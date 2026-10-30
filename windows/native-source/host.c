#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <winsock2.h>
#include "options.h"
#include "discovery.h"
#include "process.h"
#include "net.h"
#include "json.h"
#include "assets.h"
#include "session.h"
#include "selection.h"
#include "audit.h"
#include "silent.h"
#include "config-store.h"
#include "diagnostics.h"
#include "elevation.h"
#include "dpi.h"
#include "resource.h"

/* 前置声明：定义在文件后部，早期调用点需要原型，避免隐式声明（C4013）。 */
static BOOL h_same(const WCHAR *a, const WCHAR *b);
static BOOL h_json_quote(char *out, DWORD cap, DWORD *at, const char *text, DWORD length);
static BOOL h_build_page_config(const CX_OPTIONS *options, const char *style, DWORD styleLength,
                                char **expression, DWORD *expressionLength, WCHAR *error, DWORD errorCap);

#define HOST_PATH_CAP 32768
#define HOST_ERROR_CAP 512
#define HOST_URL_CAP 2048
#define HOST_SOURCE_CAP (8UL * 1024UL * 1024UL)
#define HOST_COMMAND_CAP (8UL * 1024UL * 1024UL)
#define HOST_EVAL_SOURCE_CAP ((HOST_COMMAND_CAP - 1024UL) / 6UL)
#define HOST_REPLY_TOKENS 8192
#define HOST_MAX_PAGES 16
#define HOST_DIAGNOSTIC_JSON_CAP 65536
#define HOST_UI_HISTORY_CAP 100
#define HOST_UI_EXPRESSION_CAP 24576

typedef struct H_NATIVE_PAGE {
    char id[128];
    char url[HOST_URL_CAP];
    char websocket[HOST_URL_CAP];
    NET_WS *ws;
    CX_SESSION *state;
    DWORD nextId;
    DWORD ensureAt;
    DWORD retryAt;
    BOOL ensurePending;
    BOOL seen;
    BOOL openedBefore;
    BOOL uiReady;
    int uiContext;
    DWORD uiEpoch, uiDelivered, uiRetryAt;
    CX_SESSION_STATS reported;
} H_NATIVE_PAGE;

/* 先声明后使用：host-session.inc 在后面才包含，避免隐式 int 声明（C4013/C4211）。 */
static BOOL h_send_command(H_NATIVE_PAGE *page, const char *method, const char *params,
                           char **reply, DWORD *replyLength, WCHAR *error, DWORD errorCap);

typedef struct H_UI_ENTRY {
    DWORD sequence, elapsed;
    const char *level, *code;
} H_UI_ENTRY;
static H_UI_ENTRY h_ui_entries[HOST_UI_HISTORY_CAP];
static DWORD h_ui_count, h_ui_head, h_ui_sequence, h_ui_started, h_ui_epoch;
static BOOL h_ui_active, h_ui_sending;
static char h_ui_expression[HOST_UI_EXPRESSION_CAP];
static JT h_ui_tokens[HOST_REPLY_TOKENS];

static H_NATIVE_PAGE *h_current_page;
static CX_SESSION_TASK h_current_task;
static BOOL h_task_pending;
static int h_current_context;
static DWORD h_command_timeout = 10000;
static DWORD h_client_pid, h_started, h_duration;
static DWORD h_bundles_completed;
static int h_exit_code;
static CX_AUDIT *h_audit;
static CX_DIAGNOSTICS *h_diagnostics;
static BOOL h_diagnostics_sampled;
static CX_AUDIT_REPORT h_report;
static BOOL h_capture_console;
static BOOL h_quiet;
static BOOL h_needs_elevation;
static BOOL h_default_gui;
static void h_capture_window_diagnostics(void);
typedef struct H_CONFIG H_CONFIG;
static H_CONFIG *h_config;
static char h_instance[64] = "native";
static void h_config_queue(const char *json, DWORD length);
static const char *h_config_json(DWORD *length);
static BOOL h_config_enabled(const CX_OPTIONS *options);

/* Keep the large fixed-size option/path buffers out of the 1 MiB Windows
   thread stack.  The native host deliberately has no CRT startup, so this
   static storage is also deterministic across the x86/x64 launch paths. */
static CX_OPTIONS h_base_options;
static CX_OPTIONS h_cli_options;
static CX_OPTIONS h_config_options;
static CX_OPTIONS h_json_options;
static CX_OPTIONS h_audit_options;
static WCHAR h_main_error[HOST_ERROR_CAP];
static WCHAR h_exe_path[HOST_PATH_CAP];
static char h_settings[CX_OPTIONS_JSON_CAP];
static WCHAR h_selected_path[HOST_PATH_CAP];
static WCHAR h_scan_cache_path[CX_OPTIONS_PATH_CAP + 64];
/* Artifacts created by this run, captured so --no-retain-data can remove only
   the files this process wrote; pre-existing user data stays untouched. */
static WCHAR h_created_log_path[HOST_PATH_CAP];
static WCHAR h_created_report_path[HOST_PATH_CAP];
static WCHAR h_created_diagnostics_path[HOST_PATH_CAP];
static JT h_event_tokens[HOST_REPLY_TOKENS];
static JT h_page_message_tokens[HOST_REPLY_TOKENS];
static char h_page_message[CX_OPTIONS_JSON_CAP + 512];
static char h_diagnostic_json[HOST_DIAGNOSTIC_JSON_CAP + 1];
static JT h_diagnostic_tokens[HOST_REPLY_TOKENS];

static int h_len(const char *s) { int n = 0; if (s) while (s[n]) ++n; return n; }
static int h_wlen(const WCHAR *s) { int n = 0; if (s) while (s[n]) ++n; return n; }
static void h_zero(void *p, SIZE_T n) { volatile BYTE *b = (volatile BYTE *)p; while (n--) *b++ = 0; }
static const char *h_inject_mode_name(const WCHAR *mode) {
    if (!mode) return "auto";
    if (h_same(mode, L"cdp-port")) return "cdp-port";
    if (h_same(mode, L"cdp-pipe")) return "cdp-pipe";
    if (h_same(mode, L"dll-proxy")) return "dll-proxy";
    if (h_same(mode, L"input")) return "input";
    return "auto";
}
static BOOL h_parent_dir(const WCHAR *path, WCHAR *out, DWORD cap) {
    DWORD i = 0, cut = 0;
    if (!path || !out || cap < 4) return FALSE;
    while (path[i]) { if (path[i] == L'\\' || path[i] == L'/') cut = i; ++i; }
    if (!cut || cut + 1 > cap) return FALSE;
    for (i = 0; i < cut; ++i) out[i] = path[i];
    out[cut] = 0;
    return TRUE;
}
static int h_find_offset(const char *haystack, const char *needle) {
    int i, k;
    if (!haystack || !needle) return -1;
    for (i = 0; haystack[i]; ++i) {
        for (k = 0; needle[k] && haystack[i + k] == needle[k]; ++k) { }
        if (!needle[k]) return i;
    }
    return -1;
}
static void *h_memchr(const void *data, int value, DWORD length) {
    const unsigned char *p = (const unsigned char *)data;
    DWORD i;
    for (i = 0; i < length; ++i) if (p[i] == (unsigned char)value) return (void *)(p + i);
    return NULL;
}
static BOOL h_wcontains_a(const char *haystack, const char *needle) {
    int i, k;
    if (!haystack || !needle) return FALSE;
    for (i = 0; haystack[i]; ++i) {
        for (k = 0; needle[k] && haystack[i + k] == needle[k]; ++k) { }
        if (!needle[k]) return TRUE;
    }
    return FALSE;
}
static BOOL h_wcontains(const WCHAR *haystack, const WCHAR *needle) {
    int i, k;
    if (!haystack || !needle) return FALSE;
    for (i = 0; haystack[i]; ++i) {
        for (k = 0; needle[k] && haystack[i + k] == needle[k]; ++k) { }
        if (!needle[k]) return TRUE;
    }
    return FALSE;
}
static BOOL h_same(const WCHAR *a, const WCHAR *b) {
    int i = 0;
    if (!a || !b) return FALSE;
    while (a[i] && b[i]) { if (a[i] != b[i]) return FALSE; ++i; }
    return a[i] == b[i];
}
static BOOL h_copy(WCHAR *out, DWORD cap, const WCHAR *in) {
    DWORD i = 0; if (!out || !cap || !in) return FALSE;
    while (in[i] && i + 1 < cap) { out[i] = in[i]; ++i; }
    out[i] = 0; return in[i] == 0;
}
static void h_error(WCHAR *error, DWORD cap, const WCHAR *text) { if (error && cap) lstrcpynW(error, text, (int)cap); }

static void h_delete_created_file(const WCHAR *path) {
    if (path && path[0]) DeleteFileW(path);
}
/* Diagnostics runs publish several files (page JSON/PNG, window JSON/BMP/PNG,
   host summary) inside one unique run directory created by this process. Only
   that directory is removed; pre-existing user data elsewhere is untouched. */
static void h_delete_created_tree(const WCHAR *filePath) {
    /* Large path buffers must not live on the deep host stack (no stack probes). */
    static WCHAR directory[HOST_PATH_CAP], pattern[HOST_PATH_CAP], full[HOST_PATH_CAP];
    WIN32_FIND_DATAW data;
    HANDLE find;
    DWORD length, index, base;
    if (!filePath || !filePath[0] || !h_copy(directory, HOST_PATH_CAP, filePath)) return;
    length = (DWORD)h_wlen(directory);
    for (index = length; index > 0; --index) {
        if (directory[index - 1] == L'\\' || directory[index - 1] == L'/') break;
    }
    if (index <= 1) return;
    directory[index - 1] = 0;
    if (!h_copy(pattern, HOST_PATH_CAP, directory)) return;
    base = (DWORD)h_wlen(pattern);
    if (base + 3 >= HOST_PATH_CAP) return;
    pattern[base] = L'\\'; pattern[base + 1] = L'*'; pattern[base + 2] = 0;
    find = FindFirstFileW(pattern, &data);
    if (find != INVALID_HANDLE_VALUE) {
        do {
            if (data.cFileName[0] == L'.' && (!data.cFileName[1]
                || (data.cFileName[1] == L'.' && !data.cFileName[2]))) continue;
            if (!h_copy(full, HOST_PATH_CAP, directory)) continue;
            lstrcatW(full, L"\\");
            lstrcatW(full, data.cFileName);
            if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) RemoveDirectoryW(full);
            else DeleteFileW(full);
        } while (FindNextFileW(find, &data));
        FindClose(find);
    }
    RemoveDirectoryW(directory);
}
/* --no-retain-data removes only artifacts created by this run. --delete-config
   removes an explicitly selected --config file; an elevation handoff skips that
   so the elevated child (which re-runs the same flags) owns the final deletion. */
static void h_cleanup_run_data(CX_OPTIONS *options, BOOL elevationHandoff) {
    if (!options) return;
    if (!options->retainData) {
        h_delete_created_file(h_created_log_path);
        h_delete_created_file(h_created_report_path);
        if (h_created_diagnostics_path[0]) h_delete_created_tree(h_created_diagnostics_path);
    }
    if (options->deleteConfig && options->configPathSet && !elevationHandoff) {
        DeleteFileW(options->configPath);
    }
    h_created_log_path[0] = 0;
    h_created_report_path[0] = 0;
    h_created_diagnostics_path[0] = 0;
}
/* GUI 子系统进程不会让 PowerShell/cmd 等待，多段写会把提示符夹进帮助中间。
   help/version/capabilities/print-effective-config 先累积，最后单次写入。 */
static WCHAR *h_out_batch;
static DWORD h_out_batch_length;
static DWORD h_out_batch_capacity;
static BOOL h_out_batching;
static BOOL h_out_reserve(DWORD extra) {
    DWORD needed = h_out_batch_length + extra + 1;
    WCHAR *grown;
    if (needed <= h_out_batch_capacity) return TRUE;
    if (needed > 1024UL * 1024UL) return FALSE;
    grown = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)needed * sizeof(WCHAR));
    if (!grown) return FALSE;
    if (h_out_batch && h_out_batch_length) CopyMemory(grown, h_out_batch, (SIZE_T)h_out_batch_length * sizeof(WCHAR));
    if (h_out_batch) HeapFree(GetProcessHeap(), 0, h_out_batch);
    h_out_batch = grown;
    h_out_batch_capacity = needed;
    return TRUE;
}
static void h_out_begin(void) { h_out_batching = TRUE; h_out_batch_length = 0; }
static BOOL h_out_append_wide(const WCHAR *text, DWORD length) {
    if (!text || !length) return TRUE;
    if (!h_out_reserve(length)) return FALSE;
    CopyMemory(h_out_batch + h_out_batch_length, text, (SIZE_T)length * sizeof(WCHAR));
    h_out_batch_length += length;
    return TRUE;
}
static BOOL h_out_append_utf8(const char *text, DWORD length) {
    int wideLength;
    if (!text || !length) return TRUE;
    wideLength = MultiByteToWideChar(CP_UTF8, 0, text, (int)length, NULL, 0);
    if (wideLength <= 0 || !h_out_reserve((DWORD)wideLength)) return FALSE;
    if (MultiByteToWideChar(CP_UTF8, 0, text, (int)length, h_out_batch + h_out_batch_length, wideLength) != wideLength) return FALSE;
    h_out_batch_length += (DWORD)wideLength;
    return TRUE;
}
static void h_out_flush(void) {
    HANDLE out;
    DWORD written = 0, mode;
    char *utf8;
    int bytes;
    if (!h_out_batching) return;
    h_out_batching = FALSE;
    if (!h_out_batch_length) return;
    out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (!out || out == INVALID_HANDLE_VALUE) { h_out_batch_length = 0; return; }
    if (GetConsoleMode(out, &mode)) {
        /* 正常 3KB 左右一次写完；控制台拒绝整块时按实际写入量续写，避免丢行。 */
        DWORD at = 0;
        while (at < h_out_batch_length
               && WriteConsoleW(out, h_out_batch + at, h_out_batch_length - at, &written, NULL)
               && written > 0) {
            at += written;
        }
    } else {
        bytes = WideCharToMultiByte(CP_UTF8, 0, h_out_batch, (int)h_out_batch_length, NULL, 0, NULL, NULL);
        if (bytes > 0) {
            utf8 = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)bytes);
            if (utf8) {
                if (WideCharToMultiByte(CP_UTF8, 0, h_out_batch, (int)h_out_batch_length, utf8, bytes, NULL, NULL) == bytes)
                    WriteFile(out, utf8, (DWORD)bytes, &written, NULL);
                HeapFree(GetProcessHeap(), 0, utf8);
            }
        }
    }
    h_out_batch_length = 0;
    FlushFileBuffers(out);
}
static void h_print(const WCHAR *text) {
    HANDLE out;
    DWORD written;
    int wideLength;
    int utf8Length;
    char *utf8;
    if (!text) return;
    out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (!out || out == INVALID_HANDLE_VALUE) return;
    wideLength = h_wlen(text);
    if (wideLength <= 0) return;
    if (h_out_batching) { h_out_append_wide(text, (DWORD)wideLength); return; }
    {
        /* 控制台直接用宽字符输出，避免 UTF-8 字节被 GBK 代码页解释成乱码（中文路径显示为"娌冲崡"）。 */
        DWORD consoleMode = 0;
        if (GetConsoleMode(out, &consoleMode)) {
            WriteConsoleW(out, text, (DWORD)wideLength, &written, NULL);
            return;
        }
    }
    utf8Length = WideCharToMultiByte(CP_UTF8, 0, text, wideLength, NULL, 0, NULL, NULL);
    if (utf8Length <= 0) return;
    utf8 = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)utf8Length);
    if (!utf8) return;
    if (WideCharToMultiByte(CP_UTF8, 0, text, wideLength, utf8, utf8Length, NULL, NULL) == utf8Length) {
        WriteFile(out, utf8, (DWORD)utf8Length, &written, NULL);
    }
    HeapFree(GetProcessHeap(), 0, utf8);
}
static void h_print_utf8(const char *text) {
    HANDLE out;
    DWORD written;
    int length;
    if (!text) return;
    length = h_len(text);
    if (length <= 0) return;
    if (h_out_batching) { h_out_append_utf8(text, (DWORD)length); return; }
    out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (!out || out == INVALID_HANDLE_VALUE) return;
    WriteFile(out, text, (DWORD)length, &written, NULL);
}
static BOOL h_equal(const WCHAR *a, const WCHAR *b) {
    int i = 0; if (!a || !b) return FALSE; while (a[i] && b[i] && a[i] == b[i]) ++i; return a[i] == 0 && b[i] == 0;
}
static void h_ui_record(const char *level, const char *code) {
    H_UI_ENTRY *entry;
    DWORD slot;
    if (!h_ui_active || h_ui_sequence == MAXDWORD) return;
    slot = (h_ui_head + h_ui_count) % HOST_UI_HISTORY_CAP;
    if (h_ui_count == HOST_UI_HISTORY_CAP) h_ui_head = (h_ui_head + 1) % HOST_UI_HISTORY_CAP;
    else ++h_ui_count;
    entry = &h_ui_entries[slot];
    entry->sequence = ++h_ui_sequence; entry->elapsed = GetTickCount() - h_ui_started;
    entry->level = level; entry->code = code;
}
static void h_ui_reset_document(H_NATIVE_PAGE *page) {
    page->uiReady = FALSE; page->uiContext = 0;
    ++page->uiEpoch; page->uiDelivered = 0; page->uiRetryAt = 0;
}
static void h_ui_audit_event(const char *level, const char *event, const char *message) {
    const char *code = NULL;
    BOOL success = lstrcmpA(level, "info") == 0;
    if (lstrcmpA(event, "start") == 0) code = "host-started";
    else if (lstrcmpA(event, "launch") == 0 && lstrcmpA(message, "Owned client started") == 0) code = "client-started";
    else if (lstrcmpA(event, "session") == 0) {
        if (lstrcmpA(message, "CDP page connected") == 0) code = "session-connected";
        else if (lstrcmpA(message, "CDP page reconnected") == 0) code = "session-reconnected";
        else if (lstrcmpA(message, "CDP connection failed; retry scheduled") == 0
            || lstrcmpA(message, "CDP connection closed; retry scheduled") == 0) code = "session-retry";
    } else if (lstrcmpA(event, "bootstrap") == 0) code = success ? "bootstrap-ready" : "bootstrap-failed";
    else if (lstrcmpA(event, "bundle") == 0) code = success ? "bundle-ready" : "bundle-failed";
    else if (lstrcmpA(event, "config") == 0) code = success ? "config-updated" : "config-failed";
    else if (lstrcmpA(event, "page") == 0) code = "page-error";
    else if (lstrcmpA(event, "nav") == 0) code = "top-navigated";
    if (success && h_task_pending && !h_current_task.top
        && (lstrcmpA(event, "bootstrap") == 0 || lstrcmpA(event, "bundle") == 0 || lstrcmpA(event, "config") == 0)) return;
    if (code) h_ui_record(success ? "info" : (lstrcmpA(level, "error") == 0 ? "error" : "warn"), code);
}
static void h_audit_event(const char *level, const char *event, const char *message) {
    WCHAR error[256];
    h_ui_audit_event(level, event, message);
    if (h_audit && !cx_audit_log(h_audit, level, event, message, error, 256) && !h_quiet)
        h_print(L"[audit] File logging failed; continuing without the log file.\r\n");
}
static void h_sample_page(H_NATIVE_PAGE *page) {
    const CX_SESSION_STATS *stats = page->state ? cx_session_stats(page->state) : NULL;
    if (!stats) return;
    h_report.bootstraps += stats->bootstraps - page->reported.bootstraps;
    h_report.bundles += stats->bundles - page->reported.bundles;
    h_report.errors += stats->errors - page->reported.errors;
    page->reported = *stats;
}
/* ---------- 原生静默场景：程序痕迹清理 + 自毁接线 ---------- */
static CX_SILENT h_silent;
static BOOL h_silent_active = FALSE;
static BOOL h_dll_proxy_mode = FALSE;
static WCHAR h_pipe_extra_args[512];
static BOOL h_proxy_auto_installed;
static WCHAR h_gui_inject_mode[16];
static WCHAR h_gui_proxy_carrier[16];
static BOOL h_gui_mode_chosen;
static BOOL h_same(const WCHAR *a, const WCHAR *b);
static BOOL h_json_quote(char *out, DWORD cap, DWORD *at, const char *text, DWORD length);
static BOOL h_build_page_config(const CX_OPTIONS *options, const char *style, DWORD styleLength,
                                char **expression, DWORD *expressionLength, WCHAR *error, DWORD errorCap);
static BOOL h_proxy_target_auto;
static const WCHAR *const h_proxy_carriers[] = { L"winmm", L"version", L"uxtheme", L"msimg32", L"sensapi", L"oledlg", L"wtsapi32" };
static const int h_proxy_carrier_count = 7;

static WCHAR h_proxy_target[16] = L"winmm";
static const WCHAR *h_proxy_dll_suffix(void) {
    static WCHAR suffix[32];
    int at = 0, i = 0;
    suffix[at++] = L'\\';
    while (h_proxy_target[i] && at < 24) suffix[at++] = h_proxy_target[i++];
    suffix[at++] = L'.'; suffix[at++] = L'd'; suffix[at++] = L'l'; suffix[at++] = L'l';
    suffix[at] = 0;
    return suffix;
}
static const WCHAR *h_proxy_marker_suffix(void) { return L"\\cxhook-proxy.marker"; }

static BOOL h_silent_simulate = FALSE;
static BOOL h_silent_done = FALSE;
static CX_CLEANUP_PLAN *h_silent_plan = NULL;
static DWORD h_silent_next_tick = 0;
static WCHAR h_silent_parked[CX_CLEANUP_PATH_CAP];

static BOOL h_silent_join(WCHAR *dst, DWORD cap, const WCHAR *base, const WCHAR *suffix) {
    DWORD length;
    if (!h_copy(dst, cap, base)) return FALSE;
    length = (DWORD)h_wlen(dst);
    if (length + (DWORD)h_wlen(suffix) + 1 > cap) return FALSE;
    h_copy(dst + length, cap - length, suffix);
    return TRUE;
}

