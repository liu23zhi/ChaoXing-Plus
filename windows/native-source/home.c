#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "home.h"
#include "browser-session.h"
#include "browser-extension.h"
#include "adapter-account.h"
#include "account-window.h"
#include "config-store.h"
#include "device-quota.h"
#include "json.h"
#include "resource.h"

#define HOME_CLASS L"CXPlusNativeHome"
#define SETTINGS_CLASS L"CXPlusNativeHomeSettings"
#define HOME_DEVICE_PROMPT_CLASS L"CXPlusNativeHomeDevicePrompt"
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
#define HOME_DEVICE 1414
#define HOME_OPERATION_DONE (WM_APP + 24)
/* 设备线程完成一次配额查询/会话上报后回到 UI 线程的唯一通道：
   所有 state->quota 的读取都发生在 UI 线程，与设备线程之间只经这条消息交接。 */
#define HOME_DEVICE_DONE (WM_APP + 25)
#define HOME_PROMPT_PROCEED 1601
#define HOME_PROMPT_CANCEL 1602
/* 141 §5.4：每分钟心跳一次，服务端 3 分钟未收到即把 session_count 归 0。
   poll 循环本身是 500ms 一次，这里只是复用它做 60 秒分频，不新开 timer。 */
#define HOME_HEARTBEAT_MS 60000

#define SETTINGS_BASE_URL 1502
#define SETTINGS_API_KEY 1503
#define SETTINGS_BROWSER 1504
#define SETTINGS_SAVE 1506
#define SETTINGS_CANCEL 1507
#define SETTINGS_STATUS 1508
#define SETTINGS_PANEL_ENABLED 1510
#define SETTINGS_PANEL_COLLAPSED 1511
#define SETTINGS_PANEL_TOP 1512
#define SETTINGS_PANEL_RIGHT 1513
#define SETTINGS_PANEL_WIDTH 1514
#define SETTINGS_PANEL_THEME 1515
#define SETTINGS_ANSWER_MODE 1516
#define SETTINGS_ANSWER_KEY 1517
#define SETTINGS_ANSWER_THREADS 1518
#define SETTINGS_ANSWER_DIALOG 1519
#define SETTINGS_ANSWER_COUNTDOWN 1520
#define SETTINGS_ANSWER_RETRY 1521
#define SETTINGS_AUTO_SUBMIT 1522
#define SETTINGS_LOG_ENABLED 1523
#define SETTINGS_EXTENSION_ENABLED 1524
#define SETTINGS_ENABLE_ANSWER 1525
#define SETTINGS_AI_FALLBACK 1526
#define SETTINGS_ASYNC_SEARCH 1527
#define SETTINGS_DEEP_THINKING 1528
#define SETTINGS_AI_FAILURE 1529
#define SETTINGS_EXAM_AUTO_SUBMIT 1530
#define SETTINGS_LOCAL_CACHE 1531

typedef struct HOME_SESSION_SLOT {
    CX_BROWSER_SESSION *session;
    WCHAR browser[16];
    WCHAR version[64];
    /* 该会话独有的 client_instance（141 §4.3：不持久化、不跨会话复用）。
       注入到 chrome.storage.local 的 common.settings.device-instance。 */
    WCHAR instance[CX_DEVICE_INSTANCE_CAP];
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
    /* ---- 设备槽位（141 §5/§8） ---- */
    WCHAR deviceId[CX_DEVICE_ID_CAP];
    /* 会话注入上下文：只在「启动临时浏览器会话」那一次调用前由 home_work 填好。
       injectDeviceKeys 为 FALSE 时 home_build_settings 不写设备两键 ——
       考试模式与设置对话框的预览/校验路径因此天然不参与设备判定（红线 2）。 */
    BOOL injectDeviceKeys;
    WCHAR injectInstance[CX_DEVICE_INSTANCE_CAP];
    /* 宿主自己那条状态文案（会话增减/心跳/启动各写一份），避免互相覆盖。 */
    WCHAR deviceNotice[256];
    WCHAR deviceText[256];
    WCHAR statusNotice[512];
    CX_DEVICE_QUOTA quota;
    HANDLE deviceWorker;
    DWORD deviceOperation;      /* 位掩码 HOME_DEVICE_FETCH / HOME_DEVICE_REPORT */
    int deviceReportCount;
    struct HOME_DEVICE_JOB *deviceJob;
    BOOL devicePending;         /* TRUE = 有设备操作在飞，UI 线程不再派新的 */
    DWORD heartbeatAt;          /* 上次心跳的 GetTickCount，0 = 还没跑过 */
} HOME_STATE;

