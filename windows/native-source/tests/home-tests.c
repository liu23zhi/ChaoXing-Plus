#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "../home.h"
#include "../browser-session.h"
#include "../browser-extension.h"
#include "../adapter-account.h"
#include "../account-window.h"
#include "../device-quota.h"

#define SETTINGS_PANEL_ENABLED 1510
#define SETTINGS_PANEL_COLLAPSED 1511
#define SETTINGS_PANEL_TOP 1512
#define SETTINGS_PANEL_RIGHT 1513
#define SETTINGS_PANEL_WIDTH 1514
#define SETTINGS_PANEL_THEME 1515
#define SETTINGS_ANSWER_MODE 1516
#define SETTINGS_ANSWER_KEY 1517
#define SETTINGS_ANSWER_THREADS 1518
#define SETTINGS_ANSWER_DIALOG 1519
#define SETTINGS_ANSWER_COUNTDOWN 1520
#define SETTINGS_ANSWER_RETRY 1521
#define SETTINGS_AUTO_SUBMIT 1522
#define SETTINGS_LOG_ENABLED 1523
#define SETTINGS_EXTENSION_ENABLED 1524
#define SETTINGS_ENABLE_ANSWER 1525
#define SETTINGS_AI_FALLBACK 1526
#define SETTINGS_ASYNC_SEARCH 1527
#define SETTINGS_DEEP_THINKING 1528
#define SETTINGS_AI_FAILURE 1529
#define SETTINGS_EXAM_AUTO_SUBMIT 1530
#define SETTINGS_LOCAL_CACHE 1531

static DWORD failures, browserStarts, networkCalls, closedSessions, destroyedSessions;
/* cx_browser_poll 的替身用：非 0 表示「只有这个会话还在跑」。 */
static DWORD runningSession;
/* 上报失败注入（断言「失败不阻断本地」）。 */
static BOOL reportFails;
static HANDLE fetchEntered, fetchRelease;
static BOOL blockFetch, showWindows;
static BOOL edgeInstalled = TRUE, chromeInstalled = TRUE, mockCachePackage, rejectFirstVerify;
static BOOL lastCacheNoDiskWrite, lastCachePathMatched;
static DWORD cachedFetches, forcedFetches, verifyCalls;
static DWORD resolveCalls, resolveExamCalls;
static DWORD windowCreateCalls;
static int resolveMode;
static BOOL test_script_request(const WCHAR *base, const WCHAR *method, const WCHAR *path,
    const WCHAR *authorization, const char *json, DWORD timeout, DWORD limit,
    CX_ADAPTER_REPLY *reply, WCHAR *error, DWORD cap);

static BOOL test_show_window(HWND window, int command) {
    return ShowWindow(window, showWindows ? command : SW_HIDE);
}
static HWND WINAPI test_create_window(DWORD exStyle, LPCWSTR className, LPCWSTR name, DWORD style,
    int x, int y, int width, int height, HWND parent, HMENU menu, HINSTANCE instance, LPVOID parameter) {
    ++windowCreateCalls;
    return CreateWindowExW(exStyle, className, name, style, x, y, width, height, parent, menu, instance, parameter);
}
static BOOL test_extension_fetch(const WCHAR *base, const WCHAR *source, BYTE **data,
    DWORD *size, WCHAR *version, DWORD versionCap, WCHAR *error, DWORD errorCap) {
    (void)base; (void)version; (void)versionCap;
    InterlockedIncrement((volatile LONG *)&networkCalls);
    *data = NULL; *size = 0;
    if (lstrcmpW(source, L"edge")) ExitProcess(9);
    if (blockFetch) {
        SetEvent(fetchEntered);
        if (WaitForSingleObject(fetchRelease, 5000) != WAIT_OBJECT_0) ExitProcess(10);
    }
    if (error && errorCap) lstrcpynW(error, L"Mock HTTP 503: no verified extension package", (int)errorCap);
    return FALSE;
}
static BOOL test_browser_start(const CX_BROWSER_OPTIONS *options, CX_BROWSER_SESSION **session,
    WCHAR *error, DWORD errorCap) {
    (void)options; (void)error; (void)errorCap; ++browserStarts; *session = NULL; return FALSE;
}
static BOOL test_extension_fetch_cached(const WCHAR *base, const WCHAR *source, const WCHAR *cacheDir,
    BOOL noDiskWrite, BOOL forceRefresh, BYTE **data, DWORD *size, WCHAR *version, DWORD versionCap,
    WCHAR *error, DWORD errorCap) {
    ++cachedFetches; if (forceRefresh) ++forcedFetches;
    lastCacheNoDiskWrite = noDiskWrite;
    lastCachePathMatched = cacheDir && !lstrcmpiW(cacheDir, L".data\\chaoxing\\extension-cache");
    if (mockCachePackage) {
        *data = (BYTE *)HeapAlloc(GetProcessHeap(), 0, 1); *size = 1;
        if (!*data) return FALSE;
        **data = 0x43;
        if (version && versionCap) lstrcpynW(version, L"2.0.0", (int)versionCap);
        return TRUE;
    }
    return test_extension_fetch(base, source, data, size, version, versionCap, error, errorCap);
}
static BOOL test_find_browser(const WCHAR *browser, WCHAR *out, DWORD cap) {
    BOOL found = lstrcmpiW(browser, L"edge") == 0 ? edgeInstalled : chromeInstalled;
    if (found) lstrcpynW(out, lstrcmpiW(browser, L"edge") == 0 ? L"C:\\mock\\msedge.exe" : L"C:\\mock\\chrome.exe", (int)cap);
    return found;
}
static BOOL test_browser_close(CX_BROWSER_SESSION *session, WCHAR *error, DWORD errorCap) {
    (void)session; (void)error; (void)errorCap; ++closedSessions; return TRUE;
}
static void test_browser_destroy(CX_BROWSER_SESSION *session) { (void)session; ++destroyedSessions; }
static BOOL test_browser_poll(CX_BROWSER_SESSION *session, BOOL *running, WCHAR *error, DWORD cap) {
    (void)error; (void)cap;
    /* runningSession 非 0 时，只有该 id 的会话「还在跑」，其余视为已退出 ——
       用来驱动「进程自己退出 → 会话数 -1 后上报」这条时机。 */
    *running = runningSession ? ((UINT_PTR)session == (UINT_PTR)runningSession) : TRUE;
    return TRUE;
}
static DWORD test_browser_pid(const CX_BROWSER_SESSION *session) { (void)session; return 123; }
static const WCHAR *test_browser_id(const CX_BROWSER_SESSION *session) {
    (void)session; return L"lcmeenlnjihhjcjoakekikoaldigonac";
}
static BOOL test_account_window(HWND parent, CX_HOME_CONFIG *config) { (void)parent; (void)config; return FALSE; }
static BOOL captureExamDiagnostics;
static DWORD capturedExamDiagnostics;
static WCHAR diagnosticDevices[2][CX_DEVICE_ID_CAP], diagnosticLaunches[2][CX_DEVICE_ID_CAP];
static BOOL test_owned_exam_ready(const CX_OWNED_RUN_GRANT *grant, const WCHAR *device, const WCHAR *launch) {
    /* This first-party UI fixture must never send diagnostics to a live service. */
    (void)grant;
    if (captureExamDiagnostics && capturedExamDiagnostics < ARRAYSIZE(diagnosticDevices)) {
        lstrcpynW(diagnosticDevices[capturedExamDiagnostics], device, CX_DEVICE_ID_CAP);
        lstrcpynW(diagnosticLaunches[capturedExamDiagnostics], launch, CX_DEVICE_ID_CAP);
        ++capturedExamDiagnostics;
    }
    return FALSE;
}

/* 设备槽位的替身先声明、后定义（定义放在 #include "../home.c" 之后，
   这样可以复用 device-quota.h 的类型而不依赖 home.c 内部的静态辅助函数）。 */
static BOOL test_device_quota_fetch(const WCHAR *baseUrl, const WCHAR *apiKey,
    DWORD timeoutMs, CX_DEVICE_QUOTA *quota);
static BOOL test_device_sessions_report(const WCHAR *baseUrl, const WCHAR *apiKey,
    const WCHAR *deviceId, int count, DWORD timeoutMs, WCHAR *error, DWORD errorCap);
static BOOL test_extension_verify(const BYTE *data, DWORD size, const WCHAR *id, WCHAR *error, DWORD cap) {
    (void)data; (void)size; (void)id; ++verifyCalls;
    if (rejectFirstVerify && verifyCalls == 1) {
        if (error && cap) lstrcpynW(error, L"Mock cached package signature failure", (int)cap);
        return FALSE;
    }
    return TRUE;
}

#define ShowWindow test_show_window
#define CreateWindowExW test_create_window
#define cx_adapter_extension_fetch test_extension_fetch
#define cx_adapter_extension_fetch_cached test_extension_fetch_cached
#define cx_browser_start test_browser_start
#define cx_browser_close test_browser_close
#define cx_browser_destroy test_browser_destroy
#define cx_browser_poll test_browser_poll
#define cx_browser_pid test_browser_pid
#define cx_browser_extension_id test_browser_id
#define cx_account_window test_account_window
#define cx_adapter_report_owned_exam_ready test_owned_exam_ready
#define cx_adapter_request test_script_request
#define cx_browser_extension_verify test_extension_verify
/* 设备槽位：网络一律不真的发出去，只记录「该发的都发了」。 */
#define cx_device_quota_fetch test_device_quota_fetch
#define cx_device_sessions_report test_device_sessions_report
#include "../home.c"
#undef ShowWindow
#undef CreateWindowExW
#undef cx_adapter_request

