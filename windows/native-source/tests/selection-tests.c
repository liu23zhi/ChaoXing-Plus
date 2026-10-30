#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include "../selection.h"
#include "../assets.h"
#include "../resource.h"

static DWORD failedChecks;
static WCHAR errorText[512];
static WCHAR selectedPath[CX_DISCOVERY_MAX_PATH];
static WCHAR fixturePath[CX_DISCOVERY_MAX_PATH];
static WCHAR capsPath[CX_DISCOVERY_MAX_PATH];
static UINT_PTR chooseTimer;
static BOOL requestFullScan;
static DWORD progressReports;
static DWORD progressDirectories;
static DWORD progressCancelChecks;
static DWORD progressCancelAfter;
static BOOL progressVisibleChecked;

static BOOL CALLBACK find_progress_callback(HWND hwnd, LPARAM parameter) {
    WCHAR name[64];
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != GetCurrentProcessId()) return TRUE;
    if (!GetClassNameW(hwnd, name, 64) || lstrcmpW(name, CX_SCAN_PROGRESS_CLASS) != 0) return TRUE;
    *(HWND *)parameter = hwnd;
    return FALSE;
}

/* Other test files may run selection-tests.exe concurrently, so only accept a
   progress window owned by this process instead of the first class match. */
static HWND find_progress_window(void) {
    HWND found = NULL;
    EnumWindows(find_progress_callback, (LPARAM)&found);
    return found;
}

static DWORD expected_ui_dpi(void) {
    WCHAR text[16];
    DWORD length, value = 0, i;
    length = GetEnvironmentVariableW(L"CXPLUS_NATIVE_UI_DPI", text, 16);
    if (!length || length >= 16) return 0;
    for (i = 0; i < length; ++i) {
        if (text[i] < L'0' || text[i] > L'9') return 0;
        value = value * 10 + (DWORD)(text[i] - L'0');
        if (value > 480) return 0;
    }
    return value >= 96 ? value : 0;
}

static WCHAR progressRoot[CX_DISCOVERY_MAX_PATH];
static WCHAR progressTemp[CX_DISCOVERY_MAX_PATH];
static WCHAR progressNested[CX_DISCOVERY_MAX_PATH];

static void test_progress_callback(void *context, DWORD directories, DWORD candidates) {
    (void)context; (void)candidates;
    ++progressReports;
    progressDirectories = directories;
}