typedef struct SETTINGS_STATE {
    HOME_STATE *home;
    HWND window;
    HWND baseUrl;
    HWND apiKey;
    HWND browser;
    HWND status;
    HWND panelEnabled;
    HWND panelCollapsed;
    HWND panelTop;
    HWND panelRight;
    HWND panelWidth;
    HWND panelTheme;
    HWND answerMode;
    HWND answerKey;
    HWND answerThreads;
    HWND answerDialog;
    HWND answerCountdown;
    HWND answerRetry;
    HWND autoSubmit;
    HWND logEnabled;
    HWND extensionEnabled;
    HWND enableAnswer;
    HWND aiFallback;
    HWND asyncSearch;
    HWND deepThinking;
    HWND aiFailure;
    HWND examAutoSubmit;
    HWND localCache;
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

static BOOL home_json_append_char(char *out, DWORD cap, DWORD *at, char c);
static BOOL home_json_append_utf8(char *out, DWORD cap, DWORD *at, const WCHAR *value);

static void home_hex32(WCHAR *out, DWORD cap, DWORD *at, DWORD value) {
    static const WCHAR digits[] = L"0123456789abcdef";
    int i;
    if (!out || !at || *at + 8 >= cap) return;
    for (i = 7; i >= 0; --i) out[(*at)++] = digits[(value >> (i * 4)) & 0x0f];
    out[*at] = 0;
}

static void home_build_script_identity(WCHAR *out, DWORD cap) {
    DWORD at = 0;
    if (!out || cap < 2) return;
    out[0] = 0;
    home_append(out, cap, L"native-"); at = (DWORD)lstrlenW(out);
    home_hex32(out, cap, &at, GetTickCount());
    home_append(out, cap, L"-"); at = (DWORD)lstrlenW(out);
    home_hex32(out, cap, &at, GetCurrentProcessId());
    home_append(out, cap, L"-"); at = (DWORD)lstrlenW(out);
    home_hex32(out, cap, &at, GetCurrentThreadId());
}

static BOOL home_extract_url_path(const WCHAR *url, WCHAR *out, DWORD cap) {
    DWORD i = 0, slash = 0, scheme = 0;
    if (!url || !out || cap < 2) return FALSE;
    out[0] = 0;
    while (url[i] && !(url[i] == L':' && url[i + 1] == L'/' && url[i + 2] == L'/')) ++i;
    if (!url[i]) return FALSE;
    scheme = i + 3;
    i = scheme;
    while (url[i] && url[i] != L'/' && url[i] != L'?' && url[i] != L'#') ++i;
    if (!url[i]) { home_copy(out, cap, L"/"); return TRUE; }
    slash = i;
    if (url[slash] == L'/') {
        if (lstrlenW(url + slash) >= (int)cap) return FALSE;
        lstrcpynW(out, url + slash, (int)cap);
    } else {
        home_copy(out, cap, L"/");
    }
    return TRUE;
}

static BOOL home_response_string(const CX_ADAPTER_REPLY *reply, const char *key,
                                 WCHAR *out, DWORD cap) {
    JT *tokens;
    int count, value;
    BOOL ok = FALSE;
    if (!reply || !reply->body || !key || !out || cap < 1) return FALSE;
    out[0] = 0;
    tokens = (JT *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 4096 * sizeof(JT));
    if (!tokens) return FALSE;
    count = jparse(reply->body, (int)reply->length, tokens, 4096);
    value = count > 0 ? jkey(reply->body, tokens, 0, key) : -1;
    if (value >= 0) ok = jwstr(reply->body, tokens, value, out, (int)cap);
    HeapFree(GetProcessHeap(), 0, tokens);
    return ok;
}

static BOOL home_activate_script(CX_HOME_CONFIG *config, const WCHAR *activationToken,
                                 const WCHAR *sessionUrl, WCHAR *error, DWORD errorCap) {
    WCHAR path[CX_OPTIONS_PATH_CAP], identity[CX_HOME_SCRIPT_IDENTITY_CAP];
    WCHAR sessionToken[CX_HOME_API_KEY_CAP], message[512];
    char *json = NULL;
    DWORD jsonLength = 0, used = 0, i;
    BOOL ok = FALSE;
    CX_ADAPTER_REPLY reply;
    if (!config || !activationToken || !activationToken[0] || !sessionUrl || !sessionUrl[0]) return TRUE;
    if (!home_extract_url_path(sessionUrl, path, CX_OPTIONS_PATH_CAP)) {
        home_copy(error, errorCap, L"脚本会话地址无效，无法激活。"); return FALSE;
    }
    home_build_script_identity(identity, CX_HOME_SCRIPT_IDENTITY_CAP);
    json = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 65536);
    if (!json) { home_copy(error, errorCap, L"脚本会话激活内存不足。"); return FALSE; }
    json[used++] = '{';
    if (!home_json_append_char(json, 65536, &used, '"')) goto done;
    for (i = 0; L"activationToken"[i]; ++i)
        if (!home_json_append_char(json, 65536, &used, (char)L"activationToken"[i])) goto done;
    if (!home_json_append_char(json, 65536, &used, '"') || !home_json_append_char(json, 65536, &used, ':')
        || !home_json_append_char(json, 65536, &used, '"')
        || !home_json_append_utf8(json, 65536, &used, activationToken)
        || !home_json_append_char(json, 65536, &used, '"')) goto done;
    if (!home_json_append_char(json, 65536, &used, ',') || !home_json_append_char(json, 65536, &used, '"')) goto done;
    for (i = 0; L"identity"[i]; ++i)
        if (!home_json_append_char(json, 65536, &used, (char)L"identity"[i])) goto done;
    if (!home_json_append_char(json, 65536, &used, '"') || !home_json_append_char(json, 65536, &used, ':')
        || !home_json_append_char(json, 65536, &used, '"')
        || !home_json_append_utf8(json, 65536, &used, identity)
        || !home_json_append_char(json, 65536, &used, '"')
        || !home_json_append_char(json, 65536, &used, '}')) goto done;
    json[used] = 0; jsonLength = used;
    ZeroMemory(&reply, sizeof(reply));
    ok = cx_adapter_request(config->adapterBaseUrl, L"POST", path, NULL, json,
        10000, 65536, &reply, error, errorCap);
    if (!ok || reply.status < 200 || reply.status >= 300) {
        if (ok && home_response_string(&reply, "message", message, 512) && message[0])
            home_copy(error, errorCap, message);
        ok = FALSE; goto done;
    }
    if (!home_response_string(&reply, "token", sessionToken, CX_HOME_API_KEY_CAP)
        || !sessionToken[0]) {
        home_copy(error, errorCap, L"脚本会话响应无效，未继续启动。"); ok = FALSE; goto done;
    }
    home_copy(config->apiKey, CX_HOME_API_KEY_CAP, sessionToken);
    home_copy(config->scriptIdentity, CX_HOME_SCRIPT_IDENTITY_CAP, identity);
    ok = TRUE;
done:
    cx_adapter_reply_free(&reply);
    if (json) { SecureZeroMemory(json, 65536); HeapFree(GetProcessHeap(), 0, json); }
    SecureZeroMemory(sessionToken, sizeof(sessionToken));
    SecureZeroMemory(identity, sizeof(identity));
    (void)jsonLength;
    return ok;
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
    char *json; JT *tokens; DWORD length; int count, base, key, activation, sessionUrl; BOOL ok = FALSE;
    WCHAR activationText[CX_HOME_API_KEY_CAP], sessionUrlText[CX_OPTIONS_PATH_CAP];
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
    activation = jkey(json, tokens, 0, "common.settings.tiku-adapter.script-activation-token");
    sessionUrl = jkey(json, tokens, 0, "common.settings.tiku-adapter.script-session-url");
    if (base >= 0 && !jwstr(json, tokens, base, copy->adapterBaseUrl, CX_HOME_ADAPTER_URL_CAP)) goto done;
    if (key >= 0 && !jwstr(json, tokens, key, copy->apiKey, CX_HOME_API_KEY_CAP)) goto done;
    activationText[0] = 0; sessionUrlText[0] = 0;
    if ((activation >= 0 && !jwstr(json, tokens, activation, activationText, CX_HOME_API_KEY_CAP))
        || (sessionUrl >= 0 && !jwstr(json, tokens, sessionUrl, sessionUrlText, CX_OPTIONS_PATH_CAP))) goto done;
    if (activationText[0] || sessionUrlText[0]) {
        if (!activationText[0] || !sessionUrlText[0]
            || !home_activate_script(copy, activationText, sessionUrlText, error, errorCap)) goto done;
    }
    CopyMemory(config, copy, sizeof(*copy)); ok = TRUE;
done:
    if (copy) { SecureZeroMemory(copy, sizeof(*copy)); HeapFree(GetProcessHeap(), 0, copy); }
    if (json) { SecureZeroMemory(json, length + 3); HeapFree(GetProcessHeap(), 0, json); }
    if (tokens) HeapFree(GetProcessHeap(), 0, tokens);
    SecureZeroMemory(activationText, sizeof(activationText));
    SecureZeroMemory(sessionUrlText, sizeof(sessionUrlText));
    if (!ok && error && errorCap && !error[0]) home_copy(error, errorCap, L"已有题库服务设置无效，无法初始化首页。");
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

typedef BOOL (*HOME_BROWSER_LOOKUP)(const WCHAR *browser, WCHAR *out, DWORD cap);
static BOOL home_find_default_browser(HOME_BROWSER_LOOKUP lookup, WCHAR *browserOut, DWORD browserCap,
    WCHAR *pathOut, DWORD pathCap) {
    if (lookup(L"edge", pathOut, pathCap)) { home_copy(browserOut, browserCap, L"edge"); return TRUE; }
    if (lookup(L"chrome", pathOut, pathCap)) { home_copy(browserOut, browserCap, L"chrome"); return TRUE; }
    return FALSE;
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

static BOOL home_json_append_pair(char *out, DWORD cap, DWORD *at,
                                  const char *key, const WCHAR *value, BOOL *first) {
    DWORD i;
    if (!out || !at || !key || !value || !first) return FALSE;
    if (!*first && !home_json_append_char(out, cap, at, ',')) return FALSE;
    if (!home_json_append_char(out, cap, at, '"')) return FALSE;
    for (i = 0; key[i]; ++i) if (!home_json_append_char(out, cap, at, key[i])) return FALSE;
    if (!home_json_append_char(out, cap, at, '"') || !home_json_append_char(out, cap, at, ':')
        || !home_json_append_char(out, cap, at, '"')
        || !home_json_append_utf8(out, cap, at, value)
        || !home_json_append_char(out, cap, at, '"')) return FALSE;
    *first = FALSE;
    return TRUE;
}

static BOOL home_adapter_patch(const CX_HOME_CONFIG *config, char *patch, DWORD cap) {
    DWORD n = 0;
    BOOL first = TRUE;
    if (!config || !patch || cap < 8 || !home_json_append_char(patch, cap, &n, '{')) return FALSE;
    if (!home_json_append_pair(patch, cap, &n, "common.settings.tiku-adapter.baseurl", config->adapterBaseUrl, &first)
        || !home_json_append_pair(patch, cap, &n, "common.settings.tiku-adapter.key", config->apiKey, &first)) return FALSE;
    /* A script activation ticket is single-use. Never expose the consumed
       ticket or activation endpoint to the browser's runtime settings. */
    if (!home_json_append_pair(patch, cap, &n, "common.settings.tiku-adapter.script-activation-token", L"", &first)
        || !home_json_append_pair(patch, cap, &n, "common.settings.tiku-adapter.script-session-url", L"", &first)) return FALSE;
    if (config->scriptIdentity[0]
        && !home_json_append_pair(patch, cap, &n, "common.settings.tiku-adapter.script-identity", config->scriptIdentity, &first)) return FALSE;
    return home_json_append_char(patch, cap, &n, '}');
}

/*
   设备两键（141 §5.2 / §4.3）：
     device_id        = 宿主 device_id   ← 所有会话相同（R7 要求全关能回落到 1）
     client_instance  = 该会话新生成的    ← 每个会话必须不同
   只在 injectDeviceKeys 为 TRUE（= 正在为临时浏览器会话构造 settings）时写入。
   这两个键名必须与扩展侧 src/runtime/device-identity.ts 和
   windows/node-source/config.mjs 的 DEVICE_ID_KEY / DEVICE_INSTANCE_KEY 逐字一致。
*/
static BOOL home_device_patch(const HOME_STATE *state, char *patch, DWORD cap) {
    DWORD n = 0;
    BOOL first = TRUE;
    if (!state || !patch || cap < 8 || !home_json_append_char(patch, cap, &n, '{')) return FALSE;
    if (!state->injectDeviceKeys) return home_json_append_char(patch, cap, &n, '}');
    if (!home_json_append_pair(patch, cap, &n, CX_DEVICE_ID_KEY, state->deviceId, &first)) return FALSE;
    if (!home_json_append_pair(patch, cap, &n, CX_DEVICE_INSTANCE_KEY, state->injectInstance, &first)) return FALSE;
    return home_json_append_char(patch, cap, &n, '}');
}

static BOOL home_build_settings(const HOME_STATE *state, const CX_HOME_CONFIG *config,
    char *out, DWORD cap, DWORD *length, WCHAR *error, DWORD errorCap) {
    char *buffers; char *base, *custom, *patch, *device;
    DWORD shared = state->options->sharedSettingsLength, merged = 0; int converted;
    BOOL ok = FALSE;
    if (shared > CX_OPTIONS_JSON_CAP - 3) return FALSE;
    buffers = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_OPTIONS_JSON_CAP * 4);
    if (!buffers) return FALSE;
    base = buffers; custom = base + CX_OPTIONS_JSON_CAP; patch = custom + CX_OPTIONS_JSON_CAP;
    device = patch + CX_OPTIONS_JSON_CAP;
    base[0] = '{'; CopyMemory(base + 1, state->options->sharedSettingsJson, shared); base[shared + 1] = '}';
    converted = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, config->settingsJson, -1, custom, CX_OPTIONS_JSON_CAP, NULL, NULL);
    if (!converted || !cx_config_merge_settings(base, shared + 2, custom, (DWORD)converted - 1,
        out, cap, &merged, error, errorCap)) goto done;
    if (!home_adapter_patch(config, patch, CX_OPTIONS_JSON_CAP)) goto done;
    if (!cx_config_merge_settings(out, merged, patch, (DWORD)lstrlenA(patch), out, cap, &merged, error, errorCap)) goto done;
    /* 设备两键放在最后一步合并：即使前面任何一层带了同名键，也会被这里的宿主值覆盖，
       保证「device_id 一定是宿主的、client_instance 一定是本会话的」。 */
    if (!home_device_patch(state, device, CX_OPTIONS_JSON_CAP)) goto done;
    ok = cx_config_merge_settings(out, merged, device, (DWORD)lstrlenA(device), out, cap, length, error, errorCap);
done:
    SecureZeroMemory(buffers, CX_OPTIONS_JSON_CAP * 4); HeapFree(GetProcessHeap(), 0, buffers); return ok;
}

static BOOL home_apply_typed_settings(CX_OPTIONS *options, const char *settings,
    DWORD settingsLength, WCHAR *error, DWORD errorCap) {
    char *wrapped; DWORD rawLength, prefixLength, suffixLength; BOOL fullObject, ok = FALSE;
    if (!options || !settings || settingsLength > CX_OPTIONS_JSON_CAP - 16) return FALSE;
    rawLength = (DWORD)lstrlenA(settings);
    if (rawLength != settingsLength) settingsLength = rawLength;
    fullObject = settingsLength >= 2 && settings[0] == '{' && settings[settingsLength - 1] == '}';
    prefixLength = fullObject ? 12 : 13;
    suffixLength = fullObject ? 1 : 2;
    wrapped = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_OPTIONS_JSON_CAP + 32);
    if (!wrapped) goto done;
    CopyMemory(wrapped, fullObject ? "{\"settings\":" : "{\"settings\":{", prefixLength);
    CopyMemory(wrapped + prefixLength, settings, settingsLength);
    if (!fullObject) wrapped[prefixLength + settingsLength] = '}';
    wrapped[prefixLength + settingsLength + (fullObject ? 0 : 1)] = '}';
    wrapped[prefixLength + settingsLength + suffixLength] = 0;
    ok = cx_options_apply_json_utf8(options, wrapped,
        (int)(prefixLength + settingsLength + suffixLength), error, errorCap);
done:
    if (wrapped) { SecureZeroMemory(wrapped, CX_OPTIONS_JSON_CAP + 32); HeapFree(GetProcessHeap(), 0, wrapped); }
    return ok;
}