static BOOL test_script_request(const WCHAR *base, const WCHAR *method, const WCHAR *path,
    const WCHAR *authorization, const char *json, DWORD timeout, DWORD limit,
    CX_ADAPTER_REPLY *reply, WCHAR *error, DWORD cap) {
    JT tokens[32]; WCHAR identity[128]; char ascii[128], body[2048]; int count, value;
    if (lstrcmpW(path, L"/api/script-launch/resolve"))
        return cx_adapter_request(base, method, path, authorization, json, timeout, limit, reply, error, cap);
    ++resolveCalls; ZeroMemory(reply, sizeof(*reply));
    if (lstrcmpW(base, L"https://fixture.invalid") || lstrcmpW(method, L"POST") || authorization) return FALSE;
    count = jparse(json, lstrlenA(json), tokens, 32); value = count > 0 ? jkey(json, tokens, 0, "identity") : -1;
    if (!jwstr(json, tokens, value, identity, 128)) return FALSE;
    WideCharToMultiByte(CP_UTF8, 0, identity, -1, ascii, 128, NULL, NULL);
    if (resolveMode == 3) lstrcpyA(body, "{\"message\":\"fixture denied\"}");
    else wsprintfA(body, "{\"origin\":\"%s\",\"identity\":\"%s\",\"token\":\"sr_fixture_verified_session_0123456789\",\"expiresAt\":\"2099-01-01T00:00:00Z\",\"heartbeatUrl\":\"/heartbeat\",\"parameters\":{\"cx.new.work.answer-retry\":4}}",
        resolveMode == 2 ? "https://other.invalid" : "https://fixture.invalid", ascii);
    reply->status = resolveMode == 3 ? 403 : 200; reply->length = lstrlenA(body);
    reply->body = (char *)HeapAlloc(GetProcessHeap(), 0, reply->length + 1);
    if (!reply->body) return FALSE;
    CopyMemory(reply->body, body, reply->length + 1); return TRUE;
}

/* ---- 设备槽位替身实现 ---------------------------------------------------- */

/* 最近一次上报的 (deviceId, count)：用于断言「device_id 是宿主的、
   count 是当前会话数」。 */
static WCHAR lastReportDeviceId[CX_DEVICE_ID_CAP];
static int lastReportCount = -1;
static DWORD reportCalls, quotaCalls;
/* 配额查询结果由用例指定。 */
static BOOL quotaFetchResult = FALSE;
static int quotaLimit, quotaUsed, quotaAvailable;
static WCHAR quotaLimitSource[32];

static BOOL test_device_quota_fetch(const WCHAR *baseUrl, const WCHAR *apiKey,
    DWORD timeoutMs, CX_DEVICE_QUOTA *quota) {
    (void)baseUrl; (void)apiKey; (void)timeoutMs;
    ++quotaCalls;
    if (!quota) return FALSE;
    ZeroMemory(quota, sizeof(*quota));
    if (!quotaFetchResult) {
        lstrcpynW(quota->error, L"mock quota unavailable", 256);
        return FALSE;
    }
    quota->known = TRUE;
    quota->limit = quotaLimit;
    quota->used = quotaUsed;
    quota->available = quotaAvailable;
    home_copy(quota->limitSource, CX_DEVICE_LIMIT_SOURCE_CAP, quotaLimitSource);
    return TRUE;
}
static BOOL test_device_sessions_report(const WCHAR *baseUrl, const WCHAR *apiKey,
    const WCHAR *deviceId, int count, DWORD timeoutMs, WCHAR *error, DWORD errorCap) {
    (void)baseUrl; (void)apiKey; (void)timeoutMs;
    ++reportCalls;
    home_copy(lastReportDeviceId, CX_DEVICE_ID_CAP, deviceId);
    lastReportCount = count;
    if (reportFails) {
        if (error && errorCap) lstrcpynW(error, L"mock report failure", (int)errorCap);
        return FALSE;
    }
    if (error && errorCap) error[0] = 0;
    return TRUE;
}

static CX_OPTIONS options;
static CX_HOME_CONFIG shared, separate;
static char settingsOutput[CX_OPTIONS_JSON_CAP];
static WCHAR errorText[512], browserKind[16];
static DWORD dialogInspections, homeInspections;
static BOOL examCalled;

static void output(const char *value) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), value, (DWORD)lstrlenA(value), &written, NULL);
}
static void check(BOOL passed, const char *name) {
    output(passed ? "PASS " : "FAIL "); output(name); output("\n");
    if (!passed) ++failures;
}
static BOOL contains(const char *text, const char *needle) {
    DWORD i, k;
    for (i = 0; text[i]; ++i) {
        for (k = 0; needle[k] && text[i + k] == needle[k]; ++k) { }
        if (!needle[k]) return TRUE;
    }
    return FALSE;
}
static DWORD count_occurrences(const char *text, const char *needle) {
    DWORD count = 0, i, k, length = (DWORD)lstrlenA(needle);
    if (!length) return 0;
    for (i = 0; text[i]; ++i) {
        for (k = 0; k < length && text[i + k] == needle[k]; ++k) { }
        if (k == length) { ++count; i += length - 1; }
    }
    return count;
}
static BOOL CALLBACK find_window(HWND window, LPARAM parameter) {
    struct { const WCHAR *name; HWND found; } *search = (void *)parameter;
    DWORD pid; WCHAR name[80];
    GetWindowThreadProcessId(window, &pid);
    if (pid == GetCurrentProcessId() && GetClassNameW(window, name, 80) && !lstrcmpW(name, search->name)) {
        search->found = window; return FALSE;
    }
    return TRUE;
}
static HWND owned_window(const WCHAR *name) {
    struct { const WCHAR *name; HWND found; } search;
    search.name = name; search.found = NULL; EnumWindows(find_window, (LPARAM)&search); return search.found;
}
static void clear_messages(void) {
    MSG message;
    while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) {
        if (message.message != WM_QUIT) { TranslateMessage(&message); DispatchMessageW(&message); }
    }
}
static BOOL test_home_exam_noop(CX_OPTIONS *value, WCHAR *error, DWORD cap) {
    (void)value; (void)error; (void)cap; return TRUE;
}
static HOME_STATE *make_home(void) {
    HOME_STATE *state = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*state));
    if (!state) ExitProcess(3);
    state->options = &options; state->config = &shared;
    state->examRun = test_home_exam_noop; /* this fixture represents the full home, not HEAD-only diagnostics */
    state->window = CreateWindowExW(0, HOME_CLASS, L"Home test", WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
        0, 0, 840, 510, NULL, NULL, home_instance, state);
    if (!state->window) ExitProcess(4);
    state->list = home_control(0, L"LISTBOX", L"", WS_CHILD, 0, 0, 100, 100, state->window, HOME_SESSION_LIST);
    state->status = home_control(0, L"STATIC", L"", WS_CHILD, 0, 100, 100, 20, state->window, HOME_STATUS);
    return state;
}
static void free_home(HOME_STATE *state) {
    if (state->worker) {
        SetEvent(fetchRelease);
        WaitForSingleObject(state->worker, 5000);
        CloseHandle(state->worker); state->worker = NULL;
    }
    if (IsWindow(state->window)) DestroyWindow(state->window);
    clear_messages(); SecureZeroMemory(state, sizeof(*state)); HeapFree(GetProcessHeap(), 0, state);
}

static void settings_tests(void) {
    HOME_STATE *state = make_home(); DWORD length = 0;
    const char *initial = "\"common.settings.keep\":true,\"common.settings.override\":1";
    lstrcpyA(options.sharedSettingsJson, "\"common.settings.tiku-adapter.baseurl\":\"https://saved.example/\",\"common.settings.tiku-adapter.key\":\"tk_saved\"");
    options.sharedSettingsLength = (DWORD)lstrlenA(options.sharedSettingsJson); options.sharedSettingsSet = TRUE;
    check(cx_home_config_apply_options(&shared, &options, errorText, 512)
        && !lstrcmpW(shared.adapterBaseUrl, L"https://saved.example/") && !lstrcmpW(shared.apiKey, L"tk_saved"),
        "homepage inherits the existing adapter address and credentials without replacing them with defaults");
    lstrcpyA(options.sharedSettingsJson, initial); options.sharedSettingsLength = (DWORD)lstrlenA(initial); options.sharedSettingsSet = TRUE;
    home_copy(shared.settingsJson, CX_HOME_SETTINGS_CAP,
        L"{\"common.settings.override\":2,\"cx.new.work.retry\":true,\"question.cache.secret\":\"discard\",\"cx.new.unknown.secret\":9}");
    home_copy(shared.apiKey, CX_HOME_API_KEY_CAP, L"tk_quoted\"key\\tail");
    check(home_build_settings(state, &shared, settingsOutput, sizeof(settingsOutput), &length, errorText, 512)
        && contains(settingsOutput, "\"common.settings.keep\":true")
        && contains(settingsOutput, "\"common.settings.override\":2")
        && contains(settingsOutput, "\"cx.new.work.retry\":true"),
        "settings merge preserves shared values and applies allowed overrides");
    check(!contains(settingsOutput, "question.cache.secret") && !contains(settingsOutput, "cx.new.unknown.secret"),
        "settings exclude question caches and unknown namespaces");
    check(contains(settingsOutput, "tk_quoted\\\"key\\\\tail"), "adapter credentials are escaped as JSON values");
    check(!lstrcmpA(options.sharedSettingsJson, initial), "building session settings does not overwrite shared options");
    home_copy(shared.settingsJson, CX_HOME_SETTINGS_CAP, L"{");
    check(!home_build_settings(state, &shared, settingsOutput, sizeof(settingsOutput), &length, errorText, 512),
        "malformed settings JSON is rejected");
    home_copy(shared.settingsJson, CX_HOME_SETTINGS_CAP, L"{}");
    free_home(state);
}

