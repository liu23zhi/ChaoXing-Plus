#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "home.h"
#include "browser-session.h"
#include "browser-extension.h"
#include "adapter-account.h"
#include "account-window.h"
#include "config-store.h"
#include "json.h"
#include "resource.h"

#define HOME_CLASS L"CXPlusNativeHome"
#define SETTINGS_CLASS L"CXPlusNativeHomeSettings"
#define HOME_MAX_SESSIONS 8
#define HOME_TIMER 1401

#define HOME_EDGE 1402
#define HOME_CHROME 1403
#define HOME_SEPARATE 1404
#define HOME_CLOSE_SESSION 1405
#define HOME_SETTINGS 1406
#define HOME_EXAM 1407
#define HOME_EXIT 1408
#define HOME_SESSION_LIST 1410
#define HOME_STATUS 1411
#define HOME_ACCOUNT 1412
#define HOME_UPDATE 1413
#define HOME_OPERATION_DONE (WM_APP + 24)

#define SETTINGS_BASE_URL 1502
#define SETTINGS_API_KEY 1503
#define SETTINGS_BROWSER 1504
#define SETTINGS_SAVE 1506
#define SETTINGS_CANCEL 1507
#define SETTINGS_STATUS 1508
#define SETTINGS_JSON 1509

typedef struct HOME_SESSION_SLOT {
    CX_BROWSER_SESSION *session;
    WCHAR browser[16];
    WCHAR version[64];
} HOME_SESSION_SLOT;

typedef struct HOME_STATE {
    CX_OPTIONS *options;
    CX_HOME_CONFIG *config;
    CX_HOME_EXAM_RUN examRun;
    HWND window;
    HWND list;
    HWND status;
    HFONT font;
    HOME_SESSION_SLOT sessions[HOME_MAX_SESSIONS];
    WCHAR error[512];
    BOOL closing;
    HANDLE worker;
    DWORD operation;
    WCHAR pendingBrowser[16];
    CX_HOME_CONFIG pendingConfig;
    CX_BROWSER_SESSION *pendingSession;
    DWORD pendingSlot;
    WCHAR extensionVersion[64];
    BOOL operationOK;
} HOME_STATE;

typedef struct SETTINGS_STATE {
    HOME_STATE *home;
    HWND window;
    HWND baseUrl;
    HWND apiKey;
    HWND browser;
    HWND status;
    HWND settings;
    HFONT font;
    CX_HOME_CONFIG value;
    WCHAR browserKind[16];
    BOOL persist;
    BOOL accepted;
} SETTINGS_STATE;

static HINSTANCE home_instance;
static HFONT home_default_font;
static DWORD home_dpi = 96;
static const WCHAR home_default_url[] = L"https://tiku.zelly.cn/";

static void home_copy(WCHAR *out, DWORD cap, const WCHAR *value) {
    if (!out || !cap) return;
    if (!value) value = L"";
    lstrcpynW(out, value, (int)cap);
}

static void home_append(WCHAR *out, DWORD cap, const WCHAR *value) {
    DWORD used;
    if (!out || !cap || !value) return;
    used = (DWORD)lstrlenW(out);
    if (used >= cap - 1) return;
    lstrcpynW(out + used, value, (int)(cap - used));
}

static BOOL home_exists(const WCHAR *path) {
    DWORD attr = GetFileAttributesW(path);
    return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

void cx_home_config_init(CX_HOME_CONFIG *config) {
    if (!config) return;
    ZeroMemory(config, sizeof(*config));
    home_copy(config->adapterBaseUrl, CX_HOME_ADAPTER_URL_CAP, home_default_url);
    home_copy(config->settingsJson, CX_HOME_SETTINGS_CAP, L"{}");
}

void cx_home_config_clear(CX_HOME_CONFIG *config) {
    if (config) SecureZeroMemory(config, sizeof(*config));
}

BOOL cx_home_config_apply_options(CX_HOME_CONFIG *config, const CX_OPTIONS *options,
    WCHAR *error, DWORD errorCap) {
    char *json; JT *tokens; DWORD length; int count, base, key; BOOL ok = FALSE;
    CX_HOME_CONFIG *copy;
    if (!config || !options) return FALSE;
    length = options->sharedSettingsLength;
    if (!length) return TRUE;
    if (length > CX_OPTIONS_JSON_CAP - 3) return FALSE;
    json = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, length + 3);
    tokens = (JT *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 8192 * sizeof(JT));
    copy = (CX_HOME_CONFIG *)HeapAlloc(GetProcessHeap(), 0, sizeof(*copy));
    if (!json || !tokens || !copy) goto done;
    CopyMemory(copy, config, sizeof(*copy));
    json[0] = '{'; CopyMemory(json + 1, options->sharedSettingsJson, length); json[length + 1] = '}';
    count = jparse(json, (int)length + 2, tokens, 8192);
    if (count < 1 || tokens[0].type != '{') goto done;
    base = jkey(json, tokens, 0, "common.settings.tiku-adapter.baseurl");
    key = jkey(json, tokens, 0, "common.settings.tiku-adapter.key");
    if (base >= 0 && !jwstr(json, tokens, base, copy->adapterBaseUrl, CX_HOME_ADAPTER_URL_CAP)) goto done;
    if (key >= 0 && !jwstr(json, tokens, key, copy->apiKey, CX_HOME_API_KEY_CAP)) goto done;
    CopyMemory(config, copy, sizeof(*copy)); ok = TRUE;
done:
    if (copy) { SecureZeroMemory(copy, sizeof(*copy)); HeapFree(GetProcessHeap(), 0, copy); }
    if (json) { SecureZeroMemory(json, length + 3); HeapFree(GetProcessHeap(), 0, json); }
    if (tokens) HeapFree(GetProcessHeap(), 0, tokens);
    if (!ok && error && errorCap) home_copy(error, errorCap, L"已有题库服务设置无效，无法初始化首页。");
    return ok;
}

