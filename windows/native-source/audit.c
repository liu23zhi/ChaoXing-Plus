#include "audit.h"

#define CX_AUDIT_PATH_CAP 32768
#define CX_AUDIT_LINE_CAP 4096
#define CX_AUDIT_REPORT_CAP 32768
#define CX_AUDIT_STRING_LIMIT 4096

struct CX_AUDIT {
    HANDLE file;
    BOOL quiet;
    BOOL noDiskWrite;
    BOOL reportPathInvalid;
    WCHAR logPath[CX_AUDIT_PATH_CAP];
    WCHAR reportPath[CX_AUDIT_PATH_CAP];
    char startedAt[25];
};

typedef struct {
    char *text;
    DWORD used;
    DWORD capacity;
    BOOL valid;
} CX_AUDIT_TEXT;

static void clear_error(WCHAR *error, DWORD cap) {
    if (error && cap) error[0] = 0;
}
static BOOL fail(WCHAR *error, DWORD cap, const WCHAR *message, DWORD code) {
    WCHAR digits[11]; DWORD i = 0, n;
    if (!error || !cap) return FALSE;
    lstrcpynW(error, message, (int)cap);
    if (!code) return FALSE;
    do { digits[i++] = (WCHAR)(L'0' + code % 10); code /= 10; } while (code);
    n = (DWORD)lstrlenW(error);
    while (i && n + 1 < cap) error[n++] = digits[--i];
    error[n] = 0;
    return FALSE;
}
static BOOL wide_append(WCHAR *out, DWORD cap, const WCHAR *text) {
    DWORD n = (DWORD)lstrlenW(out), m = (DWORD)lstrlenW(text);
    if (n >= cap || m >= cap - n) return FALSE;
    CopyMemory(out + n, text, (m + 1) * sizeof(WCHAR)); return TRUE;
}
static void put(CX_AUDIT_TEXT *out, char ch) {
    if (!out->valid) return;
    if (out->used + 1 >= out->capacity) { out->valid = FALSE; return; }
    out->text[out->used++] = ch; out->text[out->used] = 0;
}
static void append(CX_AUDIT_TEXT *out, const char *text) {
    while (text && *text) put(out, *text++);
}
static void number(CX_AUDIT_TEXT *out, DWORD value, DWORD width) {
    char digits[11]; DWORD count = 0;
    do { digits[count++] = (char)('0' + value % 10); value /= 10; } while (value);
    while (width > count) { put(out, '0'); --width; }
    while (count) put(out, digits[--count]);
}
static void stamp(char *out, BOOL filename) {
    SYSTEMTIME t; CX_AUDIT_TEXT text;
    GetSystemTime(&t);
    text.text = out; text.used = 0; text.capacity = 25; text.valid = TRUE; out[0] = 0;
    number(&text, t.wYear, 4); if (!filename) put(&text, '-');
    number(&text, t.wMonth, 2); if (!filename) put(&text, '-');
    number(&text, t.wDay, 2); put(&text, filename ? '-' : 'T');
    number(&text, t.wHour, 2); if (!filename) put(&text, ':');
    number(&text, t.wMinute, 2); if (!filename) put(&text, ':');
    number(&text, t.wSecond, 2); put(&text, '.'); number(&text, t.wMilliseconds, 3);
    put(&text, 'Z');
}
static BOOL utf8(const char *text, DWORD *length) {
    DWORD n = 0;
    if (!text) { *length = 0; return TRUE; }
    while (text[n] && n < CX_AUDIT_STRING_LIMIT) ++n;
    if (n >= CX_AUDIT_STRING_LIMIT) return FALSE;
    *length = n;
    return !n || MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, (int)n, NULL, 0) > 0;
}
static BOOL resolve_path(const WCHAR *input, WCHAR *out) {
    DWORD n = GetFullPathNameW(input, CX_AUDIT_PATH_CAP, out, NULL);
    return n && n < CX_AUDIT_PATH_CAP;
}
static BOOL is_separator(WCHAR ch) { return ch == L'\\' || ch == L'/'; }
static BOOL directory(const WCHAR *name) {
    DWORD attrs;
    if (CreateDirectoryW(name, NULL)) return TRUE;
    if (GetLastError() != ERROR_ALREADY_EXISTS) return FALSE;
    attrs = GetFileAttributesW(name);
    if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY)) return TRUE;
    SetLastError(ERROR_DIRECTORY); return FALSE;
}
static BOOL ensure_parent(const WCHAR *fullPath) {
    WCHAR *copy; DWORD i, start = 0, length = (DWORD)lstrlenW(fullPath); BOOL ok = TRUE;
    copy = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, (length + 1) * sizeof(WCHAR));
    if (!copy) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return FALSE; }
    CopyMemory(copy, fullPath, (length + 1) * sizeof(WCHAR));
    if (length > 2 && copy[1] == L':') start = 3;
    else if (length > 2 && is_separator(copy[0]) && is_separator(copy[1])) {
        start = 2;
        while (copy[start] && !is_separator(copy[start])) ++start;
        if (copy[start]) ++start;
        while (copy[start] && !is_separator(copy[start])) ++start;
        if (copy[start]) ++start;
    }
    for (i = start; i < length; ++i) {
        if (is_separator(copy[i]) && i && !is_separator(copy[i - 1])) {
            WCHAR separator = copy[i]; copy[i] = 0;
            ok = directory(copy); copy[i] = separator;
            if (!ok) break;
        }
    }
    {
        DWORD code = GetLastError();
        HeapFree(GetProcessHeap(), 0, copy); SetLastError(code);
    }
    return ok;
}
static BOOL write_all(HANDLE file, const char *text, DWORD length) {
    DWORD total = 0, written;
    while (total < length) {
        if (!WriteFile(file, text + total, length - total, &written, NULL)) return FALSE;
        if (!written) { SetLastError(ERROR_WRITE_FAULT); return FALSE; }
        total += written;
    }
    return TRUE;
}
static void console_line(const char *text, DWORD length) {
    HANDLE handle = GetStdHandle(STD_OUTPUT_HANDLE); DWORD mode, written;
    if (!handle || handle == INVALID_HANDLE_VALUE) return;
    if (GetConsoleMode(handle, &mode)) {
        int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, (int)length, NULL, 0);
        WCHAR *wide;
        if (count <= 0) return;
        wide = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, count * sizeof(WCHAR));
        if (!wide) return;
        if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, (int)length, wide, count))
            WriteConsoleW(handle, wide, (DWORD)count, &written, NULL);
        HeapFree(GetProcessHeap(), 0, wide);
    } else write_all(handle, text, length);
}
static BOOL open_log(CX_AUDIT *audit, const WCHAR *dataDir) {
    WCHAR *base; DWORD n, attempt, i; char name[96]; char time[25]; CX_AUDIT_TEXT out;
    BOOL ok = FALSE;
    base = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, CX_AUDIT_PATH_CAP * sizeof(WCHAR));
    if (!base) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return FALSE; }
    if (!resolve_path(dataDir[0] ? dataDir : L".data", base)
        || !wide_append(base, CX_AUDIT_PATH_CAP, L"\\" CX_HOST_DATA_SUBDIR L"\\logs\\")) goto done;
    n = (DWORD)lstrlenW(base); stamp(time, TRUE);
    for (attempt = 0; attempt < 32; ++attempt) {
        out.text = name; out.used = 0; out.capacity = sizeof(name); out.valid = TRUE; name[0] = 0;
        append(&out, "windows-host-"); append(&out, time); put(&out, '-'); number(&out, GetCurrentProcessId(), 0);
        if (attempt) { put(&out, '-'); number(&out, attempt, 0); }
        append(&out, ".log");
        if (n + out.used + 1 > CX_AUDIT_PATH_CAP) { SetLastError(ERROR_FILENAME_EXCED_RANGE); goto done; }
        CopyMemory(audit->logPath, base, n * sizeof(WCHAR));
        for (i = 0; i <= out.used; ++i) audit->logPath[n + i] = (WCHAR)(BYTE)name[i];
        if (!ensure_parent(audit->logPath)) goto done;
        audit->file = CreateFileW(audit->logPath, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
        if (audit->file != INVALID_HANDLE_VALUE) { ok = TRUE; break; }
        if (GetLastError() != ERROR_FILE_EXISTS && GetLastError() != ERROR_ALREADY_EXISTS) break;
    }
done:
    {
        DWORD code = GetLastError();
        if (!ok) audit->logPath[0] = 0;
        HeapFree(GetProcessHeap(), 0, base); SetLastError(code);
    }
    return ok;
}
CX_AUDIT *cx_audit_create(const CX_OPTIONS *options, WCHAR *error, DWORD errorCap) {
    CX_AUDIT *audit;
    clear_error(error, errorCap);
    if (!options) { fail(error, errorCap, L"Audit options are required.", 0); return NULL; }
    audit = (CX_AUDIT *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(CX_AUDIT));
    if (!audit) { fail(error, errorCap, L"Unable to allocate audit state.", 0); return NULL; }
    audit->file = INVALID_HANDLE_VALUE; audit->quiet = options->quiet; audit->noDiskWrite = options->noDiskWrite;
    stamp(audit->startedAt, FALSE);
    if (audit->noDiskWrite) return audit;
    if (options->reportPath[0] && !resolve_path(options->reportPath, audit->reportPath)) {
        audit->reportPathInvalid = TRUE;
        fail(error, errorCap, L"Unable to resolve audit report path. Windows error ", GetLastError());
    }
    if (options->logFileEnabled && !open_log(audit, options->dataDir))
        fail(error, errorCap, L"Unable to create audit log file. Windows error ", GetLastError());
    return audit;
}
static void single_line(CX_AUDIT_TEXT *out, const char *text, DWORD limit) {
    DWORD i;
    for (i = 0; text && text[i] && i < limit; ++i) {
        BYTE ch = (BYTE)text[i];
        put(out, ch < 32 || ch == 127 ? ' ' : (char)ch);
    }
}
BOOL cx_audit_log(CX_AUDIT *audit, const char *level, const char *event,
                  const char *message, WCHAR *error, DWORD errorCap) {
    CX_AUDIT_TEXT out; char *line; char time[25]; DWORD length, levelLength, eventLength, code;
    clear_error(error, errorCap);
    if (!audit || !utf8(level, &levelLength) || !utf8(event, &eventLength) || !utf8(message, &length)
        || levelLength > 32 || eventLength > 96 || length > 3500)
        return fail(error, errorCap, L"Audit event must be bounded UTF-8 text.", 0);
    line = (char *)HeapAlloc(GetProcessHeap(), 0, CX_AUDIT_LINE_CAP);
    if (!line) return fail(error, errorCap, L"Unable to allocate audit line.", 0);
    out.text = line; out.used = 0; out.capacity = CX_AUDIT_LINE_CAP; out.valid = TRUE; line[0] = 0;
    stamp(time, FALSE); append(&out, time); append(&out, " ["); single_line(&out, level, 32);
    append(&out, "] ["); single_line(&out, event, 96); append(&out, "] "); single_line(&out, message, 3500); put(&out, '\n');
    if (!audit->quiet) console_line(line, out.used);
    if (audit->file != INVALID_HANDLE_VALUE && !write_all(audit->file, line, out.used)) {
        code = GetLastError(); CloseHandle(audit->file); audit->file = INVALID_HANDLE_VALUE;
        HeapFree(GetProcessHeap(), 0, line);
        return fail(error, errorCap, L"Audit log file was disabled after a write failure. Windows error ", code);
    }
    HeapFree(GetProcessHeap(), 0, line); return TRUE;
}
static void json_string(CX_AUDIT_TEXT *out, const char *value) {
    DWORD n, i; static const char hex[] = "0123456789abcdef";
    if (!utf8(value, &n)) { out->valid = FALSE; return; }
    put(out, '"');
    for (i = 0; i < n; ++i) {
        BYTE ch = (BYTE)value[i];
        if (ch == '"' || ch == '\\') { put(out, '\\'); put(out, (char)ch); }
        else if (ch == '\n') append(out, "\\n");
        else if (ch == '\r') append(out, "\\r");
        else if (ch == '\t') append(out, "\\t");
        else if (ch < 32) { append(out, "\\u00"); put(out, hex[ch >> 4]); put(out, hex[ch & 15]); }
        else put(out, (char)ch);
    }
    put(out, '"');
}
static void json_number(CX_AUDIT_TEXT *out, const char *key, DWORD value) {
    put(out, ','); json_string(out, key); put(out, ':'); number(out, value, 0);
}
static void json_bool(CX_AUDIT_TEXT *out, const char *key, BOOL value) {
    put(out, ','); json_string(out, key); put(out, ':'); append(out, value ? "true" : "false");
}
const char *cx_endpoint_reason_name(CX_ENDPOINT_REASON reason) {
    switch (reason) {
        case CX_ENDPOINT_NO_LISTENER: return "no-listener";
        case CX_ENDPOINT_LISTENER_NOT_OWNED: return "listener-not-owned";
        case CX_ENDPOINT_LISTENER_QUERY_FAILED: return "listener-query-failed";
        case CX_ENDPOINT_LISTENER_BINDING_REJECTED: return "listener-binding-rejected";
        case CX_ENDPOINT_HTTP_FAILED: return "http-failed";
        case CX_ENDPOINT_INVALID_VERSION: return "invalid-version";
        case CX_ENDPOINT_BROWSER_MISMATCH: return "browser-mismatch";
        case CX_ENDPOINT_READY: return "ready";
        default: return "not-started";
    }
}
static void json_endpoint_probe(CX_AUDIT_TEXT *out, const CX_ENDPOINT_PROBE *probe) {
    DWORD reason;
    append(out, ",\"endpointProbe\":{\"attempts\":"); number(out, probe->attempts, 0);
    json_number(out, "elapsedMs", probe->elapsedMs);
    json_bool(out, "listenerSeen", probe->listenerSeen);
    json_bool(out, "ownershipVerified", probe->ownershipVerified);
    json_bool(out, "versionResponseReceived", probe->versionResponseReceived);
    append(out, ",\"lastReason\":"); json_string(out, cx_endpoint_reason_name(probe->lastReason));
    append(out, ",\"reasonCounts\":{");
    for (reason = CX_ENDPOINT_NO_LISTENER; reason < CX_ENDPOINT_REASON_COUNT; ++reason) {
        if (reason != CX_ENDPOINT_NO_LISTENER) put(out, ',');
        json_string(out, cx_endpoint_reason_name((CX_ENDPOINT_REASON)reason)); put(out, ':');
        number(out, probe->reasonCounts[reason], 0);
    }
    append(out, "}}");
}
BOOL cx_audit_write_report(CX_AUDIT *audit, const CX_AUDIT_REPORT *report,
                           WCHAR *error, DWORD errorCap) {
    char *buffer, finishedAt[25]; CX_AUDIT_TEXT out; HANDLE file; BOOL ok; DWORD code;
    clear_error(error, errorCap);
    if (!audit || !report) return fail(error, errorCap, L"Audit state and report are required.", 0);
    if (audit->noDiskWrite) return TRUE;
    if (audit->reportPathInvalid) return fail(error, errorCap, L"Audit report path is invalid.", 0);
    if (!audit->reportPath[0]) return TRUE;
    buffer = (char *)HeapAlloc(GetProcessHeap(), 0, CX_AUDIT_REPORT_CAP);
    if (!buffer) return fail(error, errorCap, L"Unable to allocate audit report.", 0);
    out.text = buffer; out.used = 0; out.capacity = CX_AUDIT_REPORT_CAP; out.valid = TRUE; buffer[0] = 0;
    stamp(finishedAt, FALSE);
    append(&out, "{\"version\":\"6.2.0\",\"host\":\"native\",\"startedAt\":"); json_string(&out, audit->startedAt);
    append(&out, ",\"finishedAt\":"); json_string(&out, finishedAt);
    append(&out, ",\"mode\":"); json_string(&out, report->attached ? "attach" : "launch");
    json_number(&out, "durationMs", report->durationMs); json_number(&out, "clientPid", report->clientPid);
    json_number(&out, "port", report->port); json_bool(&out, "attached", report->attached);
    json_bool(&out, "ownershipVerified", report->ownershipVerified); json_bool(&out, "success", report->success);
    append(&out, ",\"executionMode\":"); json_string(&out, report->executionMode ? report->executionMode : "normal");
    append(&out, ",\"injectStrategy\":"); json_string(&out, report->injectStrategy);
    append(&out, ",\"stopReason\":"); json_string(&out, report->stopReason);
    append(&out, ",\"injectMode\":"); json_string(&out, report->injectMode ? report->injectMode : "unknown");
    append(&out, ",\"commandLineInjected\":"); append(&out, report->commandLineInjected ? "true" : "false");
    json_endpoint_probe(&out, &report->endpointProbe);
    append(&out, ",\"totals\":{\"contexts\":"); number(&out, report->contexts, 0);
    json_number(&out, "bootstraps", report->bootstraps); json_number(&out, "bundles", report->bundles);
    json_number(&out, "errors", report->errors); json_number(&out, "reconnects", report->reconnects);
    json_number(&out, "pageSessions", report->pageSessions); append(&out, "}}\n");
    if (!out.valid) {
        HeapFree(GetProcessHeap(), 0, buffer);
        return fail(error, errorCap, L"Audit report exceeds its limit or contains invalid UTF-8.", 0);
    }
    if (!ensure_parent(audit->reportPath)) {
        code = GetLastError(); HeapFree(GetProcessHeap(), 0, buffer);
        return fail(error, errorCap, L"Unable to create audit report directory. Windows error ", code);
    }
    file = CreateFileW(audit->reportPath, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        code = GetLastError(); HeapFree(GetProcessHeap(), 0, buffer);
        return fail(error, errorCap, L"Unable to create audit report. Windows error ", code);
    }
    ok = write_all(file, buffer, out.used); code = GetLastError();
    CloseHandle(file); HeapFree(GetProcessHeap(), 0, buffer);
    if (!ok) return fail(error, errorCap, L"Unable to write audit report. Windows error ", code);
    return TRUE;
}
void cx_audit_close(CX_AUDIT *audit) {
    if (!audit) return;
    if (audit->file != INVALID_HANDLE_VALUE) CloseHandle(audit->file);
    HeapFree(GetProcessHeap(), 0, audit);
}
const WCHAR *cx_audit_log_path(const CX_AUDIT *audit) { return audit ? audit->logPath : L""; }

