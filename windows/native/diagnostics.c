#include "diagnostics.h"
#include "json.h"

#define CX_DIAGNOSTICS_PATH_CAP 32768
#define CX_DIAGNOSTICS_JSON_CAP 65536

struct CX_DIAGNOSTICS {
    BOOL enabled;
    BOOL pathReady;
    BOOL temporaryOwned;
    WCHAR outputPath[CX_DIAGNOSTICS_PATH_CAP];
    WCHAR temporaryPath[CX_DIAGNOSTICS_PATH_CAP];
};

static void clear_error(WCHAR *error, DWORD cap) {
    if (error && cap) error[0] = 0;
}

static BOOL fail(WCHAR *error, DWORD cap, const WCHAR *message, DWORD code) {
    WCHAR digits[11];
    DWORD i = 0, n;
    if (!error || !cap) return FALSE;
    lstrcpynW(error, message, (int)cap);
    if (!code) return FALSE;
    do {
        digits[i++] = (WCHAR)(L'0' + code % 10);
        code /= 10;
    } while (code && i < sizeof(digits) / sizeof(digits[0]));
    n = (DWORD)lstrlenW(error);
    while (i && n + 1 < cap) error[n++] = digits[--i];
    error[n] = 0;
    return FALSE;
}

static BOOL append_wide(WCHAR *out, DWORD cap, const WCHAR *text) {
    DWORD n = (DWORD)lstrlenW(out), m = (DWORD)lstrlenW(text);
    if (n >= cap || m >= cap - n) return FALSE;
    CopyMemory(out + n, text, (SIZE_T)(m + 1) * sizeof(WCHAR));
    return TRUE;
}

static BOOL append_number(WCHAR *out, DWORD cap, DWORD *used, DWORD value, DWORD width) {
    WCHAR digits[11];
    DWORD count = 0, target;
    do {
        digits[count++] = (WCHAR)(L'0' + value % 10);
        value /= 10;
    } while (value && count < sizeof(digits) / sizeof(digits[0]));
    target = width > count ? width : count;
    if (*used + target >= cap) return FALSE;
    while (target > count) { out[(*used)++] = L'0'; --target; }
    while (count) out[(*used)++] = digits[--count];
    out[*used] = 0;
    return TRUE;
}

static BOOL separator(WCHAR ch) {
    return ch == L'\\' || ch == L'/';
}

static BOOL create_directory(const WCHAR *path) {
    DWORD attributes;
    if (CreateDirectoryW(path, NULL)) return TRUE;
    if (GetLastError() != ERROR_ALREADY_EXISTS) return FALSE;
    attributes = GetFileAttributesW(path);
    if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY)) return TRUE;
    SetLastError(ERROR_DIRECTORY);
    return FALSE;
}

static BOOL ensure_parent_directories(const WCHAR *fullPath) {
    WCHAR *copy;
    DWORD i, start = 0, length = (DWORD)lstrlenW(fullPath);
    BOOL ok = TRUE;
    copy = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)(length + 1) * sizeof(WCHAR));
    if (!copy) {
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return FALSE;
    }
    CopyMemory(copy, fullPath, (SIZE_T)(length + 1) * sizeof(WCHAR));
    if (length > 2 && copy[1] == L':') start = 3;
    else if (length > 2 && separator(copy[0]) && separator(copy[1])) {
        start = 2;
        while (copy[start] && !separator(copy[start])) ++start;
        if (copy[start]) ++start;
        while (copy[start] && !separator(copy[start])) ++start;
        if (copy[start]) ++start;
    }
    for (i = start; i < length; ++i) {
        WCHAR saved;
        if (!separator(copy[i]) || !i || separator(copy[i - 1])) continue;
        saved = copy[i];
        copy[i] = 0;
        if (!create_directory(copy)) ok = FALSE;
        copy[i] = saved;
        if (!ok) break;
    }
    {
        DWORD code = GetLastError();
        HeapFree(GetProcessHeap(), 0, copy);
        SetLastError(code);
    }
    return ok;
}

static BOOL resolve_path(const WCHAR *input, WCHAR *out) {
    DWORD length = GetFullPathNameW(input, CX_DIAGNOSTICS_PATH_CAP, out, NULL);
    return length && length < CX_DIAGNOSTICS_PATH_CAP;
}

