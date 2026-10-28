#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>

static BOOL tokenAvailable = TRUE, tokenElevated, shellAllowed = TRUE;
static DWORD shellError = ERROR_CANCELLED, waitResult = WAIT_OBJECT_0, childExit = 17;
static BOOL exitAvailable = TRUE, processHandleAvailable = TRUE;
static DWORD shellCalls, tokenCalls, closeCalls, waits, failures;
static WCHAR capturedParameters[32768], capturedDirectory[32768], capturedExecutable[32768];
static WCHAR argumentBuffer[32768], command[32768], tooLong[32768], errorText[256];
static WCHAR testDirectory[32768];

static BOOL WINAPI test_open_token(HANDLE process, DWORD access, PHANDLE token) {
    (void)process; (void)access; ++tokenCalls;
    if (!tokenAvailable) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
    *token = (HANDLE)101; return TRUE;
}
static BOOL WINAPI test_token_info(HANDLE token, TOKEN_INFORMATION_CLASS kind,
                                  LPVOID data, DWORD size, PDWORD used) {
    (void)token; (void)kind; (void)size;
    ((TOKEN_ELEVATION *)data)->TokenIsElevated = tokenElevated;
    *used = sizeof(TOKEN_ELEVATION); return TRUE;
}
static BOOL WINAPI test_close(HANDLE handle) { (void)handle; ++closeCalls; return TRUE; }
static BOOL WINAPI test_shell(SHELLEXECUTEINFOW *info) {
    ++shellCalls;
    if (lstrcmpW(info->lpVerb, L"runas") || info->nShow != SW_SHOWNORMAL
        || !(info->fMask & SEE_MASK_NOCLOSEPROCESS)) ExitProcess(4);
    lstrcpyW(capturedParameters, info->lpParameters);
    lstrcpyW(capturedDirectory, info->lpDirectory);
    lstrcpyW(capturedExecutable, info->lpFile);
    if (!shellAllowed) { SetLastError(shellError); return FALSE; }
    info->hProcess = processHandleAvailable ? (HANDLE)102 : NULL; return TRUE;
}
static DWORD WINAPI test_wait(HANDLE handle, DWORD timeout) {
    (void)handle; (void)timeout; ++waits;
    if (waitResult == WAIT_FAILED) SetLastError(ERROR_INVALID_HANDLE);
    return waitResult;
}
static BOOL WINAPI test_exit(HANDLE handle, LPDWORD code) {
    (void)handle;
    if (!exitAvailable) { SetLastError(ERROR_INVALID_HANDLE); return FALSE; }
    *code = childExit; return TRUE;
}

#define OpenProcessToken test_open_token
#define GetTokenInformation test_token_info
#define CloseHandle test_close
#define ShellExecuteExW test_shell
#define WaitForSingleObject test_wait
#define GetExitCodeProcess test_exit
#include "../elevation.c"