static HICON home_icon(void) {
    return LoadIconW(home_instance, MAKEINTRESOURCEW(CX_RESOURCE_APP_ICON));
}

static void home_set_icon(HWND window) {
    HICON icon = home_icon();
    if (icon) {
        SendMessageW(window, WM_SETICON, ICON_BIG, (LPARAM)icon);
        SendMessageW(window, WM_SETICON, ICON_SMALL, (LPARAM)icon);
    }
}

static HWND home_control(DWORD exStyle, const WCHAR *className, const WCHAR *text,
                         DWORD style, int x, int y, int width, int height,
                         HWND parent, int id) {
    BOOL input = lstrcmpW(className, L"STATIC") != 0;
    HWND control = CreateWindowExW(exStyle, className, text, style | (input ? WS_TABSTOP : 0),
        MulDiv(x, home_dpi, 96), MulDiv(y, home_dpi, 96), MulDiv(width, home_dpi, 96), MulDiv(height, home_dpi, 96),
        parent, (HMENU)(INT_PTR)id, home_instance, NULL);
    if (control && home_default_font) SendMessageW(control, WM_SETFONT, (WPARAM)home_default_font, TRUE);
    return control;
}

static BOOL home_find_browser(const WCHAR *browser, WCHAR *out, DWORD cap) {
    static const WCHAR *roots[] = { L"LOCALAPPDATA", L"ProgramW6432", L"ProgramFiles", L"ProgramFiles(x86)" };
    WCHAR *path; DWORD length, i; BOOL found = FALSE;
    path = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_HOME_EXTENSION_PATH_CAP * sizeof(WCHAR));
    if (!path) return FALSE;
    for (i = 0; i < sizeof(roots) / sizeof(roots[0]); ++i) {
        length = GetEnvironmentVariableW(roots[i], path, CX_HOME_EXTENSION_PATH_CAP);
        if (!length || length >= CX_HOME_EXTENSION_PATH_CAP) continue;
        home_append(path, CX_HOME_EXTENSION_PATH_CAP,
            lstrcmpiW(browser, L"edge") == 0 ? L"\\Microsoft\\Edge\\Application\\msedge.exe" : L"\\Google\\Chrome\\Application\\chrome.exe");
        if (home_exists(path)) { home_copy(out, cap, path); found = TRUE; break; }
    }
    if (!found) {
        const WCHAR *keyName = lstrcmpiW(browser, L"edge") == 0 ? L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe"
            : L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe";
        HKEY key; DWORD type, bytes;
        for (i = 0; i < 4; ++i) {
            if (RegOpenKeyExW(i < 2 ? HKEY_CURRENT_USER : HKEY_LOCAL_MACHINE, keyName, 0,
                KEY_QUERY_VALUE | (i % 2 ? KEY_WOW64_32KEY : KEY_WOW64_64KEY), &key) != ERROR_SUCCESS) continue;
            bytes = CX_HOME_EXTENSION_PATH_CAP * sizeof(WCHAR); path[0] = 0;
            if (RegQueryValueExW(key, NULL, NULL, &type, (BYTE *)path, &bytes) == ERROR_SUCCESS && type == REG_SZ
                && bytes < CX_HOME_EXTENSION_PATH_CAP * sizeof(WCHAR)) {
                path[bytes / sizeof(WCHAR)] = 0;
                if (home_exists(path)) { home_copy(out, cap, path); found = TRUE; }
            }
            RegCloseKey(key); if (found) break;
        }
    }
    HeapFree(GetProcessHeap(), 0, path); return found;
}

static BOOL home_json_append_char(char *out, DWORD cap, DWORD *at, char c) {
    if (!out || !at || *at + 1 >= cap) return FALSE;
    out[(*at)++] = c; out[*at] = 0; return TRUE;
}

static BOOL home_json_append_utf8(char *out, DWORD cap, DWORD *at, const WCHAR *value) {
    char *utf8;
    int length, i;
    BOOL ok = FALSE;
    utf8 = (char *)HeapAlloc(GetProcessHeap(), 0, CX_HOME_API_KEY_CAP * 3);
    if (!utf8) return FALSE;
    length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value ? value : L"", -1,
        utf8, CX_HOME_API_KEY_CAP * 3, NULL, NULL);
    if (!length) goto done;
    for (i = 0; i < length - 1; ++i) {
        unsigned char c = (unsigned char)utf8[i];
        if (c == '"' || c == '\\') {
            if (!home_json_append_char(out, cap, at, '\\')) goto done;
        } else if (c < 0x20) {
            if (!home_json_append_char(out, cap, at, ' ')) goto done;
            continue;
        }
        if (!home_json_append_char(out, cap, at, (char)c)) goto done;
    }
    ok = TRUE;