static BOOL make_run_directory(CX_DIAGNOSTICS *state, const WCHAR *base,
                               WCHAR *error, DWORD errorCap) {
    SYSTEMTIME now;
    WCHAR *candidate;
    WCHAR runName[96];
    DWORD baseLength, used, attempt;
    BOOL result = FALSE;
    GetSystemTime(&now);
    baseLength = (DWORD)lstrlenW(base);
    candidate = (WCHAR *)HeapAlloc(GetProcessHeap(), 0,
                                   (SIZE_T)CX_DIAGNOSTICS_PATH_CAP * sizeof(WCHAR));
    if (!candidate)
        return fail(error, errorCap, L"Unable to allocate render diagnostics directory path.", 0);

    for (attempt = 0; attempt < 1000; ++attempt) {
        runName[0] = 0;
        used = 0;
        if (!append_number(runName, (DWORD)(sizeof(runName) / sizeof(runName[0])), &used, now.wYear, 4))
            goto format_error;
        if (!append_number(runName, (DWORD)(sizeof(runName) / sizeof(runName[0])), &used, now.wMonth, 2)
            || !append_number(runName, (DWORD)(sizeof(runName) / sizeof(runName[0])), &used, now.wDay, 2)) goto format_error;
        if (used + 1 >= sizeof(runName) / sizeof(runName[0])) goto format_error;
        runName[used++] = L'T';
        if (!append_number(runName, (DWORD)(sizeof(runName) / sizeof(runName[0])), &used, now.wHour, 2)
            || !append_number(runName, (DWORD)(sizeof(runName) / sizeof(runName[0])), &used, now.wMinute, 2)
            || !append_number(runName, (DWORD)(sizeof(runName) / sizeof(runName[0])), &used, now.wSecond, 2)
            || !append_number(runName, (DWORD)(sizeof(runName) / sizeof(runName[0])), &used, now.wMilliseconds, 3)) goto format_error;
        if (used + 1 >= sizeof(runName) / sizeof(runName[0])) goto format_error;
        runName[used++] = L'Z';
        if (used + 1 >= sizeof(runName) / sizeof(runName[0])) goto format_error;
        runName[used++] = L'-';
        if (!append_number(runName, (DWORD)(sizeof(runName) / sizeof(runName[0])), &used, GetCurrentProcessId(), 0)) goto format_error;
        if (used + 1 >= sizeof(runName) / sizeof(runName[0])) goto format_error;
        runName[used++] = L'-';
        if (!append_number(runName, (DWORD)(sizeof(runName) / sizeof(runName[0])), &used, attempt, 0)) goto format_error;
        if (used >= sizeof(runName) / sizeof(runName[0])) goto format_error;
        runName[used] = 0;

        CopyMemory(candidate, base, (SIZE_T)baseLength * sizeof(WCHAR));
        used = baseLength;
        if (used && !separator(candidate[used - 1])) candidate[used++] = L'\\';
        if (used >= CX_DIAGNOSTICS_PATH_CAP) {
            fail(error, errorCap, L"Render diagnostics path is too long.", 0);
            goto done;
        }
        candidate[used] = 0;
        if (!append_wide(candidate, CX_DIAGNOSTICS_PATH_CAP, runName))
        {
            fail(error, errorCap, L"Render diagnostics path is too long.", 0);
            goto done;
        }
        if ((DWORD)lstrlenW(candidate) + (DWORD)lstrlenW(L"\\render-diagnostics.json.tmp")
            >= CX_DIAGNOSTICS_PATH_CAP)
        {
            fail(error, errorCap, L"Render diagnostics file path is too long.", 0);
            goto done;
        }
        if (CreateDirectoryW(candidate, NULL)) {
            CopyMemory(state->outputPath, candidate, ((SIZE_T)lstrlenW(candidate) + 1) * sizeof(WCHAR));
            CopyMemory(state->temporaryPath, candidate, ((SIZE_T)lstrlenW(candidate) + 1) * sizeof(WCHAR));
            if (!append_wide(state->outputPath, CX_DIAGNOSTICS_PATH_CAP, L"\\render-diagnostics.json")
                || !append_wide(state->temporaryPath, CX_DIAGNOSTICS_PATH_CAP, L"\\render-diagnostics.json.tmp"))
            {
                RemoveDirectoryW(candidate);
                fail(error, errorCap, L"Render diagnostics file path is too long.", 0);
                goto done;
            }
            state->pathReady = TRUE;
            result = TRUE;
            goto done;
        }
        if (GetLastError() != ERROR_ALREADY_EXISTS) {
            DWORD code = GetLastError();
            fail(error, errorCap, L"Unable to create render diagnostics directory. Windows error ", code);
            goto done;
        }
    }
    fail(error, errorCap, L"Unable to create a unique render diagnostics directory.", 0);
    goto done;
format_error:
    fail(error, errorCap, L"Unable to format render diagnostics directory.", 0);
done:
    HeapFree(GetProcessHeap(), 0, candidate);
    return result;
}

