/* Run the real CMD -> WinMain -> home/host lifecycle against owned external
   boundaries. The home implementation is real: any HWND creation/display is
   counted, then hidden so a regression cannot leave UI on the developer desk. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
HWND WINAPI fixture_create_window(DWORD exStyle, LPCWSTR klass, LPCWSTR title,
    DWORD style, int x, int y, int width, int height, HWND parent, HMENU menu,
    HINSTANCE instance, LPVOID parameter);
BOOL WINAPI fixture_show_window(HWND window, int command);
BOOL WINAPI fixture_alloc_console(void);
BOOL WINAPI fixture_attach_console(DWORD process);
void WINAPI fixture_sleep(DWORD milliseconds);
#define CreateWindowExW fixture_create_window
#define ShowWindow fixture_show_window
#define AllocConsole fixture_alloc_console
#define AttachConsole fixture_attach_console
#define Sleep fixture_sleep
#define cx_discovery_scan fixture_discovery_scan
#define cx_options_load_default fixture_load_default
#define proc_check_instances fixture_check_instances
#define proc_launch fixture_launch
#define proc_launch_env fixture_launch_env
#define proc_stop_owned fixture_stop_owned
#define proc_alive fixture_client_alive
#define proc_port_bindable fixture_port_bindable
#define proc_port_owner_ex fixture_port_owner
#define net_http_get_timeout fixture_http_get
#define cx_wipe_clear_file fixture_clear_file
#define cx_asset_load fixture_asset_load
#define WinMain HostWinMain
#define WinMainCRTStartup HostMainCRTStartup
#include "../host.c"
#undef WinMain
#undef WinMainCRTStartup
/* Keep the actual window procedure and HWND construction in this fixture. */
#include "../home.c"
#undef CreateWindowExW
#undef ShowWindow
#undef AllocConsole
#undef AttachConsole
#undef Sleep

static DWORD windowsCreated, windowShows, scans, launches, consoleAllocations;
static DWORD targetLists, fixtureStarted;
static BOOL clientAlive;
static HWND homeWindow;
static WCHAR scenario[32], outputPath[CX_OPTIONS_PATH_CAP];

HWND WINAPI fixture_create_window(DWORD exStyle, LPCWSTR klass, LPCWSTR title,
    DWORD style, int x, int y, int width, int height, HWND parent, HMENU menu,
    HINSTANCE instance, LPVOID parameter) {
    HWND window;
    BOOL home = klass && (UINT_PTR)klass > 65535 && !lstrcmpW(klass, HOME_CLASS);
    if (home) { ++windowsCreated; style &= ~WS_VISIBLE; }
    window = CreateWindowExW(exStyle, klass, title, style, x, y, width, height,
        parent, menu, instance, parameter);
    if (home) homeWindow = window;
    return window;
}
BOOL WINAPI fixture_show_window(HWND window, int command) {
    WCHAR klass[80];
    if (GetClassNameW(window, klass, 80) && !lstrcmpW(klass, HOME_CLASS)) {
        if (command != SW_HIDE) ++windowShows;
        return ShowWindow(window, SW_HIDE);
    }
    return ShowWindow(window, command);
}
BOOL WINAPI fixture_alloc_console(void) { ++consoleAllocations; return FALSE; }
BOOL WINAPI fixture_attach_console(DWORD process) { (void)process; return FALSE; }
void WINAPI fixture_sleep(DWORD milliseconds) {
    /* This is the real watch loop's final sleep: client exit happens AFTER
       its silent tick, reproducing the ordinary client-exit failure branch. */
    if (targetLists && milliseconds == 20) clientAlive = FALSE;
    Sleep(milliseconds > 20 ? 20 : milliseconds);
}
BOOL fixture_load_default(CX_OPTIONS *options, const WCHAR *exe, WCHAR *error, DWORD cap) {
    (void)exe; (void)error; (void)cap;
    options->noDiskWrite = options->noDiskWriteSet = TRUE;
    options->logFileEnabled = FALSE; options->noDiagnose = TRUE;
    options->injectModeSet = TRUE; lstrcpyW(options->injectMode, L"cdp-port");
    return TRUE;
}
BOOL fixture_discovery_scan(const CX_DISCOVERY_OPTIONS *options, CX_DISCOVERY_RESULT *result,
    WCHAR *error, DWORD cap) {
    static const WCHAR path[] = L"C:\\owned-fixture\\CXExam.exe";
    (void)options; (void)error; (void)cap; ++scans;
    if (!lstrcmpW(scenario, L"no-client")) return TRUE;
    result->items = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*result->items));
    if (!result->items) return FALSE;
    result->items[0].path = HeapAlloc(GetProcessHeap(), 0, sizeof(path));
    if (!result->items[0].path) return FALSE;
    CopyMemory(result->items[0].path, path, sizeof(path));
    result->items[0].machine = CX_DISCOVERY_MACHINE_X86;
    result->count = result->capacity = 1;
    return TRUE;
}
BOOL fixture_check_instances(const WCHAR *path, DWORD *count, WCHAR *error, DWORD cap) {
    (void)path; (void)error; (void)cap; *count = 0; return TRUE;
}
BOOL fixture_launch(const WCHAR *path, USHORT port, DWORD *pid, HANDLE *handle,
    WCHAR *error, DWORD cap) {
    (void)path; (void)port; ++launches; *pid = 0; *handle = NULL;
    if (!lstrcmpW(scenario, L"launch-failure")) {
        h_error(error, cap, L"owned launch failure"); SetLastError(ERROR_ACCESS_DENIED); return FALSE;
    }
    clientAlive = TRUE; *pid = 4321;
    *handle = CreateEventW(NULL, TRUE, TRUE, NULL);
    return *handle != NULL;
}
BOOL fixture_launch_env(const WCHAR *path, USHORT port, BOOL includePort, DWORD *pid,
    HANDLE *handle, WCHAR *error, DWORD cap) {
    (void)includePort; return fixture_launch(path, port, pid, handle, error, cap);
}
DWORD fixture_stop_owned(DWORD pid) { (void)pid; clientAlive = FALSE; return 0; }
BOOL fixture_client_alive(DWORD pid) { return pid == 4321 && clientAlive; }
BOOL fixture_port_bindable(USHORT port, WCHAR *error, DWORD cap) {
    (void)port; (void)error; (void)cap; return TRUE;
}
BOOL fixture_port_owner(USHORT port, DWORD rootPid, DWORD *owner,
    CX_PORT_OWNER_REASON *reason, WCHAR *error, DWORD cap) {
    (void)port; (void)error; (void)cap;
    if (owner) *owner = rootPid;
    if (reason) *reason = CX_PORT_OWNER_VERIFIED;
    return TRUE;
}
BOOL fixture_http_get(USHORT port, const char *path, char **body, DWORD *length,
    DWORD timeout, WCHAR *error, DWORD cap) {
    const char *text = !lstrcmpA(path, "/json/version") ? "{\"Browser\":\"Chrome/75\"}" : "[]";
    (void)port; (void)timeout; (void)error; (void)cap;
    if (!lstrcmpA(path, "/json/list")) ++targetLists;
    *length = (DWORD)lstrlenA(text); *body = HeapAlloc(GetProcessHeap(), 0, *length + 1);
    if (!*body) return FALSE;
    CopyMemory(*body, text, *length + 1); return TRUE;
}
BOOL fixture_clear_file(const WCHAR *path) { (void)path; return TRUE; }
BOOL fixture_asset_load(const WCHAR *name, const WCHAR *overrideDir, char **data,
    DWORD *length, WCHAR *error, DWORD cap) {
    const char *text = !lstrcmpW(name, L"sweetalert2.min.css") ? "body{}" : "true;";
    (void)overrideDir; (void)error; (void)cap;
    *length = (DWORD)lstrlenA(text); *data = HeapAlloc(GetProcessHeap(), 0, *length + 1);
    if (!*data) return FALSE;
    CopyMemory(*data, text, *length + 1); return TRUE;
}