static void CALLBACK dialog_tick(HWND window, UINT message, UINT_PTR timer, DWORD time) {
    HWND dialog = owned_window(SETTINGS_CLASS); HICON icon;
    (void)window; (void)message; (void)time;
    if (!dialog) return;
    KillTimer(NULL, timer); ++dialogInspections;
    icon = LoadIconW(home_instance, MAKEINTRESOURCEW(CX_RESOURCE_APP_ICON));
    check(icon && (HICON)SendMessageW(dialog, WM_GETICON, ICON_BIG, 0) == icon,
        "settings dialog binds the actual application window icon");
    check(!GetDlgItem(dialog, 1509) && !GetDlgItem(dialog, 1501),
        "settings dialog omits the advanced JSON editor and local CRX input");
    check(FindWindowExW(dialog, NULL, L"STATIC", L"API key") != NULL
        && FindWindowExW(dialog, NULL, L"STATIC", L"API key（可选）") == NULL,
        "settings dialog labels the API key without an optional marker");
    check(GetDlgItem(dialog, SETTINGS_PANEL_ENABLED) && GetDlgItem(dialog, SETTINGS_PANEL_COLLAPSED)
        && GetDlgItem(dialog, SETTINGS_PANEL_TOP) && GetDlgItem(dialog, SETTINGS_PANEL_RIGHT)
        && GetDlgItem(dialog, SETTINGS_PANEL_WIDTH) && GetDlgItem(dialog, SETTINGS_PANEL_THEME),
        "settings dialog exposes panel visibility, collapse, position, width, and theme controls");
    check(GetDlgItem(dialog, SETTINGS_ANSWER_MODE) && GetDlgItem(dialog, SETTINGS_ANSWER_KEY)
        && GetDlgItem(dialog, SETTINGS_ANSWER_THREADS) && GetDlgItem(dialog, SETTINGS_ANSWER_DIALOG)
        && GetDlgItem(dialog, SETTINGS_ANSWER_COUNTDOWN) && GetDlgItem(dialog, SETTINGS_ANSWER_RETRY)
        && GetDlgItem(dialog, SETTINGS_AUTO_SUBMIT) && GetDlgItem(dialog, SETTINGS_LOG_ENABLED),
        "settings dialog exposes answer mode, shortcut, threads, dialog, countdown, retry, submit, and log controls");
    check(GetDlgItem(dialog, SETTINGS_EXTENSION_ENABLED) && GetDlgItem(dialog, SETTINGS_ENABLE_ANSWER)
        && GetDlgItem(dialog, SETTINGS_AI_FALLBACK) && GetDlgItem(dialog, SETTINGS_ASYNC_SEARCH)
        && GetDlgItem(dialog, SETTINGS_DEEP_THINKING) && GetDlgItem(dialog, SETTINGS_AI_FAILURE)
        && GetDlgItem(dialog, SETTINGS_EXAM_AUTO_SUBMIT) && GetDlgItem(dialog, SETTINGS_LOCAL_CACHE),
        "settings dialog exposes the same exam and AI controls as the extension floating panel");
    SetWindowTextW(GetDlgItem(dialog, SETTINGS_BASE_URL), L"https://adapter.example/");
    SetWindowTextW(GetDlgItem(dialog, SETTINGS_API_KEY), L"tk_separate");
    SendMessageW(GetDlgItem(dialog, SETTINGS_BROWSER), CB_SETCURSEL, 1, 0);
    SendMessageW(GetDlgItem(dialog, SETTINGS_PANEL_ENABLED), BM_SETCHECK, BST_UNCHECKED, 0);
    SendMessageW(GetDlgItem(dialog, SETTINGS_PANEL_COLLAPSED), BM_SETCHECK, BST_CHECKED, 0);
    SetWindowTextW(GetDlgItem(dialog, SETTINGS_PANEL_TOP), L"30");
    SetWindowTextW(GetDlgItem(dialog, SETTINGS_PANEL_RIGHT), L"40");
    SetWindowTextW(GetDlgItem(dialog, SETTINGS_PANEL_WIDTH), L"520");
    SendMessageW(GetDlgItem(dialog, SETTINGS_PANEL_THEME), CB_SETCURSEL, 2, 0);
    SendMessageW(GetDlgItem(dialog, SETTINGS_ANSWER_MODE), CB_SETCURSEL, 1, 0);
    SetWindowTextW(GetDlgItem(dialog, SETTINGS_ANSWER_KEY), L"Ctrl+Alt+Shift+S");
    SetWindowTextW(GetDlgItem(dialog, SETTINGS_ANSWER_THREADS), L"2");
    SendMessageW(GetDlgItem(dialog, SETTINGS_ANSWER_DIALOG), BM_SETCHECK, BST_UNCHECKED, 0);
    SetWindowTextW(GetDlgItem(dialog, SETTINGS_ANSWER_COUNTDOWN), L"7");
    SetWindowTextW(GetDlgItem(dialog, SETTINGS_ANSWER_RETRY), L"5");
    SendMessageW(GetDlgItem(dialog, SETTINGS_AUTO_SUBMIT), BM_SETCHECK, BST_UNCHECKED, 0);
    SendMessageW(GetDlgItem(dialog, SETTINGS_LOG_ENABLED), BM_SETCHECK, BST_UNCHECKED, 0);
    SendMessageW(GetDlgItem(dialog, SETTINGS_EXTENSION_ENABLED), BM_SETCHECK, BST_UNCHECKED, 0);
    SendMessageW(GetDlgItem(dialog, SETTINGS_ENABLE_ANSWER), BM_SETCHECK, BST_UNCHECKED, 0);
    SendMessageW(GetDlgItem(dialog, SETTINGS_AI_FALLBACK), BM_SETCHECK, BST_CHECKED, 0);
    SendMessageW(GetDlgItem(dialog, SETTINGS_ASYNC_SEARCH), CB_SETCURSEL, 1, 0);
    SendMessageW(GetDlgItem(dialog, SETTINGS_DEEP_THINKING), BM_SETCHECK, BST_CHECKED, 0);
    SendMessageW(GetDlgItem(dialog, SETTINGS_AI_FAILURE), CB_SETCURSEL, 1, 0);
    SendMessageW(GetDlgItem(dialog, SETTINGS_EXAM_AUTO_SUBMIT), BM_SETCHECK, BST_CHECKED, 0);
    SendMessageW(GetDlgItem(dialog, SETTINGS_LOCAL_CACHE), BM_SETCHECK, BST_UNCHECKED, 0);
    SendMessageW(dialog, WM_COMMAND, MAKEWPARAM(SETTINGS_SAVE, BN_CLICKED), 0);
}
static void dialog_tests(void) {
    HOME_STATE *state = make_home(); BOOL accepted; DWORD outputLength = 0;
    home_copy(shared.apiKey, CX_HOME_API_KEY_CAP, L"tk_shared");
    if (!SetTimer(NULL, 0, 20, dialog_tick)) ExitProcess(5);
    accepted = home_settings_dialog(state, FALSE, L"edge", &separate, browserKind, 16);
    if (accepted) home_build_settings(state, &separate, settingsOutput, sizeof(settingsOutput), &outputLength, errorText, 512);
    check(accepted && !lstrcmpW(separate.apiKey, L"tk_separate") && !lstrcmpW(browserKind, L"chrome"),
        "separate settings return the chosen browser and session credentials");
    check(contains(settingsOutput, "\"common.settings.windows-panel-enabled\":false")
        && contains(settingsOutput, "\"common.settings.windows-panel-collapsed\":true")
        && contains(settingsOutput, "\"common.settings.windows-panel-top\":30")
        && contains(settingsOutput, "\"common.settings.windows-panel-right\":40")
        && contains(settingsOutput, "\"common.settings.windows-panel-width\":520")
        && contains(settingsOutput, "\"common.settings.windows-panel-theme\":\"green\""),
        "native form emits panel settings as valid shared settings");
    check(contains(settingsOutput, "\"common.settings.windows-answer-mode\":\"manual\"")
        && contains(settingsOutput, "\"common.settings.windows-answer-key\":\"Ctrl+Alt+Shift+S\"")
        && contains(settingsOutput, "\"common.settings.windows-answer-threads\":2")
        && contains(settingsOutput, "\"common.settings.windows-show-answer-dialog\":false")
        && contains(settingsOutput, "\"common.settings.windows-answer-countdown\":7")
        && contains(settingsOutput, "\"common.settings.windows-answer-retry\":5")
        && contains(settingsOutput, "\"common.settings.windows-auto-submit\":false")
        && contains(settingsOutput, "\"common.settings.windows-log-enabled\":false"),
        "native form emits answer and logging settings as valid shared settings");
    check(contains(settingsOutput, "\"common.settings.extension-enabled\":false")
        && contains(settingsOutput, "\"cx.new.study.enableAnswer\":false")
        && contains(settingsOutput, "\"cx.new.study.enableAIFallbackAnswer\":true")
        && contains(settingsOutput, "\"cx.new.study.useAsyncTikuSearch\":false")
        && contains(settingsOutput, "\"cx.new.study.deepThinking\":true")
        && contains(settingsOutput, "\"cx.new.study.aiFallbackFailureAction\":\"skip\"")
        && contains(settingsOutput, "\"cx.new.study.enableExamAutoSubmit\":true")
        && contains(settingsOutput, "\"cx.new.study.enableLocalQuestionCache\":false"),
        "native form emits extension floating-panel settings as shared settings");
    check(!lstrcmpW(shared.apiKey, L"tk_shared") && !lstrcmpW(shared.settingsJson, L"{}"),
        "separate settings never replace the common configuration");
    if (!SetTimer(NULL, 0, 20, dialog_tick)) ExitProcess(5);
    check(home_settings_dialog(state, TRUE, L"edge", NULL, NULL, 0)
        && !lstrcmpW(shared.apiKey, L"tk_separate"), "saving common settings applies validated values");
    check(dialogInspections == 2, "all real settings dialogs complete their message loops");
    free_home(state);
}

