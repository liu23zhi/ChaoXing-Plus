#include "adapter-account.h"
#include "json.h"
#include <winhttp.h>
#include <wincrypt.h>
#include <bcrypt.h>
#include <wincodec.h>

/* WIC's converter accepts a double threshold; this linker marker needs no CRT. */
int _fltused = 0;

/* System networking, hashing and image components are loaded dynamically;
   the native executable needs no CRT or additional distributed DLL. */
typedef HINTERNET (WINAPI *PFN_WinHttpOpen)(LPCWSTR, DWORD, LPCWSTR, LPCWSTR, DWORD);
typedef HINTERNET (WINAPI *PFN_WinHttpConnect)(HINTERNET, LPCWSTR, INTERNET_PORT, DWORD);
typedef HINTERNET (WINAPI *PFN_WinHttpOpenRequest)(HINTERNET, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR *, DWORD);
typedef BOOL (WINAPI *PFN_WinHttpSetTimeouts)(HINTERNET, int, int, int, int);
typedef BOOL (WINAPI *PFN_WinHttpAddRequestHeaders)(HINTERNET, LPCWSTR, DWORD, DWORD);
typedef BOOL (WINAPI *PFN_WinHttpSendRequest)(HINTERNET, LPCWSTR, DWORD, LPVOID, DWORD, DWORD, DWORD_PTR);
typedef BOOL (WINAPI *PFN_WinHttpReceiveResponse)(HINTERNET, LPVOID);
typedef BOOL (WINAPI *PFN_WinHttpQueryHeaders)(HINTERNET, DWORD, LPCWSTR, LPVOID, LPDWORD, LPDWORD);
typedef BOOL (WINAPI *PFN_WinHttpReadData)(HINTERNET, LPVOID, DWORD, LPDWORD);
typedef BOOL (WINAPI *PFN_WinHttpCloseHandle)(HINTERNET);
typedef BOOL (WINAPI *PFN_WinHttpCrackUrl)(LPCWSTR, DWORD, DWORD, LPURL_COMPONENTS);
typedef BOOL (WINAPI *PFN_WinHttpSetOption)(HINTERNET, DWORD, LPVOID, DWORD);
typedef BOOL (WINAPI *PFN_CryptStringToBinaryW)(LPCWSTR, DWORD, DWORD, BYTE *, DWORD *, DWORD *, DWORD *);
typedef HRESULT (WINAPI *PFN_CoInitializeEx)(LPVOID, DWORD);
typedef void (WINAPI *PFN_CoUninitialize)(void);
typedef HRESULT (WINAPI *PFN_CoCreateInstance)(REFCLSID, LPUNKNOWN, DWORD, REFIID, LPVOID *);
typedef NTSTATUS (WINAPI *PFN_BCryptOpenAlgorithmProvider)(BCRYPT_ALG_HANDLE *, LPCWSTR, LPCWSTR, ULONG);
typedef NTSTATUS (WINAPI *PFN_BCryptGetProperty)(BCRYPT_HANDLE, LPCWSTR, PUCHAR, ULONG, ULONG *, ULONG);
typedef NTSTATUS (WINAPI *PFN_BCryptCreateHash)(BCRYPT_ALG_HANDLE, BCRYPT_HASH_HANDLE *, PUCHAR, ULONG, PUCHAR, ULONG, ULONG);
typedef NTSTATUS (WINAPI *PFN_BCryptHashData)(BCRYPT_HASH_HANDLE, PUCHAR, ULONG, ULONG);
typedef NTSTATUS (WINAPI *PFN_BCryptFinishHash)(BCRYPT_HASH_HANDLE, PUCHAR, ULONG, ULONG);
typedef NTSTATUS (WINAPI *PFN_BCryptDestroyHash)(BCRYPT_HASH_HANDLE);
typedef NTSTATUS (WINAPI *PFN_BCryptCloseAlgorithmProvider)(BCRYPT_ALG_HANDLE, ULONG);

typedef struct CX_WINHTTP_API {
    HMODULE module;
    PFN_WinHttpOpen open;
    PFN_WinHttpConnect connect;
    PFN_WinHttpOpenRequest openRequest;
    PFN_WinHttpSetTimeouts setTimeouts;
    PFN_WinHttpAddRequestHeaders addHeaders;
    PFN_WinHttpSendRequest send;
    PFN_WinHttpReceiveResponse receive;
    PFN_WinHttpQueryHeaders query;
    PFN_WinHttpReadData read;
    PFN_WinHttpCloseHandle close;
    PFN_WinHttpCrackUrl crack;
    PFN_WinHttpSetOption setOption;
} CX_WINHTTP_API;

static CX_WINHTTP_API g_http;
static INIT_ONCE g_httpOnce = INIT_ONCE_STATIC_INIT;
static INIT_ONCE g_imageOnce = INIT_ONCE_STATIC_INIT;
static INIT_ONCE g_hashOnce = INIT_ONCE_STATIC_INIT;
static HMODULE g_crypt32, g_ole32;
static PFN_CryptStringToBinaryW g_base64;
static PFN_CoInitializeEx g_coInitialize;
static PFN_CoUninitialize g_coUninitialize;
static PFN_CoCreateInstance g_coCreate;
static HMODULE g_bcrypt;
static PFN_BCryptOpenAlgorithmProvider g_bcryptOpen;
static PFN_BCryptGetProperty g_bcryptProperty;
static PFN_BCryptCreateHash g_bcryptCreate;
static PFN_BCryptHashData g_bcryptData;
static PFN_BCryptFinishHash g_bcryptFinish;
static PFN_BCryptDestroyHash g_bcryptDestroy;
static PFN_BCryptCloseAlgorithmProvider g_bcryptClose;

static DWORD cx_wlen(const WCHAR *text) { return text ? (DWORD)lstrlenW(text) : 0; }
static DWORD cx_alen(const char *text) { return text ? (DWORD)lstrlenA(text) : 0; }
static BOOL cx_mem_equal(const void *left, const void *right, DWORD length) {
    const BYTE *a = (const BYTE *)left, *b = (const BYTE *)right; DWORD i;
    for (i = 0; i < length; i++) if (a[i] != b[i]) return FALSE;
    return TRUE;
}

/*
 * cx_strip_api_prefix 把 `length` 长度的 URL 尾部若为 API 前缀则剥掉，返回新长度。
 *
 * 为什么需要它（2026-11-14 后端改名 /adapter-service → /api）：
 * 用户保存的 base URL 有两种历史形态（带旧前缀 / 不带前缀）。若不剥，
 * 拼接后会出现 https://host/adapter-service/api/... 这类双前缀，必然 404。
 * 两个前缀都要认：老用户存的是旧前缀，新用户可能存新前缀。
 *
 * 长度一律用 lstrlenW 现算，**不写死 16** —— 旧实现硬编码了 "/adapter-service"
 * 的字符数，改前缀时会静默算出错误位置。
 */