static void home_status(HOME_STATE *state, const WCHAR *text) {
    if (state && state->status) SetWindowTextW(state->status, text ? text : L"");
}

/* ============================================================================
   设备槽位（141 §5 / §8）
   ----------------------------------------------------------------------------
   两条硬约束决定了这里的结构：

   1. **上报失败不阻断本地**（红线 3）：所有网络调用都在独立线程里跑，
      结果经 HOME_DEVICE_DONE 回到 UI 线程；失败只改文案，绝不改变控制流。
   2. **C5-2 只提醒不拦截**（红线 1 / R8）：over_limit 只决定「要不要弹提醒」，
      「仍然新建」走的是和普通新建完全相同的 home_begin 分支。
   ========================================================================== */

#define HOME_DEVICE_FETCH  0x1u
#define HOME_DEVICE_REPORT 0x2u

typedef struct HOME_DEVICE_JOB {
    CX_DEVICE_QUOTA quota;
    BOOL quotaOk;
    BOOL reportOk;
    WCHAR reportError[256];
} HOME_DEVICE_JOB;

/* 当前实际打开的浏览器会话数（state->sessions 里非 NULL 的个数）。 */
static int home_open_sessions(const HOME_STATE *state) {
    DWORD i;
    int count = 0;
    if (!state) return 0;
    for (i = 0; i < HOME_MAX_SESSIONS; ++i) if (state->sessions[i].session) ++count;
    return count;
}

/* 设备配置路径：--config 显式路径 > dataDir > cwd\windows\data\config.json。 */
static BOOL home_device_config_path(const HOME_STATE *state, WCHAR *out, DWORD cap) {
    return cx_device_config_path(state->options->configPathSet ? state->options->configPath : NULL,
        state->options->dataDir, out, cap);
}

/* 状态栏文案：设备行 + （可能有的）宿主提示。 */
static void home_refresh_status(HOME_STATE *state) {
    WCHAR text[512];
    int sessions;
    if (!state) return;
    sessions = home_open_sessions(state);
    if (!cx_device_status_text(&state->quota, sessions, text, 512)) return;
    home_copy(state->deviceText, 256, text);
    text[0] = 0;
    home_append(text, 512, state->deviceText);
    if (state->deviceNotice[0]) {
        home_append(text, 512, L"\r\n");
        home_append(text, 512, state->deviceNotice);
    }
    home_status(state, text);
}

static void home_device_notice(HOME_STATE *state, const WCHAR *notice) {
    if (!state) return;
    home_copy(state->deviceNotice, 256, notice ? notice : L"");
    home_refresh_status(state);
}

/* 设备线程主体：一次只做一件事（查询配额 或 上报会话数），避免线程排队。 */
static DWORD WINAPI home_device_work(LPVOID context) {
    HOME_STATE *state = (HOME_STATE *)context;
    HOME_DEVICE_JOB *job = state ? state->deviceJob : NULL;
    if (!state || !job) { if (state) PostMessageW(state->window, HOME_DEVICE_DONE, 0, 0); return 0; }
    if (state->deviceOperation & HOME_DEVICE_FETCH) {
        job->quotaOk = cx_device_quota_fetch(state->config ? state->config->adapterBaseUrl : L"",
            state->config ? state->config->apiKey : L"", 8000, &job->quota);
    }
    if (state->deviceOperation & HOME_DEVICE_REPORT) {
        WCHAR error[256];
        error[0] = 0;
        /* count 取 state->deviceReportCount（home_device_kick 在派活前写好），
           不是 job 自己的字段 —— job 由调用方保留，count 由 UI 线程按「当前会话数」更新，
           混用会让上报值永远停在第一次分配时的 0。 */
        job->reportOk = cx_device_sessions_report(state->config ? state->config->adapterBaseUrl : L"",
            state->config ? state->config->apiKey : L"", state->deviceId, state->deviceReportCount, 8000, error, 256);
        home_copy(job->reportError, 256, error);
    }
    PostMessageW(state->window, HOME_DEVICE_DONE, 0, 0);
    return 0;
}

/*
   派一次设备操作。已有操作在飞时只更新 deviceOperation（合并请求），不新开线程 ——
   否则频繁开关会话会产生线程风暴，而每次上报都只是「把当前会话数告诉服务端」，
   最新的一次天然覆盖旧的。
*/
static void home_device_kick(HOME_STATE *state, DWORD operation, int count) {
    if (!state) return;
    if (operation & HOME_DEVICE_REPORT) {
        /* 没有 device_id 时上报无意义（服务端无从定位设备）；查询配额仍可做。 */
        if (!state->deviceId[0]) operation &= ~HOME_DEVICE_REPORT;
        else state->deviceReportCount = cx_device_sessions_clamp(count);
    }
    if (!operation) return;
    state->deviceOperation |= operation;
    if (state->devicePending) return;
    if (!state->deviceJob) {
        state->deviceJob = (HOME_DEVICE_JOB *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(HOME_DEVICE_JOB));
        if (!state->deviceJob) { state->deviceOperation = 0; return; }
    }
    state->devicePending = TRUE;
    state->deviceWorker = CreateThread(NULL, 0, home_device_work, state, 0, NULL);
    if (!state->deviceWorker) {
        state->devicePending = FALSE; state->deviceOperation = 0;
        home_device_notice(state, L"无法创建设备状态线程");
    }
}

/* 会话数变化后立即上报（四个时机统一走这里）。 */
static void home_device_report(HOME_STATE *state) {
    home_device_kick(state, HOME_DEVICE_REPORT, home_open_sessions(state));
}

/*
   同步等设备线程做完。只用于「窗口即将销毁」的那一刻（HOME_EXIT）：此时已经不能
   靠 HOME_DEVICE_DONE 回到 UI 线程，必须就地收尾，否则 count=0 永远发不出去，
   服务端会一直把崩溃前的 3 记成 3（R7 就不生效了）。
   超时上限 12 秒 = 两次 8 秒请求里的一次；等不到也不阻塞退出（fail-open）。
*/
static void home_device_wait(HOME_STATE *state) {
    if (!state || !state->deviceWorker) return;
    if (WaitForSingleObject(state->deviceWorker, 12000) == WAIT_OBJECT_0) {
        CloseHandle(state->deviceWorker);
        state->deviceWorker = NULL;
        state->devicePending = FALSE;
        state->deviceOperation = 0;
    }
}

/*
   退出前把 count=0 真正发出去（R7 的灵魂：全关必须回落到 1，那 1 个是宿主自己）。

   为什么必须同步：HOME_EXIT 紧接着 DestroyWindow，之后 HOME_DEVICE_DONE 再也
   回不到 UI 线程，异步上报必然丢失 —— 服务端会把崩溃/退出前的 N 一直记成 N。
   所以这里：先把手上的设备线程收干净，再就地同步发一次 0。
   超时上限 3 秒：等不到也不阻断退出（fail-open，与 137 一致）。
*/
static void home_device_flush_exit(HOME_STATE *state) {
    WCHAR error[256];
    if (!state || !state->deviceId[0]) return;
    /* 先把在飞的线程收干净，避免它随后又用旧 count 覆盖掉我们刚发的 0。 */
    home_device_wait(state);
    if (state->deviceJob) {
        SecureZeroMemory(state->deviceJob, sizeof(*state->deviceJob));
        HeapFree(GetProcessHeap(), 0, state->deviceJob);
        state->deviceJob = NULL;
    }
    error[0] = 0;
    (void)cx_device_sessions_report(state->config ? state->config->adapterBaseUrl : L"",
        state->config ? state->config->apiKey : L"", state->deviceId, 0, 3000, error, 256);
    if (error[0]) home_device_notice(state, error);
}

/* HOME_DEVICE_DONE：把设备线程结果搬到 UI 线程的 state 上。 */
static void home_device_settle(HOME_STATE *state) {    HOME_DEVICE_JOB *job = state->deviceJob;
    DWORD operation = state->deviceOperation;
    if (state->deviceWorker) { WaitForSingleObject(state->deviceWorker, INFINITE); CloseHandle(state->deviceWorker); state->deviceWorker = NULL; }
    state->devicePending = FALSE;
    state->deviceOperation = 0;
    if (!job) { home_refresh_status(state); return; }
    if (operation & HOME_DEVICE_FETCH) {
        if (job->quotaOk) {
            state->quota = job->quota;
            home_device_notice(state, L"");
        } else {
            /* fail-open：只改文案，不影响任何本地能力（含「新会话」）。 */
            WCHAR notice[256];
            notice[0] = 0;
            home_copy(notice, 256, L"无法获取设备配额");
            if (job->quota.error[0]) { home_append(notice, 256, L"："); home_append(notice, 256, job->quota.error); }
            home_device_notice(state, notice);
        }
    }
    if (operation & HOME_DEVICE_REPORT) {
        if (job->reportOk) home_device_notice(state, L"");
        else if (job->reportError[0]) {
            WCHAR notice[256];
            notice[0] = 0;
            home_append(notice, 256, L"会话数未能上报：");
            home_append(notice, 256, job->reportError);
            home_device_notice(state, notice);
        }
    }
    /* 刷新配额失败后重试一次心跳（心跳本身也会刷新配额）。 */
    if (!(operation & HOME_DEVICE_FETCH)) home_refresh_status(state);
}

/*
   超限提醒（R8）。

   ⚠️ 返回值只表示「用户主动选择了仍然新建」，**不表示「允许」**。调用方无论走哪条
   分支都会照常 home_begin —— 这正是 R8：**提醒，绝不拦截**。
   这个对话框没有「禁止」语义：取消只是用户放弃本次点击。

   为什么不用 MessageBoxW：默认按钮无法显式指定为「取消」以外的可测形态，
   而且 MessageBoxW 是系统模态，测试无法用 WM_COMMAND 驱动。
   自绘对话框把「默认焦点在取消」变成可断言的事实（DM_GETDEFID / BS_DEFPUSHBUTTON）。
*/
typedef struct HOME_PROMPT_STATE {
    HWND window;
    HWND text;
    HWND proceed;
    HWND cancel;
    HFONT font;
    BOOL accepted;              /* TRUE = 仍然新建 */
    int inspections;            /* 供测试观察：对话框确实起来了 */
} HOME_PROMPT_STATE;