static void browser_selection_tests(void) {
    WCHAR browser[16], path[128];
    edgeInstalled = TRUE; chromeInstalled = TRUE;
    check(home_find_default_browser(test_find_browser, browser, 16, path, 128)
        && !lstrcmpiW(browser, L"edge") && !lstrcmpW(path, L"C:\\mock\\msedge.exe"),
        "combined browser selection prefers Edge when both browsers are installed");
    edgeInstalled = FALSE;
    check(home_find_default_browser(test_find_browser, browser, 16, path, 128)
        && !lstrcmpiW(browser, L"chrome") && !lstrcmpW(path, L"C:\\mock\\chrome.exe"),
        "combined browser selection falls back to Chrome when Edge is unavailable");
    edgeInstalled = FALSE; chromeInstalled = FALSE;
    check(!home_find_default_browser(test_find_browser, browser, 16, path, 128),
        "combined browser selection reports when neither supported browser is installed");
    chromeInstalled = TRUE;
}

static void worker_tests(void) {
    HOME_STATE *state = make_home(); DWORD start, beforeNetwork = networkCalls; BOOL sawWorker;
    blockFetch = TRUE; ResetEvent(fetchEntered); ResetEvent(fetchRelease);
    home_begin(state, HOME_EDGE, L"edge", &shared);
    sawWorker = state->worker != NULL && WaitForSingleObject(fetchEntered, 5000) == WAIT_OBJECT_0;
    check(sawWorker, "online extension retrieval runs on a worker thread");
    home_begin(state, HOME_CHROME, L"chrome", &shared);
    check(networkCalls == beforeNetwork + 1, "a second action cannot start another in-flight operation");
    SendMessageW(state->window, WM_CLOSE, 0, 0);
    check(IsWindow(state->window) && state->closing && state->worker,
        "closing during a download retains the window until worker completion");
    SetEvent(fetchRelease); start = GetTickCount();
    while (IsWindow(state->window) && GetTickCount() - start < 5000) {
        clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
    }
    check(!state->worker, "the completed download worker is joined and its handle released");
    check(!browserStarts, "HTTP download failure never starts a browser");
    check(!IsWindow(state->window), "closing intention survives a failed download and finishes shutdown");
    free_home(state); blockFetch = FALSE;

    state = make_home(); mockCachePackage = TRUE; rejectFirstVerify = TRUE; verifyCalls = 0;
    options.noDiskWrite = TRUE;
    {
        DWORD beforeFetches = cachedFetches, beforeForced = forcedFetches;
        home_begin(state, HOME_EDGE, L"edge", &shared); start = GetTickCount();
        while (state->worker && GetTickCount() - start < 5000) {
            clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
        }
        check(cachedFetches == beforeFetches + 2 && forcedFetches == beforeForced + 1 && verifyCalls == 2,
            "an invalid cached extension is refreshed online once and verified again");
        check(lastCacheNoDiskWrite && lastCachePathMatched,
            "extension cache uses the data directory and obeys no-disk-write");
        beforeForced = forcedFetches;
        home_begin(state, HOME_UPDATE, NULL, &shared); start = GetTickCount();
        while (state->worker && GetTickCount() - start < 5000) {
            clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
        }
        check(forcedFetches == beforeForced + 1, "manual extension update bypasses the local cache");
    }
    options.noDiskWrite = FALSE; mockCachePackage = FALSE; rejectFirstVerify = FALSE;
    free_home(state);

    state = make_home();
    state->sessions[0].session = (CX_BROWSER_SESSION *)(UINT_PTR)1;
    home_copy(state->sessions[0].browser, 16, L"edge");
    home_copy(state->sessions[0].version, 64, L"1.2.3");
    home_refresh_list(state);
    check(SendMessageW(state->list, LB_GETCURSEL, 0, 0) != LB_ERR,
        "first owned browser session is selected automatically in the home list");
    SendMessageW(state->window, WM_COMMAND, MAKEWPARAM(HOME_CLOSE_SESSION, BN_CLICKED), 0);
    start = GetTickCount();
    while (state->worker && GetTickCount() - start < 5000) {
        clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
    }
    clear_messages();
    check(!state->sessions[0].session && closedSessions == 1 && destroyedSessions == 1,
        "close selected session closes and destroys the automatically selected browser");
    check(SendMessageW(state->list, LB_GETCOUNT, 0, 0) == 0,
        "closed browser session is removed from the home list");
    free_home(state);

    state = make_home(); closedSessions = 0; destroyedSessions = 0;
    state->sessions[0].session = (CX_BROWSER_SESSION *)(UINT_PTR)1;
    state->sessions[1].session = (CX_BROWSER_SESSION *)(UINT_PTR)2;
    home_copy(state->sessions[0].browser, 16, L"edge");
    home_copy(state->sessions[1].browser, 16, L"chrome");
    home_refresh_list(state);
    SendMessageW(state->window, WM_COMMAND, MAKEWPARAM(HOME_CLOSE_SESSION, BN_CLICKED), 0);
    start = GetTickCount();
    while (state->worker && GetTickCount() - start < 5000) {
        clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
    }
    clear_messages();
    check(!state->sessions[0].session && state->sessions[1].session
        && SendMessageW(state->list, LB_GETCURSEL, 0, 0) != LB_ERR,
        "closing the selected first session selects the next remaining session");
    SendMessageW(state->window, WM_COMMAND, MAKEWPARAM(HOME_CLOSE_SESSION, BN_CLICKED), 0);
    start = GetTickCount();
    while (state->worker && GetTickCount() - start < 5000) {
        clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
    }
    clear_messages();
    check(!state->sessions[1].session && SendMessageW(state->list, LB_GETCOUNT, 0, 0) == 0
        && closedSessions == 2 && destroyedSessions == 2,
        "consecutive close actions close and remove every selected session");
    free_home(state);

    closedSessions = 0; destroyedSessions = 0;
    state = make_home(); state->sessions[0].session = (CX_BROWSER_SESSION *)(UINT_PTR)1;
    home_copy(state->sessions[0].browser, 16, L"edge");
    SendMessageW(state->window, WM_CLOSE, 0, 0); start = GetTickCount();
    while (IsWindow(state->window) && GetTickCount() - start < 5000) {
        clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
    }
    check(!IsWindow(state->window) && closedSessions == 1 && destroyedSessions == 1,
        "shutdown closes and destroys every owned browser session");
    free_home(state);
}

/* ============================================================================
   设备槽位用例（C4-3 / C4-4 / C5-1 / C5-2，对应 141 §5/§8）
   ========================================================================== */

/* device_id / client_instance 的字面量必须与 device-quota.h 一致。
   此处**故意写字面量**而不是引用宏：宏改名时这条要变红。 */
static void device_key_tests(void) {
    check(!lstrcmpA(CX_DEVICE_ID_KEY, "common.settings.device-id"),
        "device storage key literal is common.settings.device-id");
    check(!lstrcmpA(CX_DEVICE_INSTANCE_KEY, "common.settings.device-instance"),
        "client instance storage key literal is common.settings.device-instance");
}

/* 链接是 /NODEFAULTLIB（无 CRT），wcsstr 不可用；这里手写一个窄宽的宽字串查找。 */
static BOOL wide_contains(const WCHAR *text, const WCHAR *needle) {
    DWORD i, k;
    if (!text || !needle || !needle[0]) return FALSE;
    for (i = 0; text[i]; ++i) {
        for (k = 0; needle[k] && text[i + k] == needle[k]; ++k) { }
        if (!needle[k]) return TRUE;
    }
    return FALSE;
}

