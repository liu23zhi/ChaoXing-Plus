/* Exercise the actual host wiring; stop at discovery before any client I/O. */
#define cx_discovery_scan test_cache_discovery
#define WinMain HostWinMain
#define WinMainCRTStartup HostMainCRTStartup
#include "../host.c"
#undef WinMain
#undef WinMainCRTStartup

static CX_OPTIONS testOptions;
static DWORD calls, failures;
static BOOL expectedRescan, expectedNoCache, expectedNoDiskWrite;

static void check(BOOL passed, const char *name) {
    h_print_utf8(passed ? "PASS " : "FAIL "); h_print_utf8(name); h_print_utf8("\n");
    if (!passed) ++failures;
}

BOOL test_cache_discovery(const CX_DISCOVERY_OPTIONS *options, CX_DISCOVERY_RESULT *result,
                          WCHAR *error, DWORD cap) {
    (void)result; ++calls;
    check(options->cachePath && !lstrcmpW(options->cachePath, L"C:\\owned-cache-fixture\\chaoxing\\native-scan-cache-v1.bin"),
        "host passes the native-specific cache path inside the chaoxing data subdirectory");
    check(options->rescan == expectedRescan && options->noScanCache == expectedNoCache
        && options->noDiskWrite == expectedNoDiskWrite, "host preserves all cache policy switches");
    h_error(error, cap, L"fixture stops at discovery"); return FALSE;
}

static void run(BOOL rescan, BOOL noCache, BOOL noDiskWrite, BOOL listClients) {
    BOOL result;
    cx_options_init(&testOptions);
    testOptions.logFileEnabled = FALSE; testOptions.quiet = TRUE;
    testOptions.rescan = rescan; testOptions.noScanCache = noCache;
    testOptions.noDiskWrite = noDiskWrite; testOptions.listClients = listClients;
    h_copy(testOptions.dataDir, CX_OPTIONS_PATH_CAP, L"C:\\owned-cache-fixture");
    expectedRescan = rescan; expectedNoCache = noCache || listClients; expectedNoDiskWrite = noDiskWrite;
    calls = 0;
    result = h_run(&testOptions, h_main_error, HOST_ERROR_CAP);
    check(!result && calls == 1 && !h_client_pid && !h_audit && !h_config && !h_diagnostics,
        "discovery failure releases host state before any client launch");
}

void WINAPI DiscoveryCacheHostTestMain(void) {
    run(FALSE, FALSE, FALSE, FALSE);
    run(TRUE, FALSE, FALSE, FALSE);
    run(FALSE, TRUE, FALSE, FALSE);
    run(FALSE, FALSE, TRUE, FALSE);
    run(FALSE, FALSE, FALSE, TRUE);
    run(TRUE, FALSE, FALSE, TRUE);
    h_print_utf8(failures ? "NATIVE CACHE HOST TESTS FAIL\n" : "NATIVE CACHE HOST TESTS PASS\n");
    ExitProcess(failures ? 1 : 0);
}