static BOOL test_cancel_callback(void *context) {
    (void)context;
    ++progressCancelChecks;
    return progressCancelAfter && progressCancelChecks >= progressCancelAfter;
}

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
    check(cx_selection_probe(&candidates, FALSE, NULL, &probe, errorText, 512), "hidden selection controls can be created");
    check(probe.itemCount == 2, "every scanned candidate is listed");
    check(probe.selectedIndex == 1, "the recommended candidate is selected initially");
    check(probe.browseAvailable, "manual browse remains available");
    check(probe.scanAllAvailable, "full disk scan remains available");
    check(probe.injectOptionCount == 3, "injection mode combo offers auto/cdp-port/dll-proxy");
    check(probe.injectSelectedIndex == 0, "injection mode defaults to auto");
    /* Proxy choices depend on installed DLLs; the auto entry is always first. */
    check(probe.carrierOptionCount >= 1 && probe.carrierAutoPresent,
          "carrier combo begins with the automatic import-table option");
    check(probe.carrierSelectedIndex == 0, "carrier defaults to auto");
    check(probe.carrierOptionCount == 1 && probe.carrierAutoOnly,
          "auto injection mode keeps only the automatic carrier entry");
    check(probe.carrierOptionCountForProxy > probe.carrierOptionCount,
          "dll-proxy mode expands the carrier list");
    check(probe.statusControlPresent, "the injection hint control exists for greyed modes");
    {
        char *payload = NULL;
        DWORD payloadLength = 0;
        check(cx_asset_proxy_exists(L"winmm.dll"), "the winmm proxy DLL is embedded in the executable");
        check(cx_asset_load_proxy(L"winmm.dll", &payload, &payloadLength, errorText, 512)
              && payload && payloadLength > 64 && payload[0] == 'M' && payload[1] == 'Z',
              "the embedded proxy is a PE image");
        if (payload) HeapFree(GetProcessHeap(), 0, payload);
        payload = NULL;
        check(!cx_asset_load_proxy(L"not-a-carrier.dll", &payload, &payloadLength, errorText, 512)
              && !payload, "unknown embedded proxy carriers are rejected");
    }
    check(probe.injectComboWidth >= 120 && probe.injectComboHeight >= 16, "injection combo has a usable size");
    check(probe.unicodeWindow && probe.titleMatches, "the native window has the Chinese product title");
    check(probe.classIconsMatch, "selection class icons match the embedded application icon");
    check(probe.windowIconsMatch, "selection window icons match the embedded application icon");
    {
        DWORD expectedDpi = expected_ui_dpi();
        check(expectedDpi ? probe.layoutScale == expectedDpi : probe.layoutScale >= 96,
              "selection layout uses the active DPI scale");
    }
    candidates.items = NULL; candidates.count = 0;
    ZeroMemory(&probe, sizeof(probe));
    check(cx_selection_probe(&candidates, FALSE, NULL, &probe, errorText, 512) && probe.itemCount == 0
          && probe.selectedIndex == -1 && probe.browseAvailable && probe.scanAllAvailable, "an empty scan still permits manual browsing and full scanning");
    check(!cx_selection_probe(&candidates, FALSE, NULL, NULL, errorText, 512), "a missing probe output is rejected");
    ZeroMemory(&probe, sizeof(probe));
    check(cx_selection_probe(&candidates, FALSE, NULL, &probe, errorText, 512) && probe.noticeShown,
          "the default selection heading is shown without a notice");
    ZeroMemory(&probe, sizeof(probe));
    check(cx_selection_probe(&candidates, FALSE, L"已取消全盘扫描，保留原候选；可重试或手动浏览。", &probe, errorText, 512)
          && probe.noticeShown, "a cancelled full scan notice becomes the selection heading");
}

