/* Isolated contract for one native host; no browser, user config or network. */
#include <stdio.h>
#include <wchar.h>
#include "../adapter-account.h"
#include "../device-quota.h"
#include "../json.h"

#if !defined(_M_IX86)
#error This fixture must exercise the Windows x86 host ABI.
#endif

static const WCHAR device[] = L"fixture-device";
static int reports, counts[2] = {-1, -1};

/* Observe the report produced by device-quota.c, not a second implementation
   of its slot rule. Do not link the HTTP adapter into this fixture. */
BOOL cx_adapter_request(const WCHAR *base, const WCHAR *method, const WCHAR *path,
    const WCHAR *auth, const char *json, DWORD timeout, DWORD limit,
    CX_ADAPTER_REPLY *reply, WCHAR *error, DWORD errorCap) {
    JT t[8];
    WCHAR reportedDevice[CX_DEVICE_ID_CAP];
    int id, count;
    (void)timeout; (void)limit; (void)error; (void)errorCap;
    if (reports >= 2 || lstrcmpW(base, L"https://fixture.invalid") ||
        lstrcmpW(method, L"POST") || lstrcmpW(path, L"/api/user/device-sessions") ||
        lstrcmpW(auth, L"Bearer fixture-only") || !json || !reply)
        return FALSE;
    if (jparse(json, lstrlenA(json), t, ARRAYSIZE(t)) < 1 ||
        t[0].type != '{' || t[0].count != 4) return FALSE;
    id = jkey(json, t, 0, "deviceId");
    count = jkey(json, t, 0, "count");
    if (id < 0 || !jwstr(json, t, id, reportedDevice, ARRAYSIZE(reportedDevice)) ||
        lstrcmpW(reportedDevice, device) || count < 0 || t[count].type != 'p')
        return FALSE;
    counts[reports++] = jint(json, t, count, -1);
    reply->status = 204;
    return TRUE;
}
void cx_adapter_reply_free(CX_ADAPTER_REPLY *reply) { (void)reply; }

#define CHECK(x) do { if (!(x)) { \
    fprintf(stderr, "device quota assertion failed at line %d: %s\n", __LINE__, #x); return 1; \
} } while (0)

int main(void) {
    const int sessions[] = {3, 0};
    const WCHAR *expected[] = {
        L"本 exe 占用：3 个（3 个浏览器会话）",
        L"本 exe 占用：1 个（0 个浏览器会话）"
    };
    CX_DEVICE_QUOTA quota = {0};
    WCHAR status[256];
    int i;
    quota.known = TRUE;
    for (i = 0; i < 2; ++i) {
        CHECK(cx_device_sessions_report(L"https://fixture.invalid", L"fixture-only",
            device, sessions[i], 1000, NULL, 0));
        CHECK(reports == i + 1 && counts[i] == sessions[i]);
        CHECK(cx_device_status_text(&quota, sessions[i], status, ARRAYSIZE(status)));
        CHECK(wcsstr(status, expected[i]) != NULL);
    }
    puts("same native device: reported sessions 3 -> 0; displayed occupied slots 3 -> 1");
    return 0;
}
