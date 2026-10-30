#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "../home.h"
#include "../browser-session.h"
#include "../browser-extension.h"
#include "../adapter-account.h"
#include "../account-window.h"

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
static HANDLE fetchEntered, fetchRelease;
static BOOL blockFetch, showWindows;
static BOOL edgeInstalled = TRUE, chromeInstalled = TRUE, mockCachePackage, rejectFirstVerify;
static BOOL lastCacheNoDiskWrite, lastCachePathMatched;
static DWORD cachedFetches, forcedFetches, verifyCalls;

static BOOL test_show_window(HWND window, int command) {
    return ShowWindow(window, showWindows ? command : SW_HIDE);
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
    (void)session; (void)error; (void)cap; *running = TRUE; return TRUE;
}
static DWORD test_browser_pid(const CX_BROWSER_SESSION *session) { (void)session; return 123; }
static const WCHAR *test_browser_id(const CX_BROWSER_SESSION *session) {
    (void)session; return L"lcmeenlnjihhjcjoakekikoaldigonac";
}
static BOOL test_account_window(HWND parent, CX_HOME_CONFIG *config) { (void)parent; (void)config; return FALSE; }
static BOOL test_extension_verify(const BYTE *data, DWORD size, const WCHAR *id, WCHAR *error, DWORD cap) {
    (void)data; (void)size; (void)id; ++verifyCalls;
    if (rejectFirstVerify && verifyCalls == 1) {
        if (error && cap) lstrcpynW(error, L"Mock cached package signature failure", (int)cap);
        return FALSE;
    }
    return TRUE;
}

#define ShowWindow test_show_window
#define cx_adapter_extension_fetch test_extension_fetch
#define cx_adapter_extension_fetch_cached test_extension_fetch_cached
#define cx_browser_start test_browser_start
#define cx_browser_close test_browser_close
#define cx_browser_destroy test_browser_destroy
#define cx_browser_poll test_browser_poll
#define cx_browser_pid test_browser_pid
#define cx_browser_extension_id test_browser_id
#define cx_account_window test_account_window
#define cx_browser_extension_verify test_extension_verify
#include "../home.c"
#undef ShowWindow

static CX_OPTIONS options;
static CX_HOME_CONFIG shared, separate;
static char settingsOutput[CX_OPTIONS_JSON_CAP];
static WCHAR errorText[512], browserKind[16];
static DWORD dialogMode, dialogInspections, homeInspections;
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
static HOME_STATE *make_home(void) {
    HOME_STATE *state = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*state));
    if (!state) ExitProcess(3);
    state->options = &options; state->config = &shared;
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
    check(GetDlgItem(dialog, SETTINGS_JSON) && !GetDlgItem(dialog, 1501),
        "settings dialog exposes shared JSON and has no local CRX input");
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
    SetWindowTextW(GetDlgItem(dialog, SETTINGS_JSON), dialogMode == 2 ? L"{" : L"{\"common.settings.session\":true}");
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
    if (dialogMode == 2) {
        check(IsWindow(dialog), "invalid JSON keeps the settings dialog open");
        SendMessageW(dialog, WM_COMMAND, MAKEWPARAM(SETTINGS_CANCEL, BN_CLICKED), 0);
    }
}
static void dialog_tests(void) {
    HOME_STATE *state = make_home(); BOOL accepted; DWORD outputLength = 0;
    home_copy(shared.apiKey, CX_HOME_API_KEY_CAP, L"tk_shared");
    dialogMode = 1;
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
    check(contains(settingsOutput, "\"common.settings.session\":true"),
        "advanced JSON settings are retained alongside explicit form fields");
    check(!lstrcmpW(shared.apiKey, L"tk_shared") && !lstrcmpW(shared.settingsJson, L"{}"),
        "separate settings never replace the common configuration");
    dialogMode = 2;
    if (!SetTimer(NULL, 0, 20, dialog_tick)) ExitProcess(5);
    check(!home_settings_dialog(state, TRUE, L"edge", NULL, NULL, 0) && !lstrcmpW(shared.apiKey, L"tk_shared"),
        "cancelling invalid settings preserves the common credentials");
    dialogMode = 3;
    if (!SetTimer(NULL, 0, 20, dialog_tick)) ExitProcess(5);
    check(home_settings_dialog(state, TRUE, L"edge", NULL, NULL, 0)
        && !lstrcmpW(shared.apiKey, L"tk_separate"), "saving common settings applies validated values");
    check(dialogInspections == 3, "all real settings dialogs complete their message loops");
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

static BOOL test_exam(CX_OPTIONS *received, WCHAR *error, DWORD errorCap) {
    char *effective; DWORD length = 0; BOOL merged;
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
    check(examCalled && state->options == &options && options.sharedSettingsJson[0],
        "returning from the exam page preserves the home options");
    SendMessageW(home, WM_CLOSE, 0, 0);
}

void HomeTestMain(void) {
    WCHAR text[16]; BOOL ok;
    text[0] = 0;
    GetEnvironmentVariableW(L"CX_TEST_NATIVE_WINDOW", text, 16); showWindows = text[0] == L'1';
    fetchEntered = CreateEventW(NULL, TRUE, FALSE, NULL); fetchRelease = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!fetchEntered || !fetchRelease) ExitProcess(2);
    cx_options_init(&options); cx_home_config_init(&shared);
    home_instance = GetModuleHandleW(NULL); home_default_font = (HFONT)GetStockObject(DEFAULT_GUI_FONT);
    if (!home_register_class()) ExitProcess(4);
    settings_tests(); dialog_tests(); browser_selection_tests(); worker_tests();
    if (!SetTimer(NULL, 0, 20, home_tick)) ExitProcess(5);
    ok = cx_home_run(&options, &shared, test_exam, errorText, 512);
    check(ok && homeInspections == 1, "the complete home page exits after asynchronous cleanup");
    CloseHandle(fetchEntered); CloseHandle(fetchRelease);
    cx_home_config_clear(&shared); cx_home_config_clear(&separate);
    output(failures ? "NATIVE HOME TESTS FAIL\n" : "NATIVE HOME TESTS PASS\n");
    ExitProcess(failures ? 1 : 0);
}