static LRESULT CALLBACK home_prompt_proc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    HOME_PROMPT_STATE *state = (HOME_PROMPT_STATE *)GetWindowLongPtrW(window, GWLP_USERDATA);
    if (message == WM_NCCREATE) {
        CREATESTRUCTW *create = (CREATESTRUCTW *)lParam;
        state = (HOME_PROMPT_STATE *)create->lpCreateParams;
        state->window = window;
        SetWindowLongPtrW(window, GWLP_USERDATA, (LONG_PTR)state);
        home_set_icon(window);
    }
    if (!state) return DefWindowProcW(window, message, wParam, lParam);
    if (message == WM_COMMAND) {
        switch (LOWORD(wParam)) {
        case HOME_PROMPT_PROCEED: state->accepted = TRUE; DestroyWindow(window); return 0;
        case HOME_PROMPT_CANCEL:
        case IDCANCEL: DestroyWindow(window); return 0;
        default: break;
        }
    }
    if (message == WM_CLOSE) { DestroyWindow(window); return 0; }
    return DefWindowProcW(window, message, wParam, lParam);
}

static BOOL home_prompt_register(void) {
    WNDCLASSW klass;
    ZeroMemory(&klass, sizeof(klass));
    klass.lpfnWndProc = home_prompt_proc;
    klass.hInstance = home_instance;
    klass.hIcon = home_icon();
    klass.hCursor = LoadCursorW(NULL, IDC_ARROW);
    klass.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    klass.lpszClassName = HOME_DEVICE_PROMPT_CLASS;
    return RegisterClassW(&klass) || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
}

/* 返回 TRUE = 仍然新建。超限以外的任何情况都直接返回 TRUE（不打扰用户）。 */
static BOOL home_device_prompt_modal(HOME_STATE *state) {
    HOME_PROMPT_STATE *prompt;
    WCHAR heading[128], body[768], line[256];
    MSG message;
    int got = 1;
    if (!state || !cx_device_over_limit(&state->quota)) return TRUE;
    prompt = (HOME_PROMPT_STATE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*prompt));
    if (!prompt) return TRUE; /* 分配失败按「继续」处理：绝不因为提示而挡住用户 */
    prompt->font = state->font;
    prompt->window = CreateWindowExW(WS_EX_DLGMODALFRAME, HOME_DEVICE_PROMPT_CLASS, L"设备数量已达上限",
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_POPUP,
        CW_USEDEFAULT, CW_USEDEFAULT, MulDiv(520, home_dpi, 96), MulDiv(250, home_dpi, 96),
        state->window, NULL, home_instance, prompt);
    if (!prompt->window) { HeapFree(GetProcessHeap(), 0, prompt); return TRUE; }
    wsprintfW(heading, L"设备数量已达上限（%d / %d）。", state->quota.used, state->quota.limit);
    body[0] = 0;
    home_append(body, 768, L"仍可新建浏览器，但可能无法正常使用：\r\n");
    home_append(body, 768, L"搜题请求可能被拒绝，导致答题失败。\r\n\r\n");
    home_append(body, 768, L"请到网页端「我的设备」移除不用的设备。");
    line[0] = 0;
    home_append(line, 256, heading);
    home_append(line, 256, L"\r\n\r\n");
    home_append(line, 256, body);
    prompt->text = home_control(0, L"STATIC", line, WS_CHILD | WS_VISIBLE, 20, 16, 470, 140, prompt->window, 0);
    prompt->proceed = home_control(0, L"BUTTON", L"仍然新建", WS_CHILD | WS_VISIBLE, 220, 175, 130, 32, prompt->window, HOME_PROMPT_PROCEED);
    prompt->cancel = home_control(0, L"BUTTON", L"取消", WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON, 365, 175, 130, 32, prompt->window, HOME_PROMPT_CANCEL);
    if (prompt->font) {
        if (prompt->text) SendMessageW(prompt->text, WM_SETFONT, (WPARAM)prompt->font, TRUE);
        if (prompt->proceed) SendMessageW(prompt->proceed, WM_SETFONT, (WPARAM)prompt->font, TRUE);
        if (prompt->cancel) SendMessageW(prompt->cancel, WM_SETFONT, (WPARAM)prompt->font, TRUE);
    }
    ShowWindow(prompt->window, SW_SHOW); ShowWindow(prompt->window, SW_SHOW);
    UpdateWindow(prompt->window);
    /* 默认焦点在「取消」（危险操作不设默认）。BS_DEFPUSHBUTTON 只是视觉默认，
       键盘焦点必须显式给到 cancel，两者都做才算「默认焦点在取消」。 */
    if (prompt->cancel) SetFocus(prompt->cancel);
    EnableWindow(state->window, FALSE);
    ++prompt->inspections;
    while (IsWindow(prompt->window) && (got = GetMessageW(&message, NULL, 0, 0)) > 0) {
        if (!IsDialogMessageW(prompt->window, &message)) { TranslateMessage(&message); DispatchMessageW(&message); }
    }
    if (IsWindow(prompt->window)) DestroyWindow(prompt->window);
    if (!got) PostQuitMessage((int)message.wParam);
    EnableWindow(state->window, TRUE);
    SetForegroundWindow(state->window);
    got = prompt->accepted;
    SecureZeroMemory(prompt, sizeof(*prompt));
    HeapFree(GetProcessHeap(), 0, prompt);
    return got ? TRUE : FALSE;
}

/*
   超限提醒的统一入口：判定在上，模态在 home_device_prompt_modal。

   两个可注入点（home-tests.c 以文本 include 方式编译本文件，能直接改这两个静态变量）：
     home_device_prompt_auto_proceed = TRUE  → 等价于用户点「仍然新建」
     home_device_prompt_count               → 断言「每次点击只提醒一次」
   生产路径两者都是初值，不改变行为。
*/
static int home_device_prompt_count;
static BOOL home_device_prompt_auto_proceed;

static BOOL home_device_confirm_over_limit(HOME_STATE *state) {
    if (!state || !cx_device_over_limit(&state->quota)) return TRUE;
    ++home_device_prompt_count;
    if (home_device_prompt_auto_proceed) return TRUE;   /* 等价于用户点「仍然新建」 */
    return home_device_prompt_modal(state);
}

/*
   为一个即将启动的临时浏览器会话准备注入上下文。

   抽成函数而不是内联在 home_work 里，是为了让 home-tests.c 能直接执行这段原文
   来断言「不同会话不同 instance」—— 若测试自己去调 cx_device_instance_new，
   把这里改成固定值时用例仍会绿（假钉子，2026-11-13 t143 踩过）。
*/
static BOOL home_device_begin_injection(HOME_STATE *state) {
    if (!state) return FALSE;
    state->injectDeviceKeys = TRUE;
    if (!cx_device_instance_new(state->injectInstance, CX_DEVICE_INSTANCE_CAP)) {
        /* 拿不到随机源时宁可不注入，也不要让多个会话共用同一个 instance
           （那会让服务端把不同会话判成同一实例）。 */
        state->injectDeviceKeys = FALSE;
        state->injectInstance[0] = 0;
        return FALSE;
    }
    return TRUE;
}

static void home_device_end_injection(HOME_STATE *state) {
    if (!state) return;
    state->injectDeviceKeys = FALSE;
    SecureZeroMemory(state->injectInstance, sizeof(state->injectInstance));
}

static void home_refresh_list(HOME_STATE *state) {
    DWORD i; WCHAR line[512]; LRESULT selected, oldSlot = LB_ERR; BOOL restored = FALSE;
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
                if ((LRESULT)i == oldSlot) {
                    SendMessageW(state->list, LB_SETCURSEL, selected, 0); restored = TRUE;
                }
            }
        }
    }
    if (!restored && SendMessageW(state->list, LB_GETCOUNT, 0, 0) > 0)
        SendMessageW(state->list, LB_SETCURSEL, 0, 0);
}

static void home_poll_sessions(HOME_STATE *state) {
    DWORD i; BOOL running, changed = FALSE;
    WCHAR error[256];
    if (state->worker) return;
    for (i = 0; i < HOME_MAX_SESSIONS; ++i) {
        if (!state->sessions[i].session) continue;
        error[0] = 0;
        if (!cx_browser_poll(state->sessions[i].session, &running, error, 256)) {
            if (error[0]) home_status(state, error);
        } else if (!running) {
            /* 时机 2/4（141 §5.3）：进程自己退出 → 会话数 -1 后立即上报。 */
            cx_browser_destroy(state->sessions[i].session);
            state->sessions[i].session = NULL;
            state->sessions[i].instance[0] = 0;
            changed = TRUE;
            if (error[0]) home_status(state, error);
        }
    }
    home_refresh_list(state);
    if (changed) {
        home_device_report(state);
        home_refresh_status(state);
    }
    /* 时机 5：心跳。复用本 500ms 的 poll 循环做 60 秒分频（不新开 timer）。
       心跳同时刷新配额，服务端 3 分钟收不到就把它记 0（141 §5.4）。 */
    {
        DWORD now = GetTickCount();
        if (!state->heartbeatAt || now - state->heartbeatAt >= HOME_HEARTBEAT_MS) {
            state->heartbeatAt = now;
            home_device_kick(state, HOME_DEVICE_REPORT | HOME_DEVICE_FETCH, home_open_sessions(state));
        }
    }
}

