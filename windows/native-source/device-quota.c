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

static BOOL cx_config_read_file(const WCHAR *path, char **text, DWORD *length, BOOL *missing) {
    HANDLE file;
    DWORD size, got, i;
    char *buffer;
    if (text) *text = NULL;
    if (length) *length = 0;
    if (missing) *missing = FALSE;
    if (!path || !path[0] || !text || !length) return FALSE;
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        DWORD code = GetLastError();
        if (missing) *missing = code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND;
        return FALSE;
    }
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

    read = cx_config_read_file(configPath, &text, &length, NULL);
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

/* ---- Explicit ordinary host admission ----------------------------------- */

#define CX_ADMISSION_REPLY_CAP 4096
#define CX_ADMISSION_ADDRESS_CAP 4096
#define CX_ADMISSION_SCOPE_CAP 65
#define CX_ADMISSION_PATH_CAP 32768

typedef struct CX_ADMISSION_PENDING {
    WCHAR id[CX_DEVICE_ID_CAP];
    WCHAR instance[CX_DEVICE_INSTANCE_CAP];
    BOOL retried;
} CX_ADMISSION_PENDING;

typedef BOOL (WINAPI *CX_ADMISSION_HASH)(LPCWSTR, DWORD, void *,
    const BYTE *, DWORD, BYTE *, DWORD *);

static BOOL cx_admission_fail(WCHAR *error, DWORD cap, const WCHAR *message) {
    if (error && cap) lstrcpynW(error, message, (int)cap);
    return FALSE;
}

static BOOL cx_admission_ascii(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == ':';
}

static BOOL cx_admission_token_eq(const char *text, const JT *t, int index, const WCHAR *expected) {
    int i, length = lstrlenW(expected);
    if (index < 0 || t[index].type != 's' || t[index].end - t[index].start != length) return FALSE;
    for (i = 0; i < length; ++i)
        if ((WCHAR)(BYTE)text[t[index].start + i] != expected[i]) return FALSE;
    return TRUE;
}

static BOOL cx_admission_key_equal(const WCHAR *left, const WCHAR *right) {
    while (*left && *left == *right) { ++left; ++right; }
    return *left == *right;
}

/* Preserve detection of escaped/duplicate critical keys without accepting
   ambiguous spellings. Ordinary unrelated keys are not inspected or changed. */
static int cx_admission_member(const char *text, const JT *t, int object, const WCHAR *wanted) {
    WCHAR name[128];
    int i, found = -1;
    if (object < 0 || t[object].type != '{') return -2;
    for (i = object + 1; i < t[object].next; i = t[i + 1].next) {
        if (!jwstr(text, t, i, name, ARRAYSIZE(name)) || !cx_admission_key_equal(name, wanted)) continue;
        if (found >= 0 || !cx_admission_token_eq(text, t, i, wanted)) return -2;
        found = i + 1;
    }
    return found;
}

static BOOL cx_admission_read_id(const char *text, const JT *t, int index, WCHAR *out, DWORD cap) {
    int i, length;
    if (index < 0 || t[index].type != 's') return FALSE;
    length = t[index].end - t[index].start;
    if (length <= 0 || (DWORD)length >= cap) return FALSE;
    for (i = 0; i < length; ++i) {
        char c = text[t[index].start + i];
        if (!cx_admission_ascii(c)) return FALSE;
        out[i] = (WCHAR)c;
    }
    out[length] = 0;
    return TRUE;
}

static BOOL cx_admission_span_equal(const WCHAR *first, const WCHAR *last, const WCHAR *literal) {
    while (first < last && *literal && *first == *literal) { ++first; ++literal; }
    return first == last && *literal == 0;
}

static BOOL cx_admission_alnum(WCHAR ch) {
    return (ch >= L'a' && ch <= L'z') || (ch >= L'A' && ch <= L'Z') || (ch >= L'0' && ch <= L'9');
}

static BOOL cx_admission_dns_name(const WCHAR *first, const WCHAR *last) {
    const WCHAR *p, *label = first;
    if (first == last || last - first > 253) return FALSE;
    for (p = first; p < last; ++p) {
        if (*p == L'.') {
            if (p == label || p[-1] == L'-') return FALSE;
            label = p + 1;
        } else if ((!cx_admission_alnum(*p) && !(*p == L'-' && p != label)) || p - label >= 63) {
            return FALSE;
        }
    }
    return last != label && last[-1] != L'-';
}

typedef LONG (NTAPI *CX_ADMISSION_PARSE_IPV6)(PCWSTR, PCWSTR *, void *);

