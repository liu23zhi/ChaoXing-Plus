#include "../account-window.h"

static CX_HOME_CONFIG config;
static WCHAR scenario[64];
static DWORD mainThread, dpi = 96;
static HWND found;
static void out(const char *value) { DWORD n; WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), value, (DWORD)lstrlenA(value), &n, NULL); }
static void check(BOOL condition, const char *message);
static UINT observed_window_dpi(HWND window) {
    typedef UINT (WINAPI *DPI_FOR_WINDOW)(HWND);
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    DPI_FOR_WINDOW getForWindow = user32 ? (DPI_FOR_WINDOW)GetProcAddress(user32, "GetDpiForWindow") : NULL;
    return getForWindow ? getForWindow(window) : 0;
}
static UINT observed_system_dpi(void) {
    typedef UINT (WINAPI *DPI_FOR_SYSTEM)(void);
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    DPI_FOR_SYSTEM getForSystem = user32 ? (DPI_FOR_SYSTEM)GetProcAddress(user32, "GetDpiForSystem") : NULL;
    return getForSystem ? getForSystem() : 0;
}
static void check_client_dimensions(HWND window) {
    RECT bounds; char message[192]; int expectedWidth, expectedHeight;
    GetClientRect(window, &bounds);
    expectedWidth = MulDiv(650, (int)dpi, 96); expectedHeight = MulDiv(400, (int)dpi, 96);
    wsprintfA(message, "INFO account client dimensions: requestedDpi=%lu expected=%dx%d actual=%ldx%ld systemDpi=%u windowDpi=%u",
        dpi, expectedWidth, expectedHeight, bounds.right, bounds.bottom, observed_system_dpi(), observed_window_dpi(window));
    out(message); out("\r\n");
    check(bounds.right == expectedWidth && bounds.bottom == expectedHeight, "account client dimensions scale with DPI");
}
static void check(BOOL condition, const char *message) {
    out(condition ? "PASS " : "FAIL "); out(message); out("\r\n"); if (!condition) ExitProcess(1);
}
static BOOL CALLBACK find_window(HWND window, LPARAM unused) {
    WCHAR name[64]; DWORD pid; (void)unused;
    GetWindowThreadProcessId(window, &pid);
    if (pid == GetCurrentProcessId() && GetClassNameW(window, name, 64) && !lstrcmpW(name, L"CXPlusNativeAccount")) { found = window; return FALSE; }
    return TRUE;
}
static DWORD WINAPI inspect_window(LPVOID unused) {
    HWND child, edits[5]; DWORD i, count = 0, started = GetTickCount(); WCHAR name[64]; LOGFONTW font;
    static const WPARAM limits[] = {CX_HOME_ADAPTER_URL_CAP - 1, 255, 255, 127, CX_HOME_API_KEY_CAP - 1};
    (void)unused;
    while (!found && GetTickCount() - started < 10000) { EnumWindows(find_window, 0); if (!found) Sleep(10); }
    check(found != NULL, "account HWND created");
    while (!IsWindowVisible(found) && GetTickCount() - started < 10000) Sleep(10);
    check(IsWindowVisible(found), "account window visible after hidden startup");
    check(SendMessageW(found, WM_GETICON, ICON_BIG, 0) != 0 && SendMessageW(found, WM_GETICON, ICON_SMALL, 0) != 0, "account window big and small icons bound");
    check(GetClassLongPtrW(found, GCLP_HICON) != 0 && GetClassLongPtrW(found, GCLP_HICONSM) != 0, "account class big and small icons bound");
    check_client_dimensions(found);
    for (child = GetWindow(found, GW_CHILD); child; child = GetWindow(child, GW_HWNDNEXT)) {
        GetClassNameW(child, name, 64);
        if (!lstrcmpiW(name, L"EDIT") || !lstrcmpiW(name, L"BUTTON")) check((GetWindowLongPtrW(child, GWL_STYLE) & WS_TABSTOP) != 0, "interactive control participates in tab navigation");
        if (!lstrcmpiW(name, L"EDIT") && count < 5) edits[count++] = child;
    }
    check(count == 5, "all account editors created");
    for (i = 0; i < count; i++) check((WPARAM)SendMessageW(edits[i], EM_GETLIMITTEXT, 0, 0) == limits[i], "editor limit matches storage capacity");
    check((GetWindowLongPtrW(edits[2], GWL_STYLE) & ES_PASSWORD) && (GetWindowLongPtrW(edits[4], GWL_STYLE) & ES_PASSWORD), "password and API key are masked");
    check(SendMessageW(GetDlgItem(found, 1606), BM_GETCHECK, 0, 0) == BST_CHECKED, "native-only token creation is enabled by default");
    check(GetObjectW((HFONT)SendMessageW(edits[0], WM_GETFONT, 0, 0), sizeof(font), &font) == sizeof(font) && font.lfHeight == -MulDiv(16, (int)dpi, 96), "account font scales with DPI");
    if (!lstrcmpW(scenario, L"cancel")) SendMessageW(found, WM_CLOSE, 0, 0);
    else if (!lstrcmpW(scenario, L"invalid-login-url")) {
        WCHAR statusText[512];
        SendMessageW(found, WM_COMMAND, 1605, 0);
        child = FindWindowExW(found, NULL, L"STATIC", NULL);
        for (; child; child = FindWindowExW(found, child, L"STATIC", NULL)) {
            GetWindowTextW(child, statusText, 512);
            if (!lstrcmpW(statusText, L"无法打开服务登录页，请检查上方 tikuAdapter 地址。")) break;
        }
        check(child != NULL, "non-http scheme is rejected before ShellExecute");
        SendMessageW(found, WM_CLOSE, 0, 0);
    }
    else if (!lstrcmpW(scenario, L"local-captcha") || !lstrcmpW(scenario, L"remote-captcha")) {
        DWORD refreshStarted = GetTickCount();
        SendMessageW(found, WM_COMMAND, 1601, 0);
        while (!IsWindowEnabled(GetDlgItem(found, 1601)) && GetTickCount() - refreshStarted < 15000) Sleep(10);
        check(IsWindowEnabled(GetDlgItem(found, 1601)), "captcha provider lookup completed");
        if (!lstrcmpW(scenario, L"local-captcha")) {
            WCHAR statusText[512];
            child = FindWindowExW(found, NULL, L"STATIC", NULL);
            for (; child; child = FindWindowExW(found, child, L"STATIC", NULL)) {
                GetWindowTextW(child, statusText, 512);
                if (!lstrcmpW(statusText, L"服务器已配置站内图形验证码。登录后使用已有访问令牌；如无令牌，请先勾选创建选项。")) break;
            }
            check(child != NULL, "local provider status confirms the native image flow");
            check(IsWindowEnabled(GetDlgItem(found, 1602)), "local provider enables account login");
            child = FindWindowExW(found, NULL, L"STATIC", NULL);
            for (; child; child = FindWindowExW(found, child, L"STATIC", NULL))
                if (SendMessageW(child, STM_GETIMAGE, IMAGE_BITMAP, 0)) break;
            check(child != NULL, "local provider displays the image challenge");
        } else {
            WCHAR statusText[512];
            child = FindWindowExW(found, NULL, L"STATIC", NULL);
            for (; child; child = FindWindowExW(found, child, L"STATIC", NULL)) {
                GetWindowTextW(child, statusText, 512);
                if (!lstrcmpW(statusText, L"服务端使用远程验证码，原生窗口不支持该交互，因此未显示本地图验证码。请在浏览器登录服务并打开“/access-tokens”创建访问令牌，再粘贴下方 API key 验证。")) break;
            }
            check(child != NULL, "remote provider shows actionable native limitation");
            check(!IsWindowEnabled(GetDlgItem(found, 1602)), "remote provider disables unsupported account login");
            child = FindWindowExW(found, NULL, L"STATIC", NULL);
            for (; child; child = FindWindowExW(found, child, L"STATIC", NULL))
                if (SendMessageW(child, STM_GETIMAGE, IMAGE_BITMAP, 0)) break;
            check(child == NULL, "remote provider never displays a local image fallback");
        }
        SendMessageW(found, WM_CLOSE, 0, 0);
    }
    else {
        SetWindowTextW(edits[4], L"tk_mock-existing");
        SendMessageW(found, WM_COMMAND, 1603, 0);
        check(!IsWindowEnabled(GetDlgItem(found, 1603)), "network request disables actions");
        if (!lstrcmpW(scenario, L"quit")) check(PostThreadMessageW(mainThread, WM_QUIT, 17, 0), "WM_QUIT posted to modal thread");
        else if (lstrcmpW(scenario, L"accept")) { SendMessageW(found, WM_CLOSE, 0, 0); check(IsWindow(found), "closing waits for in-flight network worker"); }
    }
    return 0;
}
void WinMainCRTStartup(void) {
    static WCHAR dpiText[16]; DWORD i, started; HANDLE inspector; MSG message; BOOL accepted, sawQuit = FALSE;
    GetEnvironmentVariableW(L"CX_ADAPTER_TEST_BASE", config.adapterBaseUrl, CX_HOME_ADAPTER_URL_CAP);
    GetEnvironmentVariableW(L"CX_ACCOUNT_TEST_SCENARIO", scenario, 64);
    if (!lstrcmpW(scenario, L"invalid-login-url")) lstrcpyW(config.adapterBaseUrl, L"javascript:alert(1)");
    if (GetEnvironmentVariableW(L"CXPLUS_NATIVE_UI_DPI", dpiText, 16)) { dpi = 0; for (i = 0; dpiText[i]; i++) dpi = dpi * 10 + (DWORD)(dpiText[i] - L'0'); }
    mainThread = GetCurrentThreadId(); started = GetTickCount();
    inspector = CreateThread(NULL, 0, inspect_window, NULL, 0, NULL); check(inspector != NULL, "UI inspector created");
    accepted = cx_account_window(NULL, &config);
    WaitForSingleObject(inspector, INFINITE); CloseHandle(inspector);
    if (!lstrcmpW(scenario, L"accept")) check(accepted && !lstrcmpW(config.apiKey, L"tk_mock-existing"), "verified API key applies only on success");
    else check(!accepted && !config.apiKey[0], "cancel or quit does not apply credentials");
    if (lstrcmpW(scenario, L"cancel") && lstrcmpW(scenario, L"invalid-login-url")) check(GetTickCount() - started >= 200, "modal cleanup joins pending network worker");
    if (!lstrcmpW(scenario, L"quit")) {
        while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) if (message.message == WM_QUIT) { sawQuit = TRUE; break; }
        check(sawQuit, "modal loop reposts WM_QUIT");
        check(message.wParam == 17, "modal loop preserves WM_QUIT exit code");
    }
    out("NATIVE ACCOUNT WINDOW TESTS PASS\r\n"); ExitProcess(0);
}
