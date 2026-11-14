#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include "account-window.h"
#include "adapter-account.h"
#include "resource.h"

#define ACCOUNT_CLASS L"CXPlusNativeAccount"
#define ACCOUNT_REFRESH 1601
#define ACCOUNT_LOGIN 1602
#define ACCOUNT_KEY 1603
#define ACCOUNT_CANCEL 1604
#define ACCOUNT_OPEN_LOGIN 1605
#define ACCOUNT_CREATE_TOKEN 1606
#define ACCOUNT_DONE (WM_APP + 25)

typedef struct ACCOUNT_WINDOW {
    HWND window, parent, base, username, password, answer, image, key, status, create;
    HWND openLogin;
    HANDLE worker;
    DWORD operation;
    DWORD dpi;
    HFONT font;
    CX_HOME_CONFIG *config;
    CX_ADAPTER_AUTH_SETTINGS authSettings;
    CX_ADAPTER_CAPTCHA captcha;
    CX_ADAPTER_ACCOUNT account;
    HBITMAP bitmap;
    WCHAR baseText[CX_HOME_ADAPTER_URL_CAP], userText[256], passwordText[256], answerText[128];
    WCHAR keyText[CX_HOME_API_KEY_CAP], error[512];
    WCHAR captchaToken[CX_ADAPTER_TOKEN_CAP], captchaBase[CX_HOME_ADAPTER_URL_CAP];
    BOOL ok, accepted, createIfMissing, closing, captchaSettingsLoaded;
} ACCOUNT_WINDOW;