static DWORD cx_strip_api_prefix(const WCHAR *text, DWORD length) {
    DWORD legacy = cx_wlen(CX_ADAPTER_API_PREFIX_LEGACY);
    DWORD current = cx_wlen(CX_ADAPTER_API_PREFIX_NEW);
    if (text && length >= legacy &&
        cx_mem_equal(text + length - legacy, CX_ADAPTER_API_PREFIX_LEGACY, legacy * sizeof(WCHAR)))
        return length - legacy;
    if (text && length >= current &&
        cx_mem_equal(text + length - current, CX_ADAPTER_API_PREFIX_NEW, current * sizeof(WCHAR)))
        return length - current;
    return length;
}
static void cx_error(WCHAR *out, DWORD cap, const WCHAR *value) {
    if (out && cap) lstrcpynW(out, value, (int)cap);
}
static BOOL CALLBACK cx_init_http(PINIT_ONCE once, PVOID parameter, PVOID *context) {
    (void)once; (void)parameter; (void)context;
    if (!g_http.module) g_http.module = LoadLibraryW(L"winhttp.dll");
    if (!g_http.module) return FALSE;
#define CX_HTTP_LOAD(apiName, field) g_http.field = (PFN_WinHttp##apiName)GetProcAddress(g_http.module, "WinHttp" #apiName)
    CX_HTTP_LOAD(Open, open); CX_HTTP_LOAD(Connect, connect); CX_HTTP_LOAD(OpenRequest, openRequest);
    CX_HTTP_LOAD(SetTimeouts, setTimeouts); CX_HTTP_LOAD(AddRequestHeaders, addHeaders); CX_HTTP_LOAD(SendRequest, send);
    CX_HTTP_LOAD(ReceiveResponse, receive); CX_HTTP_LOAD(QueryHeaders, query); CX_HTTP_LOAD(ReadData, read);
    CX_HTTP_LOAD(CloseHandle, close); CX_HTTP_LOAD(CrackUrl, crack);
    CX_HTTP_LOAD(SetOption, setOption);
#undef CX_HTTP_LOAD
    return g_http.open && g_http.connect && g_http.openRequest && g_http.setTimeouts
        && g_http.addHeaders && g_http.send && g_http.receive && g_http.query
        && g_http.read && g_http.close && g_http.crack && g_http.setOption;
}
static BOOL cx_load_http(void) { return InitOnceExecuteOnce(&g_httpOnce, cx_init_http, NULL, NULL); }
static BOOL CALLBACK cx_init_image(PINIT_ONCE once, PVOID parameter, PVOID *context) {
    (void)once; (void)parameter; (void)context;
    if (!g_crypt32) g_crypt32 = LoadLibraryW(L"crypt32.dll");
    if (!g_ole32) g_ole32 = LoadLibraryW(L"ole32.dll");
    if (!g_base64 && g_crypt32) g_base64 = (PFN_CryptStringToBinaryW)GetProcAddress(g_crypt32, "CryptStringToBinaryW");
    if (!g_coInitialize && g_ole32) g_coInitialize = (PFN_CoInitializeEx)GetProcAddress(g_ole32, "CoInitializeEx");
    if (!g_coUninitialize && g_ole32) g_coUninitialize = (PFN_CoUninitialize)GetProcAddress(g_ole32, "CoUninitialize");
    if (!g_coCreate && g_ole32) g_coCreate = (PFN_CoCreateInstance)GetProcAddress(g_ole32, "CoCreateInstance");
    return g_base64 && g_coInitialize && g_coUninitialize && g_coCreate;
}
static BOOL cx_load_image(void) { return InitOnceExecuteOnce(&g_imageOnce, cx_init_image, NULL, NULL); }
static BOOL CALLBACK cx_init_hash(PINIT_ONCE once, PVOID parameter, PVOID *context) {
    (void)once; (void)parameter; (void)context;
    if (!g_bcrypt) g_bcrypt = LoadLibraryW(L"bcrypt.dll");
    if (!g_bcrypt) return FALSE;
    if (!g_bcryptOpen) g_bcryptOpen = (PFN_BCryptOpenAlgorithmProvider)GetProcAddress(g_bcrypt, "BCryptOpenAlgorithmProvider");
    if (!g_bcryptProperty) g_bcryptProperty = (PFN_BCryptGetProperty)GetProcAddress(g_bcrypt, "BCryptGetProperty");
    if (!g_bcryptCreate) g_bcryptCreate = (PFN_BCryptCreateHash)GetProcAddress(g_bcrypt, "BCryptCreateHash");
    if (!g_bcryptData) g_bcryptData = (PFN_BCryptHashData)GetProcAddress(g_bcrypt, "BCryptHashData");
    if (!g_bcryptFinish) g_bcryptFinish = (PFN_BCryptFinishHash)GetProcAddress(g_bcrypt, "BCryptFinishHash");
    if (!g_bcryptDestroy) g_bcryptDestroy = (PFN_BCryptDestroyHash)GetProcAddress(g_bcrypt, "BCryptDestroyHash");
    if (!g_bcryptClose) g_bcryptClose = (PFN_BCryptCloseAlgorithmProvider)GetProcAddress(g_bcrypt, "BCryptCloseAlgorithmProvider");
    return g_bcryptOpen && g_bcryptProperty && g_bcryptCreate && g_bcryptData && g_bcryptFinish && g_bcryptDestroy && g_bcryptClose;
}
static BOOL cx_load_hash(void) { return InitOnceExecuteOnce(&g_hashOnce, cx_init_hash, NULL, NULL); }
static BOOL cx_append_w(WCHAR *out, DWORD cap, DWORD *used, const WCHAR *text) {
    DWORD n = cx_wlen(text);
    if (!out || !used || !text || n >= cap - *used) return FALSE;
    CopyMemory(out + *used, text, (SIZE_T)n * sizeof(WCHAR)); *used += n; out[*used] = 0; return TRUE;
}
static BOOL cx_build_url(const WCHAR *base, const WCHAR *path, WCHAR *out, DWORD cap) {
    DWORD n, p;
    if (!base || !path || !out || cap < 2) return FALSE;
    n = cx_wlen(base); while (n && base[n - 1] == L'/') n--;
    n = cx_strip_api_prefix(base, n);
    p = 0; while (path[p] == L'/') p++;
    if (n + 1 + cx_wlen(path + p) >= cap) return FALSE;
    CopyMemory(out, base, (SIZE_T)n * sizeof(WCHAR)); out[n] = L'/';
    lstrcpyW(out + n + 1, path + p); return TRUE;
}
static BOOL cx_wide_utf8(const WCHAR *text, char **out, DWORD *length) {
    int n; char *value;
    if (!out || !length || !text) return FALSE; *out = NULL; *length = 0;
    n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text, -1, NULL, 0, NULL, NULL);
    if (n <= 0) return FALSE;
    value = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)n);
    if (!value || !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text, -1, value, n, NULL, NULL)) {
        if (value) HeapFree(GetProcessHeap(), 0, value); return FALSE;
    }
    *out = value; *length = (DWORD)n - 1; return TRUE;
}
static BOOL cx_json_string(char *out, DWORD cap, DWORD *used, const WCHAR *text) {
    char *utf8 = NULL; DWORD n = 0, i;
    if (!cx_wide_utf8(text, &utf8, &n)) return FALSE;
    if (*used + 2 >= cap) { HeapFree(GetProcessHeap(), 0, utf8); return FALSE; }
    out[(*used)++] = '"';
    for (i = 0; i < n; i++) {
        char c = utf8[i];
        if (c == '"' || c == '\\') { if (*used + 2 >= cap) goto failed; out[(*used)++] = '\\'; out[(*used)++] = c; }
        else if (c == '\r' || c == '\n' || c == '\t') { if (*used + 2 >= cap) goto failed; out[(*used)++] = '\\'; out[(*used)++] = c == '\r' ? 'r' : c == '\n' ? 'n' : 't'; }
        else if ((BYTE)c < 0x20) goto failed;
        else { if (*used + 1 >= cap) goto failed; out[(*used)++] = c; }
    }
    out[(*used)++] = '"'; out[*used] = 0; HeapFree(GetProcessHeap(), 0, utf8); return TRUE;
failed: HeapFree(GetProcessHeap(), 0, utf8); return FALSE;
}
static BOOL cx_json_pair(char *out, DWORD cap, DWORD *used, const char *key, const WCHAR *value, BOOL *first) {
    DWORD n = cx_alen(key), i;
    if (!*first) { if (*used + 1 >= cap) return FALSE; out[(*used)++] = ','; }
    if (*used + 1 >= cap) return FALSE; out[(*used)++] = '"';
    for (i = 0; i < n; i++) { if (*used + 1 >= cap) return FALSE; out[(*used)++] = key[i]; }
    if (*used + 2 >= cap) return FALSE; out[(*used)++] = '"'; out[(*used)++] = ':';
    if (!cx_json_string(out, cap, used, value)) return FALSE; *first = FALSE; return TRUE;
}
static BOOL cx_json_begin3(const char *a, const WCHAR *av, const char *b, const WCHAR *bv, const char *c, const WCHAR *cv, char **out, DWORD *length) {
    char *json = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 65536); DWORD used = 0; BOOL first = TRUE;
    if (!json || used + 1 >= 65536) { if (json) HeapFree(GetProcessHeap(), 0, json); return FALSE; }
    json[used++] = '{';
    if (!cx_json_pair(json, 65536, &used, a, av, &first) || !cx_json_pair(json, 65536, &used, b, bv, &first) || !cx_json_pair(json, 65536, &used, c, cv, &first) || used + 2 >= 65536) { if (json) HeapFree(GetProcessHeap(), 0, json); return FALSE; }
    json[used++] = '}'; json[used] = 0; *out = json; *length = used; return TRUE;
}
static BOOL cx_json_value(const char *key, const WCHAR *value, char **out, DWORD *length) {
    char *json = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 65536); DWORD used = 1; BOOL first = TRUE;
    if (!json) return FALSE; json[0] = '{';
    if (!cx_json_pair(json, 65536, &used, key, value, &first) || used + 2 >= 65536) { HeapFree(GetProcessHeap(), 0, json); return FALSE; }
    json[used++] = '}'; json[used] = 0; *out = json; *length = used; return TRUE;
}
static BOOL cx_json_token_create(char **out, DWORD *length) {
    char *json = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 65536); DWORD used = 1; BOOL first = TRUE;
    if (!json) return FALSE; json[0] = '{';
    if (!cx_json_pair(json, 65536, &used, "name", L"chaoxing_plus_native", &first)
        || !cx_json_pair(json, 65536, &used, "remark", L"原生客户端", &first)
        || used + 24 >= 65536) { HeapFree(GetProcessHeap(), 0, json); return FALSE; }
    { static const char tail[] = ",\"totalQuotaLimit\":0}"; DWORD tailLength = (DWORD)sizeof(tail) - 1; CopyMemory(json + used, tail, tailLength); used += tailLength; json[used] = 0; }
    *out = json; *length = used; return TRUE;
}
static BOOL cx_http_url(const WCHAR *base, const WCHAR *path, const WCHAR *method, const WCHAR *auth, const char *json, DWORD timeout, DWORD bodyLimit, CX_ADAPTER_REPLY *reply, WCHAR *error, DWORD errorCap) {
    WCHAR *buffers = NULL, *url, *host, *object, *extra, *headers, *authHeader; URL_COMPONENTS parts; HINTERNET session = NULL, conn = NULL, req = NULL; DWORD status = 0, statusSize = sizeof(status), used = 0, got, cap, flags = 0, disabled = WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_AUTHENTICATION; BYTE *body = NULL; BOOL ok = FALSE;
    if (reply) { reply->status = 0; reply->body = NULL; reply->length = 0; }
    if (error && errorCap) error[0] = 0;
    if (!reply || !method || !cx_load_http()) { cx_error(error, errorCap, L"扩展服务地址或请求参数无效。"); return FALSE; }
    buffers = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (8192 + 512 + 8192 + 2048 + 4608 + 4300) * sizeof(WCHAR));
    if (!buffers) { cx_error(error, errorCap, L"内存不足。"); return FALSE; }
    url = buffers; host = url + 8192; object = host + 512; extra = object + 8192; headers = extra + 2048; authHeader = headers + 4608;
    if (!cx_build_url(base, path, url, 8192)) { cx_error(error, errorCap, L"扩展服务地址或请求参数无效。"); goto done; }
    ZeroMemory(&parts, sizeof(parts)); parts.dwStructSize = sizeof(parts); parts.dwSchemeLength = (DWORD)-1; parts.dwHostNameLength = (DWORD)-1; parts.dwUrlPathLength = (DWORD)-1; parts.lpszHostName = host; parts.dwHostNameLength = 512; parts.lpszUrlPath = object; parts.dwUrlPathLength = 8192; parts.lpszExtraInfo = extra; parts.dwExtraInfoLength = 2048;
    if (!g_http.crack(url, 0, 0, &parts) || !parts.dwHostNameLength || !parts.dwUrlPathLength || parts.dwUserNameLength || parts.dwPasswordLength) { cx_error(error, errorCap, L"扩展服务地址解析失败。"); goto done; }
    used = parts.dwUrlPathLength; if (parts.dwExtraInfoLength && !cx_append_w(object, 8192, &used, extra)) { cx_error(error, errorCap, L"扩展服务查询参数过长。"); goto done; }
    if (parts.nScheme == INTERNET_SCHEME_HTTPS) flags = WINHTTP_FLAG_SECURE; else if (parts.nScheme != INTERNET_SCHEME_HTTP) { cx_error(error, errorCap, L"只支持 HTTP 或 HTTPS 扩展服务。"); goto done; }
    session = g_http.open(L"超星学习助手/0.1.0", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    conn = session ? g_http.connect(session, host, parts.nPort, 0) : NULL;
    req = conn ? g_http.openRequest(conn, method, object, NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags) : NULL;
    if (!session || !conn || !req || !g_http.setTimeouts(req, (int)timeout, (int)timeout, (int)timeout, (int)timeout)
        || !g_http.setOption(req, WINHTTP_OPTION_DISABLE_FEATURE, &disabled, sizeof(disabled))) { cx_error(error, errorCap, L"无法连接扩展服务。"); goto done; }
    used = 0; if (auth && *auth) { if (!cx_append_w(authHeader, 4300, &used, L"Authorization: ") || !cx_append_w(authHeader, 4300, &used, auth) || !cx_append_w(authHeader, 4300, &used, L"\r\n")) { cx_error(error, errorCap, L"鉴权信息过长。"); goto done; } }
    used = 0; headers[0] = 0; if (!cx_append_w(headers, 4608, &used, L"Accept: application/json\r\n") || !cx_append_w(headers, 4608, &used, L"Content-Type: application/json; charset=utf-8\r\n") || (auth && *auth && !cx_append_w(headers, 4608, &used, authHeader))) { cx_error(error, errorCap, L"请求头过长。"); goto done; }
    if (!g_http.addHeaders(req, headers, (DWORD)-1, WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE)) { cx_error(error, errorCap, L"设置请求头失败。"); goto done; }
    if (!g_http.send(req, WINHTTP_NO_ADDITIONAL_HEADERS, 0, (LPVOID)json, json ? cx_alen(json) : 0, json ? cx_alen(json) : 0, 0) || !g_http.receive(req, NULL)) { cx_error(error, errorCap, L"扩展服务请求失败或超时。"); goto done; }
    if (!g_http.query(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, NULL, &status, &statusSize, NULL)) { cx_error(error, errorCap, L"扩展服务返回状态未知。"); goto done; }
    cap = bodyLimit ? bodyLimit : (8UL * 1024UL * 1024UL); body = (BYTE *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)cap + 1); if (!body) { cx_error(error, errorCap, L"内存不足。"); goto done; }
    used = 0;
    for (;;) { if (!g_http.read(req, body + used, cap + 1 - used, &got)) { cx_error(error, errorCap, L"读取扩展服务响应失败。"); goto done; } if (!got) break; used += got; if (used > cap) { cx_error(error, errorCap, L"扩展服务响应过大。"); goto done; } }
    body[used] = 0; reply->status = status; reply->body = (char *)body; reply->length = used; body = NULL; ok = TRUE;
    if (status < 200 || status >= 300) cx_error(error, errorCap, L"扩展服务拒绝请求。");
