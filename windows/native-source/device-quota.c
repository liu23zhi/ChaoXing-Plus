#include "device-quota.h"
#include "adapter-account.h"
#include "config-store.h"
#include "json.h"

/*
   设备槽位客户端实现（141 §5/§6/§8）。

   设计约束（逐条对应任务书红线）：
   1. 本模块不提供任何「拦截」能力 —— 只有 cx_device_over_limit 这一个
      「该提醒吗」的判据，是否继续由界面层决定（R8）。
   2. 全部网络调用都是 fail-open：失败只写 error 字段，返回 FALSE，
      调用方必须继续本地流程（137 的 fail-open 约定）。
   3. 写盘一律走 cx_config_patch_file（config-store.c 的既有唯一配置写入路径），
      noDiskWrite 为 TRUE 时根本不调用它。
*/

/* ---- 随机源 -------------------------------------------------------------- */

typedef BOOLEAN (APIENTRY *CX_RTL_GEN_RANDOM)(PVOID, ULONG);

static CX_RTL_GEN_RANDOM cx_random_source(void) {
    static HMODULE module;
    static CX_RTL_GEN_RANDOM generate;
    if (!generate) {
        if (!module) module = LoadLibraryW(L"advapi32.dll");
        if (!module) return NULL;
        /* SystemFunction036 == RtlGenRandom。进程级一次性取址，与 package-launcher.c 同法。 */
        generate = (CX_RTL_GEN_RANDOM)(void *)GetProcAddress(module, "SystemFunction036");
    }
    return generate;
}

static BOOL cx_random_bytes(BYTE *out, DWORD length) {
    CX_RTL_GEN_RANDOM generate = cx_random_source();
    if (!generate || !out || !length) return FALSE;
    return generate(out, length) ? TRUE : FALSE;
}

BOOL cx_device_uuid_v4(WCHAR *out, DWORD cap) {
    static const WCHAR digits[] = L"0123456789abcdef";
    BYTE bytes[16];
    DWORD i, at = 0;
    /* 36 个字符 + NUL；少一个都不写，避免产生半截 UUID。 */
    if (!out || cap < 37) return FALSE;
    out[0] = 0;
    if (!cx_random_bytes(bytes, (DWORD)sizeof(bytes))) return FALSE;
    /* RFC 4122 §4.4：version 4，variant 10xx。 */
    bytes[6] = (BYTE)((bytes[6] & 0x0f) | 0x40);
    bytes[8] = (BYTE)((bytes[8] & 0x3f) | 0x80);
    for (i = 0; i < 16; ++i) {
        if (i == 4 || i == 6 || i == 8 || i == 10) out[at++] = L'-';
        out[at++] = digits[(bytes[i] >> 4) & 0x0f];
        out[at++] = digits[bytes[i] & 0x0f];
    }
    out[at] = 0;
    SecureZeroMemory(bytes, sizeof(bytes));
    return TRUE;
}

/* ---- JSON 取值 ----------------------------------------------------------- */

static BOOL cx_json_int(const char *text, const JT *tokens, int object, const char *key,
                        int *out, BOOL *found) {
    int value = jkey(text, tokens, object, key);
    if (found) *found = value >= 0;
    if (value < 0) return FALSE;
    if (out) *out = jint(text, tokens, value, 0);
    return TRUE;
}

/* 解析 {"settings":{"common.settings.device-id":"..."}, ...}。 */
static BOOL cx_config_device_id(const char *text, DWORD length, WCHAR *out, DWORD cap) {
    JT *tokens;
    int count, settings, value;
    BOOL ok = FALSE;
    if (!text || !length || !out || cap < 2) return FALSE;
    out[0] = 0;
    tokens = (JT *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 4096 * sizeof(JT));
    if (!tokens) return FALSE;
    count = jparse(text, (int)length, tokens, 4096);
    if (count > 0 && tokens[0].type == '{') {
        settings = jkey(text, tokens, 0, "settings");
        if (settings >= 0 && tokens[settings].type == '{') {
            value = jkey(text, tokens, settings, CX_DEVICE_ID_KEY);
            if (value >= 0 && tokens[value].type == 's') {
                ok = jwstr(text, tokens, value, out, (int)cap) && out[0] != 0;
            }
        }
    }
    HeapFree(GetProcessHeap(), 0, tokens);
    if (!ok) out[0] = 0;
    return ok;
}

