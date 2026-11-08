/* Compile the actual host injection code against a deterministic CDP transport. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
DWORD WINAPI test_tick_count(void);
#define GetTickCount test_tick_count
#define proc_port_owner test_port_owner
#define proc_port_owner_ex test_port_owner_ex
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
static DWORD httpBudget, httpAdvance;
static BOOL httpExitClient;
static DWORD openBudget, openAdvance;
static BOOL openExitClient;
static DWORD cancelReadMode;
static BOOL multipleTargets;
static CX_PORT_OWNER_REASON mockOwnerReason;
static const char *mockVersion;

DWORD WINAPI test_tick_count(void) { return fakeTick; }
BOOL test_proc_alive(DWORD pid) { (void)pid; return mockClientAlive; }
BOOL test_port_owner(USHORT port, DWORD rootPid, DWORD *owner, WCHAR *error, DWORD cap) {
    (void)port; (void)rootPid;
    ++ownerChecks;
    *owner = ownerAllowed ? 123 : 0;
    if (!ownerAllowed) h_error(error, cap, L"fixture listener ownership changed");
    return ownerAllowed;
}
BOOL test_port_owner_ex(USHORT port, DWORD rootPid, DWORD *owner, CX_PORT_OWNER_REASON *reason, WCHAR *error, DWORD cap) {
    BOOL ok = test_port_owner(port, rootPid, owner, error, cap);
    if (reason) *reason = ok ? CX_PORT_OWNER_VERIFIED : mockOwnerReason;
    /* Simulate elapsed work without sleeping in the deterministic endpoint loop. */
    if (!ok) fakeTick += 1000;
    return ok;
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