static BOOL cx_admission_ipv6(const WCHAR *first, const WCHAR *closingBracket) {
    const WCHAR *p = first, *end = NULL;
    USHORT address[8];
    HMODULE ntdll;
    CX_ADMISSION_PARSE_IPV6 parse;
    if (first == closingBracket) return FALSE;
    for (; p < closingBracket; ++p) {
        WCHAR ch = *p;
        if (!(ch == L':' || ch == L'.' || (ch >= L'0' && ch <= L'9') ||
            (ch >= L'a' && ch <= L'f') || (ch >= L'A' && ch <= L'F'))) return FALSE;
    }
    /* Numeric-only OS parser. Does not resolve a hostname or open transport. */
    ntdll = GetModuleHandleW(L"ntdll.dll");
    parse = ntdll ? (CX_ADMISSION_PARSE_IPV6)(void *)GetProcAddress(ntdll, "RtlIpv6StringToAddressW") : NULL;
    return parse && parse(first, &end, address) == 0 && end == closingBracket;
}

/* Admission is the only caller. The generic WinHTTP adapter remains
   unchanged; its TLS validation, redirect policy and path joining still apply. */
static BOOL cx_admission_base_allowed(const WCHAR *base) {
    const WCHAR *host, *tail, *authorityEnd, *path, *segment;
    DWORD length, digits, port;
    BOOL tls;
    if (!base) return FALSE;
    length = (DWORD)lstrlenW(base);
    if (!length || length >= CX_ADMISSION_ADDRESS_CAP) return FALSE;
    if (length > 8 && CompareStringOrdinal(base, 8, L"https://", 8, TRUE) == CSTR_EQUAL) {
        tls = TRUE; host = base + 8;
    } else if (length > 7 && CompareStringOrdinal(base, 7, L"http://", 7, TRUE) == CSTR_EQUAL) {
        tls = FALSE; host = base + 7;
    } else return FALSE;

    for (authorityEnd = host; *authorityEnd && *authorityEnd != L'/'; ++authorityEnd) { }
    if (*host == L'[') {
        for (tail = host + 1; tail < authorityEnd && *tail != L']'; ++tail) { }
        if (tail == authorityEnd) return FALSE;
        if (tls ? !cx_admission_ipv6(host + 1, tail) : !cx_admission_span_equal(host, tail + 1, L"[::1]"))
            return FALSE;
        ++tail;
    } else {
        for (tail = host; tail < authorityEnd && *tail != L':'; ++tail) { }
        if (tls ? !cx_admission_dns_name(host, tail) : !cx_admission_span_equal(host, tail, L"127.0.0.1"))
            return FALSE;
    }
    if (tail < authorityEnd) {
        if (*tail++ != L':' || tail == authorityEnd || *tail < L'1' || *tail > L'9') return FALSE;
        for (digits = port = 0; tail < authorityEnd; ++tail) {
            if (++digits > 5 || *tail < L'0' || *tail > L'9') return FALSE;
            port = port * 10 + (*tail - L'0');
        }
        if (port > 65535) return FALSE;
    }

    /* Only literal path segments; no userinfo, escapes, query, fragment,
       backslashes, repeated slashes or dot segments to reinterpret later. */
    path = authorityEnd;
    while (*path) {
        segment = ++path;
        while (*path && *path != L'/') {
            if (!cx_admission_alnum(*path) && *path != L'-' && *path != L'_' && *path != L'.' && *path != L'~')
                return FALSE;
            ++path;
        }
        if ((path == segment && *path) || cx_admission_span_equal(segment, path, L".") ||
            cx_admission_span_equal(segment, path, L"..")) return FALSE;
    }
    return TRUE; /* Existing adapter handles unambiguous API or reverse-proxy prefixes. */
}