done:
    SecureZeroMemory(utf8, CX_HOME_API_KEY_CAP * 3); HeapFree(GetProcessHeap(), 0, utf8);
    return ok;
}

static BOOL home_adapter_patch(const CX_HOME_CONFIG *config, char *patch, DWORD cap) {
    DWORD n = 0;
    return home_json_append_char(patch, cap, &n, '{')
        && home_json_append_char(patch, cap, &n, '"')
        && home_json_append_utf8(patch, cap, &n, L"common.settings.tiku-adapter.baseurl")
        && home_json_append_char(patch, cap, &n, '"') && home_json_append_char(patch, cap, &n, ':')
        && home_json_append_char(patch, cap, &n, '"') && home_json_append_utf8(patch, cap, &n, config->adapterBaseUrl)
        && home_json_append_char(patch, cap, &n, '"') && home_json_append_char(patch, cap, &n, ',')
        && home_json_append_char(patch, cap, &n, '"') && home_json_append_utf8(patch, cap, &n, L"common.settings.tiku-adapter.key")
        && home_json_append_char(patch, cap, &n, '"') && home_json_append_char(patch, cap, &n, ':')
        && home_json_append_char(patch, cap, &n, '"') && home_json_append_utf8(patch, cap, &n, config->apiKey)
        && home_json_append_char(patch, cap, &n, '"') && home_json_append_char(patch, cap, &n, '}');
}

static BOOL home_build_settings(const HOME_STATE *state, const CX_HOME_CONFIG *config,
    char *out, DWORD cap, DWORD *length, WCHAR *error, DWORD errorCap) {
    char *buffers; char *base, *custom, *patch;
    DWORD shared = state->options->sharedSettingsLength, merged = 0; int converted;
    BOOL ok = FALSE;
    if (shared > CX_OPTIONS_JSON_CAP - 3) return FALSE;
    buffers = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_OPTIONS_JSON_CAP * 3);
    if (!buffers) return FALSE;
    base = buffers; custom = base + CX_OPTIONS_JSON_CAP; patch = custom + CX_OPTIONS_JSON_CAP;
    base[0] = '{'; CopyMemory(base + 1, state->options->sharedSettingsJson, shared); base[shared + 1] = '}';
    converted = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, config->settingsJson, -1, custom, CX_OPTIONS_JSON_CAP, NULL, NULL);
    if (!converted || !cx_config_merge_settings(base, shared + 2, custom, (DWORD)converted - 1,
        out, cap, &merged, error, errorCap)) goto done;
    if (!home_adapter_patch(config, patch, CX_OPTIONS_JSON_CAP)) goto done;
    ok = cx_config_merge_settings(out, merged, patch, (DWORD)lstrlenA(patch), out, cap, length, error, errorCap);
done:
    SecureZeroMemory(buffers, CX_OPTIONS_JSON_CAP * 3); HeapFree(GetProcessHeap(), 0, buffers); return ok;
}

static void home_status(HOME_STATE *state, const WCHAR *text) {
    if (state && state->status) SetWindowTextW(state->status, text ? text : L"");
}

static void home_refresh_list(HOME_STATE *state) {
    DWORD i; WCHAR line[512]; LRESULT selected, oldSlot = LB_ERR;
    if (!state || !state->list) return;
    selected = SendMessageW(state->list, LB_GETCURSEL, 0, 0);
    if (selected != LB_ERR) oldSlot = SendMessageW(state->list, LB_GETITEMDATA, selected, 0);
    SendMessageW(state->list, LB_RESETCONTENT, 0, 0);
    for (i = 0; i < HOME_MAX_SESSIONS; ++i) {
        CX_BROWSER_SESSION *session = state->sessions[i].session;
        if (session) {
            line[0] = 0;
            home_append(line, 512, lstrcmpiW(state->sessions[i].browser, L"edge") == 0 ? L"Edge" : L"Chrome");
            home_append(line, 512, L" 临时会话  PID ");
            {
                WCHAR pid[24];
                wsprintfW(pid, L"%lu", (unsigned long)cx_browser_pid(session));
                home_append(line, 512, pid);
            }
            home_append(line, 512, L"  扩展版本 ");
            home_append(line, 512, state->sessions[i].version);
            selected = SendMessageW(state->list, LB_ADDSTRING, 0, (LPARAM)line);
            if (selected != LB_ERR) {
                SendMessageW(state->list, LB_SETITEMDATA, selected, i);
                if ((LRESULT)i == oldSlot) SendMessageW(state->list, LB_SETCURSEL, selected, 0);
            }
        }
    }
}

