#include "../account-window.h"

static CX_HOME_CONFIG config;
static WCHAR scenario[64];
static DWORD mainThread, dpi = 96;
static HWND found;
static void out(const char *value) { DWORD n; WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), value, (DWORD)lstrlenA(value), &n, NULL); }
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
    HWND child, edits[5]; DWORD i, count = 0, started = GetTickCount(); WCHAR name[64]; RECT bounds; LOGFONTW font;
    static const WPARAM limits[] = {CX_HOME_ADAPTER_URL_CAP - 1, 255, 255, 127, CX_HOME_API_KEY_CAP - 1};
    (void)unused;
    while (!found && GetTickCount() - started < 10000) { EnumWindows(find_window, 0); if (!found) Sleep(10); }
    check(found != NULL, "account HWND created");
    while (!IsWindowVisible(found) && GetTickCount() - started < 10000) Sleep(10);
    check(IsWindowVisible(found), "account window visible after hidden startup");
    check(SendMessageW(found, WM_GETICON, ICON_BIG, 0) != 0 && SendMessageW(found, WM_GETICON, ICON_SMALL, 0) != 0, "account window big and small icons bound");
    check(GetClassLongPtrW(found, GCLP_HICON) != 0 && GetClassLongPtrW(found, GCLP_HICONSM) != 0, "account class big and small icons bound");
    GetClientRect(found, &bounds);
    check(bounds.right == MulDiv(650, (int)dpi, 96) && bounds.bottom == MulDiv(400, (int)dpi, 96), "account client dimensions scale with DPI");
    for (child = GetWindow(found, GW_CHILD); child; child = GetWindow(child, GW_HWNDNEXT)) {
        GetClassNameW(child, name, 64);
        if (!lstrcmpiW(name, L"EDIT") || !lstrcmpiW(name, L"BUTTON")) check((GetWindowLongPtrW(child, GWL_STYLE) & WS_TABSTOP) != 0, "interactive control participates in tab navigation");
        if (!lstrcmpiW(name, L"EDIT") && count < 5) edits[count++] = child;
    }
    check(count == 5, "all account editors created");
    for (i = 0; i < count; i++) check((WPARAM)SendMessageW(edits[i], EM_GETLIMITTEXT, 0, 0) == limits[i], "editor limit matches storage capacity");
    check((GetWindowLongPtrW(edits[2], GWL_STYLE) & ES_PASSWORD) && (GetWindowLongPtrW(edits[4], GWL_STYLE) & ES_PASSWORD), "password and API key are masked");
    check(GetObjectW((HFONT)SendMessageW(edits[0], WM_GETFONT, 0, 0), sizeof(font), &font) == sizeof(font) && font.lfHeight == -MulDiv(16, (int)dpi, 96), "account font scales with DPI");
    if (!lstrcmpW(scenario, L"cancel")) SendMessageW(found, WM_CLOSE, 0, 0);
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
    if (GetEnvironmentVariableW(L"CXPLUS_NATIVE_UI_DPI", dpiText, 16)) { dpi = 0; for (i = 0; dpiText[i]; i++) dpi = dpi * 10 + (DWORD)(dpiText[i] - L'0'); }
    mainThread = GetCurrentThreadId(); started = GetTickCount();
    inspector = CreateThread(NULL, 0, inspect_window, NULL, 0, NULL); check(inspector != NULL, "UI inspector created");
    accepted = cx_account_window(NULL, &config);
    WaitForSingleObject(inspector, INFINITE); CloseHandle(inspector);
    if (!lstrcmpW(scenario, L"accept")) check(accepted && !lstrcmpW(config.apiKey, L"tk_mock-existing"), "verified API key applies only on success");
    else check(!accepted && !config.apiKey[0], "cancel or quit does not apply credentials");
    if (lstrcmpW(scenario, L"cancel")) check(GetTickCount() - started >= 200, "modal cleanup joins pending network worker");
    if (!lstrcmpW(scenario, L"quit")) {
        while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) if (message.message == WM_QUIT) { sawQuit = TRUE; break; }
        check(sawQuit, "modal loop reposts WM_QUIT");
        check(message.wParam == 17, "modal loop preserves WM_QUIT exit code");
    }
    out("NATIVE ACCOUNT WINDOW TESTS PASS\r\n"); ExitProcess(0);
}