static DWORD aw_ui_dpi(void) {
    WCHAR text[16]; DWORD length, value = 0, i; HDC screen;
    typedef UINT (WINAPI *DPI_FOR_SYSTEM)(void);
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    DPI_FOR_SYSTEM getForSystem = user32 ? (DPI_FOR_SYSTEM)GetProcAddress(user32, "GetDpiForSystem") : NULL;
    length = GetEnvironmentVariableW(L"CXPLUS_NATIVE_UI_DPI", text, 16);
    if (length && length < 16) {
        for (i = 0; i < length; i++) {
            if (text[i] < L'0' || text[i] > L'9') { value = 0; break; }
            value = value * 10 + (DWORD)(text[i] - L'0'); if (value > 480) { value = 0; break; }
        }
        if (value >= 96) return value;
    }
    value = getForSystem ? getForSystem() : 0;
    if (!value) { screen = GetDC(NULL); if (screen) { value = (DWORD)GetDeviceCaps(screen, LOGPIXELSX); ReleaseDC(NULL, screen); } }
    return value ? value : 96;
}
static int aw_scale(const ACCOUNT_WINDOW *state, int value) { return MulDiv(value, (int)state->dpi, 96); }
static void aw_status(ACCOUNT_WINDOW *state, const WCHAR *text) { SetWindowTextW(state->status, text); }
static void aw_buttons(ACCOUNT_WINDOW *state, BOOL enabled) {
    EnableWindow(GetDlgItem(state->window, ACCOUNT_REFRESH), enabled);
    EnableWindow(GetDlgItem(state->window, ACCOUNT_LOGIN), enabled);
    EnableWindow(GetDlgItem(state->window, ACCOUNT_KEY), enabled);
    EnableWindow(GetDlgItem(state->window, ACCOUNT_OPEN_LOGIN), enabled);
    EnableWindow(state->base, enabled); EnableWindow(state->username, enabled); EnableWindow(state->password, enabled);
    EnableWindow(state->answer, enabled); EnableWindow(state->key, enabled); EnableWindow(state->create, enabled);
    if (enabled) {
        BOOL localCaptcha = state->captchaSettingsLoaded && !lstrcmpiW(state->authSettings.captchaProvider, L"local");
        EnableWindow(GetDlgItem(state->window, ACCOUNT_LOGIN), localCaptcha);
        EnableWindow(state->answer, localCaptcha);
    }
}
static void aw_clear_captcha(ACCOUNT_WINDOW *state) {
    SendMessageW(state->image, STM_SETIMAGE, IMAGE_BITMAP, 0);
    if (state->bitmap) DeleteObject(state->bitmap);
    state->bitmap = NULL;
    ZeroMemory(&state->captcha, sizeof(state->captcha));
    state->captchaBase[0] = 0;
}
static BOOL aw_starts_with_ci(const WCHAR *text, const WCHAR *prefix) {
    while (*prefix) {
        WCHAR left = *text++, right = *prefix++;
        if (left >= L'A' && left <= L'Z') left += L'a' - L'A';
        if (right >= L'A' && right <= L'Z') right += L'a' - L'A';
        if (left != right) return FALSE;
    }
    return TRUE;
}
static BOOL aw_build_login_url(const WCHAR *base, WCHAR *url, DWORD cap) {
    /*
     * 剥掉 base URL 尾部的 API 前缀后再拼 /login。
     *
     * 2026-11-14 后端改名 /adapter-service → /api：用户保存的 base URL 既可能带
     * 旧前缀也可能带新前缀，两者都要认，否则会拼出
     * https://host/adapter-service/login 这种不存在的页面路径。
     *
     * 长度一律 lstrlenW 现算，不写死 16（旧实现硬编码了旧前缀的字符数）。
     */
    static const WCHAR *const prefixes[] = { L"/api", L"/adapter-service" };
    DWORD length, i;
    if (!base || !url || cap < 8) return FALSE;
    lstrcpynW(url, base, (int)cap);
    length = (DWORD)lstrlenW(url);
    while (length && (url[length - 1] == L' ' || url[length - 1] == L'\t')) url[--length] = 0;
    if (!aw_starts_with_ci(url, L"http://") && !aw_starts_with_ci(url, L"https://")) return FALSE;
    while (length && url[length - 1] == L'/') url[--length] = 0;
    for (i = 0; i < sizeof(prefixes) / sizeof(prefixes[0]); i++) {
        DWORD suffixLength = (DWORD)lstrlenW(prefixes[i]);
        if (length >= suffixLength && !lstrcmpiW(url + length - suffixLength, prefixes[i])) {
            length -= suffixLength; url[length] = 0;
            while (length && url[length - 1] == L'/') url[--length] = 0;
            break;
        }
    }
    if (!length || length + 7 >= cap) return FALSE;
    lstrcatW(url, L"/login"); return TRUE;
}
static HWND aw_control(ACCOUNT_WINDOW *state, const WCHAR *className, const WCHAR *text, DWORD style,
    int x, int y, int width, int height, int id) {
    BOOL edit = lstrcmpW(className, L"EDIT") == 0;
    HWND result = CreateWindowExW(edit ? WS_EX_CLIENTEDGE : 0,
        className, text, WS_CHILD | WS_VISIBLE | style | (edit || !lstrcmpW(className, L"BUTTON") ? WS_TABSTOP : 0), aw_scale(state, x), aw_scale(state, y), aw_scale(state, width), aw_scale(state, height),
        state->window, (HMENU)(INT_PTR)id, GetModuleHandleW(NULL), NULL);
    SendMessageW(result, WM_SETFONT, (WPARAM)state->font, TRUE);
    return result;
}
static DWORD WINAPI aw_work(LPVOID context) {
    ACCOUNT_WINDOW *state = (ACCOUNT_WINDOW *)context;
    state->error[0] = 0; state->ok = FALSE;
    if (state->operation == ACCOUNT_REFRESH) {
        state->captchaSettingsLoaded = FALSE;
        ZeroMemory(&state->authSettings, sizeof(state->authSettings));
        state->ok = cx_adapter_auth_settings(state->baseText, &state->authSettings, state->error, 512);
        if (state->ok) {
            state->captchaSettingsLoaded = TRUE;
            if (!lstrcmpiW(state->authSettings.captchaProvider, L"local"))
                state->ok = cx_adapter_captcha_begin(state->baseText, &state->captcha, state->error, 512);
        }
    } else if (state->operation == ACCOUNT_KEY) {
        state->ok = cx_adapter_key_check(state->baseText, state->keyText, state->error, 512);
    } else if (state->operation == ACCOUNT_LOGIN) {
        state->captchaToken[0] = 0;
        state->ok = cx_adapter_captcha_verify(state->baseText, state->captcha.challengeId,
            state->answerText, state->captchaToken, CX_ADAPTER_TOKEN_CAP, state->error, 512)
            && cx_adapter_account_login(state->baseText, state->userText, state->passwordText,
                state->captchaToken, &state->account, state->error, 512)
            && cx_adapter_account_token(state->baseText, state->createIfMissing,
                &state->account, state->error, 512);
        SecureZeroMemory(state->captchaToken, sizeof(state->captchaToken));
        SecureZeroMemory(state->passwordText, sizeof(state->passwordText));
    }
    PostMessageW(state->window, ACCOUNT_DONE, 0, 0);
    return 0;
}
static void aw_start(ACCOUNT_WINDOW *state, DWORD operation) {
    if (state->worker || state->closing) return;
    GetWindowTextW(state->base, state->baseText, CX_HOME_ADAPTER_URL_CAP);
    GetWindowTextW(state->username, state->userText, 256);
    GetWindowTextW(state->password, state->passwordText, 256);
    GetWindowTextW(state->answer, state->answerText, 128);
    GetWindowTextW(state->key, state->keyText, CX_HOME_API_KEY_CAP);
    state->operation = operation;
    state->createIfMissing = SendMessageW(state->create, BM_GETCHECK, 0, 0) == BST_CHECKED;
    if (!state->baseText[0]) { aw_status(state, L"请填写 tikuAdapter 服务地址。"); return; }
    if (operation == ACCOUNT_LOGIN && (!state->captchaSettingsLoaded
        || lstrcmpiW(state->authSettings.captchaProvider, L"local"))) {
        if (!state->captchaSettingsLoaded)
            aw_status(state, L"请先检测服务端验证码配置；配置读取失败时不会显示本地图验证码。可使用下方 API key 验证。");
        else aw_status(state, L"当前服务端使用远程验证码，原生窗口不支持该交互。请在浏览器登录服务并创建访问令牌，再粘贴下方 API key 验证。");
        return;
    }
    if (operation == ACCOUNT_LOGIN && lstrcmpW(state->captchaBase, state->baseText)) {
        state->captcha.challengeId[0] = 0; aw_status(state, L"服务地址已改变，请重新获取验证码。"); return;
    }
    if (operation == ACCOUNT_LOGIN && (!state->captcha.challengeId[0] || !state->userText[0] || !state->passwordText[0] || !state->answerText[0])) {
        aw_status(state, L"请先获取验证码，并填写账号、密码与验证码。"); return;
    }
    if (operation == ACCOUNT_REFRESH) {
        state->captchaSettingsLoaded = FALSE;
        aw_clear_captcha(state);
        SetWindowTextW(state->answer, L"");
    }
    aw_buttons(state, FALSE); aw_status(state, L"正在连接 tikuAdapter...");
    state->worker = CreateThread(NULL, 0, aw_work, state, 0, NULL);
    if (!state->worker) { aw_buttons(state, TRUE); aw_status(state, L"无法创建网络工作线程。"); }
}
static LRESULT CALLBACK aw_proc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    ACCOUNT_WINDOW *state = (ACCOUNT_WINDOW *)GetWindowLongPtrW(window, GWLP_USERDATA);
    if (message == WM_NCCREATE) {
        state = (ACCOUNT_WINDOW *)((CREATESTRUCTW *)lParam)->lpCreateParams;
        state->window = window; SetWindowLongPtrW(window, GWLP_USERDATA, (LONG_PTR)state);
    }
    if (!state) return DefWindowProcW(window, message, wParam, lParam);
    if (message == WM_COMMAND) {
        DWORD action = LOWORD(wParam);
        if (action == IDOK) action = GetFocus() == state->key ? ACCOUNT_KEY : ACCOUNT_LOGIN;
        if (action == IDCANCEL) action = ACCOUNT_CANCEL;
        if (action == ACCOUNT_OPEN_LOGIN) {
            WCHAR *url = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_HOME_ADAPTER_URL_CAP * sizeof(WCHAR));
            HINSTANCE opened = NULL;
            GetWindowTextW(state->base, state->baseText, CX_HOME_ADAPTER_URL_CAP);
            if (url && aw_build_login_url(state->baseText, url, CX_HOME_ADAPTER_URL_CAP))
                opened = ShellExecuteW(window, L"open", url, NULL, NULL, SW_SHOWNORMAL);
            if (!url || (INT_PTR)opened <= 32) aw_status(state, L"无法打开服务登录页，请检查上方 tikuAdapter 地址。");
            else aw_status(state, L"已打开服务登录页；请在浏览器登录后进入 /access-tokens 创建令牌，再粘贴 API key。");
            if (url) HeapFree(GetProcessHeap(), 0, url);
            return 0;
        }
        if (action == ACCOUNT_REFRESH || action == ACCOUNT_LOGIN || action == ACCOUNT_KEY) { aw_start(state, action); return 0; }
        if (action == ACCOUNT_CANCEL) { SendMessageW(window, WM_CLOSE, 0, 0); return 0; }
    }
    if (message == ACCOUNT_DONE) {
        if (state->worker) { WaitForSingleObject(state->worker, INFINITE); CloseHandle(state->worker); state->worker = NULL; }
        if (state->closing) { DestroyWindow(window); return 0; }
        aw_buttons(state, TRUE);
        if (state->operation == ACCOUNT_LOGIN) { SetWindowTextW(state->password, L""); state->captcha.challengeId[0] = 0; }
        if (!state->ok) { aw_status(state, state->error[0] ? state->error : L"请求失败，请重试。账号登录失败后请刷新验证码。"); return 0; }
        if (state->operation == ACCOUNT_REFRESH) {
            if (lstrcmpiW(state->authSettings.captchaProvider, L"local")) {
                aw_clear_captcha(state);
                if (!lstrcmpiW(state->authSettings.captchaProvider, L"remote"))
                    aw_status(state, L"服务端使用远程验证码，原生窗口不支持该交互，因此未显示本地图验证码。请在浏览器登录服务并打开“/access-tokens”创建访问令牌，再粘贴下方 API key 验证。");
                else
                    aw_status(state, L"服务端验证码类型无法由原生窗口处理；未显示本地图验证码。请在浏览器登录服务并创建访问令牌，再粘贴下方 API key 验证。");
                return 0;
            }
            HBITMAP bitmap = cx_adapter_captcha_bitmap(&state->captcha, state->error, 512);
            if (!bitmap) { aw_status(state, state->error); return 0; }
            SendMessageW(state->image, STM_SETIMAGE, IMAGE_BITMAP, (LPARAM)bitmap);
            if (state->bitmap) DeleteObject(state->bitmap);
            state->bitmap = bitmap;
            lstrcpynW(state->captchaBase, state->baseText, CX_HOME_ADAPTER_URL_CAP);
            EnableWindow(GetDlgItem(state->window, ACCOUNT_LOGIN), TRUE);
            EnableWindow(state->answer, TRUE);
            aw_status(state, L"服务器已配置站内图形验证码。登录后使用已有访问令牌；如无令牌，请先勾选创建选项。");
        } else {
            lstrcpynW(state->config->adapterBaseUrl, state->baseText, CX_HOME_ADAPTER_URL_CAP);
            lstrcpynW(state->config->apiKey, state->operation == ACCOUNT_KEY ? state->keyText : state->account.apiKey, CX_HOME_API_KEY_CAP);
            state->accepted = TRUE; DestroyWindow(window);
        }
        return 0;
    }
    if (message == WM_CLOSE) {
        if (state->worker) { state->closing = TRUE; aw_status(state, L"请求结束后自动关闭，请稍候。"); EnableWindow(GetDlgItem(window, ACCOUNT_CANCEL), FALSE); return 0; }
        DestroyWindow(window); return 0;
    }
    if (message == WM_DESTROY) {
        /* A cross-thread SendMessage can destroy the HWND inside GetMessage. */
        PostThreadMessageW(GetCurrentThreadId(), WM_NULL, 0, 0); return 0;
    }
    return DefWindowProcW(window, message, wParam, lParam);
}
BOOL cx_account_window(HWND parent, CX_HOME_CONFIG *config) {
    ACCOUNT_WINDOW *state; WNDCLASSEXW klass; MSG message; HICON icon; BOOL accepted, sawQuit = FALSE, ownerEnabled; int quitCode = 0, result; RECT bounds;
    if (!config) return FALSE;
    state = (ACCOUNT_WINDOW *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*state));
    if (!state) return FALSE;
    state->parent = parent; state->config = config; state->dpi = aw_ui_dpi();
    state->font = CreateFontW(-aw_scale(state, 16), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
    if (!state->font) goto failed;
    ZeroMemory(&klass, sizeof(klass)); klass.cbSize = sizeof(klass); klass.lpfnWndProc = aw_proc; klass.hInstance = GetModuleHandleW(NULL);
    klass.lpszClassName = ACCOUNT_CLASS; klass.hCursor = LoadCursorW(NULL, IDC_ARROW);
    klass.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    icon = LoadIconW(klass.hInstance, MAKEINTRESOURCEW(CX_RESOURCE_APP_ICON)); klass.hIcon = icon; klass.hIconSm = icon;
    if (!RegisterClassExW(&klass) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) goto failed;
    bounds.left = bounds.top = 0; bounds.right = aw_scale(state, 650); bounds.bottom = aw_scale(state, 400);
    AdjustWindowRectEx(&bounds, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, FALSE, WS_EX_DLGMODALFRAME | WS_EX_CONTROLPARENT);
    if (!CreateWindowExW(WS_EX_DLGMODALFRAME | WS_EX_CONTROLPARENT, ACCOUNT_CLASS, L"超星学习助手 - 账号或 API key",
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, CW_USEDEFAULT, CW_USEDEFAULT, bounds.right - bounds.left, bounds.bottom - bounds.top,
        parent, NULL, klass.hInstance, state)) goto failed;
    SendMessageW(state->window, WM_SETICON, ICON_BIG, (LPARAM)icon); SendMessageW(state->window, WM_SETICON, ICON_SMALL, (LPARAM)icon);
    aw_control(state, L"STATIC", L"服务地址", 0, 24, 24, 100, 24, 0);
    state->base = aw_control(state, L"EDIT", config->adapterBaseUrl, ES_AUTOHSCROLL, 130, 20, 480, 28, 0);
    SendMessageW(state->base, EM_SETLIMITTEXT, CX_HOME_ADAPTER_URL_CAP - 1, 0);
    aw_control(state, L"STATIC", L"账号", 0, 24, 70, 100, 24, 0);
    state->username = aw_control(state, L"EDIT", L"", ES_AUTOHSCROLL, 130, 66, 210, 28, 0);
    SendMessageW(state->username, EM_SETLIMITTEXT, 255, 0);
    aw_control(state, L"STATIC", L"密码", 0, 360, 70, 60, 24, 0);
    state->password = aw_control(state, L"EDIT", L"", ES_AUTOHSCROLL | ES_PASSWORD, 420, 66, 190, 28, 0);
    SendMessageW(state->password, EM_SETLIMITTEXT, 255, 0);
    state->image = aw_control(state, L"STATIC", L"", SS_BITMAP | SS_CENTERIMAGE, 24, 110, 200, 70, 0);
    aw_control(state, L"BUTTON", L"检测 / 刷新验证码", 0, 240, 115, 145, 30, ACCOUNT_REFRESH);
    state->answer = aw_control(state, L"EDIT", L"", ES_AUTOHSCROLL, 370, 115, 100, 28, 0);
    SendMessageW(state->answer, EM_SETLIMITTEXT, 127, 0);
    aw_control(state, L"BUTTON", L"账号登录", 0, 490, 115, 120, 30, ACCOUNT_LOGIN);
    state->create = aw_control(state, L"BUTTON", L"没有访问令牌时创建原生客户端专用令牌", BS_AUTOCHECKBOX, 240, 157, 370, 28, ACCOUNT_CREATE_TOKEN);
    SendMessageW(state->create, BM_SETCHECK, BST_CHECKED, 0);
    aw_control(state, L"STATIC", L"或使用 API key", 0, 24, 220, 110, 24, 0);
    state->key = aw_control(state, L"EDIT", config->apiKey, ES_PASSWORD | ES_AUTOHSCROLL, 140, 215, 330, 28, 0);
    SendMessageW(state->key, EM_SETLIMITTEXT, CX_HOME_API_KEY_CAP - 1, 0);
    aw_control(state, L"BUTTON", L"验证并使用", 0, 490, 215, 120, 30, ACCOUNT_KEY);
    state->status = aw_control(state, L"STATIC", L"请先检测服务端验证码类型。API key 和账号凭据只保存在当前进程内存中。", 0, 24, 275, 585, 65, 0);
    state->openLogin = aw_control(state, L"BUTTON", L"打开服务登录页", 0, 24, 350, 170, 30, ACCOUNT_OPEN_LOGIN);
    aw_control(state, L"BUTTON", L"取消", 0, 500, 350, 110, 30, ACCOUNT_CANCEL);
    aw_buttons(state, TRUE);
    ownerEnabled = parent && IsWindowEnabled(parent);
    if (ownerEnabled) EnableWindow(parent, FALSE);
    ShowWindow(state->window, SW_SHOW); ShowWindow(state->window, SW_SHOW); UpdateWindow(state->window); SetFocus(state->base);
    while (IsWindow(state->window)) {
        result = GetMessageW(&message, NULL, 0, 0);
        if (result <= 0) {
            if (!result) { sawQuit = TRUE; quitCode = (int)message.wParam; }
            state->closing = TRUE;
            if (state->worker) { WaitForSingleObject(state->worker, INFINITE); CloseHandle(state->worker); state->worker = NULL; }
            DestroyWindow(state->window); break;
        }
        if (!IsDialogMessageW(state->window, &message)) { TranslateMessage(&message); DispatchMessageW(&message); }
    }
    if (state->worker) { WaitForSingleObject(state->worker, INFINITE); CloseHandle(state->worker); state->worker = NULL; }
    if (ownerEnabled && IsWindow(parent)) EnableWindow(parent, TRUE);
    if (!sawQuit && parent && IsWindow(parent)) SetForegroundWindow(parent);
    accepted = state->accepted;
    if (state->bitmap) DeleteObject(state->bitmap);
    DeleteObject(state->font);
    SecureZeroMemory(state, sizeof(*state)); HeapFree(GetProcessHeap(), 0, state);
    if (sawQuit) PostQuitMessage(quitCode);
    return accepted;
failed:
    if (state->window && IsWindow(state->window)) DestroyWindow(state->window);
    if (state->font) DeleteObject(state->font);
    HeapFree(GetProcessHeap(), 0, state); return FALSE;
}