static void home_poll_sessions(HOME_STATE *state) {
    DWORD i; BOOL running;
    WCHAR error[256];
    if (state->worker) return;
    for (i = 0; i < HOME_MAX_SESSIONS; ++i) {
        if (!state->sessions[i].session) continue;
        error[0] = 0;
        if (!cx_browser_poll(state->sessions[i].session, &running, error, 256)) {
            if (error[0]) home_status(state, error);
        } else if (!running) {
            cx_browser_destroy(state->sessions[i].session);
            state->sessions[i].session = NULL;
            if (error[0]) home_status(state, error);
        }
    }
    home_refresh_list(state);
}

static DWORD WINAPI home_work(LPVOID context) {
    HOME_STATE *state = (HOME_STATE *)context;
    WCHAR *browserPath = NULL;
    char *settings = NULL;
    BYTE *data = NULL; DWORD size = 0, settingsLength = 0, i;
    CX_BROWSER_OPTIONS options;
    state->operationOK = FALSE; state->error[0] = 0;
    if (state->operation == HOME_CLOSE_SESSION || state->operation == HOME_EXIT) {
        state->operationOK = TRUE;
        for (i = 0; i < HOME_MAX_SESSIONS; ++i) {
            if (state->operation == HOME_CLOSE_SESSION && i != state->pendingSlot) continue;
            if (!state->sessions[i].session) continue;
            if (cx_browser_close(state->sessions[i].session, state->error, 512)) {
                cx_browser_destroy(state->sessions[i].session); state->sessions[i].session = NULL;
            } else state->operationOK = FALSE;
        }
        goto done;
    }
    if (!cx_adapter_extension_fetch(state->pendingConfig.adapterBaseUrl, L"edge", &data, &size,
        state->extensionVersion, 64, state->error, 512)) goto done;
    if (!cx_browser_extension_verify(data, size, L"lcmeenlnjihhjcjoakekikoaldigonac", state->error, 512)) goto done;
    if (state->operation == HOME_UPDATE) { state->operationOK = TRUE; goto done; }
    browserPath = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, CX_HOME_EXTENSION_PATH_CAP * sizeof(WCHAR));
    settings = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_OPTIONS_JSON_CAP);
    if (!browserPath || !settings) goto done;
    if (!home_find_browser(state->pendingBrowser, browserPath, CX_HOME_EXTENSION_PATH_CAP)) {
        home_copy(state->error, 512, L"未找到所选浏览器，请先安装 Microsoft Edge 或 Google Chrome。"); goto done;
    }
    if (!home_build_settings(state, &state->pendingConfig, settings, CX_OPTIONS_JSON_CAP, &settingsLength, state->error, 512)) goto done;
    ZeroMemory(&options, sizeof(options)); options.browserPath = browserPath;
    options.crxData = data; options.crxSize = size; options.initialUrl = L"https://www.chaoxing.com/";
    options.settingsJsonUTF8 = settings;
    state->operationOK = cx_browser_start(&options, &state->pendingSession, state->error, 512);
done:
    if (settings) { SecureZeroMemory(settings, CX_OPTIONS_JSON_CAP); HeapFree(GetProcessHeap(), 0, settings); }
    if (browserPath) HeapFree(GetProcessHeap(), 0, browserPath);
    if (data) HeapFree(GetProcessHeap(), 0, data);
    if (!state->operationOK && !state->error[0]) home_copy(state->error, 512, L"操作失败，无法准备浏览器会话。");
    PostMessageW(state->window, HOME_OPERATION_DONE, 0, 0); return 0;
}

static void home_buttons(HOME_STATE *state, BOOL enabled) {
    static const int ids[] = { HOME_EDGE, HOME_CHROME, HOME_SEPARATE, HOME_CLOSE_SESSION, HOME_SETTINGS, HOME_ACCOUNT, HOME_EXAM, HOME_UPDATE };
    DWORD i;
    for (i = 0; i < sizeof(ids) / sizeof(ids[0]); ++i) EnableWindow(GetDlgItem(state->window, ids[i]), enabled);
}

static void home_begin(HOME_STATE *state, DWORD operation, const WCHAR *browser, const CX_HOME_CONFIG *config) {
    DWORD i; LRESULT selected;
    if (state->worker) return;
    state->pendingSlot = HOME_MAX_SESSIONS;
    if (operation == HOME_CLOSE_SESSION) {
        selected = SendMessageW(state->list, LB_GETCURSEL, 0, 0);
        if (selected != LB_ERR) state->pendingSlot = (DWORD)SendMessageW(state->list, LB_GETITEMDATA, selected, 0);
        if (state->pendingSlot >= HOME_MAX_SESSIONS) { home_status(state, L"请先选择一个临时会话"); return; }
    } else if (operation == HOME_EDGE || operation == HOME_CHROME) {
        for (i = 0; i < HOME_MAX_SESSIONS; ++i) if (!state->sessions[i].session) break;
        if (i == HOME_MAX_SESSIONS) { home_status(state, L"临时会话已达到 8 个上限"); return; }
        state->pendingSlot = i;
    }
    if (config) CopyMemory(&state->pendingConfig, config, sizeof(*config));
    home_copy(state->pendingBrowser, 16, browser); state->operation = operation;
    home_buttons(state, FALSE);
    home_status(state, operation == HOME_EXIT || operation == HOME_CLOSE_SESSION ? L"正在关闭并清理临时会话..." : L"正在从 tikuAdapter 获取扩展，请稍候...");
    state->worker = CreateThread(NULL, 0, home_work, state, 0, NULL);
    if (!state->worker) { home_buttons(state, TRUE); state->closing = FALSE; home_status(state, L"无法创建工作线程"); }
}