static BOOL cx_config_read_file(const WCHAR *path, char **text, DWORD *length) {
    HANDLE file;
    DWORD size, got, i;
    char *buffer;
    if (text) *text = NULL;
    if (length) *length = 0;
    if (!path || !path[0] || !text || !length) return FALSE;
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    size = GetFileSize(file, NULL);
    if (size == INVALID_FILE_SIZE || size >= CX_CONFIG_JSON_CAP) { CloseHandle(file); return FALSE; }
    buffer = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)size + 3);
    if (!buffer) { CloseHandle(file); return FALSE; }
    if (!ReadFile(file, buffer, size, &got, NULL) || got != size) {
        HeapFree(GetProcessHeap(), 0, buffer); CloseHandle(file); return FALSE;
    }
    CloseHandle(file);
    buffer[got] = 0;
    /* 与 config.mjs 一致：容忍 UTF-8 BOM。
       注意：链接是 /NODEFAULTLIB（无 CRT），CopyMemory/MoveMemory 都可能展开成
       memmove 而被判未解析 —— 这里用显式字节搬运，零外部依赖。 */
    i = (got >= 3 && (BYTE)buffer[0] == 0xef && (BYTE)buffer[1] == 0xbb && (BYTE)buffer[2] == 0xbf) ? 3 : 0;
    if (i) {
        DWORD k;
        got -= i;
        for (k = 0; k < got; ++k) buffer[k] = buffer[k + i];
        buffer[got] = 0;
    }
    *text = buffer;
    *length = got;
    return TRUE;
}

/* ---- 路径 ----------------------------------------------------------------- */

#define CX_DEVICE_CWD_CAP 1024

BOOL cx_device_config_path(const WCHAR *explicitConfigPath, const WCHAR *dataDir,
                           WCHAR *out, DWORD cap) {
    DWORD used, i;
    if (!out || cap < 2) return FALSE;
    out[0] = 0;
    if (explicitConfigPath && explicitConfigPath[0]) {
        if ((DWORD)lstrlenW(explicitConfigPath) + 1 > cap) return FALSE;
        lstrcpynW(out, explicitConfigPath, (int)cap);
        return TRUE;
    }
    /* 标准布局优先：start-windows.cmd 先 cd 到仓库根，所以 cwd\windows\data\config.json
       正是 141 §5.1 指定的那份宿主配置。
       必须排在 dataDir 之前 —— dataDir 默认是 ".data"（宿主的**数据**目录），
       把 device_id 写进 .data\config.json 会偏离设计文档指定的位置。 */
    {
        WCHAR cwd[CX_DEVICE_CWD_CAP];
        DWORD cwdLength = GetCurrentDirectoryW(CX_DEVICE_CWD_CAP, cwd);
        static const WCHAR suffix[] = L"\\windows\\data\\config.json";
        DWORD suffixLength = (DWORD)(sizeof(suffix) / sizeof(suffix[0])) - 1;
        if (cwdLength && cwdLength < CX_DEVICE_CWD_CAP && cwdLength + suffixLength + 1 <= cap) {
            lstrcpynW(out, cwd, (int)cap);
            if (out[cwdLength - 1] == L'\\' || out[cwdLength - 1] == L'/') out[cwdLength - 1] = 0;
            lstrcatW(out, suffix);
            return TRUE;
        }
    }
    if (dataDir && dataDir[0]) {
        used = (DWORD)lstrlenW(dataDir);
        if (used + 12 > cap) return FALSE; /* "\config.json" 12 字符 + NUL */
        lstrcpynW(out, dataDir, (int)cap);
        i = used;
        if (out[i - 1] != L'\\' && out[i - 1] != L'/') out[i++] = L'\\';
        out[i] = 0;
        lstrcatW(out, L"config.json");
        return TRUE;
    }
    return FALSE;
}

/* ---- device_id ------------------------------------------------------------ */

static BOOL cx_device_write_id(const WCHAR *configPath, const WCHAR *deviceId,
                              WCHAR *error, DWORD errorCap) {
    char patch[CX_DEVICE_ID_CAP + 64];
    DWORD at = 0, i;
    patch[at++] = '{';
    patch[at++] = '"';
    for (i = 0; CX_DEVICE_ID_KEY[i]; ++i) patch[at++] = CX_DEVICE_ID_KEY[i];
    patch[at++] = '"';
    patch[at++] = ':';
    patch[at++] = '"';
    for (i = 0; deviceId[i] && at + 3 < (DWORD)sizeof(patch); ++i) patch[at++] = (char)deviceId[i];
    patch[at++] = '"';
    patch[at++] = '}';
    patch[at] = 0;
    /* 唯一写盘路径：config-store.c 的原子 patch（读-合并-临时文件-rename）。 */
    return cx_config_patch_file(configPath, patch, at, error, errorCap);
}