static BOOL cx_admission_scope(const WCHAR *baseUrl, const WCHAR *key,
    WCHAR scope[CX_ADMISSION_SCOPE_CAP]) {
    static const WCHAR hex[] = L"0123456789abcdef";
    HMODULE library = NULL;
    CX_ADMISSION_HASH hash;
    BYTE digest[32];
    WCHAR *joined = NULL;
    DWORD a, b, bytes, i, digestLength = sizeof(digest);
    BOOL ok = FALSE;
    if (!baseUrl || !baseUrl[0] || !key || !key[0]) return FALSE;
    a = (DWORD)lstrlenW(baseUrl); b = (DWORD)lstrlenW(key);
    if (a >= CX_ADMISSION_ADDRESS_CAP || b >= CX_ADAPTER_TOKEN_CAP) return FALSE;
    for (i = 0; i < a; ++i) if (baseUrl[i] <= 0x20 || baseUrl[i] == 0x7f) return FALSE;
    for (i = 0; i < b; ++i) if (key[i] <= 0x20 || key[i] >= 0x7f) return FALSE;
    bytes = (a + b + 2) * sizeof(WCHAR);
    joined = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, bytes);
    if (!joined) goto done;
    lstrcpyW(joined, baseUrl);
    lstrcpyW(joined + a + 1, key);
    library = LoadLibraryExW(L"crypt32.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!library) goto done;
    hash = (CX_ADMISSION_HASH)(void *)GetProcAddress(library, "CryptHashCertificate2");
    if (!hash || !hash(L"SHA256", 0, NULL, (const BYTE *)joined, bytes, digest, &digestLength)
        || digestLength != sizeof(digest)) goto done;
    for (i = 0; i < sizeof(digest); ++i) {
        scope[i * 2] = hex[digest[i] >> 4];
        scope[i * 2 + 1] = hex[digest[i] & 15];
    }
    scope[CX_ADMISSION_SCOPE_CAP - 1] = 0;
    ok = TRUE;
done:
    if (library) FreeLibrary(library);
    if (joined) {
        SecureZeroMemory(joined, bytes);
        HeapFree(GetProcessHeap(), 0, joined);
    }
    SecureZeroMemory(digest, sizeof(digest));
    return ok;
}

/* An exclusive, delete-on-close sidecar serializes participants in this
   explicit flow for one config path. Never overwrite an existing sidecar. */
static HANDLE cx_admission_lock(const WCHAR *configPath) {
    static const WCHAR suffix[] = L".device-admission.lock";
    WCHAR *lockPath;
    DWORD length, used;
    HANDLE lock = INVALID_HANDLE_VALUE;
    lockPath = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, CX_ADMISSION_PATH_CAP * sizeof(WCHAR));
    if (!lockPath) return lock;
    length = GetFullPathNameW(configPath, CX_ADMISSION_PATH_CAP, lockPath, NULL);
    used = (DWORD)ARRAYSIZE(suffix);
    if (length && length < CX_ADMISSION_PATH_CAP && used <= CX_ADMISSION_PATH_CAP - length) {
        lstrcatW(lockPath, suffix);
        lock = CreateFileW(lockPath, GENERIC_READ | DELETE, 0, NULL, CREATE_NEW,
            FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, NULL);
    }
    HeapFree(GetProcessHeap(), 0, lockPath);
    return lock;
}

static BOOL cx_admission_load(const WCHAR *path, const WCHAR *scope,
    CX_ADMISSION_PENDING *pending, BOOL *resume) {
    char *text = NULL;
    JT *t = NULL;
    DWORD length = 0;
    BOOL missing = FALSE, ok = FALSE;
    int settings, id, state, retried, count;
    *resume = FALSE;
    if (!cx_config_read_file(path, &text, &length, &missing)) return missing;
    if (!length || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, (int)length, NULL, 0)) goto done;
    t = (JT *)HeapAlloc(GetProcessHeap(), 0, ((SIZE_T)length + 1) * sizeof(JT));
    if (!t) goto done;
    count = jparse(text, (int)length, t, (int)length + 1);
    if (count <= 0 || t[0].type != '{') goto done;
    settings = cx_admission_member(text, t, 0, L"settings");
    if (settings < -1 || (settings >= 0 && t[settings].type != '{')) goto done;
    if (settings >= 0) {
        id = cx_admission_member(text, t, settings, L"common.settings.device-id");
        if (id < -1 || (id >= 0 && !cx_admission_read_id(text, t, id, pending->id, ARRAYSIZE(pending->id)))) goto done;
    }
    state = cx_admission_member(text, t, 0, L"nativeDeviceAdmissionPending");
    if (state == -1 || (state >= 0 && t[state].type == 'p' && jeq(text, t, state, "null"))) {
        ok = TRUE; goto done;
    }
    if (state < 0 || t[state].type != '{' || t[state].count != 8 ||
        !cx_admission_token_eq(text, t, cx_admission_member(text, t, state, L"scope"), scope) ||
        !cx_admission_read_id(text, t, cx_admission_member(text, t, state, L"deviceId"), pending->id, ARRAYSIZE(pending->id)) ||
        !cx_admission_read_id(text, t, cx_admission_member(text, t, state, L"clientInstance"), pending->instance, ARRAYSIZE(pending->instance)))
        goto done;
    retried = cx_admission_member(text, t, state, L"retried");
    if (retried < 0 || t[retried].type != 'p' || (!jeq(text, t, retried, "true") && !jeq(text, t, retried, "false"))) goto done;
    pending->retried = jeq(text, t, retried, "true");
    *resume = TRUE; ok = TRUE;
