#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "../assets.h"

static char *originals[5];
static DWORD lengths[5];
static WCHAR errorText[512];

static void output(const char *text) {
    DWORD length = 0, written;
    while (text[length]) ++length;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, length, &written, NULL);
}

static BOOL load(DWORD index, char **bytes, DWORD *length) {
    if (index < cx_asset_count())
        return cx_asset_load(cx_asset_name(index), NULL, bytes, length, errorText, 512);
    return cx_asset_load_proxy(L"WINMM.DLL", bytes, length, errorText, 512);
}

static BOOL equal(const char *left, const char *right, DWORD length) {
    DWORD i;
    for (i = 0; i <= length; ++i) if (left[i] != right[i]) return FALSE;
    return TRUE;
}

void WINAPI MultiAssetTestMain(void) {
    DWORD i, read, length;
    char resume, *bytes = NULL, *other = NULL;
    BOOL ok = !cx_asset_resources_embedded() && cx_asset_count() == 4
        && cx_asset_proxy_count() == 1 && cx_asset_validate_embedded(errorText, 512);
    for (i = 0; ok && i < 5; ++i) {
        ok = load(i, &originals[i], &lengths[i]) && lengths[i] > 0
            && originals[i][lengths[i]] == 0;
    }
    if (!ok) { output("MULTI ASSET INITIAL LOAD FAIL\n"); ExitProcess(1); }
    output("MULTI ASSET CACHE READY\n");
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), &resume, 1, &read, NULL) || read != 1) ExitProcess(2);
    ok = cx_asset_validate_embedded(errorText, 512) && cx_asset_proxy_exists(L"winmm.dll");
    for (i = 0; ok && i < 5; ++i) {
        ok = load(i, &bytes, &length) && length == lengths[i] && equal(bytes, originals[i], length);
        if (ok) {
            bytes[0] ^= 1;
            ok = load(i, &other, &length) && length == lengths[i] && equal(other, originals[i], length);
        }
        if (bytes) HeapFree(GetProcessHeap(), 0, bytes);
        if (other) HeapFree(GetProcessHeap(), 0, other);
        bytes = NULL; other = NULL;
    }
    for (i = 0; i < 5; ++i) if (originals[i]) HeapFree(GetProcessHeap(), 0, originals[i]);
    output(ok ? "MULTI ASSET CACHE TESTS PASS\n" : "MULTI ASSET CACHE TESTS FAIL\n");
    ExitProcess(ok ? 0 : 1);
}
