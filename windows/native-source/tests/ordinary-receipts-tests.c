/* Exactly two synthetic transport operations; no network, registry or real credentials. */
#include "../adapter-account.h"
#include "../json.h"
#include "../ordinary-receipts.h"
#include <shellapi.h>

static void test_text(const char *text) {
    DWORD used;
    (void)WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &used, NULL);
}
static void test_fail(int line) {
    char text[96];
    wsprintfA(text, "ordinary native receipts fixture failed at line %d\r\n", line);
    test_text(text);
    ExitProcess((UINT)line);
}
#define CHECK(value) do { if (!(value)) test_fail(__LINE__); } while (0)

#define TEST_OUTBOX L"ordinary-receipts.v1.outbox"
#define TEST_KEY L"synthetic-ordinary-api-key"
#define TEST_AUTH L"Bearer synthetic-ordinary-api-key"
#define TEST_PROOF L"agd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
#define TEST_BASE L"https://ordinary-fixture.invalid/tenant"
#define TEST_BROWSER L"test.browser:1"
#define TEST_DEVICE L"test.device-1"
#define TEST_VERSION L"6.3.0"
#define TEST_DAY (24ULL * 60 * 60 * 10000000)
static const WCHAR *testBase = TEST_BASE;
static const WCHAR *testAuth = TEST_AUTH;
static const WCHAR *testProof = TEST_PROOF;
static ULONGLONG testAdvance;
static int testGets, testPosts, testUUID;
static char testOriginal[768], testLast[768];
static char testDisk[65536];

static void test_system_time(FILETIME *dst) {
    const SYSTEMTIME st = {2026, 11, 0, 28, 1, 2, 3, 456};
    ULARGE_INTEGER now;
    CHECK(SystemTimeToFileTime(&st, dst));
    now.LowPart = dst->dwLowDateTime;
    now.HighPart = dst->dwHighDateTime;
    now.QuadPart += testAdvance;
    dst->dwLowDateTime = now.LowPart;
    dst->dwHighDateTime = now.HighPart;
}

#define GetSystemTimeAsFileTime test_system_time
#include "../ordinary-receipts.inc"
#undef GetSystemTimeAsFileTime

typedef enum TEST_RESULT {
    TEST_MATCH, TEST_LOST, TEST_OTHER_SCOPE, TEST_COUNT_ONLY, TEST_EXTRA_ID,
    TEST_WRONG_BATCH, TEST_WRONG_EVENT, TEST_DENIED, TEST_DISABLED,
    TEST_UNKNOWN, TEST_BAD_POLICY
} TEST_RESULT;
static TEST_RESULT testPolicy = TEST_MATCH, testReceipt = TEST_LOST;