static void settings_copy(CX_HOME_CONFIG *out, const CX_HOME_CONFIG *in) {
    if (!out || !in) return;
    CopyMemory(out, in, sizeof(*out));
}

static void settings_set_status(SETTINGS_STATE *state, const WCHAR *text) {
    if (state && state->status) SetWindowTextW(state->status, text ? text : L"");
}

static BOOL settings_read(SETTINGS_STATE *state) {
    char *validation; DWORD length = 0; WCHAR error[256]; BOOL ok;
    GetWindowTextW(state->baseUrl, state->value.adapterBaseUrl, CX_HOME_ADAPTER_URL_CAP);
    GetWindowTextW(state->apiKey, state->value.apiKey, CX_HOME_API_KEY_CAP);
    GetWindowTextW(state->settings, state->value.settingsJson, CX_HOME_SETTINGS_CAP);
    validation = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_OPTIONS_JSON_CAP);
    if (!validation) return FALSE;
    error[0] = 0;
    ok = home_build_settings(state->home, &state->value, validation, CX_OPTIONS_JSON_CAP, &length, error, 256);
    SecureZeroMemory(validation, CX_OPTIONS_JSON_CAP); HeapFree(GetProcessHeap(), 0, validation);
    if (!ok) { settings_set_status(state, error[0] ? error : L"设置 JSON 无效"); return FALSE; }
    if (SendMessageW(state->browser, CB_GETCURSEL, 0, 0) == 1) home_copy(state->browserKind, 16, L"chrome");
    else home_copy(state->browserKind, 16, L"edge");
    return TRUE;
}

static LRESULT CALLBACK settings_proc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    SETTINGS_STATE *state = (SETTINGS_STATE *)GetWindowLongPtrW(window, GWLP_USERDATA);
    if (message == WM_NCCREATE) {
        CREATESTRUCTW *create = (CREATESTRUCTW *)lParam;
        state = (SETTINGS_STATE *)create->lpCreateParams;
        state->window = window; SetWindowLongPtrW(window, GWLP_USERDATA, (LONG_PTR)state);
        home_set_icon(window);
    }
    if (!state) return DefWindowProcW(window, message, wParam, lParam);
    if (message == WM_COMMAND) {
        switch (LOWORD(wParam)) {
        case SETTINGS_SAVE:
            if (settings_read(state)) { state->accepted = TRUE; DestroyWindow(window); }
            return 0;
        case IDCANCEL:
        case SETTINGS_CANCEL: DestroyWindow(window); return 0;
        default: break;
        }
    }
    if (message == WM_CLOSE) { DestroyWindow(window); return 0; }
    return DefWindowProcW(window, message, wParam, lParam);
}

static BOOL settings_register(void) {
    WNDCLASSW klass;
    ZeroMemory(&klass, sizeof(klass)); klass.lpfnWndProc = settings_proc; klass.hInstance = home_instance;
    klass.hIcon = home_icon();
    klass.hCursor = LoadCursorW(NULL, IDC_ARROW); klass.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1); klass.lpszClassName = SETTINGS_CLASS;
    return RegisterClassW(&klass) || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
}

