#include "../discovery.h"
#include <shellapi.h>

static CX_DISCOVERY_OPTIONS options;
static CX_DISCOVERY_ROOTS roots;
static CX_DISCOVERY_RESULT result;
static const WCHAR *commonRoots[129], *fixedRoots[1];
static WCHAR errorText[512];
static BOOL errorOutput;

static void text(const char *value) {
    DWORD written;
    WriteFile(GetStdHandle(errorOutput ? STD_ERROR_HANDLE : STD_OUTPUT_HANDLE), value, (DWORD)lstrlenA(value), &written, NULL);
}
static void wide(const WCHAR *value) {
    int length = WideCharToMultiByte(CP_UTF8, 0, value, -1, NULL, 0, NULL, NULL);
    char *encoded;
    if (length <= 0) return;
    encoded = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)length);
    if (!encoded) return;
    WideCharToMultiByte(CP_UTF8, 0, value, -1, encoded, length, NULL, NULL);
    text(encoded); HeapFree(GetProcessHeap(), 0, encoded);
}
static void number(DWORD value) {
    char digits[16], output[16]; DWORD i = 0, j = 0;
    do { digits[i++] = (char)('0' + value % 10); value /= 10; } while (value);
    while (i) output[j++] = digits[--i]; output[j] = 0; text(output);
}
static void machine_number(WORD value) {
    char output[5]; DWORD i;
    for (i = 0; i < 4; ++i) { DWORD digit = (value >> (12 - i * 4)) & 15; output[i] = (char)(digit < 10 ? '0' + digit : 'a' + digit - 10); }
    output[4] = 0; text(output);
}
void WINAPI DiscoveryCacheDriverMain(void) {
    int argc, i; LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    const WCHAR *cachePath = NULL;
    BOOL rescan = FALSE, noCache = FALSE, noDiskWrite = FALSE, legacy = FALSE;
    DWORD extraRoots = 1;
    if (!argv) ExitProcess(2);
    options.mode = CX_DISCOVERY_SCAN_COMMON;
    i = 1;
    if (argc >= 5 && lstrcmpW(argv[1], L"scan") == 0) {
        legacy = TRUE; commonRoots[0] = argv[3]; fixedRoots[0] = argv[4];
        options.mode = lstrcmpW(argv[2], L"all") == 0 ? CX_DISCOVERY_SCAN_ALL
            : lstrcmpW(argv[2], L"common") == 0 ? CX_DISCOVERY_SCAN_COMMON : CX_DISCOVERY_SCAN_FALLBACK_ALL;
        i = 5;
    }
    for (; i < argc; ++i) {
        if (lstrcmpW(argv[i], L"--rescan") == 0) rescan = TRUE;
        else if (lstrcmpW(argv[i], L"--no-cache") == 0) noCache = TRUE;
        else if (lstrcmpW(argv[i], L"--no-disk-write") == 0) noDiskWrite = TRUE;
        else if (lstrcmpW(argv[i], L"--force-x86-os") == 0) options.hostIs32Bit = TRUE;
        else if (lstrcmpW(argv[i], L"--enumerate-all") == 0) options.enumerateAll = TRUE;
        else if (lstrcmpW(argv[i], L"--many-roots") == 0) extraRoots = 129;
        else if (i + 1 < argc && lstrcmpW(argv[i], L"--common") == 0) commonRoots[0] = argv[++i];
        else if (i + 1 < argc && lstrcmpW(argv[i], L"--fixed") == 0) fixedRoots[0] = argv[++i];
        else if (i + 1 < argc && lstrcmpW(argv[i], L"--cache") == 0) cachePath = argv[++i];
        else if (i + 1 < argc && lstrcmpW(argv[i], L"--client") == 0) options.clientPath = argv[++i];
        else if (i + 1 < argc && lstrcmpW(argv[i], L"--mode") == 0) {
            const WCHAR *mode = argv[++i];
            options.mode = lstrcmpW(mode, L"all") == 0 ? CX_DISCOVERY_SCAN_ALL
                : lstrcmpW(mode, L"fallback-all") == 0 ? CX_DISCOVERY_SCAN_FALLBACK_ALL : CX_DISCOVERY_SCAN_COMMON;
        } else { text("ERROR arguments\n"); LocalFree(argv); ExitProcess(2); }
    }
    for (i = 1; (DWORD)i < extraRoots; ++i) commonRoots[i] = commonRoots[0];
    roots.commonRoots = commonRoots; roots.commonRootCount = commonRoots[0] ? extraRoots : 0;
    roots.fixedRoots = fixedRoots; roots.fixedRootCount = fixedRoots[0] ? 1 : 0;
    options.roots = &roots;
#ifdef CX_DISCOVERY_CACHE_FORMAT_VERSION
    options.cachePath = cachePath; options.rescan = rescan;
    options.noScanCache = noCache; options.noDiskWrite = noDiskWrite;
#else
    (void)cachePath; (void)rescan; (void)noCache; (void)noDiskWrite;
#endif
    cx_discovery_init(&result);
    if (!cx_discovery_scan(&options, &result, errorText, 512)) {
        errorOutput = legacy;
        text("ERROR "); wide(errorText); text("\n"); cx_discovery_free(&result); LocalFree(argv); ExitProcess(1);
    }
    text("RESULT\t"); number(result.count); text("\t");
#ifdef CX_DISCOVERY_CACHE_FORMAT_VERSION
    number(legacy ? result.recommendedIndex : result.cacheHit);
#else
    number(0);
#endif
    text("\t"); number(result.commonScanned); text("\t"); number(result.fallbackScanned);
    text("\t"); number(result.stoppedOnX86); text("\t"); number(result.truncated); text("\n");
    for (i = 0; (DWORD)i < result.count; ++i) { text("CAND\t"); machine_number(result.items[i].machine); text("\t"); wide(result.items[i].path); text("\n"); }
    cx_discovery_free(&result); LocalFree(argv); ExitProcess(0);
}