/* C4-1 的位置判据（141 §5.1 要求 windows/data/config.json）。 */
static void device_config_path_tests(void) {
    static const WCHAR tail[] = L"\\windows\\data\\config.json";
    WCHAR path[CX_HOME_EXTENSION_PATH_CAP];
    DWORD length;

    /* --config 显式路径最高优先。 */
    check(cx_device_config_path(L"D:\\custom\\my.json", L".data", path, CX_HOME_EXTENSION_PATH_CAP)
        && !lstrcmpW(path, L"D:\\custom\\my.json"),
        "an explicit --config path wins for the device id location");

    /* 没有 --config 时，标准仓库布局 windows\data\config.json 必须优先于 dataDir(.data) ——
       device_id 是 141 §5.1 指定的配置文件内容，不是宿主的 .data 数据目录。 */
    path[0] = 0;
    check(cx_device_config_path(NULL, L".data", path, CX_HOME_EXTENSION_PATH_CAP),
        "a config path is always derivable without --config");
    length = (DWORD)lstrlenW(path);
    check(length >= 27 && !lstrcmpiW(path + length - (lstrlenW(tail)), tail),
        "device id defaults to <cwd>\\windows\\data\\config.json, not the .data data directory");
    check(!wide_contains(path, L"\\.data\\") && !wide_contains(path, L"/.data/"),
        "the .data data directory never receives the device id file");
}