static BOOL transportErrorMode;
int net_ws_read(NET_WS *ws, char **text, DWORD *length, WCHAR *error, DWORD cap) {
    (void)ws; (void)error; (void)cap;
    if (transportErrorMode) { *text = NULL; *length = 0; return -1; }
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
    fakeTick += openAdvance;
    if (openExitClient) mockClientAlive = FALSE;
    return targetFixture ? (NET_WS *)1 : NULL;
}
NET_WS *net_ws_open_timeout(USHORT port, const char *url, DWORD timeoutMs, WCHAR *error, DWORD cap) {
    openBudget = timeoutMs;
    return net_ws_open(port, url, error, cap);
}
void net_ws_close(NET_WS *ws) { (void)ws; ++closeCalls; }
BOOL net_http_get(USHORT port, const char *path, char **body, DWORD *length, WCHAR *error, DWORD cap) {
    const char *fixture = lstrcmpA(path, "/json/version") == 0 ? (mockVersion ? mockVersion : "{\"Browser\":\"Chrome/75.0.3770.100\"}")
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
BOOL net_http_get_timeout(USHORT port, const char *path, char **body, DWORD *length,
                          DWORD timeoutMs, WCHAR *error, DWORD cap) {
    BOOL ok;
    httpBudget = timeoutMs;
    ok = net_http_get(port, path, body, length, error, cap);
    fakeTick += httpAdvance;
    if (httpExitClient) mockClientAlive = FALSE;
    return ok;
}

static void test_http_deadline_budget(void) {
    WCHAR error[HOST_ERROR_CAP];
    char *body = NULL;
    DWORD length = 0;
    BOOL ok;
    targetFixture = TRUE; mockClientAlive = TRUE; ownerAllowed = TRUE;
    h_client_pid = 123; h_current_page = NULL; h_task_pending = FALSE;
    h_started = 1000; h_duration = 100; fakeTick = 1050;
    httpCalls = httpBudget = httpAdvance = 0; httpExitClient = FALSE;
    ok = h_http_get(38100, "/json/version", 5000, &body, &length, error, HOST_ERROR_CAP);
    check("HTTP transport receives only the remaining run budget", ok && httpBudget == 50 && body != NULL);
    net_free(body); body = NULL; length = 0;
    httpAdvance = 50;
    ok = h_http_get(38100, "/json/version", 5000, &body, &length, error, HOST_ERROR_CAP);
    check("late HTTP response is discarded at the run deadline", !ok && !body && !length);
    httpCalls = 0;
    ok = h_http_get(38100, "/json/version", 5000, &body, &length, error, HOST_ERROR_CAP);
    check("expired run budget performs no HTTP request", !ok && httpCalls == 0);
    cx_options_init(&h_base_options); h_base_options.debugTimeoutMs = 1000;
    h_started = fakeTick = 1000; h_duration = 5000;
    httpCalls = 0; httpAdvance = 1000;
    ok = h_watch_targets(38100, &h_base_options, "true;", 5, "true;", 5, "body{}", 6, "true;", 5, error, HOST_ERROR_CAP);
    check("late version response cannot pass the endpoint deadline", !ok && httpCalls == 1 && httpBudget == 1000
        && lstrcmpA(h_report.stopReason, "endpoint-unavailable") == 0);
    h_started = fakeTick = 1000; h_duration = 50;
    httpCalls = 0; httpAdvance = 50;
    ok = h_watch_targets(38100, &h_base_options, "true;", 5, "true;", 5, "body{}", 6, "true;", 5, error, HOST_ERROR_CAP);
    check("run expiry before endpoint has a distinct stop reason", !ok && httpCalls == 1 && httpBudget == 50
        && lstrcmpA(h_report.stopReason, "duration-before-endpoint") == 0);
    h_started = fakeTick = 1000; h_duration = 5000; mockClientAlive = TRUE;
    httpCalls = 0; httpAdvance = 0; httpExitClient = TRUE;
    ok = h_watch_targets(38100, &h_base_options, "true;", 5, "true;", 5, "body{}", 6, "true;", 5, error, HOST_ERROR_CAP);
    check("owned client exit before endpoint is not reported as timeout", !ok && httpCalls == 1
        && lstrcmpA(h_report.stopReason, "client-exit-before-endpoint") == 0);
    httpExitClient = FALSE; mockClientAlive = TRUE;
    httpAdvance = 0; targetFixture = FALSE; h_client_pid = 0; h_duration = 0;
}

static void test_endpoint_probe(void) {
    WCHAR error[HOST_ERROR_CAP];
    DWORD i;
    BOOL ok;
    const CX_PORT_OWNER_REASON ownerReasons[] = { CX_PORT_OWNER_NO_LISTENER, CX_PORT_OWNER_NOT_OWNED,
        CX_PORT_OWNER_QUERY_FAILED, CX_PORT_OWNER_BINDING_REJECTED };
    const CX_ENDPOINT_REASON expected[] = { CX_ENDPOINT_NO_LISTENER, CX_ENDPOINT_LISTENER_NOT_OWNED,
        CX_ENDPOINT_LISTENER_QUERY_FAILED, CX_ENDPOINT_LISTENER_BINDING_REJECTED };
    const char *names[] = { "endpoint probe distinguishes no listener", "endpoint probe distinguishes foreign ownership",
        "endpoint probe distinguishes listener query failure", "endpoint probe distinguishes rejected binding" };
    cx_options_init(&h_base_options); h_base_options.quiet = TRUE; h_base_options.debugTimeoutMs = 1000;
    targetFixture = TRUE; mockClientAlive = TRUE; h_client_pid = 123;
    h_current_page = NULL; h_task_pending = FALSE; h_duration = 0;
    ownerAllowed = FALSE;
    for (i = 0; i < 4; ++i) {
        h_zero(&h_report, sizeof(h_report)); fakeTick = h_started = 1000;
        httpCalls = openCalls = ownerChecks = 0; mockOwnerReason = ownerReasons[i];
        ok = h_watch_targets(38100, &h_base_options, "true;", 5, "true;", 5, "body{}", 6, "true;", 5, error, HOST_ERROR_CAP);
        check(names[i], !ok && !httpCalls && !openCalls && ownerChecks == 1
            && h_report.endpointProbe.attempts == 1 && h_report.endpointProbe.lastReason == expected[i]
            && h_report.endpointProbe.reasonCounts[expected[i]] == 1 && h_report.endpointProbe.elapsedMs == 1000
            && !h_report.endpointProbe.ownershipVerified && !h_report.endpointProbe.versionResponseReceived
            && lstrcmpA(h_report.stopReason, "endpoint-unavailable") == 0);
    }
    ownerAllowed = TRUE; fakeTick = h_started = 1000; h_duration = 50;
    targetFixture = FALSE; httpAdvance = 50; httpCalls = 0;
    ok = h_watch_targets(38100, &h_base_options, "true;", 5, "true;", 5, "body{}", 6, "true;", 5, error, HOST_ERROR_CAP);
    check("endpoint probe retains HTTP failure beside duration stop reason", !ok && httpCalls == 1
        && h_report.endpointProbe.lastReason == CX_ENDPOINT_HTTP_FAILED && h_report.endpointProbe.ownershipVerified
        && h_report.endpointProbe.listenerSeen && !h_report.endpointProbe.versionResponseReceived
        && lstrcmpA(h_report.stopReason, "duration-before-endpoint") == 0);
    targetFixture = TRUE; httpAdvance = 0; h_duration = 0;
    mockVersion = "{\"Browser\":75}"; fakeTick = h_started = 1000;
    ok = h_watch_targets(38100, &h_base_options, "true;", 5, "true;", 5, "body{}", 6, "true;", 5, error, HOST_ERROR_CAP);
    check("endpoint probe separates invalid version from browser mismatch", !ok
        && h_report.endpointProbe.lastReason == CX_ENDPOINT_INVALID_VERSION && h_report.endpointProbe.versionResponseReceived
        && lstrcmpA(h_report.stopReason, "browser-mismatch") == 0);
    mockVersion = "{\"Browser\":\"Other/75\"}"; fakeTick = h_started = 1000;
    ok = h_watch_targets(38100, &h_base_options, "true;", 5, "true;", 5, "body{}", 6, "true;", 5, error, HOST_ERROR_CAP);
    check("endpoint probe records valid but mismatched browser", !ok
        && h_report.endpointProbe.lastReason == CX_ENDPOINT_BROWSER_MISMATCH
        && h_report.endpointProbe.reasonCounts[CX_ENDPOINT_BROWSER_MISMATCH] == 1);
    mockVersion = NULL; targetFixture = FALSE; h_client_pid = 0; h_duration = 0;
}

static void test_upgrade_deadline_budget(void) {
    H_NATIVE_PAGE *page;
    WCHAR error[HOST_ERROR_CAP];
    BOOL ok;
    DWORD mode;
    page = (H_NATIVE_PAGE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(H_NATIVE_PAGE));
    if (!page) { check("upgrade fixture allocation", FALSE); return; }
    cx_options_init(&h_base_options); h_base_options.quiet = TRUE;
    targetFixture = TRUE; mockClientAlive = TRUE; ownerAllowed = TRUE;
    h_client_pid = 123; h_current_page = NULL; h_task_pending = FALSE;
    h_started = 1000; h_duration = 100; fakeTick = 1050;
    openCalls = openBudget = openAdvance = closeCalls = calls = failures = 0;
    openExitClient = FALSE;
    lstrcpynA(page->url, "https://a.chaoxing.com/exam-ans/", sizeof(page->url));
    lstrcpynA(page->websocket, "ws://127.0.0.1:38100/devtools/page/fixture", sizeof(page->websocket));
    ok = h_page_open(page, 38100, &h_base_options, "true;", 5, error, HOST_ERROR_CAP);
    check("WebSocket Upgrade receives only the remaining run budget", ok && openBudget == 50 && page->state && page->ws);
    h_page_close(page);
    for (mode = 0; mode < 2; ++mode) {
        fakeTick = 1050; mockClientAlive = TRUE;
        openAdvance = mode ? 0 : 50; openExitClient = mode != 0;
        openCalls = closeCalls = calls = 0;
        ok = h_page_open(page, 38100, &h_base_options, "true;", 5, error, HOST_ERROR_CAP);
        check(mode ? "client exit during Upgrade leaves no session or CDP command" : "late Upgrade leaves no session or CDP command",
            !ok && openCalls == 1 && closeCalls == 1 && calls == 0 && !page->state && !page->ws && !h_current_page);
    }
    fakeTick = 1100; mockClientAlive = TRUE; openAdvance = 0; openExitClient = FALSE; openCalls = 0;
    ok = h_page_open(page, 38100, &h_base_options, "true;", 5, error, HOST_ERROR_CAP);
    check("expired run budget performs no WebSocket Upgrade", !ok && openCalls == 0 && !page->state && !page->ws);
    HeapFree(GetProcessHeap(), 0, page);
    openAdvance = 0; openExitClient = FALSE; targetFixture = FALSE; h_client_pid = 0; h_duration = 0;
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

static BOOL write_config_fixture(const WCHAR *path, const char *text) {
    HANDLE file = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, 0, NULL);
    DWORD written = 0, length = (DWORD)h_len(text);
    BOOL ok;
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    ok = WriteFile(file, text, length, &written, NULL) && written == length;
    CloseHandle(file); return ok;
}
static BOOL config_fixture_keeps_page(void) {
    JT tokens[64];
    return h_config && jparse(h_config->current, (int)h_config->currentLength, tokens, 64) > 0
        && jeq(h_config->current, tokens, jkey(h_config->current, tokens, 0, "common.settings.fixture"), "page");
}
static void test_config_write_conflict(void) {
    typedef struct { WCHAR temporary[1024], directory[1024], file[1024]; H_NATIVE_PAGE pages[HOST_MAX_PAGES]; } FIXTURE;
    const char initial[] = "{\"settings\":{\"common.settings.fixture\":\"initial\"}}";
    const char external[] = "{\"settings\":{\"common.settings.fixture\":\"external\"}}";
    const char patch[] = "{\"common.settings.fixture\":\"page\"}";
    FIXTURE *fixture = (FIXTURE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(FIXTURE));
    WCHAR error[256]; HANDLE lock = INVALID_HANDLE_VALUE;
    BOOL prepared = FALSE;
    if (!fixture) { check("configuration conflict fixture allocates", FALSE); return; }
    if (!GetTempPathW(1024, fixture->temporary) || !GetTempFileNameW(fixture->temporary, L"cxc", 0, fixture->directory)) goto done;
    if (!DeleteFileW(fixture->directory) || !CreateDirectoryW(fixture->directory, NULL)) goto done;
    lstrcpyW(fixture->file, fixture->directory); lstrcatW(fixture->file, L"\\config.json");
    lstrcpyW(h_exe_path, fixture->directory); lstrcatW(h_exe_path, L"\\host.exe");
    if (!write_config_fixture(fixture->file, initial)) goto done;
    cx_options_init(&h_base_options); cx_options_init(&h_cli_options); cx_options_init(&h_json_options);
    lstrcpyW(h_base_options.configPath, fixture->file); h_base_options.configPathSet = TRUE;
    lstrcpyW(h_cli_options.configPath, fixture->file); h_cli_options.configPathSet = TRUE;
    if (!cx_options_apply_json_utf8(&h_base_options, initial, sizeof(initial) - 1, error, 256)) goto done;
    h_client_pid = 0; h_duration = 0; h_task_pending = FALSE; fakeTick = 1000;
    if (!h_config_begin(&h_base_options, error, 256)) goto done;
    h_config_queue(patch, sizeof(patch) - 1); h_config_tick(fixture->pages);
    if (!write_config_fixture(fixture->file, external)) goto done;
    lock = CreateFileW(fixture->file, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (lock == INVALID_HANDLE_VALUE) goto done;
    prepared = TRUE; h_config->pollAt = 0; fakeTick = 3000;
    h_config_tick(fixture->pages);
    check("failed config write cannot discard the newer in-memory page settings",
        h_config->dirtySet && config_fixture_keeps_page());
    CloseHandle(lock); lock = INVALID_HANDLE_VALUE; h_config->pollAt = 0; fakeTick = 5000;
    h_config_tick(fixture->pages);
    check("config reload resumes after the pending page patch is saved",
        !h_config->dirtySet && config_fixture_keeps_page());
done:
    check("configuration conflict fixture prepares real file replacement failure", prepared);
    if (lock != INVALID_HANDLE_VALUE) CloseHandle(lock);
    h_config_close();
    if (fixture->file[0]) DeleteFileW(fixture->file);
    if (fixture->directory[0]) RemoveDirectoryW(fixture->directory);
    h_exe_path[0] = 0;
    HeapFree(GetProcessHeap(), 0, fixture);
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

/* 管道 CDP 传输在注入测试里不需要真实行为，提供最小替身以便链接 host.c。 */
BOOL net_pipe_send_frame(HANDLE writeHandle, const char *payload, DWORD length) {
    (void)writeHandle; (void)payload; (void)length;
    return FALSE;
}

int net_pipe_recv_frame(HANDLE readHandle, char **payload, DWORD *length, DWORD timeoutMs) {
    (void)readHandle; (void)timeoutMs;
    if (payload) *payload = NULL;
    if (length) *length = 0;
    return -1;
}
/* ---- auto 分派与注入判据（离线，不启动客户端） ---- */
static BOOL write_pe_with_section(const WCHAR *path, const char *sectionName) {
    HANDLE file;
    IMAGE_DOS_HEADER dos;
    IMAGE_NT_HEADERS nt;
    IMAGE_SECTION_HEADER section;
    DWORD written = 0, i;
    BOOL ok = FALSE;
    file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    ZeroMemory(&dos, sizeof(dos));
    dos.e_magic = IMAGE_DOS_SIGNATURE;
    dos.e_lfanew = (LONG)sizeof(dos);
    ZeroMemory(&nt, sizeof(nt));
    nt.Signature = IMAGE_NT_SIGNATURE;
    nt.FileHeader.NumberOfSections = 1;
    nt.FileHeader.SizeOfOptionalHeader = 0;
    ZeroMemory(&section, sizeof(section));
    for (i = 0; i < 8 && sectionName[i]; ++i) section.Name[i] = (BYTE)sectionName[i];
    ok = WriteFile(file, &dos, sizeof(dos), &written, NULL) && written == sizeof(dos)
        && WriteFile(file, &nt, sizeof(nt), &written, NULL) && written == sizeof(nt)
        && WriteFile(file, &section, sizeof(section), &written, NULL) && written == sizeof(section);
    CloseHandle(file);
    return ok;
}
static void touch_file(const WCHAR *path) {
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
}
/* 写 marker 并指定载体名。注入测试用的最小 PE 不导入 winmm.dll，
   因此这里只验证"未导入即不可复用"；导入成立的分支由
   scripts/windows-native-inject-mode-matrix.test.mjs 用真导入 winmm.dll 的
   carrier-fixture.exe 覆盖。 */
static void write_marker(const WCHAR *dir, const char *carrier) {
    WCHAR path[MAX_PATH];
    HANDLE file;
    DWORD written = 0;
    char text[64];
    int at = 0, k = 0;
    static const char prefix[] = "cxhook-proxy\r\ncarrier=";
    lstrcpyW(path, dir); lstrcatW(path, L"\\cxhook-proxy.marker");
    file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return;
    while (prefix[at]) { text[at] = prefix[at]; ++at; }
    while (carrier[k] && at < 56) text[at++] = carrier[k++];
    text[at++] = '\r'; text[at++] = '\n';
    WriteFile(file, text, (DWORD)at, &written, NULL);
    CloseHandle(file);
}
static BOOL make_directory(const WCHAR *path) { CreateDirectoryW(path, NULL); return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES; }
static BOOL file_exists(const WCHAR *path) { return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES; }

static void test_inject_plan(void) {
    WCHAR root[MAX_PATH], plainDir[MAX_PATH], packedDir[MAX_PATH], installedDir[MAX_PATH];
    WCHAR plainClient[MAX_PATH], packedClient[MAX_PATH], installedClient[MAX_PATH];
    WCHAR path[MAX_PATH];
    H_INJECT_PLAN plan;
    if (!GetEnvironmentVariableW(L"CX_INJECT_TEST_DIR", root, MAX_PATH)) {
        WCHAR temp[MAX_PATH];
        if (!GetTempPathW(MAX_PATH, temp)) ExitProcess(2);
        lstrcpyW(root, temp);
        lstrcatW(root, L"cx-inject-plan");
    }
    make_directory(root);
    wsprintfW(plainDir, L"%s\\plain", root);
    wsprintfW(packedDir, L"%s\\packed", root);
    wsprintfW(installedDir, L"%s\\installed", root);
    make_directory(plainDir); make_directory(packedDir); make_directory(installedDir);
    wsprintfW(plainClient, L"%s\\CXExam.exe", plainDir);
    wsprintfW(packedClient, L"%s\\CXExam.exe", packedDir);
    wsprintfW(installedClient, L"%s\\CXExam.exe", installedDir);
    if (!write_pe_with_section(plainClient, ".text")
        || !write_pe_with_section(packedClient, ".themida")) ExitProcess(2);

    /* 1) 未加壳且无代理 → cdp-port（不传/传 auto 都一样，auto 不额外安装） */
    h_plan_inject(plainClient, FALSE, &plan);
    check("plain client plans cdp-port", plan.channel == H_INJECT_CHANNEL_CDP_PORT
        && plan.reason == H_INJECT_PLAN_PORTABLE && !plan.packed && !plan.proxyPresent);
    h_plan_inject(plainClient, TRUE, &plan);
    check("plain client stays on cdp-port in auto", plan.channel == H_INJECT_CHANNEL_CDP_PORT);

    /* 2) 加壳 → dll-proxy（auto 与默认都要命中） */
    h_plan_inject(packedClient, FALSE, &plan);
    check("packed client plans dll-proxy without an explicit mode", plan.channel == H_INJECT_CHANNEL_DLL_PROXY
        && plan.reason == H_INJECT_PLAN_PROXY_REQUIRED && plan.packed);
    h_plan_inject(packedClient, TRUE, &plan);
    check("packed client keeps dll-proxy in auto", plan.channel == H_INJECT_CHANNEL_DLL_PROXY);

    /* 3) 已装代理 + marker：最小 PE 不导入 winmm，故不可复用；marker 缺失也不认。 */
    lstrcpyW(path, installedDir); lstrcatW(path, L"\\cxhook-proxy.marker"); DeleteFileW(path);
    lstrcpyW(path, installedDir); lstrcatW(path, L"\\winmm.dll"); touch_file(path);
    h_plan_inject(installedClient, TRUE, &plan);
    check("dll without marker is not reused", plan.channel == H_INJECT_CHANNEL_CDP_PORT && plan.proxyPresent && !plan.markerPresent);
    write_marker(installedDir, "winmm");
    h_plan_inject(installedClient, TRUE, &plan);
    /* 有 DLL 有 marker，但客户端不导入该载体 → 不能声称可复用。 */
    check("carrier that the client never imports is not reusable",
        plan.channel == H_INJECT_CHANNEL_CDP_PORT && plan.proxyPresent && plan.markerPresent && !plan.proxyUsable);
    /* 不传 --inject-mode 时保持历史默认：有代理也不自动切换 */
    h_plan_inject(installedClient, FALSE, &plan);
    check("default mode keeps cdp-port even with an installed proxy", plan.channel == H_INJECT_CHANNEL_CDP_PORT);

    /* 4) 空/无效路径必须安全回落，不能崩 */
    h_plan_inject(NULL, TRUE, &plan);
    check("missing client path plans cdp-port", plan.channel == H_INJECT_CHANNEL_CDP_PORT && !plan.packed);
    h_plan_inject(L"", TRUE, &plan);
    check("empty client path plans cdp-port", plan.channel == H_INJECT_CHANNEL_CDP_PORT);
    h_plan_inject(L"Z:\\no-such-dir\\CXExam.exe", TRUE, &plan);
    check("nonexistent client path plans cdp-port", plan.channel == H_INJECT_CHANNEL_CDP_PORT && !plan.proxyPresent);
}

static void test_proxy_log_evidence(void) {
    WCHAR path[MAX_PATH];
    HANDLE file;
    DWORD written = 0, pid = GetCurrentProcessId();
    static const char confirmed[] = "winmm proxy loaded | C:\\x\\CXExam.exe\r\n"
                                    "winmm proxy: settings-only mode (forced) | C:\\x\\CXExam.exe\r\n";
    static const char failed[] = "winmm proxy loaded | C:\\x\\CXExam.exe\r\n"
                                 "winmm proxy: no injection port | C:\\x\\CXExam.exe\r\n";
    static const char unrelated[] = "winmm proxy loaded | C:\\x\\CXExam.exe\r\n";
    path[0] = 0;
    if (!h_proxy_log_path(pid, path, MAX_PATH)) ExitProcess(2);
    check("proxy log path names the client pid", h_wcontains(path, L"cxhook-"));
    DeleteFileW(path);
    check("absent proxy log is unknown, not failed", h_proxy_hook_state(pid) == H_PROXY_HOOK_UNKNOWN);

    file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) ExitProcess(2);
    WriteFile(file, confirmed, (DWORD)(sizeof(confirmed) - 1), &written, NULL);
    CloseHandle(file);
    check("proxy log with cef hook evidence is confirmed", h_proxy_hook_state(pid) == H_PROXY_HOOK_CONFIRMED);

    file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) ExitProcess(2);
    WriteFile(file, failed, (DWORD)(sizeof(failed) - 1), &written, NULL);
    CloseHandle(file);
    check("proxy log without an injection port is failed", h_proxy_hook_state(pid) == H_PROXY_HOOK_FAILED);

    file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) ExitProcess(2);
    WriteFile(file, unrelated, (DWORD)(sizeof(unrelated) - 1), &written, NULL);
    CloseHandle(file);
    check("proxy log without hook evidence stays unknown", h_proxy_hook_state(pid) == H_PROXY_HOOK_UNKNOWN);
    DeleteFileW(path);
}

