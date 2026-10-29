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

/* 把自身复制到 %TEMP%\cx-<pid>\s.exe，用原参数拉起副本（追加 --staged-boot）。 */
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
    if (!h_copy(staged, CX_CLEANUP_PATH_CAP, dir) || !h_cat(staged, CX_CLEANUP_PATH_CAP, L"\\s.exe")) return FALSE;
    if (!CopyFileW(h_exe_path, staged, FALSE)) { RemoveDirectoryW(dir); return FALSE; }
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
        if (command[0] && h_cat(command, CX_CLEANUP_PATH_CAP * 3, L" --staged-boot")) {
            ZeroMemory(&si, sizeof(si));
            si.cb = sizeof(si);
            ZeroMemory(&pi, sizeof(pi));
            if (CreateProcessW(staged, command, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                ok = TRUE;
            }
        }
    }
    if (!ok) { DeleteFileW(staged); RemoveDirectoryW(dir); }
    LocalFree(argv);
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
static BOOL h_set_page_config(NET_WS *ws, DWORD *nextId, const CX_OPTIONS *options,
                              const char *style, DWORD styleLength, BOOL preflight, WCHAR *error, DWORD errorCap) {
    const char prefix[] = "window.__CX_WIN_CONFIG_JSON__=";
    const char middle[] = ";window.__CX_WIN_INSTANCE__=";
    const char stylePrefix[] = ";window.__CX_WIN_STYLE_TEXT__=";
    char *config = NULL, *expression = NULL;
    DWORD configLength = 0, capacity, at = 0;
    BOOL ok = FALSE;
    config = (char *)HeapAlloc(GetProcessHeap(), 0, CX_OPTIONS_JSON_CAP);
    if (!config || !cx_options_effective_settings_json_utf8(options, config, CX_OPTIONS_JSON_CAP, &configLength)) {
        h_error(error, errorCap, L"cannot serialize native settings"); goto done;
    }
    if (!preflight && h_config_json(&configLength)) CopyMemory(config, h_config_json(&configLength), configLength + 1);
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
    if (at > HOST_EVAL_SOURCE_CAP) { h_error(error, errorCap, L"native page config exceeds CDP expression limit"); goto done; }
    ok = preflight || h_send_eval(ws, (*nextId)++, expression, at, error, errorCap);
done:
    if (config) HeapFree(GetProcessHeap(), 0, config);
    if (expression) HeapFree(GetProcessHeap(), 0, expression);
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
    for (p = 38100; p < 38200; ++p) if (proc_port_bindable(p, error, 64)) { *port = p; return TRUE; }
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
            h_copy(h_scan_cache_path + length, sizeof(h_scan_cache_path) / sizeof(WCHAR) - length, L"native-scan-cache-v1.bin");
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
        /* 暂存副本目录没有 SHA256SUMS，信任闸门会跳过整段清理；副本自身仍必须消失。 */
        if (options->stagedBoot && !h_silent_parked[0] && h_exe_path[0]) {
            cx_cleanup_detach_self(h_exe_path, h_silent_parked, CX_CLEANUP_PATH_CAP);
        }
        h_silent_cleanup_pass();
        h_silent_next_tick = GetTickCount();
        h_audit_event("info", "silent", "Silent scenario active: no panel/log/console, program cleanup enabled");
    }
    if (options->attachPortSet) port = (USHORT)options->attachPort;
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
        launched = proc_launch(h_selected_path, port, &h_client_pid, &client, error, errorCap);
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
    h_zero(auditError, sizeof(auditError));
    h_diagnostics = cx_diagnostics_create(options, auditError, 256);
    if (!h_diagnostics) h_audit_event("warn", "diagnostics", "Page diagnostics unavailable; continuing without page diagnostics");
    else if (auditError[0]) h_audit_event("warn", "diagnostics", "Page diagnostics path unavailable; continuing without page diagnostics");
    /* Window DPI/snapshot sampling runs once the CDP endpoint is ready (owned launch only). */
    h_started = GetTickCount(); h_duration = options->durationSet ? (DWORD)options->durationMs : 0;
    ok = h_watch_targets(port, options, bootstrap, bootstrapLength, bundle, bundleLength, style, styleLength, trampoline, trampolineLength, error, errorCap);
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
    h_cleanup_run_data(options, h_needs_elevation);
    return ok;
}
int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR commandLine, int show) {
    /* GUI 子系统进程默认没有控制台；调试入口从 cmd 启动时必须附加父控制台，
       否则 GetStdHandle 无效，h_print 的日志会被全部丢弃。 */
    {
        HANDLE stdOut = GetStdHandle(STD_OUTPUT_HANDLE);
        if ((!stdOut || stdOut == INVALID_HANDLE_VALUE) && AttachConsole(ATTACH_PARENT_PROCESS)) {
            HANDLE console = CreateFileW(L"CONOUT$", GENERIC_READ | GENERIC_WRITE,
                                         FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
            if (console && console != INVALID_HANDLE_VALUE) {
                SetStdHandle(STD_OUTPUT_HANDLE, console);
                SetStdHandle(STD_ERROR_HANDLE, console);
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
        h_print_utf8("超星学习助手 Windows 宿主 6.2.0（原生原型）\n"
            "用法: chaoxing_plus.exe [参数]\n"
            "客户端: --client <path> | --client-index <n> | --client-first | --select-client\n"
            "扫描: --scan-mode common|fallback-all|all --scan-clients --list-clients --ui auto|gui|cli\n"
            "  无参数启动只扫描常见目录后显示选择窗口；可在窗口点击“全盘扫描”递归搜索。\n"
            "  common 只检查常见根目录及一级子目录；fallback-all 仅在常规无结果时递归。\n"
            "  原生选择/进度窗口为 DPI 感知界面，会按系统缩放比例调整控件与字体。\n"
            "  --scan-all|--no-scan-all（常规无结果时是否全盘回退） --rescan（绕过缓存并更新）\n"
            "  --no-scan-cache（禁读写缓存）；缓存有效期 5 分钟，仅扫描列表始终实时。\n"
            "配置: --config <path> --options-json <JSON|@file> --print-effective-config\n"
            "面板: --panel|--no-panel --panel-expanded|--panel-collapsed\n"
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
            "状态: --version --help --capabilities --self-check（不自动扫描、不启动、不连接、不写文件）\n"
            "配置修改: 共享设置同步到已选配置文件并广播；文件热更新保留 CLI/内联 JSON 优先级。\n"
            "  诊断仅采集一次性页面视口/面板几何/样式、页面截图及自有启动窗口 DPI/BMP，不采集正文或 URL。\n"
            "执行模式: --execution-mode normal|memory；memory 表示宿主侧零落盘（客户端仍正常可见启动）。\n"
            "静默场景（--silent-scenario）已原生支持自毁与程序痕迹清理；删除挂起/启动清理仍拒绝执行。\n");
        return 0;
    }
    if (h_base_options.version) { h_print_utf8("6.2.0\n"); return 0; }
    if (h_base_options.capabilities) {
        if (!cx_asset_validate_embedded(h_main_error, HOST_ERROR_CAP)) { h_print(h_main_error); return 2; }
        h_print_utf8("{\"host\":\"native\",\"executionMode\":\"");
        h_print_utf8(h_base_options.executionModeMemory ? "memory" : "normal");
        h_print_utf8("\",\"executionModes\":[\"normal\",\"memory\"],\"embeddedResources\":true,\"embeddedResourceCount\":4,"
            "\"nativeSelection\":true,\"highDpiUi\":true,\"scanCache\":true,\"contextLifecycle\":true,\"navigation\":true,\"targetReconnect\":true,"
            "\"maxPageSessions\":16,\"configReload\":true,\"configPersistence\":true,\"fileLogging\":true,\"runReport\":true,\"renderDiagnostics\":false,\"pageRenderDiagnostics\":true,\"pageScreenshots\":true,\"windowDiagnostics\":true,\"diagnosticsSummary\":true,\"selfCheck\":true,\"standardUac\":true,\"elevateOnStart\":true,\"temporaryDpiOverride\":true,\"existingClientCheck\":true,"
            "\"retainData\":true,\"deleteConfig\":true,"
            "\"memory\":");
        h_print_utf8(h_base_options.executionModeMemory ? "true" : "false");
        h_print_utf8(",\"deleteSuspend\":false,\"selfDestruct\":false,\"silentScenario\":true,\"wipe\":false}\n");
        return 0;
    }
    if (h_base_options.selfCheck) return h_self_check(&h_base_options);
    if (h_base_options.printEffectiveConfig) {
        DWORD settingsLength = 0;
        if (!cx_options_effective_settings_json_utf8(&h_base_options, h_settings, sizeof(h_settings), &settingsLength)) return 2;
        h_print_utf8(h_settings); h_print_utf8("\n"); return 0;
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
    if (h_silent_parked[0]) {
        cx_cleanup_release_self(h_silent_parked);
        h_silent_parked[0] = 0;
    }    return ok ? h_exit_code : 1;
}

void __stdcall WinMainCRTStartup(void) {
    ExitProcess((UINT)WinMain(GetModuleHandleW(NULL), NULL, NULL, SW_HIDE));
}










