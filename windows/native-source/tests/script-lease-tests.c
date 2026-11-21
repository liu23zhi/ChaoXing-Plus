#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "../adapter-account.h"

static DWORD failures, requests;
static BOOL transportOK = TRUE;
static DWORD responseStatus = 200;
static BOOL requestMatches;
static BOOL malformed;
static BOOL test_request(const WCHAR *base, const WCHAR *method, const WCHAR *path,
    const WCHAR *auth, const WCHAR *identity, const char *json, DWORD timeout,
    DWORD limit, CX_ADAPTER_REPLY *reply, WCHAR *error, DWORD cap) {
    static char body[] = "{\"expiresAt\":\"2099-01-01T00:00:00Z\"}";
    (void)json; (void)timeout; (void)limit; (void)error; (void)cap;
    ++requests;
    requestMatches = !lstrcmpW(base, L"https://example.test") && !lstrcmpW(method, L"POST")
        && !lstrcmpW(path, L"/api/script-command/a/heartbeat")
        && !lstrcmpW(auth, L"Bearer sr_fixture") && lstrlenW(identity) == 64;
    reply->status = responseStatus;
    reply->length = malformed ? 1 : (DWORD)lstrlenA(body);
    reply->body = (char *)HeapAlloc(GetProcessHeap(), 0, reply->length + 1);
    if (reply->body) CopyMemory(reply->body, body, reply->length + 1);
    return transportOK;
}
#define cx_adapter_request_identity test_request
#include "../script-lease.c"
#undef cx_adapter_request_identity

static void output(const char *text) { DWORD written; WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &written, NULL); }
static void check(BOOL ok, const char *name) { output(ok ? "PASS " : "FAIL "); output(name); output("\n"); if (!ok) ++failures; }

void ScriptLeaseTestMain(void) {
    CX_SCRIPT_LEASE lease;
    WCHAR identity[65], other[65], error[256]; DWORD i;
    ULONGLONG now, equivalent;
    BOOL hex = TRUE;
    check(cx_script_identity(identity, 65) && cx_script_identity(other, 65), "cryptographic identities can be generated");
    for (i = 0; identity[i]; ++i) if (!((identity[i] >= L'0' && identity[i] <= L'9') || (identity[i] >= L'a' && identity[i] <= L'f'))) hex = FALSE;
    check(hex && lstrlenW(identity) == 64 && lstrcmpW(identity, other), "identities contain 32 random bytes in lowercase hex");
    check(lease_parse_deadline(L"2030-01-02T03:04:05.123456789+08:00", &now)
        && lease_parse_deadline(L"2030-01-01T19:04:05.123Z", &equivalent) && now == equivalent,
        "RFC3339 Shanghai offset and fractional seconds preserve the absolute deadline");
    check(!lease_parse_deadline(L"2030-02-30T03:04:05Z", &equivalent)
        && !lease_parse_deadline(L"2030-01-02T03:04:05", &equivalent), "invalid calendar dates and missing time zones are rejected");
    check(lease_configure(&lease, L"https://example.test", L"/api/script-command/a/heartbeat", L"sr_fixture", identity,
        L"2030-01-02T03:05:05.123+08:00", now, error, 256), "relative heartbeat URL is bound to the activation origin");
    check(lease_poll(&lease, now + 599999999ULL) && requests == 0, "heartbeats wait one minute");
    check(lease_effective_now(&lease, now - LEASE_MINUTE, lease.startedTick + 60000) == now + LEASE_MINUTE,
        "rolling the wall clock backward cannot extend the lease");
    check(!lease_poll(&lease, now + 600000000ULL) && requests == 0,
        "hard expiry wins over a heartbeat due at the same instant");
    check(!lease_poll(&lease, now + 600000000ULL), "expired leases cannot continue");
    check(lease_configure(&lease, L"https://example.test", L"https://example.test/api/script-command/a/heartbeat", L"sr_fixture", identity,
        L"2030-01-02T03:07:05.123+08:00", now, error, 256), "an absolute heartbeat URL may use the same origin");
    requests = 0;
    check(lease_poll(&lease, now + 600000000ULL) && requests == 1 && requestMatches,
        "minute heartbeat carries the bearer session and matching identity");
    check(!lease_poll(&lease, now + 1800000000ULL), "heartbeat responses never extend the activation deadline");
    check(!lease_configure(&lease, L"https://example.test", L"https://other.test/api/script-command/a/heartbeat", L"sr_fixture", identity,
        L"2030-01-02T03:07:05.123+08:00", now, error, 256)
        && !lease_configure(&lease, L"https://example.test", L"//other.test/heartbeat", L"sr_fixture", identity,
        L"2030-01-02T03:07:05.123+08:00", now, error, 256), "foreign and protocol-relative heartbeat targets are rejected");
    lease_configure(&lease, L"https://example.test", L"/api/script-command/a/heartbeat", L"sr_fixture", identity,
        L"2030-01-02T03:07:05.123+08:00", now, error, 256);
    responseStatus = 403;
    check(!lease_poll(&lease, now + 600000000ULL), "revocation stops the lease immediately");
    responseStatus = 200; transportOK = FALSE;
    check(!lease_poll(&lease, now + 1200000000ULL), "network failure cannot keep a lease running");
    transportOK = TRUE; malformed = TRUE;
    check(!lease_poll(&lease, now + 1200000000ULL), "a malformed heartbeat response fails closed");
    {
        WCHAR origin[1024]; CX_ADAPTER_REPLY reply;
        if (GetEnvironmentVariableW(L"CX_SCRIPT_LEASE_TEST_ORIGIN", origin, 1024)) {
            ZeroMemory(&reply, sizeof(reply));
            check(cx_adapter_request_identity(origin, L"POST", L"/heartbeat", L"Bearer sr_fixture", identity,
                NULL, 2000, 65536, &reply, error, 256) && reply.status == 200,
                "real WinHTTP heartbeat transports the session proof to the local fixture");
            cx_adapter_reply_free(&reply);
            {
                DWORD started = GetTickCount();
                check(!cx_adapter_request_identity(origin, L"POST", L"/slow-heartbeat", L"Bearer sr_fixture", identity,
                    NULL, 250, 65536, &reply, error, 256) && GetTickCount() - started < 1500,
                    "slow streaming heartbeat cannot extend the absolute HTTP timeout");
                cx_adapter_reply_free(&reply);
            }
        }
    }
    output(failures ? "NATIVE SCRIPT LEASE TESTS FAIL\n" : "NATIVE SCRIPT LEASE TESTS PASS\n");
    ExitProcess(failures ? 1 : 0);
}