static void CALLBACK stop_regressed_ui(HWND window, UINT message, UINT_PTR timer, DWORD now) {
    (void)window; (void)message;
    if (!homeWindow || !IsWindow(homeWindow)) return;
    if ((launches && !clientAlive) || now - fixtureStarted > 1000) {
        KillTimer(NULL, timer);
        PostMessageW(homeWindow, WM_CLOSE, 0, 0);
    }
}

void __stdcall SilentEntryTestMain(void) {
    UINT_PTR timer; int result; HANDLE output, log; DWORD written; char json[512];
    WCHAR logPath[CX_OPTIONS_PATH_CAP];
    const WCHAR *command = GetCommandLineW(); DWORD i, k; BOOL simulate = FALSE;
    /* Safety is independent of the launcher under test: never execute actual
       cleanup if a caller accidentally uses the fixture as a release EXE. */
    for (i = 0; command[i]; ++i) {
        for (k = 0; L"--silent-delete-simulate"[k] && command[i + k] == L"--silent-delete-simulate"[k]; ++k) { }
        if (!L"--silent-delete-simulate"[k]) { simulate = TRUE; break; }
    }
    if (!simulate ||
        !GetEnvironmentVariableW(L"CX_SILENT_ENTRY_RESULT", outputPath, CX_OPTIONS_PATH_CAP)) ExitProcess(91);
    if (!h_copy(logPath, CX_OPTIONS_PATH_CAP, outputPath) || !h_cat(logPath, CX_OPTIONS_PATH_CAP, L".log")) ExitProcess(93);
    log = CreateFileW(logPath, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (log == INVALID_HANDLE_VALUE) ExitProcess(94);
    SetStdHandle(STD_OUTPUT_HANDLE, log); SetStdHandle(STD_ERROR_HANDLE, log);
    GetEnvironmentVariableW(L"CX_SILENT_ENTRY_SCENARIO", scenario, 32);
    fixtureStarted = GetTickCount();
    timer = SetTimer(NULL, 0, 25, stop_regressed_ui);
    result = HostWinMain(GetModuleHandleW(NULL), NULL, NULL, SW_HIDE);
    if (timer) KillTimer(NULL, timer);
    CloseHandle(log);
    wsprintfA(json, "{\"hostExit\":%d,\"windowsCreated\":%lu,\"windowShows\":%lu,\"scans\":%lu,\"launches\":%lu,\"targetLists\":%lu,\"consoleAllocations\":%lu,\"stopReason\":\"%s\"}",
        result, windowsCreated, windowShows, scans, launches, targetLists, consoleAllocations,
        h_report.stopReason ? h_report.stopReason : "none");
    output = CreateFileW(outputPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (output == INVALID_HANDLE_VALUE) ExitProcess(92);
    WriteFile(output, json, (DWORD)lstrlenA(json), &written, NULL); CloseHandle(output);
    ExitProcess(0);
}