done: if (body) HeapFree(GetProcessHeap(), 0, body); if (req) g_http.close(req); if (conn) g_http.close(conn); if (session) g_http.close(session); if (buffers) { SecureZeroMemory(buffers, (8192 + 512 + 8192 + 2048 + 4608 + 4300) * sizeof(WCHAR)); HeapFree(GetProcessHeap(), 0, buffers); } return ok;
}
BOOL cx_adapter_request(const WCHAR *baseUrl, const WCHAR *method, const WCHAR *path, const WCHAR *authorization, const char *json, DWORD timeoutMs, DWORD bodyLimit, CX_ADAPTER_REPLY *reply, WCHAR *error, DWORD errorCap) { return cx_http_url(baseUrl, path, method, authorization, json, timeoutMs ? timeoutMs : 10000, bodyLimit, reply, error, errorCap); }
void cx_adapter_reply_free(CX_ADAPTER_REPLY *reply) { if (reply && reply->body) HeapFree(GetProcessHeap(), 0, reply->body); if (reply) { reply->body = NULL; reply->length = 0; reply->status = 0; } }
void cx_adapter_account_clear(CX_ADAPTER_ACCOUNT *account) { if (account) { SecureZeroMemory(account, sizeof(*account)); account->accessTokenId = 0; } }