static void output(const char *s) {
    DWORD written; WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), s, (DWORD)lstrlenA(s), &written, NULL);
}
static void check(BOOL ok, const char *name) {
    output(ok ? "PASS " : "FAIL "); output(name); output("\n"); if (!ok) ++failures;
}
static void quoting(void) {
    WCHAR *args[] = {
        L"", L"--config", L"相对 配置\\a.json", L"--expected-browser", L"--elevated",
        L"--options-json", L"{\"settings\":{\"common.settings.note\":\"a \\\"b\\\"\"}}",
        L"spaces and tabs\tend", L"quote\"inside", L"C:\\trailing slash\\",
        L"two\\\\\"quote", L"", L"ends with two \\\\"
    };
    WCHAR **parsed; int count, i; BOOL same = TRUE;
    check(cx_elevation_parameters(13, args, L"D:\\选定 客户端\\CXExam.exe", argumentBuffer, 32768), "parameters build");
    lstrcpyW(command, L"\"C:\\host.exe\" "); lstrcatW(command, argumentBuffer);
    parsed = CommandLineToArgvW(command, &count);
    if (!parsed || count != 17) same = FALSE;
    else {
        for (i = 0; i < 13; ++i) if (lstrcmpW(parsed[i + 1], args[i])) same = FALSE;
        if (lstrcmpW(parsed[14], L"--elevated") || lstrcmpW(parsed[15], L"--elevated-client")
            || lstrcmpW(parsed[16], L"D:\\选定 客户端\\CXExam.exe")) same = FALSE;
    }
    check(same, "Windows argv roundtrip preserves empty Unicode JSON quotes slashes and marker-valued argument");
    if (parsed) LocalFree(parsed);
    check(!cx_elevation_parameters(13, args, L"C:\\CXExam.exe", argumentBuffer, 8) && !argumentBuffer[0], "capacity failure never returns a truncated command");
    for (i = 0; i < 32767; ++i) tooLong[i] = L'x'; tooLong[32767] = 0;
    args[0] = tooLong;
    check(!cx_elevation_parameters(1, args, L"C:\\CXExam.exe", argumentBuffer, 32768), "overlong argument rejected");
}
static void gates(void) {
    BOOL elevated = TRUE;
    tokenCalls = 0;
    check(!cx_elevation_can_restart(ERROR_ACCESS_DENIED, FALSE, FALSE)
        && !cx_elevation_can_restart(ERROR_ELEVATION_REQUIRED, TRUE, FALSE)
        && !cx_elevation_can_restart(ERROR_ELEVATION_REQUIRED, FALSE, TRUE)
        && tokenCalls == 0, "only unmarked opted-in 740 can inspect elevation");
    check(cx_elevation_can_restart(ERROR_ELEVATION_REQUIRED, FALSE, FALSE), "740 ordinary token permits one visible restart");
    tokenElevated = TRUE;
    check(!cx_elevation_can_restart(ERROR_ELEVATION_REQUIRED, FALSE, FALSE), "already elevated cannot recurse");
    tokenAvailable = FALSE;
    check(!cx_elevation_query(&elevated) && !elevated
        && !cx_elevation_can_restart(ERROR_ELEVATION_REQUIRED, FALSE, FALSE), "unknown token fails closed");
    tokenAvailable = TRUE; tokenElevated = FALSE;
}
static void handoff(void) {
    DWORD code = 0, before;
    WCHAR *args[] = { L"--options-json", L"{\"panel\":false}", L"--client-index", L"2" };
    check(cx_elevation_restart(L"C:\\宿主 目录\\chaoxing_plus.exe", 4, args,
        L"D:\\安装\\CXExam.exe", &code, errorText, 256) && code == 17, "handoff returns elevated child exit code");
    check(!lstrcmpW(capturedDirectory, testDirectory)
        && !lstrcmpW(capturedExecutable, L"C:\\宿主 目录\\chaoxing_plus.exe")
        && shellCalls == 1 && waits == 1, "runas restarts host with original working directory");
    shellAllowed = FALSE;
    check(!cx_elevation_restart(L"C:\\host.exe", 4, args, L"D:\\CXExam.exe", &code, errorText, 256)
        && GetLastError() == ERROR_CANCELLED && code == 3, "UAC cancel exits 3");
    shellError = ERROR_ACCESS_DENIED;
    check(!cx_elevation_restart(L"C:\\host.exe", 4, args, L"D:\\CXExam.exe", &code, errorText, 256)
        && GetLastError() == ERROR_ACCESS_DENIED && code == 1, "shell failure remains failure");
    shellAllowed = TRUE; processHandleAvailable = FALSE;
    check(!cx_elevation_restart(L"C:\\host.exe", 4, args, L"D:\\CXExam.exe", &code, errorText, 256), "missing process handle cannot claim success");
    processHandleAvailable = TRUE; waitResult = WAIT_FAILED; before = closeCalls;
    check(!cx_elevation_restart(L"C:\\host.exe", 4, args, L"D:\\CXExam.exe", &code, errorText, 256)
        && closeCalls == before + 1, "wait failure closes child handle");
    waitResult = WAIT_OBJECT_0; exitAvailable = FALSE;
    check(!cx_elevation_restart(L"C:\\host.exe", 4, args, L"D:\\CXExam.exe", &code, errorText, 256), "missing child result cannot claim success");
}
void __stdcall ElevationTestMain(void) {
    if (!GetCurrentDirectoryW(32768, testDirectory)) ExitProcess(3);
    quoting(); gates(); handoff();
    output(failures ? "NATIVE ELEVATION TESTS FAIL\n" : "NATIVE ELEVATION TESTS PASS\n");
    ExitProcess(failures ? 1 : 0);
}