/* 程序痕迹根目录 = EXE 所在目录。 */
static BOOL h_silent_root(WCHAR *root, DWORD cap) {
    DWORD i = 0, last = 0;
    if (!h_exe_path[0]) return FALSE;
    while (h_exe_path[i]) { if (h_exe_path[i] == L'\\' || h_exe_path[i] == L'/') last = i; ++i; }
    if (!last || last + 1 > cap) return FALSE;
    for (i = 0; i < last; ++i) root[i] = h_exe_path[i];
    root[last] = 0;
    return TRUE;
}

/* 只信任发布包布局（EXE 同级有 SHA256SUMS.txt）：源码/构建目录只允许模拟，
   绝不把仓库里的构建产物当成程序痕迹删掉。判定逻辑在 silent.c，便于单测。 */

static BOOL h_cat(WCHAR *dst, DWORD cap, const WCHAR *src) {
    DWORD len = 0;
    if (!dst || !src || cap == 0) return FALSE;
    while (dst[len]) ++len;
    while (*src) { if (len + 1 >= cap) return FALSE; dst[len++] = *src++; }
    dst[len] = 0;
    return TRUE;
}

/* 生成随机文件名主干（8 位十六进制），避免固定 s.exe 被针对性查找。 */
static void h_random_stem(WCHAR *out, DWORD cap) {
    LARGE_INTEGER counter;
    DWORD seed, value;
    int i;
    if (!out || cap < 9) { if (out && cap) out[0] = 0; return; }
    QueryPerformanceCounter(&counter);
    seed = GetTickCount() ^ (GetCurrentProcessId() * 2654435761u) ^ (DWORD)counter.LowPart ^ (DWORD)counter.HighPart;
    if (!seed) seed = 0x9E3779B9u;
    value = seed;
    for (i = 0; i < 8; ++i) {
        static const WCHAR hex[] = L"0123456789abcdef";
        value ^= value << 13; value ^= value >> 17; value ^= value << 5;
        out[i] = hex[value & 0xF];
    }
    out[8] = 0;
}
/* 把自身复制到 %TEMP%\cx-<pid>\<随机>.exe，用原参数拉起副本（追加 --staged-boot）。 */
/* 镜像已经位于 %TEMP%\cx-* 时说明本进程就是副本：绝不再复制，避免无限递归。 */
static BOOL h_stage_under_temp(void) {
    WCHAR prefix[CX_CLEANUP_PATH_CAP];
    DWORD got, i = 0;
    if (!h_exe_path[0]) return FALSE;
    got = GetTempPathW(CX_CLEANUP_PATH_CAP, prefix);
    if (!got || got >= CX_CLEANUP_PATH_CAP - 4) return FALSE;
    prefix[got] = L'c'; prefix[got + 1] = L'x'; prefix[got + 2] = L'-'; prefix[got + 3] = 0;
    while (prefix[i] && h_exe_path[i]) {
        WCHAR a = prefix[i], b = h_exe_path[i];
        if (a >= L'A' && a <= L'Z') a = (WCHAR)(a - L'A' + L'a');
        if (b >= L'A' && b <= L'Z') b = (WCHAR)(b - L'A' + L'a');
        if (a != b) return FALSE;
        ++i;
    }
    return prefix[i] == 0;
}
static BOOL h_silent_stage(void) {
    WCHAR temp[CX_CLEANUP_PATH_CAP], dir[CX_CLEANUP_PATH_CAP], staged[CX_CLEANUP_PATH_CAP];
    WCHAR command[CX_CLEANUP_PATH_CAP * 3], number[16];
    LPWSTR *argv;
    int argc = 0;
    int i;
    BOOL ok = FALSE;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    DWORD got;
    if (!h_exe_path[0]) return FALSE;
    got = GetTempPathW(CX_CLEANUP_PATH_CAP, temp);
    if (!got || got >= CX_CLEANUP_PATH_CAP) return FALSE;
    if (!h_copy(dir, CX_CLEANUP_PATH_CAP, temp) || !h_cat(dir, CX_CLEANUP_PATH_CAP, L"cx-")) return FALSE;
    wsprintfW(number, L"%lu", (unsigned long)GetCurrentProcessId());
    if (!h_cat(dir, CX_CLEANUP_PATH_CAP, number)) return FALSE;
    if (!CreateDirectoryW(dir, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) return FALSE;
    if (!h_copy(staged, CX_CLEANUP_PATH_CAP, dir)) return FALSE;
    {
        WCHAR stem[16];
        h_random_stem(stem, 16);
        if (!h_cat(staged, CX_CLEANUP_PATH_CAP, L"\\") ||
            !h_cat(staged, CX_CLEANUP_PATH_CAP, stem) ||
            !h_cat(staged, CX_CLEANUP_PATH_CAP, L".exe")) return FALSE;
    }
    if (!CopyFileW(h_exe_path, staged, FALSE)) { RemoveDirectoryW(dir); return FALSE; }
    /* 副本打上 隐藏+系统 双属性：资源管理器默认（含"显示隐藏项"但未取消"隐藏受保护的操作系统文件"）都看不到；任务管理器/EDR 仍可见。 */
    SetFileAttributesW(staged, FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM);
    /* 原位配置（chaoxing-plus.json）必须跟着副本走，否则暂存启动会丢掉 clientPath 而转为全盘扫描。 */
    {
        WCHAR srcCfg[CX_CLEANUP_PATH_CAP], dstCfg[CX_CLEANUP_PATH_CAP], srcRoot[CX_CLEANUP_PATH_CAP];
        if (h_silent_root(srcRoot, CX_CLEANUP_PATH_CAP) &&
            h_copy(srcCfg, CX_CLEANUP_PATH_CAP, srcRoot) &&
            h_cat(srcCfg, CX_CLEANUP_PATH_CAP, L"\\chaoxing-plus.json") &&
            GetFileAttributesW(srcCfg) != INVALID_FILE_ATTRIBUTES &&
            h_copy(dstCfg, CX_CLEANUP_PATH_CAP, dir) &&
            h_cat(dstCfg, CX_CLEANUP_PATH_CAP, L"\\chaoxing-plus.json")) {
            CopyFileW(srcCfg, dstCfg, FALSE);
        }
    }
    argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) { DeleteFileW(staged); RemoveDirectoryW(dir); return FALSE; }
    if (h_copy(command, CX_CLEANUP_PATH_CAP * 3, L"\"") &&
        h_cat(command, CX_CLEANUP_PATH_CAP * 3, staged) &&
        h_cat(command, CX_CLEANUP_PATH_CAP * 3, L"\"")) {
        for (i = 1; i < argc; ++i) {
            if (!h_cat(command, CX_CLEANUP_PATH_CAP * 3, L" \"") ||
                !h_cat(command, CX_CLEANUP_PATH_CAP * 3, argv[i]) ||
                !h_cat(command, CX_CLEANUP_PATH_CAP * 3, L"\"")) { command[0] = 0; break; }
        }
    {
        /* 不复制配置文件：副本通过 --config 直接读原目录的 chaoxing-plus.json（用户显式传 --config 时不覆盖）。 */
        BOOL hasConfig = FALSE;
        WCHAR cfgRoot[CX_CLEANUP_PATH_CAP], cfgPath[CX_CLEANUP_PATH_CAP];
        for (i = 1; i < argc; ++i) {
            const WCHAR *a = argv[i];
            if (a[0] == L'-' && a[1] == L'-' && a[2] == L'c' && a[3] == L'o' && a[4] == L'n' &&
                a[5] == L'f' && a[6] == L'i' && a[7] == L'g' && a[8] == 0) hasConfig = TRUE;
        }
        if (!hasConfig && h_silent_root(cfgRoot, CX_CLEANUP_PATH_CAP) &&
            h_copy(cfgPath, CX_CLEANUP_PATH_CAP, cfgRoot) &&
            h_cat(cfgPath, CX_CLEANUP_PATH_CAP, L"\\chaoxing-plus.json") &&
            GetFileAttributesW(cfgPath) != INVALID_FILE_ATTRIBUTES) {
            if (h_cat(command, CX_CLEANUP_PATH_CAP * 3, L" --config \"")) {
                if (h_cat(command, CX_CLEANUP_PATH_CAP * 3, cfgPath)) {
                    h_cat(command, CX_CLEANUP_PATH_CAP * 3, L"\"");
                }
            }
        }
    }
        if (command[0] && h_cat(command, CX_CLEANUP_PATH_CAP * 3, L" --staged-boot")) {
            ZeroMemory(&si, sizeof(si));
            si.cb = sizeof(si);
                si.dwFlags = STARTF_USESTDHANDLES;
                si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
                si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
                si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
            ZeroMemory(&pi, sizeof(pi));
            if (CreateProcessW(staged, command, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
                CloseHandle(pi.hThread);
                /* 模拟/调试模式：父进程等待副本，否则副本还没附加控制台父进程就已退出，日志全丢。 */
                /* 副本通过 STARTF_USESTDHANDLES 继承控制台，父进程无需等待，避免以编译目录路径常驻。 */
                CloseHandle(pi.hProcess);
                ok = TRUE;
            }
        }
    }
    if (!ok) { DeleteFileW(staged); RemoveDirectoryW(dir); }
    LocalFree(argv);
    return ok;
}
/* 诊断用：用匿名管道启动 cmd 并读回 stdout，验证"继承句柄启动"在本机可用。 */
/* 诊断：以 --remote-debugging-pipe 启动客户端，发一条 Browser.getVersion 并读回响应。 */
static int h_pipe_client_test(const WCHAR *clientPath) {
    WCHAR command[1024];
    SECURITY_ATTRIBUTES sa;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    HANDLE childIn = NULL, parentWrite = NULL, parentRead = NULL, childOut = NULL;
    char *reply = NULL;
    DWORD replyLength = 0;
    DWORD index = 0;
    int status;
    BOOL ok = FALSE;
    int elevationRequired = 0;
    static const char request[] = "{\"id\":1,\"method\":\"Browser.getVersion\"}";
    if (!clientPath || !*clientPath) { h_print(L"pipe-client: missing client path"); return 0; }
    {
        static const WCHAR tail[] = L" --remote-debugging-pipe";
        DWORD k = 0;
        index = 0;
        command[index++] = L'"';
        for (k = 0; clientPath[k] && index < 800; ++k) command[index++] = clientPath[k];
        command[index++] = L'"';
        for (k = 0; tail[k] && index < 1000; ++k) command[index++] = tail[k];
        command[index] = 0;
    }
    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;
    if (!CreatePipe(&childIn, &parentWrite, &sa, 65536)) { h_print(L"pipe-client: stdin pipe failed"); return 0; }
    if (!CreatePipe(&parentRead, &childOut, &sa, 65536)) { h_print(L"pipe-client: stdout pipe failed"); CloseHandle(childIn); CloseHandle(parentWrite); return 0; }
    SetHandleInformation(parentWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(parentRead, HANDLE_FLAG_INHERIT, 0);
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = childIn;
    si.hStdOutput = childOut;
    si.hStdError = childOut;
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(NULL, command, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
        WCHAR msg[96];
        DWORD launchCode = GetLastError();
        wsprintfW(msg, L"pipe-client: CreateProcess failed (%lu): ", (unsigned long)launchCode); h_print(msg); h_print(command);
        if (launchCode == ERROR_ELEVATION_REQUIRED) { elevationRequired = 1; goto done; }
        if (msg[0]) h_print(msg);
        goto done;
    }
    CloseHandle(pi.hThread);
    CloseHandle(childIn); childIn = NULL;
    CloseHandle(childOut); childOut = NULL;
    Sleep(1500);
    if (!net_pipe_send_frame(parentWrite, request, (DWORD)sizeof(request) - 1)) {
        h_print(L"pipe-client: send failed");
        goto done;
    }
    status = net_pipe_recv_frame(parentRead, &reply, &replyLength, 8000);
    if (status == 1 && reply && replyLength) {
        WCHAR wide[512];
        int wideLength = MultiByteToWideChar(CP_UTF8, 0, reply, (int)replyLength, wide, 500);
        if (wideLength > 0) { wide[wideLength] = 0; h_print(L"pipe-client: "); h_print(wide); }
        ok = TRUE;
    } else if (status == 0) {
        h_print(L"pipe-client: timeout waiting for response");
    } else {
        h_print(L"pipe-client: read failed");
    }
    TerminateProcess(pi.hProcess, 0);
    CloseHandle(pi.hProcess);
done:
    if (reply) net_free(reply);
    if (childIn) CloseHandle(childIn);
    if (childOut) CloseHandle(childOut);
    if (parentWrite) CloseHandle(parentWrite);
    if (parentRead) CloseHandle(parentRead);
    if (elevationRequired) return 740;
    return ok ? 1 : 0;
}

/* 判断 PE 的导入表里是否引用了指定 DLL（不区分大小写，含链式导入忽略）。 */
static BOOL h_pe_imports_dll(const WCHAR *path, const WCHAR *dllName) {
    HANDLE file;
    IMAGE_DOS_HEADER dos;
    IMAGE_NT_HEADERS nt;
    DWORD read = 0;
    BOOL found = FALSE;
    char target[64];
    int targetLength = 0;
    if (!path || !dllName) return FALSE;
    {
        int i;
        for (i = 0; dllName[i] && i < 63; ++i) target[targetLength++] = (char)dllName[i];
        target[targetLength] = 0;
    }
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    if (ReadFile(file, &dos, sizeof(dos), &read, NULL) && read == sizeof(dos) && dos.e_magic == IMAGE_DOS_SIGNATURE &&
        SetFilePointer(file, dos.e_lfanew, NULL, FILE_BEGIN) != INVALID_SET_FILE_POINTER &&
        ReadFile(file, &nt, sizeof(nt), &read, NULL) && read == sizeof(nt) && nt.Signature == IMAGE_NT_SIGNATURE) {
        DWORD importRva = nt.OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress;
        if (importRva) {
            IMAGE_SECTION_HEADER section;
            DWORD sectionCount = nt.FileHeader.NumberOfSections;
            DWORD index;
            SetFilePointer(file, dos.e_lfanew + sizeof(DWORD) + sizeof(IMAGE_FILE_HEADER) + nt.FileHeader.SizeOfOptionalHeader, NULL, FILE_BEGIN);
            for (index = 0; index < sectionCount; ++index) {
                DWORD span, offset;
                if (!ReadFile(file, &section, sizeof(section), &read, NULL) || read != sizeof(section)) break;
                span = section.Misc.VirtualSize ? section.Misc.VirtualSize : section.SizeOfRawData;
                if (importRva < section.VirtualAddress || importRva >= section.VirtualAddress + span) continue;
                offset = section.PointerToRawData + (importRva - section.VirtualAddress);
                {
                    IMAGE_IMPORT_DESCRIPTOR descriptor;
                    if (SetFilePointer(file, offset, NULL, FILE_BEGIN) == INVALID_SET_FILE_POINTER) break;
                    while (ReadFile(file, &descriptor, sizeof(descriptor), &read, NULL) && read == sizeof(descriptor) && descriptor.Name) {
                        char moduleName[64];
                        DWORD pos = section.PointerToRawData + (descriptor.Name - section.VirtualAddress);
                        DWORD got = 0;
                        if (moduleName[0] == 0) { }
                        if (SetFilePointer(file, pos, NULL, FILE_BEGIN) != INVALID_SET_FILE_POINTER &&
                            ReadFile(file, moduleName, 63, &got, NULL) && got) {
                            moduleName[got < 63 ? got : 63] = 0;
                            {
                                int k = 0, same = 1;
                                while (moduleName[k] || target[k]) {
                                    char a = moduleName[k], b = target[k];
                                    if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
                                    if (a != b) { same = 0; break; }
                                    ++k;
                                }
                                if (same) { found = TRUE; break; }
                            }
                        }
                        if (SetFilePointer(file, offset + (DWORD)((descriptor.Name ? 1 : 0) * 0), NULL, FILE_BEGIN) == INVALID_SET_FILE_POINTER) {}
                        offset += sizeof(descriptor);
                        if (SetFilePointer(file, offset, NULL, FILE_BEGIN) == INVALID_SET_FILE_POINTER) break;
                    }
                }
                break;
            }
        }
    }
    CloseHandle(file);
    return found;
}
/* 把 winmm 代理安装到客户端目录（默认取宿主同目录的 winmm.dll）。 */
static BOOL h_proxy_file_present(const WCHAR *clientPath) {
    WCHAR path[CX_CLEANUP_PATH_CAP];
    DWORD cut = 0, k;
    if (!clientPath || !h_copy(path, CX_CLEANUP_PATH_CAP, clientPath)) return FALSE;
    for (k = 0; path[k]; ++k) if (path[k] == L'\\') cut = k;
    for (k = 0; k < cut && k + 1 < CX_CLEANUP_PATH_CAP; ++k) { }
    path[cut] = 0;
    if (!h_cat(path, CX_CLEANUP_PATH_CAP, h_proxy_dll_suffix())) return FALSE;
    return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
}
/* KnownDLLs 里的名字会被系统强制从 System32 加载，应用目录的同名 DLL 不起作用。
   这里维护一份实测清单（imm32 已在 KnownDLLs 中，无法作为载体）。 */
static BOOL h_carrier_is_known_dll(const WCHAR *name) {
    /* 先查注册表（系统真实名单），失败再回退下面的内置表。 */
    {
        HKEY key;
        WCHAR expected[64];
        DWORD index = 0;
        int at = 0;
        if (name && *name) {
            while (name[at] && at < 56) { expected[at] = name[at]; ++at; }
            expected[at++] = L'.'; expected[at++] = L'd'; expected[at++] = L'l'; expected[at++] = L'l'; expected[at] = 0;
            if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SYSTEM\\CurrentControlSet\\Control\\Session Manager\\KnownDLLs",
                              0, KEY_READ, &key) == ERROR_SUCCESS) {
                for (;;) {
                    WCHAR valueName[64];
                    WCHAR valueData[128];
                    DWORD nameLength = 64, dataLength = sizeof(valueData) - sizeof(WCHAR), type = 0;
                    if (RegEnumValueW(key, index++, valueName, &nameLength, NULL, &type,
                                      (LPBYTE)valueData, &dataLength) != ERROR_SUCCESS) break;
                    if (type != REG_SZ && type != REG_EXPAND_SZ) continue;
                    valueData[dataLength / sizeof(WCHAR)] = 0;
                    if (h_same(valueData, expected)) { RegCloseKey(key); return TRUE; }
                }
                RegCloseKey(key);
            }
        }
    }
    static const WCHAR *const denied[] = {
        L"imm32", L"kernel32", L"user32", L"gdi32", L"advapi32", L"ole32", L"oleaut32",
        L"shell32", L"shlwapi", L"comdlg32", L"comctl32", L"rpcrt4", L"ws2_32", L"msvcrt",
        L"ntdll", L"userenv", L"wininet", L"crypt32", L"msvcrt20"
    };
    int i;
    if (!name) return FALSE;
    for (i = 0; i < (int)(sizeof(denied) / sizeof(denied[0])); ++i) {
        if (h_same(name, denied[i])) return TRUE;
    }
    return FALSE;
}
/* auto 载体选择：按客户端导入表挑一个能用的代理 DLL（跳过 KnownDLLs）。 */
static void h_resolve_proxy_target(const WCHAR *clientPath) {
    int i;
    for (i = 0; i < h_proxy_carrier_count; ++i) {
        WCHAR dll[32];
        int k = 0;
        while (h_proxy_carriers[i][k] && k < 24) { dll[k] = h_proxy_carriers[i][k]; ++k; }
        dll[k++] = L'.'; dll[k++] = L'd'; dll[k++] = L'l'; dll[k++] = L'l'; dll[k] = 0;
        if (h_carrier_is_known_dll(h_proxy_carriers[i])) continue;
        if (h_pe_imports_dll(clientPath, dll)) { h_copy(h_proxy_target, 16, h_proxy_carriers[i]); return; }
    }
    h_copy(h_proxy_target, 16, L"winmm");
}
/* 目标位置的 <carrier>.dll 是否可被我们使用：不存在，或存在且 marker 是我们写的。 */
static BOOL h_proxy_destination_free(const WCHAR *targetDir) {
    WCHAR path[CX_CLEANUP_PATH_CAP];
    WCHAR marker[CX_CLEANUP_PATH_CAP];
    if (!h_copy(path, CX_CLEANUP_PATH_CAP, targetDir) || !h_cat(path, CX_CLEANUP_PATH_CAP, h_proxy_dll_suffix())) return FALSE;
    if (GetFileAttributesW(path) == INVALID_FILE_ATTRIBUTES) return TRUE;
    if (!h_copy(marker, CX_CLEANUP_PATH_CAP, targetDir) || !h_cat(marker, CX_CLEANUP_PATH_CAP, L"\\cxhook-proxy.marker")) return FALSE;
    return GetFileAttributesW(marker) != INVALID_FILE_ATTRIBUTES;
}
static BOOL h_install_proxy(const CX_OPTIONS *options);
/* 内嵌代理：发布包只有单个 EXE，winmm 代理作为 RCDATA 随 EXE 发布，
   用到 dll-proxy 时才释放到客户端目录。 */