static BOOL cx_response_string(const CX_ADAPTER_REPLY *reply, const char *key, WCHAR *out, DWORD cap) { JT *tokens; int count, value; BOOL ok = FALSE; if (!reply || !reply->body || !out || cap < 1) return FALSE; out[0] = 0; tokens = (JT *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 4096 * sizeof(JT)); if (!tokens) return FALSE; count = jparse(reply->body, (int)reply->length, tokens, 4096); value = count > 0 ? jkey(reply->body, tokens, 0, key) : -1; if (value >= 0) ok = jwstr(reply->body, tokens, value, out, (int)cap); HeapFree(GetProcessHeap(), 0, tokens); return ok; }
static void cx_reply_error(const CX_ADAPTER_REPLY *reply, WCHAR *error, DWORD errorCap, const WCHAR *fallback) {
    WCHAR message[512];
    message[0] = 0;
    if (reply && reply->status >= 400 && cx_response_string(reply, "message", message, 512) && message[0]) cx_error(error, errorCap, message);
    else cx_error(error, errorCap, fallback);
}
BOOL cx_adapter_auth_settings(const WCHAR *baseUrl, CX_ADAPTER_AUTH_SETTINGS *settings, WCHAR *error, DWORD errorCap) {
    CX_ADAPTER_REPLY reply; WCHAR provider[32]; BOOL ok;
    if (!settings) { cx_error(error, errorCap, L"验证码配置状态无效。"); return FALSE; }
    ZeroMemory(settings, sizeof(*settings));
    /* The web client defaults to remote. Fail closed if the provider is omitted. */
    lstrcpyW(settings->captchaProvider, L"remote");
    ok = cx_adapter_request(baseUrl, L"GET", L"/api/public/register-status", NULL, NULL, 10000, 65536, &reply, error, errorCap);
    if (!ok || reply.status < 200 || reply.status >= 300) { if (ok) cx_reply_error(&reply, error, errorCap, L"读取服务端验证码配置失败。"); cx_adapter_reply_free(&reply); return FALSE; }
    if (!cx_response_string(&reply, "captchaProvider", provider, 32)) {
        cx_adapter_reply_free(&reply); cx_error(error, errorCap, L"服务端验证码配置格式无效；为避免使用错误验证码，未显示本地图验证码。"); return FALSE;
    }
    lstrcpynW(settings->captchaProvider, provider, 32);
    (void)cx_response_string(&reply, "captchaApiBaseUrl", settings->captchaApiBaseUrl, CX_ADAPTER_TOKEN_CAP);
    (void)cx_response_string(&reply, "captchaType", settings->captchaType, 64);
    cx_adapter_reply_free(&reply);
    return TRUE;
}
BOOL cx_adapter_captcha_begin(const WCHAR *baseUrl, CX_ADAPTER_CAPTCHA *captcha, WCHAR *error, DWORD errorCap) { CX_ADAPTER_REPLY reply; char *json; DWORD length; BOOL ok; if (!captcha) return FALSE; ZeroMemory(captcha, sizeof(*captcha)); if (!cx_json_value("scene", L"login_password", &json, &length)) { cx_error(error, errorCap, L"验证码请求编码失败。"); return FALSE; } ok = cx_adapter_request(baseUrl, L"POST", L"/api/public/captcha/challenge", NULL, json, 10000, 65536, &reply, error, errorCap); HeapFree(GetProcessHeap(), 0, json); if (!ok || reply.status < 200 || reply.status >= 300) { if (ok) cx_reply_error(&reply, error, errorCap, L"获取站内图形验证码失败。"); cx_adapter_reply_free(&reply); return FALSE; } ok = cx_response_string(&reply, "challengeId", captcha->challengeId, 128); { JT *t = (JT *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 4096 * sizeof(JT)); int n = t ? jparse(reply.body, (int)reply.length, t, 4096) : -1; int v = n > 0 ? jkey(reply.body, t, 0, "imageData") : -1; if (v < 0 || !t || !jstr(reply.body, t, v, captcha->imageData, CX_ADAPTER_CAPTCHA_IMAGE_CAP)) ok = FALSE; if (t) HeapFree(GetProcessHeap(), 0, t); } if (ok) (void)cx_response_string(&reply, "expiresAt", captcha->expiresAt, 64); cx_adapter_reply_free(&reply); if (!ok) cx_error(error, errorCap, L"验证码响应格式无效。"); return ok; }
BOOL cx_adapter_captcha_verify(const WCHAR *baseUrl, const WCHAR *challengeId, const WCHAR *answer, WCHAR *captchaToken, DWORD tokenCap, WCHAR *error, DWORD errorCap) { CX_ADAPTER_REPLY reply; char *json; DWORD length; BOOL ok; if (!captchaToken || !cx_json_begin3("challengeId", challengeId, "scene", L"login_password", "captchaCode", answer, &json, &length)) { cx_error(error, errorCap, L"验证码校验编码失败。"); return FALSE; } ok = cx_adapter_request(baseUrl, L"POST", L"/api/public/captcha/verify", NULL, json, 10000, 65536, &reply, error, errorCap); HeapFree(GetProcessHeap(), 0, json); if (!ok || reply.status < 200 || reply.status >= 300 || !cx_response_string(&reply, "captchaToken", captchaToken, tokenCap)) { if (ok) cx_reply_error(&reply, error, errorCap, L"验证码校验失败。"); else if (error && !error[0]) cx_error(error, errorCap, L"验证码校验失败。"); cx_adapter_reply_free(&reply); return FALSE; } cx_adapter_reply_free(&reply); return TRUE; }
BOOL cx_adapter_account_login(const WCHAR *baseUrl, const WCHAR *username, const WCHAR *password, const WCHAR *captchaToken, CX_ADAPTER_ACCOUNT *account, WCHAR *error, DWORD errorCap) { CX_ADAPTER_REPLY reply; char *json; DWORD length; BOOL ok; if (!account) { cx_error(error, errorCap, L"账号状态无效。"); return FALSE; } cx_adapter_account_clear(account); if (!cx_json_begin3("username", username, "password", password, "captchaToken", captchaToken, &json, &length)) { cx_error(error, errorCap, L"登录请求编码失败。"); return FALSE; } ok = cx_adapter_request(baseUrl, L"POST", L"/api/user/login", NULL, json, 15000, 65536, &reply, error, errorCap); SecureZeroMemory(json, length); HeapFree(GetProcessHeap(), 0, json); if (!ok || reply.status < 200 || reply.status >= 300 || !cx_response_string(&reply, "jwt", account->jwt, CX_ADAPTER_TOKEN_CAP)) { if (ok) cx_reply_error(&reply, error, errorCap, L"账号登录失败。"); else if (error && !error[0]) cx_error(error, errorCap, L"账号登录失败。"); cx_adapter_reply_free(&reply); cx_adapter_account_clear(account); return FALSE; } lstrcpynW(account->username, username ? username : L"", 256); cx_adapter_reply_free(&reply); return TRUE; }
static BOOL cx_find_token(const CX_ADAPTER_REPLY *reply, CX_ADAPTER_ACCOUNT *account) {
    JT *t; char *token; int count, i, status, value, id; BOOL ok = FALSE;
    if (!reply || !reply->body || !account) return FALSE;
    t = (JT *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 8192 * sizeof(JT));
    token = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_ADAPTER_TOKEN_CAP);
    if (!t || !token) goto done;
    count = jparse(reply->body, (int)reply->length, t, 8192);
    if (count > 0 && t[0].type == '[') {
        for (i = 1; i < t[0].next; i = t[i].next) {
            if (t[i].type != '{') continue;
            status = jkey(reply->body, t, i, "status"); value = jkey(reply->body, t, i, "tokenValue"); id = jkey(reply->body, t, i, "id");
            if (status >= 0 && value >= 0 && jeq(reply->body, t, status, "enabled") && jstr(reply->body, t, value, token, CX_ADAPTER_TOKEN_CAP)
                && token[0] && MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, token, -1, account->apiKey, CX_ADAPTER_TOKEN_CAP)) {
                account->accessTokenId = id >= 0 ? jint(reply->body, t, id, 0) : 0; ok = TRUE; break;
            }
        }
    }