static DWORD WINAPI home_work(LPVOID context) {
    HOME_STATE *state = (HOME_STATE *)context;
    WCHAR *browserPath = NULL, *cacheDir = NULL;
    char *settings = NULL;
    BYTE *data = NULL; DWORD size = 0, settingsLength = 0, i;
    CX_BROWSER_OPTIONS options;
    BOOL forceRefresh;
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
    browserPath = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, CX_HOME_EXTENSION_PATH_CAP * sizeof(WCHAR));
    cacheDir = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_HOME_EXTENSION_PATH_CAP * sizeof(WCHAR));
    settings = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_OPTIONS_JSON_CAP);
    if (!browserPath || !cacheDir || !settings) goto done;
    home_copy(cacheDir, CX_HOME_EXTENSION_PATH_CAP, state->options->dataDir);
    if (cacheDir[0] && cacheDir[lstrlenW(cacheDir) - 1] != L'\\' && cacheDir[lstrlenW(cacheDir) - 1] != L'/')
        home_append(cacheDir, CX_HOME_EXTENSION_PATH_CAP, L"\\");
    home_append(cacheDir, CX_HOME_EXTENSION_PATH_CAP, L"chaoxing\\extension-cache");
    if (state->operation != HOME_UPDATE && lstrcmpiW(state->pendingBrowser, L"auto") == 0) {
        if (!home_find_default_browser(home_find_browser, state->pendingBrowser, 16,
            browserPath, CX_HOME_EXTENSION_PATH_CAP)) {
            home_copy(state->error, 512, L"未找到 Microsoft Edge 或 Google Chrome，请先安装其中一个浏览器。");
            goto done;
        }
    } else if (state->operation != HOME_UPDATE
        && !home_find_browser(state->pendingBrowser, browserPath, CX_HOME_EXTENSION_PATH_CAP)) {
        home_copy(state->error, 512, L"未找到所选浏览器，请先安装 Microsoft Edge 或 Google Chrome。"); goto done;
    }
    forceRefresh = state->operation == HOME_UPDATE;
    if (!cx_adapter_extension_fetch_cached(state->pendingConfig.adapterBaseUrl, L"edge", cacheDir,
        state->options->noDiskWrite, forceRefresh, &data, &size, state->extensionVersion, 64,
        state->error, 512)) goto done;
    if (!cx_browser_extension_verify(data, size, L"lcmeenlnjihhjcjoakekikoaldigonac", state->error, 512)) {
        if (forceRefresh) goto done;
        if (data) { HeapFree(GetProcessHeap(), 0, data); data = NULL; size = 0; }
        state->error[0] = 0;
        if (!cx_adapter_extension_fetch_cached(state->pendingConfig.adapterBaseUrl, L"edge", cacheDir,
            state->options->noDiskWrite, TRUE, &data, &size, state->extensionVersion, 64,
            state->error, 512)) goto done;
        if (!cx_browser_extension_verify(data, size, L"lcmeenlnjihhjcjoakekikoaldigonac", state->error, 512)) goto done;
    }
    if (state->operation == HOME_UPDATE) { state->operationOK = TRUE; goto done; }
    /* 注入上下文只在这里填：这就是「临时浏览器会话」那一次构造。
       考试模式（home_exam）与设置对话框的预览/校验都走 home_build_settings，
       但它们不会置 injectDeviceKeys，所以天然不带设备两键（红线 2）。
       实例标识每次点击都新生成 —— 不同会话一定不同值（141 §4.3）。 */
    /* 注入上下文只在这里填：这就是「临时浏览器会话」那一次构造。
       考试模式（home_exam）与设置对话框的预览/校验都走 home_build_settings，
       但它们不会置 injectDeviceKeys，所以天然不带设备两键（红线 2）。
       实例标识每次点击都新生成 —— 不同会话一定不同值（141 §4.3）。 */
    (void)home_device_begin_injection(state);
    if (!home_build_settings(state, &state->pendingConfig, settings, CX_OPTIONS_JSON_CAP, &settingsLength, state->error, 512)) goto done;
    ZeroMemory(&options, sizeof(options)); options.browserPath = browserPath;
    options.crxData = data; options.crxSize = size; options.initialUrl = L"https://www.chaoxing.com/";
    options.settingsJsonUTF8 = settings;
    state->operationOK = cx_browser_start(&options, &state->pendingSession, state->error, 512);
