#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include "../selection.h"

static DWORD failedChecks;
static WCHAR errorText[512];
static WCHAR selectedPath[CX_DISCOVERY_MAX_PATH];
static WCHAR fixturePath[CX_DISCOVERY_MAX_PATH];
static UINT_PTR chooseTimer;

static void output(const char *text) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &written, NULL);
}

static void check(BOOL passed, const char *name) {
    output(passed ? "PASS " : "FAIL "); output(name); output("\n");
    if (!passed) ++failedChecks;
}

static void probe_tests(void) {
    CX_DISCOVERY_RESULT candidates;
    CX_CLIENT_CANDIDATE items[2];
    CX_SELECTION_PROBE probe;
    ZeroMemory(&candidates, sizeof(candidates));
    ZeroMemory(items, sizeof(items));
    items[0].path = L"C:\\Exam One\\CXExam.exe";
    items[0].machine = CX_DISCOVERY_MACHINE_X64;
    lstrcpyW(items[0].version, L"4.3.0.4");
    items[1].path = L"D:\\中文 考试客户端\\CXExam.exe";
    items[1].machine = CX_DISCOVERY_MACHINE_X86;
    lstrcpyW(items[1].version, L"4.1.4.25512");
    candidates.items = items; candidates.count = 2; candidates.recommendedIndex = 1;
    ZeroMemory(&probe, sizeof(probe));
    check(cx_selection_probe(&candidates, &probe, errorText, 512), "hidden selection controls can be created");
    check(probe.itemCount == 2, "every scanned candidate is listed");
    check(probe.selectedIndex == 1, "the recommended candidate is selected initially");
    check(probe.browseAvailable, "manual browse remains available");
    check(probe.unicodeWindow && probe.titleMatches, "the native window has the Chinese product title");
    candidates.items = NULL; candidates.count = 0;
    ZeroMemory(&probe, sizeof(probe));
    check(cx_selection_probe(&candidates, &probe, errorText, 512) && probe.itemCount == 0
          && probe.selectedIndex == -1 && probe.browseAvailable, "an empty scan still permits manual browsing");
    check(!cx_selection_probe(&candidates, NULL, errorText, 512), "a missing probe output is rejected");
}

static VOID CALLBACK choose_row(HWND owner, UINT message, UINT_PTR timer, DWORD tick) {
    HWND window = FindWindowW(L"CXPlusNativeClientSelection", NULL);
    DWORD pid = 0;
    (void)owner; (void)message; (void)tick;
    if (window) GetWindowThreadProcessId(window, &pid);
    if (pid != GetCurrentProcessId()) return;
    KillTimer(NULL, timer); chooseTimer = 0;
    SendMessageW(window, WM_COMMAND, MAKEWPARAM(IDOK, BN_CLICKED), 0);
}

void WINAPI SelectionTestMain(void) {
    int argc;
    WCHAR **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    BOOL visible = argv && argc == 2 && lstrcmpW(argv[1], L"--show-cancel") == 0;
    BOOL choose = argv && argc == 3 && lstrcmpW(argv[1], L"--choose") == 0;
    if (choose) lstrcpynW(fixturePath, argv[2], CX_DISCOVERY_MAX_PATH);
    if (argv) LocalFree(argv);
    if (choose) {
        CX_DISCOVERY_RESULT candidates;
        CX_CLIENT_CANDIDATE item;
        CX_SELECTION_STATUS status;
        ZeroMemory(&candidates, sizeof(candidates)); ZeroMemory(&item, sizeof(item));
        item.path = fixturePath; item.machine = CX_DISCOVERY_MACHINE_X86;
        candidates.items = &item; candidates.count = 1;
        chooseTimer = SetTimer(NULL, 0, 100, choose_row);
        check(chooseTimer != 0, "a test-only timer can choose the current process window");
        status = cx_select_client(&candidates, FALSE, selectedPath, CX_DISCOVERY_MAX_PATH, errorText, 512);
        if (chooseTimer) KillTimer(NULL, chooseTimer);
        check(status == CX_SELECTION_SELECTED && lstrcmpiW(selectedPath, fixturePath) == 0,
              "choosing a row returns its validated Unicode PE path");
    } else if (visible) {
        CX_DISCOVERY_RESULT empty;
        CX_SELECTION_STATUS status;
        ZeroMemory(&empty, sizeof(empty));
        lstrcpyW(selectedPath, L"must be cleared");
        status = cx_select_client(&empty, FALSE, selectedPath, CX_DISCOVERY_MAX_PATH, errorText, 512);
        check(status == CX_SELECTION_CANCELLED && !selectedPath[0], "closing the actual window cancels without a selected client");
    } else {
        probe_tests();
        check(cx_select_client(NULL, FALSE, NULL, 0, errorText, 512) == CX_SELECTION_ERROR,
              "invalid selection output fails before opening a window");
    }
    output(failedChecks ? "NATIVE SELECTION TESTS FAIL\n" : "NATIVE SELECTION TESTS PASS\n");
    ExitProcess(failedChecks ? 1 : 0);
}