done: if (token) { SecureZeroMemory(token, CX_ADAPTER_TOKEN_CAP); HeapFree(GetProcessHeap(), 0, token); } if (t) HeapFree(GetProcessHeap(), 0, t); return ok;
}
BOOL cx_adapter_account_token(const WCHAR *baseUrl, BOOL createIfMissing, CX_ADAPTER_ACCOUNT *account, WCHAR *error, DWORD errorCap) {
    CX_ADAPTER_REPLY reply; char *json; DWORD length; BOOL ok;
    if (!account || !account->jwt[0]) { cx_error(error, errorCap, L"尚未登录适配器账号。"); return FALSE; }
    account->apiKey[0] = 0; account->accessTokenId = 0;
    ok = cx_adapter_request(baseUrl, L"GET", L"/api/access-tokens", account->jwt, NULL, 15000, 262144, &reply, error, errorCap);
    if (!ok || reply.status < 200 || reply.status >= 300) { if (ok) cx_reply_error(&reply, error, errorCap, L"获取账号访问令牌失败。"); cx_adapter_reply_free(&reply); return FALSE; }
    ok = cx_find_token(&reply, account); cx_adapter_reply_free(&reply);
    if (ok) return TRUE;
    if (!createIfMissing) { cx_error(error, errorCap, L"账号密码登录已成功，但账号没有可用访问令牌。请勾选“没有访问令牌时创建原生客户端专用令牌”后重试，或先在服务端创建令牌。"); return FALSE; }
    if (!cx_json_token_create(&json, &length)) { cx_error(error, errorCap, L"令牌请求编码失败。"); return FALSE; }
    ok = cx_adapter_request(baseUrl, L"POST", L"/api/access-tokens", account->jwt, json, 15000, 65536, &reply, error, errorCap);
    SecureZeroMemory(json, length); HeapFree(GetProcessHeap(), 0, json);
    if (!ok || reply.status < 200 || reply.status >= 300 || !cx_response_string(&reply, "token", account->apiKey, CX_ADAPTER_TOKEN_CAP) || !account->apiKey[0]) {
        if (ok) cx_reply_error(&reply, error, errorCap, L"创建访问令牌失败。"); else if (error && !error[0]) cx_error(error, errorCap, L"创建访问令牌失败。");
        cx_adapter_reply_free(&reply); return FALSE;
    }
    cx_adapter_reply_free(&reply); return TRUE;
}
BOOL cx_adapter_key_check(const WCHAR *baseUrl, const WCHAR *apiKey, WCHAR *error, DWORD errorCap) {
    CX_ADAPTER_REPLY reply; WCHAR *auth; BOOL ok;
    if (!apiKey || !*apiKey || cx_wlen(apiKey) >= CX_ADAPTER_TOKEN_CAP) { cx_error(error, errorCap, L"API key 为空或过长。"); return FALSE; }
    auth = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (CX_ADAPTER_TOKEN_CAP + 8) * sizeof(WCHAR));
    if (!auth) { cx_error(error, errorCap, L"内存不足。"); return FALSE; }
    lstrcpyW(auth, L"Bearer "); lstrcpyW(auth + 7, apiKey);
    ok = cx_adapter_request(baseUrl, L"GET", L"/api/search/health", auth, NULL, 10000, 65536, &reply, error, errorCap);
    SecureZeroMemory(auth, (CX_ADAPTER_TOKEN_CAP + 8) * sizeof(WCHAR)); HeapFree(GetProcessHeap(), 0, auth);
    if (ok && (reply.status < 200 || reply.status >= 300)) cx_reply_error(&reply, error, errorCap, L"API key 无效或服务不可用。");
    ok = ok && reply.status >= 200 && reply.status < 300; cx_adapter_reply_free(&reply);
    if (!ok && error && !error[0]) cx_error(error, errorCap, L"API key 无效或服务不可用。"); return ok;
}

static BOOL cx_ascii_equal(const WCHAR *left, const WCHAR *right) {
    DWORD i, n = cx_wlen(left); if (!left || !right || n != cx_wlen(right)) return FALSE;
    for (i = 0; i < n; i++) { WCHAR a = left[i], b = right[i]; if (a >= L'A' && a <= L'Z') a += L'a' - L'A'; if (b >= L'A' && b <= L'Z') b += L'a' - L'A'; if (a != b) return FALSE; } return TRUE;
}
static BOOL cx_sha256(const BYTE *data, DWORD length, BYTE digest[32]) {
    BCRYPT_ALG_HANDLE algorithm = NULL; BCRYPT_HASH_HANDLE hash = NULL; PUCHAR object = NULL; ULONG objectLength = 0, digestLength = 0, result = 0; BOOL ok = FALSE;
    if (!data || !digest || !cx_load_hash()) return FALSE;
    if (g_bcryptOpen(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, 0) < 0
        || g_bcryptProperty(algorithm, BCRYPT_OBJECT_LENGTH, (PUCHAR)&objectLength, sizeof(objectLength), &result, 0) < 0
        || g_bcryptProperty(algorithm, BCRYPT_HASH_LENGTH, (PUCHAR)&digestLength, sizeof(digestLength), &result, 0) < 0
        || digestLength != 32 || !objectLength) goto done;
    object = (PUCHAR)HeapAlloc(GetProcessHeap(), 0, objectLength);
    if (!object || g_bcryptCreate(algorithm, &hash, object, objectLength, NULL, 0, 0) < 0
        || g_bcryptData(hash, (PUCHAR)data, length, 0) < 0
        || g_bcryptFinish(hash, digest, 32, 0) < 0) goto done;
    ok = TRUE;
done: if (hash) g_bcryptDestroy(hash); if (object) HeapFree(GetProcessHeap(), 0, object); if (algorithm) g_bcryptClose(algorithm, 0); return ok;
}
static BOOL cx_hex_digest(const BYTE digest[32], char out[65]) {
    static const char hex[] = "0123456789abcdef"; DWORD i; if (!digest || !out) return FALSE;
    for (i = 0; i < 32; i++) { out[i * 2] = hex[digest[i] >> 4]; out[i * 2 + 1] = hex[digest[i] & 15]; } out[64] = 0; return TRUE;
}
static BOOL cx_hex_equal(const char *left, const char *right) {
    DWORD i; if (!left || !right || cx_alen(left) != 64 || cx_alen(right) != 64) return FALSE;
    for (i = 0; i < 64; i++) { char a = left[i], b = right[i]; if (a >= 'A' && a <= 'F') a += 'a' - 'A'; if (a != b) return FALSE; } return TRUE;
}
static BOOL cx_extension_version(const WCHAR *value) {
    DWORD i = 0, parts = 0, digits, number;
    if (!value || !*value) return FALSE;
    for (;;) {
        digits = 0; number = 0;
        while (value[i] >= L'0' && value[i] <= L'9') {
            number = number * 10 + (DWORD)(value[i++] - L'0');
            if (++digits > 5 || number > 65535) return FALSE;
        }
        if (!digits || ++parts > 4) return FALSE;
        if (!value[i]) return TRUE;
        if (value[i++] != L'.') return FALSE;
    }
}
#define CX_EXTENSION_CACHE_MAGIC 0x43584543UL
#define CX_EXTENSION_CACHE_FORMAT 2UL
typedef struct CX_EXTENSION_CACHE_HEADER {
    DWORD magic;
    DWORD format;
    DWORD headerSize;
    DWORD packageSize;
    BYTE serviceIdentity[32];
    WCHAR source[8];
    WCHAR extensionVersion[128];
    char extensionId[65];
    char sha256[65];
} CX_EXTENSION_CACHE_HEADER;

static BOOL cx_cache_mkdirs(const WCHAR *directory) {
    WCHAR *path; DWORD length, i; DWORD attributes;
    if (!directory || !*directory) return FALSE;
    length = cx_wlen(directory);
    path = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (SIZE_T)(length + 2) * sizeof(WCHAR));
    if (!path) return FALSE;
    CopyMemory(path, directory, (SIZE_T)(length + 1) * sizeof(WCHAR));
    for (i = 0; i < length; i++) {
        if (path[i] != L'\\' && path[i] != L'/') continue;
        if (i == 0 || (i == 2 && path[1] == L':')) continue;
        path[i] = 0;
        if (*path) {
            attributes = GetFileAttributesW(path);
            if (attributes == INVALID_FILE_ATTRIBUTES && !CreateDirectoryW(path, NULL)
                && GetLastError() != ERROR_ALREADY_EXISTS) { HeapFree(GetProcessHeap(), 0, path); return FALSE; }
            if (attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY)) { HeapFree(GetProcessHeap(), 0, path); return FALSE; }
        }
        path[i] = L'\\';
    }
    attributes = GetFileAttributesW(path);
    if (attributes == INVALID_FILE_ATTRIBUTES && !CreateDirectoryW(path, NULL)
        && GetLastError() != ERROR_ALREADY_EXISTS) { HeapFree(GetProcessHeap(), 0, path); return FALSE; }
    if (attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY)) { HeapFree(GetProcessHeap(), 0, path); return FALSE; }
    HeapFree(GetProcessHeap(), 0, path); return TRUE;
}

