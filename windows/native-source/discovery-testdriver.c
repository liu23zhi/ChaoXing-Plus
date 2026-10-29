#include <windows.h>
#include <stdio.h>
#include "discovery.h"

static int parse_mode(const WCHAR *value) {
    if (!value) return 1;
    if (_wcsicmp(value, L"common") == 0) return CX_DISCOVERY_SCAN_COMMON;
    if (_wcsicmp(value, L"all") == 0) return CX_DISCOVERY_SCAN_ALL;
    return CX_DISCOVERY_SCAN_FALLBACK_ALL;
}

int wmain(int argc, wchar_t **argv) {
    const WCHAR *common[1];
    const WCHAR *fixed[1];
    CX_DISCOVERY_ROOTS roots;
    CX_DISCOVERY_OPTIONS options;
    CX_DISCOVERY_RESULT result;
    WCHAR error[256];
    DWORD i;
    int mode;
    if (argc < 5) {
        fwprintf(stderr, L"usage: discovery-testdriver scan <common|fallback-all|all> <common-root> <fixed-root> [--client path] [--force-x86-os] [--enumerate-all]\n");
        return 2;
    }
    mode = parse_mode(argv[2]);
    ZeroMemory(&options, sizeof(options));
    common[0] = argv[3];
    fixed[0] = argv[4];
    roots.commonRoots = common;
    roots.commonRootCount = 1;
    roots.fixedRoots = fixed;
    roots.fixedRootCount = 1;
    options.mode = (CX_DISCOVERY_SCAN_MODE)mode;
    options.clientPath = NULL;
    options.roots = &roots;
    options.hostIs32Bit = FALSE;
    options.enumerateAll = FALSE;
    for (i = 5; i < (DWORD)argc; ++i) {
        if (_wcsicmp(argv[i], L"--client") == 0 && i + 1 < (DWORD)argc) {
            options.clientPath = argv[++i];
        } else if (_wcsicmp(argv[i], L"--force-x86-os") == 0) {
            options.hostIs32Bit = TRUE;
        } else if (_wcsicmp(argv[i], L"--enumerate-all") == 0) {
            options.enumerateAll = TRUE;
        } else if (!options.clientPath && argv[i][0] != L'-') {
            /* Keep the original positional [client] test-driver contract. */
            options.clientPath = argv[i];
        }
    }
    cx_discovery_init(&result);
    error[0] = 0;
    if (!cx_discovery_scan(&options, &result, error, 256)) {
        fwprintf(stderr, L"ERROR\t%s\n", error);
        cx_discovery_free(&result);
        return 1;
    }
    wprintf(L"RESULT\t%lu\t%lu\t%d\t%d\t%d\t%d\n", (unsigned long)result.count,
            (unsigned long)result.recommendedIndex, result.commonScanned ? 1 : 0,
            result.fallbackScanned ? 1 : 0, result.stoppedOnX86 ? 1 : 0,
            result.truncated ? 1 : 0);
    for (i = 0; i < result.count; ++i)
        wprintf(L"CAND\t%04x\t%s\n", result.items[i].machine, result.items[i].path);
    if (error[0]) wprintf(L"NOTICE\t%s\n", error);
    cx_discovery_free(&result);
    return 0;
}
