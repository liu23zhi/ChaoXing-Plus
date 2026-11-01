#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <shellapi.h>
#include "../dpi.h"
#include "../process.h"

static WCHAR executables[3][32768], errorText[512];
static DWORD failures;

static void output(const char *text) {
    DWORD written; WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &written, NULL);
}
static void output_number(DWORD value) {
    char digits[16]; DWORD at = sizeof(digits) - 1, written;
    digits[at] = 0;
    do { digits[--at] = (char)('0' + (value % 10)); value /= 10; } while (value && at);
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), digits + at, (DWORD)lstrlenA(digits + at), &written, NULL);
}
static void output_wide(const WCHAR *text) {
    char buffer[1024]; DWORD written; int length;
    if (!text || !*text) return;
    length = WideCharToMultiByte(CP_UTF8, 0, text, -1, buffer, sizeof(buffer), NULL, NULL);
    if (length > 1) WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), buffer, (DWORD)length - 1, &written, NULL);
}
static void check(BOOL ok, const char *name) {
    output(ok ? "PASS " : "FAIL "); output(name); output("\n"); if (!ok) ++failures;
}
static BOOL layer_absent(const WCHAR *executable) {
    HKEY key;
    LSTATUS status = RegOpenKeyExW(HKEY_CURRENT_USER,
        L"Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers", 0,
        KEY_QUERY_VALUE | KEY_WOW64_64KEY, &key);
    if (status == ERROR_FILE_NOT_FOUND) return TRUE;
    if (status != ERROR_SUCCESS) return FALSE;
    status = RegQueryValueExW(key, executable, NULL, NULL, NULL, NULL);
    RegCloseKey(key); return status == ERROR_FILE_NOT_FOUND;
}
static BOOL run_child(const WCHAR *executable, USHORT port, BOOL override, DWORD *code) {
    CX_DPI_OVERRIDE *dpi = NULL;
    HANDLE child = NULL;
    DWORD pid = 0;
    DWORD waitResult = WAIT_FAILED;
    DWORD errorCode;
    BOOL launched, restored = TRUE, ok = FALSE, exited = FALSE;
    errorText[0] = 0;
    if (override) {
        dpi = cx_dpi_begin(executable, errorText, 512);
        if (!dpi) {
            errorCode = GetLastError();
            output("DPI_BEGIN_FAILED win32="); output_number(errorCode); output(" error="); output_wide(errorText); output("\n");
            return FALSE;
        }
    }
    launched = proc_launch(executable, port, &pid, &child, errorText, 512);
    if (!launched) {
        errorCode = GetLastError();
        output("DPI_LAUNCH_FAILED win32="); output_number(errorCode); output(" error="); output_wide(errorText); output("\n");
    }
    /* Match the real host: restore immediately after CreateProcess returns,
       before waiting for the child to initialize or finish. */
    if (dpi) {
        errorText[0] = 0;
        restored = cx_dpi_restore(dpi, errorText, 512);
        if (!restored) {
            errorCode = GetLastError();
            output("DPI_RESTORE_FAILED win32="); output_number(errorCode); output(" error="); output_wide(errorText); output("\n");
        }
    }
    if (launched && restored) {
        waitResult = WaitForSingleObject(child, 5000);
        exited = waitResult == WAIT_OBJECT_0;
        if (!exited) { output("DPI_WAIT_FAILED result="); output_number(waitResult); output("\n"); }
        if (exited) {
            ok = GetExitCodeProcess(child, code);
            if (ok) { output("DPI_CHILD_EXIT="); output_number(*code); output("\n"); }
            else { errorCode = GetLastError(); output("DPI_EXIT_CODE_FAILED win32="); output_number(errorCode); output("\n"); }
        }
    }
    if (child) { proc_stop_owned(pid); CloseHandle(child); }
    return ok && restored;
}
void __stdcall DpiProcessTestMain(void) {
    WCHAR **argv; int argc;
    WSADATA data;
    DWORD baseCode = 0, overrideCode = 0, againCode = 0;
    int i;
    USHORT port;
    BOOL baselineLaunched, overrideLaunched, afterRestoreLaunched, overrideLayerAbsent;
    argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv || argc != 4) ExitProcess(2);
    for (i = 0; i < 3; ++i) {
        if (!GetFullPathNameW(argv[i + 1], 32768, executables[i], NULL)) ExitProcess(2);
    }
    LocalFree(argv);
    if (WSAStartup(MAKEWORD(2, 2), &data)) ExitProcess(2);
    for (port = 38100; port < 38200; ++port) if (proc_port_bindable(port, errorText, 512)) break;
    if (port == 38200 || !layer_absent(executables[0]) || !layer_absent(executables[1])
        || !layer_absent(executables[2])) ExitProcess(2);
    baselineLaunched = run_child(executables[0], port, FALSE, &baseCode);
    overrideLaunched = run_child(executables[1], port, TRUE, &overrideCode);
    overrideLayerAbsent = layer_absent(executables[1]);
    afterRestoreLaunched = run_child(executables[2], port, FALSE, &againCode);
    check(baselineLaunched && baseCode == 5,
        "test child starts DPI-unaware without override");
    check(overrideLayerAbsent, "overridden test executable has no retained compatibility value");
    check(afterRestoreLaunched && againCode == 5,
        "ordinary launch after restoration remains DPI-unaware");
    if (baselineLaunched && baseCode == 5 && overrideLaunched && overrideCode == 5
        && overrideLayerAbsent && afterRestoreLaunched && againCode == 5) {
        output("DPI_SHIM_UNOBSERVED\n");
        output("SKIP temporary layer affects a fresh test child before immediate restore\n");
        output("NATIVE DPI PROCESS TESTS SKIP\n");
        WSACleanup();
        ExitProcess(8);
    }
    check(overrideLaunched && overrideCode == 7,
        "temporary layer affects a fresh test child before immediate restore");
    WSACleanup();
    output(failures ? "NATIVE DPI PROCESS TESTS FAIL\n" : "NATIVE DPI PROCESS TESTS PASS\n");
    ExitProcess(failures ? 1 : 0);
}
