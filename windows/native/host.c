#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <winsock2.h>
#include "options.h"
#include "discovery.h"
#include "process.h"
#include "net.h"
#include "json.h"

#define HOST_PATH_CAP 32768
#define HOST_ERROR_CAP 512
#define HOST_URL_CAP 2048
#define HOST_SOURCE_CAP (8UL * 1024UL * 1024UL)
#define HOST_COMMAND_CAP (8UL * 1024UL * 1024UL)
#define HOST_REPLY_TOKENS 1024

/* Keep the large fixed-size option/path buffers out of the 1 MiB Windows
   thread stack.  The native host deliberately has no CRT startup, so this
   static storage is also deterministic across the x86/x64 launch paths. */
static CX_OPTIONS h_base_options;
static CX_OPTIONS h_cli_options;
static CX_OPTIONS h_config_options;
static CX_OPTIONS h_json_options;
static WCHAR h_main_error[HOST_ERROR_CAP];
static WCHAR h_exe_path[HOST_PATH_CAP];
static char h_settings[CX_OPTIONS_JSON_CAP];

static int h_len(const char *s) { int n = 0; if (s) while (s[n]) ++n; return n; }
static int h_wlen(const WCHAR *s) { int n = 0; if (s) while (s[n]) ++n; return n; }
static void h_zero(void *p, SIZE_T n) { volatile BYTE *b = (volatile BYTE *)p; while (n--) *b++ = 0; }
static BOOL h_copy(WCHAR *out, DWORD cap, const WCHAR *in) {
    DWORD i = 0; if (!out || !cap || !in) return FALSE;
    while (in[i] && i + 1 < cap) { out[i] = in[i]; ++i; }
    out[i] = 0; return in[i] == 0;
}
static BOOL h_append(WCHAR *out, DWORD cap, const WCHAR *in) {
    DWORD at = (DWORD)h_wlen(out), i = 0; if (!out || !in || at >= cap) return FALSE;
    while (in[i] && at + i + 1 < cap) { out[at + i] = in[i]; ++i; }
    out[at + i] = 0; return in[i] == 0;
}
static BOOL h_append_char(WCHAR *out, DWORD cap, WCHAR c) {
    DWORD n = (DWORD)h_wlen(out); if (n + 1 >= cap) return FALSE; out[n] = c; out[n + 1] = 0; return TRUE;
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
static BOOL h_append_bytes(char *out, DWORD cap, DWORD *at, const char *text, DWORD length) {
    if (!out || !at || !text || *at >= cap || length >= cap - *at) return FALSE;
    CopyMemory(out + *at, text, length); *at += length; out[*at] = 0; return TRUE;
}
static BOOL h_file_read(const WCHAR *path, char **data, DWORD *length, WCHAR *error, DWORD cap) {
    HANDLE f; DWORD size, got; char *buf;
    if (!path || !data || !length) return FALSE;
    *data = NULL; *length = 0;
    f = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) { h_error(error, cap, L"cannot open native asset"); return FALSE; }
    size = GetFileSize(f, NULL);
    if (size == INVALID_FILE_SIZE || size >= HOST_SOURCE_CAP) { CloseHandle(f); h_error(error, cap, L"native asset is too large"); return FALSE; }
    buf = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)size + 1);
    if (!buf) { CloseHandle(f); h_error(error, cap, L"out of memory reading native asset"); return FALSE; }
    got = 0;
    if (!ReadFile(f, buf, size, &got, NULL) || got != size) { HeapFree(GetProcessHeap(), 0, buf); CloseHandle(f); h_error(error, cap, L"cannot read native asset"); return FALSE; }
    CloseHandle(f); buf[size] = 0; *data = buf; *length = size; return TRUE;
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
static BOOL h_make_path(WCHAR *out, DWORD cap, const WCHAR *dir, const WCHAR *name) {
    if (!h_copy(out, cap, dir)) return FALSE;
    if (out[h_wlen(out) - 1] != L'\\') if (!h_append_char(out, cap, L'\\')) return FALSE;
    return h_append(out, cap, name);
}
static BOOL h_find_websocket(const char *body, DWORD length, char *url, DWORD cap) {
    const char key[] = "\"webSocketDebuggerUrl\""; DWORD i, start, end, k = 0;
    if (!body || !url || cap < 2) return FALSE;
    for (i = 0; i + sizeof(key) - 1 <= length; ++i) { k = 0; while (key[k] && body[i + k] == key[k]) ++k; if (!key[k]) break; }
    if (i + k >= length) return FALSE;
    i += k; while (i < length && body[i] != ':') ++i; if (i >= length) return FALSE; ++i;
    while (i < length && (body[i] == ' ' || body[i] == '\t')) ++i; if (i >= length || body[i++] != '"') return FALSE;
    start = i; while (i < length && body[i] != '"') { if (body[i] == '\\') return FALSE; ++i; }
    end = i; if (i >= length || end <= start || end - start + 1 > cap) return FALSE;
    for (i = start; i < end; ++i) url[i - start] = body[i]; url[end - start] = 0; return TRUE;
}
static BOOL h_send_eval(NET_WS *ws, DWORD id, const char *expression, DWORD expressionLength, WCHAR *error, DWORD errorCap) {
    char *command, *reply = NULL; JT *tokens; DWORD at = 0, replyLength = 0, commandCap, deadline; int readResult, count, idToken, resultToken, exceptionToken; char idText[16]; DWORD n = 0; unsigned int v = id;
    if (!expression || expressionLength > (HOST_COMMAND_CAP - 1024UL) / 6UL) { h_error(error, errorCap, L"CDP expression exceeds native limit"); return FALSE; }
    commandCap = expressionLength * 6UL + 1024UL;
    if (commandCap > HOST_COMMAND_CAP) commandCap = HOST_COMMAND_CAP;
    command = (char *)HeapAlloc(GetProcessHeap(), 0, commandCap); if (!command) { h_error(error, errorCap, L"out of memory building CDP command"); return FALSE; }
    command[at++] = '{'; command[at++] = '"'; command[at++] = 'i'; command[at++] = 'd'; command[at++] = '"'; command[at++] = ':';
    do { idText[n++] = (char)('0' + v % 10U); v /= 10U; } while (v); while (n) command[at++] = idText[--n];
    { const char prefix[] = ",\"method\":\"Runtime.evaluate\",\"params\":{\"expression\":"; if (!h_append_bytes(command, commandCap, &at, prefix, sizeof(prefix) - 1)) goto command_error; }
    if (!h_json_quote(command, commandCap, &at, expression, expressionLength)) goto command_error;
    { const char suffix[] = ",\"returnByValue\":true}}"; if (!h_append_bytes(command, commandCap, &at, suffix, sizeof(suffix) - 1)) goto command_error; }
    if (!net_ws_send_text(ws, command, at, error, errorCap)) { HeapFree(GetProcessHeap(), 0, command); return FALSE; }
    HeapFree(GetProcessHeap(), 0, command);
    tokens = (JT *)HeapAlloc(GetProcessHeap(), 0, sizeof(JT) * HOST_REPLY_TOKENS);
    if (!tokens) { h_error(error, errorCap, L"out of memory parsing CDP response"); return FALSE; }
    deadline = GetTickCount() + 10000UL;
    for (;;) {
        readResult = net_ws_read(ws, &reply, &replyLength, error, errorCap);
        if (readResult < 0) { HeapFree(GetProcessHeap(), 0, tokens); return FALSE; }
        if (readResult == 0) { if ((LONG)(GetTickCount() - deadline) >= 0) { h_error(error, errorCap, L"timed out waiting for CDP Runtime.evaluate response"); HeapFree(GetProcessHeap(), 0, tokens); return FALSE; } continue; }
        count = jparse(reply, (int)replyLength, tokens, HOST_REPLY_TOKENS);
        idToken = count > 0 ? jkey(reply, tokens, 0, "id") : -1;
        if (idToken < 0 || (DWORD)jint(reply, tokens, idToken, -1) != id) { net_free(reply); reply = NULL; continue; }
        resultToken = jkey(reply, tokens, 0, "result");
        exceptionToken = resultToken >= 0 ? jkey(reply, tokens, resultToken, "exceptionDetails") : -1;
        if (jkey(reply, tokens, 0, "error") >= 0 || exceptionToken >= 0 || resultToken < 0) { h_error(error, errorCap, L"CDP Runtime.evaluate returned an exception"); net_free(reply); HeapFree(GetProcessHeap(), 0, tokens); return FALSE; }
        net_free(reply); HeapFree(GetProcessHeap(), 0, tokens); return TRUE;
    }
command_error:
    HeapFree(GetProcessHeap(), 0, command); h_error(error, errorCap, L"CDP command exceeds native limit"); return FALSE;
}
static BOOL h_inject_source(NET_WS *ws, DWORD id, const char *source, DWORD length, WCHAR *error, DWORD errorCap) {
    static const char pre[] = "(function(){var s=document.createElement('script');s.textContent=";
    static const char post[] = ";var p=document.head||document.documentElement||document.body;if(!p){return false;}p.appendChild(s);if(s.parentNode){s.parentNode.removeChild(s);}return true;})()";
    DWORD preLength = sizeof(pre) - 1, postLength = sizeof(post) - 1, total; char *expr; DWORD at = 0; BOOL ok;
    if (length > (HOST_COMMAND_CAP - preLength - postLength - 2) / 6UL) { h_error(error, errorCap, L"injection source is too large"); return FALSE; }
    total = preLength + postLength + length * 6UL + 2;
    expr = (char *)HeapAlloc(GetProcessHeap(), 0, total); if (!expr) { h_error(error, errorCap, L"out of memory building injection"); return FALSE; }
    while (at < preLength) { expr[at] = pre[at]; ++at; }
    if (!h_json_quote(expr, total, &at, source, length)) { HeapFree(GetProcessHeap(), 0, expr); h_error(error, errorCap, L"injection source is too large"); return FALSE; }
    { DWORD i = 0; while (i < postLength) expr[at++] = post[i++]; }
    expr[at] = 0; ok = h_send_eval(ws, id, expr, at, error, errorCap); HeapFree(GetProcessHeap(), 0, expr); return ok;
}
static BOOL h_inject_runtime(NET_WS *ws, DWORD id, const char *source, DWORD length, WCHAR *error, DWORD errorCap) {
    return h_send_eval(ws, id, source, length, error, errorCap);
}
static BOOL h_inject_asset(NET_WS *ws, DWORD id, const WCHAR *strategy, const char *source, DWORD length, WCHAR *error, DWORD errorCap) {
    WCHAR firstError[HOST_ERROR_CAP];
    if (h_equal(strategy ? strategy : L"hybrid", L"runtime")) return h_inject_runtime(ws, id, source, length, error, errorCap);
    if (h_equal(strategy ? strategy : L"hybrid", L"script")) {
        if (h_inject_source(ws, id, source, length, error, errorCap)) return TRUE;
        h_copy(firstError, HOST_ERROR_CAP, error);
        return h_inject_runtime(ws, id + 1000, source, length, error, errorCap) || (h_error(error, errorCap, firstError), FALSE);
    }
    if (h_inject_runtime(ws, id, source, length, error, errorCap)) return TRUE;
    h_copy(firstError, HOST_ERROR_CAP, error);
    if (h_inject_source(ws, id + 1000, source, length, error, errorCap)) return TRUE;
    h_copy(error, errorCap, firstError);
    return FALSE;
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
static BOOL h_run(CX_OPTIONS *options, const WCHAR *exePath, WCHAR *error, DWORD errorCap) {
    CX_DISCOVERY_OPTIONS discover; CX_DISCOVERY_RESULT result; DWORD index, pid = 0; HANDLE client = NULL; USHORT port; char *body = NULL, *bootstrap = NULL, *bundle = NULL, *config = NULL; DWORD bodyLength, bootstrapLength, bundleLength, configLength; char url[HOST_URL_CAP]; NET_WS *ws = NULL; WCHAR *assetDir = NULL, *path = NULL; BOOL ok = FALSE, ownerReady = FALSE; int i;
    assetDir = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)HOST_PATH_CAP * sizeof(WCHAR));
    path = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)HOST_PATH_CAP * sizeof(WCHAR));
    if (!assetDir || !path) { h_error(error, errorCap, L"out of memory allocating native paths"); goto done; }
    h_zero(&discover, sizeof(discover)); h_zero(&result, sizeof(result)); h_zero(url, sizeof(url)); cx_discovery_init(&result);
    discover.mode = h_equal(options->scanMode, L"common") ? CX_DISCOVERY_SCAN_COMMON : (h_equal(options->scanMode, L"all") ? CX_DISCOVERY_SCAN_ALL : CX_DISCOVERY_SCAN_FALLBACK_ALL);
    discover.clientPath = options->clientPathSet ? options->clientPath : NULL; discover.hostIs32Bit = FALSE;
    discover.enumerateAll = options->listClients || options->selectClient || options->clientIndexSet;
    if (!cx_discovery_scan(&discover, &result, error, errorCap)) goto done;
    if (!result.count) goto done;
    index = result.recommendedIndex;
    if (options->clientIndexSet) { if ((DWORD)options->clientIndex < 1 || (DWORD)options->clientIndex > result.count) { h_error(error, errorCap, L"client-index is outside the discovered candidate list"); goto done; } index = (DWORD)options->clientIndex - 1; }
    if (options->listClients) { for (i = 0; i < (int)result.count; ++i) { h_print(result.items[i].path); h_print(L"\r\n"); } ok = TRUE; goto done; }
    if (!h_choose_port(options, &port)) { h_error(error, errorCap, L"no usable loopback CDP port"); goto done; }
    if (!proc_launch(result.items[index].path, port, &pid, &client, error, errorCap)) goto done;
    for (i = 0; i < 60 && proc_alive(pid); ++i) {
        DWORD owner = 0;
        if (proc_port_owner(port, pid, &owner, error, errorCap) && owner == pid) ownerReady = TRUE;
        if (ownerReady && net_http_get(port, "/json/list", &body, &bodyLength, error, errorCap) && h_find_websocket(body, bodyLength, url, sizeof(url))) break;
        if (body) { net_free(body); body = NULL; }
        Sleep(500);
    }
    if (!url[0]) { h_error(error, errorCap, L"CXExam CDP endpoint did not become ready"); goto done; }
    ws = net_ws_open(port, url, error, errorCap); if (!ws) { goto done; }
    config = (char *)HeapAlloc(GetProcessHeap(), 0, CX_OPTIONS_JSON_CAP); if (!config || !cx_options_effective_settings_json_utf8(options, config, CX_OPTIONS_JSON_CAP, &configLength)) { h_error(error, errorCap, L"cannot serialize native settings"); goto done; }
    { const char pre[] = "window.__CX_WIN_CONFIG_JSON__="; const char mid[] = ";window.__CX_WIN_INSTANCE__=\"native\";true;"; DWORD total = sizeof(pre)-1 + configLength + sizeof(mid)-1; char *expr = (char *)HeapAlloc(GetProcessHeap(), 0, total + 1); DWORD at = 0, j = 0; if (!expr) { h_error(error, errorCap, L"out of memory setting native config"); goto done; } while (j < sizeof(pre)-1) expr[at++] = pre[j++]; for (j=0;j<configLength;j++) expr[at++] = config[j]; j=0; while(j<sizeof(mid)-1) expr[at++]=mid[j++]; expr[at]=0; if (!h_send_eval(ws, 1, expr, at, error, errorCap)) { HeapFree(GetProcessHeap(),0,expr); goto done; } HeapFree(GetProcessHeap(),0,expr); }
    if (!h_copy(assetDir, HOST_PATH_CAP, options->assetsDirSet ? options->assetsDir : exePath)) goto done;
    if (options->assetsDirSet) { /* caller supplied a directory */ } else { WCHAR *slash = assetDir + h_wlen(assetDir); while (slash > assetDir && slash[-1] != L'\\' && slash[-1] != L'/') --slash; *slash = 0; }
    if (!h_make_path(path, HOST_PATH_CAP, assetDir, L"windows-bootstrap.js") || !h_file_read(path, &bootstrap, &bootstrapLength, error, errorCap)) goto done;
    if (!h_make_path(path, HOST_PATH_CAP, assetDir, L"chaoxing-plus.windows.js") || !h_file_read(path, &bundle, &bundleLength, error, errorCap)) goto done;
    if (!h_inject_asset(ws, 2, options->injectStrategy, bootstrap, bootstrapLength, error, errorCap) || !h_inject_asset(ws, 3, options->injectStrategy, bundle, bundleLength, error, errorCap)) goto done;
    ok = TRUE;
