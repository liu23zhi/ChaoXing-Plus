#include "../adapter-account.h"

static void out(const char *value) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), value, (DWORD)lstrlenA(value), &written, NULL);
}
static void check(BOOL condition, const char *message) {
    if (condition) { out("PASS "); out(message); out("\r\n"); return; }
    out("FAIL "); out(message); out("\r\n"); ExitProcess(1);
}
static BOOL fetch(const WCHAR *base, const WCHAR *cacheDir, const WCHAR *expectedVersion,
    BOOL noDiskWrite, BOOL forceRefresh) {
    BYTE *package = NULL; DWORD size = 0; WCHAR version[128], error[512]; BOOL ok;
    ok = cx_adapter_extension_fetch_cached(base, L"edge", cacheDir, noDiskWrite, forceRefresh,
        &package, &size, version, 128, error, 512);
    check(ok && package && size == 20, "extension cache API returns the expected package");
    check(!lstrcmpW(version, expectedVersion), "extension cache API preserves the version");
    check(package[0] == 'C' && package[1] == 'r' && package[2] == '2' && package[3] == '4', "extension cache API preserves CRX bytes");
    HeapFree(GetProcessHeap(), 0, package);
    return ok;
}
void ExtensionCacheTestMain(void) {
    static WCHAR base[2048], cacheDir[2048], scenario[64], expectedVersion[128];
    check(GetEnvironmentVariableW(L"CX_EXTENSION_CACHE_TEST_BASE", base, 2048) > 0, "mock base configured");
    check(GetEnvironmentVariableW(L"CX_EXTENSION_CACHE_TEST_DIR", cacheDir, 2048) > 0, "cache directory configured");
    GetEnvironmentVariableW(L"CX_EXTENSION_CACHE_TEST_SCENARIO", scenario, 64);
    if (!GetEnvironmentVariableW(L"CX_EXTENSION_CACHE_TEST_VERSION", expectedVersion, 128))
        lstrcpyW(expectedVersion, L"1.2.3.4");
    if (!lstrcmpW(scenario, L"sequence")) {
        fetch(base, cacheDir, expectedVersion, FALSE, FALSE);
        fetch(base, cacheDir, expectedVersion, FALSE, FALSE);
        fetch(base, cacheDir, expectedVersion, FALSE, TRUE);
    } else if (!lstrcmpW(scenario, L"fetch-once")) {
        fetch(base, cacheDir, expectedVersion, FALSE, FALSE);
    } else if (!lstrcmpW(scenario, L"force-with-reader")) {
        WCHAR cachePath[2048]; HANDLE reader;
        lstrcpynW(cachePath, cacheDir, 2048);
        if (cachePath[0] && cachePath[lstrlenW(cachePath) - 1] != L'\\') lstrcatW(cachePath, L"\\");
        lstrcatW(cachePath, L"edge.crxcache");
        reader = CreateFileW(cachePath, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE,
            NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        check(reader != INVALID_HANDLE_VALUE, "cache reader permits atomic replacement");
        fetch(base, cacheDir, expectedVersion, FALSE, TRUE);
        fetch(base, cacheDir, expectedVersion, FALSE, FALSE);
        CloseHandle(reader);
    } else if (!lstrcmpW(scenario, L"corrupt")) {
        fetch(base, cacheDir, expectedVersion, FALSE, FALSE);
    } else if (!lstrcmpW(scenario, L"no-disk")) {
        fetch(base, cacheDir, expectedVersion, TRUE, FALSE);
    } else if (!lstrcmpW(scenario, L"write-fail")) {
        fetch(base, cacheDir, expectedVersion, FALSE, FALSE);
    } else {
        check(FALSE, "known extension cache scenario");
    }
    out("NATIVE EXTENSION CACHE TESTS PASS\r\n"); ExitProcess(0);
}
