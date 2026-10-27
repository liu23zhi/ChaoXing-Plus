/* Compile the actual host injection code against a deterministic CDP transport. */
#define WinMain HostWinMain
#define WinMainCRTStartup HostMainCRTStartup
#include "../host.c"
#undef WinMain
#undef WinMainCRTStartup

static DWORD calls, failures, failedChecks, ids[32];
static char methods[33];
static char response[256];
static DWORD scriptReplyMode;
static BOOL emitRequest;

static void check(const char *name, BOOL passed) {
    h_print_utf8(passed ? "PASS " : "FAIL ");
    h_print_utf8(name);
    h_print_utf8("\n");
    if (!passed) ++failedChecks;
}

BOOL net_ws_send_text(NET_WS *ws, const char *text, DWORD length, WCHAR *error, DWORD cap) {
    JT tokens[32];
    WCHAR expression[1024];
    DWORD at = 0, n = 0, id, value;
    char digits[16];
    int params, token;
    const char *tail;
    (void)ws; (void)error; (void)cap;
    if (emitRequest) { h_print_utf8(text); h_print_utf8("\n"); }
    if (calls >= 32 || jparse(text, (int)length, tokens, 32) <= 0) return FALSE;
    id = (DWORD)jint(text, tokens, jkey(text, tokens, 0, "id"), -1);
    params = jkey(text, tokens, 0, "params");
    token = jkey(text, tokens, params, "expression");
    if (!emitRequest && !jwstr(text, tokens, token, expression, 1024)) return FALSE;
    ids[calls] = id;
    methods[calls] = !emitRequest && expression[0] == L'(' ? 'S' : 'R';
    methods[++calls] = 0;
    response[at++] = '{'; response[at++] = '"'; response[at++] = 'i';
    response[at++] = 'd'; response[at++] = '"'; response[at++] = ':';
    value = id;
    do { digits[n++] = (char)('0' + value % 10); value /= 10; } while (value);
    while (n) response[at++] = digits[--n];
    tail = calls <= failures ? ",\"error\":{\"message\":\"forced rejection\"}}" : ",\"result\":{\"result\":{\"type\":\"boolean\",\"value\":true}}}";
    if (calls > failures && methods[calls - 1] == 'S') {
        if (scriptReplyMode == 1) tail = ",\"result\":{\"result\":{\"type\":\"boolean\",\"value\":false}}}";
        else if (scriptReplyMode == 2) tail = ",\"result\":{\"result\":{\"type\":\"undefined\"}}}";
        else if (scriptReplyMode == 3) tail = ",\"result\":{\"exceptionDetails\":{\"text\":\"script fixture threw\"}}}";
        else if (scriptReplyMode == 4) tail = ",\"result\":{\"result\":{\"type\":\"string\",\"value\":\"true\"}}}";
    }
    while (*tail) response[at++] = *tail++;
    response[at] = 0;
    return TRUE;
}

int net_ws_read(NET_WS *ws, char **text, DWORD *length, WCHAR *error, DWORD cap) {
    (void)ws; (void)error; (void)cap;
    *length = (DWORD)h_len(response);
    *text = (char *)HeapAlloc(GetProcessHeap(), 0, *length + 1);
    if (!*text) return -1;
    CopyMemory(*text, response, *length + 1);
    return 1;
}

void net_free(void *memory) { HeapFree(GetProcessHeap(), 0, memory); }
NET_WS *net_ws_open(USHORT port, const char *url, WCHAR *error, DWORD cap) {
    (void)port; (void)url; (void)error; (void)cap; return NULL;
}
void net_ws_close(NET_WS *ws) { (void)ws; }
BOOL net_http_get(USHORT port, const char *path, char **body, DWORD *length, WCHAR *error, DWORD cap) {
    (void)port; (void)path; (void)body; (void)length; (void)error; (void)cap; return FALSE;
}

static BOOL run_replies(const WCHAR *strategy, DWORD retries, DWORD failCount, DWORD replyMode, DWORD *nextId) {
    WCHAR error[HOST_ERROR_CAP];
    calls = 0; methods[0] = 0; failures = failCount; scriptReplyMode = replyMode;
    return h_inject_asset(NULL, nextId, strategy, retries, "window.test=1;", 14, error, HOST_ERROR_CAP);
}
static BOOL run(const WCHAR *strategy, DWORD retries, DWORD failCount, DWORD *nextId) {
    return run_replies(strategy, retries, failCount, 0, nextId);
}

static void emit_script_expression(void) {
    int argc, length;
    WCHAR **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    char source[1024];
    WCHAR error[HOST_ERROR_CAP];
    if (!argv || argc < 3) ExitProcess(2);
    length = WideCharToMultiByte(CP_UTF8, 0, argv[2], -1, source, sizeof(source), NULL, NULL);
    LocalFree(argv);
    if (length <= 0) ExitProcess(2);
    emitRequest = TRUE;
    ExitProcess(h_inject_source(NULL, 1, source, (DWORD)length - 1, error, HOST_ERROR_CAP) ? 0 : 1);
}