static BOOL cx_cache_paths(const WCHAR *cacheDir, const WCHAR *source, WCHAR **path, WCHAR **temp) {
    const WCHAR *name; DWORD directoryLength, needed; WCHAR *result; WCHAR suffix[48];
    if (path) *path = NULL; if (temp) *temp = NULL;
    if (!cacheDir || !*cacheDir || !source || !path || !temp) return FALSE;
    name = cx_ascii_equal(source, L"edge") ? L"edge.crxcache" : L"chrome.crxcache";
    directoryLength = cx_wlen(cacheDir); needed = directoryLength + 1 + cx_wlen(name) + 48;
    result = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (SIZE_T)needed * sizeof(WCHAR) * 2);
    if (!result) return FALSE;
    lstrcpyW(result, cacheDir); if (directoryLength && result[directoryLength - 1] != L'\\') lstrcatW(result, L"\\"); lstrcatW(result, name);
    *path = result;
    *temp = result + needed;
    wsprintfW(suffix, L".tmp.%08lx.%08lx", GetCurrentProcessId(), GetTickCount());
    lstrcpyW(*temp, result); lstrcatW(*temp, suffix);
    return TRUE;
}

static BOOL cx_wide_terminated(const WCHAR *value, DWORD capacity) {
    DWORD i; if (!value || !capacity) return FALSE;
    for (i = 0; i < capacity; i++) if (!value[i]) return TRUE;
    return FALSE;
}
static DWORD cx_bounded_alen(const char *value, DWORD capacity) {
    DWORD i; if (!value) return capacity;
    for (i = 0; i < capacity; i++) if (!value[i]) return i;
    return capacity;
}
static BOOL cx_identity_append_folded(WCHAR *out, DWORD cap, DWORD *used, const WCHAR *text, DWORD length) {
    DWORD i;
    if (!out || !used || !text || length >= cap - *used) return FALSE;
    for (i = 0; i < length; i++) {
        WCHAR c = text[i];
        if (c >= L'A' && c <= L'Z') c += L'a' - L'A';
        out[(*used)++] = c;
    }
    out[*used] = 0;
    return TRUE;
}
static BOOL cx_extension_service_identity(const WCHAR *baseUrl, BYTE identity[32]) {
    enum { SCHEME_CAP = 32, HOST_CAP = 512, PATH_CAP = 8192, EXTRA_CAP = 1024, CREDENTIAL_CAP = 512 };
    WCHAR *partsBuffer = NULL, *scheme, *host, *path, *extra, *username, *password;
    WCHAR *canonical = NULL, portText[24]; URL_COMPONENTS parts; char *utf8 = NULL;
    DWORD urlLength, pathLength, canonicalCap, used = 0, utf8Length = 0, i; BOOL ok = FALSE;
    if (!baseUrl || !*baseUrl || !identity || !cx_load_http()) return FALSE;
    urlLength = cx_wlen(baseUrl);
    if (!urlLength || urlLength >= PATH_CAP) return FALSE;
    partsBuffer = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
        (SCHEME_CAP + HOST_CAP + PATH_CAP + EXTRA_CAP + CREDENTIAL_CAP * 2) * sizeof(WCHAR));
    if (!partsBuffer) return FALSE;
    scheme = partsBuffer;
    host = scheme + SCHEME_CAP;
    path = host + HOST_CAP;
    extra = path + PATH_CAP;
    username = extra + EXTRA_CAP;
    password = username + CREDENTIAL_CAP;
    ZeroMemory(&parts, sizeof(parts));
    parts.dwStructSize = sizeof(parts);
    parts.lpszScheme = scheme; parts.dwSchemeLength = SCHEME_CAP;
    parts.lpszHostName = host; parts.dwHostNameLength = HOST_CAP;
    parts.lpszUrlPath = path; parts.dwUrlPathLength = PATH_CAP;
    parts.lpszExtraInfo = extra; parts.dwExtraInfoLength = EXTRA_CAP;
    parts.lpszUserName = username; parts.dwUserNameLength = CREDENTIAL_CAP;
    parts.lpszPassword = password; parts.dwPasswordLength = CREDENTIAL_CAP;
    if (!g_http.crack(baseUrl, 0, 0, &parts)
        || parts.dwSchemeLength >= SCHEME_CAP || parts.dwHostNameLength >= HOST_CAP
        || parts.dwUrlPathLength >= PATH_CAP || parts.dwExtraInfoLength >= EXTRA_CAP
        || parts.dwUserNameLength || parts.dwPasswordLength
        || (parts.nScheme != INTERNET_SCHEME_HTTP && parts.nScheme != INTERNET_SCHEME_HTTPS)) goto done;
    scheme[parts.dwSchemeLength] = 0; host[parts.dwHostNameLength] = 0;
    path[parts.dwUrlPathLength] = 0; extra[parts.dwExtraInfoLength] = 0;
    if (!parts.dwHostNameLength || parts.dwExtraInfoLength) goto done;
    pathLength = parts.dwUrlPathLength;
    while (pathLength && path[pathLength - 1] == L'/') pathLength--;
    pathLength = cx_strip_api_prefix(path, pathLength);
    /* 原「剥 /adapter-service 后缀」逻辑已抽成 cx_strip_api_prefix（见上方定义）。 */
    if (pathLength == 1 && path[0] == L'/') pathLength = 0;
    canonicalCap = parts.dwSchemeLength + parts.dwHostNameLength + pathLength + 64;
    canonical = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (SIZE_T)canonicalCap * sizeof(WCHAR));
    if (!canonical) goto done;
    if (!cx_append_w(canonical, canonicalCap, &used, parts.nScheme == INTERNET_SCHEME_HTTPS ? L"https://" : L"http://")
        || !cx_identity_append_folded(canonical, canonicalCap, &used, host, parts.dwHostNameLength)) goto done;
    if ((parts.nScheme == INTERNET_SCHEME_HTTPS && parts.nPort != INTERNET_DEFAULT_HTTPS_PORT)
        || (parts.nScheme == INTERNET_SCHEME_HTTP && parts.nPort != INTERNET_DEFAULT_HTTP_PORT)) {
        wsprintfW(portText, L":%u", (unsigned)parts.nPort);
        if (!cx_append_w(canonical, canonicalCap, &used, portText)) goto done;
    }
    for (i = 0; i < pathLength; i++) {
        if (used + 1 >= canonicalCap) goto done;
        canonical[used++] = path[i];
    }
    canonical[used] = 0;
    if (!cx_wide_utf8(canonical, &utf8, &utf8Length) || !cx_sha256((BYTE *)utf8, utf8Length, identity)) goto done;
    ok = TRUE;
done:
    if (utf8) { SecureZeroMemory(utf8, (SIZE_T)utf8Length + 1); HeapFree(GetProcessHeap(), 0, utf8); }
    if (canonical) HeapFree(GetProcessHeap(), 0, canonical);
    if (partsBuffer) HeapFree(GetProcessHeap(), 0, partsBuffer);
    return ok;
}
static BOOL cx_cache_header_valid(const CX_EXTENSION_CACHE_HEADER *header, const WCHAR *source,
    const BYTE serviceIdentity[32], DWORD fileSize) {
    DWORD i;
    if (!header || header->magic != CX_EXTENSION_CACHE_MAGIC || header->format != CX_EXTENSION_CACHE_FORMAT
        || header->headerSize != sizeof(*header) || header->packageSize == 0 || header->packageSize > 64UL * 1024UL * 1024UL
        || fileSize != sizeof(*header) + header->packageSize || !serviceIdentity
        || !cx_mem_equal(header->serviceIdentity, serviceIdentity, sizeof(header->serviceIdentity))
        || !cx_wide_terminated(header->source, sizeof(header->source) / sizeof(header->source[0]))
        || !cx_wide_terminated(header->extensionVersion, sizeof(header->extensionVersion) / sizeof(header->extensionVersion[0]))
        || !cx_ascii_equal(header->source, source) || !cx_extension_version(header->extensionVersion)
        || cx_bounded_alen(header->extensionId, sizeof(header->extensionId)) != 32
        || cx_bounded_alen(header->sha256, sizeof(header->sha256)) != 64) return FALSE;
    for (i = 0; i < 32; i++) if (header->extensionId[i] < 'a' || header->extensionId[i] > 'p') return FALSE;
    for (i = 0; i < 64; i++) {
        char c = header->sha256[i];
        if (c >= 'A' && c <= 'F') c += 'a' - 'A';
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return FALSE;
    }
    return TRUE;
}