static void progress_scan_test(void) {
    WCHAR number[16];
    CX_DISCOVERY_OPTIONS scan;
    CX_DISCOVERY_ROOTS roots;
    CX_DISCOVERY_RESULT result;
    const WCHAR *fixedRoots[1];
    CX_SCAN_PROGRESS *window = NULL;
    DWORD length, pid = GetCurrentProcessId();
    DWORD digits = 0;
    do { number[digits++] = (WCHAR)(L'0' + pid % 10); pid /= 10; } while (pid && digits < 16);
    {
        DWORD left = 0, right = digits ? digits - 1 : 0;
        while (left < right) { WCHAR hold = number[left]; number[left++] = number[right]; number[right--] = hold; }
        number[digits] = 0;
    }
    length = GetTempPathW(CX_DISCOVERY_MAX_PATH, progressTemp);
    if (!length || length >= CX_DISCOVERY_MAX_PATH) { check(FALSE, "temporary directory is available"); return; }
    lstrcpynW(progressRoot, progressTemp, CX_DISCOVERY_MAX_PATH);
    lstrcatW(progressRoot, L"cx-native-progress-"); lstrcatW(progressRoot, number);
    CreateDirectoryW(progressRoot, NULL);
    lstrcpynW(progressNested, progressRoot, CX_DISCOVERY_MAX_PATH); lstrcatW(progressNested, L"\\alpha");
    CreateDirectoryW(progressNested, NULL);
    lstrcatW(progressNested, L"\\beta"); CreateDirectoryW(progressNested, NULL);
    lstrcpynW(progressNested, progressRoot, CX_DISCOVERY_MAX_PATH); lstrcatW(progressNested, L"\\gamma");
    CreateDirectoryW(progressNested, NULL);

    SetEnvironmentVariableW(L"CXPLUS_NATIVE_SCAN_PROGRESS_HIDDEN", L"1");
    SetEnvironmentVariableW(L"CXPLUS_NATIVE_SCAN_PROGRESS_AUTOCANCEL_MS", NULL);
    check(cx_scan_progress_begin(&window, errorText, 512) && window, "hidden full-scan progress window thread starts");
    {
        HWND progressWindow = find_progress_window();
        HICON icon = LoadIconW(GetModuleHandleW(NULL), MAKEINTRESOURCEW(CX_RESOURCE_APP_ICON));
        check(icon && progressWindow && (HICON)GetClassLongPtrW(progressWindow, GCLP_HICON) == icon
              && (HICON)GetClassLongPtrW(progressWindow, GCLP_HICONSM) == icon,
              "progress class icons match the embedded application icon");
        check(icon && progressWindow && (HICON)SendMessageW(progressWindow, WM_GETICON, ICON_BIG, 0) == icon
              && (HICON)SendMessageW(progressWindow, WM_GETICON, ICON_SMALL, 0) == icon,
              "progress window icons match the embedded application icon");
        check(progressWindow && !(GetWindowLongPtrW(progressWindow, GWL_EXSTYLE) & WS_EX_DLGMODALFRAME),
              "progress title bar permits the small application icon");
    }
    {
        CX_DISCOVERY_OPTIONS bind;
        ZeroMemory(&bind, sizeof(bind));
        cx_scan_progress_bind(&bind, window);
        check(bind.onProgress && bind.cancelRequested, "progress window binds discovery progress/cancel hooks");
        if (bind.onProgress) bind.onProgress(bind.progressContext, 4, 2);
    }
    Sleep(150);
    check(!cx_scan_progress_end(window, errorText, 512), "ending the progress window normally is not a cancellation");
    {
        DWORD waited = 0;
        while (waited < 3000 && find_progress_window()) { Sleep(20); waited += 20; }
    }
    check(find_progress_window() == NULL, "the progress window is destroyed after it ends");

    SetEnvironmentVariableW(L"CXPLUS_NATIVE_UI_DPI", L"144");
    window = NULL;
    check(cx_scan_progress_begin(&window, errorText, 512) && window, "the hidden progress window starts at a high-DPI scale");
    {
        HWND highDpi = find_progress_window();
        RECT bounds;
        check(highDpi && GetWindowRect(highDpi, &bounds)
              && bounds.right - bounds.left == MulDiv(460, 144, 96),
              "the high-DPI progress window scales its width from 96 DPI metrics");
    }
    check(!cx_scan_progress_end(window, errorText, 512), "the high-DPI progress window closes normally");
    SetEnvironmentVariableW(L"CXPLUS_NATIVE_UI_DPI", NULL);

    SetEnvironmentVariableW(L"CXPLUS_NATIVE_SCAN_PROGRESS_AUTOCANCEL_MS", L"80");
    window = NULL;
    check(cx_scan_progress_begin(&window, errorText, 512) && window, "hidden progress window starts for auto-cancel");
    {
        DWORD waited = 0;
        while (waited < 2000 && find_progress_window()) { Sleep(50); waited += 50; }
    }
    check(find_progress_window() == NULL, "the auto-cancel timer destroys the progress window");
    check(cx_scan_progress_end(window, errorText, 512), "the auto-cancel timer reports cancellation");
    SetEnvironmentVariableW(L"CXPLUS_NATIVE_SCAN_PROGRESS_HIDDEN", NULL);
    SetEnvironmentVariableW(L"CXPLUS_NATIVE_SCAN_PROGRESS_AUTOCANCEL_MS", NULL);

    fixedRoots[0] = progressRoot;
    ZeroMemory(&roots, sizeof(roots));
    roots.fixedRoots = fixedRoots; roots.fixedRootCount = 1;
    progressReports = 0; progressDirectories = 0; progressCancelChecks = 0; progressCancelAfter = 0;
    ZeroMemory(&scan, sizeof(scan));
    scan.mode = CX_DISCOVERY_SCAN_ALL; scan.enumerateAll = TRUE; scan.rescan = TRUE; scan.noScanCache = TRUE;
    scan.roots = &roots;
    scan.onProgress = test_progress_callback;
    scan.cancelRequested = test_cancel_callback;
    cx_discovery_init(&result);
    check(cx_discovery_scan(&scan, &result, errorText, 512) && !result.cancelled, "full scan without cancellation completes");
    check(progressReports > 0 && progressDirectories >= 3, "discovery reports visited directory progress");
    cx_discovery_free(&result);

    progressCancelChecks = 0; progressCancelAfter = 2;
    cx_discovery_init(&result);
    check(cx_discovery_scan(&scan, &result, errorText, 512) && result.cancelled,
          "the cancel callback reports a cancelled full scan");
    check(progressCancelChecks >= 2, "the cancel callback is polled during traversal");
    cx_discovery_free(&result);

    lstrcpynW(progressNested, progressRoot, CX_DISCOVERY_MAX_PATH); lstrcatW(progressNested, L"\\alpha\\beta");
    RemoveDirectoryW(progressNested);
    lstrcpynW(progressNested, progressRoot, CX_DISCOVERY_MAX_PATH); lstrcatW(progressNested, L"\\alpha");
    RemoveDirectoryW(progressNested);
    lstrcpynW(progressNested, progressRoot, CX_DISCOVERY_MAX_PATH); lstrcatW(progressNested, L"\\gamma");
    RemoveDirectoryW(progressNested);
    RemoveDirectoryW(progressRoot);
}