/* ---- 注入判据：页面主世界哨兵（三态） ---- */
static void test_bundle_sentinel(void) {
    WCHAR error[HOST_ERROR_CAP];
    H_NATIVE_PAGE page;
    DWORD before;
    ZeroMemory(&page, sizeof(page));
    page.ws = (NET_WS *)1;
    page.nextId = 1;
    page.state = NULL;
    cx_options_init(&h_base_options);
    error[0] = 0;

    /* 确认：页面回答 boolean true → 注入落地 */
    ZeroMemory(&h_report, sizeof(h_report));
    scriptReplyMode = 0; calls = 0; failures = 0; cancelReadMode = 0;
    h_probe_bundle_sentinel(&page);
    check("bundle sentinel confirms a true page acknowledgement", h_report.injectEvidence.bundleInPage
        && !h_report.injectEvidence.bundleSentinelRejected);

    /* 明确否定：页面回答 boolean false → 拒绝 */
    ZeroMemory(&h_report, sizeof(h_report));
    scriptReplyMode = 1; calls = 0;
    h_probe_bundle_sentinel(&page);
    check("bundle sentinel records an explicit false acknowledgement", !h_report.injectEvidence.bundleInPage
        && h_report.injectEvidence.bundleSentinelRejected);

    /* 明确否定：脚本抛异常 */
    ZeroMemory(&h_report, sizeof(h_report));
    scriptReplyMode = 3; calls = 0;
    h_probe_bundle_sentinel(&page);
    check("bundle sentinel records a page exception as rejection", !h_report.injectEvidence.bundleInPage
        && h_report.injectEvidence.bundleSentinelRejected);

    /* 无法判定：传输层错误不升级为否定 */
    ZeroMemory(&h_report, sizeof(h_report));
    scriptReplyMode = 0; calls = 0; transportErrorMode = TRUE;
    h_probe_bundle_sentinel(&page);
    check("bundle sentinel transport failure is unknown, not rejected", !h_report.injectEvidence.bundleInPage
        && !h_report.injectEvidence.bundleSentinelRejected);
    transportErrorMode = FALSE;

    /* 已确认后不重复探测 */
    ZeroMemory(&h_report, sizeof(h_report));
    h_report.injectEvidence.bundleInPage = TRUE;
    before = calls;
    h_probe_bundle_sentinel(&page);
    check("bundle sentinel probe runs once per run", calls == before);
    scriptReplyMode = 0;
    ZeroMemory(&h_report, sizeof(h_report));
    error[0] = 0;
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
    {
        WCHAR gate[16];
        gate[0] = 0;
        GetEnvironmentVariableW(L"CX_INJECT_TEST_ONLY", gate, 16);
        if (!gate[0] || lstrcmpW(gate, L"plan") == 0) test_inject_plan();
        if (!gate[0] || lstrcmpW(gate, L"log") == 0) test_proxy_log_evidence();
        if (!gate[0] || lstrcmpW(gate, L"sentinel") == 0) test_bundle_sentinel();
    }
    test_http_deadline_budget();
    test_endpoint_probe();
    test_upgrade_deadline_budget();
    test_normal_stop_cancellation();
    test_config_write_conflict();
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