static BOOL test_response(CX_ADAPTER_REPLY *reply, DWORD status, const char *body, DWORD limit) {
    reply->status = status;
    if (body) {
        reply->length = (DWORD)lstrlenA(body);
        CHECK(reply->length < limit);
        reply->body = (char *)HeapAlloc(GetProcessHeap(), 0, reply->length + 1);
        CHECK(reply->body);
        CopyMemory(reply->body, body, reply->length + 1);
    }
    return TRUE;
}
void cx_adapter_reply_free(CX_ADAPTER_REPLY *reply) {
    if (reply->body) HeapFree(GetProcessHeap(), 0, reply->body);
    ZeroMemory(reply, sizeof(*reply));
}
BOOL cx_device_uuid_v4(WCHAR *out, DWORD cap) {
    CHECK(cap >= 37);
    wsprintfW(out, L"00000000-0000-4000-8000-%012d", ++testUUID);
    return TRUE;
}
BOOL cx_adapter_agreement_request(const WCHAR *base, const WCHAR *method, const WCHAR *path,
    const WCHAR *authorization, const WCHAR *proof, const char *json, DWORD limit, CX_ADAPTER_REPLY *reply) {
    JT tok[48];
    int entries, entry, seq, when;
    char device[129], browser[129], version[32], launch[40], batch[40], event[40], output[768];
    const char *extra = "";
    CHECK(!lstrcmpW(base, testBase));
    CHECK(!lstrcmpW(authorization, testAuth));
    CHECK(!lstrcmpW(proof, testProof));
    if (!lstrcmpW(method, L"GET")) {
        CHECK(!lstrcmpW(path, L"api/extension-logs/receipt-policy?mode=native_browser") && !json);
        ++testGets;
        switch (testPolicy) {
        case TEST_UNKNOWN: return FALSE;
        case TEST_DENIED: return test_response(reply, 401, NULL, limit);
        case TEST_DISABLED: return test_response(reply, 200, "{\"enabled\":false,\"transport\":\"receipt-v1\"}", limit);
        case TEST_BAD_POLICY: return test_response(reply, 200, "{\"enabled\":\"true\",\"transport\":\"receipt-v1\"}", limit);
        default: return test_response(reply, 200, "{\"enabled\":true,\"transport\":\"receipt-v1\"}", limit);
        }
    }
    CHECK(!lstrcmpW(method, L"POST") && !lstrcmpW(path, L"api/extension-logs/batches") && json);
    CHECK(++testPosts <= testGets && lstrlenA(json) < (int)sizeof(testLast));
    lstrcpyA(testLast, json);
    if (testOriginal[0]) CHECK(!lstrcmpA(testOriginal, json));
    CHECK(jparse(json, lstrlenA(json), tok, ARRAYSIZE(tok)) > 0 && tok[0].count == 14);
    CHECK(jeq(json, tok, jkey(json, tok, 0, "mode"), "native_browser"));
    CHECK(jstr(json, tok, jkey(json, tok, 0, "version"), version, ARRAYSIZE(version)));
    CHECK(jstr(json, tok, jkey(json, tok, 0, "device_id"), device, ARRAYSIZE(device)));
    CHECK(jstr(json, tok, jkey(json, tok, 0, "browser_id"), browser, ARRAYSIZE(browser)));
    CHECK(jstr(json, tok, jkey(json, tok, 0, "launch_id"), launch, ARRAYSIZE(launch)));
    CHECK(jstr(json, tok, jkey(json, tok, 0, "batch_id"), batch, ARRAYSIZE(batch)));
    CHECK((entries = jkey(json, tok, 0, "entries")) >= 0 && tok[entries].type == '[' && tok[entries].count == 1);
    entry = entries + 1;
    CHECK(tok[entry].type == '{' && tok[entry].count == 10);
    CHECK(jstr(json, tok, jkey(json, tok, entry, "event_id"), event, ARRAYSIZE(event)));
    CHECK((seq = jkey(json, tok, entry, "event_seq")) >= 0 && jint(json, tok, seq, 0) == 1);
    CHECK((when = jkey(json, tok, entry, "time")) >= 0 && jeq(json, tok, when, "2026-11-28T01:02:03.456Z"));
    CHECK(jeq(json, tok, jkey(json, tok, entry, "event"), "extension.ready"));
    CHECK(jeq(json, tok, jkey(json, tok, entry, "level"), "info"));
    switch (testReceipt) {
    case TEST_LOST: return FALSE;
    case TEST_DENIED: return test_response(reply, 403, NULL, limit);
    case TEST_COUNT_ONLY: return test_response(reply, 200, "{\"accepted\":1}", limit);
    case TEST_OTHER_SCOPE: lstrcpyA(browser, "other.browser"); break;
    case TEST_WRONG_BATCH: lstrcpyA(batch, "00000000-0000-4000-8000-999999999999"); break;
    case TEST_WRONG_EVENT: lstrcpyA(event, "00000000-0000-4000-8000-999999999999"); break;
    case TEST_EXTRA_ID: extra = ",\"00000000-0000-4000-8000-999999999999\""; break;
    default: break;
    }
    wsprintfA(output, "{\"scope\":{\"mode\":\"native_browser\",\"version\":\"%s\",\"device_id\":\"%s\","
        "\"browser_id\":\"%s\",\"launch_id\":\"%s\"},\"batch_id\":\"%s\",\"accepted_event_ids\":[\"%s\"%s]}",
        version, device, browser, launch, batch, event, extra);
    return test_response(reply, 200, output, limit);
}

