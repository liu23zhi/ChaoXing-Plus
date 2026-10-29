/* Exercise the real host launch/cleanup path without launching a client or UAC. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
DWORD WINAPI test_attributes(LPCWSTR path);
LPWSTR WINAPI test_command_line(void);
#define cx_discovery_scan test_discovery_scan
#define proc_check_instances test_check_instances
#define proc_launch test_launch
#define proc_stop_owned test_stop_owned
#define proc_port_bindable test_bindable
#define cx_elevation_can_restart test_can_restart
#define cx_elevation_query test_elevation_query
#define cx_elevation_restart test_restart
#define cx_dpi_begin test_dpi_begin
#define cx_dpi_restore test_dpi_restore
#define cx_select_client test_selection
#define cx_options_load_default test_load_default
#define cx_audit_write_report test_report
#define net_http_get_timeout test_http_get_timeout
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
static DWORD processChecks, existingCount;
static BOOL inspectionAllowed = TRUE;
static const char *defaultJson;
static BOOL selectionCancelled, scannedFullCandidates, emptyCandidates;
static BOOL requestScanAll, failFullScan, cancelFullScan, explicitFullScanPolicies;
static CX_DISCOVERY_SCAN_MODE firstScanMode, lastScanMode;
static DWORD expectedRestartArgc = 5;
static BOOL earlyRestartExpected, tokenElevated, tokenAvailable = TRUE;
static DWORD tokenQueries;

BOOL test_load_default(CX_OPTIONS *options, const WCHAR *exePath, WCHAR *error, DWORD cap) {
    (void)exePath;
    return !defaultJson || cx_options_apply_json_utf8(options, defaultJson, h_len(defaultJson), error, cap);
}

BOOL test_check_instances(const WCHAR *path, DWORD *count, WCHAR *error, DWORD cap) {
    (void)path; ++processChecks; *count = inspectionAllowed ? existingCount : 0;
    if (!inspectionAllowed) h_error(error, cap, L"fixture process inspection failed");
    return inspectionAllowed;
}

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
BOOL test_elevation_query(BOOL *elevated) { ++tokenQueries; *elevated = tokenAvailable && tokenElevated; return tokenAvailable; }
BOOL test_restart(const WCHAR *executable, int argc, WCHAR *const *argv,
                  const WCHAR *client, DWORD *exitCode, WCHAR *error, DWORD cap) {
    (void)executable; (void)error; (void)cap; ++restartCalls;
    if (earlyRestartExpected) {
        if (h_audit || h_config || h_diagnostics || reports || dpiActive || scans || selections || launches
            || processChecks || dpiBegins || client != NULL || argc != (int)expectedRestartArgc
            || (argc && lstrcmpW(argv[0], L"--elevate-on-start"))) ExitProcess(4);
        *exitCode = restartCancelled ? 3 : 37; return !restartCancelled;
    }
    if (h_audit || h_config || h_diagnostics || reports || dpiActive || argc != (int)expectedRestartArgc
        || (argc && (lstrcmpW(argv[0], L"--select-client") || lstrcmpW(argv[4], L"child-report.json")))
        || (argc && lstrcmpW(client, L"D:\\用户选定 客户端\\CXExam.exe"))) ExitProcess(4);
    *exitCode = restartCancelled ? 3 : 37; return !restartCancelled;
}

DWORD WINAPI test_attributes(LPCWSTR path) { (void)path; return FILE_ATTRIBUTE_NORMAL; }
BOOL test_discovery_scan(const CX_DISCOVERY_OPTIONS *options, CX_DISCOVERY_RESULT *result,
                         WCHAR *error, DWORD cap) {
    const WCHAR *path = options->clientPath ? options->clientPath : L"C:\\candidate\\CXExam.exe";
    (void)error; (void)cap; ++scans;
    if (scans == 1) firstScanMode = options->mode;
    lastScanMode = options->mode;
    if (scans > 1 && requestScanAll) {
        explicitFullScanPolicies = options->mode == CX_DISCOVERY_SCAN_ALL && options->enumerateAll
            && options->rescan && options->noScanCache && !options->clientPath
            && options->noDiskWrite == testOptions.noDiskWrite;
        if (failFullScan) { h_error(error, cap, L"fixture full scan failed"); return FALSE; }
        if (cancelFullScan) { result->cancelled = TRUE; return TRUE; }
    }
    scannedFullCandidates = !options->clientPath && options->enumerateAll;
    if (emptyCandidates) return TRUE;
    result->items = (CX_CLIENT_CANDIDATE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(CX_CLIENT_CANDIDATE));
    if (!result->items) return FALSE;
    result->count = result->capacity = 1;
    result->items[0].path = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, ((SIZE_T)lstrlenW(path) + 1) * sizeof(WCHAR));
    if (!result->items[0].path) return FALSE;
    lstrcpyW(result->items[0].path, path); result->items[0].machine = CX_DISCOVERY_MACHINE_X86;
    return TRUE;
}
static const WCHAR *lastSelectionNotice;
CX_SELECTION_STATUS test_selection(const CX_DISCOVERY_RESULT *result, BOOL hostIs32Bit,
                                   const WCHAR *notice, WCHAR *out, DWORD outCap, WCHAR *error, DWORD cap) {
    (void)result; (void)hostIs32Bit; (void)error; (void)cap; ++selections;
    lastSelectionNotice = notice;
    if (requestScanAll && selections == 1) return CX_SELECTION_SCAN_ALL;
    if (selectionCancelled) return CX_SELECTION_CANCELLED;
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
BOOL test_http_get_timeout(USHORT port, const char *path, char **body, DWORD *length,
                           DWORD timeoutMs, WCHAR *error, DWORD cap) {
    (void)port; (void)path; (void)timeoutMs;
    *body = NULL; *length = 0; h_error(error, cap, L"fixture blocks HTTP without network I/O"); return FALSE;
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
    processChecks = existingCount = 0; inspectionAllowed = TRUE;
    defaultJson = NULL; selectionCancelled = scannedFullCandidates = emptyCandidates = FALSE; expectedRestartArgc = 5;
    requestScanAll = failFullScan = cancelFullScan = explicitFullScanPolicies = FALSE; lastSelectionNotice = NULL;
    firstScanMode = lastScanMode = CX_DISCOVERY_SCAN_FALLBACK_ALL;
    h_default_gui = FALSE;
    earlyRestartExpected = tokenElevated = FALSE; tokenAvailable = TRUE; tokenQueries = 0;
}
static void test_diagnostics_cleanup(void) {
    static WCHAR temp[HOST_PATH_CAP], root[HOST_PATH_CAP], run[HOST_PATH_CAP], file[HOST_PATH_CAP], keep[HOST_PATH_CAP];
    static const WCHAR *const names[] = {
        L"render-diagnostics.json", L"render-diagnostics-page.png", L"window-diagnostics.json",
        L"window-capture.bmp", L"window-capture.png", L"render-diagnostics-host.json"
    };
    DWORD length, i;
    HANDLE handle;
    BOOL ok = TRUE;
    length = GetTempPathW(HOST_PATH_CAP, temp);
    check(length > 0 && length < HOST_PATH_CAP, "temporary directory is available for diagnostics cleanup");
    if (!length || length >= HOST_PATH_CAP || !GetTempFileNameW(temp, L"cxc", 0, root)) return;
    check(TRUE, "temporary diagnostics root is created");
    DeleteFileW(root);
    CreateDirectoryW(root, NULL);
    lstrcpynW(run, root, HOST_PATH_CAP); lstrcatW(run, L"\\run");
    CreateDirectoryW(run, NULL);
    for (i = 0; i < sizeof(names) / sizeof(names[0]); ++i) {
        lstrcpynW(file, run, HOST_PATH_CAP); lstrcatW(file, L"\\"); lstrcatW(file, names[i]);
        handle = CreateFileW(file, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);
        if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
        else ok = FALSE;
    }
    check(ok, "diagnostics run directory fixtures are created");
    lstrcpynW(keep, root, HOST_PATH_CAP); lstrcatW(keep, L"\\keep.txt");
    handle = CreateFileW(keep, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle); else ok = FALSE;
    lstrcpynW(h_created_diagnostics_path, run, HOST_PATH_CAP);
    lstrcatW(h_created_diagnostics_path, L"\\render-diagnostics.json");
    h_delete_created_tree(h_created_diagnostics_path);
    h_created_diagnostics_path[0] = 0;
    check(GetFileAttributesW(run) == INVALID_FILE_ATTRIBUTES,
          "recursive diagnostics cleanup removes the whole run directory");
    check(GetFileAttributesW(keep) != INVALID_FILE_ATTRIBUTES,
          "recursive diagnostics cleanup preserves files outside the run directory");
    DeleteFileW(keep);
    RemoveDirectoryW(root);
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
    reset(); testOptions.dpiAware = TRUE; existingCount = 2;
    check(!h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && processChecks == 1
        && !dpiBegins && !launches && !stopped && !h_needs_elevation
        && !lstrcmpA(h_report.stopReason, "client-already-running") && !h_audit && !h_config,
        "existing clients block before DPI and launch without stopping them or requesting UAC");
    reset(); testOptions.dpiAware = TRUE; inspectionAllowed = FALSE;
    check(!h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && processChecks == 1
        && !dpiBegins && !launches && !stopped && !h_needs_elevation
        && !lstrcmpA(h_report.stopReason, "process-check-failed"),
        "failed process inspection blocks before DPI and launch instead of counting zero clients");
    reset(); testOptions.elevated = TRUE; testOptions.elevatedClientSet = TRUE; existingCount = 1;
    h_copy(testOptions.elevatedClientPath, 32768, L"D:\\原始选择\\CXExam.exe");
    check(!h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && processChecks == 1
        && !launches && !stopped && !h_needs_elevation
        && !lstrcmpA(h_report.stopReason, "client-already-running"),
        "resumed UAC host rechecks existing clients before starting the selected path");
    reset(); testOptions.dpiAware = TRUE; launchFailure = ERROR_ALREADY_EXISTS;
    check(!h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && dpiBegins == 1 && dpiRestores == 1
        && dpiAt < launchAt && launchAt < restoreAt && !stopped && !h_needs_elevation,
        "a late existing-client conflict restores DPI and never requests UAC or stops existing clients");
    reset(); testOptions.listClients = TRUE; existingCount = 1;
    check(h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && !processChecks && !launches
        && !dpiBegins && !stopped, "listing clients never inspects or alters existing processes");
    reset(); commandLineFixture = L"host.exe --self-check --dpi-aware --quiet";
    check(HostWinMain(NULL, NULL, NULL, 0) == 0 && !dpiBegins && !launches && !processChecks,
        "self-check never creates a DPI override or checks for running client conflicts");
    reset(); defaultJson = "{\"clientPath\":\"C:\\\\Configured\\\\CXExam.exe\",\"ui\":\"cli\",\"quiet\":true,\"noDiskWrite\":true}";
    commandLineFixture = L"host.exe"; launchFailure = ERROR_ACCESS_DENIED;
    check(HostWinMain(NULL, NULL, NULL, 0) == 1 && scans == 1 && selections == 1 && launches == 1
        && scannedFullCandidates && firstScanMode == CX_DISCOVERY_SCAN_COMMON
        && !lstrcmpW(launchedPath, L"D:\\用户选定 客户端\\CXExam.exe"),
        "no-argument entry scans only common directories and opens GUI despite configured client path or CLI mode");
    reset(); defaultJson = "{\"scanMode\":\"all\",\"quiet\":true,\"noDiskWrite\":true}";
    commandLineFixture = L"host.exe"; selectionCancelled = TRUE;
    check(HostWinMain(NULL, NULL, NULL, 0) == 3 && scans == 1 && selections == 1 && !launches
        && firstScanMode == CX_DISCOVERY_SCAN_COMMON,
        "no-argument common scan overrides a configured recursive scan mode");
    reset(); defaultJson = "{\"clientFirst\":true,\"ui\":\"cli\",\"quiet\":true,\"noDiskWrite\":true}";
    commandLineFixture = L"host.exe"; selectionCancelled = TRUE; launchFailure = ERROR_ACCESS_DENIED;
    check(HostWinMain(NULL, NULL, NULL, 0) == 3 && scans == 1 && selections == 1 && !launches
        && scannedFullCandidates && !restartCalls,
        "no-argument GUI cancellation cannot launch the recommended configured client");
    reset(); defaultJson = "{\"clientFirst\":true,\"quiet\":true,\"noDiskWrite\":true}";
    commandLineFixture = L"host.exe"; emptyCandidates = selectionCancelled = TRUE;
    check(HostWinMain(NULL, NULL, NULL, 0) == 3 && scans == 1 && selections == 1 && !launches
        && scannedFullCandidates && !restartCalls,
        "no-argument entry opens GUI browsing even when a quiet configured scan has no candidates");
    reset(); defaultJson = "{\"clientPath\":\"C:\\\\Configured\\\\CXExam.exe\",\"noDiskWrite\":true}";
    commandLineFixture = L"host.exe --quiet"; launchFailure = ERROR_ACCESS_DENIED;
    check(HostWinMain(NULL, NULL, NULL, 0) == 1 && scans == 1 && !selections && launches == 1
        && !lstrcmpW(launchedPath, L"C:\\Configured\\CXExam.exe"),
        "any user argument preserves configured direct-client selection semantics");
    reset(); defaultJson = "{\"clientPath\":\"C:\\\\Configured\\\\CXExam.exe\",\"noDiskWrite\":true}";
    commandLineFixture = L"host.exe --client D:\\Explicit\\CXExam.exe --quiet"; launchFailure = ERROR_ACCESS_DENIED;
    check(HostWinMain(NULL, NULL, NULL, 0) == 1 && scans == 1 && !selections && launches == 1
        && !lstrcmpW(launchedPath, L"D:\\Explicit\\CXExam.exe"),
        "explicit client arguments retain direct launch without GUI");
    reset(); defaultJson = "{\"quiet\":true,\"noDiskWrite\":true}";
    commandLineFixture = L"host.exe"; expectedRestartArgc = 0;
    check(HostWinMain(NULL, NULL, NULL, 0) == 37 && scans == 1 && selections == 1
        && launches == 1 && restartCalls == 1 && scannedFullCandidates
        && !lstrcmpW(h_selected_path, L"D:\\用户选定 客户端\\CXExam.exe"),
        "no-argument GUI selection hands off its chosen path while preserving an empty original argv");
    reset(); testOptions.elevated = TRUE; testOptions.elevatedClientSet = TRUE;
    h_copy(testOptions.elevatedClientPath, 32768, L"D:\\原始选择\\CXExam.exe");
    check(!h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && launches == 1 && !selections
        && !lstrcmpW(launchedPath, testOptions.elevatedClientPath),
        "verified elevated client selection bypasses a no-argument GUI policy without reopening it");
    reset(); requestScanAll = TRUE; testOptions.noDiskWrite = TRUE; launchFailure = ERROR_ACCESS_DENIED;
    check(!h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && scans == 2 && selections == 2
        && launches == 1 && explicitFullScanPolicies && lastScanMode == CX_DISCOVERY_SCAN_ALL && lastSelectionNotice == NULL,
        "GUI full scan requests an uncached recursive scan and reopens refreshed selection before launch");
    reset(); requestScanAll = cancelFullScan = TRUE; testOptions.noDiskWrite = TRUE; launchFailure = ERROR_ACCESS_DENIED;
    check(!h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && scans == 2 && selections == 2 && launches == 1
        && lastSelectionNotice && !lstrcmpW(lastSelectionNotice, L"已取消全盘扫描，保留原候选；可重试或手动浏览。"),
        "a cancelled recursive scan keeps the selection and reopens it with a cancellation notice");
    reset(); requestScanAll = selectionCancelled = TRUE; testOptions.noDiskWrite = TRUE;
    check(h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && h_exit_code == 3 && scans == 2
        && selections == 2 && !launches && explicitFullScanPolicies,
        "cancelling refreshed full scan selection never launches a client");
    reset(); requestScanAll = failFullScan = TRUE;
    check(!h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && scans == 2 && selections == 1
        && !launches && explicitFullScanPolicies,
        "failed requested full scan stops before any client launch");
    reset(); commandLineFixture = L"host.exe --elevate-on-start";
    earlyRestartExpected = TRUE; expectedRestartArgc = 1;
    check(HostWinMain(NULL, NULL, NULL, 0) == 37 && restartCalls == 1 && tokenQueries == 1
        && !scans && !selections && !launches && !reports && h_default_gui,
        "early elevation hands off before scanning GUI audit or launch and preserves standalone GUI policy");
    reset(); commandLineFixture = L"host.exe --elevate-on-start";
    earlyRestartExpected = restartCancelled = TRUE; expectedRestartArgc = 1;
    check(HostWinMain(NULL, NULL, NULL, 0) == 3 && restartCalls == 1 && !scans && !reports,
        "early UAC cancellation exits three without scanning or writing a parent report");
    reset(); commandLineFixture = L"host.exe";
    defaultJson = "{\"elevateOnStart\":true,\"noDiskWrite\":true}";
    earlyRestartExpected = TRUE; expectedRestartArgc = 0;
    check(HostWinMain(NULL, NULL, NULL, 0) == 37 && restartCalls == 1 && !scans && !reports && h_default_gui,
        "configured early elevation preserves a truly empty argument list and GUI policy");
    reset(); commandLineFixture = L"host.exe --elevate-on-start";
    tokenElevated = TRUE; launchFailure = ERROR_ACCESS_DENIED;
    check(HostWinMain(NULL, NULL, NULL, 0) == 1 && !restartCalls && tokenQueries == 1
        && scans == 1 && selections == 1 && launches == 1 && firstScanMode == CX_DISCOVERY_SCAN_COMMON,
        "already elevated standalone startup continues with common scan and GUI without another UAC");
    reset(); commandLineFixture = L"host.exe --elevate-on-start --elevated";
    tokenElevated = TRUE; launchFailure = ERROR_ACCESS_DENIED;
    check(HostWinMain(NULL, NULL, NULL, 0) == 1 && !restartCalls && tokenQueries == 1
        && scans == 1 && selections == 1 && launches == 1 && firstScanMode == CX_DISCOVERY_SCAN_COMMON,
        "verified early restart retains common scan and GUI instead of silently choosing a client");
    reset(); commandLineFixture = L"host.exe --elevate-on-start --elevated";
    check(HostWinMain(NULL, NULL, NULL, 0) == 2 && !restartCalls && !scans && !launches && tokenQueries == 1,
        "a forged early restart marker cannot replace the administrator token");
    reset(); commandLineFixture = L"host.exe --elevate-on-start"; tokenAvailable = FALSE;
    check(HostWinMain(NULL, NULL, NULL, 0) == 1 && !restartCalls && !scans && !launches,
        "unknown early elevation token fails before scanning or launching");
    reset(); commandLineFixture = L"host.exe --elevate-on-start --no-elevate";
    check(HostWinMain(NULL, NULL, NULL, 0) == 2 && !restartCalls && !scans && !tokenQueries,
        "conflicting early elevation flags fail before inspecting the token");
    {
        WCHAR *readOnly[] = {
            L"host.exe --elevate-on-start --help", L"host.exe --elevate-on-start --capabilities",
            L"host.exe --elevate-on-start --self-check", L"host.exe --elevate-on-start --print-effective-config",
            L"host.exe --elevate-on-start --list-clients --no-disk-write",
            L"host.exe --elevate-on-start --attach 38100 --duration 1 --no-disk-write --quiet"
        };
        DWORD i; BOOL noEarlyUac = TRUE;
        for (i = 0; i < sizeof(readOnly) / sizeof(readOnly[0]); ++i) {
            reset(); commandLineFixture = readOnly[i];
            HostWinMain(NULL, NULL, NULL, 0);
            if (restartCalls || tokenQueries || selections || launches || (i < 5 && reports)) noEarlyUac = FALSE;
        }
        check(noEarlyUac, "read-only and explicit attach actions never request early elevation");
    }
    h_print_utf8(failures ? "NATIVE ELEVATION HOST TESTS FAIL\n" : "NATIVE ELEVATION HOST TESTS PASS\n");
    ExitProcess(failures ? 1 : 0);
}