static VOID CALLBACK progress_inspect(HWND owner, UINT message, UINT_PTR timer, DWORD tick) {
    HWND window = find_progress_window();
    DWORD pid = 0;
    (void)owner; (void)message; (void)tick;
    if (!window) return;
    GetWindowThreadProcessId(window, &pid);
    if (pid != GetCurrentProcessId()) return;
    KillTimer(NULL, timer); chooseTimer = 0;
    progressVisibleChecked = IsWindowVisible(window) ? TRUE : FALSE;
    SendMessageW(window, WM_COMMAND, MAKEWPARAM(CX_SCAN_PROGRESS_CANCEL_ID, BN_CLICKED), 0);
}

static VOID CALLBACK choose_row(HWND owner, UINT message, UINT_PTR timer, DWORD tick) {
    HWND window = FindWindowW(L"CXPlusNativeClientSelection", NULL);
    DWORD pid = 0;
    (void)owner; (void)message; (void)tick;
    if (window) GetWindowThreadProcessId(window, &pid);
    if (pid != GetCurrentProcessId()) return;
    KillTimer(NULL, timer); chooseTimer = 0;
    SendMessageW(window, WM_COMMAND, MAKEWPARAM(requestFullScan ? 1004 : IDOK, BN_CLICKED), 0);
}

