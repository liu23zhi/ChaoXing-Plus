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
#include "config-store.h"

#define HOST_PATH_CAP 32768
#define HOST_ERROR_CAP 512
#define HOST_URL_CAP 2048
#define HOST_SOURCE_CAP (8UL * 1024UL * 1024UL)
#define HOST_COMMAND_CAP (8UL * 1024UL * 1024UL)
#define HOST_EVAL_SOURCE_CAP ((HOST_COMMAND_CAP - 1024UL) / 6UL)
#define HOST_REPLY_TOKENS 8192
#define HOST_MAX_PAGES 16

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
    CX_SESSION_STATS reported;
} H_NATIVE_PAGE;

static H_NATIVE_PAGE *h_current_page;
static CX_SESSION_TASK h_current_task;
static BOOL h_task_pending;
static int h_current_context;
static DWORD h_command_timeout = 10000;
static DWORD h_client_pid, h_started, h_duration;
static DWORD h_bundles_completed;
static int h_exit_code;
static CX_AUDIT *h_audit;
static CX_AUDIT_REPORT h_report;
static BOOL h_capture_console;
static BOOL h_quiet;
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
static JT h_event_tokens[HOST_REPLY_TOKENS];
static JT h_page_message_tokens[HOST_REPLY_TOKENS];
static char h_page_message[CX_OPTIONS_JSON_CAP + 512];

