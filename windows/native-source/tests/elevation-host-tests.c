/* Exercise the real host launch/cleanup path without launching a client or UAC. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
DWORD WINAPI test_attributes(LPCWSTR path);
LPWSTR WINAPI test_command_line(void);
#define cx_discovery_scan test_discovery_scan
#define proc_check_instances test_check_instances
#define proc_launch test_launch
#define proc_launch_env test_launch_env
#define proc_stop_owned test_stop_owned
#define proc_port_bindable test_bindable
#define cx_elevation_can_restart test_can_restart
#define cx_elevation_query test_elevation_query
#define cx_elevation_restart test_restart
#define cx_dpi_begin test_dpi_begin
#define cx_dpi_restore test_dpi_restore
#define cx_select_client test_selection
#define cx_selection_inject_mode test_selection_inject_mode
#define cx_selection_proxy_carrier test_selection_proxy_carrier
#define cx_options_load_default test_load_default
#define cx_home_run test_home
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
static DWORD homeCalls, homeExamCalls;
static BOOL homeInside, homeInvokesExam = TRUE, homeRepeatExam;
static BOOL homeNoPreScan, homeNoPendingElevation, homeExamResult, homeSettingsPreserved;
static const char *homeSettingsFixture;
static CX_OPTIONS transferredOptions;
static CX_OPTIONS transferredCliOptions, homeRoundOptions;
static WCHAR homeExpectedMode[CX_OPTIONS_SHORT_CAP];
static WCHAR homeExpectedCarrier[16];
static const WCHAR *selectionModes[4], *selectionCarriers[4], *selectionPaths[4];
static DWORD modeGetterCalls, carrierGetterCalls, portLaunches, proxyLaunches;
static BOOL launchProxy[8], launchEnvironmentOK, homeFreshOptions, homeSelectedOptions;
static WCHAR launchCarriers[8][16], handoffModes[8][16], handoffCarriers[8][16], handoffPaths[8][CX_OPTIONS_PATH_CAP];

static const WCHAR *selected_mode_value(void) {
    return selections && selections <= 4 && selectionModes[selections - 1] ? selectionModes[selections - 1] : L"cdp-port";
}
static const WCHAR *selected_carrier_value(void) {
    return selections && selections <= 4 && selectionCarriers[selections - 1] ? selectionCarriers[selections - 1] : L"auto";
}

BOOL test_home(CX_OPTIONS *options, CX_HOME_CONFIG *config, CX_HOME_EXAM_RUN examRun,
               WCHAR *error, DWORD cap) {
    BOOL first;
    (void)config; ++homeCalls;
    homeNoPreScan = !scans && !selections && !launches && !restartCalls;
    homeInside = TRUE;
    if (homeSettingsFixture && !cx_options_apply_json_utf8(options, homeSettingsFixture,
        h_len(homeSettingsFixture), error, cap)) ExitProcess(4);
    if (homeInvokesExam) {
        CopyMemory(&homeRoundOptions, options, sizeof(*options));
        homeFreshOptions = !homeRoundOptions.injectModeSet;
        ++homeExamCalls; first = examRun(&homeRoundOptions, error, cap); homeExamResult = first;
        homeSelectedOptions = !modeGetterCalls || (homeRoundOptions.injectModeSet && homeRoundOptions.proxyTargetSet
            && lstrcmpW(homeRoundOptions.injectMode, selected_mode_value()) == 0
            && lstrcmpW(homeRoundOptions.proxyTarget, selected_carrier_value()) == 0);
        homeNoPendingElevation = !h_needs_elevation && h_exit_code == 0;
        if (homeRepeatExam) {
            CopyMemory(&homeRoundOptions, options, sizeof(*options));
            homeFreshOptions = homeFreshOptions && !homeRoundOptions.injectModeSet;
            h_copy(homeExpectedMode, CX_OPTIONS_SHORT_CAP, selectionModes[1] ? selectionModes[1] : L"cdp-port");
            h_copy(homeExpectedCarrier, 16, selectionCarriers[1] ? selectionCarriers[1] : L"auto");
            restartCancelled = FALSE; ++homeExamCalls;
            homeExamResult = examRun(&homeRoundOptions, error, cap);
            homeSelectedOptions = homeSelectedOptions && (!modeGetterCalls || (homeRoundOptions.injectModeSet && homeRoundOptions.proxyTargetSet
                && lstrcmpW(homeRoundOptions.injectMode, selected_mode_value()) == 0
                && lstrcmpW(homeRoundOptions.proxyTarget, selected_carrier_value()) == 0));
            homeNoPendingElevation = homeNoPendingElevation && !h_needs_elevation && h_exit_code == 0;
        }
    }
    homeInside = FALSE;
    /* Closing the primary page succeeds even after a secondary action failed. */
    return TRUE;
}