static BOOL cx_extension_cache_read(const WCHAR *cacheDir, const WCHAR *source,
    const BYTE serviceIdentity[32], BYTE **data, DWORD *size, WCHAR *version, DWORD versionCap) {
    WCHAR *path = NULL, *temp = NULL; HANDLE file = INVALID_HANDLE_VALUE; LARGE_INTEGER length; CX_EXTENSION_CACHE_HEADER header; BYTE *package = NULL; DWORD read = 0; BYTE digest[32]; char actualHash[65]; BOOL ok = FALSE;
    (void)temp;
    if (!data || !size || !cx_cache_paths(cacheDir, source, &path, &temp)) return FALSE;
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE || !GetFileSizeEx(file, &length) || length.HighPart != 0 || length.LowPart <= sizeof(header)) goto done;
    if (SetFilePointer(file, 0, NULL, FILE_BEGIN) == INVALID_SET_FILE_POINTER
        || !ReadFile(file, &header, sizeof(header), &read, NULL) || read != sizeof(header)
        || !cx_cache_header_valid(&header, source, serviceIdentity, length.LowPart)) goto done;
    package = (BYTE *)HeapAlloc(GetProcessHeap(), 0, header.packageSize);
    if (!package || !ReadFile(file, package, header.packageSize, &read, NULL) || read != header.packageSize
        || !cx_sha256(package, header.packageSize, digest) || !cx_hex_digest(digest, actualHash) || !cx_hex_equal(actualHash, header.sha256)) goto done;
    *data = package; *size = header.packageSize; package = NULL; if (version && versionCap) lstrcpynW(version, header.extensionVersion, (int)versionCap); ok = TRUE;
done: if (file != INVALID_HANDLE_VALUE) CloseHandle(file); if (package) HeapFree(GetProcessHeap(), 0, package); if (path) HeapFree(GetProcessHeap(), 0, path); return ok;
}

static void cx_extension_cache_write(const WCHAR *cacheDir, const WCHAR *source, const BYTE *data,
    DWORD size, const WCHAR *version, const char *extensionId, const char *sha256,
    const BYTE serviceIdentity[32]) {
    WCHAR *path = NULL, *temp = NULL; HANDLE file = INVALID_HANDLE_VALUE; CX_EXTENSION_CACHE_HEADER header; DWORD written = 0; BOOL ok = FALSE;
    if (!cacheDir || !*cacheDir || !data || !size || !version || !extensionId || !sha256 || !serviceIdentity || !cx_cache_paths(cacheDir, source, &path, &temp)) return;
    if (!cx_cache_mkdirs(cacheDir)) goto done;
    ZeroMemory(&header, sizeof(header)); header.magic = CX_EXTENSION_CACHE_MAGIC; header.format = CX_EXTENSION_CACHE_FORMAT; header.headerSize = sizeof(header); header.packageSize = size;
    CopyMemory(header.serviceIdentity, serviceIdentity, sizeof(header.serviceIdentity));
    lstrcpynW(header.source, cx_ascii_equal(source, L"edge") ? L"edge" : L"chrome", sizeof(header.source) / sizeof(header.source[0]));
    lstrcpynW(header.extensionVersion, version, sizeof(header.extensionVersion) / sizeof(header.extensionVersion[0]));
    lstrcpynA(header.extensionId, extensionId, sizeof(header.extensionId)); lstrcpynA(header.sha256, sha256, sizeof(header.sha256));
    file = CreateFileW(temp, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_WRITE_THROUGH, NULL);
    if (file == INVALID_HANDLE_VALUE || !WriteFile(file, &header, sizeof(header), &written, NULL) || written != sizeof(header)
        || !WriteFile(file, data, size, &written, NULL) || written != size || !FlushFileBuffers(file)) goto done;
    CloseHandle(file); file = INVALID_HANDLE_VALUE;
    ok = MoveFileExW(temp, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
    if (!ok && GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES)
        ok = ReplaceFileW(path, temp, NULL, REPLACEFILE_WRITE_THROUGH, NULL, NULL);
done: if (file != INVALID_HANDLE_VALUE) CloseHandle(file); if (!ok && temp) DeleteFileW(temp); if (path) HeapFree(GetProcessHeap(), 0, path);
}

static BOOL cx_adapter_extension_fetch_online(const WCHAR *baseUrl, const WCHAR *source, BYTE **data, DWORD *size, WCHAR *version, DWORD versionCap, char *extensionIdOut, DWORD extensionIdCap, WCHAR *error, DWORD errorCap) {
    WCHAR *wide = NULL, *latestPath, *downloadPath, *expectedPath, *advertisedVersion, *advertisedSource; const WCHAR *canonicalSource; char advertisedHash[80], downloadUrl[2048], extensionId[128]; CX_ADAPTER_REPLY latest = {0}, package = {0}; JT *tokens = NULL; int count, v, sizeToken; DWORD advertisedSize, pathUsed, i; BYTE digest[32]; char actualHash[65]; BOOL ok = FALSE;
    if (data) *data = NULL; if (size) *size = 0; if (version && versionCap) version[0] = 0;
    if (!data || !size || !baseUrl || !source || (!cx_ascii_equal(source, L"edge") && !cx_ascii_equal(source, L"chrome"))) { cx_error(error, errorCap, L"扩展来源必须是 edge 或 chrome。"); return FALSE; }
    wide = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (256 + 2048 + 256 + 128 + 16) * sizeof(WCHAR));
    if (!wide) { cx_error(error, errorCap, L"内存不足。"); return FALSE; }
    latestPath = wide; downloadPath = latestPath + 256; expectedPath = downloadPath + 2048; advertisedVersion = expectedPath + 256; advertisedSource = advertisedVersion + 128;
    canonicalSource = cx_ascii_equal(source, L"edge") ? L"edge" : L"chrome";
    pathUsed = 0; latestPath[0] = 0; cx_append_w(latestPath, 256, &pathUsed, L"/api/extensions/"); cx_append_w(latestPath, 256, &pathUsed, canonicalSource); cx_append_w(latestPath, 256, &pathUsed, L"/latest");
    if (!cx_adapter_request(baseUrl, L"GET", latestPath, NULL, NULL, 15000, 65536, &latest, error, errorCap)) goto done;
    if (latest.status < 200 || latest.status >= 300) {
        cx_error(error, errorCap, latest.status == 503 ? L"服务端尚无已验证扩展，请在管理后台检查扩展更新。"
            : latest.status == 404 ? L"扩展来源或分发接口尚未配置，请先部署 tikuAdapter 更新服务。"
            : L"扩展服务暂时不可用，请稍后重试。");
        goto done;
    }
    tokens = (JT *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 4096 * sizeof(JT)); if (!tokens) { cx_error(error, errorCap, L"扩展版本响应内存不足。"); goto done; }
    count = jparse(latest.body, (int)latest.length, tokens, 4096); if (count <= 0 || tokens[0].type != '{') { cx_error(error, errorCap, L"扩展版本响应格式无效。"); goto done; }
    v = jkey(latest.body, tokens, 0, "version"); sizeToken = jkey(latest.body, tokens, 0, "size"); { int hashToken = jkey(latest.body, tokens, 0, "sha256"); int urlToken = jkey(latest.body, tokens, 0, "downloadUrl"); int idToken = jkey(latest.body, tokens, 0, "extensionId"); int sourceToken = jkey(latest.body, tokens, 0, "source"); if (v < 0 || sizeToken < 0 || hashToken < 0 || urlToken < 0 || idToken < 0 || sourceToken < 0 || !jwstr(latest.body, tokens, v, advertisedVersion, 128) || !jwstr(latest.body, tokens, sourceToken, advertisedSource, 16) || !jstr(latest.body, tokens, hashToken, advertisedHash, 80) || !jstr(latest.body, tokens, urlToken, downloadUrl, 2048) || !jstr(latest.body, tokens, idToken, extensionId, 128)) { cx_error(error, errorCap, L"扩展版本响应缺少必要字段。"); goto done; } }
    advertisedSize = (DWORD)jint(latest.body, tokens, sizeToken, 0);
    if (!advertisedSize || advertisedSize > 64UL * 1024UL * 1024UL || !cx_extension_version(advertisedVersion) || !cx_ascii_equal(advertisedSource, canonicalSource) || cx_alen(extensionId) != 32 || cx_alen(advertisedHash) != 64) { cx_error(error, errorCap, L"扩展下载信息无效。"); goto done; }
    for (i = 0; i < 32; i++) if (extensionId[i] < 'a' || extensionId[i] > 'p') { cx_error(error, errorCap, L"扩展标识无效。"); goto done; }
    for (i = 0; i < 64; i++) { char c = advertisedHash[i]; if (c >= 'A' && c <= 'F') c += 'a' - 'A'; if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) { cx_error(error, errorCap, L"扩展 SHA-256 格式无效。"); goto done; } advertisedHash[i] = c; }
    { int wchars = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, downloadUrl, -1, downloadPath, 2048); if (wchars <= 0) { cx_error(error, errorCap, L"扩展下载路径编码无效。"); goto done; } }
    pathUsed = 0; expectedPath[0] = 0; cx_append_w(expectedPath, 256, &pathUsed, L"/api/extensions/"); cx_append_w(expectedPath, 256, &pathUsed, canonicalSource); cx_append_w(expectedPath, 256, &pathUsed, L"/download?sha256="); for (i = 0; i < 64; i++) expectedPath[pathUsed++] = (WCHAR)advertisedHash[i]; expectedPath[pathUsed] = 0;
    if (lstrcmpW(expectedPath, downloadPath)) { cx_error(error, errorCap, L"扩展下载路径不属于当前服务或版本。"); goto done; }
    if (!cx_adapter_request(baseUrl, L"GET", downloadPath, NULL, NULL, 60000, 64UL * 1024UL * 1024UL, &package, error, errorCap) || package.status < 200 || package.status >= 300 || package.length != advertisedSize || !cx_sha256((BYTE *)package.body, package.length, digest) || !cx_hex_digest(digest, actualHash) || !cx_hex_equal(actualHash, advertisedHash)) { cx_error(error, errorCap, L"扩展下载包大小或 SHA-256 校验失败。"); goto done; }
    *data = (BYTE *)package.body; *size = package.length; package.body = NULL; package.length = 0; if (version && versionCap) lstrcpynW(version, advertisedVersion, (int)versionCap); if (extensionIdOut && extensionIdCap) lstrcpynA(extensionIdOut, extensionId, extensionIdCap); ok = TRUE;
