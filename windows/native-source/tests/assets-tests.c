#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include "../assets.h"
#include "../resource.h"

static WCHAR errorText[512];
static DWORD failedChecks;

static void output(const char *text) {
    DWORD written, length = 0;
    while (text[length]) ++length;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, length, &written, NULL);
}

static void check(BOOL passed, const char *name) {
    output(passed ? "PASS " : "FAIL "); output(name); output("\n");
    if (!passed) ++failedChecks;
}

static int dump(const WCHAR *name, const WCHAR *overrideDir) {
    char *data = NULL;
    DWORD length = 0, written = 0;
    BOOL ok = cx_asset_load(name, overrideDir, &data, &length, errorText, 512);
    if (!ok) { output("ASSET LOAD FAILED\n"); return 3; }
    ok = WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), data, length, &written, NULL);
    HeapFree(GetProcessHeap(), 0, data);
    return ok && written == length ? 0 : 4;
}

static int dump_from_module(const WCHAR *modulePath, const WCHAR *name) {
    HMODULE module;
    HRSRC resource;
    HGLOBAL loaded;
    const void *bytes;
    DWORD index, size, written = 0;
    BOOL ok;
    for (index = 0; index < cx_asset_count(); ++index)
        if (lstrcmpW(name, cx_asset_name(index)) == 0) break;
    if (index == cx_asset_count()) return 3;
    module = LoadLibraryExW(modulePath, NULL, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
    if (!module) return 3;
    resource = FindResourceW(module, MAKEINTRESOURCEW(CX_RESOURCE_BOOTSTRAP + index), RT_RCDATA);
    if (!resource) { FreeLibrary(module); return 3; }
    size = SizeofResource(module, resource);
    loaded = LoadResource(module, resource);
    bytes = loaded ? LockResource(loaded) : NULL;
    if (!bytes || !size || size > CX_ASSET_MAX_BYTES) { FreeLibrary(module); return 3; }
    ok = WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes, size, &written, NULL);
    FreeLibrary(module);
    return ok && written == size ? 0 : 4;
}

static int self_test(void) {
    DWORD index;
    char *data = NULL;
    DWORD length = 123;
    BOOL ok;
    check(cx_asset_count() == 4, "all four resources are enumerated");
    check(cx_asset_name(cx_asset_count()) == NULL, "out-of-range name is absent");
    check(cx_asset_validate_embedded(errorText, 512), "embedded resource validation succeeds");
    for (index = 0; index < cx_asset_count(); ++index) {
        ok = cx_asset_load(cx_asset_name(index), NULL, &data, &length, errorText, 512);
        check(ok && data && length && length <= CX_ASSET_MAX_BYTES && data[length] == 0,
              "resource buffer is nonempty and NUL-terminated");
        if (data) HeapFree(GetProcessHeap(), 0, data);
        data = NULL;
    }
    check(!cx_asset_load(L"../windows-bootstrap.js", NULL, &data, &length, errorText, 512)
          && !data && length == 0, "unknown or traversal resource names are rejected");
    check(!cx_asset_load(NULL, NULL, &data, &length, errorText, 512), "missing asset name is rejected");
    output(failedChecks ? "NATIVE ASSET TESTS FAIL\n" : "NATIVE ASSET TESTS PASS\n");
    return failedChecks ? 1 : 0;
}

void WINAPI AssetTestMain(void) {
    WCHAR **argv;
    int argc = 0, result = 2;
    argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) ExitProcess(2);
    if (argc == 1 || (argc == 2 && lstrcmpW(argv[1], L"--self-test") == 0)) result = self_test();
    else if ((argc == 3 || argc == 4) && lstrcmpW(argv[1], L"--dump") == 0)
        result = dump(argv[2], argc == 4 ? argv[3] : NULL);
    else if (argc == 4 && lstrcmpW(argv[1], L"--dump-from-module") == 0)
        result = dump_from_module(argv[2], argv[3]);
    LocalFree(argv);
    ExitProcess((UINT)result);
}