static BOOL read_text_file(const WCHAR *path, char **text, DWORD *length) {
    HANDLE file;
    DWORD size, got;
    char *buffer;
    *text = NULL; length[0] = 0;
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    size = GetFileSize(file, NULL);
    buffer = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)size + 1);
    if (!buffer) { CloseHandle(file); return FALSE; }
    if (!ReadFile(file, buffer, size, &got, NULL)) { HeapFree(GetProcessHeap(), 0, buffer); CloseHandle(file); return FALSE; }
    CloseHandle(file);
    buffer[got] = 0;
    *text = buffer; length[0] = got;
    return TRUE;
}
static void device_id_tests(void) {
    WCHAR directory[MAX_PATH], file[MAX_PATH], id[CX_DEVICE_ID_CAP], error[256];
    WCHAR second[CX_DEVICE_ID_CAP], third[CX_DEVICE_ID_CAP];
    char *text = NULL;
    DWORD length = 0;
    HANDLE handle;

    GetTempPathW(MAX_PATH, directory);
    lstrcatW(directory, L"cxdevice-");
    {
        WCHAR unique[32];
        wsprintfW(unique, L"%lu", (unsigned long)GetCurrentProcessId());
        lstrcatW(directory, unique);
    }
    CreateDirectoryW(directory, NULL);
    file[0] = 0;
    lstrcpynW(file, directory, MAX_PATH);
    lstrcatW(file, L"\\config.json");
    DeleteFileW(file);

    /* 文件不存在 → 生成 UUIDv4 并写回。 */
    id[0] = 0; error[0] = 0;
    check(cx_device_id_ensure(file, FALSE, id, CX_DEVICE_ID_CAP, error, 256) && lstrlenW(id) == 36,
        "a missing config file gets a freshly generated device id");
    handle = CreateFileW(file, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    check(handle != INVALID_HANDLE_VALUE,
        "the generated device id is written back to the configuration file (C4-1)");
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);

    /* 第二次读：必须复用同一个值（R5 要求宿主槽位跨重启稳定）。 */
    second[0] = 0;
    check(cx_device_id_ensure(file, FALSE, second, CX_DEVICE_ID_CAP, NULL, 0)
        && !lstrcmpW(second, id),
        "a second start reuses the persisted device id instead of regenerating it");

    /* --no-disk-write：文件不存在时不得创建（不绕过「不写盘」约定）。 */
    DeleteFileW(file);
    second[0] = 0;
    check(cx_device_id_ensure(file, TRUE, second, CX_DEVICE_ID_CAP, NULL, 0) && lstrlenW(second) == 36
        && GetFileAttributesW(file) == INVALID_FILE_ATTRIBUTES,
        "--no-disk-write keeps the device id in memory and never creates the config file");

    /* 已有文件但 settings 里没有该键 → 补写，且保留文件里其它内容。 */
    {
        static const char seed[] = "{\"port\":7777,\"settings\":{\"common.settings.keep\":true}}";
        DWORD written = 0;
        handle = CreateFileW(file, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        if (handle != INVALID_HANDLE_VALUE) {
            WriteFile(handle, seed, (DWORD)sizeof(seed) - 1, &written, NULL);
            CloseHandle(handle);
        }
        third[0] = 0;
        check(cx_device_id_ensure(file, FALSE, third, CX_DEVICE_ID_CAP, NULL, 0) && lstrlenW(third) == 36,
            "an existing config without a device id gets one injected");
        text = NULL; length = 0;
        if (read_text_file(file, &text, &length)) {
            check(contains(text, "\"common.settings.device-id\"") && contains(text, "7777")
                && contains(text, "common.settings.keep"),
                "injecting the device id preserves every other key in the config file");
            HeapFree(GetProcessHeap(), 0, text);
        } else check(FALSE, "injected config file is readable");
        /* 再读一次必须拿到同一个值（不是每次生成新的）。 */
        DeleteFileW(file);
    }

    DeleteFileW(file);
    RemoveDirectoryW(directory);
}


static void device_injection_tests(void) {
    HOME_STATE *state = make_home();
    DWORD length = 0;
    home_copy(state->deviceId, CX_DEVICE_ID_CAP, L"11111111-2222-4333-8444-555555555555");

    /* 1) 没置注入上下文（= 考试模式 / 设置对话框预览）时不得出现设备键。 */
    state->injectDeviceKeys = FALSE;
    check(home_build_settings(state, &shared, settingsOutput, sizeof(settingsOutput), &length, errorText, 512)
        && !contains(settingsOutput, "common.settings.device-id")
        && !contains(settingsOutput, "common.settings.device-instance"),
        "device keys are absent while no browser session is being built");

    /* 2) 置上之后必须出现，且 device_id 是宿主的。 */
    state->injectDeviceKeys = TRUE;
    home_copy(state->injectInstance, CX_DEVICE_INSTANCE_CAP, L"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    check(home_build_settings(state, &shared, settingsOutput, sizeof(settingsOutput), &length, errorText, 512)
        && contains(settingsOutput, "\"common.settings.device-id\":\"11111111-2222-4333-8444-555555555555\"")
        && contains(settingsOutput, "\"common.settings.device-instance\":\"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\""),
        "browser session settings carry the host device id and this session instance");

    /* 3) 两个会话的 instance 必须不同 —— 必须**执行源码那段原文**
       （home_device_begin_injection），不能在测试里手搓 cx_device_instance_new：
       后者绕过了 home_work 的真实注入路径，把实现改成固定值时用例仍会绿（假钉子）。 */
    {
        WCHAR first[CX_DEVICE_INSTANCE_CAP], second[CX_DEVICE_INSTANCE_CAP];
        BOOL made = home_device_begin_injection(state);
        home_copy(first, CX_DEVICE_INSTANCE_CAP, state->injectInstance);
        home_device_end_injection(state);
        made = home_device_begin_injection(state) && made;
        home_copy(second, CX_DEVICE_INSTANCE_CAP, state->injectInstance);
        home_device_end_injection(state);
        check(made && first[0] && second[0] && lstrcmpW(first, second) != 0,
            "each browser session gets its own client instance");
        /* 同时验证它确实是 UUIDv4 形态（36 字符、版本位 4、variant 8/9/a/b）。 */
        check(lstrlenW(first) == 36 && first[14] == L'4'
            && (first[19] == L'8' || first[19] == L'9' || first[19] == L'a' || first[19] == L'b'),
            "session client instance is a well formed uuid v4");
        /* 结束注入必须真把上下文清干净（否则设置对话框预览会带出设备键）。 */
        check(!state->injectDeviceKeys && !state->injectInstance[0],
            "ending the injection context clears both flags");
    }

    /* 4) 注入上下文是「每次调用一次性」的：下一次构造（例如考试模式）不得带上设备键。
       注意不能在 home_build_settings 之后就地断言 false —— 真正的清除点在 home_work
       的 done 标签与 cx_home_run 的启动段，这里只验证「没置就绝不出现」这条语义。 */
    state->injectDeviceKeys = FALSE;
    check(home_build_settings(state, &shared, settingsOutput, sizeof(settingsOutput), &length, errorText, 512)
        && !contains(settingsOutput, "common.settings.device-instance"),
        "turning the injection context off removes the device keys again");
    free_home(state);
}

/* C4-4：四个时机各上报一次，且 count 是当前会话数；退出时同步上报 0。 */
/* 等设备线程把结果经 HOME_DEVICE_DONE 交回 UI 线程。
   上报/查询都在独立线程里跑，所以「发起了」和「报到了」是两件事 ——
   用例必须等 settle 之后才看 reportCalls，否则断言的是竞态不是语义。 */
static void drain_device(HOME_STATE *state) {
    DWORD start = GetTickCount();
    while (state->deviceWorker && GetTickCount() - start < 5000) {
        clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
    }
    clear_messages();
}

static void device_report_tests(void) {
    HOME_STATE *state;
    DWORD start;

    reportCalls = 0; lastReportCount = -1; lastReportDeviceId[0] = 0;
    closedSessions = 0; destroyedSessions = 0;
    state = make_home();
    home_copy(state->deviceId, CX_DEVICE_ID_CAP, L"host-device-id");

    /* 时机 1：会话启动成功（HOME_OPERATION_DONE 里 pendingSession 落位）。 */
    state->sessions[0].session = NULL;
    state->pendingSession = (CX_BROWSER_SESSION *)(UINT_PTR)7;
    state->pendingSlot = 0;
    state->operation = HOME_EDGE;
    state->operationOK = TRUE;
    home_copy(state->pendingBrowser, 16, L"edge");
    SendMessageW(state->window, HOME_OPERATION_DONE, 0, 0);
    drain_device(state);
    check(reportCalls == 1 && lastReportCount == 1
        && !lstrcmpW(lastReportDeviceId, L"host-device-id"),
        "starting a session reports count=1 with the host device id");

    /* 时机 3：主动关闭一个会话后 count 回到 0。 */
    state->sessions[0].session = (CX_BROWSER_SESSION *)(UINT_PTR)7;
    home_refresh_list(state);
    SendMessageW(state->window, WM_COMMAND, MAKEWPARAM(HOME_CLOSE_SESSION, BN_CLICKED), 0);
    start = GetTickCount();
    while (state->worker && GetTickCount() - start < 5000) {
        clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
    }
    drain_device(state);
    check(reportCalls == 2 && lastReportCount == 0,
        "closing the last session reports count=0");
    drain_device(state);
    free_home(state);

    /* 时机 2：进程自己退出（cx_browser_poll 报 not running）。 */
    reportCalls = 0; lastReportCount = -1;
    state = make_home();
    home_copy(state->deviceId, CX_DEVICE_ID_CAP, L"host-device-id");
    state->sessions[0].session = (CX_BROWSER_SESSION *)(UINT_PTR)8;
    state->sessions[1].session = (CX_BROWSER_SESSION *)(UINT_PTR)9;
    runningSession = 8; /* 第 8 号会话「已退出」，第 9 号仍在跑 */
    state->heartbeatAt = GetTickCount(); /* 抑制本轮的 60 秒心跳，只看退出上报 */
    home_poll_sessions(state);
    drain_device(state);
    check(reportCalls == 1 && lastReportCount == 1,
        "a session exiting on its own reports the remaining session count");
    free_home(state);

    /* 时机 4：HOME_EXIT → 同步上报 0（R7 回落）。 */
    reportCalls = 0; lastReportCount = -1;
    closedSessions = 0; destroyedSessions = 0;
    state = make_home();
    home_copy(state->deviceId, CX_DEVICE_ID_CAP, L"host-device-id");
    state->sessions[0].session = (CX_BROWSER_SESSION *)(UINT_PTR)10;
    state->sessions[1].session = (CX_BROWSER_SESSION *)(UINT_PTR)11;
    state->sessions[2].session = (CX_BROWSER_SESSION *)(UINT_PTR)12;
    SendMessageW(state->window, WM_CLOSE, 0, 0);
    start = GetTickCount();
    while (IsWindow(state->window) && GetTickCount() - start < 5000) {
        clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
    }
    check(reportCalls >= 1 && lastReportCount == 0,
        "exiting with three open sessions reports count=0 (falls back to the host slot)");
    free_home(state);
    runningSession = 0;

    /* 红线 3：上报失败不阻断本地关闭 —— 关掉浏览器是用户的硬需求。 */
    reportCalls = 0; lastReportCount = -1;
    closedSessions = 0; destroyedSessions = 0;
    state = make_home();
    home_copy(state->deviceId, CX_DEVICE_ID_CAP, L"host-device-id");
    state->sessions[0].session = (CX_BROWSER_SESSION *)(UINT_PTR)13;
    home_refresh_list(state);
    reportFails = TRUE;
    SendMessageW(state->window, WM_COMMAND, MAKEWPARAM(HOME_CLOSE_SESSION, BN_CLICKED), 0);
    start = GetTickCount();
    while (state->worker && GetTickCount() - start < 5000) {
        clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
    }
    drain_device(state);
    check(!state->sessions[0].session && closedSessions == 1 && destroyedSessions == 1,
        "a failed session-count report never blocks closing the browser");
    check(reportCalls == 1, "the failed report was actually attempted");
    reportFails = FALSE;
    free_home(state);
}

/* C5-1：状态栏文案（limit=0 显示「不限」，Z = max(1, 会话数)）。 */
static void device_status_tests(void) {
    CX_DEVICE_QUOTA quota;
    WCHAR text[512];

    ZeroMemory(&quota, sizeof(quota));
    quota.known = TRUE; quota.limit = 3; quota.used = 2; quota.available = 1;
    check(cx_device_status_text(&quota, 0, text, 512)
        && !lstrcmpW(text, L"可用设备：1 / 3　本 exe 占用：1 个（0 个浏览器会话）"),
        "status shows available/limit and the host occupies one slot when no session is open");
    check(cx_device_status_text(&quota, 3, text, 512)
        && !lstrcmpW(text, L"可用设备：1 / 3　本 exe 占用：3 个（3 个浏览器会话）"),
        "status shows three occupied slots for three browser sessions");

    quota.limit = 0; quota.used = 0; quota.available = -1;
    check(cx_device_status_text(&quota, 0, text, 512)
        && !lstrcmpW(text, L"可用设备：不限 / 不限　本 exe 占用：1 个（0 个浏览器会话）"),
        "status renders 不限 instead of numbers when the limit is unlimited");

    ZeroMemory(&quota, sizeof(quota));
    check(cx_device_status_text(&quota, 0, text, 512)
        && !lstrcmpW(text, L"可用设备：无法获取设备配额　本 exe 占用：1 个（0 个浏览器会话）"),
        "status reports 无法获取设备配额 when the quota was never fetched");
}

/* C5-2：超限只提醒不拦截（R8）+ 提醒只在「已取到配额、上限有限、已用满」时出现。 */
static void device_over_limit_tests(void) {
    CX_DEVICE_QUOTA quota;
    HOME_STATE *state;

    ZeroMemory(&quota, sizeof(quota));
    check(!cx_device_over_limit(&quota), "unknown quota never counts as over limit");

    quota.known = TRUE; quota.limit = 0; quota.used = 99;
    check(!cx_device_over_limit(&quota), "unlimited accounts are never over limit even when used>0");

    quota.limit = 3; quota.used = 2;
    check(!cx_device_over_limit(&quota), "under the limit is not over limit");

    quota.used = 3;
    check(cx_device_over_limit(&quota), "used==limit is over limit");
    quota.used = 4;
    check(cx_device_over_limit(&quota), "used>limit is over limit");

    /*
       R8 的核心断言：即使超限，点击「新会话」也必须真的启动浏览器。
       这里不驱动对话框（那要人工点按钮），而是进程内驱动同一条路径：
       home_begin 在超限且用户点了「仍然新建」时不得返回、必须置 worker。
       对话框的默认焦点/文案由 device_prompt_tests 单独覆盖。
    */
    state = make_home();
    ZeroMemory(&state->quota, sizeof(state->quota));
    state->quota.known = TRUE; state->quota.limit = 1; state->quota.used = 1;
    check(cx_device_over_limit(&state->quota), "precondition: this home state is over limit");
    {
        home_device_prompt_auto_proceed = TRUE; /* 等价于用户点「仍然新建」 */
        blockFetch = TRUE; ResetEvent(fetchEntered); ResetEvent(fetchRelease);
        home_begin(state, HOME_EDGE, L"edge", &shared);
        check(state->worker != NULL,
            "over-limit still starts a browser session on New Session (R8: remind, never block)");
        check(home_device_prompt_count == 1,
            "the over-limit reminder is shown exactly once per click");
        SetEvent(fetchRelease);
        {
            DWORD start = GetTickCount();
            while (state->worker && GetTickCount() - start < 5000) {
                clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
            }
        }
        clear_messages(); blockFetch = FALSE; home_device_prompt_auto_proceed = FALSE;
    }
    free_home(state);
}

static BOOL test_exam(CX_OPTIONS *received, WCHAR *error, DWORD errorCap) {    char *effective; DWORD length = 0; BOOL merged;
    (void)error; (void)errorCap; examCalled = TRUE;
    check(received != &options && contains(received->sharedSettingsJson, "common.settings.tiku-adapter.key"),
        "exam page receives a private options copy with the current shared settings");
    check(!received->panelEnabled && !received->answerModeAuto && received->answerThreads == 2
        && !received->showAnswerDialog && received->answerCountdown == 7 && received->answerRetry == 5
        && !received->autoSubmit && !received->logFileEnabled,
        "home form settings update the typed host options used by the exam runtime");
    if (received->panelEnabled || received->answerModeAuto || received->answerThreads != 2
        || received->showAnswerDialog || received->answerCountdown != 7 || received->answerRetry != 5
        || received->autoSubmit || received->logFileEnabled) {
        output("typed settings mismatch\\n");
    }
    effective = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_OPTIONS_JSON_CAP);
    merged = effective && cx_options_effective_settings_json_utf8(received, effective, CX_OPTIONS_JSON_CAP, &length);
    check(merged && count_occurrences(effective, "\"common.settings.windows-panel-enabled\"") == 1,
        "home settings serialize host-managed keys exactly once");
    if (effective) HeapFree(GetProcessHeap(), 0, effective);
    received->sharedSettingsJson[0] = 0; return TRUE;
}
static void CALLBACK home_tick(HWND window, UINT message, UINT_PTR timer, DWORD time) {
    HWND home = owned_window(HOME_CLASS); HWND edge; RECT rect; HICON icon; DWORD i;
    const int ids[] = { HOME_EDGE, HOME_SEPARATE, HOME_CLOSE_SESSION, HOME_SETTINGS, HOME_ACCOUNT, HOME_EXAM, HOME_UPDATE };
    BOOL controls = TRUE; HOME_STATE *state; WCHAR dpiText[16]; DWORD expectedDpi = 0, digit;
    (void)window; (void)message; (void)time;
    if (!home) return;
    KillTimer(NULL, timer); ++homeInspections;
    state = (HOME_STATE *)GetWindowLongPtrW(home, GWLP_USERDATA);
    for (i = 0; i < sizeof(ids) / sizeof(ids[0]); ++i) if (!GetDlgItem(home, ids[i])) controls = FALSE;
    check(controls && GetDlgItem(home, HOME_SESSION_LIST), "the actual home page creates every workflow control");
    check(!GetDlgItem(home, HOME_SCRIPT_URL) && !GetDlgItem(home, HOME_SCRIPT_CHECK),
        "multi-browser homepage has no script URL or PowerShell input");
    icon = LoadIconW(home_instance, MAKEINTRESOURCEW(CX_RESOURCE_APP_ICON));
    check(icon && (HICON)SendMessageW(home, WM_GETICON, ICON_SMALL, 0) == icon
        && (HICON)GetClassLongPtrW(home, GCLP_HICON) == icon, "home window and class use the embedded application icon");
    edge = GetDlgItem(home, HOME_EDGE); GetWindowRect(edge, &rect);
    if (GetEnvironmentVariableW(L"CXPLUS_NATIVE_UI_DPI", dpiText, 16)) {
        for (digit = 0; dpiText[digit] >= L'0' && dpiText[digit] <= L'9'; ++digit)
            expectedDpi = expectedDpi * 10 + (DWORD)(dpiText[digit] - L'0');
    }
    check(!expectedDpi || expectedDpi == home_dpi, "home uses the requested DPI test override");
    check(rect.right - rect.left == MulDiv(150, home_dpi, 96), "home controls scale from the active DPI");
    check(showWindows ? IsWindowVisible(home) : !IsWindowVisible(home), "home visibility matches the requested UI smoke mode");
    SendMessageW(home, WM_COMMAND, MAKEWPARAM(HOME_EXAM, BN_CLICKED), 0);
    check(!examCalled && state->examPage && GetDlgItem(home, HOME_SCRIPT_URL)
        && GetDlgItem(home, HOME_EXAM_START), "entering the exam page exposes its optional script input without launching");
    check(!cx_script_lease_active(), "local exam test starts without manufacturing a script lease");
    SendMessageW(home, WM_COMMAND, MAKEWPARAM(HOME_EXAM_START, BN_CLICKED), 0);
    check(examCalled, "empty script URL dispatches the real local exam callback");
    examCalled = FALSE;
    /* The positive UI flow uses an in-memory synthetic exchange receipt; no file
       or command-line setting may manufacture the production grant. */
    home_copy(shared.apiKey, CX_HOME_API_KEY_CAP, L"sr_fixture_verified_session_0123456789");
    cx_script_identity(shared.scriptIdentity, CX_HOME_SCRIPT_IDENTITY_CAP);
    check(cx_grant_capture(&shared.verifiedExam, shared.adapterBaseUrl, shared.apiKey,
        shared.scriptIdentity, L"2099-01-01T00:00:00Z"), "synthetic successful exchange captures a private exam grant");
    SendMessageW(home, WM_COMMAND, MAKEWPARAM(HOME_EXAM_START, BN_CLICKED), 0);
    check(examCalled && state->options == &options && options.sharedSettingsJson[0],
        "returning from the exam page preserves the home options");
    SendMessageW(home, WM_COMMAND, MAKEWPARAM(HOME_EXAM_BACK, BN_CLICKED), 0);
    check(!state->examPage && !GetDlgItem(home, HOME_SCRIPT_URL)
        && IsWindowVisible(GetDlgItem(home, HOME_EDGE)) == showWindows,
        "returning to multi-browser mode removes the exam-only input");
    SendMessageW(home, WM_CLOSE, 0, 0);
}

