/* Compile the actual host injection code against a deterministic CDP transport. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
DWORD WINAPI test_tick_count(void);
#define GetTickCount test_tick_count
#define proc_port_owner test_port_owner
#define proc_alive test_proc_alive
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
static BOOL targetFixture, ownerAllowed, mockClientAlive;
static DWORD ownerChecks, httpCalls, openCalls, closeCalls, fakeTick;
static DWORD cancelReadMode;
static BOOL multipleTargets;

DWORD WINAPI test_tick_count(void) { return fakeTick; }
BOOL test_proc_alive(DWORD pid) { (void)pid; return mockClientAlive; }
BOOL test_port_owner(USHORT port, DWORD rootPid, DWORD *owner, WCHAR *error, DWORD cap) {
    (void)port; (void)rootPid;
    ++ownerChecks;
    *owner = ownerAllowed ? 123 : 0;
    if (!ownerAllowed) h_error(error, cap, L"fixture listener ownership changed");
    return ownerAllowed;
}

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
    if (!emitRequest && !targetFixture && !jwstr(text, tokens, token, expression, 1024)) return FALSE;
    ids[calls] = id;
    methods[calls] = !emitRequest && !targetFixture && expression[0] == L'(' ? 'S' : 'R';
    methods[++calls] = 0;
    response[at++] = '{'; response[at++] = '"'; response[at++] = 'i';
    response[at++] = 'd'; response[at++] = '"'; response[at++] = ':';
    value = id;
    do { digits[n++] = (char)('0' + value % 10); value /= 10; } while (value);
    while (n) response[at++] = digits[--n];
    tail = calls <= failures ? ",\"error\":{\"message\":\"forced rejection\"}}" : ",\"result\":{\"result\":{\"type\":\"boolean\",\"value\":true}}}";
    if (targetFixture) {
        tail = jeq(text, tokens, jkey(text, tokens, 0, "method"), "Page.getFrameTree")
            ? ",\"result\":{\"frameTree\":{\"frame\":{\"id\":\"top\",\"url\":\"https://a.chaoxing.com/exam-ans/\"}}}}"
            : ",\"result\":{}}";
    }
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
int net_ws_read_timeout(NET_WS *ws, char **text, DWORD *length, DWORD timeout, WCHAR *error, DWORD cap) {
    if (cancelReadMode && ((cancelReadMode <= 2 && timeout) || (cancelReadMode > 2 && !timeout))) {
        if (cancelReadMode & 1) fakeTick = h_started + h_duration;
        else mockClientAlive = FALSE;
        return timeout ? 0 : -1;
    }
    return net_ws_read(ws, text, length, error, cap);
}

void net_free(void *memory) { HeapFree(GetProcessHeap(), 0, memory); }
NET_WS *net_ws_open(USHORT port, const char *url, WCHAR *error, DWORD cap) {
    (void)port; (void)url; (void)error; (void)cap;
    ++openCalls;
    return targetFixture ? (NET_WS *)1 : NULL;
}
void net_ws_close(NET_WS *ws) { (void)ws; ++closeCalls; }
BOOL net_http_get(USHORT port, const char *path, char **body, DWORD *length, WCHAR *error, DWORD cap) {
    const char *fixture = lstrcmpA(path, "/json/version") == 0 ? "{\"Browser\":\"Chrome/75.0.3770.100\"}"
        : multipleTargets
            ? "[{\"id\":\"first-page\",\"type\":\"page\",\"url\":\"https://a.chaoxing.com/exam-ans/\",\"webSocketDebuggerUrl\":\"ws://127.0.0.1:38100/devtools/page/first\"},{\"id\":\"second-page\",\"type\":\"page\",\"url\":\"https://a.chaoxing.com/exam-ans/\",\"webSocketDebuggerUrl\":\"ws://127.0.0.1:38100/devtools/page/second\"}]"
            : "[{\"id\":\"owned-page\",\"type\":\"page\",\"url\":\"https://a.chaoxing.com/exam-ans/\",\"webSocketDebuggerUrl\":\"ws://127.0.0.1:38100/devtools/page/owned-page\"}]";
    (void)port; (void)error; (void)cap;
    ++httpCalls;
    if (!targetFixture) return FALSE;
    *length = (DWORD)h_len(fixture);
    *body = (char *)HeapAlloc(GetProcessHeap(), 0, *length + 1);
    if (!*body) return FALSE;
    CopyMemory(*body, fixture, *length + 1);
    return TRUE;
}

static void prepare_stop_fixture(DWORD mode) {
    cx_options_init(&h_base_options);
    h_base_options.quiet = TRUE;
    targetFixture = TRUE; ownerAllowed = TRUE; mockClientAlive = TRUE;
    ownerChecks = httpCalls = openCalls = closeCalls = calls = failures = 0;
    h_zero(&h_report, sizeof(h_report));
    h_client_pid = 123; h_started = 1000; h_duration = 100; fakeTick = 1000;
    h_current_page = NULL; h_task_pending = FALSE; h_current_context = 0;
    cancelReadMode = mode; multipleTargets = FALSE;
}

static void test_normal_stop_cancellation(void) {
    const char created[] = "{\"method\":\"Runtime.executionContextCreated\",\"params\":{\"context\":{\"id\":1,\"origin\":\"https://a.chaoxing.com\",\"auxData\":{\"isDefault\":true,\"frameId\":\"top\"}}}}";
    H_NATIVE_PAGE *pages;
    WCHAR error[HOST_ERROR_CAP];
    DWORD mode;
    BOOL pumped, watched;
    for (mode = 1; mode <= 2; ++mode) {
        prepare_stop_fixture(mode);
        pages = (H_NATIVE_PAGE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(H_NATIVE_PAGE) * HOST_MAX_PAGES);
        if (!pages) { check("stop fixture allocation", FALSE); return; }
        pages[0].state = cx_session_create("https://a.chaoxing.com/exam-ans/", TRUE, TRUE);
        if (!pages[0].state) { HeapFree(GetProcessHeap(), 0, pages); check("stop session allocation", FALSE); return; }
        pages[0].ws = (NET_WS *)1; pages[0].nextId = 1;
        cx_session_feed(pages[0].state, created, sizeof(created) - 1);
        pumped = h_page_pump(&pages[0], &h_base_options, "true;", 5, "true;", 5, "body{}", 6, error, HOST_ERROR_CAP);
        check(mode == 1 ? "duration cancellation does not count an injection error" : "client exit cancellation does not count an injection error",
            pumped && calls == 1 && cx_session_stats(pages[0].state)->errors == 0 && h_report.errors == 0 && !h_task_pending);
        h_page_close(&pages[0]); HeapFree(GetProcessHeap(), 0, pages);

        prepare_stop_fixture(mode); multipleTargets = TRUE;
        pages = (H_NATIVE_PAGE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(H_NATIVE_PAGE) * HOST_MAX_PAGES);
        if (!pages) { check("cancelled targets allocation", FALSE); return; }
        h_targets_refresh(pages, 38100, &h_base_options, "true;", 5, error, HOST_ERROR_CAP);
        check(mode == 1 ? "duration cancellation stops target opens without errors or retries" : "client exit cancellation stops target opens without errors or retries",
            openCalls == 1 && calls == 1 && h_report.errors == 0 && !pages[0].retryAt && !pages[1].retryAt);
        h_page_close(&pages[0]); h_page_close(&pages[1]); HeapFree(GetProcessHeap(), 0, pages);
    }
    for (mode = 3; mode <= 4; ++mode) {
        prepare_stop_fixture(mode); h_base_options.extensionEnabled = FALSE;
        watched = h_watch_targets(38100, &h_base_options, "true;", 5, "true;", 5, "body{}", 6, "true;", 5, error, HOST_ERROR_CAP);
        check(mode == 3 ? "duration read closure does not count a transport error" : "client exit read closure does not count a transport error",
            watched && h_report.errors == 0 && openCalls == 1 && closeCalls == 1);
    }
    cancelReadMode = 0; multipleTargets = FALSE; targetFixture = FALSE;
    h_client_pid = 0; h_duration = 0; h_current_page = NULL; h_task_pending = FALSE;
}

static void test_owned_target_refresh(void) {
    H_NATIVE_PAGE *pages = (H_NATIVE_PAGE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(H_NATIVE_PAGE) * HOST_MAX_PAGES);
    WCHAR error[HOST_ERROR_CAP];
    DWORD beforeHttp, beforeOpen, beforeClose, beforeOwner;
    BOOL refreshed;
    if (!pages) { check("ownership fixture allocation", FALSE); return; }
    cx_options_init(&h_base_options);
    h_base_options.quiet = TRUE;
    targetFixture = TRUE; ownerAllowed = TRUE; mockClientAlive = TRUE;
    ownerChecks = httpCalls = openCalls = closeCalls = calls = failures = 0;
    h_client_pid = 123; h_duration = 0; h_task_pending = FALSE; fakeTick = 1000;
    refreshed = h_targets_refresh(pages, 38100, &h_base_options, "true;", 5, error, HOST_ERROR_CAP);
    check("initial verified ownership opens the target", refreshed && httpCalls == 1 && openCalls == 1 && pages[0].ws != NULL);
    check("target discovery and opening each verify ownership", ownerChecks >= 2);
    beforeHttp = httpCalls; beforeOpen = openCalls; beforeClose = closeCalls;
    ownerAllowed = FALSE;
    refreshed = h_targets_refresh(pages, 38100, &h_base_options, "true;", 5, error, HOST_ERROR_CAP);
    check("ownership change rejects refresh before any HTTP or WS", !refreshed && httpCalls == beforeHttp && openCalls == beforeOpen);
    check("ownership change closes the previous page session", pages[0].ws == NULL && pages[0].state == NULL && closeCalls == beforeClose + 1);
    h_page_close(&pages[0]);
    h_zero(&pages[0], sizeof(pages[0]));
    beforeOpen = openCalls;
    check("direct page reconnect rejects changed ownership before WS", !h_page_open(&pages[0], 38100, &h_base_options, "true;", 5, error, HOST_ERROR_CAP) && openCalls == beforeOpen);
    h_page_close(&pages[0]);
    h_zero(&pages[0], sizeof(pages[0]));
    h_client_pid = 0; h_base_options.attachPortSet = TRUE;
    beforeOwner = ownerChecks; beforeOpen = openCalls;
    refreshed = h_targets_refresh(pages, 38100, &h_base_options, "true;", 5, error, HOST_ERROR_CAP);
    check("explicit attach mode permits the debug ownership exception", refreshed && ownerChecks == beforeOwner && openCalls == beforeOpen + 1 && pages[0].ws != NULL);
    h_page_close(&pages[0]);
    h_zero(&pages[0], sizeof(pages[0]));
    h_client_pid = 123; h_base_options.attachPortSet = FALSE; ownerAllowed = TRUE;
    fakeTick = 0x90000000UL; beforeOpen = openCalls;
    refreshed = h_targets_refresh(pages, 38100, &h_base_options, "true;", 5, error, HOST_ERROR_CAP);
    check("zero retry deadline allows first connection with high TickCount", refreshed && openCalls == beforeOpen + 1 && pages[0].ws != NULL);
    h_page_close(&pages[0]);
    HeapFree(GetProcessHeap(), 0, pages);
    targetFixture = FALSE; h_client_pid = 0; h_current_page = NULL; h_task_pending = FALSE;
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
    test_owned_target_refresh();
    test_normal_stop_cancellation();
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