static void remove_run_directory(CX_DIAGNOSTICS *state) {
    DWORD length, i;
    WCHAR saved;
    if (!state) return;
    if (state->temporaryOwned && state->temporaryPath[0]) {
        if (DeleteFileW(state->temporaryPath) || GetLastError() == ERROR_FILE_NOT_FOUND)
            state->temporaryOwned = FALSE;
    }
    length = (DWORD)lstrlenW(state->outputPath);
    for (i = length; i > 0 && !separator(state->outputPath[i - 1]); --i) { }
    if (i > 0) {
        saved = state->outputPath[i - 1];
        state->outputPath[i - 1] = 0;
        RemoveDirectoryW(state->outputPath);
        state->outputPath[i - 1] = saved;
    }
    state->pathReady = FALSE;
    if (!state->temporaryOwned) {
        state->outputPath[0] = 0;
        state->temporaryPath[0] = 0;
    }
}

static BOOL fail_write(CX_DIAGNOSTICS *state, WCHAR *error, DWORD errorCap,
                       const WCHAR *message, DWORD code) {
    fail(error, errorCap, message, code);
    remove_run_directory(state);
    return FALSE;
}

static int diagnostic_key_count(const char *json, const JT *tokens, int object,
                                const char *key) {
    int i, count = 0;
    if (object < 0 || tokens[object].type != '{') return 0;
    for (i = object + 1; i < tokens[object].next;) {
        if (jeq(json, tokens, i, key)) ++count;
        i = tokens[i + 1].next;
    }
    return count;
}

static BOOL diagnostic_object_keys(const char *json, const JT *tokens, int object,
                                   const char *const *keys, int keyCount) {
    int i, j, members;
    if (object < 0 || tokens[object].type != '{' || (tokens[object].count & 1)) return FALSE;
    members = tokens[object].count / 2;
    if (members != keyCount) return FALSE;
    for (j = 0; j < keyCount; ++j) {
        if (diagnostic_key_count(json, tokens, object, keys[j]) != 1) return FALSE;
    }
    for (i = object + 1; i < tokens[object].next;) {
        BOOL known = FALSE;
        for (j = 0; j < keyCount; ++j) if (jeq(json, tokens, i, keys[j])) { known = TRUE; break; }
        if (!known || tokens[i].type != 's') return FALSE;
        i = tokens[i + 1].next;
    }
    return TRUE;
}

static BOOL diagnostic_decimal(const char *json, const JT *tokens, int index,
                               BOOL allowNegative, DWORD maxWhole,
                               DWORD *whole, DWORD *fraction, DWORD *scale,
                               BOOL *negative) {
    int p, end, digits = 0, fractionDigits = 0;
    DWORD value = 0, part = 0;
    BOOL minus = FALSE;
    if (index < 0 || tokens[index].type != 'p') return FALSE;
    p = tokens[index].start; end = tokens[index].end;
    if (p >= end) return FALSE;
    if (json[p] == '-') { minus = TRUE; ++p; if (!allowNegative) return FALSE; }
    if (p >= end || json[p] < '0' || json[p] > '9') return FALSE;
    while (p < end && json[p] >= '0' && json[p] <= '9') {
        if (++digits > 6) return FALSE;
        value = value * 10U + (DWORD)(json[p++] - '0');
    }
    if (p < end && json[p] == '.') {
        ++p;
        while (p < end && json[p] >= '0' && json[p] <= '9') {
            if (++fractionDigits > 6) return FALSE;
            part = part * 10U + (DWORD)(json[p++] - '0');
        }
        if (!fractionDigits) return FALSE;
    }
    if (p != end || value > maxWhole) return FALSE;
    while (fractionDigits < 6) { part *= 10U; ++fractionDigits; }
    *whole = value; *fraction = part; *scale = 1000000U; *negative = minus;
    return TRUE;
}