static BOOL home_settings_dialog(HOME_STATE *home, BOOL persist, const WCHAR *browser,
                                 CX_HOME_CONFIG *out, WCHAR *browserOut, DWORD browserCap) {
    SETTINGS_STATE *state; MSG message; HWND parent = home->window; BOOL accepted; int got = 1;
    ZeroMemory(&message, sizeof(message));
    state = (SETTINGS_STATE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*state));
    if (!state) return FALSE;
    state->home = home; state->persist = persist; settings_copy(&state->value, home->config);
    home_copy(state->browserKind, 16, browser && browser[0] ? browser : L"edge");
    if (!settings_register()) { HeapFree(GetProcessHeap(), 0, state); return FALSE; }
    state->window = CreateWindowExW(WS_EX_DLGMODALFRAME, SETTINGS_CLASS, L"超星学习助手 - 注入设置",
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, CW_USEDEFAULT, CW_USEDEFAULT,
        MulDiv(740, home_dpi, 96), MulDiv(530, home_dpi, 96), parent, NULL, home_instance, state);
    if (!state->window) { HeapFree(GetProcessHeap(), 0, state); return FALSE; }
    state->font = home_default_font;
    home_control(0, L"STATIC", L"tikuAdapter 地址", WS_CHILD | WS_VISIBLE, 24, 24, 120, 24, state->window, 0);
    state->baseUrl = home_control(WS_EX_CLIENTEDGE, L"EDIT", state->value.adapterBaseUrl, WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL, 150, 20, 550, 28, state->window, SETTINGS_BASE_URL);
    home_control(0, L"STATIC", L"API key（可选）", WS_CHILD | WS_VISIBLE, 24, 70, 120, 24, state->window, 0);
    state->apiKey = home_control(WS_EX_CLIENTEDGE, L"EDIT", state->value.apiKey, WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_PASSWORD, 150, 66, 550, 28, state->window, SETTINGS_API_KEY);
    home_control(0, L"STATIC", L"单独会话浏览器", WS_CHILD | WS_VISIBLE, 24, 116, 120, 24, state->window, 0);
    state->browser = home_control(0, L"COMBOBOX", L"", WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST, 150, 112, 220, 120, state->window, SETTINGS_BROWSER);
    SendMessageW(state->browser, CB_ADDSTRING, 0, (LPARAM)L"Microsoft Edge"); SendMessageW(state->browser, CB_ADDSTRING, 0, (LPARAM)L"Google Chrome");
    SendMessageW(state->browser, CB_SETCURSEL, lstrcmpiW(state->browserKind, L"chrome") == 0 ? 1 : 0, 0);
    home_control(0, L"STATIC", L"扩展设置 JSON（共享设置键）", WS_CHILD | WS_VISIBLE, 24, 162, 650, 24, state->window, 0);
    state->settings = home_control(WS_EX_CLIENTEDGE, L"EDIT", state->value.settingsJson,
        WS_CHILD | WS_VISIBLE | ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN | WS_VSCROLL, 24, 192, 676, 175, state->window, SETTINGS_JSON);
    SendMessageW(state->baseUrl, EM_SETLIMITTEXT, CX_HOME_ADAPTER_URL_CAP - 1, 0);
    SendMessageW(state->apiKey, EM_SETLIMITTEXT, CX_HOME_API_KEY_CAP - 1, 0);
    SendMessageW(state->settings, EM_SETLIMITTEXT, CX_HOME_SETTINGS_CAP - 1, 0);
    state->status = home_control(0, L"STATIC", L"设置仅保留在当前进程。单独会话不会覆盖公共设置；服务地址和 API key 以上方输入为准。", WS_CHILD | WS_VISIBLE, 24, 382, 676, 42, state->window, SETTINGS_STATUS);
    home_control(0, L"BUTTON", persist ? L"保存" : L"启动此会话", WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON, 470, 440, 110, 30, state->window, SETTINGS_SAVE);
    home_control(0, L"BUTTON", L"取消", WS_CHILD | WS_VISIBLE, 590, 440, 110, 30, state->window, SETTINGS_CANCEL);
    ShowWindow(state->window, SW_SHOW); ShowWindow(state->window, SW_SHOW); UpdateWindow(state->window); EnableWindow(parent, FALSE);
    while (IsWindow(state->window) && (got = GetMessageW(&message, NULL, 0, 0)) > 0) {
        if (!IsDialogMessageW(state->window, &message)) { TranslateMessage(&message); DispatchMessageW(&message); }
    }
    if (IsWindow(state->window)) DestroyWindow(state->window);
    if (!got) PostQuitMessage((int)message.wParam);
    EnableWindow(parent, TRUE); SetForegroundWindow(parent);
    accepted = state->accepted;
    if (accepted) {
        if (persist) settings_copy(home->config, &state->value);
        if (out) settings_copy(out, &state->value);
        if (browserOut) home_copy(browserOut, browserCap, state->browserKind);
    }
    SecureZeroMemory(state, sizeof(*state)); HeapFree(GetProcessHeap(), 0, state);
    return accepted;
}

static void home_exam(HOME_STATE *state) {
    CX_OPTIONS *options; char *settings; DWORD length = 0;
    if (!state->examRun) return;
    options = (CX_OPTIONS *)HeapAlloc(GetProcessHeap(), 0, sizeof(*options));
    settings = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_OPTIONS_JSON_CAP);
    if (!options || !settings) goto done;
    state->error[0] = 0;
    if (!home_build_settings(state, state->config, settings, CX_OPTIONS_JSON_CAP, &length, state->error, 512)) {
        home_status(state, state->error); goto done;
    }
    CopyMemory(options, state->options, sizeof(*options));
    if (length >= 2) {
        CopyMemory(options->sharedSettingsJson, settings + 1, length - 2);
        options->sharedSettingsJson[length - 2] = 0; options->sharedSettingsLength = length - 2; options->sharedSettingsSet = TRUE;
    }
    ShowWindow(state->window, SW_HIDE);
    state->examRun(options, state->error, 512);
    home_status(state, state->error[0] ? state->error : L"考试客户端流程已返回");
    ShowWindow(state->window, SW_SHOW); SetForegroundWindow(state->window);
done:
    if (settings) { SecureZeroMemory(settings, CX_OPTIONS_JSON_CAP); HeapFree(GetProcessHeap(), 0, settings); }
    if (options) { SecureZeroMemory(options, sizeof(*options)); HeapFree(GetProcessHeap(), 0, options); }
}