BOOL cx_device_id_ensure(const WCHAR *configPath, BOOL noDiskWrite,
                         WCHAR *out, DWORD cap, WCHAR *error, DWORD errorCap) {
    char *text = NULL;
    DWORD length = 0;
    WCHAR generated[CX_DEVICE_ID_CAP];
    BOOL read;
    if (error && errorCap) error[0] = 0;
    if (!out || cap < 2) return FALSE;
    out[0] = 0;
    generated[0] = 0;

    read = cx_config_read_file(configPath, &text, &length);
    if (read) {
        BOOL found = cx_config_device_id(text, length, out, cap);
        HeapFree(GetProcessHeap(), 0, text);
        if (found) return TRUE;
    }

    if (!cx_device_uuid_v4(generated, CX_DEVICE_ID_CAP)) {
        if (error && errorCap) lstrcpynW(error, L"无法生成设备标识（随机源不可用）", (int)errorCap);
        return FALSE;
    }
    /* --no-disk-write：只用本次进程内存里的 id，绝不落盘（与宿主不写盘约定一致）。 */
    if (!noDiskWrite) {
        if (!cx_device_write_id(configPath, generated, error, errorCap)) {
            /* 写失败不阻断：本次运行仍可用该 id，下次启动会重新生成。 */
            if (error && errorCap && !error[0])
                lstrcpynW(error, L"设备标识无法写入配置文件", (int)errorCap);
        }
    }
    if ((DWORD)lstrlenW(generated) + 1 > cap) return FALSE;
    lstrcpynW(out, generated, (int)cap);
    return TRUE;
}

BOOL cx_device_instance_new(WCHAR *out, DWORD cap) {
    /* 141 §4.3：每个会话一个新的实例标识，进 chrome.storage 后不跨会话复用。 */
    return cx_device_uuid_v4(out, cap);
}

/* ---- 会话数 --------------------------------------------------------------- */

int cx_device_sessions_clamp(int count) {
    if (count < 0) return 0;
    if (count > CX_DEVICE_MAX_SESSIONS) return CX_DEVICE_MAX_SESSIONS;
    return count;
}

/* ---- 配额解析 ------------------------------------------------------------- */

BOOL cx_device_quota_parse(const char *body, DWORD length, CX_DEVICE_QUOTA *quota) {
    JT *tokens;
    int count, value;
    BOOL ok = FALSE;
    if (!quota) return FALSE;
    quota->known = FALSE;
    quota->limit = 0;
    quota->used = 0;
    quota->available = -1;
    quota->limitSource[0] = 0;
    quota->error[0] = 0;
    if (!body || length < 2) {
        lstrcpynW(quota->error, L"设备配额响应为空", 256);
        return FALSE;
    }
    tokens = (JT *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 4096 * sizeof(JT));
    if (!tokens) {
        lstrcpynW(quota->error, L"内存不足", 256);
        return FALSE;
    }
    count = jparse(body, (int)length, tokens, 4096);
    if (count > 0 && tokens[0].type == '{') {
        BOOL haveLimit = cx_json_int(body, tokens, 0, "limit", &quota->limit, NULL);
        BOOL haveUsed = cx_json_int(body, tokens, 0, "used", &quota->used, NULL);
        BOOL haveAvailable = cx_json_int(body, tokens, 0, "available", &quota->available, NULL);
        value = jkey(body, tokens, 0, "limitSource");
        if (value >= 0 && tokens[value].type == 's')
            (void)jwstr(body, tokens, value, quota->limitSource, CX_DEVICE_LIMIT_SOURCE_CAP);
        if (haveLimit && haveUsed) {
            ok = TRUE;
            /* 服务端可能省略 available：按 141 §6.1 的定义补齐，limit=0 记 -1（不限）。
               必须在释放 tokens 之前判定「字段是否存在」，否则是 use-after-free。 */
            if (!haveAvailable)
                quota->available = quota->limit > 0
                    ? (quota->limit > quota->used ? quota->limit - quota->used : 0) : -1;
        }
    }
    HeapFree(GetProcessHeap(), 0, tokens);
    if (!ok) {
        quota->limit = 0; quota->used = 0; quota->available = -1;
        lstrcpynW(quota->error, L"设备配额响应格式无效", 256);
        return FALSE;
    }
    quota->known = TRUE;
    return TRUE;
}

