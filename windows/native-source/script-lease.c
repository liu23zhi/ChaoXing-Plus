#include "script-lease.h"
#include "adapter-account.h"
#include "json.h"

#define LEASE_URL_CAP 1024
#define LEASE_TOKEN_CAP 4096
#define LEASE_MINUTE 600000000ULL

typedef struct CX_SCRIPT_LEASE {
    WCHAR origin[LEASE_URL_CAP], path[LEASE_URL_CAP], token[LEASE_TOKEN_CAP], identity[65];
    ULONGLONG deadline, heartbeatAt;
    ULONGLONG startedAt;
    DWORD startedTick;
} CX_SCRIPT_LEASE;

static CX_SCRIPT_LEASE lease_current;
static HANDLE lease_thread, lease_stop;
static volatile LONG lease_active, lease_invalid;

BOOL cx_script_identity(WCHAR *out, DWORD cap) {
    typedef BOOLEAN (APIENTRY *RANDOM_BYTES)(PVOID, ULONG);
    HMODULE library; RANDOM_BYTES random; BYTE bytes[32]; DWORD i;
    static const WCHAR hex[] = L"0123456789abcdef";
    if (!out || cap < 65) return FALSE;
    out[0] = 0;
    library = LoadLibraryW(L"advapi32.dll");
    if (!library) return FALSE;
    random = (RANDOM_BYTES)(void *)GetProcAddress(library, "SystemFunction036");
    if (!random || !random(bytes, sizeof(bytes))) { FreeLibrary(library); return FALSE; }
    for (i = 0; i < 32; ++i) { out[2 * i] = hex[bytes[i] >> 4]; out[2 * i + 1] = hex[bytes[i] & 15]; }
    out[64] = 0; SecureZeroMemory(bytes, sizeof(bytes)); FreeLibrary(library); return TRUE;
}

static ULONGLONG lease_now(void) {
    FILETIME time; ULARGE_INTEGER value;
    GetSystemTimeAsFileTime(&time); value.LowPart = time.dwLowDateTime; value.HighPart = time.dwHighDateTime;
    return value.QuadPart;
}

static ULONGLONG lease_effective_now(const CX_SCRIPT_LEASE *lease, ULONGLONG wall, DWORD tick) {
    ULONGLONG monotonic = lease->startedAt + (ULONGLONG)(tick - lease->startedTick) * 10000ULL;
    return wall > monotonic ? wall : monotonic;
}

static BOOL lease_digits(const WCHAR *value, DWORD length, WORD *result) {
    DWORD i; WORD n = 0;
    for (i = 0; i < length; ++i) {
        if (value[i] < L'0' || value[i] > L'9') return FALSE;
        n = (WORD)(n * 10 + value[i] - L'0');
    }
    *result = n; return TRUE;
}

static BOOL lease_parse_deadline(const WCHAR *text, ULONGLONG *deadline) {
    SYSTEMTIME st; FILETIME ft; ULARGE_INTEGER value; DWORD i = 19, digits = 0;
    WORD hours, minutes; ULONGLONG offset;
    if (!text || lstrlenW(text) < 20 || !deadline) return FALSE;
    ZeroMemory(&st, sizeof(st));
    if (text[4] != L'-' || text[7] != L'-' || text[10] != L'T' || text[13] != L':' || text[16] != L':'
        || !lease_digits(text, 4, &st.wYear) || !lease_digits(text + 5, 2, &st.wMonth)
        || !lease_digits(text + 8, 2, &st.wDay) || !lease_digits(text + 11, 2, &st.wHour)
        || !lease_digits(text + 14, 2, &st.wMinute) || !lease_digits(text + 17, 2, &st.wSecond)) return FALSE;
    if (text[i] == L'.') {
        ++i;
        while (text[i] >= L'0' && text[i] <= L'9') {
            if (digits < 3) st.wMilliseconds = (WORD)(st.wMilliseconds * 10 + text[i] - L'0');
            ++digits; ++i;
        }
        if (!digits) return FALSE;
        if (digits == 1) st.wMilliseconds *= 100;
        else if (digits == 2) st.wMilliseconds *= 10;
    }
    if (!SystemTimeToFileTime(&st, &ft)) return FALSE;
    value.LowPart = ft.dwLowDateTime; value.HighPart = ft.dwHighDateTime;
    if (text[i] == L'Z' && !text[i + 1]) { *deadline = value.QuadPart; return TRUE; }
    if ((text[i] != L'+' && text[i] != L'-') || lstrlenW(text + i) != 6 || text[i + 3] != L':'
        || !lease_digits(text + i + 1, 2, &hours) || !lease_digits(text + i + 4, 2, &minutes)
        || hours > 23 || minutes > 59) return FALSE;
    offset = (ULONGLONG)(hours * 60 + minutes) * LEASE_MINUTE;
    if (text[i] == L'+') { if (value.QuadPart < offset) return FALSE; value.QuadPart -= offset; }
    else value.QuadPart += offset;
    *deadline = value.QuadPart; return TRUE;
}