BOOL test_load_default(CX_OPTIONS *options, const WCHAR *exePath, WCHAR *error, DWORD cap) {
    (void)exePath;
    options->logFileEnabled = FALSE;
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
            || processChecks || dpiBegins || homeCalls || client != NULL || argc != (int)expectedRestartArgc
            || (argc && lstrcmpW(argv[0], L"--elevate-on-start"))) ExitProcess(4);
        *exitCode = restartCancelled ? 3 : 37; return !restartCancelled;
    }
    if (homeInside) {
        WCHAR **original, *carrierArgs[2]; int originalCount, i; char *json;
        if (h_audit || h_config || h_diagnostics || reports || dpiActive || h_needs_elevation || !launches
            || !client || lstrcmpW(client, launchedPath)) ExitProcess(4);
        original = CommandLineToArgvW(commandLineFixture, &originalCount);
        if (!original || argc != originalCount + 3) ExitProcess(4);
        for (i = 1; i < originalCount; ++i) if (lstrcmpW(original[i], argv[i - 1])) ExitProcess(4);
        LocalFree(original);
        if (lstrcmpW(argv[argc - 4], L"--options-json") || lstrcmpW(argv[argc - 2], L"--proxy-target")) ExitProcess(4);
        json = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_OPTIONS_JSON_CAP + 256);
        if (!json || !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[argc - 3], -1,
            json, CX_OPTIONS_JSON_CAP + 256, NULL, NULL)) ExitProcess(4);
        cx_options_init(&transferredOptions);
        homeSettingsPreserved = cx_options_apply_json_utf8(&transferredOptions, json,
            h_len(json), error, cap) && lstrcmpW(transferredOptions.injectMode, homeExpectedMode) == 0;
        cx_options_init(&transferredCliOptions);
        carrierArgs[0] = argv[argc - 2]; carrierArgs[1] = argv[argc - 1];
        homeSettingsPreserved = homeSettingsPreserved && cx_options_parse_cli(&transferredCliOptions, 2, carrierArgs, error, cap)
            && cx_options_merge(&transferredOptions, &transferredCliOptions, error, cap)
            && transferredOptions.proxyTargetSet && lstrcmpW(transferredOptions.proxyTarget, homeExpectedCarrier) == 0;
        if (restartCalls <= 8) {
            h_copy(handoffModes[restartCalls - 1], 16, transferredOptions.injectMode);
            h_copy(handoffCarriers[restartCalls - 1], 16, transferredOptions.proxyTarget);
            h_copy(handoffPaths[restartCalls - 1], CX_OPTIONS_PATH_CAP, client);
        }
        if (homeSettingsFixture) {
            static JT tokens[256]; char value[256]; int object;
            if (jparse(json, h_len(json), tokens, 256) <= 0) ExitProcess(4);
            object = jkey(json, tokens, 0, "settings");
            homeSettingsPreserved = homeSettingsPreserved
                && jint(json, tokens, jkey(json, tokens, object, "cx.new.work.answer-retry"), -1) == 7
                && jstr(json, tokens, jkey(json, tokens, object, "common.settings.tikuAdapterApiKey"), value, sizeof(value))
                && lstrcmpA(value, "tk_quote\"slash\\中文") == 0;
        }
        SecureZeroMemory(json, CX_OPTIONS_JSON_CAP + 256); HeapFree(GetProcessHeap(), 0, json);
        if (!homeSettingsPreserved) ExitProcess(4);
        *exitCode = restartCancelled ? 3 : 0; return !restartCancelled;
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
                                   const WCHAR *notice, BOOL explainReasons,
                                   WCHAR *out, DWORD outCap, WCHAR *error, DWORD cap) {
    (void)result; (void)hostIs32Bit; (void)explainReasons; (void)error; (void)cap; ++selections;
    lastSelectionNotice = notice;
    if (requestScanAll && selections == 1) return CX_SELECTION_SCAN_ALL;
    if (selectionCancelled) return CX_SELECTION_CANCELLED;
    return h_copy(out, outCap, selections <= 4 && selectionPaths[selections - 1] ? selectionPaths[selections - 1] : L"D:\\用户选定 客户端\\CXExam.exe") ? CX_SELECTION_SELECTED : CX_SELECTION_ERROR;
}
const WCHAR *test_selection_inject_mode(void) {
    ++modeGetterCalls; return selected_mode_value();
}
const WCHAR *test_selection_proxy_carrier(void) {
    ++carrierGetterCalls; return selected_carrier_value();
}
BOOL test_bindable(USHORT port, WCHAR *error, DWORD cap) { (void)port; (void)error; (void)cap; return TRUE; }
static BOOL test_do_launch(const WCHAR *path, USHORT port, BOOL proxy, DWORD *pid, HANDLE *handle, WCHAR *error, DWORD cap) {
    (void)port; ++launches; *pid = 0; *handle = NULL;
    if (launches <= 8) { launchProxy[launches - 1] = proxy; h_copy(launchCarriers[launches - 1], 16, h_proxy_target); }
    launchAt = ++sequence;
    lstrcpyW(launchedPath, path); h_error(error, cap, L"fixture launch failed");
    if (launchFailure == ERROR_SUCCESS) {
        *pid = 4321; *handle = CreateEventW(NULL, TRUE, TRUE, NULL); return *handle != NULL;
    }
    SetLastError(launchFailure); return FALSE;
}
BOOL test_launch(const WCHAR *path, USHORT port, DWORD *pid, HANDLE *handle, WCHAR *error, DWORD cap) {
    WCHAR value[32]; ++portLaunches;
    if (GetEnvironmentVariableW(L"CX_INJECT_PORT", value, 32) || GetEnvironmentVariableW(L"CX_PROXY_SETTINGS_ONLY", value, 32)) launchEnvironmentOK = FALSE;
    return test_do_launch(path, port, FALSE, pid, handle, error, cap);
}
BOOL test_launch_env(const WCHAR *path, USHORT port, BOOL includePortArgument, DWORD *pid, HANDLE *handle, WCHAR *error, DWORD cap) {
    WCHAR value[32]; ++proxyLaunches;
    if (includePortArgument || !GetEnvironmentVariableW(L"CX_INJECT_PORT", value, 32) || !GetEnvironmentVariableW(L"CX_PROXY_SETTINGS_ONLY", value, 32) || lstrcmpW(value, L"1")) launchEnvironmentOK = FALSE;
    return test_do_launch(path, port, TRUE, pid, handle, error, cap);
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
    DWORD i;
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
    homeCalls = homeExamCalls = 0; homeInside = homeRepeatExam = FALSE; homeInvokesExam = TRUE;
    homeNoPreScan = homeNoPendingElevation = homeExamResult = homeSettingsPreserved = FALSE; homeSettingsFixture = NULL;
    h_copy(homeExpectedMode, CX_OPTIONS_SHORT_CAP, L"cdp-port"); h_copy(homeExpectedCarrier, 16, L"auto");
    for (i = 0; i < 4; ++i) { selectionModes[i] = NULL; selectionCarriers[i] = NULL; selectionPaths[i] = NULL; }
    ZeroMemory(launchProxy, sizeof(launchProxy)); ZeroMemory(launchCarriers, sizeof(launchCarriers)); ZeroMemory(handoffModes, sizeof(handoffModes)); ZeroMemory(handoffCarriers, sizeof(handoffCarriers)); ZeroMemory(handoffPaths, sizeof(handoffPaths));
    modeGetterCalls = carrierGetterCalls = portLaunches = proxyLaunches = 0;
    launchEnvironmentOK = TRUE; homeFreshOptions = homeSelectedOptions = FALSE;
    h_needs_elevation = FALSE; h_exit_code = 0;
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
    check(HostWinMain(NULL, NULL, NULL, 0) == 0 && homeCalls == 1 && homeExamCalls == 1 && homeNoPreScan
        && !homeExamResult && homeNoPendingElevation && scans == 1 && selections == 1 && launches == 1
        && scannedFullCandidates && firstScanMode == CX_DISCOVERY_SCAN_COMMON
        && !lstrcmpW(launchedPath, L"D:\\用户选定 客户端\\CXExam.exe"),
        "no-argument entry opens the homepage before the secondary common scan despite configured client path or CLI mode");
    reset(); commandLineFixture = L"host.exe"; homeInvokesExam = FALSE;
    check(HostWinMain(NULL, NULL, NULL, 0) == 0 && homeCalls == 1 && !homeExamCalls && homeNoPreScan
        && !scans && !selections && !launches && !restartCalls,
        "closing the homepage without choosing examinations performs no discovery or launch");
    reset(); defaultJson = "{\"scanMode\":\"all\",\"quiet\":true,\"noDiskWrite\":true}";
    commandLineFixture = L"host.exe"; selectionCancelled = TRUE;
    check(HostWinMain(NULL, NULL, NULL, 0) == 0 && homeCalls == 1 && homeNoPreScan && homeNoPendingElevation
        && scans == 1 && selections == 1 && !launches
        && firstScanMode == CX_DISCOVERY_SCAN_COMMON,
        "secondary common scan overrides configured recursive mode and cancellation returns to the homepage");
    reset(); defaultJson = "{\"clientFirst\":true,\"ui\":\"cli\",\"quiet\":true,\"noDiskWrite\":true}";
    commandLineFixture = L"host.exe"; selectionCancelled = TRUE; launchFailure = ERROR_ACCESS_DENIED;
    check(HostWinMain(NULL, NULL, NULL, 0) == 0 && homeCalls == 1 && homeNoPreScan && homeNoPendingElevation
        && scans == 1 && selections == 1 && !launches
        && scannedFullCandidates && !restartCalls,
        "secondary selection cancellation returns to the homepage without launching the configured client");
    reset(); defaultJson = "{\"clientFirst\":true,\"quiet\":true,\"noDiskWrite\":true}";
    commandLineFixture = L"host.exe"; emptyCandidates = selectionCancelled = TRUE;
    check(HostWinMain(NULL, NULL, NULL, 0) == 0 && homeCalls == 1 && homeNoPreScan && homeNoPendingElevation
        && scans == 1 && selections == 1 && !launches
        && scannedFullCandidates && !restartCalls,
        "secondary selection allows browsing with no candidates and cancellation returns to the homepage");
    reset(); defaultJson = "{\"clientPath\":\"C:\\\\Configured\\\\CXExam.exe\",\"noDiskWrite\":true}";
    commandLineFixture = L"host.exe --quiet"; launchFailure = ERROR_ACCESS_DENIED;
    check(HostWinMain(NULL, NULL, NULL, 0) == 1 && !homeCalls && scans == 1 && !selections && launches == 1
        && !lstrcmpW(launchedPath, L"C:\\Configured\\CXExam.exe"),
        "any user argument preserves configured direct-client selection semantics");
    reset(); defaultJson = "{\"clientPath\":\"C:\\\\Configured\\\\CXExam.exe\",\"noDiskWrite\":true}";
    commandLineFixture = L"host.exe --client D:\\Explicit\\CXExam.exe --quiet"; launchFailure = ERROR_ACCESS_DENIED;
    check(HostWinMain(NULL, NULL, NULL, 0) == 1 && !homeCalls && scans == 1 && !selections && launches == 1
        && !lstrcmpW(launchedPath, L"D:\\Explicit\\CXExam.exe"),
        "explicit client arguments retain direct launch without GUI");
    reset(); defaultJson = "{\"quiet\":true,\"noDiskWrite\":true}";
    commandLineFixture = L"host.exe";
    homeSettingsFixture = "{\"injectMode\":\"cdp-port\",\"settings\":{\"common.settings.tikuAdapterApiKey\":\"tk_quote\\\"slash\\\\中文\",\"cx.new.work.answer-retry\":7}}";
    check(HostWinMain(NULL, NULL, NULL, 0) == 0 && homeCalls == 1 && homeNoPreScan && homeExamResult
        && homeNoPendingElevation && homeSettingsPreserved && scans == 1 && selections == 1
        && launches == 1 && restartCalls == 1 && scannedFullCandidates
        && !lstrcmpW(h_selected_path, L"D:\\用户选定 客户端\\CXExam.exe"),
        "secondary 740 immediately hands off its selected path with shared settings and injection mode JSON");
    reset(); defaultJson = "{\"quiet\":true,\"noDiskWrite\":true}"; commandLineFixture = L"host.exe"; restartCancelled = TRUE;
    check(HostWinMain(NULL, NULL, NULL, 0) == 0 && homeCalls == 1 && homeExamCalls == 1
        && homeNoPreScan && !homeExamResult && homeNoPendingElevation && restartCalls == 1
        && !h_needs_elevation && !reports,
        "secondary UAC cancellation returns to the homepage without a pending restart flag");
    reset(); defaultJson = "{\"quiet\":true,\"noDiskWrite\":true}"; commandLineFixture = L"host.exe";
    restartCancelled = homeRepeatExam = TRUE;
    check(HostWinMain(NULL, NULL, NULL, 0) == 0 && homeCalls == 1 && homeExamCalls == 2 && homeExamResult
        && homeNoPreScan && homeNoPendingElevation && restartCalls == 2 && launches == 2 && !h_needs_elevation,
        "the same homepage can retry examinations after cancelled UAC without leaking restart state");
    reset(); defaultJson = "{\"quiet\":true,\"noDiskWrite\":true}"; commandLineFixture = L"host.exe";
    selectionModes[0] = L"dll-proxy"; selectionCarriers[0] = L"version"; selectionPaths[0] = L"D:\\第一轮 代理\\CXExam.exe";
    selectionModes[1] = L"cdp-port"; selectionCarriers[1] = L"auto"; selectionPaths[1] = L"E:\\第二轮 端口\\CXExam.exe";
    h_copy(homeExpectedMode, CX_OPTIONS_SHORT_CAP, L"dll-proxy"); h_copy(homeExpectedCarrier, 16, L"version");
    restartCancelled = homeRepeatExam = TRUE;
    check(HostWinMain(NULL, NULL, NULL, 0) == 0 && homeCalls == 1 && homeExamCalls == 2 && homeExamResult
        && homeFreshOptions && homeSelectedOptions && modeGetterCalls == 2 && carrierGetterCalls == 2
        && homeNoPendingElevation && restartCalls == 2 && launches == 2 && proxyLaunches == 1 && portLaunches == 1
        && launchProxy[0] && !launchProxy[1] && launchEnvironmentOK
        && !lstrcmpW(launchCarriers[0], L"version") && !lstrcmpW(launchCarriers[1], L"winmm")
        && !lstrcmpW(handoffModes[0], L"dll-proxy") && !lstrcmpW(handoffCarriers[0], L"version")
        && !lstrcmpW(handoffModes[1], L"cdp-port") && !lstrcmpW(handoffCarriers[1], L"auto")
        && !lstrcmpW(handoffPaths[0], selectionPaths[0]) && !lstrcmpW(handoffPaths[1], selectionPaths[1])
        && !h_dll_proxy_mode && !h_needs_elevation,
        "the same homepage preserves each GUI mode carrier and selected path across cancelled proxy UAC then port UAC");
    reset(); selectionCancelled = TRUE; h_dll_proxy_mode = h_gui_mode_chosen = h_proxy_auto_installed = TRUE;
    h_copy(h_gui_inject_mode, 16, L"dll-proxy"); h_copy(h_gui_proxy_carrier, 16, L"version"); h_copy(h_proxy_target, 16, L"version");
    h_copy(h_pipe_extra_args, 512, L"previous-run-arguments");
    check(h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && h_exit_code == 3 && !launches
        && !h_dll_proxy_mode && !h_proxy_auto_installed && !h_gui_mode_chosen && !h_gui_inject_mode[0]
        && !h_gui_proxy_carrier[0] && !h_pipe_extra_args[0] && !lstrcmpW(h_proxy_target, L"winmm")
        && !modeGetterCalls && !carrierGetterCalls && !h_needs_elevation,
        "cancelled secondary selection clears previous proxy GUI carrier and pipe state before returning");
    selectionCancelled = FALSE;
    h_copy(testOptions.pipeExtraArgs, 512, L"fresh-round-arguments");
    check(h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && h_needs_elevation && portLaunches == 1 && !proxyLaunches
        && !h_dll_proxy_mode && modeGetterCalls == 1 && carrierGetterCalls == 1 && launchEnvironmentOK
        && !lstrcmpW(h_pipe_extra_args, L"fresh-round-arguments"),
        "retry after cancelled selection uses the fresh GUI port mode instead of a previous proxy");
    reset(); testOptions.injectModeSet = testOptions.proxyTargetSet = TRUE;
    h_copy(testOptions.injectMode, CX_OPTIONS_SHORT_CAP, L"cdp-port"); h_copy(testOptions.proxyTarget, 16, L"winmm");
    selectionModes[0] = L"dll-proxy"; selectionCarriers[0] = L"version";
    check(h_run(&testOptions, h_main_error, HOST_ERROR_CAP) && h_needs_elevation && portLaunches == 1 && !proxyLaunches
        && !lstrcmpW(testOptions.injectMode, L"cdp-port") && !lstrcmpW(testOptions.proxyTarget, L"winmm"),
        "an explicit injection mode and carrier retain priority over GUI defaults");
    reset(); commandLineFixture = L"host.exe --client \"D:\\用户选定 客户端\\CXExam.exe\" --quiet";
    testOptions.selectClient = FALSE; testOptions.clientPathSet = TRUE;
    h_copy(testOptions.clientPath, CX_OPTIONS_PATH_CAP, L"D:\\用户选定 客户端\\CXExam.exe"); homeInside = TRUE;
    check(h_home_exam(&testOptions, h_main_error, HOST_ERROR_CAP) && homeSettingsPreserved && restartCalls == 1
        && portLaunches == 1 && !proxyLaunches && !modeGetterCalls && !carrierGetterCalls
        && !testOptions.injectModeSet && !lstrcmpW(handoffModes[0], L"cdp-port") && !h_needs_elevation,
        "unset injection mode without GUI hands off actual cdp-port instead of promoting default auto");
    homeInside = FALSE; transferredOptions.logFileEnabled = FALSE; transferredOptions.quiet = TRUE;
    transferredOptions.clientPathSet = TRUE; transferredOptions.elevated = TRUE; transferredOptions.noDiskWrite = TRUE;
    h_copy(transferredOptions.clientPath, CX_OPTIONS_PATH_CAP, testOptions.clientPath); launchFailure = ERROR_ACCESS_DENIED;
    check(!h_run(&transferredOptions, h_main_error, HOST_ERROR_CAP) && portLaunches == 2 && !proxyLaunches
        && !launchProxy[1] && !h_dll_proxy_mode && launchEnvironmentOK,
        "replaying the default port UAC handoff keeps cdp-port even when an installed proxy is present");
    reset(); commandLineFixture = L"host.exe --data-dir \"D:\\原参数 目录\\资料\" --answer-key Ctrl+F8 --quiet";
    homeInside = TRUE;
    check(h_home_exam(&testOptions, h_main_error, HOST_ERROR_CAP) && restartCalls == 1 && homeSettingsPreserved
        && !h_needs_elevation && h_exit_code == 0,
        "secondary administrator handoff preserves every original argument before appending options JSON");
    homeInside = FALSE;
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
    check(HostWinMain(NULL, NULL, NULL, 0) == 0 && homeCalls == 1 && homeNoPreScan && homeNoPendingElevation
        && !restartCalls && tokenQueries == 1
        && scans == 1 && selections == 1 && launches == 1 && firstScanMode == CX_DISCOVERY_SCAN_COMMON,
        "already elevated standalone startup opens the homepage before secondary selection without another UAC");
    reset(); commandLineFixture = L"host.exe --elevate-on-start --elevated";
    tokenElevated = TRUE; launchFailure = ERROR_ACCESS_DENIED;
    check(HostWinMain(NULL, NULL, NULL, 0) == 0 && homeCalls == 1 && homeNoPreScan && homeNoPendingElevation
        && !restartCalls && tokenQueries == 1
        && scans == 1 && selections == 1 && launches == 1 && firstScanMode == CX_DISCOVERY_SCAN_COMMON,
        "verified early restart opens the homepage instead of silently choosing a client");
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