done:
    if (!ok && !options->quiet) h_print(error[0] ? error : L"native host failed");
    if (body) net_free(body); if (bootstrap) HeapFree(GetProcessHeap(), 0, bootstrap); if (bundle) HeapFree(GetProcessHeap(), 0, bundle); if (config) HeapFree(GetProcessHeap(), 0, config); if (ws) net_ws_close(ws);
    if (client) {
        if (ok) WaitForSingleObject(client, INFINITE);
        else { proc_stop_owned(pid); WaitForSingleObject(client, 5000); }
        CloseHandle(client); if (ok) proc_stop_owned(pid);
    }
    if (assetDir) HeapFree(GetProcessHeap(), 0, assetDir); if (path) HeapFree(GetProcessHeap(), 0, path);
    cx_discovery_free(&result); return ok;
}
int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR commandLine, int show) {
    LPWSTR *argv; int argc; BOOL ok; WSADATA data; (void)instance; (void)previous; (void)commandLine; (void)show;
    h_zero(h_main_error, sizeof(h_main_error)); h_zero(h_exe_path, sizeof(h_exe_path)); GetModuleFileNameW(NULL, h_exe_path, HOST_PATH_CAP);
    cx_options_init(&h_base_options); cx_options_init(&h_cli_options); cx_options_init(&h_config_options); cx_options_init(&h_json_options);
    if (!cx_options_load_default(&h_base_options, h_exe_path, h_main_error, HOST_ERROR_CAP)) return 2;
    argv = CommandLineToArgvW(GetCommandLineW(), &argc); if (!argv) return 2;
    ok = cx_options_parse_cli(&h_cli_options, argc - 1, argv + 1, h_main_error, HOST_ERROR_CAP);
    if (!ok) return 2;
    if (h_cli_options.configPathSet && !cx_options_load_file(&h_config_options, h_cli_options.configPath, h_main_error, HOST_ERROR_CAP)) { if (!h_cli_options.quiet) h_print(h_main_error); return 2; }
    if (!cx_options_apply_pending_json(&h_json_options, &h_cli_options, h_main_error, HOST_ERROR_CAP)) { if (!h_cli_options.quiet) h_print(h_main_error); return 2; }
    if (!cx_options_merge(&h_base_options, &h_config_options, h_main_error, HOST_ERROR_CAP) || !cx_options_merge(&h_base_options, &h_json_options, h_main_error, HOST_ERROR_CAP) || !cx_options_merge(&h_base_options, &h_cli_options, h_main_error, HOST_ERROR_CAP)) { if (!h_cli_options.quiet) h_print(h_main_error); return 2; }
    if (!cx_options_finalize(&h_base_options, h_main_error, HOST_ERROR_CAP)) { if (!h_cli_options.quiet) h_print(h_main_error); return 2; }
    if (h_base_options.help) {
        h_print_utf8("chaoxing_plus native host\n");
        return 0;
    }
    if (h_base_options.capabilities) {
        h_print_utf8("{\"host\":\"native\",\"executionMode\":\"normal\",\"memory\":false,\"deleteSuspend\":false,\"selfDestruct\":false,\"wipe\":false}\n");
        return 0;
    }
    if (h_base_options.printEffectiveConfig) {
        DWORD settingsLength = 0;
        if (!cx_options_effective_settings_json_utf8(&h_base_options, h_settings, sizeof(h_settings), &settingsLength)) return 2;
        h_print_utf8(h_settings); h_print_utf8("\n"); return 0;
    }
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return 2; ok = h_run(&h_base_options, h_exe_path, h_main_error, HOST_ERROR_CAP); WSACleanup(); return ok ? 0 : 1;
}

void __stdcall WinMainCRTStartup(void) {
    ExitProcess((UINT)WinMain(GetModuleHandleW(NULL), NULL, NULL, SW_HIDE));
}