static BOOL lease_configure(CX_SCRIPT_LEASE *lease, const WCHAR *origin, const WCHAR *heartbeatUrl,
    const WCHAR *token, const WCHAR *identity, const WCHAR *expiresAt, ULONGLONG now, WCHAR *error, DWORD errorCap) {
    DWORD i;
    ZeroMemory(lease, sizeof(*lease));
    if (!origin || !token || !identity || lstrlenW(origin) >= LEASE_URL_CAP
        || !token[0] || lstrlenW(token) >= LEASE_TOKEN_CAP || lstrlenW(identity) != 64
        || !lease_parse_deadline(expiresAt, &lease->deadline) || lease->deadline <= now
        || !cx_adapter_same_origin_path(origin, heartbeatUrl, lease->path, LEASE_URL_CAP)) goto failed;
    for (i = 0; token[i]; ++i) if (token[i] < 33 || token[i] > 126) goto failed;
    for (i = 0; i < 64; ++i) if (!((identity[i] >= L'0' && identity[i] <= L'9') || (identity[i] >= L'a' && identity[i] <= L'f'))) goto failed;
    lstrcpyW(lease->origin, origin); lstrcpyW(lease->token, token); lstrcpyW(lease->identity, identity);
    lease->startedAt = now; lease->startedTick = GetTickCount();
    lease->heartbeatAt = now + LEASE_MINUTE; return TRUE;
failed:
    SecureZeroMemory(lease, sizeof(*lease));
    if (error && errorCap) lstrcpynW(error, L"脚本会话租约响应无效，未继续启动。", (int)errorCap);
    return FALSE;
}

static BOOL lease_poll(CX_SCRIPT_LEASE *lease, ULONGLONG now) {
    CX_ADAPTER_REPLY reply; WCHAR authorization[LEASE_TOKEN_CAP + 8], error[256]; BOOL ok;
    JT tokens[32]; int count, value; WCHAR expiresAt[64]; ULONGLONG responseDeadline;
    if (now >= lease->deadline) return FALSE;
    if (now < lease->heartbeatAt) return TRUE;
    lstrcpyW(authorization, L"Bearer "); lstrcatW(authorization, lease->token);
    ZeroMemory(&reply, sizeof(reply));
    ok = cx_adapter_request_identity(lease->origin, L"POST", lease->path, authorization, lease->identity,
        NULL, 10000, 65536, &reply, error, 256) && reply.status >= 200 && reply.status < 300;
    if (ok) {
        count = jparse(reply.body, (int)reply.length, tokens, 32);
        value = count > 0 ? jkey(reply.body, tokens, 0, "expiresAt") : -1;
        ok = value >= 0 && jwstr(reply.body, tokens, value, expiresAt, 64)
            && lease_parse_deadline(expiresAt, &responseDeadline) && responseDeadline > now;
    }
    cx_adapter_reply_free(&reply); SecureZeroMemory(authorization, sizeof(authorization));
    if (ok) lease->heartbeatAt = now + LEASE_MINUTE;
    return ok;
}

static DWORD WINAPI lease_work(LPVOID unused) {
    (void)unused;
    while (WaitForSingleObject(lease_stop, 250) == WAIT_TIMEOUT) {
        if (!lease_poll(&lease_current, lease_effective_now(&lease_current, lease_now(), GetTickCount()))) { InterlockedExchange(&lease_invalid, TRUE); break; }
    }
    return 0;
}

void cx_script_lease_stop(void) {
    if (lease_stop) SetEvent(lease_stop);
    if (lease_thread) { WaitForSingleObject(lease_thread, INFINITE); CloseHandle(lease_thread); lease_thread = NULL; }
    if (lease_stop) { CloseHandle(lease_stop); lease_stop = NULL; }
    InterlockedExchange(&lease_active, FALSE); InterlockedExchange(&lease_invalid, FALSE);
    SecureZeroMemory(&lease_current, sizeof(lease_current));
}

void cx_script_lease_cancel(void) {
    if (cx_script_lease_active()) InterlockedExchange(&lease_invalid, TRUE);
    if (lease_stop) SetEvent(lease_stop);
}

BOOL cx_script_lease_start(const WCHAR *origin, const WCHAR *heartbeatUrl,
    const WCHAR *token, const WCHAR *identity, const WCHAR *expiresAt, WCHAR *error, DWORD errorCap) {
    cx_script_lease_stop();
    if (!lease_configure(&lease_current, origin, heartbeatUrl, token, identity, expiresAt, lease_now(), error, errorCap)) return FALSE;
    lease_stop = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (lease_stop) lease_thread = CreateThread(NULL, 0, lease_work, NULL, 0, NULL);
    if (!lease_thread) { cx_script_lease_stop(); return FALSE; }
    InterlockedExchange(&lease_active, TRUE); return TRUE;
}

BOOL cx_script_lease_active(void) { return InterlockedCompareExchange(&lease_active, 0, 0) != 0; }
BOOL cx_script_lease_valid(void) {
    return !cx_script_lease_active() || (!InterlockedCompareExchange(&lease_invalid, 0, 0)
        && lease_effective_now(&lease_current, lease_now(), GetTickCount()) < lease_current.deadline);
}