done:
    if (t) HeapFree(GetProcessHeap(), 0, t);
    HeapFree(GetProcessHeap(), 0, text);
    return ok;
}

/* All wide fields here are already bounded, validated ASCII, and cannot
   require JSON escaping. Buffers below include worst-case fixed syntax. */
static void cx_admission_literal(char *out, DWORD *used, const char *text) {
    while (*text) out[(*used)++] = *text++;
}
static void cx_admission_field(char *out, DWORD *used, const WCHAR *text) {
    while (*text) out[(*used)++] = (char)*text++;
}
static BOOL cx_admission_save(const WCHAR *path, const WCHAR *scope, const CX_ADMISSION_PENDING *pending,
    BOOL publish, WCHAR *error, DWORD errorCap) {
    char patch[CX_DEVICE_ID_CAP + CX_DEVICE_INSTANCE_CAP + CX_ADMISSION_SCOPE_CAP + 192];
    DWORD n = 0;
    if (publish) {
        cx_admission_literal(patch, &n, "{\"settings\":{\"" CX_DEVICE_ID_KEY "\":\"");
        cx_admission_field(patch, &n, pending->id);
        cx_admission_literal(patch, &n, "\"},\"" CX_DEVICE_ADMISSION_PENDING_KEY "\":null}");
    } else {
        cx_admission_literal(patch, &n, "{\"" CX_DEVICE_ADMISSION_PENDING_KEY "\":{\"scope\":\"");
        cx_admission_field(patch, &n, scope);
        cx_admission_literal(patch, &n, "\",\"deviceId\":\"");
        cx_admission_field(patch, &n, pending->id);
        cx_admission_literal(patch, &n, "\",\"clientInstance\":\"");
        cx_admission_field(patch, &n, pending->instance);
        cx_admission_literal(patch, &n, pending->retried ? "\",\"retried\":true}}" : "\",\"retried\":false}}");
    }
    return cx_config_patch_device_admission_file(path, patch, n, error, errorCap);
}

/* Only the fixed existing endpoint and the exact native-host contract. */
static BOOL cx_admission_request(const WCHAR *base, const WCHAR *auth, const CX_ADMISSION_PENDING *pending,
    DWORD timeout, BOOL *conflict) {
    char json[CX_DEVICE_ID_CAP + CX_DEVICE_INSTANCE_CAP + 64];
    DWORD n = 0;
    CX_ADAPTER_REPLY reply = {0};
    JT t[64];
    int value;
    BOOL admitted = FALSE;
    *conflict = FALSE;
    cx_admission_literal(json, &n, "{\"deviceId\":\"");
    cx_admission_field(json, &n, pending->id);
    cx_admission_literal(json, &n, "\",\"clientInstance\":\"");
    cx_admission_field(json, &n, pending->instance);
    cx_admission_literal(json, &n, "\"}");
    json[n] = 0;
    if (!cx_adapter_request(base, L"POST", L"/api/user/device-admission", auth, json,
        timeout, CX_ADMISSION_REPLY_CAP, &reply, NULL, 0)) goto done;
    if ((reply.status != 200 && reply.status != 409) || !reply.body || !reply.length ||
        reply.length > CX_ADMISSION_REPLY_CAP ||
        !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, reply.body, (int)reply.length, NULL, 0) ||
        jparse(reply.body, (int)reply.length, t, ARRAYSIZE(t)) <= 0 || t[0].type != '{') goto done;
    if (reply.status == 409) {
        value = cx_admission_member(reply.body, t, 0, L"code");
        *conflict = cx_admission_token_eq(reply.body, t, value, L"DEVICE_ID_CONFLICT");
        goto done;
    }
    value = cx_admission_member(reply.body, t, 0, L"admitted");
    admitted = value >= 0 && t[value].type == 'p' && jeq(reply.body, t, value, "true")
        && cx_admission_token_eq(reply.body, t, cx_admission_member(reply.body, t, 0, L"deviceId"), pending->id);
done:
    cx_adapter_reply_free(&reply);
    return admitted;
}