void WINAPI SelectionTestMain(void) {
    int argc;
    WCHAR **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    BOOL visible = argv && argc == 2 && lstrcmpW(argv[1], L"--show-cancel") == 0;
    BOOL progressMode = argv && argc == 2 && lstrcmpW(argv[1], L"--scan-progress") == 0;
    BOOL choose = argv && argc == 3 && lstrcmpW(argv[1], L"--choose") == 0;
    BOOL capsMode = argv && argc == 3 && lstrcmpW(argv[1], L"--caps") == 0;
    requestFullScan = argv && argc == 2 && lstrcmpW(argv[1], L"--request-scan-all") == 0;
    if (choose) lstrcpynW(fixturePath, argv[2], CX_DISCOVERY_MAX_PATH);
    if (capsMode) lstrcpynW(capsPath, argv[2], CX_DISCOVERY_MAX_PATH);
    if (argv) LocalFree(argv);
    if (capsMode) {
        DWORD inject = 0, carrier = 0, reasons = 0;
        DWORD index, written = 0;
        char line[256];
        BOOL ok = capsPath[0] && cx_selection_client_caps(capsPath, &inject, &carrier, &reasons);
        written = (DWORD)wsprintfA(line, "caps: injectMask=0x%lX carrierMask=0x%lX reasons=0x%lX embedded=",
                                   (unsigned long)inject, (unsigned long)carrier, (unsigned long)reasons);
        for (index = 0; index < cx_asset_proxy_count() && written + 2 < (DWORD)sizeof(line); ++index) {
            const WCHAR *name = cx_asset_proxy_name(index);
            DWORD k = 0;
            if (index && written + 1 < (DWORD)sizeof(line)) line[written++] = ',';
            while (name && name[k] && written + 1 < (DWORD)sizeof(line)) line[written++] = (char)name[k++];
        }
        line[written++] = '\n';
        line[written] = 0;
        output(line);
        check(ok, "client capability probe answers for the requested client");
        check(cx_asset_proxy_count() > 0, "the executable carries an embedded proxy DLL");
    } else if (requestFullScan) {
        CX_DISCOVERY_RESULT empty;
        CX_SELECTION_STATUS status;
        ZeroMemory(&empty, sizeof(empty));
        lstrcpyW(selectedPath, L"must be cleared");
        chooseTimer = SetTimer(NULL, 0, 100, choose_row);
        check(chooseTimer != 0, "a test-only timer can request a full scan");
        status = cx_select_client(&empty, FALSE, NULL, selectedPath, CX_DISCOVERY_MAX_PATH, errorText, 512);
        if (chooseTimer) KillTimer(NULL, chooseTimer);
        check(status == CX_SELECTION_SCAN_ALL && !selectedPath[0], "the full scan button requests scanning without selecting or launching a client");
    } else if (choose) {
        CX_DISCOVERY_RESULT candidates;
        CX_CLIENT_CANDIDATE item;
        CX_SELECTION_STATUS status;
        ZeroMemory(&candidates, sizeof(candidates)); ZeroMemory(&item, sizeof(item));
        item.path = fixturePath; item.machine = CX_DISCOVERY_MACHINE_X86;
        candidates.items = &item; candidates.count = 1;
        chooseTimer = SetTimer(NULL, 0, 100, choose_row);
        check(chooseTimer != 0, "a test-only timer can choose the current process window");
        status = cx_select_client(&candidates, FALSE, NULL, selectedPath, CX_DISCOVERY_MAX_PATH, errorText, 512);
        if (chooseTimer) KillTimer(NULL, chooseTimer);
        check(status == CX_SELECTION_SELECTED && lstrcmpiW(selectedPath, fixturePath) == 0,
              "choosing a row returns its validated Unicode PE path");
    } else if (visible) {
        CX_DISCOVERY_RESULT empty;
        CX_SELECTION_STATUS status;
        ZeroMemory(&empty, sizeof(empty));
        lstrcpyW(selectedPath, L"must be cleared");
        status = cx_select_client(&empty, FALSE, NULL, selectedPath, CX_DISCOVERY_MAX_PATH, errorText, 512);
        check(status == CX_SELECTION_CANCELLED && !selectedPath[0], "closing the actual window cancels without a selected client");
    } else if (progressMode) {
        CX_SCAN_PROGRESS *window = NULL;
        check(cx_scan_progress_begin(&window, errorText, 512) && window, "visible progress window starts");
        chooseTimer = SetTimer(NULL, 0, 150, progress_inspect);
        check(chooseTimer != 0, "a test-only timer can inspect the progress window");
        {
            DWORD started = GetTickCount();
            while (GetTickCount() - started < 1500 && chooseTimer) {
                MSG message;
                while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                Sleep(20);
            }
        }
        if (chooseTimer) { KillTimer(NULL, chooseTimer); chooseTimer = 0; }
        check(progressVisibleChecked, "the progress window is visible to the operating system");
        check(cx_scan_progress_end(window, errorText, 512), "clicking cancel reports a progress-window cancellation");
    } else {
        probe_tests();
        progress_scan_test();
        check(cx_select_client(NULL, FALSE, NULL, NULL, 0, errorText, 512) == CX_SELECTION_ERROR,
              "invalid selection output fails before opening a window");
    }
    output(failedChecks ? "NATIVE SELECTION TESTS FAIL\n" : "NATIVE SELECTION TESTS PASS\n");
    ExitProcess(failedChecks ? 1 : 0);
}