static LRESULT CALLBACK home_proc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    HOME_STATE *state = (HOME_STATE *)GetWindowLongPtrW(window, GWLP_USERDATA);
    if (message == WM_NCCREATE) {
        CREATESTRUCTW *create = (CREATESTRUCTW *)lParam; state = (HOME_STATE *)create->lpCreateParams;
        state->window = window; SetWindowLongPtrW(window, GWLP_USERDATA, (LONG_PTR)state); home_set_icon(window);
    }
    if (!state) return DefWindowProcW(window, message, wParam, lParam);
    if (message == HOME_OPERATION_DONE) {
        if (state->worker) { WaitForSingleObject(state->worker, INFINITE); CloseHandle(state->worker); state->worker = NULL; }
        if (state->pendingSession) {
            state->sessions[state->pendingSlot].session = state->pendingSession;
            home_copy(state->sessions[state->pendingSlot].browser, 16, state->pendingBrowser); state->pendingSession = NULL;
            home_copy(state->sessions[state->pendingSlot].version, 64, state->extensionVersion);
        }
        cx_home_config_clear(&state->pendingConfig); home_buttons(state, TRUE); home_refresh_list(state);
        if (!state->operationOK) {
            home_status(state, state->error);
            if (state->closing && state->operation != HOME_EXIT) home_begin(state, HOME_EXIT, NULL, NULL);
            else state->closing = FALSE;
            return 0;
        }
        if (state->operation == HOME_EXIT) { KillTimer(window, HOME_TIMER); DestroyWindow(window); return 0; }
        if (state->operation == HOME_UPDATE) {
            home_copy(state->error, 512, L"已校验在线扩展 "); home_append(state->error, 512, state->extensionVersion);
            home_append(state->error, 512, L"；新会话将获取当前发布版本。"); home_status(state, state->error);
        } else home_status(state, state->operation == HOME_CLOSE_SESSION ? L"已关闭并清理临时会话"
            : L"临时会话已启动；关闭浏览器窗口后资料会自动清理");
        if (state->closing) home_begin(state, HOME_EXIT, NULL, NULL);
        return 0;
    }
    if (message == WM_TIMER) { home_poll_sessions(state); return 0; }
    if (message == WM_COMMAND && HIWORD(wParam) == BN_CLICKED) {
        CX_HOME_CONFIG *separate; WCHAR browser[16];
        if (state->worker && LOWORD(wParam) != HOME_EXIT) return 0;
        switch (LOWORD(wParam)) {
        case HOME_EDGE: home_begin(state, HOME_EDGE, L"edge", state->config); return 0;
        case HOME_CHROME: home_begin(state, HOME_CHROME, L"chrome", state->config); return 0;
        case HOME_UPDATE: home_begin(state, HOME_UPDATE, NULL, state->config); return 0;
        case HOME_SEPARATE:
            separate = (CX_HOME_CONFIG *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*separate));
            if (!separate) return 0;
            if (home_settings_dialog(state, FALSE, L"edge", separate, browser, 16)) home_begin(state,
                lstrcmpiW(browser, L"chrome") == 0 ? HOME_CHROME : HOME_EDGE, browser, separate);
            cx_home_config_clear(separate); HeapFree(GetProcessHeap(), 0, separate);
            return 0;
        case HOME_CLOSE_SESSION: home_begin(state, HOME_CLOSE_SESSION, NULL, NULL); return 0;
        case HOME_SETTINGS: home_settings_dialog(state, TRUE, L"edge", NULL, NULL, 0); return 0;
        case HOME_ACCOUNT:
            if (cx_account_window(window, state->config)) home_status(state, L"账号凭据已准备好，新会话将使用该 API key。");
            return 0;
        case HOME_EXAM: home_exam(state); return 0;
        case HOME_EXIT: SendMessageW(window, WM_CLOSE, 0, 0); return 0;
        default: break;
        }
    }
    if (message == WM_CLOSE) {
        state->closing = TRUE;
        if (state->worker) home_status(state, L"正在等待当前操作结束，随后关闭并清理所有临时会话...");
        else home_begin(state, HOME_EXIT, NULL, NULL);
        return 0;
    }
    if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(window, message, wParam, lParam);
}

static BOOL home_register_class(void) {
    WNDCLASSW klass; ZeroMemory(&klass, sizeof(klass)); klass.lpfnWndProc = home_proc; klass.hInstance = home_instance;
    klass.hIcon = home_icon();
    klass.hCursor = LoadCursorW(NULL, IDC_ARROW); klass.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1); klass.lpszClassName = HOME_CLASS;
    return RegisterClassW(&klass) || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
}