static BOOL diagnostic_number(const char *json, const JT *tokens, int index,
                              BOOL allowNegative, DWORD maxWhole) {
    DWORD whole, fraction, scale; BOOL negative;
    (void)scale;
    if (!diagnostic_decimal(json, tokens, index, allowNegative, maxWhole,
                            &whole, &fraction, &scale, &negative)) return FALSE;
    if (negative && whole == 0 && fraction == 0) return FALSE;
    return TRUE;
}

static BOOL diagnostic_bool(const char *json, const JT *tokens, int index) {
    return index >= 0 && tokens[index].type == 'p'
        && (jeq(json, tokens, index, "true") || jeq(json, tokens, index, "false"));
}

static BOOL diagnostic_string(const char *json, const JT *tokens, int index,
                              char *out, int capacity) {
    int i, length;
    if (!jstr(json, tokens, index, out, capacity)) return FALSE;
    length = 0; while (out[length]) ++length;
    if (length > 256) return FALSE;
    for (i = 0; i < length; ++i) {
        unsigned char c = (unsigned char)out[i];
        if (c < 0x20 || c >= 0x7f) return FALSE;
    }
    return TRUE;
}

static BOOL diagnostic_css_string(const char *json, const JT *tokens, int index) {
    char value[257]; int i;
    if (!diagnostic_string(json, tokens, index, value, sizeof(value))) return FALSE;
    for (i = 0; value[i]; ++i) {
        unsigned char c = (unsigned char)value[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
            || (c >= '0' && c <= '9') || c == ' ' || c == '.' || c == ','
            || c == '(' || c == ')' || c == '%' || c == '#' || c == '+' || c == '-')) return FALSE;
    }
    return TRUE;
}

static BOOL diagnostic_timestamp(const char *json, const JT *tokens, int index) {
    char value[32]; int i;
    if (!diagnostic_string(json, tokens, index, value, sizeof(value))) return FALSE;
    for (i = 0; value[i]; ++i) {
        BOOL digit = value[i] >= '0' && value[i] <= '9';
        BOOL punctuation = (i == 4 || i == 7) ? value[i] == '-'
            : (i == 10 ? value[i] == 'T' : (i == 13 || i == 16) ? value[i] == ':'
            : (i == 19 ? value[i] == '.' : (i == 23 ? value[i] == 'Z' : FALSE)));
        if (!digit && !punctuation) return FALSE;
    }
    return i == 24;
}