static DWORD localExamCalls, localPageChecks;
static BOOL self_destruct_exam(CX_OPTIONS *received, WCHAR *error, DWORD cap) {
    (void)error; (void)cap; received->selfDestructCompleted = TRUE; return TRUE;
}
static void self_destruct_home_tests(void) {
    HOME_STATE *state = make_home(); DWORD start;
    state->examRun = self_destruct_exam;
    home_authorized_exam(state);
    check(state->closing, "completed exam self-destruct closes the assistant instead of reopening its homepage");
    start = GetTickCount();
    while (IsWindow(state->window) && GetTickCount() - start < 5000) {
        clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
    }
    check(!IsWindow(state->window), "completed exam self-destruct joins the assistant window cleanup");
    free_home(state);
}
static BOOL test_local_exam(CX_OPTIONS *received, WCHAR *error, DWORD cap) {
    (void)received; (void)error; (void)cap; ++localExamCalls;
    check(!cx_script_lease_active(), "no-address startup reaches the exam callback without a script lease"); return TRUE;
}
static void CALLBACK local_exam_tick(HWND unused, UINT message, UINT_PTR timer, DWORD tick) {
    HWND window = owned_window(HOME_CLASS); HOME_STATE *state;
    (void)unused; (void)message; (void)tick;
    if (!window || !localExamCalls) return;
    KillTimer(NULL, timer); ++localPageChecks;
    state = (HOME_STATE *)GetWindowLongPtrW(window, GWLP_USERDATA);
    check(state->examPage && GetDlgItem(window, HOME_SCRIPT_URL) && !state->deviceId[0]
        && !state->deviceInitialized, "direct exam testing never registers a multi-browser device");
    SendMessageW(window, WM_CLOSE, 0, 0);
}

static BOOL resolve_exam(CX_OPTIONS *received, WCHAR *error, DWORD cap) {
    (void)error; (void)cap; ++resolveExamCalls;
    check(cx_script_lease_active() && cx_script_lease_valid()
        && contains(received->sharedSettingsJson, "sr_fixture_verified_session_0123456789")
        && contains(received->sharedSettingsJson, "common.settings.tiku-adapter.script-identity"),
        "resolved script input reaches the exam callback with the real in-memory lease and special token");
    return TRUE;
}
static void no_window_script_resolve_tests(void) {
    static const WCHAR *inputs[] = { L"https://fixture.invalid/launch",
        L"powershell -c \"iex(irm https://fixture.invalid/launch)\"" };
    CX_HOME_CONFIG *config = HeapAlloc(GetProcessHeap(), 0, sizeof(*config));
    CX_OPTIONS *received = HeapAlloc(GetProcessHeap(), 0, sizeof(*received));
    DWORD i, before, windowsBefore = windowCreateCalls; WCHAR error[512];
    if (!config || !received) ExitProcess(7);
    for (i = 0; i < sizeof(inputs) / sizeof(inputs[0]); ++i) {
        cx_home_config_init(config); cx_options_init(received); before = resolveCalls;
        check(cx_home_config_resolve_script(config, inputs[i], error, 512)
            && resolveCalls == before + 1 && cx_script_lease_active() && cx_script_lease_valid()
            && !lstrcmpW(config->apiKey, L"sr_fixture_verified_session_0123456789")
            && config->verifiedExam.token[0] && config->scriptIdentity[0],
            "silent URL and PowerShell redemption acquires a private script grant without a home window");
        check(cx_home_config_apply_session(config, received, error, 512)
            && contains(received->sharedSettingsJson, "\"cx.new.work.answer-retry\":4")
            && contains(received->sharedSettingsJson, "sr_fixture_verified_session_0123456789")
            && contains(received->sharedSettingsJson, "common.settings.tiku-adapter.script-identity")
            && received->noDiskWrite,
            "silent redemption preserves script parameters and private authentication in runtime options");
        cx_script_lease_stop();
    }
    for (resolveMode = 2; resolveMode <= 3; ++resolveMode) {
        cx_home_config_init(config); home_copy(config->apiKey, CX_HOME_API_KEY_CAP, L"tk_original"); before = resolveCalls;
        check(!cx_home_config_resolve_script(config, inputs[0], error, 512)
            && resolveCalls == before + 1 && !cx_script_lease_active()
            && !lstrcmpW(config->apiKey, L"tk_original") && !config->verifiedExam.token[0],
            "silent rejected redemption leaves credentials unchanged and cannot become an unauthorized launch");
        if (resolveMode == 3) check(!lstrcmpW(error, L"fixture denied"), "silent redemption preserves the server denial reason");
    }
    check(windowCreateCalls == windowsBefore && !owned_window(HOME_CLASS),
        "silent redemption creates zero actual Win32 controls or home windows");
    resolveMode = 0; resolveCalls = 0;
    cx_home_config_clear(config); SecureZeroMemory(received, sizeof(*received));
    HeapFree(GetProcessHeap(), 0, config); HeapFree(GetProcessHeap(), 0, received);
}
static void script_resolve_tests(void) {
    CX_HOME_CONFIG *saved = HeapAlloc(GetProcessHeap(), 0, sizeof(*saved));
    HOME_STATE *state; DWORD start, before; WCHAR text[512];
    if (!saved) ExitProcess(7);
    CopyMemory(saved, &shared, sizeof(shared));
    state = make_home(); state->examRun = resolve_exam;
    home_show_exam(state); SetDlgItemTextW(state->window, HOME_SCRIPT_URL,
        L"powershell -c \"iex(irm https://fixture.invalid/launch)\"");
    SendMessageW(state->window, WM_COMMAND, MAKEWPARAM(HOME_EXAM_START, BN_CLICKED), 0);
    start = GetTickCount();
    while (state->worker && GetTickCount() - start < 5000) { clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT); }
    check(resolveCalls == 1 && resolveExamCalls == 1 && state->operationOK
        && !lstrcmpW(state->resolvedScriptUrl, L"powershell -c \"iex(irm https://fixture.invalid/launch)\""),
        "URL or PowerShell startup resolves a script and automatically starts the exam workflow");
    home_show_main(state); home_show_exam(state);
    GetDlgItemTextW(state->window, HOME_SCRIPT_URL, text, 512);
    check(text[0] && cx_script_lease_active(), "reopening the exam page preserves its input and current authorization");
    cx_script_lease_stop();
    for (resolveMode = 2; resolveMode <= 3; ++resolveMode) {
        before = resolveExamCalls; state->resolvedScriptUrl[0] = 0;
        SendMessageW(state->window, WM_COMMAND, MAKEWPARAM(HOME_EXAM_START, BN_CLICKED), 0);
        start = GetTickCount();
        while (state->worker && GetTickCount() - start < 5000) { clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT); }
        GetWindowTextW(state->status, text, 512);
        check(!state->operationOK && !cx_script_lease_active() && before == resolveExamCalls,
            "cross-origin grant or denied script never starts an exam or creates a lease");
        if (resolveMode == 3) check(!lstrcmpW(text, L"fixture denied"), "server denial message is visible in the exam page");
    }
    resolveMode = 0; home_device_flush_exit(state); free_home(state); CopyMemory(&shared, saved, sizeof(shared));
    SecureZeroMemory(saved, sizeof(*saved)); HeapFree(GetProcessHeap(), 0, saved);
}