BOOL cx_device_host_admit(const WCHAR *configPath, const WCHAR *baseUrl,
    const WCHAR *ordinaryApiKey, CX_DEVICE_HOST_MODE mode, BOOL noDiskWrite,
    DWORD timeoutMs, CX_DEVICE_HOST_CONSENT verifyConsent, void *consentContext,
    WCHAR *publishedId, DWORD cap, WCHAR *error, DWORD errorCap) {
    CX_ADMISSION_PENDING pending = {0};
    WCHAR scope[CX_ADMISSION_SCOPE_CAP], previousId[CX_DEVICE_ID_CAP], previousInstance[CX_DEVICE_INSTANCE_CAP];
    WCHAR *auth = NULL;
    HANDLE lock = INVALID_HANDLE_VALUE;
    BOOL resume, conflict, ok = FALSE;
    if (error && errorCap) error[0] = 0;
    if (noDiskWrite || mode != CX_DEVICE_HOST_ORDINARY || !configPath || !configPath[0]
        || !publishedId || cap < CX_DEVICE_ID_CAP)
        return cx_admission_fail(error, errorCap, L"普通设备登记需要可写配置及明确的普通宿主模式");
    if (!verifyConsent)
        return cx_admission_fail(error, errorCap, L"无法复核当前设备的协议确认");
    if (!cx_admission_base_allowed(baseUrl))
        return cx_admission_fail(error, errorCap, L"普通设备登记仅支持 HTTPS 或数字回环 HTTP");
    if (!cx_admission_scope(baseUrl, ordinaryApiKey, scope))
        return cx_admission_fail(error, errorCap, L"普通设备登记地址或凭据不可用");
    timeoutMs = timeoutMs ? timeoutMs : 8000;
    lock = cx_admission_lock(configPath);
    if (lock == INVALID_HANDLE_VALUE)
        return cx_admission_fail(error, errorCap, L"无法锁定普通设备登记配置，请稍后重试");
    if (!cx_admission_load(configPath, scope, &pending, &resume)) {
        cx_admission_fail(error, errorCap, L"设备登记配置无效，或待确认记录与当前普通凭据不匹配");
        goto done;
    }
    auth = cx_device_auth(ordinaryApiKey);
    if (!auth) { cx_admission_fail(error, errorCap, L"普通设备登记凭据不可用"); goto done; }
    if (!resume &&
        ((!pending.id[0] && !cx_device_uuid_v4(pending.id, ARRAYSIZE(pending.id))) ||
         !cx_device_instance_new(pending.instance, ARRAYSIZE(pending.instance)))) goto random_failed;
    if (!verifyConsent(pending.id, consentContext)) goto consent_failed;
    if (!resume && !cx_admission_save(configPath, scope, &pending, FALSE, error, errorCap)) goto done;
    if (!cx_admission_request(baseUrl, auth, &pending, timeoutMs, &conflict)) {
        if (!conflict || pending.retried) goto receipt_failed;
        lstrcpyW(previousId, pending.id);
        lstrcpyW(previousInstance, pending.instance);
        if (!cx_device_uuid_v4(pending.id, ARRAYSIZE(pending.id)) ||
            !cx_device_instance_new(pending.instance, ARRAYSIZE(pending.instance)) ||
            !lstrcmpW(previousId, pending.id) || !lstrcmpW(previousInstance, pending.instance)) goto random_failed;
        if (!verifyConsent(pending.id, consentContext)) goto consent_failed;
        pending.retried = TRUE;
        if (!cx_admission_save(configPath, scope, &pending, FALSE, error, errorCap)) goto done;
        if (!cx_admission_request(baseUrl, auth, &pending, timeoutMs, &conflict)) goto receipt_failed;
    }
    if (!cx_admission_save(configPath, scope, &pending, TRUE, error, errorCap)) goto done;
    lstrcpynW(publishedId, pending.id, CX_DEVICE_ID_CAP);
    ok = TRUE;
    goto done;
consent_failed:
    cx_admission_fail(error, errorCap, L"当前候选设备尚无有效协议确认");
    goto done;
random_failed:
    cx_admission_fail(error, errorCap, L"无法生成新的设备登记标识");
    goto done;
receipt_failed:
    cx_admission_fail(error, errorCap, L"普通设备登记未取得有效回执");
done:
    if (auth) {
        SecureZeroMemory(auth, (CX_ADAPTER_TOKEN_CAP + 8) * sizeof(WCHAR));
        HeapFree(GetProcessHeap(), 0, auth);
    }
    CloseHandle(lock);
    return ok;
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