/* ---- 网络 ----------------------------------------------------------------- */

static WCHAR *cx_device_auth(const WCHAR *apiKey) {
    WCHAR *auth;
    DWORD i;
    if (!apiKey || !apiKey[0] || (DWORD)lstrlenW(apiKey) >= CX_ADAPTER_TOKEN_CAP) return NULL;
    auth = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (CX_ADAPTER_TOKEN_CAP + 8) * sizeof(WCHAR));
    if (!auth) return NULL;
    lstrcpyW(auth, L"Bearer ");
    for (i = 0; apiKey[i]; ++i) auth[7 + i] = apiKey[i];
    auth[7 + i] = 0;
    return auth;
}

BOOL cx_device_quota_fetch(const WCHAR *baseUrl, const WCHAR *apiKey,
                           DWORD timeoutMs, CX_DEVICE_QUOTA *quota) {
    CX_ADAPTER_REPLY reply;
    WCHAR *auth;
    WCHAR error[256];
    BOOL ok;
    if (!quota) return FALSE;
    quota->known = FALSE;
    quota->limit = 0;
    quota->used = 0;
    quota->available = -1;
    quota->limitSource[0] = 0;
    quota->error[0] = 0;
    if (!baseUrl || !baseUrl[0] || !apiKey || !apiKey[0]) {
        lstrcpynW(quota->error, L"未配置题库服务地址或 API key", 256);
        return FALSE;
    }
    auth = cx_device_auth(apiKey);
    if (!auth) {
        lstrcpynW(quota->error, L"API key 为空或过长", 256);
        return FALSE;
    }
    error[0] = 0;
    ZeroMemory(&reply, sizeof(reply));
    /* GET 也是一次「登记」：服务端据此把宿主这个槽位记进绑定表（R5）。 */
    ok = cx_adapter_request(baseUrl, L"GET", L"/api/user/device-quota", auth, NULL,
        timeoutMs ? timeoutMs : 8000, 65536, &reply, error, 256);
    SecureZeroMemory(auth, (CX_ADAPTER_TOKEN_CAP + 8) * sizeof(WCHAR));
    HeapFree(GetProcessHeap(), 0, auth);
    if (!ok) {
        lstrcpynW(quota->error, error[0] ? error : L"设备配额请求失败", 256);
        cx_adapter_reply_free(&reply);
        return FALSE;
    }
    if (reply.status < 200 || reply.status >= 300) {
        if (reply.status == 404)
            lstrcpynW(quota->error, L"服务端未提供设备配额接口", 256);
        else if (reply.status == 401 || reply.status == 403)
            lstrcpynW(quota->error, L"API key 无效，无法读取设备配额", 256);
        else {
            WCHAR prefix[64];
            wsprintfW(prefix, L"设备配额请求被拒绝（HTTP %lu）", (unsigned long)reply.status);
            lstrcpynW(quota->error, prefix, 256);
        }
        cx_adapter_reply_free(&reply);
        return FALSE;
    }
    ok = cx_device_quota_parse(reply.body, reply.length, quota);
    cx_adapter_reply_free(&reply);
    return ok;
}

