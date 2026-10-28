/* Exercise the real host launch/cleanup path without launching a client or UAC. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
DWORD WINAPI test_attributes(LPCWSTR path);
LPWSTR WINAPI test_command_line(void);
#define cx_discovery_scan test_discovery_scan
#define proc_launch test_launch
#define proc_stop_owned test_stop_owned
#define proc_port_bindable test_bindable
#define cx_elevation_can_restart test_can_restart
#define cx_elevation_query test_elevation_query
#define cx_elevation_restart test_restart
#define cx_dpi_begin test_dpi_begin
#define cx_dpi_restore test_dpi_restore
#define cx_select_client test_selection
#define cx_audit_write_report test_report
#define GetFileAttributesW test_attributes
#define GetCommandLineW test_command_line
#define WinMain HostWinMain
#define WinMainCRTStartup HostMainCRTStartup
#include "../host.c"
#undef WinMain
#undef WinMainCRTStartup

static CX_OPTIONS testOptions;
static DWORD scans, selections, launches, reports, failures;
static DWORD launchFailure = ERROR_ELEVATION_REQUIRED;
static WCHAR launchedPath[32768];
static WCHAR *commandLineFixture;
static DWORD restartCalls;
static BOOL restartCancelled;
static DWORD dpiBegins, dpiRestores, stopped, sequence, dpiAt, launchAt, restoreAt;
static BOOL dpiActive, dpiBeginAllowed = TRUE, dpiRestoreAllowed = TRUE;

CX_DPI_OVERRIDE *test_dpi_begin(const WCHAR *client, WCHAR *error, DWORD cap) {
    (void)client; ++dpiBegins; dpiAt = ++sequence;
    if (!dpiBeginAllowed) { h_error(error, cap, L"fixture DPI begin failed"); return NULL; }
    dpiActive = TRUE; return (CX_DPI_OVERRIDE *)99;
}
BOOL test_dpi_restore(CX_DPI_OVERRIDE *state, WCHAR *error, DWORD cap) {
    (void)state; ++dpiRestores; restoreAt = ++sequence; dpiActive = FALSE;
    if (!dpiRestoreAllowed) h_error(error, cap, L"fixture DPI restore failed");
    return dpiRestoreAllowed;
}
DWORD test_stop_owned(DWORD pid) { (void)pid; ++stopped; return 1; }

LPWSTR WINAPI test_command_line(void) { return commandLineFixture; }
BOOL test_elevation_query(BOOL *elevated) { *elevated = FALSE; return TRUE; }
BOOL test_restart(const WCHAR *executable, int argc, WCHAR *const *argv,
                  const WCHAR *client, DWORD *exitCode, WCHAR *error, DWORD cap) {
    (void)executable; (void)error; (void)cap; ++restartCalls;
    if (h_audit || h_config || h_diagnostics || reports || dpiActive || argc != 5
        || lstrcmpW(argv[0], L"--select-client") || lstrcmpW(argv[4], L"child-report.json")
        || lstrcmpW(client, L"D:\\用户选定 客户端\\CXExam.exe")) ExitProcess(4);
    *exitCode = restartCancelled ? 3 : 37; return !restartCancelled;
}

DWORD WINAPI test_attributes(LPCWSTR path) { (void)path; return FILE_ATTRIBUTE_NORMAL; }
BOOL test_discovery_scan(const CX_DISCOVERY_OPTIONS *options, CX_DISCOVERY_RESULT *result,
                         WCHAR *error, DWORD cap) {
    const WCHAR *path = options->clientPath ? options->clientPath : L"C:\\candidate\\CXExam.exe";
    (void)error; (void)cap; ++scans;
    result->items = (CX_CLIENT_CANDIDATE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(CX_CLIENT_CANDIDATE));
    if (!result->items) return FALSE;
    result->count = result->capacity = 1;
    result->items[0].path = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, ((SIZE_T)lstrlenW(path) + 1) * sizeof(WCHAR));
    if (!result->items[0].path) return FALSE;
    lstrcpyW(result->items[0].path, path); result->items[0].machine = CX_DISCOVERY_MACHINE_X86;
    return TRUE;
}
CX_SELECTION_STATUS test_selection(const CX_DISCOVERY_RESULT *result, BOOL hostIs32Bit,
                                   WCHAR *out, DWORD outCap, WCHAR *error, DWORD cap) {
    (void)result; (void)hostIs32Bit; (void)error; (void)cap; ++selections;
    return h_copy(out, outCap, L"D:\\用户选定 客户端\\CXExam.exe") ? CX_SELECTION_SELECTED : CX_SELECTION_ERROR;
}
BOOL test_bindable(USHORT port, WCHAR *error, DWORD cap) { (void)port; (void)error; (void)cap; return TRUE; }
BOOL test_launch(const WCHAR *path, USHORT port, DWORD *pid, HANDLE *handle, WCHAR *error, DWORD cap) {
    (void)port; ++launches; *pid = 0; *handle = NULL;
    launchAt = ++sequence;
    lstrcpyW(launchedPath, path); h_error(error, cap, L"fixture launch failed");
    if (launchFailure == ERROR_SUCCESS) {
        *pid = 4321; *handle = CreateEventW(NULL, TRUE, TRUE, NULL); return *handle != NULL;
    }
    SetLastError(launchFailure); return FALSE;
}
BOOL test_can_restart(DWORD code, BOOL noElevate, BOOL restarted) {
    if (dpiActive) ExitProcess(4);
    return code == ERROR_ELEVATION_REQUIRED && !noElevate && !restarted;
}
BOOL test_report(CX_AUDIT *audit, const CX_AUDIT_REPORT *report, WCHAR *error, DWORD cap) {
    (void)audit; (void)report; (void)error; (void)cap; ++reports; return TRUE;
}
static void check(BOOL ok, const char *name) {
    h_print_utf8(ok ? "PASS " : "FAIL "); h_print_utf8(name); h_print_utf8("\n"); if (!ok) ++failures;
}
static void reset(void) {
    cx_options_init(&testOptions); cx_options_init(&h_cli_options); cx_options_init(&h_json_options);
    testOptions.logFileEnabled = FALSE; testOptions.quiet = TRUE;
    testOptions.selectClient = TRUE; h_copy(testOptions.ui, CX_OPTIONS_SHORT_CAP, L"gui");
    h_copy(testOptions.reportPath, CX_OPTIONS_PATH_CAP, L"handoff-report-must-not-be-written.json");
    scans = selections = launches = reports = 0; launchFailure = ERROR_ELEVATION_REQUIRED;
    restartCalls = 0; restartCancelled = FALSE;
    dpiBegins = dpiRestores = stopped = sequence = dpiAt = launchAt = restoreAt = 0;
    dpiActive = FALSE; dpiBeginAllowed = dpiRestoreAllowed = TRUE;
}
void __stdcall ElevationHostTestMain(void) {
    BOOL result;
    GetModuleFileNameW(NULL, h_exe_path, HOST_PATH_CAP);
    reset(); result = h_run(&testOptions, h_main_error, HOST_ERROR_CAP);
    check(result && h_needs_elevation && h_client_pid == 0 && !h_report.success,
        "740 requests host handoff without claiming client launch success");
    check(scans == 1 && selections == 1 && launches == 1
        && !lstrcmpW(h_selected_path, L"D:\\用户选定 客户端\\CXExam.exe"), "handoff preserves manual selection");
    check(reports == 0 && !h_audit && !h_config && !h_diagnostics,
        "handoff closes parent resources and skips parent report");
    reset(); testOptions.noElevate = TRUE; result = h_run(&testOptions, h_main_error, HOST_ERROR_CAP);
    check(!result && !h_needs_elevation && launches == 1 && reports == 1,
        "no-elevate keeps ordinary launch failure and writes its failure report");
    reset(); launchFailure = ERROR_ACCESS_DENIED; result = h_run(&testOptions, h_main_error, HOST_ERROR_CAP);
    check(!result && !h_needs_elevation, "non-740 failure never requests UAC");
    reset(); testOptions.selectClient = FALSE; testOptions.clientIndexSet = TRUE; testOptions.clientIndex = 99;
    testOptions.elevated = TRUE; testOptions.elevatedClientSet = TRUE;
    h_copy(testOptions.elevatedClientPath, 32768, L"D:\\原始选择\\CXExam.exe");
    result = h_run(&testOptions, h_main_error, HOST_ERROR_CAP);
    check(!result && !h_needs_elevation && launches == 1 && selections == 0
        && !lstrcmpW(launchedPath, testOptions.elevatedClientPath), "resumed host revalidates selected path without applying index again or reopening GUI");
    reset(); testOptions.elevated = TRUE; result = h_run(&testOptions, h_main_error, HOST_ERROR_CAP);
    check(!result && !h_needs_elevation, "restarted host cannot request another UAC");
    reset(); commandLineFixture = L"host.exe --elevated --elevated-client C:\\fixture\\CXExam.exe --quiet";
    check(HostWinMain(NULL, NULL, NULL, 0) == 2 && !scans && !launches && !restartCalls,
        "forged internal restart marker with ordinary token is rejected before discovery");
    reset(); commandLineFixture = L"host.exe --select-client --no-log --quiet --report child-report.json";
    check(HostWinMain(NULL, NULL, NULL, 0) == 37 && scans == 1 && selections == 1
        && launches == 1 && restartCalls == 1 && !reports, "actual WinMain waits for handoff result and returns child exit code");
    reset(); restartCancelled = TRUE;
    check(HostWinMain(NULL, NULL, NULL, 0) == 3 && restartCalls == 1 && !reports,
        "actual WinMain keeps UAC cancellation distinct from successful launch");
    reset(); testOptions.dpiAware = TRUE; result = h_run(&testOptions, h_main_error, HOST_ERROR_CAP);
    check(result && h_needs_elevation && dpiBegins == 1 && dpiRestores == 1
        && dpiAt < launchAt && launchAt < restoreAt, "DPI original state is restored before 740 handoff decision");
    reset(); testOptions.dpiAware = TRUE; launchFailure = ERROR_ACCESS_DENIED;
    check(!h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && dpiRestores == 1
        && !h_needs_elevation, "ordinary launch failure still restores temporary DPI state");
    reset(); testOptions.dpiAware = TRUE; dpiBeginAllowed = FALSE;
    check(!h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && !launches && !dpiRestores,
        "DPI setup failure never launches the client");
    reset(); testOptions.dpiAware = TRUE; dpiRestoreAllowed = FALSE;
    check(!h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && !h_needs_elevation
        && dpiRestores == 1, "DPI restore failure prevents UAC handoff");
    reset(); testOptions.dpiAware = TRUE; dpiRestoreAllowed = FALSE; launchFailure = ERROR_SUCCESS;
    check(!h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && stopped == 1 && h_report.clientPid == 4321
        && !h_needs_elevation, "DPI restore failure stops only the newly owned client and keeps its PID in report");
    reset(); commandLineFixture = L"host.exe --self-check --dpi-aware --quiet";
    check(HostWinMain(NULL, NULL, NULL, 0) == 0 && !dpiBegins && !launches,
        "self-check never creates a temporary DPI registry override");
    h_print_utf8(failures ? "NATIVE ELEVATION HOST TESTS FAIL\n" : "NATIVE ELEVATION HOST TESTS PASS\n");
    ExitProcess(failures ? 1 : 0);
}
