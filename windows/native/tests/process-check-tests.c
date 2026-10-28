#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <tlhelp32.h>

typedef struct { DWORD pid; const WCHAR *name; } TestProcess;

static TestProcess testRows[16];
static DWORD testRowCount, testRowAt, testSnapshotError, testFirstError;
static DWORD testNextError, testNextFailAt, testSnapshotCalls, testFirstCalls;
static DWORD testNextCalls, testCloseCalls, testBadCalls, testCreateCalls, failures;
static WCHAR errorText[512], launchPath[32768];

static HANDLE test_handle(void) { return (HANDLE)(ULONG_PTR)101; }

static void test_copy_entry(LPPROCESSENTRY32W entry) {
    DWORD i = 0;
    entry->th32ProcessID = testRows[testRowAt].pid;
    while (testRows[testRowAt].name[i] && i + 1 < MAX_PATH) {
        entry->szExeFile[i] = testRows[testRowAt].name[i]; ++i;
    }
    entry->szExeFile[i] = 0;
}

static HANDLE WINAPI test_snapshot(DWORD flags, DWORD pid) {
    ++testSnapshotCalls;
    if (flags != TH32CS_SNAPPROCESS || pid != 0) ++testBadCalls;
    if (testSnapshotError) {
        SetLastError(testSnapshotError); return INVALID_HANDLE_VALUE;
    }
    return test_handle();
}

static BOOL WINAPI test_first(HANDLE snapshot, LPPROCESSENTRY32W entry) {
    ++testFirstCalls;
    if (snapshot != test_handle() || !entry || entry->dwSize != sizeof(*entry)) {
        ++testBadCalls; SetLastError(ERROR_INVALID_PARAMETER); return FALSE;
    }
    testRowAt = 0;
    if (testFirstError || !testRowCount) {
        SetLastError(testFirstError ? testFirstError : ERROR_NO_MORE_FILES); return FALSE;
    }
    test_copy_entry(entry); return TRUE;
}

static BOOL WINAPI test_next(HANDLE snapshot, LPPROCESSENTRY32W entry) {
    ++testNextCalls;
    if (snapshot != test_handle() || !entry || entry->dwSize != sizeof(*entry)) {
        ++testBadCalls; SetLastError(ERROR_INVALID_PARAMETER); return FALSE;
    }
    ++testRowAt;
    if (testRowAt >= testNextFailAt || testRowAt >= testRowCount) {
        SetLastError(testNextError); return FALSE;
    }
    test_copy_entry(entry); return TRUE;
}

static BOOL WINAPI test_close(HANDLE handle) {
    ++testCloseCalls;
    if (handle != test_handle()) ++testBadCalls;
    /* Closing must not replace the enumeration failure reported to callers. */
    SetLastError(ERROR_INVALID_HANDLE); return TRUE;
}

static DWORD WINAPI test_current_pid(void) { return 999; }

static BOOL WINAPI test_create_process(LPCWSTR application, LPWSTR command,
    LPSECURITY_ATTRIBUTES processAttributes, LPSECURITY_ATTRIBUTES threadAttributes,
    BOOL inheritHandles, DWORD flags, LPVOID environment, LPCWSTR directory,
    LPSTARTUPINFOW startup, LPPROCESS_INFORMATION info) {
    (void)application; (void)command; (void)processAttributes; (void)threadAttributes;
    (void)inheritHandles; (void)flags; (void)environment; (void)directory;
    (void)startup; (void)info;
    ++testCreateCalls;
    SetLastError(ERROR_FILE_NOT_FOUND); return FALSE;
}

#define CreateToolhelp32Snapshot test_snapshot
#define Process32FirstW test_first
#define Process32NextW test_next
#define CloseHandle test_close
#define GetCurrentProcessId test_current_pid
#define CreateProcessW test_create_process
#include "../process.c"
#undef CreateToolhelp32Snapshot
#undef Process32FirstW
#undef Process32NextW
#undef CloseHandle
#undef GetCurrentProcessId
#undef CreateProcessW

static void output(const char *text) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &written, NULL);
}

static void check(BOOL ok, const char *name) {
    output(ok ? "PASS " : "FAIL "); output(name); output("\n");
    if (!ok) ++failures;
}

static void reset(void) {
    testRowCount = testRowAt = testSnapshotError = testFirstError = 0;
    testNextError = ERROR_NO_MORE_FILES;
    testNextFailAt = 0xffffffffUL;
    testSnapshotCalls = testFirstCalls = testNextCalls = testCloseCalls = testBadCalls = 0;
    testCreateCalls = 0;
    errorText[0] = 0;
    SetLastError(ERROR_SUCCESS);
}