static BOOL diagnostic_validate_schema(const char *json, const JT *tokens) {
    static const char *const rootKeys[] = {
        "version", "host", "source", "collectedAt", "bundleLoaded", "devicePixelRatio",
        "innerWidth", "innerHeight", "visualViewport", "panelCount", "topPanel", "scope"
    };
    static const char *const viewportKeys[] = { "width", "height", "scale" };
    static const char *const panelKeys[] = { "visible", "rect", "fractionalDevicePixel", "style" };
    static const char *const rectKeys[] = { "x", "y", "width", "height" };
    static const char *const styleKeys[] = { "backdropFilter", "boxShadow", "transform", "backgroundColor" };
    static const char *const scopeKeys[] = { "pageOnly", "windowDpi", "screenshots" };
    int version, host, source, collectedAt, bundleLoaded, dpr, innerWidth, innerHeight;
    int viewport, panelCount, topPanel, scope, panelRect, fractional, style;
    if (!diagnostic_object_keys(json, tokens, 0, rootKeys, sizeof(rootKeys) / sizeof(rootKeys[0]))) return FALSE;
    version = jkey(json, tokens, 0, "version"); host = jkey(json, tokens, 0, "host");
    source = jkey(json, tokens, 0, "source"); collectedAt = jkey(json, tokens, 0, "collectedAt");
    bundleLoaded = jkey(json, tokens, 0, "bundleLoaded"); dpr = jkey(json, tokens, 0, "devicePixelRatio");
    innerWidth = jkey(json, tokens, 0, "innerWidth"); innerHeight = jkey(json, tokens, 0, "innerHeight");
    viewport = jkey(json, tokens, 0, "visualViewport"); panelCount = jkey(json, tokens, 0, "panelCount");
    topPanel = jkey(json, tokens, 0, "topPanel"); scope = jkey(json, tokens, 0, "scope");
    if (!jeq(json, tokens, version, "6.2.0") || !jeq(json, tokens, host, "native")
        || !jeq(json, tokens, source, "native-page") || !diagnostic_timestamp(json, tokens, collectedAt)
        || !diagnostic_bool(json, tokens, bundleLoaded) || !diagnostic_number(json, tokens, dpr, FALSE, 16)
        || !diagnostic_number(json, tokens, innerWidth, FALSE, 200000)
        || !diagnostic_number(json, tokens, innerHeight, FALSE, 200000)
        || !diagnostic_number(json, tokens, panelCount, FALSE, 64)) return FALSE;
    if (!diagnostic_object_keys(json, tokens, viewport, viewportKeys, 3)
        || !diagnostic_number(json, tokens, jkey(json, tokens, viewport, "width"), FALSE, 200000)
        || !diagnostic_number(json, tokens, jkey(json, tokens, viewport, "height"), FALSE, 200000)
        || !diagnostic_number(json, tokens, jkey(json, tokens, viewport, "scale"), FALSE, 16)) return FALSE;
    if (tokens[topPanel].type == 'p') {
        if (!jeq(json, tokens, topPanel, "null")) return FALSE;
    } else {
        if (!diagnostic_object_keys(json, tokens, topPanel, panelKeys, 4)) return FALSE;
        panelRect = jkey(json, tokens, topPanel, "rect"); fractional = jkey(json, tokens, topPanel, "fractionalDevicePixel"); style = jkey(json, tokens, topPanel, "style");
        if (!diagnostic_bool(json, tokens, jkey(json, tokens, topPanel, "visible"))
            || !diagnostic_object_keys(json, tokens, panelRect, rectKeys, 4)
            || !diagnostic_object_keys(json, tokens, fractional, rectKeys, 4)
            || !diagnostic_object_keys(json, tokens, style, styleKeys, 4)) return FALSE;
        if (!diagnostic_number(json, tokens, jkey(json, tokens, panelRect, "x"), TRUE, 20000)
            || !diagnostic_number(json, tokens, jkey(json, tokens, panelRect, "y"), TRUE, 20000)
            || !diagnostic_number(json, tokens, jkey(json, tokens, panelRect, "width"), FALSE, 200000)
            || !diagnostic_number(json, tokens, jkey(json, tokens, panelRect, "height"), FALSE, 200000)
            || !diagnostic_number(json, tokens, jkey(json, tokens, fractional, "x"), TRUE, 200000)
            || !diagnostic_number(json, tokens, jkey(json, tokens, fractional, "y"), TRUE, 200000)
            || !diagnostic_number(json, tokens, jkey(json, tokens, fractional, "width"), FALSE, 200000)
            || !diagnostic_number(json, tokens, jkey(json, tokens, fractional, "height"), FALSE, 200000)) return FALSE;
        if (!diagnostic_css_string(json, tokens, jkey(json, tokens, style, "backdropFilter"))
            || !diagnostic_css_string(json, tokens, jkey(json, tokens, style, "boxShadow"))
            || !diagnostic_css_string(json, tokens, jkey(json, tokens, style, "transform"))
            || !diagnostic_css_string(json, tokens, jkey(json, tokens, style, "backgroundColor"))) return FALSE;
    }
    if (!diagnostic_object_keys(json, tokens, scope, scopeKeys, 3)
        || !jeq(json, tokens, jkey(json, tokens, scope, "pageOnly"), "true")
        || !jeq(json, tokens, jkey(json, tokens, scope, "windowDpi"), "false")
        || !jeq(json, tokens, jkey(json, tokens, scope, "screenshots"), "false")) return FALSE;
    return TRUE;
}

CX_DIAGNOSTICS *cx_diagnostics_create(const CX_OPTIONS *options,
                                      WCHAR *error, DWORD errorCap) {
    CX_DIAGNOSTICS *state;
    WCHAR *base;
    const WCHAR *configured;
    clear_error(error, errorCap);
    if (!options) {
        fail(error, errorCap, L"Diagnostics options are required.", 0);
        return NULL;
    }
    state = (CX_DIAGNOSTICS *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(CX_DIAGNOSTICS));
    if (!state) {
        fail(error, errorCap, L"Unable to allocate render diagnostics state.", 0);
        return NULL;
    }
    if (!options->diagnose || options->noDiskWrite) return state;
    state->enabled = TRUE;
    base = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, CX_DIAGNOSTICS_PATH_CAP * sizeof(WCHAR));
    if (!base) {
        fail(error, errorCap, L"Unable to allocate render diagnostics path.", 0);
        return state;
    }
    configured = options->diagnosticsDir[0] ? options->diagnosticsDir : L".data\\diagnostics";
    if (!resolve_path(configured, base)) {
        fail(error, errorCap, L"Unable to resolve render diagnostics directory. Windows error ", GetLastError());
        HeapFree(GetProcessHeap(), 0, base);
        return state;
    }
    if (!ensure_parent_directories(base) || !create_directory(base)) {
        fail(error, errorCap, L"Unable to prepare render diagnostics directory. Windows error ", GetLastError());
        HeapFree(GetProcessHeap(), 0, base);
        return state;
    }
    make_run_directory(state, base, error, errorCap);
    HeapFree(GetProcessHeap(), 0, base);
    return state;
}