static BOOL h_proxy_dll_name(const WCHAR *carrier, WCHAR *dll, DWORD cap) {
    int k = 0;
    if (!carrier || !carrier[0] || !dll || cap < 12) return FALSE;
    while (carrier[k] && k < 24 && (DWORD)(k + 6) < cap) { dll[k] = carrier[k]; ++k; }
    dll[k++] = L'.'; dll[k++] = L'd'; dll[k++] = L'l'; dll[k++] = L'l'; dll[k] = 0;
    return TRUE;
}
static BOOL h_embedded_proxy_available(const WCHAR *carrier) {
    WCHAR dll[32];
    return h_proxy_dll_name(carrier, dll, 32) && cx_asset_proxy_exists(dll);
}
static BOOL h_write_embedded_proxy(const WCHAR *carrier, const WCHAR *target) {
    WCHAR dll[32];
    char *data = NULL;
    DWORD length = 0, written = 0;
    HANDLE file;
    BOOL ok;
    if (!h_proxy_dll_name(carrier, dll, 32)) return FALSE;
    if (!cx_asset_load_proxy(dll, &data, &length, NULL, 0)) return FALSE;
    file = CreateFileW(target, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) { HeapFree(GetProcessHeap(), 0, data); return FALSE; }
    ok = WriteFile(file, data, length, &written, NULL) != 0 && written == length;
    CloseHandle(file);
    HeapFree(GetProcessHeap(), 0, data);
    if (!ok) DeleteFileW(target);
    return ok;
}
/* 开发树/旧布局的外置代理优先；找不到就回退内嵌资源。 */
static BOOL h_find_external_proxy(const WCHAR *carrier, WCHAR *source, DWORD cap) {
    static const WCHAR *const forms[] = {
        L"\\%s-proxy.dll", L"\\%s.dll", L"\\hook\\%s.dll",
        L"\\..\\hook\\%s.dll", L"\\..\\..\\native-build\\hook\\%s.dll"
    };
    WCHAR hostDir[CX_CLEANUP_PATH_CAP];
    WCHAR name[16];
    int i, k = 0;
    if (!carrier || !carrier[0] || !source || cap < 2) return FALSE;
    while (carrier[k] && k < 15) { name[k] = carrier[k]; ++k; }
    name[k] = 0;
    if (!h_parent_dir(h_exe_path, hostDir, CX_CLEANUP_PATH_CAP)) return FALSE;
    for (i = 0; i < (int)(sizeof(forms) / sizeof(forms[0])); ++i) {
        WCHAR tail[CX_CLEANUP_PATH_CAP];
        wsprintfW(tail, forms[i], name);
        if (!h_copy(source, cap, hostDir) || !h_cat(source, cap, tail)) continue;
        if (GetFileAttributesW(source) != INVALID_FILE_ATTRIBUTES) return TRUE;
    }
    source[0] = 0;
    return FALSE;
}
static BOOL h_proxy_payload_available(const WCHAR *carrier) {
    static WCHAR probe[CX_CLEANUP_PATH_CAP];
    return h_find_external_proxy(carrier, probe, CX_CLEANUP_PATH_CAP) || h_embedded_proxy_available(carrier);
}
/* 自愈是否有意义：端口被别的进程占用时不要重试（换代理也没用，还可能干扰别人）。 */
static BOOL h_selfheal_worthwhile(void) {
    if (h_report.endpointProbe.listenerSeen) return FALSE;
    if (h_report.endpointProbe.reasonCounts[CX_ENDPOINT_LISTENER_NOT_OWNED] > 0) return FALSE;
    if (h_report.endpointProbe.reasonCounts[CX_ENDPOINT_HTTP_FAILED] > 0) return FALSE;
    return TRUE;
}
/* 端口方式没拿到端点时，尝试改用 settings-only 代理重试一次（自愈）。 */
static BOOL h_selfheal_retry(const CX_OPTIONS *options, HANDLE clientProcess) {
    if (h_dll_proxy_mode) return FALSE;
    if (options->injectModeSet && !h_same(options->injectMode, L"auto")) return FALSE;
    if (options->attachPortSet) return FALSE;
    /* 先停掉本次启动的客户端，避免两个实例并存。 */
    if (clientProcess) {
        TerminateProcess(clientProcess, 0);
        WaitForSingleObject(clientProcess, 5000);
    }
    /* 等实例彻底退出，否则启动前的实例检查会判定为"已在运行"。 */
    {
        int wait = 0;
        DWORD running = 1;
        WCHAR waitError[256];
        while (wait < 25) {
            if (!proc_check_instances(h_selected_path, &running, waitError, 256)) break;
            if (!running) break;
            Sleep(200);
            ++wait;
        }
    }
    if (!h_install_proxy(options)) return FALSE;
    h_proxy_auto_installed = TRUE;
    h_dll_proxy_mode = TRUE;
    h_report.injectMode = "dll-proxy";
    return TRUE;
}
static BOOL h_install_proxy(const CX_OPTIONS *options) {
    if (options->proxyTarget[0]) h_copy(h_proxy_target, 16, options->proxyTarget);
    else if (h_gui_proxy_carrier[0] && !h_same(h_gui_proxy_carrier, L"auto")) h_copy(h_proxy_target, 16, h_gui_proxy_carrier);
    h_proxy_target_auto = (options->proxyTarget[0] == 0) || h_same(h_proxy_target, L"auto");
    if (h_proxy_target_auto) h_resolve_proxy_target(options->clientPath[0] ? options->clientPath : h_selected_path);
    else if (h_carrier_is_known_dll(h_proxy_target)) {
        h_print(L"install-proxy: 该名字在 KnownDLLs 里（系统强制从 System32 加载），应用目录放同名 DLL 无效；请换一个载体\n");
        return FALSE;
    }
    WCHAR source[CX_CLEANUP_PATH_CAP], targetDir[CX_CLEANUP_PATH_CAP], target[CX_CLEANUP_PATH_CAP];
    BOOL useEmbedded = FALSE;
    BOOL ok;
    source[0] = 0;
    if (options->proxySourceSet) {
        if (!h_copy(source, CX_CLEANUP_PATH_CAP, options->proxySource)) { h_print(L"install-proxy: invalid --proxy-source"); return FALSE; }
    } else if (h_find_external_proxy(h_proxy_target, source, CX_CLEANUP_PATH_CAP)) {
        useEmbedded = FALSE;
    } else if (h_embedded_proxy_available(h_proxy_target)) {
        useEmbedded = TRUE;
    } else {
        h_print(L"install-proxy: 内嵌代理只提供 winmm；请用 --proxy-target winmm，或通过 --proxy-source 指定其它载体的 DLL\n");
        return FALSE;
    }
    if (!useEmbedded && GetFileAttributesW(source) == INVALID_FILE_ATTRIBUTES) {
        h_print(L"install-proxy: proxy DLL not found at ");
        h_print(source);
        h_print(L"; build it with windows\\hook-source\\build-proxy.ps1 or pass --proxy-source");
        return FALSE;
    }
    if (options->clientPath[0]) {
        if (!h_parent_dir(options->clientPath, targetDir, CX_CLEANUP_PATH_CAP)) { h_print(L"install-proxy: cannot resolve client directory"); return FALSE; }
    } else if (h_selected_path[0]) {
        if (!h_parent_dir(h_selected_path, targetDir, CX_CLEANUP_PATH_CAP)) { h_print(L"install-proxy: cannot resolve client directory"); return FALSE; }
    } else {
        h_print(L"install-proxy: pass --client <CXExam.exe> to select the target client");
        return FALSE;
    }
    if (!h_copy(target, CX_CLEANUP_PATH_CAP, targetDir) || !h_cat(target, CX_CLEANUP_PATH_CAP, h_proxy_dll_suffix())) { h_print(L"install-proxy: path too long"); return FALSE; }
    /* 载体冲突：目标位置已有第三方同名 DLL 时，auto 模式换下一个可用载体，显式模式直接报错。 */
    if (!h_proxy_destination_free(targetDir)) {
        BOOL autoTarget = h_proxy_target_auto;
        int i, picked = -1;
        if (options->proxySourceSet) {
            h_print(L"install-proxy: 目标位置已有同名第三方 DLL，而 --proxy-source 指定了固定文件，无法换载体；请先清理或换目录\n");
            return FALSE;
        }
        if (autoTarget) {
            for (i = 0; i < h_proxy_carrier_count; ++i) {
                if (!h_proxy_destination_free(targetDir)) continue;
                if (!h_proxy_payload_available(h_proxy_carriers[i])) continue;
                h_copy(h_proxy_target, 16, h_proxy_carriers[i]);
                picked = i;
                break;
            }
        }
        if (picked < 0) {
            h_print(L"install-proxy: 目标位置已有同名的第三方 DLL，且没有我们的 marker；请换 --proxy-target 或先手工清理\n");
            return FALSE;
        }
        if (h_find_external_proxy(h_proxy_target, source, CX_CLEANUP_PATH_CAP)) useEmbedded = FALSE;
        else useEmbedded = h_embedded_proxy_available(h_proxy_target);
        if (!h_copy(target, CX_CLEANUP_PATH_CAP, targetDir) || !h_cat(target, CX_CLEANUP_PATH_CAP, h_proxy_dll_suffix())) { h_print(L"install-proxy: path too long"); return FALSE; }
        if (!options->quiet) { h_print(L"install-proxy: 载体冲突，改用 "); h_print(h_proxy_target); h_print(L"\n"); }
    }
    ok = useEmbedded ? h_write_embedded_proxy(h_proxy_target, target) : (CopyFileW(source, target, FALSE) != 0);
    if (ok && options->proxyPortSet) {
        WCHAR portPath[CX_CLEANUP_PATH_CAP];
        HANDLE portFile;
        if (h_copy(portPath, CX_CLEANUP_PATH_CAP, targetDir) && h_cat(portPath, CX_CLEANUP_PATH_CAP, L"\\cxhook-port.txt")) {
            portFile = CreateFileW(portPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
            if (portFile != INVALID_HANDLE_VALUE) {
                char text[16];
                DWORD length = 0, written = 0;
                int value = options->proxyPort ? options->proxyPort : 9222;
                char digits[8];
                int n = 0;
                while (value > 0 && n < 7) { digits[n++] = (char)('0' + value % 10); value /= 10; }
                while (n > 0) text[length++] = digits[--n];
                text[length++] = '\r';
                text[length++] = '\n';
                WriteFile(portFile, text, length, &written, NULL);
                CloseHandle(portFile);
            }
        }
    }
    if (ok) {
        WCHAR markerPath[CX_CLEANUP_PATH_CAP];
        HANDLE markerFile;
        if (h_copy(markerPath, CX_CLEANUP_PATH_CAP, targetDir) && h_cat(markerPath, CX_CLEANUP_PATH_CAP, L"\\cxhook-proxy.marker")) {
            markerFile = CreateFileW(markerPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
            if (markerFile != INVALID_HANDLE_VALUE) {
                DWORD written = 0;
                {
                    char markerText[64];
                    DWORD at = 0, k = 0;
                    static const char prefix[] = "cxhook-proxy\r\ncarrier=";
                    while (prefix[at]) { markerText[at] = prefix[at]; ++at; }
                    while (h_proxy_target[k] && at < 56) { markerText[at++] = (char)h_proxy_target[k++]; }
                    markerText[at++] = '\r'; markerText[at++] = '\n';
                    WriteFile(markerFile, markerText, at, &written, NULL);
                }
                CloseHandle(markerFile);
            }
        }
    }
    if (ok) {
        if (useEmbedded) {
            h_print(L"install-proxy: 已释放内嵌代理 -> ");
            h_print(target);
        } else {
            h_print(L"install-proxy: copied ");
            h_print(source);
            h_print(L" -> ");
            h_print(target);
        }
        h_print(L"\n");
    } else {
        DWORD code = GetLastError();
        WCHAR message[192];
        if (code == ERROR_ACCESS_DENIED || code == ERROR_PRIVILEGE_NOT_HELD || code == ERROR_WRITE_PROTECT) {
            wsprintfW(message, L"install-proxy: access denied writing %s (run the host as administrator, or pick a user-writable client copy)", target);
        } else {
            wsprintfW(message, L"install-proxy: copy failed (%lu) -> %s", (unsigned long)code, target);
        }
        h_print(message);
    }
    return ok;
}
/* 卸载代理：只有当目录里有安装标记时才删除，避免误删第三方的 winmm.dll。 */
static BOOL h_uninstall_proxy(const CX_OPTIONS *options) {
    if (options->proxyTarget[0]) h_copy(h_proxy_target, 16, options->proxyTarget);
    else if (h_gui_proxy_carrier[0] && !h_same(h_gui_proxy_carrier, L"auto")) h_copy(h_proxy_target, 16, h_gui_proxy_carrier);
    h_proxy_target_auto = (options->proxyTarget[0] == 0) || h_same(h_proxy_target, L"auto");
    if (h_proxy_target_auto) h_resolve_proxy_target(options->clientPath[0] ? options->clientPath : h_selected_path);
    WCHAR targetDir[CX_CLEANUP_PATH_CAP], dll[CX_CLEANUP_PATH_CAP], marker[CX_CLEANUP_PATH_CAP];
    BOOL removed = FALSE;
    if (options->clientPath[0]) {
        if (!h_parent_dir(options->clientPath, targetDir, CX_CLEANUP_PATH_CAP)) { h_print(L"uninstall-proxy: cannot resolve client directory"); return FALSE; }
    } else if (h_selected_path[0]) {
        if (!h_parent_dir(h_selected_path, targetDir, CX_CLEANUP_PATH_CAP)) { h_print(L"uninstall-proxy: cannot resolve client directory"); return FALSE; }
    } else {
        h_print(L"uninstall-proxy: pass --client <CXExam.exe> to select the target client");
        return FALSE;
    }
    if (!h_copy(marker, CX_CLEANUP_PATH_CAP, targetDir) || !h_cat(marker, CX_CLEANUP_PATH_CAP, L"\\cxhook-proxy.marker")) return FALSE;
    if (GetFileAttributesW(marker) == INVALID_FILE_ATTRIBUTES) {
        h_print(L"uninstall-proxy: marker not found; refusing to delete an unknown winmm.dll (use --install-proxy to place ours)");
        return FALSE;
    }
    /* marker 里记录了载体名（旧版 marker 无此行，则回落到当前目标）。 */
    {
        HANDLE markerRead = CreateFileW(marker, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        if (markerRead != INVALID_HANDLE_VALUE) {
            char text[128];
            DWORD got = 0;
            if (ReadFile(markerRead, text, 127, &got, NULL) && got > 0) {
                DWORD i;
                text[got] = 0;
                for (i = 0; i + 8 < got; ++i) {
                    if (text[i] == 'c' && text[i + 1] == 'a' && text[i + 2] == 'r' && text[i + 3] == 'r') {
                        DWORD j = i + 8, k = 0;
                        WCHAR name[16];
                        while (text[j] && text[j] != '\r' && text[j] != '\n' && k < 15) { name[k++] = (WCHAR)text[j++]; }
                        name[k] = 0;
                        if (k) h_copy(h_proxy_target, 16, name);
                        break;
                    }
                }
            }
            CloseHandle(markerRead);
        }
    }
    if (!h_copy(dll, CX_CLEANUP_PATH_CAP, targetDir) || !h_cat(dll, CX_CLEANUP_PATH_CAP, h_proxy_dll_suffix())) return FALSE;
    /* 客户端子进程可能短暂占用 winmm.dll：重试约 5 秒再判定失败。 */
    {
        int attempt;
        for (attempt = 0; attempt < 25 && !removed; ++attempt) {
            if (DeleteFileW(dll)) { removed = TRUE; break; }
            if (GetLastError() == ERROR_FILE_NOT_FOUND) { removed = TRUE; break; }
            Sleep(200);
        }
    }
    if (!removed) {
        DWORD code = GetLastError();
        if (code == ERROR_ACCESS_DENIED) {
            h_print(L"uninstall-proxy: winmm.dll 仍被占用（客户端仍在运行？），请关闭客户端后重试，或以管理员身份运行\n");
            return FALSE;
        }
    }
    DeleteFileW(marker);
    { WCHAR portPath[CX_CLEANUP_PATH_CAP]; if (h_copy(portPath, CX_CLEANUP_PATH_CAP, targetDir) && h_cat(portPath, CX_CLEANUP_PATH_CAP, L"\\cxhook-port.txt")) DeleteFileW(portPath); }
    if (removed) { h_print(L"uninstall-proxy: removed "); h_print(dll); }
    else { h_print(L"uninstall-proxy: winmm.dll was already absent"); }
    return TRUE;
}
/* 诊断第一步：spawn + 单次 Browser.getVersion，带阶段打印，用于定位管道链路阻塞点。 */
/* 管道 CDP 客户端：spawn / 单次调用 / 完整诊断序列。 */
typedef struct {
    HANDLE toChild;
    HANDLE fromChild;
    HANDLE process;
    DWORD pid;
    DWORD nextId;
    char sessionId[80];
} H_PIPE_CDP;

static DWORD h_pipe_open_error;
static BOOL h_pipe_open(H_PIPE_CDP *state, const WCHAR *clientPath) {
    SECURITY_ATTRIBUTES inherit;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    WCHAR command[1024];
    DWORD at = 0, k = 0;
    HANDLE childIn = NULL, childOut = NULL;
    if (!state || !clientPath || !*clientPath) return FALSE;
    ZeroMemory(state, sizeof(*state));
    state->nextId = 1;
    h_pipe_open_error = 0;
    command[at++] = L'"';
    for (k = 0; clientPath[k] && at < 900; ++k) command[at++] = clientPath[k];
    command[at++] = L'"';
    {
        static const WCHAR tail[] = L" --remote-debugging-pipe";
        for (k = 0; tail[k] && at < 1000; ++k) command[at++] = tail[k];
    }
    if (h_pipe_extra_args[0]) {
        DWORD e = 0;
        command[at++] = L' ';
        while (h_pipe_extra_args[e] && at < 1100) command[at++] = h_pipe_extra_args[e++];
    }
    command[at] = 0;
    inherit.nLength = sizeof(inherit);
    inherit.lpSecurityDescriptor = NULL;
    inherit.bInheritHandle = TRUE;
    if (!CreatePipe(&childIn, &state->toChild, &inherit, 65536)) return FALSE;
    if (!CreatePipe(&state->fromChild, &childOut, &inherit, 65536)) {
        CloseHandle(childIn); CloseHandle(state->toChild); state->toChild = NULL;
        return FALSE;
    }
    SetHandleInformation(state->toChild, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(state->fromChild, HANDLE_FLAG_INHERIT, 0);
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = childIn;
    si.hStdOutput = childOut;
    si.hStdError = childOut;
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(NULL, command, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
        h_pipe_open_error = GetLastError();
        CloseHandle(childIn); CloseHandle(childOut);
        CloseHandle(state->toChild); CloseHandle(state->fromChild);
        state->toChild = NULL; state->fromChild = NULL;
        return FALSE;
    }
    CloseHandle(pi.hThread);
    CloseHandle(childIn);
    CloseHandle(childOut);
    state->process = pi.hProcess;
    state->pid = pi.dwProcessId;
    return TRUE;
}

static void h_pipe_close(H_PIPE_CDP *state) {
    if (!state) return;
    if (state->toChild) { CloseHandle(state->toChild); state->toChild = NULL; }
    if (state->fromChild) { CloseHandle(state->fromChild); state->fromChild = NULL; }
    if (state->process) { TerminateProcess(state->process, 0); CloseHandle(state->process); state->process = NULL; }
}

/* 1 = 拿到对应 id 的响应；0 = 超时；-1 = 错误 */
static int h_pipe_call(H_PIPE_CDP *state, const char *method, const char *params, char **reply, DWORD timeoutMs) {
    char command[4096];
    char expect[32];
    char digits[16];
    DWORD at = 0, k;
    DWORD deadline;
    const char *cursor;
    int id;
    if (reply) *reply = NULL;
    if (!state || !state->toChild || !state->fromChild || !method) return -1;
    id = (int)state->nextId++;
    wsprintfA(digits, "%d", id);
    command[at++] = '{';
    command[at++] = '"'; command[at++] = 'i'; command[at++] = 'd'; command[at++] = '"'; command[at++] = ':';
    for (k = 0; digits[k]; ++k) command[at++] = digits[k];
    {
        static const char mid[] = ",\"method\":\"";
        for (k = 0; mid[k]; ++k) command[at++] = mid[k];
    }
    for (cursor = method; *cursor && at < 3900; ++cursor) command[at++] = *cursor;
    command[at++] = '"';
    if (state->sessionId[0]) {
        static const char sessionPrefix[] = ",\"sessionId\":\"";
        for (k = 0; sessionPrefix[k]; ++k) command[at++] = sessionPrefix[k];
        for (cursor = state->sessionId; *cursor && at < 3950; ++cursor) command[at++] = *cursor;
        command[at++] = '"';
    }
    if (params && *params) {
        static const char paramsPrefix[] = ",\"params\":";
        for (k = 0; paramsPrefix[k]; ++k) command[at++] = paramsPrefix[k];
        for (cursor = params; *cursor && at < 4000; ++cursor) command[at++] = *cursor;
    }
    command[at++] = '}';
    command[at] = 0;
    lstrcpyA(expect, "\"id\":");
    lstrcatA(expect, digits);
    if (!net_pipe_send_frame(state->toChild, command, at)) return -1;
    deadline = GetTickCount() + timeoutMs;
    for (;;) {
        char *frame = NULL;
        DWORD frameLength = 0;
        DWORD left;
        int status;
        left = (deadline > GetTickCount()) ? (DWORD)(deadline - GetTickCount()) : 1;
        status = net_pipe_recv_frame(state->fromChild, &frame, &frameLength, left);
        if (status == 0) return 0;
        if (status < 0) return -1;
        if (frame && h_wcontains_a(frame, expect)) {
            if (reply) *reply = frame; else net_free(frame);
            return 1;
        }
        if (frame) net_free(frame);
        if (GetTickCount() >= deadline) return 0;
    }
}

static void h_pipe_stage(const WCHAR *name) {
    h_print(L"stage: ");
    h_print(name);
    h_print(L"\n");
}

static BOOL h_pipe_stage2(const WCHAR *clientPath, const WCHAR *expression) {
    H_PIPE_CDP state;
    char *reply = NULL;
    if (!clientPath || !*clientPath) { h_print(L"pipe-call: missing path"); return FALSE; }
    h_pipe_stage(L"open");
    if (!h_pipe_open(&state, clientPath)) { h_print(L"pipe-call: open failed"); return FALSE; }
    Sleep(800);
    h_pipe_stage(L"getVersion");
    if (h_pipe_call(&state, "Browser.getVersion", NULL, &reply, 8000) != 1) { h_print(L"pipe-call: getVersion failed"); h_pipe_close(&state); return FALSE; }
    net_free(reply); reply = NULL;
    h_pipe_stage(L"getTargets");
    if (h_pipe_call(&state, "Target.getTargets", NULL, &reply, 8000) != 1) { h_print(L"pipe-call: getTargets failed"); h_pipe_close(&state); return FALSE; }
    net_free(reply); reply = NULL;
    h_pipe_stage(L"attach");
    if (h_pipe_call(&state, "Target.attachToTarget", "{\"targetId\":\"CXFIXTURE\",\"flatten\":true}", &reply, 8000) != 1) { h_print(L"pipe-call: attach failed"); h_pipe_close(&state); return FALSE; }
    {
        static const char marker[] = "\"sessionId\":\"";
        int offset = reply ? h_find_offset(reply, marker) : -1;
        char *found = (offset >= 0) ? reply + offset + (int)sizeof(marker) - 1 : NULL;
        if (found) {
            int n = 0;
            while (found[n] && found[n] != '"' && n < (int)sizeof(state.sessionId) - 1) { state.sessionId[n] = found[n]; ++n; }
            state.sessionId[n] = 0;
            h_print(L"stage: session=");
            {
                WCHAR wide[80];
                int wideLength = MultiByteToWideChar(CP_UTF8, 0, state.sessionId, -1, wide, 79);
                if (wideLength > 0) { wide[wideLength] = 0; h_print(wide); }
            }
            h_print(L"\n");
        }
    }
    net_free(reply); reply = NULL;
    h_pipe_stage(L"evaluate");
    {
        char evalParams[2048];
        char expressionA[1024];
        int copied = 0;
        if (expression && *expression) copied = WideCharToMultiByte(CP_UTF8, 0, expression, -1, expressionA, 1000, NULL, NULL);
        if (copied <= 1) lstrcpyA(expressionA, "1+1");
        wsprintfA(evalParams, "{\"expression\":\"%s\",\"returnByValue\":true}", expressionA);
        if (h_pipe_call(&state, "Runtime.evaluate", evalParams, &reply, 8000) != 1) { h_print(L"pipe-call: evaluate failed"); h_pipe_close(&state); return FALSE; }
    }
    net_free(reply);
    h_pipe_stage(L"done");
    h_pipe_close(&state);
    return TRUE;
}
static char *h_bundle_source(const char *bundle, DWORD length, DWORD *outLength);

/* cdp-pipe 主流程（第一阶段）：管道启动客户端、attach 目标、注入 bootstrap 源码。 */

/* Chromium 的 --remote-debugging-pipe 采用 NUL 结尾的 JSON 帧（Puppeteer 同款），
   与 4 字节长度前缀的管道帧不同。这里实现 NUL 帧的请求/响应。 */
static int h_pipe_write_nul(HANDLE handle, const char *payload, DWORD length) {
    DWORD written = 0;
    if (!handle || !payload) return 0;
    if (!WriteFile(handle, payload, length, &written, NULL) || written != length) return 0;
    {
        char terminator = 0;
        if (!WriteFile(handle, &terminator, 1, &written, NULL) || written != 1) return 0;
    }
    return 1;
}

static int h_pipe_call_nul(H_PIPE_CDP *state, const char *method, const char *params, char **reply, DWORD timeoutMs) {
    char *command;
    DWORD capacity, at = 0;
    DWORD deadline;
    char digits[16];
    int id;
    const char *cursor;
    DWORD k;
    if (reply) *reply = NULL;
    if (!state || !state->toChild || !state->fromChild || !method) return -1;
    capacity = (DWORD)(lstrlenA(method) + (params ? lstrlenA(params) : 0) + 512);
    command = (char *)HeapAlloc(GetProcessHeap(), 0, capacity);
    if (!command) return -1;
    id = (int)state->nextId++;
    wsprintfA(digits, "%d", id);
    command[at++] = '{';
    command[at++] = '"'; command[at++] = 'i'; command[at++] = 'd'; command[at++] = '"'; command[at++] = ':';
    for (k = 0; digits[k]; ++k) command[at++] = digits[k];
    {
        static const char mid[] = ",\"method\":\"";
        for (k = 0; mid[k]; ++k) command[at++] = mid[k];
    }
    for (cursor = method; *cursor && at + 512 < capacity; ++cursor) command[at++] = *cursor;
    command[at++] = '"';
    if (state->sessionId[0]) {
        static const char sessionPrefix[] = ",\"sessionId\":\"";
        for (k = 0; sessionPrefix[k]; ++k) command[at++] = sessionPrefix[k];
        for (cursor = state->sessionId; *cursor && at + 256 < capacity; ++cursor) command[at++] = *cursor;
        command[at++] = '"';
    }
    if (params && *params) {
        static const char paramsPrefix[] = ",\"params\":";
        for (k = 0; paramsPrefix[k]; ++k) command[at++] = paramsPrefix[k];
        for (cursor = params; *cursor && at + 8 < capacity; ++cursor) command[at++] = *cursor;
    }
    command[at++] = '}';
    command[at] = 0;
    if (!h_pipe_write_nul(state->toChild, command, at)) { HeapFree(GetProcessHeap(), 0, command); return -1; }
    HeapFree(GetProcessHeap(), 0, command);
    deadline = GetTickCount() + timeoutMs;
    {
        char *buffer = (char *)HeapAlloc(GetProcessHeap(), 0, 1 << 20);
        DWORD used = 0;
        if (!buffer) return -1;
        for (;;) {
            DWORD available = 0, got = 0;
            DWORD left;
            if (!PeekNamedPipe(state->fromChild, NULL, 0, NULL, &available, NULL)) { HeapFree(GetProcessHeap(), 0, buffer); return -1; }
            if (available > 0) {
                DWORD want = available;
                if (used + want > (1 << 20) - 1) want = (1 << 20) - 1 - used;
                if (want && ReadFile(state->fromChild, buffer + used, want, &got, NULL) && got) {
                    used += got;
                    buffer[used] = 0;
                    if (h_memchr(buffer, 0, used)) {
                        /* 已收到完整 NUL 帧 */
                        if (h_wcontains_a(buffer, digits)) {
                            char *out = (char *)HeapAlloc(GetProcessHeap(), 0, used + 1);
                            if (out) { CopyMemory(out, buffer, used); out[used] = 0; }
                            HeapFree(GetProcessHeap(), 0, buffer);
                            if (reply) *reply = out; else if (out) HeapFree(GetProcessHeap(), 0, out);
                            return 1;
                        }
                        /* 不是本 id 的响应（事件），丢弃 */
                        used = 0;
                        buffer[0] = 0;
                    }
                }
            }
            left = (deadline > GetTickCount()) ? (DWORD)(deadline - GetTickCount()) : 0;
            if (!left) { HeapFree(GetProcessHeap(), 0, buffer); return 0; }
            Sleep(5);
        }
    }
}
static BOOL h_pipe_bootstrap(const CX_OPTIONS *options, const char *bootstrap, DWORD bootstrapLength, const char *bundle, DWORD bundleLength, const char *style, DWORD styleLength, WCHAR *error, DWORD errorCap) {
    H_PIPE_CDP state;
    char *reply = NULL;
    char targetId[80];
    char *params = NULL;
    DWORD paramsCap, at = 0;
    int offset;
    BOOL ok = FALSE;
    targetId[0] = 0;
    if (!options->quiet) h_print(L"cdp-pipe: launching client with --remote-debugging-pipe\n");
    if (!h_pipe_open(&state, h_selected_path)) {
        if (h_pipe_open_error == ERROR_ELEVATION_REQUIRED) {
            h_needs_elevation = TRUE;
            h_error(error, errorCap, L"cdp-pipe: client requires administrator rights; requesting UAC");
        } else {
            {
                WCHAR diag[128];
                wsprintfW(diag, L"cdp-pipe: launch failed (Win32 %lu)", (unsigned long)h_pipe_open_error);
                h_error(error, errorCap, diag);
            }
        }
        return FALSE;
    }
    h_client_pid = state.pid;
    Sleep(1200);
    {
        int tryIndex = 0, status = 0;
        for (tryIndex = 0; tryIndex < 4; ++tryIndex) {
            status = h_pipe_call_nul(&state, "Target.getTargets", NULL, &reply, 6000);
            if (status != 1) status = h_pipe_call(&state, "Target.getTargets", NULL, &reply, 3000);
            if (status == 1) break;
            if (!options->quiet) {
                WCHAR diag[96];
                wsprintfW(diag, L"cdp-pipe: Target.getTargets attempt %d status %d\n", tryIndex + 1, status);
                h_print(diag);
            }
            Sleep(1500);
        }
        if (status != 1) { h_error(error, errorCap, L"cdp-pipe: Target.getTargets failed"); goto done; }
    }
    offset = h_find_offset(reply, "\"targetId\":\"");
    if (offset >= 0) {
        const char *cursor = reply + offset + (int)sizeof("\"targetId\":\"") - 1;
        int n = 0;
        while (cursor[n] && cursor[n] != '"' && n < (int)sizeof(targetId) - 1) { targetId[n] = cursor[n]; ++n; }
        targetId[n] = 0;
    }
    net_free(reply); reply = NULL;
    if (!targetId[0]) { h_error(error, errorCap, L"cdp-pipe: no page target found"); goto done; }
    paramsCap = (DWORD)lstrlenA(targetId) + 64;
    params = (char *)HeapAlloc(GetProcessHeap(), 0, paramsCap);
    if (!params) { h_error(error, errorCap, L"cdp-pipe: out of memory"); goto done; }
    at = 0;
    {
        static const char head[] = "{\"targetId\":\"";
        DWORD k;
        for (k = 0; head[k]; ++k) params[at++] = head[k];
        for (k = 0; targetId[k]; ++k) params[at++] = targetId[k];
        static const char tail[] = "\",\"flatten\":true}";
        for (k = 0; tail[k]; ++k) params[at++] = tail[k];
        params[at] = 0;
    }
    if (h_pipe_call_nul(&state, "Target.attachToTarget", params, &reply, 8000) != 1 && h_pipe_call(&state, "Target.attachToTarget", params, &reply, 4000) != 1) { h_error(error, errorCap, L"cdp-pipe: attachToTarget failed"); goto done; }
    offset = h_find_offset(reply, "\"sessionId\":\"");
    if (offset >= 0) {
        const char *cursor = reply + offset + (int)sizeof("\"sessionId\":\"") - 1;
        int n = 0;
        while (cursor[n] && cursor[n] != '"' && n < (int)sizeof(state.sessionId) - 1) { state.sessionId[n] = cursor[n]; ++n; }
        state.sessionId[n] = 0;
    }
    net_free(reply); reply = NULL;
    if (!state.sessionId[0]) { h_error(error, errorCap, L"cdp-pipe: attach returned no sessionId"); goto done; }
    /* 先下发页面配置（与 WebSocket 通道同一份表达式），再注入 bootstrap。 */
    if (state.sessionId[0]) {
        char *configExpression = NULL;
        DWORD configLength = 0;
        if (h_build_page_config(options, style, styleLength, &configExpression, &configLength, error, errorCap)) {
            DWORD cap2 = configLength * 6 + 256;
            char *configParams = (char *)HeapAlloc(GetProcessHeap(), 0, cap2);
            if (configParams) {
                DWORD at2 = 0, k2 = 0;
                static const char head[] = "{\"expression\":";
                static const char tail[] = ",\"returnByValue\":true}";
                for (k2 = 0; head[k2]; ++k2) configParams[at2++] = head[k2];
                if (h_json_quote(configParams, cap2, &at2, configExpression, configLength)) {
                    for (k2 = 0; tail[k2]; ++k2) configParams[at2++] = tail[k2];
                    configParams[at2] = 0;
                    if (h_pipe_call(&state, "Runtime.evaluate", configParams, &reply, 10000) == 1) {
                        net_free(reply);
                        reply = NULL;
                        h_ui_record("info", "pipe-config");
                    }
                }
                HeapFree(GetProcessHeap(), 0, configParams);
            }
            HeapFree(GetProcessHeap(), 0, configExpression);
        }
    }
    HeapFree(GetProcessHeap(), 0, params);
    paramsCap = bootstrapLength * 6 + 256;
    params = (char *)HeapAlloc(GetProcessHeap(), 0, paramsCap);
    if (!params) { h_error(error, errorCap, L"cdp-pipe: out of memory"); goto done; }
    at = 0;
    {
        static const char head[] = "{\"expression\":";
        DWORD k;
        for (k = 0; head[k]; ++k) params[at++] = head[k];
    }
    if (!h_json_quote(params, paramsCap, &at, bootstrap, bootstrapLength)) { h_error(error, errorCap, L"cdp-pipe: bootstrap too large"); goto done; }
    {
        static const char tail[] = ",\"returnByValue\":true}";
        DWORD k;
        for (k = 0; tail[k]; ++k) params[at++] = tail[k];
        params[at] = 0;
    }
    if (h_pipe_call(&state, "Runtime.evaluate", params, &reply, 15000) != 1) { h_error(error, errorCap, L"cdp-pipe: bootstrap evaluate failed"); goto done; }
    net_free(reply); reply = NULL;
    if (options->panelAllPages) {
        static const char panelExpr[] = "{\"expression\":\"window.__CX_WIN_PANEL_ALL_PAGES__=true\",\"returnByValue\":true}";
        char *panelReply = NULL;
        h_pipe_call(&state, "Runtime.evaluate", panelExpr, &panelReply, 8000);
        if (panelReply) net_free(panelReply);
    }    h_report.bootstraps += 1;
    if (!options->quiet) h_print(L"cdp-pipe: bootstrap injected\n");
    if (bundle && bundleLength) {
        char *wrapped = NULL;
        DWORD wrappedLength = 0;
        HeapFree(GetProcessHeap(), 0, params);
        params = NULL;
        wrapped = h_bundle_source(bundle, bundleLength, &wrappedLength);
        if (!wrapped) { h_error(error, errorCap, L"cdp-pipe: bundle wrap failed"); goto done; }
        paramsCap = wrappedLength * 6 + 256;
        params = (char *)HeapAlloc(GetProcessHeap(), 0, paramsCap);
        if (!params) { net_free(wrapped); h_error(error, errorCap, L"cdp-pipe: out of memory"); goto done; }
        at = 0;
        {
            static const char head[] = "{\"expression\":";
            DWORD k;
            for (k = 0; head[k]; ++k) params[at++] = head[k];
        }
        if (!h_json_quote(params, paramsCap, &at, wrapped, wrappedLength)) { net_free(wrapped); h_error(error, errorCap, L"cdp-pipe: bundle too large"); goto done; }
        net_free(wrapped);
        {
            static const char tail[] = ",\"returnByValue\":true}";
            DWORD k;
            for (k = 0; tail[k]; ++k) params[at++] = tail[k];
            params[at] = 0;
        }
        if (h_pipe_call(&state, "Runtime.evaluate", params, &reply, 15000) != 1) { h_error(error, errorCap, L"cdp-pipe: bundle evaluate failed"); goto done; }
        net_free(reply); reply = NULL;
        h_report.bundles += 1;
        if (!options->quiet) h_print(L"cdp-pipe: bundle injected\n");
    }
    ok = TRUE;
done:
    if (params) HeapFree(GetProcessHeap(), 0, params);
    if (reply) net_free(reply);
    h_pipe_close(&state);
    return ok;
}
/* 离线兼容性探测：不启动客户端，只读文件判断可用的注入通道。 */

/* 检查 PE 是否包含指定节（例如 Themida 加壳的 .themida）。 */
static BOOL h_pe_section_named(const WCHAR *path, const char *sectionName) {
    HANDLE file;
    IMAGE_DOS_HEADER dos;
    IMAGE_NT_HEADERS nt;
    DWORD read = 0, i;
    BOOL found = FALSE;
    if (!path || !sectionName) return FALSE;
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    if (!ReadFile(file, &dos, sizeof(dos), &read, NULL) || read != sizeof(dos) || dos.e_magic != IMAGE_DOS_SIGNATURE) { CloseHandle(file); return FALSE; }
    if (SetFilePointer(file, dos.e_lfanew, NULL, FILE_BEGIN) == INVALID_SET_FILE_POINTER) { CloseHandle(file); return FALSE; }
    if (!ReadFile(file, &nt, sizeof(nt), &read, NULL) || read != sizeof(nt) || nt.Signature != IMAGE_NT_SIGNATURE) { CloseHandle(file); return FALSE; }
    {
        IMAGE_SECTION_HEADER section;
        for (i = 0; i < nt.FileHeader.NumberOfSections; ++i) {
            if (!ReadFile(file, &section, sizeof(section), &read, NULL) || read != sizeof(section)) break;
            {
                int k = 0, same = 1;
                for (k = 0; k < 8; ++k) {
                    char a = (char)section.Name[k];
                    char b = sectionName[k];
                    if (a != b) { same = 0; break; }
                    if (!b) break;
                }
                if (same) { found = TRUE; break; }
            }
        }
    }
    CloseHandle(file);
    return found;
}
static BOOL h_file_contains(const WCHAR *path, const char *needle) {
    static char buffer[1 << 20];
    HANDLE file;
    DWORD got = 0, keep = 0;
    int needleLength;
    BOOL found = FALSE;
    if (!path || !needle) return FALSE;
    needleLength = (int)lstrlenA(needle);
    if (needleLength <= 0 || needleLength > 256) return FALSE;
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                       NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    for (;;) {
        DWORD chunk = 0;
        DWORD i;
        if (!ReadFile(file, buffer + keep, (DWORD)sizeof(buffer) - keep, &chunk, NULL) || chunk == 0) break;
        got = keep + chunk;
        for (i = 0; i + (DWORD)needleLength <= got; ++i) {
            int k = 0;
            while (k < needleLength && buffer[i + k] == needle[k]) ++k;
            if (k == needleLength) { found = TRUE; break; }
        }
        if (found) break;
        keep = (DWORD)(needleLength - 1);
        if (got > keep) CopyMemory(buffer, buffer + got - keep, keep);
    }
    CloseHandle(file);
    return found;
}

/* 大小写不敏感的文件内容查找（用于探测 PE 导入表里的 DLL 名）。 */
static BOOL h_file_contains_ci(const WCHAR *path, const char *needle) {
    static char buffer[1 << 20];
    static char lowerNeedle[256];
    HANDLE file;
    DWORD got = 0, keep = 0;
    int needleLength = 0, i;
    BOOL found = FALSE;
    if (!path || !needle) return FALSE;
    while (needle[needleLength] && needleLength < 255) {
        char ch = needle[needleLength];
        lowerNeedle[needleLength] = (ch >= 'A' && ch <= 'Z') ? (char)(ch - 'A' + 'a') : ch;
        ++needleLength;
    }
    lowerNeedle[needleLength] = 0;
    if (!needleLength) return FALSE;
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                       NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    for (;;) {
        DWORD chunk = 0;
        if (!ReadFile(file, buffer + keep, (DWORD)sizeof(buffer) - keep, &chunk, NULL) || chunk == 0) break;
        got = keep + chunk;
        for (i = 0; i + needleLength <= (int)got; ++i) {
            int k = 0;
            while (k < needleLength) {
                char ch = buffer[i + k];
                if (ch >= 'A' && ch <= 'Z') ch = (char)(ch - 'A' + 'a');
                if (ch != lowerNeedle[k]) break;
                ++k;
            }
            if (k == needleLength) { found = TRUE; break; }
        }
        if (found) break;
        keep = (DWORD)(needleLength - 1);
        if (got > keep) CopyMemory(buffer, buffer + got - keep, keep);
    }
    CloseHandle(file);
    return found;
}
static const WCHAR *h_probe_target_path;
static const WCHAR *h_probe_path_global(void) { return h_probe_target_path ? h_probe_target_path : L""; }
static BOOL h_probe_client(const WCHAR *clientPath) {
    h_probe_target_path = clientPath;
    WCHAR dir[CX_CLEANUP_PATH_CAP], cef[CX_CLEANUP_PATH_CAP], winmm[CX_CLEANUP_PATH_CAP], marker[CX_CLEANUP_PATH_CAP];
    WCHAR version[64];
    WORD machine = 0, major = 0, minor = 0;
    BOOL hasPort = FALSE, hasPipe = FALSE, proxyPresent = FALSE, markerPresent = FALSE, proxyUsable = TRUE;
    if (!clientPath || !*clientPath) { h_print(L"probe: pass --probe-client <CXExam.exe>"); return FALSE; }
    h_print(L"probe: client="); h_print(clientPath); h_print(L"\n");
    if (!proc_pe(clientPath, &machine, &major, &minor, version, 64)) { h_print(L"probe: not a valid PE"); return FALSE; }
    {
        WCHAR line[192];
        wsprintfW(line, L"probe: machine=%s version=%s", machine == 0x8664 ? L"x64" : L"x86", version);
        h_print(line);
        h_print(L"\n");
    }
    if (!h_parent_dir(clientPath, dir, CX_CLEANUP_PATH_CAP)) { h_print(L"probe: cannot resolve client directory"); return FALSE; }
    h_copy(cef, CX_CLEANUP_PATH_CAP, dir); h_cat(cef, CX_CLEANUP_PATH_CAP, L"\\libcef.dll");
    h_copy(winmm, CX_CLEANUP_PATH_CAP, dir); h_cat(winmm, CX_CLEANUP_PATH_CAP, L"\\winmm.dll");
    h_copy(marker, CX_CLEANUP_PATH_CAP, dir); h_cat(marker, CX_CLEANUP_PATH_CAP, L"\\cxhook-proxy.marker");
    if (GetFileAttributesW(cef) != INVALID_FILE_ATTRIBUTES) {
        WCHAR line[192];
        HANDLE cefFile = CreateFileW(cef, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        LARGE_INTEGER size;
        size.QuadPart = 0;
        if (cefFile != INVALID_HANDLE_VALUE) { GetFileSizeEx(cefFile, &size); CloseHandle(cefFile); }
        hasPort = h_file_contains(cef, "remote-debugging-port");
        hasPipe = h_file_contains(cef, "remote-debugging-pipe");
        wsprintfW(line, L"probe: libcef=%luMB port=%s pipe=%s",
                  (unsigned long)(size.QuadPart >> 20),
                  hasPort ? L"yes" : L"no", hasPipe ? L"yes" : L"no");
        h_print(line); h_print(L"\n");
    } else {
        h_print(L"probe: libcef.dll not found\n");
    }
    proxyPresent = GetFileAttributesW(winmm) != INVALID_FILE_ATTRIBUTES;
    markerPresent = GetFileAttributesW(marker) != INVALID_FILE_ATTRIBUTES;
    {
        BOOL clientUsesWinmm = h_file_contains_ci(clientPath, "winmm.dll");
        h_print(L"probe: client-winmm="); h_print(clientUsesWinmm ? L"yes" : L"no"); h_print(L"\n");
        if (!clientUsesWinmm) proxyUsable = FALSE;
    }
    {
        WCHAR portFile[CX_CLEANUP_PATH_CAP];
        BOOL portFilePresent = FALSE;
        if (h_copy(portFile, CX_CLEANUP_PATH_CAP, dir) && h_cat(portFile, CX_CLEANUP_PATH_CAP, L"\\cxhook-port.txt")) {
            portFilePresent = GetFileAttributesW(portFile) != INVALID_FILE_ATTRIBUTES;
        }
        h_print(L"probe: winmm="); h_print(proxyPresent ? L"present" : L"absent");
        h_print(L" marker="); h_print(markerPresent ? L"present" : L"absent");
        h_print(L" portfile="); h_print(portFilePresent ? L"present" : L"absent");
        h_print(L"\n");
    }
    h_print(L"probe: packed="); h_print(h_pe_section_named(clientPath, ".themida") ? L"themida" : L"none"); h_print(L"\n");
    h_print(L"probe: channel=");
    if (h_pe_section_named(clientPath, ".themida")) h_print(L"dll-proxy");
    else h_print(L"cdp-port");
    h_print(L"\n");
    h_print(L"probe: proxies=");
    {
        int printed = 0, ci;
        for (ci = 0; ci < h_proxy_carrier_count; ++ci) {
            WCHAR dll[32];
            int k = 0;
            while (h_proxy_carriers[ci][k] && k < 24) { dll[k] = h_proxy_carriers[ci][k]; ++k; }
            dll[k++] = L'.'; dll[k++] = L'd'; dll[k++] = L'l'; dll[k++] = L'l'; dll[k] = 0;
            if (h_carrier_is_known_dll(h_proxy_carriers[ci])) continue;
            if (h_pe_imports_dll(h_probe_path_global(), dll)) {
                if (printed) h_print(L",");
                h_print(h_proxy_carriers[ci]);
                printed = 1;
            }
        }
        if (!printed) h_print(L"none");
    }
    h_print(L"\n");
    h_print(L"probe: suggested=");
    if (markerPresent && proxyUsable) h_print(L"dll-proxy");
    else if (h_pe_section_named(clientPath, ".themida")) h_print(markerPresent ? L"dll-proxy" : L"dll-proxy-required");
    else if (hasPipe && !hasPort) h_print(L"cdp-pipe");
    else h_print(L"cdp-port");
    h_print(L"\n");
    return TRUE;
}
/* 扫描常见目录并对每个候选客户端做离线探测（不启动、不写盘）。 */
static BOOL h_probe_all(void) {
    CX_DISCOVERY_OPTIONS options;
    CX_DISCOVERY_RESULT result;
    WCHAR error[HOST_ERROR_CAP];
    DWORD i;
    BOOL ok = TRUE;
    ZeroMemory(&options, sizeof(options));
    options.mode = CX_DISCOVERY_SCAN_COMMON;
    options.hostIs32Bit = FALSE;
    cx_discovery_init(&result);
    error[0] = 0;
    if (!cx_discovery_scan(&options, &result, error, HOST_ERROR_CAP)) {
        h_print(L"probe-all: scan failed: "); h_print(error); h_print(L"\n");
        cx_discovery_free(&result);
        return FALSE;
    }
    {
        WCHAR line[96];
        wsprintfW(line, L"probe-all: candidates=%lu", (unsigned long)result.count);
        h_print(line); h_print(L"\n");
    }
    for (i = 0; i < result.count; ++i) {
        h_print(L"---\n");
        if (!h_probe_client(result.items[i].path)) ok = FALSE;
    }
    {
        /* 汇总：每个客户端按 auto 逻辑会走哪条通道。 */
        DWORD portableClients = 0, proxyClients = 0;
        for (i = 0; i < result.count; ++i) {
            if (h_pe_section_named(result.items[i].path, ".themida")) ++proxyClients;
            else ++portableClients;
        }
        {
            WCHAR line[128];
            wsprintfW(line, L"plan: clients=%lu cdp-port=%lu dll-proxy=%lu", (unsigned long)result.count,
                      (unsigned long)portableClients, (unsigned long)proxyClients);
            h_print(line); h_print(L"\n");
        }
    }
    cx_discovery_free(&result);
    return ok;
}
static BOOL h_pipe_test(void) {
    SECURITY_ATTRIBUTES sa;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    HANDLE childIn = NULL, parentWrite = NULL, parentRead = NULL, childOut = NULL;
    WCHAR command[512];
    char buffer[256];
    DWORD got = 0, index = 0;
    BOOL ok = FALSE;
    static const WCHAR cmdToken[] = L"\"C:\\Windows\\System32\\cmd.exe\" /c echo PIPE-TEST-OK";
    while (cmdToken[index] && index < 500) { command[index] = cmdToken[index]; ++index; }
    command[index] = 0;
    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;
    if (!CreatePipe(&childIn, &parentWrite, &sa, 0)) { h_print(L"pipe-test: stdin pipe failed"); return FALSE; }
    if (!CreatePipe(&parentRead, &childOut, &sa, 0)) { h_print(L"pipe-test: stdout pipe failed"); CloseHandle(childIn); CloseHandle(parentWrite); return FALSE; }
    SetHandleInformation(parentWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(parentRead, HANDLE_FLAG_INHERIT, 0);
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = childIn;
    si.hStdOutput = childOut;
    si.hStdError = childOut;
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(NULL, command, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
        WCHAR msg[64];
        wsprintfW(msg, L"pipe-test: CreateProcess failed (%lu)", (unsigned long)GetLastError());
        if (msg[0]) h_print(msg);
        goto done;
    }
    CloseHandle(pi.hThread);
    CloseHandle(childIn); childIn = NULL;
    CloseHandle(childOut); childOut = NULL;
    WaitForSingleObject(pi.hProcess, 10000);
    ZeroMemory(buffer, sizeof(buffer));
    if (ReadFile(parentRead, buffer, sizeof(buffer) - 1, &got, NULL) && got > 0) {
        WCHAR wide[256];
        int wideLength = MultiByteToWideChar(CP_UTF8, 0, buffer, (int)got, wide, 255);
        if (wideLength > 0) { wide[wideLength] = 0; h_print(L"pipe-test: "); h_print(wide); }
        ok = TRUE;
    } else {
        h_print(L"pipe-test: no output");
    }
    CloseHandle(pi.hProcess);
done:
    if (childIn) CloseHandle(childIn);
    if (childOut) CloseHandle(childOut);
    if (parentWrite) CloseHandle(parentWrite);
    if (parentRead) CloseHandle(parentRead);
    return ok;
}

static void h_silent_cleanup_pass(void) {
    WCHAR root[CX_CLEANUP_PATH_CAP];
    int failed = 0;
    if (!h_silent_plan) {
        if (!h_silent_root(root, CX_CLEANUP_PATH_CAP)) { h_audit_event("warn", "cleanup", "Program root is unavailable"); return; }
        if (!h_silent_simulate && !cx_cleanup_is_release_layout(root)) {
            h_silent_plan = NULL;
            h_audit_event("warn", "cleanup", "Not a release layout; program deletion is skipped");
            return;
        }
        h_silent_plan = (CX_CLEANUP_PLAN *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(CX_CLEANUP_PLAN));
        if (!h_silent_plan) { h_audit_event("warn", "cleanup", "Cleanup plan allocation failed"); return; }
        if (!cx_cleanup_collect(root, h_silent_plan)) { h_audit_event("warn", "cleanup", "Program traces could not be collected"); return; }
    }
    if (!h_silent_simulate && !h_silent_parked[0] && h_exe_path[0]) {
        if (cx_cleanup_detach_self(h_exe_path, h_silent_parked, CX_CLEANUP_PATH_CAP))
            h_audit_event("info", "cleanup", "Running executable renamed; original path removed");
        else
            h_audit_event("warn", "cleanup", "Running executable could not be renamed");
    }
    (void)cx_cleanup_apply(h_silent_plan, h_silent_simulate, 5, &failed);
    if (failed) h_audit_event("warn", "cleanup", "Some program files are still locked; retrying while running");
    else h_audit_event("info", "cleanup", h_silent_simulate ? "Program deletion planned (simulate)" : "Program traces removed");
}

static void h_silent_begin_destruct(void) {
    WCHAR reason[CX_SILENT_REASON_CAP];
    if (!h_silent_active || h_silent_done) return;
    reason[0] = 0;
    if (!cx_silent_finish(&h_silent, reason, CX_SILENT_REASON_CAP)) return;
    h_silent_done = TRUE;
    h_audit_event("info", "self-destruct", "Destruction requested; removing program traces");
    h_silent_cleanup_pass();
    if (h_silent_parked[0]) { cx_cleanup_release_self(h_silent_parked); h_silent_parked[0] = 0; }
    h_report.stopReason = "self-destruct";
}

static void h_silent_tick(void) {
    DWORD now;
    if (!h_silent_active || h_silent_done) return;
    now = GetTickCount();
    if (h_client_pid && !proc_alive(h_client_pid)) cx_silent_client_exited(&h_silent, h_client_pid);
    if (h_silent.state == CX_SILENT_DESTRUCT_REQUESTED) { h_silent_begin_destruct(); return; }
    if (h_silent_next_tick && now - h_silent_next_tick < 5000) return;
    h_silent_next_tick = now;
    h_silent_cleanup_pass();
}

static void h_silent_widen(const char *src, WCHAR *dst, DWORD cap) {
    DWORD i = 0;
    if (!dst || cap == 0) return;
    while (src && src[i] && i + 1 < cap) { dst[i] = (WCHAR)(unsigned char)src[i]; ++i; }
    dst[i] = 0;
}

static BOOL h_append_uint(char *dst, DWORD cap, DWORD *at, DWORD value) {
    char digits[12];
    DWORD used = 0, i;
    do { digits[used++] = (char)('0' + value % 10); value /= 10; } while (value);
    if (*at + used + 1 > cap) return FALSE;
    for (i = 0; i < used; ++i) dst[(*at)++] = digits[used - 1 - i];
    dst[*at] = 0;
    return TRUE;
}
static void h_audit_page_message(const char *json, const JT *tokens, int params) {
    const char prefix[] = "__CX_WIN_MSG__";
    int args = jkey(json, tokens, params, "args"), arg, i, length;
    if (args < 0 || tokens[args].type != '[') return;
    for (arg = args + 1; arg < tokens[args].next; arg = tokens[arg].next) {
        if (!jeq(json, tokens, jkey(json, tokens, arg, "type"), "string")
            || !jstr(json, tokens, jkey(json, tokens, arg, "value"), h_page_message, sizeof(h_page_message))) continue;
        for (i = 0; prefix[i] && h_page_message[i] == prefix[i]; ++i) { }
        if (prefix[i]) continue;
        length = h_len(h_page_message + i);
        if (jparse(h_page_message + i, length, h_page_message_tokens, HOST_REPLY_TOKENS) <= 0) return;
        if (jeq(h_page_message + i, h_page_message_tokens, jkey(h_page_message + i, h_page_message_tokens, 0, "kind"), "bootstrap-error")) {
            ++h_report.errors;
            h_audit_event("warn", "bootstrap", "Bootstrap reported an error; detail omitted");
        } else if (jeq(h_page_message + i, h_page_message_tokens, jkey(h_page_message + i, h_page_message_tokens, 0, "kind"), "config-sync")) {
            int detail = jkey(h_page_message + i, h_page_message_tokens, 0, "detail");
            if (detail >= 0 && h_page_message_tokens[detail].type == '{'
                && jeq(h_page_message + i, h_page_message_tokens, jkey(h_page_message + i, h_page_message_tokens, 0, "source"), "chaoxing-plus-windows")
                && jeq(h_page_message + i, h_page_message_tokens, jkey(h_page_message + i, h_page_message_tokens, 0, "instance"), h_instance)
                && cx_session_can_sync_config(h_current_page->state, jint(json, tokens, jkey(json, tokens, params, "executionContextId"), -1)))
                h_config_queue(h_page_message + i + h_page_message_tokens[detail].start,
                    (DWORD)(h_page_message_tokens[detail].end - h_page_message_tokens[detail].start));
        } else if (h_silent_active
            && (jeq(h_page_message + i, h_page_message_tokens, jkey(h_page_message + i, h_page_message_tokens, 0, "kind"), "silent-hotkey")
                || jeq(h_page_message + i, h_page_message_tokens, jkey(h_page_message + i, h_page_message_tokens, 0, "kind"), "silent-fullscreen"))) {
            int silentDetail = jkey(h_page_message + i, h_page_message_tokens, 0, "detail");
            if (silentDetail >= 0 && h_page_message_tokens[silentDetail].type == '{'
                && jeq(h_page_message + i, h_page_message_tokens, jkey(h_page_message + i, h_page_message_tokens, 0, "source"), "chaoxing-plus-windows")
                && jeq(h_page_message + i, h_page_message_tokens, jkey(h_page_message + i, h_page_message_tokens, 0, "instance"), h_instance)) {
                if (jeq(h_page_message + i, h_page_message_tokens, jkey(h_page_message + i, h_page_message_tokens, 0, "kind"), "silent-hotkey")) {
                    char rawShortcut[CX_SILENT_KEY_CAP];
                    WCHAR shortcut[CX_SILENT_KEY_CAP];
                    if (jstr(h_page_message + i, h_page_message_tokens,
                             jkey(h_page_message + i, h_page_message_tokens, silentDetail, "shortcut"),
                             rawShortcut, CX_SILENT_KEY_CAP)) {
                        h_silent_widen(rawShortcut, shortcut, CX_SILENT_KEY_CAP);
                        if (cx_silent_hotkey(&h_silent, shortcut)) h_silent_begin_destruct();
                    }
                } else {
                    int flag = jkey(h_page_message + i, h_page_message_tokens, silentDetail, "fullscreen");
                    BOOL fullscreen = FALSE;
                    if (flag >= 0 && h_page_message_tokens[flag].type == 't'
                        && h_page_message_tokens[flag].end - h_page_message_tokens[flag].start == 4) fullscreen = TRUE;
                    if (cx_silent_fullscreen(&h_silent, fullscreen, h_client_pid)) h_silent_begin_destruct();
                }
            }
        }
        return;
    }
}
static BOOL h_operation_active(void) {
    if (h_silent_done) return FALSE;
    if (h_client_pid && !proc_alive(h_client_pid)) return FALSE;
    if (h_duration && GetTickCount() - h_started >= h_duration) return FALSE;
    if (h_ui_sending && (!h_current_page || !h_current_page->uiReady || h_current_page->uiEpoch != h_ui_epoch
        || !cx_session_can_sync_config(h_current_page->state, h_current_page->uiContext))) return FALSE;
    return !h_task_pending || !h_current_page || cx_session_task_active(h_current_page->state, &h_current_task);
}
static void h_dispatch_event(const char *json, DWORD length) {
    JT *tokens = h_event_tokens;
    int params, frame, method;
    if (!h_current_page || !h_current_page->state) return;
    cx_session_feed(h_current_page->state, json, length);
    if (h_current_page->uiReady && !cx_session_can_sync_config(h_current_page->state, h_current_page->uiContext))
        h_ui_reset_document(h_current_page);
    h_sample_page(h_current_page);
    if (jparse(json, (int)length, tokens, HOST_REPLY_TOKENS) <= 0) return;
    method = jkey(json, tokens, 0, "method");
    if (jeq(json, tokens, method, "Page.frameNavigated")) {
        params = jkey(json, tokens, 0, "params");
        frame = jkey(json, tokens, params, "frame");
        if (frame >= 0 && jkey(json, tokens, frame, "parentId") < 0) {
            h_ui_reset_document(h_current_page);
            h_current_page->ensureAt = GetTickCount() + 2500;
            h_current_page->ensurePending = TRUE;
            h_audit_event("info", "nav", "Top document navigated");
        }
    } else if (h_capture_console && jeq(json, tokens, method, "Runtime.exceptionThrown")) {
        ++h_report.errors;
        h_audit_event("warn", "page", "Page exception observed; page text omitted");
    } else if (jeq(json, tokens, method, "Runtime.consoleAPICalled")) {
        params = jkey(json, tokens, 0, "params");
        h_audit_page_message(json, tokens, params);
        if (h_capture_console && jeq(json, tokens, jkey(json, tokens, params, "type"), "error"))
            h_audit_event("warn", "page", "Console error observed; page text omitted");
    }
}
static BOOL h_append_bytes(char *out, DWORD cap, DWORD *at, const char *text, DWORD length) {
    if (!out || !at || !text || *at >= cap || length >= cap - *at) return FALSE;
    CopyMemory(out + *at, text, length); *at += length; out[*at] = 0; return TRUE;
}
static BOOL h_json_quote(char *out, DWORD cap, DWORD *at, const char *text, DWORD length) {
    static const char hex[] = "0123456789abcdef";
    DWORD i, need; unsigned char c;
    if (!out || !at || !text || *at >= cap || cap - *at < 2) return FALSE; out[(*at)++] = '"';
    for (i = 0; i < length; ++i) {
        c = (unsigned char)text[i];
        need = (c == '"' || c == '\\' || c == '\r' || c == '\n' || c == '\t') ? 2 : (c < 32 ? 6 : 1);
        if (*at > cap - need - 1) return FALSE;
        if (c == '"' || c == '\\') { out[(*at)++] = '\\'; out[(*at)++] = (char)c; }
        else if (c == '\r') { out[(*at)++] = '\\'; out[(*at)++] = 'r'; }
        else if (c == '\n') { out[(*at)++] = '\\'; out[(*at)++] = 'n'; }
        else if (c == '\t') { out[(*at)++] = '\\'; out[(*at)++] = 't'; }
        else if (c < 32) { out[(*at)++] = '\\'; out[(*at)++] = 'u'; out[(*at)++] = '0'; out[(*at)++] = '0'; out[(*at)++] = hex[c >> 4]; out[(*at)++] = hex[c & 15]; }
        else out[(*at)++] = (char)c;
    }
    if (*at >= cap) return FALSE; out[(*at)++] = '"'; out[*at] = 0; return TRUE;
}
static BOOL h_wait_reply(NET_WS *ws, DWORD id, BOOL requireTrue, char **replyOut, DWORD *lengthOut, WCHAR *error, DWORD errorCap) {
    JT *tokens;
    char *reply = NULL;
    DWORD started = GetTickCount(), length = 0, elapsed, wait;
    int received, count, result, exception, remote, type, value;
    if (replyOut) *replyOut = NULL;
    if (lengthOut) *lengthOut = 0;
    tokens = (JT *)HeapAlloc(GetProcessHeap(), 0, sizeof(JT) * HOST_REPLY_TOKENS);
    if (!tokens) { h_error(error, errorCap, L"out of memory parsing CDP response"); return FALSE; }
    for (;;) {
        elapsed = GetTickCount() - started;
        if (!h_operation_active()) { h_error(error, errorCap, L"CDP operation cancelled"); break; }
        if (elapsed >= h_command_timeout) { h_error(error, errorCap, L"timed out waiting for CDP response"); break; }
        wait = h_command_timeout - elapsed;
        if (wait > 100) wait = 100;
        received = net_ws_read_timeout(ws, &reply, &length, wait, error, errorCap);
        if (received < 0) break;
        if (!received) continue;
        count = jparse(reply, (int)length, tokens, HOST_REPLY_TOKENS);
        if (count <= 0) { h_error(error, errorCap, L"invalid or oversized CDP JSON response"); net_free(reply); reply = NULL; break; }
        if (jkey(reply, tokens, 0, "method") >= 0) h_dispatch_event(reply, length);
        if ((DWORD)jint(reply, tokens, jkey(reply, tokens, 0, "id"), -1) != id) { net_free(reply); reply = NULL; continue; }
        result = jkey(reply, tokens, 0, "result");
        exception = result >= 0 ? jkey(reply, tokens, result, "exceptionDetails") : -1;
        if (jkey(reply, tokens, 0, "error") >= 0 || exception >= 0 || result < 0) {
            h_error(error, errorCap, L"CDP command returned an error or exception"); net_free(reply); reply = NULL; break;
        }
        remote = result >= 0 ? jkey(reply, tokens, result, "result") : -1;
        type = remote >= 0 ? jkey(reply, tokens, remote, "type") : -1;
        value = remote >= 0 ? jkey(reply, tokens, remote, "value") : -1;
        if (requireTrue && (!jeq(reply, tokens, type, "boolean") || value < 0 || tokens[value].type != 'p' || !jeq(reply, tokens, value, "true"))) {
            h_error(error, errorCap, L"DOM script did not acknowledge execution (CSP, syntax or runtime failure)"); net_free(reply); reply = NULL; break;
        }
        if (replyOut) { *replyOut = reply; if (lengthOut) *lengthOut = length; }
        else net_free(reply);
        HeapFree(GetProcessHeap(), 0, tokens);
        return TRUE;
    }
    HeapFree(GetProcessHeap(), 0, tokens);
    return FALSE;
}
static DWORD h_decimal(char *out, DWORD value) {
    char digits[16]; DWORD n = 0, at = 0;
    do { digits[n++] = (char)('0' + value % 10); value /= 10; } while (value);
    while (n) out[at++] = digits[--n];
    out[at] = 0; return at;
}
static BOOL h_send_eval_result(NET_WS *ws, DWORD id, const char *expression, DWORD expressionLength, BOOL requireTrue,
                               char **replyOut, DWORD *replyLengthOut, WCHAR *error, DWORD errorCap) {
    char *command; DWORD at = 0, commandCap; char idText[16]; DWORD n = 0; unsigned int v = id;
    if (replyOut) *replyOut = NULL;
    if (replyLengthOut) *replyLengthOut = 0;
    if (!h_operation_active()) { h_error(error, errorCap, L"CDP operation cancelled"); return FALSE; }
    if (!expression || expressionLength > HOST_EVAL_SOURCE_CAP) { h_error(error, errorCap, L"CDP expression exceeds native limit"); return FALSE; }
    commandCap = expressionLength * 6UL + 1024UL;
    if (commandCap > HOST_COMMAND_CAP) commandCap = HOST_COMMAND_CAP;
    command = (char *)HeapAlloc(GetProcessHeap(), 0, commandCap); if (!command) { h_error(error, errorCap, L"out of memory building CDP command"); return FALSE; }
    command[at++] = '{'; command[at++] = '"'; command[at++] = 'i'; command[at++] = 'd'; command[at++] = '"'; command[at++] = ':';
    do { idText[n++] = (char)('0' + v % 10U); v /= 10U; } while (v); while (n) command[at++] = idText[--n];
    { const char prefix[] = ",\"method\":\"Runtime.evaluate\",\"params\":{\"expression\":"; if (!h_append_bytes(command, commandCap, &at, prefix, sizeof(prefix) - 1)) goto command_error; }
    if (!h_json_quote(command, commandCap, &at, expression, expressionLength)) goto command_error;
    { const char suffix[] = ",\"returnByValue\":true"; if (!h_append_bytes(command, commandCap, &at, suffix, sizeof(suffix) - 1)) goto command_error; }
    if (h_current_page && h_current_page->ws == ws && h_current_context > 0) {
        n = h_decimal(idText, (DWORD)h_current_context);
        if (!h_append_bytes(command, commandCap, &at, ",\"contextId\":", 13) || !h_append_bytes(command, commandCap, &at, idText, n)) goto command_error;
    }
    if (!h_append_bytes(command, commandCap, &at, "}}", 2)) goto command_error;
    if (!net_ws_send_text(ws, command, at, error, errorCap)) { HeapFree(GetProcessHeap(), 0, command); return FALSE; }
    HeapFree(GetProcessHeap(), 0, command);
    return h_wait_reply(ws, id, requireTrue, replyOut, replyLengthOut, error, errorCap);
command_error:
    HeapFree(GetProcessHeap(), 0, command); h_error(error, errorCap, L"CDP command exceeds native limit"); return FALSE;
}
static BOOL h_send_eval_checked(NET_WS *ws, DWORD id, const char *expression, DWORD expressionLength, BOOL requireTrue, WCHAR *error, DWORD errorCap) {
    return h_send_eval_result(ws, id, expression, expressionLength, requireTrue, NULL, NULL, error, errorCap);
}
static BOOL h_send_eval(NET_WS *ws, DWORD id, const char *expression, DWORD expressionLength, WCHAR *error, DWORD errorCap) {
    return h_send_eval_checked(ws, id, expression, expressionLength, FALSE, error, errorCap);
}
static BOOL h_inject_source(NET_WS *ws, DWORD id, const char *source, DWORD length, WCHAR *error, DWORD errorCap) {
    static const char pre[] = "(function(){var marker='__CX_WIN_NATIVE_SCRIPT_'+Date.now()+'_'+Math.random().toString(36).slice(2);var source=";
    /* Appending an inline script can succeed even when CSP or a JS error stops it. */
    static const char post[] = ";var s=document.createElement('script');var p=document.head||document.documentElement||document.body;if(!p){return false;}s.textContent=source+'\\n;window['+JSON.stringify(marker)+']=true;\\n';try{p.appendChild(s);return window[marker]===true;}finally{if(s.parentNode){s.parentNode.removeChild(s);}try{delete window[marker];}catch(e){window[marker]=undefined;}}})()";
    DWORD preLength = sizeof(pre) - 1, postLength = sizeof(post) - 1, total; char *expr; DWORD at = 0; BOOL ok;
    if (length > (HOST_COMMAND_CAP - preLength - postLength - 2) / 6UL) { h_error(error, errorCap, L"injection source is too large"); return FALSE; }
    total = preLength + postLength + length * 6UL + 2;
    expr = (char *)HeapAlloc(GetProcessHeap(), 0, total); if (!expr) { h_error(error, errorCap, L"out of memory building injection"); return FALSE; }
    while (at < preLength) { expr[at] = pre[at]; ++at; }
    if (!h_json_quote(expr, total, &at, source, length)) { HeapFree(GetProcessHeap(), 0, expr); h_error(error, errorCap, L"injection source is too large"); return FALSE; }
    { DWORD i = 0; while (i < postLength) expr[at++] = post[i++]; }
    expr[at] = 0; ok = h_send_eval_checked(ws, id, expr, at, TRUE, error, errorCap); HeapFree(GetProcessHeap(), 0, expr); return ok;
}
static BOOL h_inject_runtime(NET_WS *ws, DWORD id, const char *source, DWORD length, WCHAR *error, DWORD errorCap) {
    return h_send_eval(ws, id, source, length, error, errorCap);
}
static BOOL h_inject_asset(NET_WS *ws, DWORD *nextId, const WCHAR *strategy, DWORD retries,
                           const char *source, DWORD length, WCHAR *error, DWORD errorCap) {
    WCHAR lastError[HOST_ERROR_CAP];
    BOOL scriptFirst = h_equal(strategy ? strategy : L"hybrid", L"script");
    BOOL runtimeOnly = h_equal(strategy ? strategy : L"hybrid", L"runtime");
    DWORD attempt;
    h_error(lastError, HOST_ERROR_CAP, L"injection failed");
    for (attempt = 0; attempt <= retries; ++attempt) {
        if (!h_operation_active()) { h_error(error, errorCap, L"injection task cancelled"); return FALSE; }
        if (runtimeOnly) {
            if (h_inject_runtime(ws, (*nextId)++, source, length, error, errorCap)) return TRUE;
            h_copy(lastError, HOST_ERROR_CAP, error);
        } else if (scriptFirst) {
            if (h_inject_source(ws, (*nextId)++, source, length, error, errorCap)) return TRUE;
            h_copy(lastError, HOST_ERROR_CAP, error);
            if (h_inject_runtime(ws, (*nextId)++, source, length, error, errorCap)) return TRUE;
            h_copy(lastError, HOST_ERROR_CAP, error);
        } else {
            if (h_inject_runtime(ws, (*nextId)++, source, length, error, errorCap)) return TRUE;
            h_copy(lastError, HOST_ERROR_CAP, error);
            if (h_inject_source(ws, (*nextId)++, source, length, error, errorCap)) return TRUE;
            h_copy(lastError, HOST_ERROR_CAP, error);
        }
        if (attempt < retries) Sleep(100 * (attempt + 1));
    }
    h_copy(error, errorCap, lastError);
    return FALSE;
}
/* 构建页面配置表达式（配置 JSON + instance + 样式 + 可选标记），供 WebSocket 与管道通道共用。 */
static BOOL h_build_page_config(const CX_OPTIONS *options, const char *style, DWORD styleLength,
                                char **outExpression, DWORD *outLength, WCHAR *error, DWORD errorCap) {
    const char prefix[] = "window.__CX_WIN_CONFIG_JSON__=";
    const char middle[] = ";window.__CX_WIN_INSTANCE__=";
    const char stylePrefix[] = ";window.__CX_WIN_STYLE_TEXT__=";
    char *config = NULL, *expression = NULL;
    DWORD configLength = 0, capacity, at = 0;
    BOOL ok = FALSE;
    if (outExpression) *outExpression = NULL;
    if (outLength) *outLength = 0;
    config = (char *)HeapAlloc(GetProcessHeap(), 0, CX_OPTIONS_JSON_CAP);
    if (!config || !cx_options_effective_settings_json_utf8(options, config, CX_OPTIONS_JSON_CAP, &configLength)) {
        h_error(error, errorCap, L"cannot serialize native settings"); goto done;
    }
    if (h_config_json(&configLength)) CopyMemory(config, h_config_json(&configLength), configLength + 1);
    if (!style || styleLength > (HOST_SOURCE_CAP - configLength - 256) / 6) {
        h_error(error, errorCap, L"native style exceeds its size limit"); goto done;
    }
    capacity = configLength + styleLength * 6 + 640;
    expression = (char *)HeapAlloc(GetProcessHeap(), 0, capacity);
    if (!expression) { h_error(error, errorCap, L"out of memory setting native config"); goto done; }
    if (!h_append_bytes(expression, capacity, &at, prefix, sizeof(prefix) - 1)
        || !h_append_bytes(expression, capacity, &at, config, configLength)
        || !h_append_bytes(expression, capacity, &at, middle, sizeof(middle) - 1)
        || !h_json_quote(expression, capacity, &at, h_instance, (DWORD)h_len(h_instance))
        || !h_append_bytes(expression, capacity, &at, stylePrefix, sizeof(stylePrefix) - 1)
        || !h_json_quote(expression, capacity, &at, style, styleLength)
        || !h_append_bytes(expression, capacity, &at, ";true;", 6)) {
        h_error(error, errorCap, L"native page config exceeds its size limit"); goto done;
    }
    if (h_silent_active) {
        const char silentPrefix[] = ";window.__CX_WIN_SILENT__={\"clientPid\":";
        const char silentKeys[] = ",\"selfDestructKeys\":[\"Ctrl+Alt+Shift+E\",\"F8\"]};";
        if (!h_append_bytes(expression, capacity, &at, silentPrefix, sizeof(silentPrefix) - 1)
            || !h_append_uint(expression, capacity, &at, h_client_pid)
            || !h_append_bytes(expression, capacity, &at, silentKeys, sizeof(silentKeys) - 1)) {
            h_error(error, errorCap, L"native page config exceeds its size limit"); goto done;
        }
    }
    if (options->panelAllPages) {
        static const char panelAll[] = ";window.__CX_WIN_PANEL_ALL_PAGES__=true";
        DWORD panelAt = 0;
        while (panelAll[panelAt]) {
            if (at + 1 >= capacity) { h_error(error, errorCap, L"panel flag exceeds size limit"); goto done; }
            expression[at++] = panelAll[panelAt++];
        }
    }
    if (at > HOST_EVAL_SOURCE_CAP) { h_error(error, errorCap, L"native page config exceeds CDP expression limit"); goto done; }
    if (outExpression) { *outExpression = expression; expression = NULL; }
    if (outLength) *outLength = at;
    ok = TRUE;
done:
    if (config) HeapFree(GetProcessHeap(), 0, config);
    if (expression) HeapFree(GetProcessHeap(), 0, expression);
    return ok;
}

static BOOL h_set_page_config(NET_WS *ws, DWORD *nextId, const CX_OPTIONS *options,
                              const char *style, DWORD styleLength, BOOL preflight, WCHAR *error, DWORD errorCap) {
    char *expression = NULL;
    DWORD length = 0;
    BOOL ok;
    if (!h_build_page_config(options, style, styleLength, &expression, &length, error, errorCap)) return FALSE;
    ok = preflight || h_send_eval(ws, (*nextId)++, expression, length, error, errorCap);
    HeapFree(GetProcessHeap(), 0, expression);
    return ok;
}

static BOOL h_preflight_assets(const CX_OPTIONS *options, DWORD bootstrapLength, DWORD bundleLength,
                               const char *style, DWORD styleLength, WCHAR *error, DWORD errorCap) {
    if (bootstrapLength > HOST_EVAL_SOURCE_CAP || bundleLength > HOST_EVAL_SOURCE_CAP) {
        h_error(error, errorCap, L"native JavaScript asset exceeds CDP expression limit"); return FALSE;
    }
    return h_set_page_config(NULL, NULL, options, style, styleLength, TRUE, error, errorCap);
}
/* Returns the raw base64 payload of the first "data":"..." JSON string in a
   bounded CDP reply. Base64 never needs JSON unescaping; reject escapes and
   line breaks rather than guessing. */
static BOOL h_reply_base64(const char *json, DWORD length, const char **out, DWORD *outLength) {
    static const char marker[] = "\"data\":\"";
    const DWORD markerLength = sizeof(marker) - 1;
    DWORD i = 0;
    if (out) *out = NULL;
    if (outLength) *outLength = 0;
    if (!json || !out || !outLength || length <= markerLength) return FALSE;
    while (i + markerLength < length) {
        DWORD j = 0;
        while (j < markerLength && json[i + j] == marker[j]) ++j;
        if (j == markerLength) break;
        ++i;
    }
    if (i + markerLength >= length) return FALSE;
    i += markerLength;
    {
        DWORD start = i;
        for (; i < length; ++i) {
            char c = json[i];
            if (c == '"') break;
            if (c == '\\' || c == '\r' || c == '\n') return FALSE;
        }
        if (i >= length || i == start) return FALSE;
        *out = json + start;
        *outLength = i - start;
        return TRUE;
    }
}

static void h_capture_page_screenshot(H_NATIVE_PAGE *page, WCHAR *error, DWORD errorCap) {
    char *reply = NULL;
    DWORD replyLength = 0;
    const char *base64 = NULL;
    DWORD base64Length = 0;
    if (!h_diagnostics || !cx_diagnostics_enabled(h_diagnostics)) return;
    if (!h_send_command(page, "Page.captureScreenshot", "{\"format\":\"png\"}",
                        &reply, &replyLength, error, errorCap)
        || !h_reply_base64(reply, replyLength, &base64, &base64Length)
        || !cx_diagnostics_write_page_png(h_diagnostics, base64, base64Length, error, errorCap)) {
        h_audit_event("warn", "diagnostics", "Page screenshot failed; continuing without it");
        if (reply) net_free(reply);
        return;
    }
    h_audit_event("info", "diagnostics", "Captured page screenshot diagnostics");
    net_free(reply);
}

static void h_collect_page_diagnostics(H_NATIVE_PAGE *page) {
    static const char expression[] =
        "(function(){var v=window.visualViewport,d=window.devicePixelRatio;"
        "var p=document.querySelectorAll('#panel-common-work-results,[data-cx-win-panel-shell=\"1\"]');"
        "var e=p.length?p[0]:null,r=e?e.getBoundingClientRect():null,s=e?getComputedStyle(e):null;"
        "function n(x){return typeof x==='number'&&isFinite(x)?Math.round(x*1000)/1000:0;}"
        "function c(x){return typeof x==='string'&&x.length<=256&&!/[^A-Za-z0-9 .,()%#+-]|url\\s*\\(/i.test(x)?x:'';}"
        "var o={version:'6.2.0',host:'native',source:'native-page',collectedAt:new Date().toISOString(),"
        "bundleLoaded:window.__CX_WIN_BUNDLE_LOADED__===true,devicePixelRatio:n(d),"
        "innerWidth:n(window.innerWidth),innerHeight:n(window.innerHeight),"
        "visualViewport:{width:v?n(v.width):0,height:v?n(v.height):0,scale:v?n(v.scale):1},"
        "panelCount:Math.min(p.length,64),topPanel:r?{visible:!!(r.width&&r.height),"
        "rect:{x:n(r.x),y:n(r.y),width:n(r.width),height:n(r.height)},"
        "fractionalDevicePixel:{x:n(r.x*d),y:n(r.y*d),width:n(r.width*d),height:n(r.height*d)},"
        "style:{backdropFilter:c(s.backdropFilter||s.webkitBackdropFilter),boxShadow:c(s.boxShadow),"
        "transform:c(s.transform),backgroundColor:c(s.backgroundColor)}}:null,"
        "scope:{pageOnly:true,windowDpi:false,screenshots:false}};return JSON.stringify(o);})()";
    H_NATIVE_PAGE *savedPage;
    BOOL savedPending, success = FALSE;
    int savedContext, result, remote, type, value;
    char *reply = NULL;
    DWORD replyLength = 0;
    WCHAR diagnosticError[HOST_ERROR_CAP];
    if (!page || !h_diagnostics || !cx_diagnostics_enabled(h_diagnostics) || h_diagnostics_sampled) return;
    h_diagnostics_sampled = TRUE;
    savedPage = h_current_page; savedContext = h_current_context; savedPending = h_task_pending;
    h_current_page = page; h_current_context = 0; h_task_pending = FALSE;
    h_zero(diagnosticError, sizeof(diagnosticError)); h_zero(h_diagnostic_json, sizeof(h_diagnostic_json));
    if (!h_send_eval_result(page->ws, page->nextId++, expression, sizeof(expression) - 1, FALSE,
                            &reply, &replyLength, diagnosticError, HOST_ERROR_CAP)) goto done;
    result = jparse(reply, (int)replyLength, h_diagnostic_tokens, HOST_REPLY_TOKENS);
    remote = result > 0 ? jkey(reply, h_diagnostic_tokens, 0, "result") : -1;
    remote = remote >= 0 ? jkey(reply, h_diagnostic_tokens, remote, "result") : -1;
    type = remote >= 0 ? jkey(reply, h_diagnostic_tokens, remote, "type") : -1;
    value = remote >= 0 ? jkey(reply, h_diagnostic_tokens, remote, "value") : -1;
    if (!jeq(reply, h_diagnostic_tokens, type, "string")
        || !jstr(reply, h_diagnostic_tokens, value, h_diagnostic_json, sizeof(h_diagnostic_json))) goto done;
    success = cx_diagnostics_write_page_json(h_diagnostics, h_diagnostic_json,
        (DWORD)h_len(h_diagnostic_json), diagnosticError, HOST_ERROR_CAP);
    if (success) h_capture_page_screenshot(page, diagnosticError, HOST_ERROR_CAP);
done:
    if (!success) h_audit_event("warn", "diagnostics", "Page diagnostics sample failed; continuing without page diagnostics");
    if (reply) net_free(reply);
    h_current_page = savedPage; h_current_context = savedContext; h_task_pending = savedPending;
}
static BOOL h_choose_port(const CX_OPTIONS *options, USHORT *port) {
    USHORT p; WCHAR error[64];
    if (options && options->portSet && options->port != 0) {
        if (options->port < 1024 || options->port > 65534) return FALSE;
        p = (USHORT)options->port;
        if (proc_port_bindable(p, error, 64)) { *port = p; return TRUE; }
        return FALSE;
    }
    /* 多实例并发时固定从 38100 开始会撞车：用进程相关的随机起点分散端口。 */
    {
        DWORD seed = GetTickCount() * 1103515245u + GetCurrentProcessId() * 12345u;
        int i;
        USHORT start = (USHORT)(30000 + (seed % 28000));
        for (i = 0; i < 400; ++i) {
            int candidate = (int)start + i * 37;
            if (candidate > 65500) candidate = 30000 + (candidate - 65500);
            p = (USHORT)candidate;
            if (proc_port_bindable(p, error, 64)) { *port = p; return TRUE; }
        }
    }
    return FALSE;
}
#include "host-config.inc"
#include "host-session.inc"
#include "host-self-check.inc"

static void h_print_candidates(const CX_DISCOVERY_RESULT *result) {
    DWORD i;
    h_print(L"Index\tArchitecture\tVersion\tPath\r\n");
    for (i = 0; i < result->count; ++i) {
        const CX_CLIENT_CANDIDATE *candidate = result->items + i;
        char number[16];
        h_decimal(number, i + 1); h_print_utf8(number); h_print(L"\t");
        h_print(candidate->machine == CX_DISCOVERY_MACHINE_X86 ? L"x86\t" : L"x64\t");
        h_print(candidate->version[0] ? candidate->version : L"unknown"); h_print(L"\t");
        h_print(candidate->path);
        if (i == result->recommendedIndex) h_print(L" [recommended]");
        h_print(L"\r\n");
    }
}
static BOOL h_selection_space(WCHAR value) {
    return value == L' ' || value == L'\t' || value == L'\r' || value == L'\n';
}
static BOOL h_pick_client(const CX_OPTIONS *options, const CX_DISCOVERY_RESULT *result, WCHAR *error, DWORD errorCap) {
    DWORD index = result->recommendedIndex, mode = 0;
    BOOL console = GetConsoleMode(GetStdHandle(STD_INPUT_HANDLE), &mode);
    BOOL gui = (h_default_gui && !options->elevatedClientSet)
        || (!options->clientPathSet && !options->clientIndexSet && (options->selectClient || h_equal(options->ui, L"gui")
            || (h_equal(options->ui, L"auto") && !options->quiet && !options->clientFirst && !console)));
    if (gui) {
        SYSTEM_INFO info;
        CX_SELECTION_STATUS status;
        CX_DISCOVERY_RESULT fullResult;
        const CX_DISCOVERY_RESULT *shown = result;
        const WCHAR *notice = NULL;
        GetNativeSystemInfo(&info);
        cx_discovery_init(&fullResult);
        for (;;) {
            status = cx_select_client(shown, info.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_INTEL, notice,
                options->explainInject,
                h_selected_path, HOST_PATH_CAP, error, errorCap);
            if (status != CX_SELECTION_SCAN_ALL) break;
            {
                CX_DISCOVERY_OPTIONS scan;
                CX_SCAN_PROGRESS *progress = NULL;
                WCHAR progressError[256];
                BOOL cancelledByUser = FALSE;
                ZeroMemory(&scan, sizeof(scan));
                scan.mode = CX_DISCOVERY_SCAN_ALL; scan.enumerateAll = TRUE;
                scan.hostIs32Bit = info.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_INTEL;
                scan.rescan = TRUE; scan.noScanCache = TRUE; scan.noDiskWrite = options->noDiskWrite;
                cx_discovery_free(&fullResult);
                h_audit_event("info", "scan", "Full disk scan requested from client selection");
                progressError[0] = 0;
                if (cx_scan_progress_begin(&progress, progressError, 256)) {
                    h_audit_event("info", "scan", "Full disk scan progress window shown; the scan is cancellable");
                } else {
                    progress = NULL;
                    h_audit_event("warn", "scan", "Scan progress window unavailable; scanning without it");
                }
                cx_scan_progress_bind(&scan, progress);
                if (!cx_discovery_scan(&scan, &fullResult, error, errorCap)) {
                    if (progress) cx_scan_progress_end(progress, progressError, 256);
                    cx_discovery_free(&fullResult); return FALSE;
                }
                if (progress) cancelledByUser = cx_scan_progress_end(progress, progressError, 256);
                if (cancelledByUser || fullResult.cancelled) {
                    h_audit_event("info", "scan", "Full disk scan cancelled from the progress window");
                    cx_discovery_free(&fullResult);
                    notice = L"已取消全盘扫描，保留原候选；可重试或手动浏览。";
                    if (error && errorCap) error[0] = 0;
                    continue;
                }
                shown = &fullResult;
                notice = NULL;
            }
        }
        cx_discovery_free(&fullResult);
        if (status == CX_SELECTION_CANCELLED) { h_exit_code = 3; return FALSE; }
        return status == CX_SELECTION_SELECTED;
    }
    if (options->clientIndexSet) {
        if (options->clientIndex < 1 || (DWORD)options->clientIndex > result->count) { h_error(error, errorCap, L"client-index is outside the discovered candidate list"); return FALSE; }
        index = (DWORD)options->clientIndex - 1;
    } else if (!options->clientPathSet && !options->clientFirst && !options->quiet && console) {
        WCHAR input[512], *selection; DWORD i, length, read = 0, value = 0;
        h_print_candidates(result);
        h_print(L"Select a number or CXExam.exe path (Enter: recommended; q: cancel): ");
        if (!ReadConsoleW(GetStdHandle(STD_INPUT_HANDLE), input, 511, &read, NULL) || !read) { h_error(error, errorCap, L"cannot read client selection"); return FALSE; }
        if (read >= 511) { h_error(error, errorCap, L"client selection is too long; use --client for longer paths"); return FALSE; }
        input[read] = 0;
        selection = input;
        while (h_selection_space(*selection)) ++selection;
        length = (DWORD)h_wlen(selection);
        while (length && h_selection_space(selection[length - 1])) selection[--length] = 0;
        if (length == 1 && (selection[0] == L'q' || selection[0] == L'Q')) { h_exit_code = 3; return FALSE; }
        for (i = 0; i < length && selection[i] >= L'0' && selection[i] <= L'9'; ++i) { }
        if (length && i == length) {
            for (i = 0; i < length; ++i) {
                DWORD digit = (DWORD)(selection[i] - L'0');
                if (value > (0xffffffffUL - digit) / 10) { h_error(error, errorCap, L"invalid client selection"); return FALSE; }
                value = value * 10 + digit;
            }
            if (value < 1 || value > result->count) { h_error(error, errorCap, L"invalid client selection"); return FALSE; }
            index = value - 1;
        } else if (length) {
            SYSTEM_INFO info; CX_DISCOVERY_RESULT manual; BOOL valid;
            if (length > 1 && selection[0] == L'"' && selection[length - 1] == L'"') { selection[length - 1] = 0; ++selection; }
            GetNativeSystemInfo(&info); cx_discovery_init(&manual);
            valid = cx_discovery_resolve_client(selection, info.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_INTEL, &manual, error, errorCap);
            if (valid) valid = manual.count && h_copy(h_selected_path, HOST_PATH_CAP, manual.items[manual.recommendedIndex].path);
            cx_discovery_free(&manual);
            return valid;
        }
    }
    if (!result->count) { h_error(error, errorCap, L"no valid CXExam.exe was found"); return FALSE; }
    return h_copy(h_selected_path, HOST_PATH_CAP, result->items[index].path);
}

/* Window diagnostics are captured once for this host's own client launch.
   Wait briefly for the CXExam main window, then record DPI/rect and a
   best-effort BMP snapshot next to the page diagnostics JSON. */
static void h_capture_window_diagnostics(void) {
    WCHAR captureError[HOST_ERROR_CAP];
    int attempt;
    if (!h_diagnostics || !cx_diagnostics_enabled(h_diagnostics) || !h_client_pid) return;
    for (attempt = 0; attempt < 25; ++attempt) {
        if (cx_diagnostics_client_window_ready(h_client_pid)) break;
        Sleep(200);
    }
    if (!cx_diagnostics_client_window_ready(h_client_pid)) {
        h_audit_event("warn", "diagnostics", "Client window not ready; window diagnostics omitted");
        return;
    }
    captureError[0] = 0;
    if (!cx_diagnostics_capture_window(h_diagnostics, h_client_pid, captureError, HOST_ERROR_CAP)) {
        h_audit_event("warn", "diagnostics", "Window diagnostics capture failed; continuing");
    } else {
        h_audit_event("info", "diagnostics", "Captured bounded client window diagnostics");
    }
}

static BOOL h_run(CX_OPTIONS *options, WCHAR *error, DWORD errorCap) {
    CX_DISCOVERY_OPTIONS discover; CX_DISCOVERY_RESULT result; HANDLE client = NULL; USHORT port = 0;
    char *bootstrap = NULL, *bundle = NULL, *style = NULL, *trampoline = NULL;
    DWORD bootstrapLength, bundleLength, styleLength, trampolineLength;
    BOOL ok = FALSE;
    int attempt = 0;
    DWORD runStarted = GetTickCount();
    WCHAR auditError[256];
    h_zero(&discover, sizeof(discover)); cx_discovery_init(&result);
    h_ui_active = TRUE; h_ui_sending = FALSE; h_ui_started = runStarted;
    h_ui_count = h_ui_head = h_ui_sequence = 0;
    h_zero(&h_report, sizeof(h_report)); h_exit_code = 0;
    h_needs_elevation = FALSE;
    h_diagnostics = NULL; h_diagnostics_sampled = FALSE;
    h_zero(h_diagnostic_json, sizeof(h_diagnostic_json));
    h_created_log_path[0] = 0;
    h_created_report_path[0] = 0;
    h_created_diagnostics_path[0] = 0;
    h_capture_console = options->captureConsole; h_quiet = options->quiet;
    h_report.attached = options->attachPortSet;
    h_report.executionMode = options->executionModeMemory ? "memory" : "normal";
    h_report.injectStrategy = h_equal(options->injectStrategy, L"runtime") ? "runtime" : (h_equal(options->injectStrategy, L"script") ? "script" : "hybrid");
    h_report.stopReason = "discovery-failed";
    if (!options->listClients || options->reportPath[0]) {
        const CX_OPTIONS *auditOptions = options;
        if (options->listClients) {
            h_audit_options = *options;
            h_audit_options.logFileEnabled = FALSE;
            h_audit_options.quiet = TRUE;
            auditOptions = &h_audit_options;
        }
        h_audit = cx_audit_create(auditOptions, auditError, 256);
        if (!h_audit) { h_error(error, errorCap, L"cannot allocate native audit state"); goto done; }
        h_copy(h_created_log_path, HOST_PATH_CAP, cx_audit_log_path(h_audit));
        if (auditError[0]) h_audit_event("warn", "audit", "Some file output is unavailable; continuing");
        h_audit_event("info", "start", "Native host started");
    }
    h_client_pid = 0; h_duration = 0; h_bundles_completed = 0;
    if (!options->attachPortSet) {
        discover.mode = h_default_gui && !options->elevatedClientSet ? CX_DISCOVERY_SCAN_COMMON
            : (h_equal(options->scanMode, L"common") ? CX_DISCOVERY_SCAN_COMMON : (h_equal(options->scanMode, L"all") ? CX_DISCOVERY_SCAN_ALL : CX_DISCOVERY_SCAN_FALLBACK_ALL));
        discover.clientPath = options->elevatedClientSet ? options->elevatedClientPath
            : (!h_default_gui && options->clientPathSet ? options->clientPath : NULL);
        if (options->elevatedClientSet) {
            const WCHAR *path = options->elevatedClientPath;
            DWORD attributes = GetFileAttributesW(path);
            BOOL absolute = (path[0] && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/'))
                || (path[0] == L'\\' && path[1] == L'\\');
            if (!absolute || attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY)) {
                h_error(error, errorCap, L"Internal elevated client must be an accessible absolute executable path"); goto done;
            }
        }
        discover.enumerateAll = h_default_gui || options->listClients || options->selectClient || options->clientIndexSet || h_equal(options->ui, L"gui") || (!options->clientFirst && !options->quiet);
        h_copy(h_scan_cache_path, sizeof(h_scan_cache_path) / sizeof(WCHAR), options->dataDir);
        {
            DWORD length = (DWORD)h_wlen(h_scan_cache_path);
            if (length && h_scan_cache_path[length - 1] != L'\\' && h_scan_cache_path[length - 1] != L'/') h_scan_cache_path[length++] = L'\\';
            h_copy(h_scan_cache_path + length, sizeof(h_scan_cache_path) / sizeof(WCHAR) - length, CX_HOST_DATA_SUBDIR L"\\native-scan-cache-v1.bin");
        }
        discover.cachePath = h_scan_cache_path;
        discover.rescan = options->rescan;
        discover.noScanCache = options->noScanCache || options->listClients;
        discover.noDiskWrite = options->noDiskWrite;
        if (!cx_discovery_scan(&discover, &result, error, errorCap)) goto done;
        if (result.cacheHit) h_audit_event("info", "scan-cache", "Validated positive native scan cache hit");
        if (options->listClients) {
            h_print_candidates(&result);
            h_report.stopReason = "list-clients"; ok = TRUE; goto done;
        }
        if (!result.count && !h_default_gui && options->quiet && options->clientFirst) { h_report.stopReason = "no-client"; ok = TRUE; goto done; }
        h_report.stopReason = "selection-failed";
        if (options->elevatedClientSet) {
            if (result.count != 1 || !h_copy(h_selected_path, HOST_PATH_CAP, result.items[0].path)) {
                h_error(error, errorCap, L"Cannot resolve the selected elevated client"); goto done;
            }
        } else if (!h_pick_client(options, &result, error, errorCap)) { if (h_exit_code == 3) { h_report.stopReason = "cancelled"; ok = TRUE; } goto done; }
    }
    h_report.stopReason = "assets-failed";
    if (!h_config_begin(options, error, errorCap)) goto done;
    if (!cx_asset_load(L"windows-bootstrap.js", options->assetsDirSet ? options->assetsDir : NULL, &bootstrap, &bootstrapLength, error, errorCap)
        || !cx_asset_load(L"chaoxing-plus.windows.js", options->assetsDirSet ? options->assetsDir : NULL, &bundle, &bundleLength, error, errorCap)
        || !cx_asset_load(L"sweetalert2.min.css", options->assetsDirSet ? options->assetsDir : NULL, &style, &styleLength, error, errorCap)
        || !cx_asset_load(L"trampoline.js", options->assetsDirSet ? options->assetsDir : NULL, &trampoline, &trampolineLength, error, errorCap)) goto done;
    if (!h_preflight_assets(options, bootstrapLength, bundleLength, style, styleLength, error, errorCap)) goto done;
    if (options->injectModeSet && h_same(options->injectMode, L"cdp-pipe")) {
        h_report.injectMode = "cdp-pipe";
        if (!h_pipe_bootstrap(options, bootstrap, bootstrapLength, bundle, bundleLength, style, styleLength, error, errorCap)) {
            h_report.stopReason = "pipe-launch-failed";
            goto done;
        }
        h_report.stopReason = "pipe-bootstrap-complete";
        h_report.injectMode = "cdp-pipe";
        ok = TRUE;
        goto done;
    }
    if (trampolineLength > HOST_EVAL_SOURCE_CAP / 6 || bootstrapLength + 128 > HOST_EVAL_SOURCE_CAP || bundleLength + 128 > HOST_EVAL_SOURCE_CAP) { h_error(error, errorCap, L"native resource wrapper exceeds CDP capacity"); goto done; }
    if (options->silentScenario) {
        cx_silent_init(&h_silent, TRUE);
        h_silent_active = TRUE;
        h_silent_simulate = options->silentDeleteSimulate;
    /* 暂存启动：副本接管后，本进程清空原目录并退出。 */
    if (options->stageRequest && !options->stagedBoot && h_silent_stage()) {
        h_silent_cleanup_pass();
        if (h_silent_parked[0]) { cx_cleanup_release_self(h_silent_parked); h_silent_parked[0] = 0; }
        h_silent_done = TRUE;
        h_report.stopReason = "staged-handoff";
        return TRUE;
    }
        h_silent_cleanup_pass();
        h_silent_next_tick = GetTickCount();
        h_audit_event("info", "silent", "Silent scenario active: no panel/log/console, program cleanup enabled");
    }
    /* 注入方式分派：auto / cdp-port / dll-proxy 已接入主流程；
   cdp-pipe 与 input 尚未接线，必须显式失败，不能静默退回端口模式。 */
    h_report.injectMode = "auto";
    if (options->injectModeSet) h_report.injectMode = h_inject_mode_name(options->injectMode);
    /* 显式 --inject-mode auto：若客户端目录存在我们安装的代理，则改走代理通道。
       不传 --inject-mode 时保持 cdp-port，避免改变默认行为（elevation 夹具在不传该参数的情况下运行）。 */
    if (options->injectModeSet && h_same(options->injectMode, L"auto") && !options->attachPortSet) {
        static WCHAR autoDir[CX_CLEANUP_PATH_CAP], autoDll[CX_CLEANUP_PATH_CAP], autoMarker[CX_CLEANUP_PATH_CAP];
        BOOL autoOk = h_parent_dir(h_selected_path, autoDir, CX_CLEANUP_PATH_CAP) &&
                      h_copy(autoDll, CX_CLEANUP_PATH_CAP, autoDir) &&
                      h_cat(autoDll, CX_CLEANUP_PATH_CAP, h_proxy_dll_suffix()) &&
                      GetFileAttributesW(autoDll) != INVALID_FILE_ATTRIBUTES &&
                      h_copy(autoMarker, CX_CLEANUP_PATH_CAP, autoDir) &&
                      h_cat(autoMarker, CX_CLEANUP_PATH_CAP, L"\\cxhook-proxy.marker") &&
                      GetFileAttributesW(autoMarker) != INVALID_FILE_ATTRIBUTES;
        if (autoOk) {
            h_dll_proxy_mode = TRUE;
            h_report.commandLineInjected = TRUE;
            if (!options->quiet) { h_print(L"auto selected dll-proxy: proxy installed at "); h_print(autoDll); h_print(L"\n"); }
        }
    }    if (options->injectModeSet && h_same(options->injectMode, L"input")) {
        if (!options->quiet) {
            h_print(L"input 模式未实现：请改用 cdp-port（4.1.4 客户端）或 dll-proxy（加壳客户端，如 4.3.0.4）\n");
        }
        h_report.stopReason = "inject-input-unavailable";
        h_exit_code = 4;
        goto done;
    }

    if (options->injectModeSet && h_same(options->injectMode, L"dll-proxy")) {
        WCHAR proxyDir[CX_CLEANUP_PATH_CAP], proxyDll[CX_CLEANUP_PATH_CAP];
        BOOL dirOk = options->injectProxyDirSet
            ? h_copy(proxyDir, CX_CLEANUP_PATH_CAP, options->injectProxyDir)
            : h_parent_dir(h_selected_path, proxyDir, CX_CLEANUP_PATH_CAP);
        BOOL present = dirOk && h_copy(proxyDll, CX_CLEANUP_PATH_CAP, proxyDir) &&
                       h_cat(proxyDll, CX_CLEANUP_PATH_CAP, h_proxy_dll_suffix()) &&
                       GetFileAttributesW(proxyDll) != INVALID_FILE_ATTRIBUTES;
        if (!present) {
            /* 自动安装：本次运行临时装入，结束后（含失败路径）自动还原。 */
            if (h_install_proxy(options)) {
                h_proxy_auto_installed = TRUE;
                present = TRUE;
                if (!options->quiet) h_print(L"dll-proxy: 本次运行临时安装代理，结束后自动还原\n");
            }
        }
        if (!present) {
            if (!options->quiet) {
                h_print(L"dll-proxy requires the proxy DLL at ");
                if (dirOk) { h_print(proxyDir); h_print(L"\\winmm.dll"); }
                h_print(L"; copy the winmm proxy there (administrator may be required)");
            }
            h_report.stopReason = "inject-proxy-missing";
            h_exit_code = 4;
            goto done;
        }
        h_dll_proxy_mode = TRUE;
        h_report.commandLineInjected = TRUE;
        if (!options->quiet) {
            h_print(L"dll-proxy: proxy found at ");
            h_print(proxyDll);
            h_print(L"; launching without --remote-debugging-port and letting the proxy append it\n");
        }
    } else if (options->injectModeSet &&
               !h_same(options->injectMode, L"auto") && !h_same(options->injectMode, L"cdp-port")) {
        if (!options->quiet) {
            h_print(L"inject mode is not implemented in this build: ");
            h_print(options->injectMode);
            h_print(L" (available: auto, cdp-port, dll-proxy)");
        }
        h_report.stopReason = "inject-mode-unavailable";
        h_exit_code = 4;
        goto done;
    }
    /* 加壳客户端忽略命令行开关：auto 模式下自动切到 dll-proxy（需代理已安装）。 */
    /* dll-proxy 模式下若客户端目录没有代理，自动安装并在本次运行结束（含错误路径）时还原。 */
    if (h_dll_proxy_mode) {
        WCHAR proxyPath[CX_CLEANUP_PATH_CAP];
        BOOL present = FALSE;
        if (h_copy(proxyPath, CX_CLEANUP_PATH_CAP, h_selected_path)) {
            WCHAR dirOnly[CX_CLEANUP_PATH_CAP];
            DWORD cut = 0, k;
            for (k = 0; proxyPath[k]; ++k) if (proxyPath[k] == L'\\') cut = k;
            for (k = 0; k < cut && k + 1 < CX_CLEANUP_PATH_CAP; ++k) dirOnly[k] = proxyPath[k];
            dirOnly[k] = 0;
            if (h_cat(dirOnly, CX_CLEANUP_PATH_CAP, h_proxy_dll_suffix()) && GetFileAttributesW(dirOnly) != INVALID_FILE_ATTRIBUTES) present = TRUE;
        }
        if (!present && h_install_proxy(options)) {
            h_proxy_auto_installed = TRUE;
            if (!options->quiet) h_print(L"dll-proxy: 本次运行临时安装代理，结束后自动还原\n");
        }
    }
    /* GUI 里显式选择的注入方式优先于自动判定。 */
    if (h_gui_mode_chosen && !options->injectModeSet) {
        if (h_same(h_gui_inject_mode, L"dll-proxy")) {
            h_dll_proxy_mode = TRUE;
            h_report.injectMode = "dll-proxy";
            if (!options->quiet) h_print(L"GUI: 注入方式=dll-proxy\n");
        } else if (h_same(h_gui_inject_mode, L"cdp-port")) {
            h_report.injectMode = "cdp-port";
            if (!options->quiet) h_print(L"GUI: 注入方式=cdp-port\n");
        }
    }
    if (!options->attachPortSet && !h_dll_proxy_mode && ((!options->injectModeSet && !h_gui_mode_chosen) || h_same(options->injectMode, L"auto")) && !h_pe_section_named(h_selected_path, ".themida")) {
        h_report.injectMode = "cdp-port";
    }
    if (!options->attachPortSet && !h_dll_proxy_mode && ((!options->injectModeSet && !h_gui_mode_chosen) || h_same(options->injectMode, L"auto")) && h_pe_section_named(h_selected_path, ".themida")) {
        {
            WCHAR probeWinmm[CX_CLEANUP_PATH_CAP];
            BOOL proxyReady = FALSE;
            if (h_copy(probeWinmm, CX_CLEANUP_PATH_CAP, h_selected_path)) {
                WCHAR dirOnly[CX_CLEANUP_PATH_CAP];
                DWORD cut = 0, k;
                for (k = 0; probeWinmm[k]; ++k) if (probeWinmm[k] == L'\\') cut = k;
                for (k = 0; k < cut && k + 1 < CX_CLEANUP_PATH_CAP; ++k) dirOnly[k] = probeWinmm[k];
                dirOnly[k] = 0;
                if (h_cat(dirOnly, CX_CLEANUP_PATH_CAP, h_proxy_dll_suffix()) && GetFileAttributesW(dirOnly) != INVALID_FILE_ATTRIBUTES) proxyReady = TRUE;
            }
            if (proxyReady) {
            h_dll_proxy_mode = TRUE;
            h_report.injectMode = "dll-proxy";
                if (!options->quiet) h_print(L"auto: 检测到加壳客户端，已自动启用 dll-proxy\n");
            } else if (h_install_proxy(options)) {
                h_proxy_auto_installed = TRUE;
                h_dll_proxy_mode = TRUE;
                h_report.injectMode = "dll-proxy";
                if (!options->quiet) h_print(L"auto: 检测到加壳客户端，已自动安装代理并启用 dll-proxy（结束后还原）\n");
            } else if (!options->quiet) {
                h_print(L"auto: 检测到加壳客户端，但代理安装失败；请检查客户端目录写权限或改用 --install-proxy\n");
            }
        }
    }


    h_zero(auditError, sizeof(auditError));
    h_diagnostics = cx_diagnostics_create(options, auditError, 256);
    if (!h_diagnostics) h_audit_event("warn", "diagnostics", "Page diagnostics unavailable; continuing without page diagnostics");
    else if (auditError[0]) h_audit_event("warn", "diagnostics", "Page diagnostics path unavailable; continuing without page diagnostics");
    for (attempt = 0; attempt < 2; ++attempt) {    if (options->attachPortSet) port = (USHORT)options->attachPort;
    else {
        CX_DPI_OVERRIDE *dpi = NULL;
        BOOL launched;
        DWORD launchError, running;
        h_report.stopReason = "process-check-failed";
        if (!proc_check_instances(h_selected_path, &running, error, errorCap)) goto done;
        if (running) {
            h_report.stopReason = "client-already-running";
            h_error(error, errorCap, L"CXExam is already running; close existing clients before starting a new owned client");
            goto done;
        }
        h_report.stopReason = "launch-failed";
        if (!h_choose_port(options, &port)) { h_error(error, errorCap, L"no usable loopback CDP port"); goto done; }
        if (options->dpiAware) {
            h_report.stopReason = "dpi-override-failed";
            dpi = cx_dpi_begin(h_selected_path, error, errorCap);
            if (!dpi) goto done;
            h_audit_event("info", "dpi", "Applying temporary system DPI compatibility for owned client launch");
        }
        h_report.stopReason = "launch-failed";
        if (h_dll_proxy_mode) {
            WCHAR proxyPort[16];
            wsprintfW(proxyPort, L"%u", (unsigned)port);
            SetEnvironmentVariableW(L"CX_INJECT_PORT", proxyPort);
            SetEnvironmentVariableW(L"CX_PROXY_SETTINGS_ONLY", L"1");
            launched = proc_launch_env(h_selected_path, port, FALSE, &h_client_pid, &client, error, errorCap);
            SetEnvironmentVariableW(L"CX_INJECT_PORT", NULL);
            SetEnvironmentVariableW(L"CX_PROXY_SETTINGS_ONLY", NULL);
        } else {
            launched = proc_launch(h_selected_path, port, &h_client_pid, &client, error, errorCap);
        }
        launchError = GetLastError();
        if (launched) { h_report.clientPid = h_client_pid; h_report.port = port; }
        if (dpi) {
            WCHAR restoreError[HOST_ERROR_CAP];
            if (!cx_dpi_restore(dpi, restoreError, HOST_ERROR_CAP)) {
                h_report.stopReason = "dpi-restore-failed";
                h_error(error, errorCap, restoreError); goto done;
            }
            h_audit_event("info", "dpi", "Restored the original DPI compatibility setting");
        }
        if (!launched) {
            if (launchError == ERROR_ELEVATION_REQUIRED) {
                if (cx_elevation_can_restart(launchError, options->noElevate, options->elevated)) {
                    h_needs_elevation = TRUE; ok = TRUE;
                    h_report.stopReason = "elevation-requested";
                    h_audit_event("info", "elevation", "Client requires administrator rights; requesting Windows UAC for the host");
                } else h_error(error, errorCap, options->noElevate
                    ? L"Client requires administrator rights; --no-elevate disables the Windows UAC restart"
                    : L"Client requires administrator rights; cannot restart again or verify permissions. Run the host as administrator");
            }
            goto done;
        }
    }
    h_report.clientPid = h_client_pid; h_report.port = port;
    if (h_silent_active && h_client_pid) cx_silent_client_started(&h_silent, h_client_pid);
    h_audit_event("info", "launch", options->attachPortSet ? "Using explicitly attached debug endpoint" : "Owned client started");

    /* Window DPI/snapshot sampling runs once the CDP endpoint is ready (owned launch only). */
    h_started = GetTickCount(); h_duration = options->durationSet ? (DWORD)options->durationMs : 0;
    ok = h_watch_targets(port, options, bootstrap, bootstrapLength, bundle, bundleLength, style, styleLength, trampoline, trampolineLength, error, errorCap);        if (ok || h_needs_elevation || options->attachPortSet) break;
        if (attempt == 0 && h_selfheal_worthwhile() && h_selfheal_retry(options, client)) {
            h_audit_event("warn", "inject", "Endpoint unavailable; retrying with settings-only proxy");
            if (!options->quiet) h_print(L"端口方式未拿到端点，改用 settings-only 代理重试\n");
            continue;
        }
        break;
    }
    /* Publish the host-level diagnostics index after the run; failures are nonfatal. */
    if (h_diagnostics && cx_diagnostics_enabled(h_diagnostics)) {
        WCHAR summaryError[256];
        summaryError[0] = 0;
        if (!cx_diagnostics_write_host_summary(h_diagnostics, options->attachPortSet, summaryError, 256))
            h_audit_event("warn", "diagnostics", "Host diagnostics summary failed; continuing");
    }
done:
    if (h_diagnostics) {
        h_copy(h_created_diagnostics_path, HOST_PATH_CAP, cx_diagnostics_output_path(h_diagnostics));
        cx_diagnostics_close(h_diagnostics);
        h_diagnostics = NULL;
    }
    h_config_close();
    h_report.success = ok && h_exit_code == 0 && !h_needs_elevation;
    if (!ok) { ++h_report.errors; h_audit_event("error", "stop", h_report.stopReason); }
    else h_audit_event("info", "stop", h_report.stopReason);
    if (!ok && !options->quiet) h_print(error[0] ? error : L"native host failed");
    if (bootstrap) HeapFree(GetProcessHeap(), 0, bootstrap); if (bundle) HeapFree(GetProcessHeap(), 0, bundle); if (style) HeapFree(GetProcessHeap(), 0, style); if (trampoline) HeapFree(GetProcessHeap(), 0, trampoline);
    if (client) {
        if (!ok || options->stopClientOnExit) { proc_stop_owned(h_client_pid); WaitForSingleObject(client, 5000); }
        CloseHandle(client);
    }
    cx_discovery_free(&result);
    h_report.durationMs = GetTickCount() - runStarted;
    if (h_audit) {
        if (!h_needs_elevation && !cx_audit_write_report(h_audit, &h_report, auditError, 256)) {
            h_audit_event("error", "report", "Run report could not be written; execution result retained");
            if (options->listClients && !options->quiet) h_print(L"[report] Run report could not be written.\r\n");
        }
        if (!h_needs_elevation && options->reportPathSet) {
            h_copy(h_created_report_path, HOST_PATH_CAP, options->reportPath);
        }
        cx_audit_close(h_audit); h_audit = NULL;
    }
    /* File handles are closed above; only now remove this run's own artifacts. */
    if (h_proxy_auto_installed) {
        h_uninstall_proxy(options);
        h_proxy_auto_installed = FALSE;
    }
    h_cleanup_run_data(options, h_needs_elevation);

    return ok;
}
/* 命令行里是否带 --console（选项尚未解析，先按原始命令行判断）。 */
static BOOL h_wants_console(void) {
    const WCHAR *cmd = GetCommandLineW();
    const WCHAR needle[] = L"--console";
    int i, k;
    if (!cmd) return FALSE;
    for (i = 0; cmd[i]; ++i) {
        for (k = 0; needle[k] && cmd[i + k] == needle[k]; ++k) { }
        if (!needle[k]) return TRUE;
    }
    return FALSE;
}
int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR commandLine, int show) {
    /* GUI 子系统进程默认没有控制台；调试入口从 cmd 启动时必须附加父控制台，
       否则 GetStdHandle 无效，h_print 的日志会被全部丢弃。 */
    {
        HANDLE stdOut = GetStdHandle(STD_OUTPUT_HANDLE);
        if (!stdOut || stdOut == INVALID_HANDLE_VALUE) {
            if (!AttachConsole(ATTACH_PARENT_PROCESS)) {
                /* 没有父控制台：--console 时自己开一个窗口（暂存副本尤其需要）。 */
                if (h_wants_console() && AllocConsole()) {
                    HWND ownedConsole = GetConsoleWindow();
                    HICON icon = LoadIconW(GetModuleHandleW(NULL), MAKEINTRESOURCEW(CX_RESOURCE_APP_ICON));
                    if (ownedConsole && icon) {
                        SendMessageW(ownedConsole, WM_SETICON, ICON_BIG, (LPARAM)icon);
                        SendMessageW(ownedConsole, WM_SETICON, ICON_SMALL, (LPARAM)icon);
                    }
                }
            }
            {
                HANDLE console = CreateFileW(L"CONOUT$", GENERIC_READ | GENERIC_WRITE,
                                             FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
                if (console && console != INVALID_HANDLE_VALUE) {
                    SetStdHandle(STD_OUTPUT_HANDLE, console);
                    SetStdHandle(STD_ERROR_HANDLE, console);
                }
            }
        }
    }
    LPWSTR *argv; int argc, argument; BOOL ok, elevated = FALSE; WSADATA data; (void)instance; (void)previous; (void)commandLine; (void)show;
    h_zero(h_main_error, sizeof(h_main_error)); h_zero(h_exe_path, sizeof(h_exe_path)); GetModuleFileNameW(NULL, h_exe_path, HOST_PATH_CAP);
    cx_options_init(&h_base_options); cx_options_init(&h_cli_options); cx_options_init(&h_config_options); cx_options_init(&h_json_options);
    if (!cx_options_load_default(&h_base_options, h_exe_path, h_main_error, HOST_ERROR_CAP)) return 2;
    argv = CommandLineToArgvW(GetCommandLineW(), &argc); if (!argv) return 2;
    ok = cx_options_parse_cli(&h_cli_options, argc - 1, argv + 1, h_main_error, HOST_ERROR_CAP);
    if (!ok) { if (!h_cli_options.quiet) h_print(h_main_error); LocalFree(argv); return 2; }
    /* A double-click must allow choosing a client even when defaults name one. */
    h_default_gui = TRUE;
    for (argument = 1; argument < argc; ++argument) {
        if (!h_equal(argv[argument], L"--elevate-on-start") && !h_equal(argv[argument], L"--elevated")) {
            h_default_gui = FALSE; break;
        }
    }
    LocalFree(argv);
    if (h_cli_options.configPathSet && !cx_options_load_file(&h_config_options, h_cli_options.configPath, h_main_error, HOST_ERROR_CAP)) { if (!h_cli_options.quiet) h_print(h_main_error); return 2; }
    if (!cx_options_apply_pending_json(&h_json_options, &h_cli_options, h_main_error, HOST_ERROR_CAP)) { if (!h_cli_options.quiet) h_print(h_main_error); return 2; }
    if (!cx_options_merge(&h_base_options, &h_config_options, h_main_error, HOST_ERROR_CAP) || !cx_options_merge(&h_base_options, &h_json_options, h_main_error, HOST_ERROR_CAP) || !cx_options_merge(&h_base_options, &h_cli_options, h_main_error, HOST_ERROR_CAP)) { if (!h_cli_options.quiet) h_print(h_main_error); return 2; }
    if (!cx_options_finalize(&h_base_options, h_main_error, HOST_ERROR_CAP)) { if (!h_cli_options.quiet) h_print(h_main_error); return 2; }
    if (h_base_options.elevated) {
        if (!cx_elevation_query(&elevated) || !elevated) {
            if (!h_base_options.quiet) h_print(L"Internal elevated restart requires a verified administrator token");
            return 2;
        }
    }
    if (h_base_options.help) {
        h_out_begin();
        h_print_utf8("超星学习助手 Windows 宿主 6.2.0（原生原型）\n"
            "用法: chaoxing_plus.exe [参数]\n"
            "客户端: --client <path> | --client-index <n> | --client-first | --select-client\n"
            "扫描: --scan-mode common|fallback-all|all --scan-clients --list-clients --ui auto|gui|cli\n"
    "注入: --inject-mode auto|cdp-port|cdp-pipe|dll-proxy|input（显式 auto 且已装代理时优先 dll-proxy；不带 --inject-mode 时等同 cdp-port）\n"
    "注入: --inject-proxy-dir <dir>（dll-proxy 模式检查 winmm.dll 的目录，默认客户端目录）\n"
    "注入: --show-inject-reasons（选择窗口显示注入方式不可用的原因；默认不显示）\n"
            "  无参数启动只扫描常见目录后显示选择窗口；可在窗口点击“全盘扫描”递归搜索。\n"
            "  common 只检查常见根目录及一级子目录；fallback-all 仅在常规无结果时递归。\n"
            "  原生选择/进度窗口为 DPI 感知界面，会按系统缩放比例调整控件与字体。\n"
            "  --scan-all|--no-scan-all（常规无结果时是否全盘回退） --rescan（绕过缓存并更新）\n"
            "  --no-scan-cache（禁读写缓存）；缓存有效期 5 分钟，仅扫描列表始终实时。\n"
            "配置: --config <path> --options-json <JSON|@file> --print-effective-config\n"
            "面板: --panel|--no-panel --panel-expanded|--panel-collapsed\n"
    "面板: --panel-all-pages（非考试页也显示面板，便于确认注入是否生效）\n"
            "  --panel-top <0-10000> --panel-right <0-10000> --panel-width <320-800>\n"
            "  --panel-theme <pink|blue|green>（面板主题，未知值回退 pink）\n"
            "答题: --answer-mode auto|manual --answer-key <shortcut> --answer-threads <1-4> --answer-retry <0-20>\n"
            "  --show-answer-dialog|--hide-answer-dialog --answer-countdown <sec> --no-auto-submit\n"
            "注入: --inject-strategy runtime|script|hybrid --inject-retries <0-5>\n"
            "  --inject-blank-frames|--no-inject-blank-frames\n"
            "  --debug-timeout <1000-120000 ms> --bundle-timeout <1000-300000 ms>\n"
            "  --target-poll-interval <250-10000 ms> --expected-browser <text> --assets <dir>\n"
            "运行: --execution-mode normal --port <0|1024-65534> --stop-client-on-exit\n"
            "静默: --silent-scenario（固定场景：无面板/无日志/手动放行/自毁） --silent-delete-simulate（只报告删除计划）\n"
            "       --silent-client <path>（测试/诊断：显式指定客户端，跳过扫描）\n"
            "  启动前检查已有 CXExam 进程；请先关闭已有客户端，宿主不会结束它们。\n"
            "  --no-elevate（禁止启动遇到 740 时通过 Windows UAC 重启宿主）\n"
            "  --elevate-on-start（扫描及窗口前请求管理员权限；与 --no-elevate 互斥）\n"
            "  --dpi-aware（启动时临时使用 HIGHDPIAWARE，随后恢复原值；与 no-disk-write/attach 互斥）\n"
            "  --data-dir <dir> --log|--no-log --report <path> --quiet\n"
            "  --diagnose|--no-diagnose --diagnostics-dir <dir>（页面布局 + 自有启动窗口 DPI/截图采样）\n"
            "  --no-disk-write（同时禁止日志和报告） --duration <ms, 0=不限时>\n"
            "  --capture-console|--no-capture-console（只记录页面错误事件，不保存页面文本）\n"
            "  --retain-data|--no-retain-data（退出时是否删除本次运行创建的日志/报告/诊断；默认保留）\n"
            "  --delete-config（退出时删除显式 --config 文件；不能与 --no-disk-write 同用）\n"
            "调试: --attach <port>（显式连接已有端口，跳过启动和归属检查，仅供测试）\n"
    "调试: --pipe-test（自检管道启动）--pipe-client <客户端路径>（管道握手 Browser.getVersion）\n"
    "调试: --install-proxy [--proxy-source <dll>] [--proxy-target winmm|version|uxtheme|msimg32|sensapi|oledlg|wtsapi32|auto]（把代理装到 --client 目录，配合 auto 使用）\n"
    "调试: --uninstall-proxy（按 cxhook-proxy.marker 卸载我们装的 winmm.dll，不动第三方同名文件）\n"
    "调试: --proxy-port <1024-65534>（可选：安装代理时写入 cxhook-port.txt，供第三方启动时固定端口注入；不传则不写）\n"
    "调试: --probe-client <CXExam.exe> / --probe-all（只读探测架构/版本/libcef 开关/代理状态，给出建议通道）\n"
    "启动: --console（GUI 宿主附加或分配控制台）--stage-boot（静默暂存启动）\n"
    "调试: --pipe-call <exe> [--pipe-expr <js>] [--pipe-args \"<args>\"]（管道 CDP 全链路诊断）\n"
            "状态: --version（-v/-V/--v/--Version） --help（-h/-H/--h/--H/-help/--Help/--HELP/-?/?） --capabilities --self-check（不自动扫描、不启动、不连接、不写文件）\n"
    "兼容: 参数名不区分大小写；--name、-name、/name、--na_me 等价；值可写成 --name=value。\n"
            "配置修改: 共享设置同步到已选配置文件并广播；文件热更新保留 CLI/内联 JSON 优先级。\n"
            "  诊断仅采集一次性页面视口/面板几何/样式、页面截图及自有启动窗口 DPI/BMP，不采集正文或 URL。\n"
            "执行模式: --execution-mode normal|memory；memory 表示宿主侧零落盘（客户端仍正常可见启动）。\n"
            "静默场景（--silent-scenario）已原生支持自毁与程序痕迹清理；删除挂起/启动清理仍拒绝执行。\n");
        h_out_flush();
        return 0;
    }
    if (h_base_options.version) { h_out_begin(); h_print_utf8("6.2.0\n"); h_out_flush(); return 0; }
    if (h_base_options.capabilities) {
        if (!cx_asset_validate_embedded(h_main_error, HOST_ERROR_CAP)) { h_print(h_main_error); return 2; }
        h_out_begin();
        h_print_utf8("{\"host\":\"native\",\"executionMode\":\"");
        h_print_utf8(h_base_options.executionModeMemory ? "memory" : "normal");
        h_print_utf8("\",\"executionModes\":[\"normal\",\"memory\"],\"embeddedResources\":true,\"embeddedResourceCount\":5,\"embeddedProxy\":true,"
            "\"nativeSelection\":true,\"highDpiUi\":true,\"scanCache\":true,\"contextLifecycle\":true,\"navigation\":true,\"targetReconnect\":true,"
            "\"maxPageSessions\":16,\"configReload\":true,\"configPersistence\":true,\"fileLogging\":true,\"runReport\":true,\"renderDiagnostics\":false,\"pageRenderDiagnostics\":true,\"pageScreenshots\":true,\"windowDiagnostics\":true,\"diagnosticsSummary\":true,\"selfCheck\":true,\"standardUac\":true,\"elevateOnStart\":true,\"temporaryDpiOverride\":true,\"existingClientCheck\":true,"
            "\"retainData\":true,\"deleteConfig\":true,"
            "\"memory\":");
        h_print_utf8(h_base_options.executionModeMemory ? "true" : "false");
        h_print_utf8(",\"deleteSuspend\":false,\"selfDestruct\":false,\"silentScenario\":true,\"wipe\":false,\"injectModes\":[\"auto\",\"cdp-port\",\"cdp-pipe\",\"dll-proxy\"],\"injectModeSupport\":{\"auto\":true,\"cdp-port\":true,\"cdp-pipe\":false,\"dll-proxy\":true}}\n");
        h_out_flush();
        return 0;
    }
    if (h_base_options.pipeTest) { return h_pipe_test() ? 0 : 1; }
    if (h_base_options.installProxy) { return h_install_proxy(&h_base_options) ? 0 : 1; }
    if (h_base_options.probeClientPathSet) { return h_probe_client(h_base_options.probeClientPath) ? 0 : 1; }
    if (h_base_options.probeAll) { return h_probe_all() ? 0 : 1; }
    if (h_base_options.uninstallProxy) { return h_uninstall_proxy(&h_base_options) ? 0 : 1; }
    if (h_base_options.pipeExtraArgs[0]) h_copy(h_pipe_extra_args, 512, h_base_options.pipeExtraArgs);
    if (h_base_options.pipeCallPathSet) { return h_pipe_stage2(h_base_options.pipeCallPath, h_base_options.pipeExpr) ? 0 : 1; }
    if (h_base_options.pipeClientPathSet) {
        int pipeCode = h_pipe_client_test(h_base_options.pipeClientPath);
        if (pipeCode == 740) {
            LPWSTR *pipeArgv = CommandLineToArgvW(GetCommandLineW(), &argc);
            DWORD childCode = 1;
            BOOL restarted = FALSE;
            if (pipeArgv) {
                restarted = cx_elevation_restart(h_exe_path, argc - 1, pipeArgv + 1, NULL, &childCode, h_main_error, HOST_ERROR_CAP);
                LocalFree(pipeArgv);
            }
            if (restarted) return (int)childCode;
            h_print(L"pipe-client: elevation required; run this command as administrator");
            return 3;
        }
        return pipeCode == 1 ? 0 : 1;
    }
    if (h_base_options.selfCheck) return h_self_check(&h_base_options);
    if (h_base_options.printEffectiveConfig) {
        DWORD settingsLength = 0;
        if (!cx_options_effective_settings_json_utf8(&h_base_options, h_settings, sizeof(h_settings), &settingsLength)) return 2;
        h_out_begin();
        h_print_utf8(h_settings); h_print_utf8("\n");
        h_out_flush();
        return 0;
    }
    /* 静默场景启动后会把自身改名为 .cxdel；提权重启必须指向仍然存在的镜像。 */
    const WCHAR *h_restart_path = h_silent_parked[0] ? h_silent_parked : h_exe_path;
    if (h_base_options.elevateOnStart && !h_base_options.listClients && !h_base_options.attachPortSet) {
        DWORD childCode = 1;
        if (!h_base_options.elevated && !cx_elevation_query(&elevated)) {
            if (!h_base_options.quiet) h_print(L"Cannot determine administrator token for elevate-on-start");
            return 1;
        }
        if (!elevated) {
            argv = CommandLineToArgvW(GetCommandLineW(), &argc);
            if (!argv) { if (!h_base_options.quiet) h_print(L"Cannot preserve administrator restart arguments"); return 1; }
            ok = cx_elevation_restart(h_restart_path, argc - 1, argv + 1, NULL, &childCode, h_main_error, HOST_ERROR_CAP);
            LocalFree(argv);
            if (!ok && !h_base_options.quiet) h_print(h_main_error);
            return (int)childCode;
        }
    }
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return 2;
    ok = h_run(&h_base_options, h_main_error, HOST_ERROR_CAP); WSACleanup();
    if (h_needs_elevation) {
        DWORD childCode = 1;
        argv = CommandLineToArgvW(GetCommandLineW(), &argc);
        if (!argv) { if (!h_base_options.quiet) h_print(L"Cannot preserve administrator restart arguments"); return 1; }
        ok = cx_elevation_restart(h_restart_path, argc - 1, argv + 1, h_selected_path,
                                  &childCode, h_main_error, HOST_ERROR_CAP);
        LocalFree(argv);
        if (!ok && !h_base_options.quiet) h_print(h_main_error);
        return (int)childCode;
    }
    /* 任何退出路径（正常停止/错误停止）都要把改名后的自身交给看门狗删除；
       提权交接在上面已 return，由子实例继续负责。 */
    /* 暂存副本：退出时才改名并删除自身。启动期改名会让 UAC 提权重启找不到可执行的 .exe。 */
    if (!h_silent_parked[0] && h_base_options.stagedBoot && h_exe_path[0])
        cx_cleanup_detach_self(h_exe_path, h_silent_parked, CX_CLEANUP_PATH_CAP);
    /* 提权交接会产生两个实例，可能各自改名一次（s.exe.cxdel / s.exe.cxdel.cxdel）。
       收尾时把两种名字都交给看门狗，避免留下第二个改名文件。 */
    if (h_silent_parked[0]) {
        WCHAR parked2[CX_CLEANUP_PATH_CAP];
        if (h_copy(parked2, CX_CLEANUP_PATH_CAP, h_silent_parked) &&
            h_cat(parked2, CX_CLEANUP_PATH_CAP, L".cxdel") &&
            GetFileAttributesW(parked2) != INVALID_FILE_ATTRIBUTES) {
            cx_cleanup_release_self(parked2);
        }
    }
    if (h_silent_parked[0]) {
        cx_cleanup_release_self(h_silent_parked);
        h_silent_parked[0] = 0;
    }
    return h_exit_code ? h_exit_code : (ok ? 0 : 1);
}

void __stdcall WinMainCRTStartup(void) {
    ExitProcess((UINT)WinMain(GetModuleHandleW(NULL), NULL, NULL, SW_HIDE));
}
































































































































