done:
    /* 注入上下文只在本次调用内有效：任何后续（设置对话框预览、考试模式）
       都不得意外带上设备两键。 */
    home_device_end_injection(state);
    if (settings) { SecureZeroMemory(settings, CX_OPTIONS_JSON_CAP); HeapFree(GetProcessHeap(), 0, settings); }
    if (browserPath) HeapFree(GetProcessHeap(), 0, browserPath);
    if (cacheDir) HeapFree(GetProcessHeap(), 0, cacheDir);
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
    BOOL isNewSession;
    if (state->worker) return;
    isNewSession = operation == HOME_EDGE || operation == HOME_CHROME;
    state->pendingSlot = HOME_MAX_SESSIONS;
    if (operation == HOME_CLOSE_SESSION) {
        selected = SendMessageW(state->list, LB_GETCURSEL, 0, 0);
        if (selected != LB_ERR) state->pendingSlot = (DWORD)SendMessageW(state->list, LB_GETITEMDATA, selected, 0);
        if (state->pendingSlot >= HOME_MAX_SESSIONS) { home_status(state, L"请先选择一个临时会话"); return; }
    } else if (isNewSession) {
        for (i = 0; i < HOME_MAX_SESSIONS; ++i) if (!state->sessions[i].session) break;
        if (i == HOME_MAX_SESSIONS) { home_status(state, L"临时会话已达到 8 个上限"); return; }
        state->pendingSlot = i;
        /*
           C5-2 / R8：超限只提醒，绝不拦截。

           ⚠️ 这里刻意写成「先提示、无论结果都往下走」：home_device_confirm_over_limit
           返回 FALSE 只代表用户自己点了取消（一次用户主动放弃），不是程序拦住了他。
           任何「if (!confirm) return;」以外的校验都不要往这里加 —— 变异 S10 会把这条
           改成拦截，scripts/device-quota.test.mjs 必须因此变红。
        */
        home_device_confirm_over_limit(state);
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

static BOOL settings_read_int(HWND control, int minimum, int maximum, int *value) {
    WCHAR text[32]; DWORD i; int parsed = 0;
    if (!control || !value || !GetWindowTextW(control, text, 32) || !text[0]) return FALSE;
    for (i = 0; text[i]; ++i) {
        if (text[i] < L'0' || text[i] > L'9') return FALSE;
        parsed = parsed * 10 + (int)(text[i] - L'0');
        if (parsed > maximum) return FALSE;
    }
    if (parsed < minimum) return FALSE;
    *value = parsed; return TRUE;
}

static BOOL settings_token_eq(const WCHAR *start, int length, const WCHAR *value) {
    int i = 0; WCHAR current;
    while (value[i] && i < length) {
        current = start[i];
        if (current >= L'a' && current <= L'z') current = (WCHAR)(current - L'a' + L'A');
        if (current != value[i]) break;
        ++i;
    }
    return i == length && value[i] == 0;
}

static BOOL settings_shortcut_valid(const WCHAR *value) {
    int i = 0, begin = 0, bases = 0, modifiers = 0, modifierMask = 0;
    if (!value || !value[0]) return FALSE;
    for (;;) {
        int end = i, k, fnum = 0, base = 0;
        while (value[end] && value[end] != L'+') ++end;
        if (end == begin) return FALSE;
        if (settings_token_eq(value + begin, end - begin, L"CTRL") ||
            settings_token_eq(value + begin, end - begin, L"ALT") ||
            settings_token_eq(value + begin, end - begin, L"SHIFT") ||
            settings_token_eq(value + begin, end - begin, L"WIN")) {
            int bit = settings_token_eq(value + begin, end - begin, L"CTRL") ? 1 :
                settings_token_eq(value + begin, end - begin, L"ALT") ? 2 :
                settings_token_eq(value + begin, end - begin, L"SHIFT") ? 4 : 8;
            if (modifierMask & bit) return FALSE;
            modifierMask |= bit; ++modifiers;
        } else {
            if (end - begin == 1 && ((value[begin] >= L'A' && value[begin] <= L'Z') ||
                (value[begin] >= L'a' && value[begin] <= L'z') ||
                (value[begin] >= L'0' && value[begin] <= L'9'))) base = 1;
            if (settings_token_eq(value + begin, end - begin, L"SPACE") ||
                settings_token_eq(value + begin, end - begin, L"ENTER") ||
                settings_token_eq(value + begin, end - begin, L"ESCAPE") ||
                settings_token_eq(value + begin, end - begin, L"TAB") ||
                settings_token_eq(value + begin, end - begin, L"INSERT") ||
                settings_token_eq(value + begin, end - begin, L"DELETE") ||
                settings_token_eq(value + begin, end - begin, L"HOME") ||
                settings_token_eq(value + begin, end - begin, L"END") ||
                settings_token_eq(value + begin, end - begin, L"PAGEUP") ||
                settings_token_eq(value + begin, end - begin, L"PAGEDOWN") ||
                settings_token_eq(value + begin, end - begin, L"ARROWUP") ||
                settings_token_eq(value + begin, end - begin, L"ARROWDOWN") ||
                settings_token_eq(value + begin, end - begin, L"ARROWLEFT") ||
                settings_token_eq(value + begin, end - begin, L"ARROWRIGHT") ||
                settings_token_eq(value + begin, end - begin, L"UP") ||
                settings_token_eq(value + begin, end - begin, L"DOWN") ||
                settings_token_eq(value + begin, end - begin, L"LEFT") ||
                settings_token_eq(value + begin, end - begin, L"RIGHT")) base = 1;
            if (end - begin >= 2 && end - begin <= 3 && (value[begin] == L'F' || value[begin] == L'f') &&
                value[begin + 1] >= L'1' && value[begin + 1] <= L'9') {
                for (k = begin + 1; k < end; ++k) {
                    if (value[k] < L'0' || value[k] > L'9') break;
                    fnum = fnum * 10 + (value[k] - L'0');
                }
                if (k == end && fnum >= 1 && fnum <= 24) base = 1;
            }
            if (!base) return FALSE;
            ++bases;
        }
        if (!value[end]) break;
        i = end + 1; begin = i;
    }
    return bases == 1 && modifiers <= 4;
}

static BOOL settings_patch_key(char *patch, DWORD cap, DWORD *at, BOOL *first, const WCHAR *key) {
    if (!*first && !home_json_append_char(patch, cap, at, ',')) return FALSE;
    *first = FALSE;
    return home_json_append_char(patch, cap, at, '"') && home_json_append_utf8(patch, cap, at, key)
        && home_json_append_char(patch, cap, at, '"') && home_json_append_char(patch, cap, at, ':');
}

static BOOL settings_patch_string(char *patch, DWORD cap, DWORD *at, BOOL *first,
    const WCHAR *key, const WCHAR *value) {
    return settings_patch_key(patch, cap, at, first, key) && home_json_append_char(patch, cap, at, '"')
        && home_json_append_utf8(patch, cap, at, value) && home_json_append_char(patch, cap, at, '"');
}

static BOOL settings_patch_bool(char *patch, DWORD cap, DWORD *at, BOOL *first,
    const WCHAR *key, BOOL value) {
    const char *text = value ? "true" : "false";
    DWORD i;
    if (!settings_patch_key(patch, cap, at, first, key)) return FALSE;
    for (i = 0; text[i]; ++i) if (!home_json_append_char(patch, cap, at, text[i])) return FALSE;
    return TRUE;
}

static BOOL settings_patch_int(char *patch, DWORD cap, DWORD *at, BOOL *first,
    const WCHAR *key, int value) {
    char text[16]; int length, i;
    if (!settings_patch_key(patch, cap, at, first, key)) return FALSE;
    length = wsprintfA(text, "%d", value);
    for (i = 0; i < length; ++i) if (!home_json_append_char(patch, cap, at, text[i])) return FALSE;
    return TRUE;
}

static BOOL settings_make_patch(SETTINGS_STATE *state, char *patch, DWORD cap, DWORD *length) {
    DWORD at = 0; BOOL first = TRUE; WCHAR answerKey[CX_OPTIONS_SHORT_CAP];
    int top, right, width, threads, countdown, retry, theme, mode, asyncMode, failureMode;
    BOOL panel, collapsed, dialog, submit, log, extension, answer, aiFallback, deepThinking, examSubmit, localCache;
    GetWindowTextW(state->answerKey, answerKey, CX_OPTIONS_SHORT_CAP);
    if (!settings_read_int(state->panelTop, 0, 10000, &top) ||
        !settings_read_int(state->panelRight, 0, 10000, &right) ||
        !settings_read_int(state->panelWidth, 320, 800, &width) ||
        !settings_read_int(state->answerThreads, 1, 4, &threads) ||
        !settings_read_int(state->answerCountdown, 0, 3600, &countdown) ||
        !settings_read_int(state->answerRetry, 0, 20, &retry)) {
        settings_set_status(state, L"数值超出范围：位置 0-10000、宽度 320-800、线程 1-4、倒计时 0-3600、重试 0-20。");
        return FALSE;
    }
    if (!settings_shortcut_valid(answerKey)) {
        settings_set_status(state, L"答题快捷键格式无效，需包含一个基础按键，可组合 Ctrl/Alt/Shift/Win。");
        return FALSE;
    }
    theme = (int)SendMessageW(state->panelTheme, CB_GETCURSEL, 0, 0);
    mode = (int)SendMessageW(state->answerMode, CB_GETCURSEL, 0, 0);
    asyncMode = (int)SendMessageW(state->asyncSearch, CB_GETCURSEL, 0, 0);
    failureMode = (int)SendMessageW(state->aiFailure, CB_GETCURSEL, 0, 0);
    if (theme < 0 || theme > 2 || mode < 0 || mode > 1 || asyncMode < 0 || asyncMode > 1 || failureMode < 0 || failureMode > 1) {
        settings_set_status(state, L"面板主题或答题模式无效。"); return FALSE;
    }
    panel = SendMessageW(state->panelEnabled, BM_GETCHECK, 0, 0) == BST_CHECKED;
    collapsed = SendMessageW(state->panelCollapsed, BM_GETCHECK, 0, 0) == BST_CHECKED;
    dialog = SendMessageW(state->answerDialog, BM_GETCHECK, 0, 0) == BST_CHECKED;
    submit = SendMessageW(state->autoSubmit, BM_GETCHECK, 0, 0) == BST_CHECKED;
    log = !state->home->options->noDiskWrite && SendMessageW(state->logEnabled, BM_GETCHECK, 0, 0) == BST_CHECKED;
    extension = SendMessageW(state->extensionEnabled, BM_GETCHECK, 0, 0) == BST_CHECKED;
    answer = SendMessageW(state->enableAnswer, BM_GETCHECK, 0, 0) == BST_CHECKED;
    aiFallback = SendMessageW(state->aiFallback, BM_GETCHECK, 0, 0) == BST_CHECKED;
    deepThinking = SendMessageW(state->deepThinking, BM_GETCHECK, 0, 0) == BST_CHECKED;
    examSubmit = SendMessageW(state->examAutoSubmit, BM_GETCHECK, 0, 0) == BST_CHECKED;
    localCache = SendMessageW(state->localCache, BM_GETCHECK, 0, 0) == BST_CHECKED;
    patch[0] = 0;
    if (!home_json_append_char(patch, cap, &at, '{') ||
        !settings_patch_bool(patch, cap, &at, &first, L"common.settings.extension-enabled", extension) ||
        !settings_patch_bool(patch, cap, &at, &first, L"cx.new.study.enableAnswer", answer) ||
        !settings_patch_bool(patch, cap, &at, &first, L"cx.new.study.enableAIFallbackAnswer", aiFallback) ||
        !settings_patch_bool(patch, cap, &at, &first, L"cx.new.study.useAsyncTikuSearch", asyncMode == 0) ||
        !settings_patch_bool(patch, cap, &at, &first, L"cx.new.study.deepThinking", deepThinking) ||
        !settings_patch_string(patch, cap, &at, &first, L"cx.new.study.aiFallbackFailureAction", failureMode == 0 ? L"pause" : L"skip") ||
        !settings_patch_bool(patch, cap, &at, &first, L"cx.new.study.enableExamAutoSubmit", examSubmit) ||
        !settings_patch_bool(patch, cap, &at, &first, L"cx.new.study.enableLocalQuestionCache", localCache) ||
        !settings_patch_bool(patch, cap, &at, &first, L"common.settings.windows-panel-enabled", panel) ||
        !settings_patch_bool(patch, cap, &at, &first, L"common.settings.windows-panel-collapsed", collapsed) ||
        !settings_patch_int(patch, cap, &at, &first, L"common.settings.windows-panel-top", top) ||
        !settings_patch_int(patch, cap, &at, &first, L"common.settings.windows-panel-right", right) ||
        !settings_patch_int(patch, cap, &at, &first, L"common.settings.windows-panel-width", width) ||
        !settings_patch_string(patch, cap, &at, &first, L"common.settings.windows-panel-theme",
            theme == 1 ? L"blue" : theme == 2 ? L"green" : L"pink") ||
        !settings_patch_string(patch, cap, &at, &first, L"common.settings.windows-answer-mode", mode == 1 ? L"manual" : L"auto") ||
        !settings_patch_string(patch, cap, &at, &first, L"common.settings.windows-answer-key", answerKey) ||
        !settings_patch_int(patch, cap, &at, &first, L"common.settings.windows-answer-threads", threads) ||
        !settings_patch_bool(patch, cap, &at, &first, L"common.settings.windows-show-answer-dialog", dialog) ||
        !settings_patch_int(patch, cap, &at, &first, L"common.settings.windows-answer-countdown", countdown) ||
        !settings_patch_int(patch, cap, &at, &first, L"common.settings.windows-answer-retry", retry) ||
        !settings_patch_bool(patch, cap, &at, &first, L"common.settings.windows-auto-submit", submit) ||
        !settings_patch_bool(patch, cap, &at, &first, L"common.settings.windows-log-enabled", log) ||
        !home_json_append_char(patch, cap, &at, '}')) return FALSE;
    *length = at; return TRUE;
}

static BOOL settings_populate(SETTINGS_STATE *state) {
    char *json; JT *tokens; DWORD length = 0; int count, value; WCHAR text[32], wide[CX_OPTIONS_SHORT_CAP];
    CX_OPTIONS *options = state->home->options; BOOL panel = options->panelEnabled, collapsed = options->panelCollapsed;
    BOOL dialog = options->showAnswerDialog, submit = options->autoSubmit, log = options->logFileEnabled && !options->noDiskWrite;
    BOOL extension = options->extensionEnabled, answer = TRUE, aiFallback = TRUE, asyncSearch = TRUE;
    BOOL deepThinking = FALSE, examSubmit = FALSE, localCache = TRUE;
    int failureMode = 0;
    int top = options->panelTop, right = options->panelRight, width = options->panelWidth;
    int threads = options->answerThreads, countdown = options->answerCountdown, retry = options->answerRetry;
    BOOL autoMode = options->answerModeAuto; home_copy(wide, CX_OPTIONS_SHORT_CAP, options->answerKey);
    json = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_OPTIONS_JSON_CAP);
    tokens = (JT *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 8192 * sizeof(JT));
    if (json && tokens && home_build_settings(state->home, &state->value, json, CX_OPTIONS_JSON_CAP, &length, NULL, 0)) {
        count = jparse(json, (int)length, tokens, 8192);
        if (count > 0 && tokens[0].type == '{') {
#define SETTINGS_READ_BOOL(key, target) do { value = jkey(json, tokens, 0, key); if (value >= 0) (target) = jeq(json, tokens, value, "true"); } while (0)
#define SETTINGS_READ_INT(key, target) do { value = jkey(json, tokens, 0, key); if (value >= 0) (target) = jint(json, tokens, value, (target)); } while (0)
            SETTINGS_READ_BOOL("common.settings.extension-enabled", extension);
            SETTINGS_READ_BOOL("cx.new.study.enableAnswer", answer);
            SETTINGS_READ_BOOL("cx.new.study.enableAIFallbackAnswer", aiFallback);
            SETTINGS_READ_BOOL("cx.new.study.useAsyncTikuSearch", asyncSearch);
            SETTINGS_READ_BOOL("cx.new.study.deepThinking", deepThinking);
            SETTINGS_READ_BOOL("cx.new.study.enableExamAutoSubmit", examSubmit);
            SETTINGS_READ_BOOL("cx.new.study.enableLocalQuestionCache", localCache);
            SETTINGS_READ_BOOL("common.settings.windows-panel-enabled", panel);
            SETTINGS_READ_BOOL("common.settings.windows-panel-collapsed", collapsed);
            SETTINGS_READ_BOOL("common.settings.windows-show-answer-dialog", dialog);
            SETTINGS_READ_BOOL("common.settings.windows-auto-submit", submit);
            SETTINGS_READ_BOOL("common.settings.windows-log-enabled", log);
            SETTINGS_READ_INT("common.settings.windows-panel-top", top);
            SETTINGS_READ_INT("common.settings.windows-panel-right", right);
            SETTINGS_READ_INT("common.settings.windows-panel-width", width);
            SETTINGS_READ_INT("common.settings.windows-answer-threads", threads);
            SETTINGS_READ_INT("common.settings.windows-answer-countdown", countdown);
            SETTINGS_READ_INT("common.settings.windows-answer-retry", retry);
            value = jkey(json, tokens, 0, "common.settings.windows-answer-mode");
            if (value >= 0) { if (jwstr(json, tokens, value, text, 32)) autoMode = lstrcmpiW(text, L"manual") != 0; }
            value = jkey(json, tokens, 0, "common.settings.windows-answer-key");
            if (value >= 0) jwstr(json, tokens, value, wide, CX_OPTIONS_SHORT_CAP);
            value = jkey(json, tokens, 0, "common.settings.windows-panel-theme");
            if (value >= 0 && jwstr(json, tokens, value, text, 32)) {
                SendMessageW(state->panelTheme, CB_SETCURSEL, lstrcmpiW(text, L"blue") == 0 ? 1 : lstrcmpiW(text, L"green") == 0 ? 2 : 0, 0);
            }
            value = jkey(json, tokens, 0, "cx.new.study.aiFallbackFailureAction");
            if (value >= 0 && jwstr(json, tokens, value, text, 32)) failureMode = lstrcmpiW(text, L"skip") == 0 ? 1 : 0;
#undef SETTINGS_READ_BOOL
#undef SETTINGS_READ_INT
        }
    }
    if (json) { SecureZeroMemory(json, CX_OPTIONS_JSON_CAP); HeapFree(GetProcessHeap(), 0, json); }
    if (tokens) HeapFree(GetProcessHeap(), 0, tokens);
    SendMessageW(state->panelEnabled, BM_SETCHECK, panel ? BST_CHECKED : BST_UNCHECKED, 0);
    SendMessageW(state->panelCollapsed, BM_SETCHECK, collapsed ? BST_CHECKED : BST_UNCHECKED, 0);
    SendMessageW(state->extensionEnabled, BM_SETCHECK, extension ? BST_CHECKED : BST_UNCHECKED, 0);
    SendMessageW(state->enableAnswer, BM_SETCHECK, answer ? BST_CHECKED : BST_UNCHECKED, 0);
    SendMessageW(state->aiFallback, BM_SETCHECK, aiFallback ? BST_CHECKED : BST_UNCHECKED, 0);
    SendMessageW(state->asyncSearch, CB_SETCURSEL, asyncSearch ? 0 : 1, 0);
    SendMessageW(state->deepThinking, BM_SETCHECK, deepThinking ? BST_CHECKED : BST_UNCHECKED, 0);
    SendMessageW(state->aiFailure, CB_SETCURSEL, failureMode, 0);
    SendMessageW(state->examAutoSubmit, BM_SETCHECK, examSubmit ? BST_CHECKED : BST_UNCHECKED, 0);
    SendMessageW(state->localCache, BM_SETCHECK, localCache ? BST_CHECKED : BST_UNCHECKED, 0);
    wsprintfW(text, L"%d", top); SetWindowTextW(state->panelTop, text);
    wsprintfW(text, L"%d", right); SetWindowTextW(state->panelRight, text);
    wsprintfW(text, L"%d", width); SetWindowTextW(state->panelWidth, text);
    wsprintfW(text, L"%d", threads); SetWindowTextW(state->answerThreads, text);
    wsprintfW(text, L"%d", countdown); SetWindowTextW(state->answerCountdown, text);
    wsprintfW(text, L"%d", retry); SetWindowTextW(state->answerRetry, text);
    SendMessageW(state->answerMode, CB_SETCURSEL, autoMode ? 0 : 1, 0);
    SetWindowTextW(state->answerKey, wide);
    SendMessageW(state->answerDialog, BM_SETCHECK, dialog ? BST_CHECKED : BST_UNCHECKED, 0);
    SendMessageW(state->autoSubmit, BM_SETCHECK, submit ? BST_CHECKED : BST_UNCHECKED, 0);
    SendMessageW(state->logEnabled, BM_SETCHECK, log ? BST_CHECKED : BST_UNCHECKED, 0);
    EnableWindow(state->logEnabled, !options->noDiskWrite);
    return TRUE;
}