static void script_session_tests(void) {
    CX_HOME_CONFIG *config = (CX_HOME_CONFIG *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*config));
    CX_OPTIONS *local = (CX_OPTIONS *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*local));
    HOME_STATE *state; WCHAR identity[65], error[256]; DWORD start;
    if (!config || !local) ExitProcess(3);
    cx_home_config_init(config); cx_options_init(local);
    cx_script_identity(identity, 65); home_copy(config->scriptIdentity, CX_HOME_SCRIPT_IDENTITY_CAP, identity);
    home_copy(config->apiKey, CX_HOME_API_KEY_CAP, L"sr_fixture");
    check(cx_home_config_apply_session(config, local, error, 256) && local->noDiskWrite
        && contains(local->sharedSettingsJson, "\"common.settings.tiku-adapter.key\":\"sr_fixture\"")
        && contains(local->sharedSettingsJson, "\"common.settings.tiku-adapter.script-identity\":")
        && contains(local->sharedSettingsJson, "\"common.settings.tiku-adapter.script-activation-token\":\"\""),
        "activated sessions replace consumed tickets in memory and force no disk writes");
    cx_home_config_clear(config); SecureZeroMemory(local, sizeof(*local));
    HeapFree(GetProcessHeap(), 0, config); HeapFree(GetProcessHeap(), 0, local);
    check(cx_script_lease_start(L"http://127.0.0.1:1", L"/heartbeat", L"sr_fixture", identity,
        L"2099-01-01T00:00:00Z", error, 256), "script lease monitor starts without exposing credentials");
    closedSessions = destroyedSessions = 0;
    state = make_home();
    state->sessions[0].session = (CX_BROWSER_SESSION *)(UINT_PTR)25;
    cx_script_lease_cancel(); home_poll_sessions(state);
    start = GetTickCount();
    while (IsWindow(state->window) && GetTickCount() - start < 5000) {
        clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
    }
    check(!IsWindow(state->window) && closedSessions == 1 && destroyedSessions == 1,
        "a failed script lease closes every owned browser through normal cleanup");
    cx_script_lease_stop();
    check(!cx_script_lease_active(), "shutdown joins and clears the script heartbeat worker");
    free_home(state);
}

static void exam_diagnostic_identity_tests(void) {
    HOME_STATE *state = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*state));
    DWORD i;
    BOOL joined = TRUE;
    if (!state) ExitProcess(8);
    state->config = &shared;
    captureExamDiagnostics = TRUE;
    for (i = 0; i < ARRAYSIZE(diagnosticDevices); ++i) {
        DWORD started;
        /* Reuse the same in-memory home fixture; the first direct launch has no browser host ID. */
        if (i) home_copy(state->deviceId, CX_DEVICE_ID_CAP, L"fixture-browser-host");
        home_owned_launcher_ready(state);
        started = GetTickCount();
        while (InterlockedCompareExchange(&home_diag_running, 0, 0) && GetTickCount() - started < 1500) Sleep(1);
        if (InterlockedCompareExchange(&home_diag_running, 0, 0)) { joined = FALSE; break; }
    }
    captureExamDiagnostics = FALSE;
    check(joined && capturedExamDiagnostics == 2 && !lstrcmpW(state->deviceId, L"fixture-browser-host")
        && lstrlenW(diagnosticDevices[0]) == 36 && lstrlenW(diagnosticDevices[1]) == 36
        && lstrcmpW(diagnosticDevices[0], state->deviceId) && lstrcmpW(diagnosticDevices[1], state->deviceId),
        "authorized exam diagnostics use an independent device even without a browser host");
    check(joined && capturedExamDiagnostics == 2 && lstrcmpW(diagnosticDevices[0], diagnosticDevices[1])
        && lstrlenW(diagnosticLaunches[0]) == 36 && lstrlenW(diagnosticLaunches[1]) == 36
        && lstrcmpW(diagnosticLaunches[0], diagnosticLaunches[1])
        && lstrcmpW(diagnosticLaunches[0], diagnosticDevices[0]) && lstrcmpW(diagnosticLaunches[1], diagnosticDevices[1]),
        "each new authorized exam diagnostic run gets a fresh device and launch identity");
    HeapFree(GetProcessHeap(), 0, state);
}

void HomeTestMain(void) {
    WCHAR text[16]; BOOL ok;
    {
        WCHAR first[128], second[128]; DWORD i; BOOL hex = TRUE;
        home_build_script_identity(first, 128); home_build_script_identity(second, 128);
        for (i = 0; first[i]; ++i) if (!((first[i] >= L'0' && first[i] <= L'9') || (first[i] >= L'a' && first[i] <= L'f'))) hex = FALSE;
        check(lstrlenW(first) == 64 && hex && lstrcmpW(first, second) != 0,
            "script activation uses a fresh 32 byte cryptographic hexadecimal identity");
    }
    text[0] = 0;
    GetEnvironmentVariableW(L"CX_TEST_NATIVE_WINDOW", text, 16); showWindows = text[0] == L'1';
    fetchEntered = CreateEventW(NULL, TRUE, FALSE, NULL); fetchRelease = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!fetchEntered || !fetchRelease) ExitProcess(2);
    cx_options_init(&options); cx_home_config_init(&shared);
    exam_diagnostic_identity_tests();
    /* 测试跑在仓库里，绝不能让 cx_home_run 的启动登记段真的写出
       windows/data/config.json —— 那会在 git status 里留下未跟踪文件。
       noDiskWrite 同时保持了「设备 id 只在内存里」的语义，正好也是要验的一条。
       注意：worker_tests() 内部会把 options.noDiskWrite 复位成 FALSE（它要验
       「缓存遵守磁盘写开关」的正反两态），所以这里必须在 cx_home_run 之前再置一次。 */
    home_instance = GetModuleHandleW(NULL); home_default_font = (HFONT)GetStockObject(DEFAULT_GUI_FONT);
    if (!home_register_class()) ExitProcess(4);
    settings_tests(); dialog_tests(); browser_selection_tests(); worker_tests();
    device_key_tests(); device_injection_tests(); device_report_tests();
    device_status_tests(); device_over_limit_tests(); device_config_path_tests(); device_id_tests();
    script_session_tests();
    no_window_script_resolve_tests();
    script_resolve_tests();
    self_destruct_home_tests();
    if (!SetTimer(NULL, 0, 20, home_tick)) ExitProcess(5);
    options.noDiskWrite = TRUE;
    options.noDiskWriteSet = TRUE;
    ok = cx_home_run(&options, &shared, test_exam, errorText, 512);
    check(ok && homeInspections == 1, "the complete home page exits after asynchronous cleanup");
    cx_home_config_init(&shared); shared.examTestPage = shared.autoStartExam = TRUE;
    if (!SetTimer(NULL, 0, 20, local_exam_tick)) ExitProcess(6);
    ok = cx_home_run(&options, &shared, test_local_exam, errorText, 512);
    check(ok && localExamCalls == 1 && localPageChecks == 1,
        "direct no-address test mode starts once and remains usable after the exam workflow returns");
    CloseHandle(fetchEntered); CloseHandle(fetchRelease);
    cx_home_config_clear(&shared); cx_home_config_clear(&separate);
    output(failures ? "NATIVE HOME TESTS FAIL\n" : "NATIVE HOME TESTS PASS\n");
    ExitProcess(failures ? 1 : 0);
}