static void emit_page_setup(void) {
    char *style = NULL, *bootstrap = NULL;
    DWORD styleLength, bootstrapLength, id = 1;
    WCHAR error[HOST_ERROR_CAP];
    BOOL ok;
    cx_options_init(&h_base_options);
    h_base_options.panelEnabled = FALSE;
    h_base_options.panelEnabledSet = TRUE;
    if (!cx_asset_load(L"sweetalert2.min.css", NULL, &style, &styleLength, error, HOST_ERROR_CAP)
        || !cx_asset_load(L"windows-bootstrap.js", NULL, &bootstrap, &bootstrapLength, error, HOST_ERROR_CAP)) ExitProcess(2);
    emitRequest = TRUE;
    ok = h_set_page_config(NULL, &id, &h_base_options, style, styleLength, FALSE, error, HOST_ERROR_CAP)
        && h_inject_runtime(NULL, id, bootstrap, bootstrapLength, error, HOST_ERROR_CAP);
    HeapFree(GetProcessHeap(), 0, style);
    HeapFree(GetProcessHeap(), 0, bootstrap);
    ExitProcess(ok ? 0 : 1);
}

void __stdcall InjectionTestMain(void) {
    DWORD id = 2;
    int argc;
    WCHAR **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    BOOL emit = argv && argc > 1 && lstrcmpW(argv[1], L"--emit-script-expression") == 0;
    BOOL pageSetup = argv && argc > 1 && lstrcmpW(argv[1], L"--emit-page-setup") == 0;
    if (argv) LocalFree(argv);
    if (emit) emit_script_expression();
    if (pageSetup) emit_page_setup();
    check("runtime retries twice then succeeds", run(L"runtime", 2, 2, &id) && calls == 3 && lstrcmpA(methods, "RRR") == 0);
    check("request IDs advance across retries", ids[0] == 2 && ids[1] == 3 && ids[2] == 4 && id == 5);
    check("script falls back to runtime in the same attempt", run(L"script", 2, 1, &id) && calls == 2 && lstrcmpA(methods, "SR") == 0);
    check("next asset does not reuse a prior request ID", ids[0] == 5 && ids[1] == 6 && id == 7);
    check("hybrid retries runtime after both methods fail", run(L"hybrid", 1, 2, &id) && calls == 3 && lstrcmpA(methods, "RSR") == 0);
    check("exhausted retries fail after exactly three attempts", !run(L"hybrid", 2, 32, &id) && calls == 6 && lstrcmpA(methods, "RSRSRS") == 0);
    check("zero retries still allows one fallback attempt", !run(L"script", 0, 32, &id) && calls == 2 && lstrcmpA(methods, "SR") == 0);
    check("success stops retrying immediately", run(L"runtime", 5, 0, &id) && calls == 1);
    check("script false result falls back to runtime", run_replies(L"script", 0, 0, 1, &id) && calls == 2 && lstrcmpA(methods, "SR") == 0);
    check("script missing execution result falls back to runtime", run_replies(L"script", 0, 0, 2, &id) && calls == 2 && lstrcmpA(methods, "SR") == 0);
    check("script exception falls back to runtime", run_replies(L"script", 0, 0, 3, &id) && calls == 2 && lstrcmpA(methods, "SR") == 0);
    check("script string true is not an execution acknowledgement", run_replies(L"script", 0, 0, 4, &id) && calls == 2 && lstrcmpA(methods, "SR") == 0);
    {
        WCHAR error[HOST_ERROR_CAP];
        DWORD before = calls, i;
        char *style = (char *)HeapAlloc(GetProcessHeap(), 0, 1024 * 1024);
        cx_options_init(&h_base_options);
        check("preflight accepts ordinary assets without sending CDP", h_preflight_assets(&h_base_options, 100, 100, "body{}", 6, error, HOST_ERROR_CAP) && calls == before);
        check("oversized bootstrap is rejected before CDP", !h_preflight_assets(&h_base_options, 2UL * 1024 * 1024, 100, "body{}", 6, error, HOST_ERROR_CAP) && calls == before);
        check("oversized bundle is rejected before CDP", !h_preflight_assets(&h_base_options, 100, 2UL * 1024 * 1024, "body{}", 6, error, HOST_ERROR_CAP) && calls == before);
        if (style) for (i = 0; i < 1024 * 1024; ++i) style[i] = 1;
        check("style escaping expansion is preflighted before CDP", style && !h_preflight_assets(&h_base_options, 100, 100, style, 1024 * 1024, error, HOST_ERROR_CAP) && calls == before);
        if (style) HeapFree(GetProcessHeap(), 0, style);
    }
    h_print_utf8(failedChecks ? "NATIVE INJECTION TESTS FAIL\n" : "NATIVE INJECTION TESTS PASS\n");
    ExitProcess(failedChecks ? 1 : 0);
}