BOOL cx_home_run(CX_OPTIONS *options, CX_HOME_CONFIG *config,
                 CX_HOME_EXAM_RUN examRun, WCHAR *error, DWORD errorCap) {
    HOME_STATE *state; MSG message; HWND window; int got = 1;
    HDC screen; HMODULE user32; WCHAR dpiText[16]; DWORD dpiLength, dpiOverride = 0, i;
    typedef UINT (WINAPI *HOME_GET_DPI)(void);
    HOME_GET_DPI getDpi;
    if (!options || !config) return FALSE;
    state = (HOME_STATE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*state));
    if (!state) return FALSE;
    state->options = options; state->config = config; state->examRun = examRun;
    home_instance = GetModuleHandleW(NULL);
    user32 = GetModuleHandleW(L"user32.dll"); getDpi = (HOME_GET_DPI)GetProcAddress(user32, "GetDpiForSystem");
    home_dpi = getDpi ? getDpi() : 0;
    if (!home_dpi) { screen = GetDC(NULL); home_dpi = screen ? GetDeviceCaps(screen, LOGPIXELSX) : 96; if (screen) ReleaseDC(NULL, screen); }
    dpiLength = GetEnvironmentVariableW(L"CXPLUS_NATIVE_UI_DPI", dpiText, 16);
    if (dpiLength && dpiLength < 16) {
        for (i = 0; i < dpiLength && dpiText[i] >= L'0' && dpiText[i] <= L'9'; ++i) dpiOverride = dpiOverride * 10 + dpiText[i] - L'0';
        if (i == dpiLength && dpiOverride >= 96 && dpiOverride <= 480) home_dpi = dpiOverride;
    }
    home_default_font = CreateFontW(-MulDiv(14, home_dpi, 96), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
        DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
    if (!home_register_class()) {
        if (error && errorCap) lstrcpynW(error, L"无法注册原生主页窗口", (int)errorCap);
        if (home_default_font) DeleteObject(home_default_font); HeapFree(GetProcessHeap(), 0, state); return FALSE;
    }
    window = CreateWindowExW(0, HOME_CLASS, L"超星学习助手", WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
        CW_USEDEFAULT, CW_USEDEFAULT, MulDiv(840, home_dpi, 96), MulDiv(530, home_dpi, 96), NULL, NULL, home_instance, state);
    if (!window) {
        if (error && errorCap) lstrcpynW(error, L"无法创建原生主页窗口", (int)errorCap);
        if (home_default_font) DeleteObject(home_default_font); HeapFree(GetProcessHeap(), 0, state); return FALSE;
    }
    state->font = home_default_font;
    home_control(0, L"STATIC", L"超星学习助手", WS_CHILD | WS_VISIBLE, 24, 20, 300, 34, window, 0);
    home_control(0, L"STATIC", L"创建互相隔离的浏览器临时会话，也可打开考试客户端。", WS_CHILD | WS_VISIBLE, 24, 52, 700, 24, window, 0);
    state->list = home_control(WS_EX_CLIENTEDGE, L"LISTBOX", L"", WS_CHILD | WS_VISIBLE | LBS_NOTIFY | WS_VSCROLL, 24, 88, 780, 230, window, HOME_SESSION_LIST);
    state->status = home_control(0, L"STATIC", L"扩展从 tikuAdapter 在线获取；临时资料在关闭会话后自动清理。", WS_CHILD | WS_VISIBLE, 24, 330, 780, 55, window, HOME_STATUS);
    home_control(0, L"BUTTON", L"Edge 新会话", WS_CHILD | WS_VISIBLE, 24, 395, 120, 32, window, HOME_EDGE);
    home_control(0, L"BUTTON", L"Chrome 新会话", WS_CHILD | WS_VISIBLE, 152, 395, 120, 32, window, HOME_CHROME);
    home_control(0, L"BUTTON", L"单独配置会话", WS_CHILD | WS_VISIBLE, 280, 395, 120, 32, window, HOME_SEPARATE);
    home_control(0, L"BUTTON", L"关闭选中会话", WS_CHILD | WS_VISIBLE, 408, 395, 120, 32, window, HOME_CLOSE_SESSION);
    home_control(0, L"BUTTON", L"设置注入", WS_CHILD | WS_VISIBLE, 536, 395, 100, 32, window, HOME_SETTINGS);
    home_control(0, L"BUTTON", L"考试客户端", WS_CHILD | WS_VISIBLE, 644, 395, 100, 32, window, HOME_EXAM);
    home_control(0, L"BUTTON", L"退出", WS_CHILD | WS_VISIBLE, 752, 395, 52, 32, window, HOME_EXIT);
    home_control(0, L"BUTTON", L"账号 / API key", WS_CHILD | WS_VISIBLE, 24, 435, 150, 30, window, HOME_ACCOUNT);
    home_control(0, L"BUTTON", L"检查扩展更新", WS_CHILD | WS_VISIBLE, 185, 435, 150, 30, window, HOME_UPDATE);
    ShowWindow(window, SW_SHOW); ShowWindow(window, SW_SHOW); UpdateWindow(window); SetTimer(window, HOME_TIMER, 500, NULL);
    home_refresh_list(state);
    while ((got = GetMessageW(&message, NULL, 0, 0)) > 0) {
        if (!IsDialogMessageW(window, &message)) { TranslateMessage(&message); DispatchMessageW(&message); }
    }
    if (state->worker) { WaitForSingleObject(state->worker, INFINITE); CloseHandle(state->worker); state->worker = NULL; }
    for (i = 0; i < HOME_MAX_SESSIONS; ++i) if (state->sessions[i].session) cx_browser_destroy(state->sessions[i].session);
    if (state->pendingSession) cx_browser_destroy(state->pendingSession);
    if (IsWindow(window)) DestroyWindow(window);
    if (home_default_font) DeleteObject(home_default_font); home_default_font = NULL;
    SecureZeroMemory(state, sizeof(*state)); HeapFree(GetProcessHeap(), 0, state);
    cx_home_config_clear(config);
    if (got < 0) { if (error && errorCap) lstrcpynW(error, L"主页消息循环失败", (int)errorCap); return FALSE; }
    return TRUE;
}