static void add(DWORD pid, const WCHAR *name) {
    testRows[testRowCount].pid = pid; testRows[testRowCount].name = name; ++testRowCount;
}

static void invalid_path(const WCHAR *path, const char *name) {
    DWORD count = 123, code;
    BOOL ok;
    reset();
    ok = proc_check_instances(path, &count, errorText, 512); code = GetLastError();
    check(!ok && count == 0 && code == ERROR_INVALID_PARAMETER && errorText[0]
        && testSnapshotCalls == 0 && testCloseCalls == 0, name);
}

static void launch_rejection(USHORT port, DWORD expectedError, const char *name) {
    DWORD pid = 123, code;
    HANDLE process = (HANDLE)(ULONG_PTR)456;
    BOOL ok = proc_launch(launchPath, port, &pid, &process, errorText, 512);
    code = GetLastError();
    check(!ok && pid == 0 && process == NULL && code == expectedError && errorText[0]
        && testSnapshotCalls == 1 && !testCreateCalls && !testBadCalls, name);
}

void __stdcall ProcessCheckTestMain(void) {
    DWORD count, code, pids[2], at;
    HANDLE process;
    USHORT port;
    BOOL ok;
    int oldCount;

    reset(); count = 123;
    ok = proc_check_instances(L"C:\\Fixture\\CXExam.exe", &count, errorText, 512);
    check(ok && count == 0 && testSnapshotCalls == 1 && testFirstCalls == 1
        && testNextCalls == 0 && testCloseCalls == 1 && !testBadCalls,
        "empty enumeration is successful only at ERROR_NO_MORE_FILES");

    reset(); add(10, L"other.exe"); add(0, L"CXExam.exe"); add(999, L"CXExam.exe");
    add(20, L"cxexam.EXE"); add(30, L"CXExam.exe"); add(40, L"CXExam.exe.bak");
    count = 123;
    ok = proc_check_instances(L"C:\\First\\CXExam.exe", &count, errorText, 512);
    check(ok && count == 2 && testNextCalls == 6 && testCloseCalls == 1 && !testBadCalls,
        "count matches ASCII case-insensitive basename and excludes self and PID zero");

    reset(); add(20, L"CXExam.exe"); add(30, L"cxexam.exe"); count = 123;
    ok = proc_check_instances(L"D:/Another/Client/CxExAm.ExE", &count, errorText, 512);
    check(ok && count == 2 && testCloseCalls == 1 && !testBadCalls,
        "same basename in another installation path is still a conflict");

    reset(); add(12, L"unrelated.exe"); count = 123;
    ok = proc_check_instances(L"CXExam.exe", &count, NULL, 0);
    check(ok && count == 0 && testCloseCalls == 1 && !testBadCalls,
        "bare executable name and omitted error buffer are supported");

    invalid_path(NULL, "null executable path fails before enumeration");
    invalid_path(L"", "empty executable path fails before enumeration");
    invalid_path(L"C:\\Fixture\\", "backslash trailing executable path fails before enumeration");
    invalid_path(L"C:/Fixture/", "slash trailing executable path fails before enumeration");

    reset();
    ok = proc_check_instances(L"CXExam.exe", NULL, errorText, 512); code = GetLastError();
    check(!ok && code == ERROR_INVALID_PARAMETER && errorText[0] && !testSnapshotCalls,
        "missing count output fails before enumeration");

    reset(); testSnapshotError = ERROR_ACCESS_DENIED; count = 123;
    ok = proc_check_instances(L"CXExam.exe", &count, errorText, 512); code = GetLastError();
    check(!ok && count == 0 && code == ERROR_ACCESS_DENIED && errorText[0]
        && testSnapshotCalls == 1 && !testFirstCalls && !testCloseCalls,
        "snapshot failure is distinct from no matching processes");

    reset(); testFirstError = ERROR_BAD_LENGTH; count = 123;
    ok = proc_check_instances(L"CXExam.exe", &count, errorText, 512); code = GetLastError();
    check(!ok && count == 0 && code == ERROR_BAD_LENGTH && errorText[0]
        && testFirstCalls == 1 && !testNextCalls && testCloseCalls == 1 && !testBadCalls,
        "first enumeration failure preserves its error after closing snapshot");

    reset(); add(20, L"CXExam.exe"); add(30, L"CXExam.exe");
    testNextFailAt = 1; testNextError = ERROR_PARTIAL_COPY; count = 123;
    ok = proc_check_instances(L"CXExam.exe", &count, errorText, 512); code = GetLastError();
    check(!ok && count == 0 && code == ERROR_PARTIAL_COPY && errorText[0]
        && testNextCalls == 1 && testCloseCalls == 1 && !testBadCalls,
        "next enumeration failure discards partial counts and preserves its error");

    reset(); testFirstError = ERROR_ACCESS_DENIED; count = 123;
    ok = proc_check_instances(L"CXExam.exe", &count, NULL, 0); code = GetLastError();
    check(!ok && count == 0 && code == ERROR_ACCESS_DENIED && testCloseCalls == 1,
        "failure remains fail-closed when no error buffer is supplied");

    reset(); add(20, L"CXExam.exe"); add(30, L"cxexam.exe"); add(40, L"CXExam.exe");
    pids[0] = pids[1] = 0;
    oldCount = proc_instances(L"D:\\Fixture\\CXExam.exe", pids, 2);
    check(oldCount == 3 && pids[0] == 20 && pids[1] == 30 && testCloseCalls == 1 && !testBadCalls,
        "legacy helper returns total matches while respecting PID output capacity");

    reset(); testSnapshotError = ERROR_ACCESS_DENIED;
    oldCount = proc_instances(L"CXExam.exe", NULL, 0); code = GetLastError();
    check(oldCount == -1 && code == ERROR_ACCESS_DENIED && !testCloseCalls,
        "legacy helper never translates snapshot failure into zero matches");

    reset(); add(20, L"CXExam.exe"); testNextFailAt = 1; testNextError = ERROR_BAD_LENGTH;
    oldCount = proc_instances(L"CXExam.exe", NULL, 0); code = GetLastError();
    check(oldCount == -1 && code == ERROR_BAD_LENGTH && testCloseCalls == 1,
        "legacy helper never returns a partial successful count after enumeration failure");

    reset();
    check(proc_instances(NULL, NULL, 0) == -1 && !testSnapshotCalls,
        "legacy helper rejects invalid executable path");

    at = GetTempPathW(32768, launchPath);
    if (at && at < 32000) {
        at = p_copy(launchPath, 32768, at, L"cxplus-process-guard-absent-");
        at = p_decimal(launchPath, 32768, at, GetCurrentProcessId());
        at = p_copy(launchPath, 32768, at, L"-");
        at = p_decimal(launchPath, 32768, at, GetTickCount());
        p_copy(launchPath, 32768, at, L"\\CXExam.exe");
    }
    check(at && at < 32000 && GetFileAttributesW(launchPath) == INVALID_FILE_ATTRIBUTES,
        "launch guard fixture path is absolute and does not exist");
    for (port = 38100; port < 39100; ++port) if (proc_port_free(port)) break;
    check(port < 39100, "read-only listener inspection finds an available test port");
    if (at && at < 32000 && port < 39100) {
        reset(); add(20, L"CXExam.exe");
        launch_rejection(port, ERROR_ALREADY_EXISTS,
            "proc_launch rejects an existing client before CreateProcessW");

        reset(); testSnapshotError = ERROR_ACCESS_DENIED;
        launch_rejection(port, ERROR_ACCESS_DENIED,
            "proc_launch rejects snapshot failure before CreateProcessW");

        reset(); testFirstError = ERROR_BAD_LENGTH;
        launch_rejection(port, ERROR_BAD_LENGTH,
            "proc_launch rejects first enumeration failure before CreateProcessW");

        reset(); add(20, L"unrelated.exe");
        testNextFailAt = 1; testNextError = ERROR_PARTIAL_COPY;
        launch_rejection(port, ERROR_PARTIAL_COPY,
            "proc_launch rejects incomplete enumeration before CreateProcessW");

        reset(); count = 123; process = (HANDLE)(ULONG_PTR)456;
        ok = proc_launch(launchPath, port, &count, &process, errorText, 512); code = GetLastError();
        check(!ok && count == 0 && process == NULL && code == ERROR_FILE_NOT_FOUND
            && testSnapshotCalls == 1 && testCreateCalls == 1 && !testBadCalls,
            "proc_launch with no conflict reaches only the safe CreateProcessW substitute");
    }

    output(failures ? "NATIVE PROCESS CHECK TESTS FAIL\n" : "NATIVE PROCESS CHECK TESTS PASS\n");
    ExitProcess(failures ? 1 : 0);
}
