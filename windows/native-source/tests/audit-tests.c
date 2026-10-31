#include "../audit.h"

static DWORD failures;
static WCHAR testRoot[CX_OPTIONS_PATH_CAP];
static WCHAR errorText[256];

static void output(const char *text) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, lstrlenA(text), &written, NULL);
}
static void check(const char *name, BOOL ok) {
    output(ok ? "PASS " : "FAIL "); output(name); output("\n");
    if (!ok) ++failures;
}
static void path(WCHAR *out, const WCHAR *suffix) {
    lstrcpyW(out, testRoot); lstrcatW(out, L"\\"); lstrcatW(out, suffix);
}
static CX_OPTIONS *options(const WCHAR *suffix) {
    CX_OPTIONS *o = (CX_OPTIONS *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(CX_OPTIONS));
    if (!o) ExitProcess(3);
    path(o->dataDir, suffix); o->logFileEnabled = TRUE; o->quiet = TRUE;
    return o;
}
static char *read_file(const WCHAR *name) {
    HANDLE file = CreateFileW(name, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    char *text; DWORD size, got;
    if (file == INVALID_HANDLE_VALUE) return NULL;
    size = GetFileSize(file, NULL);
    if (size == INVALID_FILE_SIZE || size > 65536) { CloseHandle(file); return NULL; }
    text = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size + 1);
    if (!text || !ReadFile(file, text, size, &got, NULL) || got != size) {
        if (text) HeapFree(GetProcessHeap(), 0, text);
        text = NULL;
    }
    CloseHandle(file); return text;
}
static BOOL contains(const char *text, const char *part) {
    DWORD i, j;
    if (!text) return FALSE;
    for (i = 0; text[i]; ++i) {
        for (j = 0; part[j] && text[i + j] == part[j]; ++j) {}
        if (!part[j]) return TRUE;
    }
    return FALSE;
}
static BOOL exists(const WCHAR *name) { return GetFileAttributesW(name) != INVALID_FILE_ATTRIBUTES; }
static CX_AUDIT_REPORT report(void) {
    CX_AUDIT_REPORT r;
    ZeroMemory(&r, sizeof(r));
    r.durationMs = 123; r.clientPid = 456; r.port = 9222;
    r.contexts = 7; r.bootstraps = 6; r.bundles = 5; r.errors = 4;
    r.reconnects = 3; r.pageSessions = 2; r.success = TRUE; r.ownershipVerified = TRUE;
    r.injectStrategy = "hybrid"; r.stopReason = "duration\"\\\n\t\001";
    r.endpointProbe.attempts = 3; r.endpointProbe.elapsedMs = 50;
    r.endpointProbe.listenerSeen = TRUE; r.endpointProbe.ownershipVerified = TRUE;
    r.endpointProbe.versionResponseReceived = TRUE; r.endpointProbe.lastReason = CX_ENDPOINT_READY;
    r.endpointProbe.reasonCounts[CX_ENDPOINT_NO_LISTENER] = 1;
    r.endpointProbe.reasonCounts[CX_ENDPOINT_HTTP_FAILED] = 1;
    r.endpointProbe.reasonCounts[CX_ENDPOINT_READY] = 1;
    return r;
}
static void test_files(void) {
    CX_OPTIONS *o = options(L"unicode \x5BA1\x8BA1\\nested");
    CX_AUDIT *a, *b; CX_AUDIT_REPORT r = report(); char *text; WCHAR *first;
    first = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, 32768 * sizeof(WCHAR));
    if (!first) ExitProcess(3);
    path(o->reportPath, L"reports \x4E2D\x6587\\nested\\run.json");
    a = cx_audit_create(o, errorText, 256);
    check("create nested Unicode log directory", a && !errorText[0] && exists(cx_audit_log_path(a)));
    lstrcpyW(first, cx_audit_log_path(a));
    b = cx_audit_create(o, errorText, 256);
    check("log filenames never overwrite another session", a && b && lstrcmpW(first, cx_audit_log_path(b)) != 0 && exists(first));
    check("quiet mode still writes the UTF-8 log", cx_audit_log(a, "info", "session", "safe \xE4\xB8\xAD\xE6\x96\x87\nnext", errorText, 256));
    cx_audit_close(a); cx_audit_close(b);
    text = read_file(first);
    check("log is one UTC UTF-8 line without BOM", text && text[0] == '2' && contains(text, "Z [info] [session] safe \xE4\xB8\xAD\xE6\x96\x87 next\n") && !contains(text, "\r"));
    if (text) HeapFree(GetProcessHeap(), 0, text);
    a = cx_audit_create(o, errorText, 256);
    check("write complete report into nested Unicode path", cx_audit_write_report(a, &r, errorText, 256));
    text = read_file(o->reportPath);
    check("report contains metadata and escaped stop reason", contains(text, "\"version\":\"0.1.0\"") && contains(text, "\"host\":\"native\"") && contains(text, "\"startedAt\":\"2") && contains(text, "\"finishedAt\":\"2") && contains(text, "duration\\\"\\\\\\n\\t\\u0001"));
    check("report contains only fixed endpoint reason codes and bounded counters", contains(text, "\"endpointProbe\":{\"attempts\":3,\"elapsedMs\":50")
        && contains(text, "\"lastReason\":\"ready\"") && contains(text, "\"no-listener\":1")
        && contains(text, "\"http-failed\":1") && contains(text, "\"ready\":1")
        && lstrcmpA(cx_endpoint_reason_name((CX_ENDPOINT_REASON)999), "not-started") == 0);
    if (text) HeapFree(GetProcessHeap(), 0, text);
    cx_audit_close(a); HeapFree(GetProcessHeap(), 0, first); HeapFree(GetProcessHeap(), 0, o);
}
static void test_policy(void) {
    CX_OPTIONS *o = options(L"no-disk"); CX_AUDIT *a; CX_AUDIT_REPORT r = report();
    path(o->reportPath, L"no-disk-report\\run.json"); o->noDiskWrite = TRUE;
    a = cx_audit_create(o, errorText, 256);
    check("noDiskWrite allows audit calls without a log path", a && !cx_audit_log_path(a)[0] && cx_audit_log(a, "info", "policy", "safe", errorText, 256) && cx_audit_write_report(a, &r, errorText, 256));
    check("noDiskWrite creates no directories or report", !exists(o->dataDir) && !exists(o->reportPath));
    cx_audit_close(a);
    o->noDiskWrite = FALSE; o->logFileEnabled = FALSE;
    path(o->dataDir, L"disabled-log"); path(o->reportPath, L"report-only\\run.json");
    a = cx_audit_create(o, errorText, 256);
    check("disabled logging does not disable independent reports", a && !cx_audit_log_path(a)[0] && cx_audit_write_report(a, &r, errorText, 256) && exists(o->reportPath) && !exists(o->dataDir));
    cx_audit_close(a); HeapFree(GetProcessHeap(), 0, o);
}
static void test_relative_attach(void) {
    CX_OPTIONS *o = options(L"unused"); CX_AUDIT *a; CX_AUDIT_REPORT r = report();
    WCHAR *previous = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, 32768 * sizeof(WCHAR));
    if (!previous || !GetCurrentDirectoryW(32768, previous) || !SetCurrentDirectoryW(testRoot)) ExitProcess(3);
    lstrcpyW(o->dataDir, L"relative data"); lstrcpyW(o->reportPath, L"relative report\\attach.json"); r.attached = TRUE;
    a = cx_audit_create(o, errorText, 256);
    check("relative paths resolve from the working directory", a && exists(cx_audit_log_path(a)) && cx_audit_log_path(a)[1] == L':' && cx_audit_write_report(a, &r, errorText, 256) && exists(o->reportPath));
    cx_audit_close(a); o->reportPath[0] = 0; o->logFileEnabled = FALSE;
    a = cx_audit_create(o, errorText, 256);
    check("empty report path leaves report output disabled", a && cx_audit_write_report(a, &r, errorText, 256));
    cx_audit_close(a); SetCurrentDirectoryW(previous);
    HeapFree(GetProcessHeap(), 0, previous); HeapFree(GetProcessHeap(), 0, o);
}
static void test_write_failure(void) {
    CX_OPTIONS *o = options(L"write-failure"); CX_AUDIT *a; HANDLE reader; OVERLAPPED lock;
    DWORD code, size; BOOL locked, first, second;
    o->quiet = FALSE;
    a = cx_audit_create(o, errorText, 256);
    if (!a || !cx_audit_log_path(a)[0]) { check("prepare real locked log file", FALSE); cx_audit_close(a); HeapFree(GetProcessHeap(), 0, o); return; }
    reader = CreateFileW(cx_audit_log_path(a), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    ZeroMemory(&lock, sizeof(lock));
    locked = reader != INVALID_HANDLE_VALUE && LockFileEx(reader, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 65536, 0, &lock);
    check("prepare real locked log file", locked);
    first = cx_audit_log(a, "warn", "locked", "safe", errorText, 256); code = errorText[0];
    if (locked) UnlockFileEx(reader, 0, 65536, 0, &lock);
    second = cx_audit_log(a, "info", "after-failure", "safe", errorText, 256);
    size = reader != INVALID_HANDLE_VALUE ? GetFileSize(reader, NULL) : INVALID_FILE_SIZE;
    check("write failure disables the file without retrying later events", locked && !first && code && second && !errorText[0] && size == 0);
    if (reader != INVALID_HANDLE_VALUE) CloseHandle(reader);
    cx_audit_close(a); HeapFree(GetProcessHeap(), 0, o);
}
static void test_failures(void) {
    CX_OPTIONS *o = options(L"blocked-parent\\child"); CX_AUDIT *a; CX_AUDIT_REPORT r = report();
    WCHAR *blocked = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, CX_OPTIONS_PATH_CAP * sizeof(WCHAR));
    HANDLE file; char *text;
    if (!blocked) ExitProcess(3);
    o->quiet = FALSE;
    path(blocked, L"blocked-parent");
    file = CreateFileW(blocked, GENERIC_WRITE, 0, NULL, CREATE_NEW, 0, NULL);
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    a = cx_audit_create(o, errorText, 256);
    check("log open failure returns a usable audit with an error", a && errorText[0] && !cx_audit_log_path(a)[0]);
    check("log open failure never blocks later console events", cx_audit_log(a, "warn", "file", "safe", errorText, 256));
    cx_audit_close(a);
    o->logFileEnabled = FALSE; path(o->reportPath, L"blocked-parent\\report.json");
    a = cx_audit_create(o, errorText, 256);
    check("bad report parent returns a bounded failure", a && !cx_audit_write_report(a, &r, errorText, 256) && errorText[0]);
    cx_audit_close(a);
    path(o->reportPath, L"preserved.json");
    file = CreateFileW(o->reportPath, GENERIC_WRITE, 0, NULL, CREATE_NEW, 0, NULL);
    if (file != INVALID_HANDLE_VALUE) { DWORD written; WriteFile(file, "original", 8, &written, NULL); CloseHandle(file); }
    a = cx_audit_create(o, errorText, 256); r.stopReason = "\xc0\xaf";
    check("invalid UTF-8 report fails before opening output", !cx_audit_write_report(a, &r, errorText, 256) && errorText[0]);
    text = read_file(o->reportPath);
    check("generation failure preserves the previous report", text && lstrcmpA(text, "original") == 0);
    if (text) HeapFree(GetProcessHeap(), 0, text);
    cx_audit_close(a); HeapFree(GetProcessHeap(), 0, blocked); HeapFree(GetProcessHeap(), 0, o);
}
void WINAPI AuditTestMain(void) {
    WCHAR mode[32];
    if (!GetEnvironmentVariableW(L"CX_AUDIT_TEST_DIR", testRoot, CX_OPTIONS_PATH_CAP)) ExitProcess(2);
    mode[0] = 0;
    GetEnvironmentVariableW(L"CX_AUDIT_TEST_MODE", mode, 32);
    if (lstrcmpW(mode, L"console") == 0 || lstrcmpW(mode, L"quiet") == 0) {
        CX_OPTIONS *o = options(L"console"); CX_AUDIT *a;
        o->quiet = lstrcmpW(mode, L"quiet") == 0; o->logFileEnabled = FALSE;
        a = cx_audit_create(o, errorText, 256);
        if (!a || !cx_audit_log(a, "warn", "lifecycle", "fixed event", errorText, 256)) ExitProcess(1);
        cx_audit_close(a); HeapFree(GetProcessHeap(), 0, o); ExitProcess(0);
    }
    test_files(); test_policy(); test_relative_attach(); test_write_failure(); test_failures();
    output(failures ? "AUDIT SELF-TEST FAIL\n" : "AUDIT SELF-TEST PASS\n"); ExitProcess(failures ? 1 : 0);
}