BOOL cx_diagnostics_write_page_json(CX_DIAGNOSTICS *state,
                                    const char *json, DWORD length,
                                    WCHAR *error, DWORD errorCap) {
    JT *tokens = NULL;
    HANDLE file = INVALID_HANDLE_VALUE;
    BOOL ok = FALSE;
    int tokenCount;
    DWORD tokenCapacity, total, written, code;
    clear_error(error, errorCap);
    if (!state || !state->enabled) return TRUE;
    if (!state->pathReady) return fail(error, errorCap, L"Render diagnostics output path is unavailable.", 0);
    if (!json || !length || length > CX_DIAGNOSTICS_JSON_CAP
        || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, json, (int)length, NULL, 0))
        return fail_write(state, error, errorCap,
                          L"Render diagnostics JSON is empty, invalid UTF-8, or exceeds 64 KiB.", 0);
    tokenCapacity = length + 1;
    tokens = (JT *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)tokenCapacity * sizeof(JT));
    if (!tokens) return fail_write(state, error, errorCap,
                                   L"Unable to allocate render diagnostics JSON tokens.", 0);
    tokenCount = jparse(json, (int)length, tokens, (int)tokenCapacity);
    if (tokenCount <= 0 || tokens[0].type != '{' || !diagnostic_validate_schema(json, tokens)) {
        HeapFree(GetProcessHeap(), 0, tokens);
        return fail_write(state, error, errorCap, L"Render diagnostics schema is invalid or contains disallowed page data.", 0);
    }
    HeapFree(GetProcessHeap(), 0, tokens);

    file = CreateFileW(state->temporaryPath, GENERIC_WRITE, 0, NULL, CREATE_NEW,
                       FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        code = GetLastError();
        return fail_write(state, error, errorCap,
                          L"Unable to create render diagnostics file. Windows error ", code);
    }
    state->temporaryOwned = TRUE;
    total = 0;
    while (total < length) {
        if (!WriteFile(file, json + total, length - total, &written, NULL) || !written) {
            code = GetLastError();
            if (!code) code = ERROR_WRITE_FAULT;
            fail(error, errorCap, L"Unable to write complete render diagnostics file. Windows error ", code);
            goto done;
        }
        total += written;
    }
    if (!WriteFile(file, "\n", 1, &written, NULL) || written != 1) {
        code = GetLastError();
        if (!code) code = ERROR_WRITE_FAULT;
        fail(error, errorCap, L"Unable to finish render diagnostics file. Windows error ", code);
        goto done;
    }
    if (!FlushFileBuffers(file)) {
        fail(error, errorCap, L"Unable to flush render diagnostics file. Windows error ", GetLastError());
        goto done;
    }
    CloseHandle(file);
    file = INVALID_HANDLE_VALUE;
    if (!MoveFileExW(state->temporaryPath, state->outputPath, MOVEFILE_WRITE_THROUGH)) {
        fail(error, errorCap, L"Unable to publish render diagnostics file. Windows error ", GetLastError());
        goto done;
    }
    state->temporaryOwned = FALSE;
    ok = TRUE;
done:
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    if (!ok) remove_run_directory(state);
    return ok;
}

void cx_diagnostics_close(CX_DIAGNOSTICS *state) {
    if (!state) return;
    if (state->temporaryOwned || state->pathReady) remove_run_directory(state);
    HeapFree(GetProcessHeap(), 0, state);
}

BOOL cx_diagnostics_enabled(const CX_DIAGNOSTICS *state) {
    return state && state->enabled && state->pathReady;
}

const WCHAR *cx_diagnostics_output_path(const CX_DIAGNOSTICS *state) {
    return state && state->pathReady ? state->outputPath : L"";
}