static int h_len(const char *s) { int n = 0; if (s) while (s[n]) ++n; return n; }
static int h_wlen(const WCHAR *s) { int n = 0; if (s) while (s[n]) ++n; return n; }
static void h_zero(void *p, SIZE_T n) { volatile BYTE *b = (volatile BYTE *)p; while (n--) *b++ = 0; }
static BOOL h_copy(WCHAR *out, DWORD cap, const WCHAR *in) {
    DWORD i = 0; if (!out || !cap || !in) return FALSE;
    while (in[i] && i + 1 < cap) { out[i] = in[i]; ++i; }
    out[i] = 0; return in[i] == 0;
}
static void h_error(WCHAR *error, DWORD cap, const WCHAR *text) { if (error && cap) lstrcpynW(error, text, (int)cap); }
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
static void h_audit_event(const char *level, const char *event, const char *message) {
    WCHAR error[256];
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
        }
        return;
    }
}
static BOOL h_operation_active(void) {
    if (h_client_pid && !proc_alive(h_client_pid)) return FALSE;
    if (h_duration && GetTickCount() - h_started >= h_duration) return FALSE;
    return !h_task_pending || !h_current_page || cx_session_task_active(h_current_page->state, &h_current_task);
}
static void h_dispatch_event(const char *json, DWORD length) {
    JT *tokens = h_event_tokens;
    int params, frame, method;
    if (!h_current_page || !h_current_page->state) return;
    cx_session_feed(h_current_page->state, json, length);
    h_sample_page(h_current_page);
    if (jparse(json, (int)length, tokens, HOST_REPLY_TOKENS) <= 0) return;
    method = jkey(json, tokens, 0, "method");
    if (jeq(json, tokens, method, "Page.frameNavigated")) {
        params = jkey(json, tokens, 0, "params");
        frame = jkey(json, tokens, params, "frame");
        if (frame >= 0 && jkey(json, tokens, frame, "parentId") < 0) {
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
    tokens = (JT *)HeapAlloc(GetProcessHeap(), 0, sizeof(JT) * HOST_REPLY_TOKENS);
    if (!tokens) { h_error(error, errorCap, L"out of memory parsing CDP response"); return FALSE; }
    if (replyOut) *replyOut = NULL;
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
static BOOL h_send_eval_checked(NET_WS *ws, DWORD id, const char *expression, DWORD expressionLength, BOOL requireTrue, WCHAR *error, DWORD errorCap) {
    char *command; DWORD at = 0, commandCap; char idText[16]; DWORD n = 0; unsigned int v = id;
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
    return h_wait_reply(ws, id, requireTrue, NULL, NULL, error, errorCap);
command_error:
    HeapFree(GetProcessHeap(), 0, command); h_error(error, errorCap, L"CDP command exceeds native limit"); return FALSE;
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
    capacity = configLength + styleLength * 6 + 256;
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
static BOOL h_choose_port(const CX_OPTIONS *options, USHORT *port) {
    USHORT p; WCHAR error[64];
    if (options && options->portSet && options->port > 0 && options->port <= 65535) {
        p = (USHORT)options->port;
        if (proc_port_bindable(p, error, 64)) { *port = p; return TRUE; }
        return FALSE;
    }
    for (p = 38100; p < 38200; ++p) if (proc_port_bindable(p, error, 64)) { *port = p; return TRUE; }
    return FALSE;
}
#include "host-config.inc"
#include "host-session.inc"

static BOOL h_pick_client(const CX_OPTIONS *options, const CX_DISCOVERY_RESULT *result, WCHAR *error, DWORD errorCap) {
    DWORD index = result->recommendedIndex, mode = 0;
    BOOL console = GetConsoleMode(GetStdHandle(STD_INPUT_HANDLE), &mode);
    BOOL gui = !options->clientPathSet && !options->clientIndexSet && (options->selectClient || h_equal(options->ui, L"gui")
        || (h_equal(options->ui, L"auto") && !options->quiet && !options->clientFirst && !console));
    if (gui) {
        SYSTEM_INFO info;
        CX_SELECTION_STATUS status;
        GetNativeSystemInfo(&info);
        status = cx_select_client(result, info.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_INTEL, h_selected_path, HOST_PATH_CAP, error, errorCap);
        if (status == CX_SELECTION_CANCELLED) { h_exit_code = 3; return FALSE; }
        return status == CX_SELECTION_SELECTED;
    }
    if (!result->count) { h_error(error, errorCap, L"no valid CXExam.exe was found"); return FALSE; }
    if (options->clientIndexSet) {
        if (options->clientIndex < 1 || (DWORD)options->clientIndex > result->count) { h_error(error, errorCap, L"client-index is outside the discovered candidate list"); return FALSE; }
        index = (DWORD)options->clientIndex - 1;
    } else if (!options->clientPathSet && !options->clientFirst && !options->quiet && console) {
        WCHAR input[512]; DWORD i, read = 0; int value = 0;
        for (i = 0; i < result->count; ++i) {
            char number[16]; h_decimal(number, i + 1); h_print_utf8(number); h_print(L". "); h_print(result->items[i].path); h_print(L"\r\n");
        }
        h_print(L"Select a client number (Enter uses recommended): ");
        if (!ReadConsoleW(GetStdHandle(STD_INPUT_HANDLE), input, 511, &read, NULL)) { h_error(error, errorCap, L"cannot read client selection"); return FALSE; }
        input[read] = 0;
        if (input[0] >= L'0' && input[0] <= L'9') {
            for (i = 0; i < read && input[i] >= L'0' && input[i] <= L'9'; ++i) {
                if (value > 100000) { h_error(error, errorCap, L"invalid client selection"); return FALSE; }
                value = value * 10 + input[i] - L'0';
            }
            if (value < 1 || (DWORD)value > result->count) { h_error(error, errorCap, L"invalid client selection"); return FALSE; }
            index = (DWORD)value - 1;
        }
    }
    return h_copy(h_selected_path, HOST_PATH_CAP, result->items[index].path);
}
static BOOL h_run(CX_OPTIONS *options, WCHAR *error, DWORD errorCap) {
    CX_DISCOVERY_OPTIONS discover; CX_DISCOVERY_RESULT result; DWORD i; HANDLE client = NULL; USHORT port = 0;
    char *bootstrap = NULL, *bundle = NULL, *style = NULL, *trampoline = NULL;
    DWORD bootstrapLength, bundleLength, styleLength, trampolineLength;
    BOOL ok = FALSE;
    DWORD runStarted = GetTickCount();
    WCHAR auditError[256];
    h_zero(&discover, sizeof(discover)); cx_discovery_init(&result);
    h_zero(&h_report, sizeof(h_report)); h_exit_code = 0;
    h_capture_console = options->captureConsole; h_quiet = options->quiet;
    h_report.attached = options->attachPortSet;
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
        if (auditError[0]) h_audit_event("warn", "audit", "Some file output is unavailable; continuing");
        h_audit_event("info", "start", "Native host started");
    }
    h_client_pid = 0; h_duration = 0; h_bundles_completed = 0;
    if (!options->attachPortSet) {
        discover.mode = h_equal(options->scanMode, L"common") ? CX_DISCOVERY_SCAN_COMMON : (h_equal(options->scanMode, L"all") ? CX_DISCOVERY_SCAN_ALL : CX_DISCOVERY_SCAN_FALLBACK_ALL);
        discover.clientPath = options->clientPathSet ? options->clientPath : NULL;
        discover.enumerateAll = options->listClients || options->selectClient || options->clientIndexSet || h_equal(options->ui, L"gui") || (!options->clientFirst && !options->quiet);
        if (!cx_discovery_scan(&discover, &result, error, errorCap)) goto done;
        if (options->listClients) {
            for (i = 0; i < result.count; ++i) { h_print(result.items[i].path); h_print(L"\r\n"); }
            h_report.stopReason = "list-clients"; ok = TRUE; goto done;
        }
        if (!result.count && options->quiet && options->clientFirst) { h_report.stopReason = "no-client"; ok = TRUE; goto done; }
        h_report.stopReason = "selection-failed";
        if (!h_pick_client(options, &result, error, errorCap)) { if (h_exit_code == 3) { h_report.stopReason = "cancelled"; ok = TRUE; } goto done; }
    }
    h_report.stopReason = "assets-failed";
    if (!h_config_begin(options, error, errorCap)) goto done;
    if (!cx_asset_load(L"windows-bootstrap.js", options->assetsDirSet ? options->assetsDir : NULL, &bootstrap, &bootstrapLength, error, errorCap)
        || !cx_asset_load(L"chaoxing-plus.windows.js", options->assetsDirSet ? options->assetsDir : NULL, &bundle, &bundleLength, error, errorCap)
        || !cx_asset_load(L"sweetalert2.min.css", options->assetsDirSet ? options->assetsDir : NULL, &style, &styleLength, error, errorCap)
        || !cx_asset_load(L"trampoline.js", options->assetsDirSet ? options->assetsDir : NULL, &trampoline, &trampolineLength, error, errorCap)) goto done;
    if (!h_preflight_assets(options, bootstrapLength, bundleLength, style, styleLength, error, errorCap)) goto done;
    if (trampolineLength > HOST_EVAL_SOURCE_CAP / 6 || bootstrapLength + 128 > HOST_EVAL_SOURCE_CAP || bundleLength + 128 > HOST_EVAL_SOURCE_CAP) { h_error(error, errorCap, L"native resource wrapper exceeds CDP capacity"); goto done; }
    if (options->attachPortSet) port = (USHORT)options->attachPort;
    else {
        h_report.stopReason = "launch-failed";
        if (!h_choose_port(options, &port)) { h_error(error, errorCap, L"no usable loopback CDP port"); goto done; }
        if (!proc_launch(h_selected_path, port, &h_client_pid, &client, error, errorCap)) goto done;
    }
    h_report.clientPid = h_client_pid; h_report.port = port;
    h_audit_event("info", "launch", options->attachPortSet ? "Using explicitly attached debug endpoint" : "Owned client started");
    h_started = GetTickCount(); h_duration = options->durationSet ? (DWORD)options->durationMs : 0;
    ok = h_watch_targets(port, options, bootstrap, bootstrapLength, bundle, bundleLength, style, styleLength, trampoline, trampolineLength, error, errorCap);
done:
    h_config_close();
    h_report.success = ok && h_exit_code == 0;
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
        if (!cx_audit_write_report(h_audit, &h_report, auditError, 256)) {
            h_audit_event("error", "report", "Run report could not be written; execution result retained");
            if (options->listClients && !options->quiet) h_print(L"[report] Run report could not be written.\r\n");
        }
        cx_audit_close(h_audit); h_audit = NULL;
    }
    return ok;
}
int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR commandLine, int show) {
    LPWSTR *argv; int argc; BOOL ok; WSADATA data; (void)instance; (void)previous; (void)commandLine; (void)show;
    h_zero(h_main_error, sizeof(h_main_error)); h_zero(h_exe_path, sizeof(h_exe_path)); GetModuleFileNameW(NULL, h_exe_path, HOST_PATH_CAP);
    cx_options_init(&h_base_options); cx_options_init(&h_cli_options); cx_options_init(&h_config_options); cx_options_init(&h_json_options);
    if (!cx_options_load_default(&h_base_options, h_exe_path, h_main_error, HOST_ERROR_CAP)) return 2;
    argv = CommandLineToArgvW(GetCommandLineW(), &argc); if (!argv) return 2;
    ok = cx_options_parse_cli(&h_cli_options, argc - 1, argv + 1, h_main_error, HOST_ERROR_CAP);
    if (!ok) { if (!h_cli_options.quiet) h_print(h_main_error); LocalFree(argv); return 2; }
    LocalFree(argv);
    if (h_cli_options.configPathSet && !cx_options_load_file(&h_config_options, h_cli_options.configPath, h_main_error, HOST_ERROR_CAP)) { if (!h_cli_options.quiet) h_print(h_main_error); return 2; }
    if (!cx_options_apply_pending_json(&h_json_options, &h_cli_options, h_main_error, HOST_ERROR_CAP)) { if (!h_cli_options.quiet) h_print(h_main_error); return 2; }
    if (!cx_options_merge(&h_base_options, &h_config_options, h_main_error, HOST_ERROR_CAP) || !cx_options_merge(&h_base_options, &h_json_options, h_main_error, HOST_ERROR_CAP) || !cx_options_merge(&h_base_options, &h_cli_options, h_main_error, HOST_ERROR_CAP)) { if (!h_cli_options.quiet) h_print(h_main_error); return 2; }
    if (!cx_options_finalize(&h_base_options, h_main_error, HOST_ERROR_CAP)) { if (!h_cli_options.quiet) h_print(h_main_error); return 2; }
    if (h_base_options.help) {
        h_print_utf8("超星学习助手 Windows 宿主 6.2.0（原生原型）\n"
            "用法: chaoxing_plus.exe [参数]\n"
            "客户端: --client <path> | --client-index <n> | --client-first | --select-client\n"
            "扫描: --scan-mode common|fallback-all|all --list-clients --ui auto|gui|cli\n"
            "  common 只检查常见根目录及一级子目录；fallback-all 仅在常规无结果时递归。\n"
            "配置: --config <path> --options-json <JSON|@file> --print-effective-config\n"
            "面板: --panel|--no-panel --panel-expanded|--panel-collapsed\n"
            "  --panel-top <0-10000> --panel-right <0-10000> --panel-width <320-800>\n"
            "答题: --answer-mode auto|manual --answer-key <shortcut> --answer-threads <1-4>\n"
            "  --show-answer-dialog|--hide-answer-dialog --answer-countdown <sec> --no-auto-submit\n"
            "注入: --inject-strategy runtime|script|hybrid --inject-retries <0-5>\n"
            "  --inject-blank-frames|--no-inject-blank-frames\n"
            "  --debug-timeout <1000-120000 ms> --bundle-timeout <1000-300000 ms>\n"
            "  --target-poll-interval <250-10000 ms> --expected-browser <text> --assets <dir>\n"
            "运行: --execution-mode normal --port <0-65535> --stop-client-on-exit\n"
            "  --data-dir <dir> --log|--no-log --report <path> --quiet\n"
            "  --no-disk-write（同时禁止日志和报告） --duration <ms, 0=不限时>\n"
            "  --capture-console|--no-capture-console（只记录页面错误事件，不保存页面文本）\n"
            "调试: --attach <port>（显式连接已有端口，跳过启动和归属检查，仅供测试）\n"
            "状态: --help --capabilities\n"
            "配置修改: 共享设置同步到已选配置文件并广播；文件热更新保留 CLI/内联 JSON 优先级。\n"
            "  日志/写盘策略与启动选项本轮锁定；渲染诊断尚未接入。\n"
            "内存执行、删除挂起、启动清理和自毁当前会明确拒绝，不会降级执行。\n");
        return 0;
    }
    if (h_base_options.capabilities) {
        if (!cx_asset_validate_embedded(h_main_error, HOST_ERROR_CAP)) { h_print(h_main_error); return 2; }
        h_print_utf8("{\"host\":\"native\",\"executionMode\":\"normal\",\"embeddedResources\":true,\"embeddedResourceCount\":4,"
            "\"nativeSelection\":true,\"contextLifecycle\":true,\"navigation\":true,\"targetReconnect\":true,"
            "\"maxPageSessions\":16,\"configReload\":true,\"configPersistence\":true,\"fileLogging\":true,\"runReport\":true,\"renderDiagnostics\":false,"
            "\"memory\":false,\"deleteSuspend\":false,\"selfDestruct\":false,\"wipe\":false}\n");
        return 0;
    }
    if (h_base_options.printEffectiveConfig) {
        DWORD settingsLength = 0;
        if (!cx_options_effective_settings_json_utf8(&h_base_options, h_settings, sizeof(h_settings), &settingsLength)) return 2;
        h_print_utf8(h_settings); h_print_utf8("\n"); return 0;
    }
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return 2; ok = h_run(&h_base_options, h_main_error, HOST_ERROR_CAP); WSACleanup(); return ok ? h_exit_code : 1;
}

void __stdcall WinMainCRTStartup(void) {
    ExitProcess((UINT)WinMain(GetModuleHandleW(NULL), NULL, NULL, SW_HIDE));
}
