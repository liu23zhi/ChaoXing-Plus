#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <shellapi.h>
#include "../dpi.h"
#include "../process.h"

static WCHAR executable[32768], errorText[512];
static DWORD failures;

static void output(const char *text) {
    DWORD written; WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &written, NULL);
}
static void check(BOOL ok, const char *name) {
    output(ok ? "PASS " : "FAIL "); output(name); output("\n"); if (!ok) ++failures;
}
static BOOL layer_absent(void) {
    HKEY key;
    LSTATUS status = RegOpenKeyExW(HKEY_CURRENT_USER,
        L"Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers", 0,
        KEY_QUERY_VALUE | KEY_WOW64_64KEY, &key);
    if (status == ERROR_FILE_NOT_FOUND) return TRUE;
    if (status != ERROR_SUCCESS) return FALSE;
    status = RegQueryValueExW(key, executable, NULL, NULL, NULL, NULL);
    RegCloseKey(key); return status == ERROR_FILE_NOT_FOUND;
}
static BOOL run_child(USHORT port, BOOL override, DWORD *code) {
    CX_DPI_OVERRIDE *dpi = NULL;
    HANDLE child = NULL;
    DWORD pid = 0;
    BOOL launched, restored = TRUE, ok = FALSE;
    if (override) {
        dpi = cx_dpi_begin(executable, errorText, 512);
        if (!dpi) return FALSE;
    }
    launched = proc_launch(executable, port, &pid, &child, errorText, 512);
    /* Match the real host: restore immediately after CreateProcess returns,
       before waiting for the child to initialize or finish. */
    if (dpi) restored = cx_dpi_restore(dpi, errorText, 512);
    if (launched && restored && WaitForSingleObject(child, 5000) == WAIT_OBJECT_0)
        ok = GetExitCodeProcess(child, code);
    if (child) { proc_stop_owned(pid); CloseHandle(child); }
    return ok && restored;
}
void __stdcall DpiProcessTestMain(void) {
    WCHAR **argv; int argc;
    WSADATA data;
    DWORD baseCode = 0, overrideCode = 0, againCode = 0;
    USHORT port;
    argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv || argc != 2 || !GetFullPathNameW(argv[1], 32768, executable, NULL)) ExitProcess(2);
    LocalFree(argv);
    if (WSAStartup(MAKEWORD(2, 2), &data)) ExitProcess(2);
    for (port = 38100; port < 38200; ++port) if (proc_port_bindable(port, errorText, 512)) break;
    if (port == 38200 || !layer_absent()) ExitProcess(2);
    check(run_child(port, FALSE, &baseCode) && baseCode == 5, "test child starts DPI-unaware without override");
    check(run_child(port, TRUE, &overrideCode) && overrideCode == 7, "temporary layer affects actual child DPI awareness before immediate restore");
    check(layer_absent(), "owned test executable has no retained compatibility value");
    check(run_child(port, FALSE, &againCode) && againCode == 5,
        "subsequent ordinary launch returns to original DPI awareness");
    WSACleanup();
    output(failures ? "NATIVE DPI PROCESS TESTS FAIL\n" : "NATIVE DPI PROCESS TESTS PASS\n");
    ExitProcess(failures ? 1 : 0);
}