static BOOL test_run(const WCHAR *dir, BOOL capture) {
    return cx_ordinary_receipts_pump(dir, TEST_BASE, TEST_KEY, TEST_PROOF, TEST_DEVICE,
        capture ? TEST_BROWSER : NULL, capture ? TEST_VERSION : NULL, capture);
}
static BOOL test_read(const WCHAR *dir) {
    WCHAR path[MAX_PATH];
    HANDLE file;
    DWORD count = 0;
    CHECK(lstrlenW(dir) + 40 < MAX_PATH);
    wsprintfW(path, L"%s\\%s", dir, TEST_OUTBOX);
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) { CHECK(GetLastError() == ERROR_FILE_NOT_FOUND); return FALSE; }
    CHECK(ReadFile(file, testDisk, (DWORD)sizeof(testDisk) - 1, &count, NULL) && count > 0 && count < sizeof(testDisk) - 1);
    CHECK(CloseHandle(file));
    testDisk[count] = 0;
    return TRUE;
}
static BOOL test_contains(const char *text, const char *needle) {
    int i;
    for (; *text; ++text) {
        for (i = 0; needle[i] && text[i] == needle[i]; ++i) {}
        if (!needle[i]) return TRUE;
    }
    return FALSE;
}
static void test_pending(const WCHAR *dir) {
    CHECK(test_read(dir));
    CHECK(test_contains(testDisk, testOriginal));
    CHECK(!test_contains(testDisk, "synthetic-ordinary-api-key"));
    CHECK(!test_contains(testDisk, "agd_"));
    CHECK(!test_contains(testDisk, "ordinary-fixture.invalid"));
}
static void test_cold(const WCHAR *dir) {
    int i;
    char *start, *end;
    CHECK(testPosts == 0 && testUUID == 0 && test_read(dir));
    start = testDisk;
    while (*start && *start != '\n') ++start;
    CHECK(*start++ == '\n');
    end = start;
    while (*end && *end != '\n') ++end;
    CHECK(end - start > 0 && end - start < (int)sizeof(testOriginal));
    for (i = 0; start + i < end; ++i) testOriginal[i] = start[i];
    testOriginal[i] = 0;
    testReceipt = TEST_MATCH;
    CHECK(test_run(dir, FALSE) && testPosts == 1 && testUUID == 0 && !test_read(dir));
    test_text("cold child replay matched exact stored packet and retired it\r\n");
}
static void test_cold_process(const WCHAR *dir) {
    WCHAR path[MAX_PATH], args[MAX_PATH * 2];
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    DWORD result = 0;
    CHECK(GetModuleFileNameW(NULL, path, ARRAYSIZE(path)) > 0);
    wsprintfW(args, L"\"%s\" --cold \"%s\"", path, dir);
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    CHECK(CreateProcessW(path, args, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi));
    CHECK(WaitForSingleObject(pi.hProcess, 10000) == WAIT_OBJECT_0);
    CHECK(GetExitCodeProcess(pi.hProcess, &result) && result == 0);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    CHECK(!test_read(dir));
}