static BOOL settings_read(SETTINGS_STATE *state) {
    char *buffers, *custom, *patch, *merged, *validation;
    DWORD patchLength = 0, mergedLength = 0, length = 0; int converted, wideLength;
    WCHAR error[256]; BOOL ok;
    GetWindowTextW(state->baseUrl, state->value.adapterBaseUrl, CX_HOME_ADAPTER_URL_CAP);
    GetWindowTextW(state->apiKey, state->value.apiKey, CX_HOME_API_KEY_CAP);
    buffers = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_OPTIONS_JSON_CAP * 4);
    if (!buffers) return FALSE;
    custom = buffers; patch = custom + CX_OPTIONS_JSON_CAP; merged = patch + CX_OPTIONS_JSON_CAP;
    validation = merged + CX_OPTIONS_JSON_CAP;
    error[0] = 0;
    if (!settings_make_patch(state, patch, CX_OPTIONS_JSON_CAP, &patchLength)) goto failed;
    converted = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, state->value.settingsJson, -1,
        custom, CX_OPTIONS_JSON_CAP, NULL, NULL);
    if (!converted || !cx_config_merge_settings(custom, (DWORD)converted - 1, patch, patchLength,
        merged, CX_OPTIONS_JSON_CAP, &mergedLength, error, 256)) {
        settings_set_status(state, error[0] ? error : L"共享设置无效"); goto failed;
    }
    wideLength = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, merged, (int)mergedLength,
        state->value.settingsJson, CX_HOME_SETTINGS_CAP - 1);
    if (wideLength <= 0 || wideLength >= CX_HOME_SETTINGS_CAP - 1) {
        settings_set_status(state, L"合并后的设置过长，无法保存。"); goto failed;
    }
    state->value.settingsJson[wideLength] = 0;
    error[0] = 0;
    ok = home_build_settings(state->home, &state->value, validation, CX_OPTIONS_JSON_CAP, &length, error, 256);
    if (!ok) { settings_set_status(state, error[0] ? error : L"共享设置无效"); goto failed; }
    if (SendMessageW(state->browser, CB_GETCURSEL, 0, 0) == 1) home_copy(state->browserKind, 16, L"chrome");
    else home_copy(state->browserKind, 16, L"edge");
    SecureZeroMemory(buffers, CX_OPTIONS_JSON_CAP * 4); HeapFree(GetProcessHeap(), 0, buffers);
    return TRUE;