done: if (tokens) HeapFree(GetProcessHeap(), 0, tokens); if (wide) HeapFree(GetProcessHeap(), 0, wide); cx_adapter_reply_free(&latest); cx_adapter_reply_free(&package); return ok;
}

BOOL cx_adapter_extension_fetch(const WCHAR *baseUrl, const WCHAR *source, BYTE **data, DWORD *size,
    WCHAR *version, DWORD versionCap, WCHAR *error, DWORD errorCap) {
    return cx_adapter_extension_fetch_online(baseUrl, source, data, size, version, versionCap,
        NULL, 0, error, errorCap);
}

BOOL cx_adapter_extension_fetch_cached(const WCHAR *baseUrl, const WCHAR *source,
    const WCHAR *cacheDir, BOOL noDiskWrite, BOOL forceRefresh, BYTE **data, DWORD *size,
    WCHAR *version, DWORD versionCap, WCHAR *error, DWORD errorCap) {
    char extensionId[128], actualHash[65]; BYTE digest[32], serviceIdentity[32]; BOOL ok, cacheIdentityReady = FALSE;
    if (data) *data = NULL; if (size) *size = 0; if (version && versionCap) version[0] = 0;
    if (!noDiskWrite && cacheDir && *cacheDir)
        cacheIdentityReady = cx_extension_service_identity(baseUrl, serviceIdentity);
    if (cacheIdentityReady && !forceRefresh
        && cx_extension_cache_read(cacheDir, source, serviceIdentity, data, size, version, versionCap)) return TRUE;
    ok = cx_adapter_extension_fetch_online(baseUrl, source, data, size, version, versionCap,
        extensionId, sizeof(extensionId), error, errorCap);
    if (!ok) return FALSE;
    if (cacheIdentityReady && *data && *size && cx_sha256(*data, *size, digest)
        && cx_hex_digest(digest, actualHash)) cx_extension_cache_write(cacheDir, source, *data, *size,
            version, extensionId, actualHash, serviceIdentity);
    return TRUE;
}

HBITMAP cx_adapter_captcha_bitmap(const CX_ADAPTER_CAPTCHA *captcha, WCHAR *error, DWORD errorCap) {
    static const GUID factoryClass = {0xcacaf262,0x9370,0x4615,{0xa1,0x3b,0x9f,0x55,0x39,0xda,0x4c,0x0a}};
    static const GUID factoryInterface = {0xec5ec8a9,0xc395,0x4314,{0x9c,0x77,0x54,0xd7,0xa9,0x35,0xff,0x70}};
    static const GUID bgra = {0x6fddc324,0x4e03,0x4bfe,{0xb1,0x85,0x3d,0x77,0x76,0x8d,0xc9,0x0f}};
    const char *prefix = "data:image/png;base64,";
    BYTE *bytes = NULL; WCHAR *encoded = NULL; DWORD count = 0, flags = 0, chars, p = 22, n;
    IWICImagingFactory *factory = NULL; IWICStream *stream = NULL; IWICBitmapDecoder *decoder = NULL;
    IWICBitmapFrameDecode *frame = NULL; IWICFormatConverter *converter = NULL;
    HBITMAP bitmap = NULL; BITMAPINFO info; void *pixels = NULL; UINT width = 0, height = 0;
    BOOL com = FALSE, ok = FALSE; HRESULT hr; int converted;
    if (!captcha || !captcha->imageData[0] || !cx_load_image()) { cx_error(error, errorCap, L"验证码图片解析组件不可用。"); return NULL; }
    n = cx_alen(captcha->imageData);
    if (n <= p || !cx_mem_equal(captcha->imageData, prefix, p)) { cx_error(error, errorCap, L"验证码图片格式无效。"); return NULL; }
    chars = n - p; encoded = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)(chars + 1) * sizeof(WCHAR));
    if (!encoded) goto done;
    converted = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, captcha->imageData + p, (int)chars, encoded, (int)chars);
    if (converted <= 0) goto done;
    encoded[converted] = 0; count = chars * 3 / 4 + 8; bytes = (BYTE *)HeapAlloc(GetProcessHeap(), 0, count);
    if (!bytes || !g_base64(encoded, (DWORD)converted, CRYPT_STRING_BASE64, bytes, &count, NULL, &flags)) goto done;
    hr = g_coInitialize(NULL, COINIT_APARTMENTTHREADED);
    com = hr == S_OK || hr == S_FALSE;
    if (!com && hr != RPC_E_CHANGED_MODE) goto done;
    if (FAILED(g_coCreate(&factoryClass, NULL, CLSCTX_INPROC_SERVER, &factoryInterface, (LPVOID *)&factory))
        || FAILED(factory->lpVtbl->CreateStream(factory, &stream))
        || FAILED(stream->lpVtbl->InitializeFromMemory(stream, bytes, count))
        || FAILED(factory->lpVtbl->CreateDecoderFromStream(factory, (IStream *)stream, NULL, WICDecodeMetadataCacheOnLoad, &decoder))
        || FAILED(decoder->lpVtbl->GetFrame(decoder, 0, &frame))
        || FAILED(frame->lpVtbl->GetSize(frame, &width, &height))
        || !width || !height || width > 2048 || height > 2048
        || FAILED(factory->lpVtbl->CreateFormatConverter(factory, &converter))
        || FAILED(converter->lpVtbl->Initialize(converter, (IWICBitmapSource *)frame, &bgra, WICBitmapDitherTypeNone, NULL, 0, WICBitmapPaletteTypeCustom))) goto done;
    ZeroMemory(&info, sizeof(info)); info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); info.bmiHeader.biWidth = (LONG)width; info.bmiHeader.biHeight = -(LONG)height; info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
    bitmap = CreateDIBSection(NULL, &info, DIB_RGB_COLORS, &pixels, NULL, 0);
    if (!bitmap || FAILED(converter->lpVtbl->CopyPixels(converter, NULL, width * 4, width * height * 4, (BYTE *)pixels))) goto done;
    ok = TRUE;
done:
    if (converter) converter->lpVtbl->Release(converter);
    if (frame) frame->lpVtbl->Release(frame);
    if (decoder) decoder->lpVtbl->Release(decoder);
    if (stream) stream->lpVtbl->Release(stream);
    if (factory) factory->lpVtbl->Release(factory);
    if (com) g_coUninitialize();
    if (bytes) HeapFree(GetProcessHeap(), 0, bytes);
    if (encoded) HeapFree(GetProcessHeap(), 0, encoded);
    if (!ok) { if (bitmap) DeleteObject(bitmap); bitmap = NULL; cx_error(error, errorCap, L"验证码 PNG 图片解码失败。"); }
    return bitmap;
}