void WINAPI OrdinaryReceiptsTestMain(void) {
    WCHAR temp[MAX_PATH], dir[MAX_PATH];
    WCHAR **argv;
    int argc, posts, i;
    static const TEST_RESULT mismatched[] = {TEST_OTHER_SCOPE, TEST_COUNT_ONLY, TEST_EXTRA_ID, TEST_WRONG_BATCH, TEST_WRONG_EVENT};

    argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    CHECK(argv);
    if (argc == 3 && !lstrcmpW(argv[1], L"--cold")) {
        test_cold(argv[2]);
        LocalFree(argv);
        ExitProcess(0);
    }
    CHECK(argc == 1);
    LocalFree(argv);
    CHECK(GetTempPathW(ARRAYSIZE(temp), temp) > 0 && lstrlenW(temp) < MAX_PATH - 64);
    wsprintfW(dir, L"%sCX-ordinary-receipts-fixture-%u-%u", temp, GetCurrentProcessId(), GetTickCount());
    CHECK(CreateDirectoryW(dir, NULL));

    CHECK(!test_run(dir, FALSE) && !test_read(dir) && testPosts == 0);
    testPolicy = TEST_UNKNOWN;
    CHECK(!test_run(dir, TRUE) && !test_read(dir) && testPosts == 0);
    testPolicy = TEST_BAD_POLICY;
    CHECK(!test_run(dir, TRUE) && !test_read(dir) && testPosts == 0);
    testPolicy = TEST_DENIED;
    CHECK(!test_run(dir, TRUE) && !test_read(dir) && testPosts == 0);
    testPolicy = TEST_DISABLED;
    CHECK(!test_run(dir, TRUE) && !test_read(dir) && testPosts == 0);

    testPolicy = TEST_MATCH;
    CHECK(!test_run(dir, TRUE) && testPosts == 1);
    lstrcpyA(testOriginal, testLast);
    test_pending(dir);
    for (i = 0; i < ARRAYSIZE(mismatched); ++i) {
        testReceipt = mismatched[i];
        posts = testPosts;
        CHECK(!test_run(dir, FALSE) && testPosts == posts + 1);
        test_pending(dir);
    }
    testPolicy = TEST_UNKNOWN;
    posts = testPosts;
    CHECK(!test_run(dir, TRUE) && testPosts == posts);
    test_pending(dir);
    test_cold_process(dir);
    testOriginal[0] = 0;

    testPolicy = TEST_MATCH;
    testReceipt = TEST_LOST;
    CHECK(!test_run(dir, TRUE) && test_read(dir));
    posts = testPosts;
    testPolicy = TEST_DISABLED;
    CHECK(!test_run(dir, TRUE) && !test_read(dir) && testPosts == posts);
    testPolicy = TEST_MATCH;
    CHECK(!test_run(dir, TRUE) && test_read(dir));
    testReceipt = TEST_DENIED;
    CHECK(!test_run(dir, FALSE) && !test_read(dir));

    testReceipt = TEST_LOST;
    CHECK(!test_run(dir, TRUE) && test_read(dir));
    posts = testPosts;
    testAdvance = TEST_DAY;
    CHECK(!test_run(dir, FALSE) && !test_read(dir) && testPosts == posts);
    testAdvance = 0;

    CHECK(!test_run(dir, TRUE) && test_read(dir));
    posts = testPosts;
    testAuth = L"Bearer synthetic-foreign-account";
    CHECK(!cx_ordinary_receipts_pump(dir, TEST_BASE, L"synthetic-foreign-account", TEST_PROOF, TEST_DEVICE,
        NULL, NULL, FALSE) && !test_read(dir) && testPosts == posts);
    testAuth = TEST_AUTH;
    CHECK(!test_run(dir, TRUE) && test_read(dir));
    posts = testPosts;
    testBase = L"https://other-fixture.invalid/tenant";
    CHECK(!cx_ordinary_receipts_pump(dir, testBase, TEST_KEY, TEST_PROOF, TEST_DEVICE, NULL, NULL, FALSE)
        && !test_read(dir) && testPosts == posts);
    testBase = TEST_BASE;
    CHECK(!test_run(dir, TRUE) && test_read(dir));
    posts = testPosts;
    CHECK(!cx_ordinary_receipts_pump(dir, TEST_BASE, TEST_KEY, TEST_PROOF, L"foreign-device", NULL, NULL, FALSE)
        && !test_read(dir) && testPosts == posts);

    CHECK(!test_run(dir, TRUE) && test_read(dir));
    lstrcpyA(testOriginal, testLast);
    for (i = 0; i < 68; ++i) CHECK(!test_run(dir, TRUE));
    CHECK(test_read(dir));
    for (i = 0, posts = 0; testDisk[i]; ++i) if (testDisk[i] == '\n') ++posts;
    CHECK(posts == 65);
    testPolicy = TEST_DENIED;
    CHECK(!test_run(dir, FALSE) && !test_read(dir));
    CHECK(RemoveDirectoryW(dir));
    test_text("ordinary native receipts: policy, fixed safe data, exact receipts, cold retry, denial, scope, 24h and cap passed\r\n");
    ExitProcess(0);
}