failed:
    SecureZeroMemory(buffers, CX_OPTIONS_JSON_CAP * 4); HeapFree(GetProcessHeap(), 0, buffers); return FALSE;
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
        MulDiv(940, home_dpi, 96), MulDiv(540, home_dpi, 96), parent, NULL, home_instance, state);
    if (!state->window) { HeapFree(GetProcessHeap(), 0, state); return FALSE; }
    state->font = home_default_font;
    home_control(0, L"STATIC", L"tikuAdapter 地址", WS_CHILD | WS_VISIBLE, 24, 24, 120, 24, state->window, 0);
    state->baseUrl = home_control(WS_EX_CLIENTEDGE, L"EDIT", state->value.adapterBaseUrl, WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL, 150, 20, 760, 28, state->window, SETTINGS_BASE_URL);
    home_control(0, L"STATIC", L"API key", WS_CHILD | WS_VISIBLE, 24, 64, 120, 24, state->window, 0);
    state->apiKey = home_control(WS_EX_CLIENTEDGE, L"EDIT", state->value.apiKey, WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_PASSWORD, 150, 60, 760, 28, state->window, SETTINGS_API_KEY);
    home_control(0, L"STATIC", L"单独会话浏览器", WS_CHILD | WS_VISIBLE, 24, 104, 120, 24, state->window, 0);
    state->browser = home_control(0, L"COMBOBOX", L"", WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST, 150, 100, 260, 120, state->window, SETTINGS_BROWSER);
    SendMessageW(state->browser, CB_ADDSTRING, 0, (LPARAM)L"Microsoft Edge"); SendMessageW(state->browser, CB_ADDSTRING, 0, (LPARAM)L"Google Chrome");
    SendMessageW(state->browser, CB_SETCURSEL, lstrcmpiW(state->browserKind, L"chrome") == 0 ? 1 : 0, 0);
    home_control(0, L"STATIC", L"扩展考试设置（与悬浮面板同步）", WS_CHILD | WS_VISIBLE, 24, 140, 360, 24, state->window, 0);
    state->extensionEnabled = home_control(0, L"BUTTON", L"启用注入/扩展", WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX, 24, 164, 150, 26, state->window, SETTINGS_EXTENSION_ENABLED);
    state->enableAnswer = home_control(0, L"BUTTON", L"自动答题", WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX, 184, 164, 115, 26, state->window, SETTINGS_ENABLE_ANSWER);
    state->aiFallback = home_control(0, L"BUTTON", L"AI 兜底搜题", WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX, 309, 164, 135, 26, state->window, SETTINGS_AI_FALLBACK);
    state->deepThinking = home_control(0, L"BUTTON", L"深度思考", WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX, 454, 164, 105, 26, state->window, SETTINGS_DEEP_THINKING);
    state->asyncSearch = home_control(0, L"COMBOBOX", L"", WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST, 569, 162, 125, 90, state->window, SETTINGS_ASYNC_SEARCH);
    SendMessageW(state->asyncSearch, CB_ADDSTRING, 0, (LPARAM)L"异步搜题");
    SendMessageW(state->asyncSearch, CB_ADDSTRING, 0, (LPARAM)L"同步搜题");
    state->aiFailure = home_control(0, L"COMBOBOX", L"", WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST, 704, 162, 206, 90, state->window, SETTINGS_AI_FAILURE);
    SendMessageW(state->aiFailure, CB_ADDSTRING, 0, (LPARAM)L"AI 失败后停留当前页");
    SendMessageW(state->aiFailure, CB_ADDSTRING, 0, (LPARAM)L"AI 失败后继续后续流程");
    state->examAutoSubmit = home_control(0, L"BUTTON", L"考试自动交卷", WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX, 24, 202, 145, 26, state->window, SETTINGS_EXAM_AUTO_SUBMIT);
    state->localCache = home_control(0, L"BUTTON", L"本地题库缓存", WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX, 184, 202, 135, 26, state->window, SETTINGS_LOCAL_CACHE);
    home_control(0, L"STATIC", L"悬浮面板", WS_CHILD | WS_VISIBLE, 24, 240, 120, 24, state->window, 0);
    state->panelEnabled = home_control(0, L"BUTTON", L"显示面板", WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX, 24, 264, 130, 26, state->window, SETTINGS_PANEL_ENABLED);
    state->panelCollapsed = home_control(0, L"BUTTON", L"默认折叠", WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX, 170, 264, 130, 26, state->window, SETTINGS_PANEL_COLLAPSED);
    home_control(0, L"STATIC", L"Top", WS_CHILD | WS_VISIBLE, 325, 266, 40, 22, state->window, 0);
    state->panelTop = home_control(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL, 365, 262, 70, 27, state->window, SETTINGS_PANEL_TOP);
    home_control(0, L"STATIC", L"Right", WS_CHILD | WS_VISIBLE, 455, 266, 45, 22, state->window, 0);
    state->panelRight = home_control(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL, 500, 262, 70, 27, state->window, SETTINGS_PANEL_RIGHT);
    home_control(0, L"STATIC", L"Width", WS_CHILD | WS_VISIBLE, 590, 266, 45, 22, state->window, 0);
    state->panelWidth = home_control(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL, 635, 262, 70, 27, state->window, SETTINGS_PANEL_WIDTH);
    home_control(0, L"STATIC", L"主题", WS_CHILD | WS_VISIBLE, 725, 266, 35, 22, state->window, 0);
    state->panelTheme = home_control(0, L"COMBOBOX", L"", WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST, 765, 262, 145, 90, state->window, SETTINGS_PANEL_THEME);
    SendMessageW(state->panelTheme, CB_ADDSTRING, 0, (LPARAM)L"Pink");
    SendMessageW(state->panelTheme, CB_ADDSTRING, 0, (LPARAM)L"Blue");
    SendMessageW(state->panelTheme, CB_ADDSTRING, 0, (LPARAM)L"Green");
    home_control(0, L"STATIC", L"宿主答题调度", WS_CHILD | WS_VISIBLE, 24, 304, 160, 24, state->window, 0);
    state->answerMode = home_control(0, L"COMBOBOX", L"", WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST, 24, 328, 110, 90, state->window, SETTINGS_ANSWER_MODE);
    SendMessageW(state->answerMode, CB_ADDSTRING, 0, (LPARAM)L"自动答题");
    SendMessageW(state->answerMode, CB_ADDSTRING, 0, (LPARAM)L"快捷键答题");
    home_control(0, L"STATIC", L"答题快捷键", WS_CHILD | WS_VISIBLE, 155, 332, 90, 22, state->window, 0);
    state->answerKey = home_control(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL, 245, 328, 210, 27, state->window, SETTINGS_ANSWER_KEY);
    home_control(0, L"STATIC", L"线程数", WS_CHILD | WS_VISIBLE, 480, 332, 60, 22, state->window, 0);
    state->answerThreads = home_control(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL, 540, 328, 54, 27, state->window, SETTINGS_ANSWER_THREADS);
    state->answerDialog = home_control(0, L"BUTTON", L"显示答题弹窗", WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX, 615, 328, 140, 26, state->window, SETTINGS_ANSWER_DIALOG);
    state->autoSubmit = home_control(0, L"BUTTON", L"自动提交", WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX, 770, 328, 125, 26, state->window, SETTINGS_AUTO_SUBMIT);
    home_control(0, L"STATIC", L"倒计时（秒）", WS_CHILD | WS_VISIBLE, 24, 368, 90, 22, state->window, 0);
    state->answerCountdown = home_control(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL, 115, 364, 65, 27, state->window, SETTINGS_ANSWER_COUNTDOWN);
    home_control(0, L"STATIC", L"失败重试", WS_CHILD | WS_VISIBLE, 205, 368, 70, 22, state->window, 0);
    state->answerRetry = home_control(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL, 275, 364, 65, 27, state->window, SETTINGS_ANSWER_RETRY);
    state->logEnabled = home_control(0, L"BUTTON", L"写入宿主日志", WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX, 380, 364, 150, 26, state->window, SETTINGS_LOG_ENABLED);
    settings_populate(state);
    SendMessageW(state->baseUrl, EM_SETLIMITTEXT, CX_HOME_ADAPTER_URL_CAP - 1, 0);
    SendMessageW(state->apiKey, EM_SETLIMITTEXT, CX_HOME_API_KEY_CAP - 1, 0);
    SendMessageW(state->answerKey, EM_SETLIMITTEXT, CX_OPTIONS_SHORT_CAP - 1, 0);
    SendMessageW(state->panelTop, EM_SETLIMITTEXT, 5, 0); SendMessageW(state->panelRight, EM_SETLIMITTEXT, 5, 0);
    SendMessageW(state->panelWidth, EM_SETLIMITTEXT, 3, 0); SendMessageW(state->answerThreads, EM_SETLIMITTEXT, 1, 0);
    SendMessageW(state->answerCountdown, EM_SETLIMITTEXT, 4, 0); SendMessageW(state->answerRetry, EM_SETLIMITTEXT, 2, 0);
    state->status = home_control(0, L"STATIC", L"设置仅保留在当前进程。表单值会合并进共享设置；单独会话不会覆盖公共设置。", WS_CHILD | WS_VISIBLE, 24, 410, 886, 42, state->window, SETTINGS_STATUS);
    home_control(0, L"BUTTON", persist ? L"保存" : L"启动此会话", WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON, 670, 470, 110, 30, state->window, SETTINGS_SAVE);
    home_control(0, L"BUTTON", L"取消", WS_CHILD | WS_VISIBLE, 800, 470, 110, 30, state->window, SETTINGS_CANCEL);
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
        if (!home_apply_typed_settings(options, settings, length,
            state->error, 512)) { home_status(state, state->error); goto done; }
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
            /* 时机 1（141 §5.3）：cx_browser_start 成功 → 会话数 +1，立即上报。
               只有真拿到 session 才计数，失败路径不虚增。 */
            home_device_report(state);
        }
        cx_home_config_clear(&state->pendingConfig); home_buttons(state, TRUE); home_refresh_list(state);
        if (!state->operationOK) {
            home_status(state, state->error);
            if (state->closing && state->operation != HOME_EXIT) home_begin(state, HOME_EXIT, NULL, NULL);
            else state->closing = FALSE;
            return 0;
        }
        /* 时机 3（141 §5.3）：主动关闭单个会话成功 → 会话数 -1，立即上报。 */
        if (state->operation == HOME_CLOSE_SESSION) home_device_report(state);
        /* 时机 4（141 §5.3）：退出全部 → 归 0，且必须真的发出去（R7 回落）。
           HOME_EXIT 会销毁窗口，之后无法再走 HOME_DEVICE_DONE，所以同步发。 */
        if (state->operation == HOME_EXIT) home_device_flush_exit(state);
        if (state->operation == HOME_EXIT) { KillTimer(window, HOME_TIMER); DestroyWindow(window); return 0; }
        if (state->operation == HOME_UPDATE) {
            home_copy(state->error, 512, L"已校验在线扩展 "); home_append(state->error, 512, state->extensionVersion);
            home_append(state->error, 512, L"；新会话将获取当前发布版本。"); home_status(state, state->error);
        } else home_status(state, state->operation == HOME_CLOSE_SESSION ? L"已关闭并清理临时会话"
            : L"临时会话已启动；关闭浏览器窗口后资料会自动清理");
        home_refresh_status(state);
        if (state->closing) home_begin(state, HOME_EXIT, NULL, NULL);
        return 0;
    }
    if (message == WM_TIMER) { home_poll_sessions(state); return 0; }
    if (message == HOME_DEVICE_DONE) { home_device_settle(state); return 0; }
    if (message == WM_COMMAND && HIWORD(wParam) == BN_CLICKED) {
        CX_HOME_CONFIG *separate; WCHAR browser[16];
        if (state->worker && LOWORD(wParam) != HOME_EXIT) return 0;
        switch (LOWORD(wParam)) {
        case HOME_EDGE: home_begin(state, HOME_EDGE, L"auto", state->config); return 0;
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
    if (!home_register_class() || !home_prompt_register()) {
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
    home_control(0, L"BUTTON", L"新会话（Edge优先）", WS_CHILD | WS_VISIBLE, 24, 395, 150, 32, window, HOME_EDGE);
    home_control(0, L"BUTTON", L"单独配置会话", WS_CHILD | WS_VISIBLE, 182, 395, 120, 32, window, HOME_SEPARATE);
    home_control(0, L"BUTTON", L"关闭选中会话", WS_CHILD | WS_VISIBLE, 310, 395, 120, 32, window, HOME_CLOSE_SESSION);
    home_control(0, L"BUTTON", L"设置注入", WS_CHILD | WS_VISIBLE, 438, 395, 100, 32, window, HOME_SETTINGS);
    home_control(0, L"BUTTON", L"考试客户端", WS_CHILD | WS_VISIBLE, 544, 395, 100, 32, window, HOME_EXAM);
    home_control(0, L"BUTTON", L"退出", WS_CHILD | WS_VISIBLE, 650, 395, 52, 32, window, HOME_EXIT);
    home_control(0, L"BUTTON", L"账号 / API key", WS_CHILD | WS_VISIBLE, 24, 435, 150, 30, window, HOME_ACCOUNT);
    home_control(0, L"BUTTON", L"检查扩展更新", WS_CHILD | WS_VISIBLE, 185, 435, 150, 30, window, HOME_UPDATE);
    ShowWindow(window, SW_SHOW); ShowWindow(window, SW_SHOW); UpdateWindow(window); SetTimer(window, HOME_TIMER, 500, NULL);
    home_refresh_list(state);
    /*
       C4-1 + C4-2（141 §5.1 / R5）：
         1) 取宿主 device_id（没有就生成并写回 windows/data/config.json）；
         2) 立刻查一次 GET /api/user/device-quota —— 这一步同时完成「登记该槽位」，
            所以 exe 一启动就占 1 个，哪怕用户从不点「新会话」。
      两者都 fail-open：取不到 id 就不上报（只查配额），查不到配额只改状态栏文案。
    */
    {
        WCHAR configPath[CX_HOME_EXTENSION_PATH_CAP];
        WCHAR idError[256];
        configPath[0] = 0; idError[0] = 0;
        if (home_device_config_path(state, configPath, CX_HOME_EXTENSION_PATH_CAP)) {
            (void)cx_device_id_ensure(configPath, options->noDiskWrite, state->deviceId,
                CX_DEVICE_ID_CAP, idError, 256);
        }
        if (!state->deviceId[0] && idError[0]) home_device_notice(state, idError);
        home_refresh_status(state);
        home_device_kick(state, HOME_DEVICE_FETCH | (state->deviceId[0] ? HOME_DEVICE_REPORT : 0),
            home_open_sessions(state));
    }
    while ((got = GetMessageW(&message, NULL, 0, 0)) > 0) {
        if (!IsDialogMessageW(window, &message)) { TranslateMessage(&message); DispatchMessageW(&message); }
    }
    if (state->worker) { WaitForSingleObject(state->worker, INFINITE); CloseHandle(state->worker); state->worker = NULL; }
    /* 退出路径兜底：把 count=0 发出去（R7），再收设备线程与句柄。 */
    home_device_flush_exit(state);
    if (state->deviceWorker) { WaitForSingleObject(state->deviceWorker, INFINITE); CloseHandle(state->deviceWorker); state->deviceWorker = NULL; }
    if (state->deviceJob) { SecureZeroMemory(state->deviceJob, sizeof(*state->deviceJob)); HeapFree(GetProcessHeap(), 0, state->deviceJob); state->deviceJob = NULL; }
    for (i = 0; i < HOME_MAX_SESSIONS; ++i) if (state->sessions[i].session) cx_browser_destroy(state->sessions[i].session);
    if (state->pendingSession) cx_browser_destroy(state->pendingSession);
    if (IsWindow(window)) DestroyWindow(window);
    if (home_default_font) DeleteObject(home_default_font); home_default_font = NULL;
    SecureZeroMemory(state, sizeof(*state)); HeapFree(GetProcessHeap(), 0, state);
    cx_home_config_clear(config);
    if (got < 0) { if (error && errorCap) lstrcpynW(error, L"主页消息循环失败", (int)errorCap); return FALSE; }
    return TRUE;
}
