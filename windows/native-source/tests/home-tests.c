#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "../home.h"
#include "../browser-session.h"
#include "../browser-extension.h"
#include "../adapter-account.h"
#include "../account-window.h"

static DWORD failures, browserStarts, networkCalls, closedSessions, destroyedSessions;
static HANDLE fetchEntered, fetchRelease;
static BOOL blockFetch, showWindows;

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
    (void)data; (void)size; (void)id; (void)error; (void)cap; return TRUE;
}

#define ShowWindow test_show_window
#define cx_adapter_extension_fetch test_extension_fetch
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
    options.sharedSettingsLength = (DWORD)lstrlenA(options.sharedSettingsJson);
    check(cx_home_config_apply_options(&shared, &options, errorText, 512)
        && !lstrcmpW(shared.adapterBaseUrl, L"https://saved.example/") && !lstrcmpW(shared.apiKey, L"tk_saved"),
        "homepage inherits the existing adapter address and credentials without replacing them with defaults");
    lstrcpyA(options.sharedSettingsJson, initial); options.sharedSettingsLength = (DWORD)lstrlenA(initial);
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
    SetWindowTextW(GetDlgItem(dialog, SETTINGS_BASE_URL), L"https://adapter.example/");
    SetWindowTextW(GetDlgItem(dialog, SETTINGS_API_KEY), L"tk_separate");
    SetWindowTextW(GetDlgItem(dialog, SETTINGS_JSON), dialogMode == 2 ? L"{" : L"{\"common.settings.session\":true}");
    SendMessageW(GetDlgItem(dialog, SETTINGS_BROWSER), CB_SETCURSEL, 1, 0);
    SendMessageW(dialog, WM_COMMAND, MAKEWPARAM(SETTINGS_SAVE, BN_CLICKED), 0);
    if (dialogMode == 2) {
        check(IsWindow(dialog), "invalid JSON keeps the settings dialog open");
        SendMessageW(dialog, WM_COMMAND, MAKEWPARAM(SETTINGS_CANCEL, BN_CLICKED), 0);
    }
}
static void dialog_tests(void) {
    HOME_STATE *state = make_home(); BOOL accepted;
    home_copy(shared.apiKey, CX_HOME_API_KEY_CAP, L"tk_shared");
    dialogMode = 1;
    if (!SetTimer(NULL, 0, 20, dialog_tick)) ExitProcess(5);
    accepted = home_settings_dialog(state, FALSE, L"edge", &separate, browserKind, 16);
    check(accepted && !lstrcmpW(separate.apiKey, L"tk_separate") && !lstrcmpW(browserKind, L"chrome"),
        "separate settings return the chosen browser and session credentials");
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
    (void)error; (void)errorCap; examCalled = TRUE;
    check(received != &options && contains(received->sharedSettingsJson, "common.settings.tiku-adapter.key"),
        "exam page receives a private options copy with the current shared settings");
    received->sharedSettingsJson[0] = 0; return TRUE;
}
static void CALLBACK home_tick(HWND window, UINT message, UINT_PTR timer, DWORD time) {
    HWND home = owned_window(HOME_CLASS); HWND edge; RECT rect; HICON icon; DWORD i;
    const int ids[] = { HOME_EDGE, HOME_CHROME, HOME_SEPARATE, HOME_CLOSE_SESSION, HOME_SETTINGS, HOME_ACCOUNT, HOME_EXAM, HOME_UPDATE };
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
    check(rect.right - rect.left == MulDiv(120, home_dpi, 96), "home controls scale from the active DPI");
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
    settings_tests(); dialog_tests(); worker_tests();
    if (!SetTimer(NULL, 0, 20, home_tick)) ExitProcess(5);
    ok = cx_home_run(&options, &shared, test_exam, errorText, 512);
    check(ok && homeInspections == 1, "the complete home page exits after asynchronous cleanup");
    CloseHandle(fetchEntered); CloseHandle(fetchRelease);
    cx_home_config_clear(&shared); cx_home_config_clear(&separate);
    output(failures ? "NATIVE HOME TESTS FAIL\n" : "NATIVE HOME TESTS PASS\n");
    ExitProcess(failures ? 1 : 0);
}