BOOL cx_device_sessions_report(const WCHAR *baseUrl, const WCHAR *apiKey,
                               const WCHAR *deviceId, int count, DWORD timeoutMs,
                               WCHAR *error, DWORD errorCap) {
    CX_ADAPTER_REPLY reply;
    WCHAR *auth;
    char json[CX_DEVICE_ID_CAP + 80];
    DWORD at = 0, i;
    int clamped;
    BOOL ok;
    if (error && errorCap) error[0] = 0;
    if (!baseUrl || !baseUrl[0] || !apiKey || !apiKey[0] || !deviceId || !deviceId[0]) {
        if (error && errorCap) lstrcpynW(error, L"缺少题库地址、API key 或设备标识", (int)errorCap);
        return FALSE;
    }
    clamped = cx_device_sessions_clamp(count);
    at = 0;
    json[at++] = '{';
    json[at++] = '"';
    lstrcpyA(json + at, "deviceId");
    at += 8;
    json[at++] = '"';
    json[at++] = ':';
    json[at++] = '"';
    for (i = 0; deviceId[i]; ++i) {
        if (at + 8 >= (DWORD)sizeof(json)) {
            if (error && errorCap) lstrcpynW(error, L"设备标识过长", (int)errorCap);
            return FALSE;
        }
        json[at++] = (char)deviceId[i];
    }
    json[at++] = '"';
    json[at++] = ',';
    json[at++] = '"';
    lstrcpyA(json + at, "count");
    at += 5;
    json[at++] = '"';
    json[at++] = ':';
    {
        char digits[8];
        int n = 0, value = clamped;
        if (value == 0) digits[n++] = '0';
        while (value > 0 && n < (int)sizeof(digits)) { digits[n++] = (char)('0' + value % 10); value /= 10; }
        while (n > 0) json[at++] = digits[--n];
    }
    json[at++] = '}';
    json[at] = 0;

    auth = cx_device_auth(apiKey);
    if (!auth) {
        if (error && errorCap) lstrcpynW(error, L"API key 为空或过长", (int)errorCap);
        return FALSE;
    }
    ZeroMemory(&reply, sizeof(reply));
    ok = cx_adapter_request(baseUrl, L"POST", L"/api/user/device-sessions", auth, json,
        timeoutMs ? timeoutMs : 8000, 16384, &reply, error, errorCap);
    SecureZeroMemory(auth, (CX_ADAPTER_TOKEN_CAP + 8) * sizeof(WCHAR));
    HeapFree(GetProcessHeap(), 0, auth);
    SecureZeroMemory(json, sizeof(json));
    if (!ok) {
        cx_adapter_reply_free(&reply);
        if (error && errorCap && !error[0]) lstrcpynW(error, L"会话数上报失败", (int)errorCap);
        return FALSE;
    }
    ok = reply.status >= 200 && reply.status < 300;
    if (!ok && error && errorCap) {
        WCHAR prefix[64];
        wsprintfW(prefix, L"会话数上报被拒绝（HTTP %lu）", (unsigned long)reply.status);
        lstrcpynW(error, prefix, (int)errorCap);
    }
    cx_adapter_reply_free(&reply);
    return ok;
}

/* ---- 判据与文案 ----------------------------------------------------------- */

BOOL cx_device_over_limit(const CX_DEVICE_QUOTA *quota) {
    /* 单一判据：已取到配额 + 上限有限 + 已用满。limit=0 恒不提醒（141 §9.3 豁免）。 */
    if (!quota || !quota->known) return FALSE;
    if (quota->limit <= 0) return FALSE;
    return quota->used >= quota->limit;
}

static void cx_device_append(WCHAR *out, DWORD cap, const WCHAR *value) {
    DWORD used;
    if (!out || !cap || !value) return;
    used = (DWORD)lstrlenW(out);
    if (used >= cap - 1) return;
    lstrcpynW(out + used, value, (int)(cap - used));
}

static void cx_device_append_int(WCHAR *out, DWORD cap, int value) {
    WCHAR digits[16];
    wsprintfW(digits, L"%d", value);
    cx_device_append(out, cap, digits);
}

BOOL cx_device_status_text(const CX_DEVICE_QUOTA *quota, int openSessions,
                           WCHAR *out, DWORD cap) {
    int sessions, occupied;
    if (!out || cap < 2) return FALSE;
    out[0] = 0;
    sessions = cx_device_sessions_clamp(openSessions);
    occupied = sessions > 0 ? sessions : 1; /* R5/R7：宿主自己恒占 1 */
    if (!quota || !quota->known) {
        cx_device_append(out, cap, L"可用设备：无法获取设备配额");
    } else {
        cx_device_append(out, cap, L"可用设备：");
        if (quota->limit <= 0) cx_device_append(out, cap, L"不限");
        else cx_device_append_int(out, cap, quota->available > 0 ? quota->available : 0);
        cx_device_append(out, cap, L" / ");
        if (quota->limit <= 0) cx_device_append(out, cap, L"不限");
        else cx_device_append_int(out, cap, quota->limit);
    }
    cx_device_append(out, cap, L"　本 exe 占用：");
    cx_device_append_int(out, cap, occupied);
    cx_device_append(out, cap, L" 个（");
    cx_device_append_int(out, cap, sessions);
    cx_device_append(out, cap, L" 个浏览器会话）");
    return TRUE;
}
