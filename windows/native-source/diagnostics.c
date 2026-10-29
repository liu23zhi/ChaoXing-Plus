#include "diagnostics.h"
#include "json.h"

#define CX_DIAGNOSTICS_PATH_CAP 32768
#define CX_DIAGNOSTICS_JSON_CAP 65536
#define CX_WINDOW_JSON_CAP 4096
#define CX_WINDOW_MAX_DIMENSION 8192
#define CX_WINDOW_MAX_BYTES (64u * 1024u * 1024u)

struct CX_DIAGNOSTICS {
    BOOL enabled;
    BOOL pathReady;
    BOOL temporaryOwned;
    WCHAR outputPath[CX_DIAGNOSTICS_PATH_CAP];
    WCHAR temporaryPath[CX_DIAGNOSTICS_PATH_CAP];
    WCHAR windowJsonPath[CX_DIAGNOSTICS_PATH_CAP];
    WCHAR windowCapturePath[CX_DIAGNOSTICS_PATH_CAP];
    WCHAR windowPngPath[CX_DIAGNOSTICS_PATH_CAP];
    WCHAR pagePngPath[CX_DIAGNOSTICS_PATH_CAP];
    WCHAR hostSummaryPath[CX_DIAGNOSTICS_PATH_CAP];
    BOOL windowRecorded;
    DWORD clientPid;
    UINT systemDpi;
    UINT windowDpi;
    BOOL windowVisible;
    RECT windowRect;
    char screenshotStatus[16];
    DWORD artifactFlags;
};

#define CX_DIAGNOSTICS_ARTIFACT_PAGE_JSON 0x1u
#define CX_DIAGNOSTICS_ARTIFACT_PAGE_PNG 0x2u
#define CX_DIAGNOSTICS_ARTIFACT_WINDOW_JSON 0x4u
#define CX_DIAGNOSTICS_ARTIFACT_WINDOW_BMP 0x8u
#define CX_DIAGNOSTICS_ARTIFACT_WINDOW_PNG 0x10u

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
            CopyMemory(state->windowJsonPath, candidate, ((SIZE_T)lstrlenW(candidate) + 1) * sizeof(WCHAR));
            CopyMemory(state->windowCapturePath, candidate, ((SIZE_T)lstrlenW(candidate) + 1) * sizeof(WCHAR));
            CopyMemory(state->windowPngPath, candidate, ((SIZE_T)lstrlenW(candidate) + 1) * sizeof(WCHAR));
            CopyMemory(state->pagePngPath, candidate, ((SIZE_T)lstrlenW(candidate) + 1) * sizeof(WCHAR));
            CopyMemory(state->hostSummaryPath, candidate, ((SIZE_T)lstrlenW(candidate) + 1) * sizeof(WCHAR));
            if (!append_wide(state->outputPath, CX_DIAGNOSTICS_PATH_CAP, L"\\render-diagnostics.json")
                || !append_wide(state->temporaryPath, CX_DIAGNOSTICS_PATH_CAP, L"\\render-diagnostics.json.tmp")
                || !append_wide(state->windowJsonPath, CX_DIAGNOSTICS_PATH_CAP, L"\\window-diagnostics.json")
                || !append_wide(state->windowCapturePath, CX_DIAGNOSTICS_PATH_CAP, L"\\window-capture.bmp")
                || !append_wide(state->windowPngPath, CX_DIAGNOSTICS_PATH_CAP, L"\\window-capture.png")
                || !append_wide(state->pagePngPath, CX_DIAGNOSTICS_PATH_CAP, L"\\render-diagnostics-page.png")
                || !append_wide(state->hostSummaryPath, CX_DIAGNOSTICS_PATH_CAP, L"\\render-diagnostics-host.json"))
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
    char value[257]; int i, after;
    if (!diagnostic_string(json, tokens, index, value, sizeof(value))) return FALSE;
    for (i = 0; value[i]; ++i) {
        unsigned char c = (unsigned char)value[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
            || (c >= '0' && c <= '9') || c == ' ' || c == '.' || c == ','
            || c == '(' || c == ')' || c == '%' || c == '#' || c == '+' || c == '-')) return FALSE;
        if ((c == 'u' || c == 'U') && (value[i + 1] == 'r' || value[i + 1] == 'R')
            && (value[i + 2] == 'l' || value[i + 2] == 'L')) {
            after = i + 3;
            while (value[after] == ' ') ++after;
            if (value[after] == '(') return FALSE;
        }
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
    if (ok) state->artifactFlags |= CX_DIAGNOSTICS_ARTIFACT_PAGE_JSON;
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

/* ---- Window render diagnostics (owned client launch only) ---- */

typedef struct WINDOW_SEARCH {
    DWORD pid;
    HWND best;
    LONG area;
    BOOL bestVisible;
} WINDOW_SEARCH;

static BOOL CALLBACK find_window_callback(HWND hwnd, LPARAM parameter) {
    WINDOW_SEARCH *search = (WINDOW_SEARCH *)parameter;
    DWORD owner = 0;
    RECT rect;
    LONG width, height, area;
    BOOL visible;
    if (!search) return TRUE;
    GetWindowThreadProcessId(hwnd, &owner);
    if (owner != search->pid) return TRUE;
    if (!GetWindowRect(hwnd, &rect)) return TRUE;
    width = rect.right - rect.left;
    height = rect.bottom - rect.top;
    if (width <= 0 || height <= 0 || width > 100000 || height > 100000) return TRUE;
    area = width * height;
    if (area <= 0) return TRUE;
    visible = IsWindowVisible(hwnd);
    if (!search->best || area > search->area || (area == search->area && visible && !search->bestVisible)) {
        search->best = hwnd;
        search->area = area;
        search->bestVisible = visible;
    }
    return TRUE;
}

static HWND find_client_window(DWORD clientPid, RECT *rectOut, BOOL *visibleOut) {
    WINDOW_SEARCH search;
    if (!clientPid || clientPid == (DWORD)-1 || !rectOut || !visibleOut) return NULL;
    ZeroMemory(&search, sizeof(search));
    search.pid = clientPid;
    search.area = -1;
    EnumWindows(find_window_callback, (LPARAM)&search);
    if (!search.best || !GetWindowRect(search.best, rectOut)) return NULL;
    *visibleOut = search.bestVisible;
    return search.best;
}

BOOL cx_diagnostics_client_window_ready(DWORD clientPid) {
    RECT rect;
    BOOL visible = FALSE;
    return find_client_window(clientPid, &rect, &visible) != NULL;
}

static BOOL write_window_bytes(const WCHAR *path, const void *data, DWORD length,
                               WCHAR *error, DWORD cap, const WCHAR *message) {
    HANDLE file;
    DWORD written = 0;
    BOOL ok;
    if (!path || !path[0]) return FALSE;
    file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        fail(error, cap, message, GetLastError());
        return FALSE;
    }
    ok = WriteFile(file, data, length, &written, NULL) && written == length;
    if (!ok) fail(error, cap, message, GetLastError());
    CloseHandle(file);
    return ok;
}

static BOOL capture_window_pixels(HWND hwnd, LONG width, LONG height,
                                  unsigned char **pixelsOut, DWORD *strideOut,
                                  char *method, DWORD methodCap,
                                  WCHAR *error, DWORD cap) {
    HDC windowDc = NULL;
    HDC memoryDc = NULL;
    HBITMAP bitmap = NULL;
    HGDIOBJ previous = NULL;
    BITMAPINFO info;
    unsigned char *buffer = NULL;
    DWORD stride, pixelsSize;
    BOOL captured = FALSE;
    BOOL result = FALSE;
    if (pixelsOut) *pixelsOut = NULL;
    if (strideOut) *strideOut = 0;
    if (width <= 0 || height <= 0 || width > CX_WINDOW_MAX_DIMENSION || height > CX_WINDOW_MAX_DIMENSION) {
        fail(error, cap, L"Window is too large to capture.", 0);
        return FALSE;
    }
    stride = (((DWORD)width * 3u) + 3u) & ~3u;
    pixelsSize = stride * (DWORD)height;
    if (pixelsSize == 0 || pixelsSize > CX_WINDOW_MAX_BYTES) {
        fail(error, cap, L"Window snapshot exceeds the bounded capture size.", 0);
        return FALSE;
    }
    windowDc = GetWindowDC(hwnd);
    if (!windowDc) {
        fail(error, cap, L"Unable to acquire the client window device context. Windows error ", GetLastError());
        return FALSE;
    }
    memoryDc = CreateCompatibleDC(windowDc);
    if (memoryDc) bitmap = CreateCompatibleBitmap(windowDc, width, height);
    if (!memoryDc || !bitmap) {
        fail(error, cap, L"Unable to create the window snapshot bitmap. Windows error ", GetLastError());
        goto done;
    }
    previous = SelectObject(memoryDc, bitmap);
    if (PrintWindow(hwnd, memoryDc, 2)) {
        captured = TRUE;
        lstrcpynA(method, "print-window", (int)methodCap);
    } else if (BitBlt(memoryDc, 0, 0, width, height, windowDc, 0, 0, SRCCOPY | CAPTUREBLT)) {
        captured = TRUE;
        lstrcpynA(method, "bitblt", (int)methodCap);
    }
    if (!captured) {
        /* Keep correctly-sized snapshots even when both capture paths fail
           (for example a hidden window). The JSON marks the pixels as failed. */
        lstrcpynA(method, "blank", (int)methodCap);
    }
    buffer = (unsigned char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, pixelsSize);
    if (!buffer) {
        fail(error, cap, L"Out of memory capturing the client window.", 0);
        goto done;
    }
    if (captured) {
        ZeroMemory(&info, sizeof(info));
        info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 24;
        info.bmiHeader.biCompression = BI_RGB;
        if (GetDIBits(memoryDc, bitmap, 0, (UINT)height, buffer, &info, DIB_RGB_COLORS) != height) {
            fail(error, cap, L"Unable to read the window snapshot pixels. Windows error ", GetLastError());
            goto done;
        }
    }
    *pixelsOut = buffer;
    *strideOut = stride;
    buffer = NULL;
    result = TRUE;
done:
    if (previous && memoryDc) SelectObject(memoryDc, previous);
    if (bitmap) DeleteObject(bitmap);
    if (memoryDc) DeleteDC(memoryDc);
    if (windowDc) ReleaseDC(hwnd, windowDc);
    if (buffer) HeapFree(GetProcessHeap(), 0, buffer);
    return result;
}

static BOOL write_window_bmp(const WCHAR *path, LONG width, LONG height,
                             const unsigned char *pixels, DWORD stride,
                             WCHAR *error, DWORD cap) {
    BITMAPFILEHEADER *fileHeader;
    BITMAPINFOHEADER *infoHeader;
    unsigned char *file = NULL;
    DWORD pixelsSize = stride * (DWORD)height, total = sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER) + pixelsSize;
    BOOL result = FALSE;
    if (!width || !height || !pixels || !pixelsSize || total > CX_WINDOW_MAX_BYTES + 128u) {
        fail(error, cap, L"Window snapshot exceeds the bounded BMP size.", 0);
        return FALSE;
    }
    file = (unsigned char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, total);
    if (!file) {
        fail(error, cap, L"Out of memory writing the window snapshot.", 0);
        return FALSE;
    }
    fileHeader = (BITMAPFILEHEADER *)file;
    infoHeader = (BITMAPINFOHEADER *)(file + sizeof(BITMAPFILEHEADER));
    fileHeader->bfType = 0x4D42;
    fileHeader->bfSize = total;
    fileHeader->bfOffBits = sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER);
    infoHeader->biSize = sizeof(BITMAPINFOHEADER);
    infoHeader->biWidth = width;
    infoHeader->biHeight = height;
    infoHeader->biPlanes = 1;
    infoHeader->biBitCount = 24;
    infoHeader->biCompression = BI_RGB;
    infoHeader->biSizeImage = pixelsSize;
    CopyMemory(file + fileHeader->bfOffBits, pixels, pixelsSize);
    result = write_window_bytes(path, file, total, error, cap, L"Unable to write the window snapshot. Windows error ");
    HeapFree(GetProcessHeap(), 0, file);
    return result;
}

/* Minimal PNG writer: 24-bit RGB rows, stored (uncompressed) zlib blocks. It
   avoids CRT/zlib dependencies while producing a standard PNG that the same
   consumers can open as the Node host's window capture. */
static unsigned long png_crc_table[256];
static BOOL png_crc_ready;

static void png_crc_init(void) {
    DWORD i, bit;
    if (png_crc_ready) return;
    for (i = 0; i < 256; ++i) {
        unsigned long value = i;
        for (bit = 0; bit < 8; ++bit)
            value = (value & 1UL) ? (0xEDB88320UL ^ (value >> 1)) : (value >> 1);
        png_crc_table[i] = value;
    }
    png_crc_ready = TRUE;
}

static unsigned long png_crc_bytes(unsigned long state, const unsigned char *data, DWORD length) {
    DWORD i;
    png_crc_init();
    for (i = 0; i < length; ++i) state = png_crc_table[(state ^ data[i]) & 0xFFu] ^ (state >> 8);
    return state;
}

static unsigned long png_crc_finish(unsigned long state) {
    return state ^ 0xFFFFFFFFUL;
}

static unsigned long png_adler32(const unsigned char *data, DWORD length) {
    unsigned long a = 1, b = 0;
    DWORD i;
    for (i = 0; i < length; ++i) {
        a = (a + data[i]) % 65521UL;
        b = (b + a) % 65521UL;
    }
    return (b << 16) | a;
}

static void png_put32(unsigned char *out, unsigned long value) {
    out[0] = (unsigned char)(value >> 24);
    out[1] = (unsigned char)(value >> 16);
    out[2] = (unsigned char)(value >> 8);
    out[3] = (unsigned char)value;
}

static BOOL png_append_chunk(unsigned char *file, DWORD capacity, DWORD *at,
                             const unsigned char type[4],
                             const unsigned char *data, DWORD length) {
    unsigned long crc;
    if (*at + 12u + length > capacity) return FALSE;
    png_put32(file + *at, length);
    CopyMemory(file + *at + 4, type, 4);
    if (length) CopyMemory(file + *at + 8, data, length);
    crc = png_crc_bytes(0xFFFFFFFFUL, type, 4);
    crc = png_crc_finish(png_crc_bytes(crc, data, length));
    png_put32(file + *at + 8 + length, crc);
    *at += 12u + length;
    return TRUE;
}

static BOOL png_deflate_store(const unsigned char *raw, DWORD rawLength,
                              unsigned char **streamOut, DWORD *streamLengthOut) {
    DWORD blocks = rawLength ? ((rawLength + 65534UL) / 65535UL) : 1UL;
    DWORD size = 2 + blocks * 5u + rawLength + 4u;
    unsigned char *stream;
    DWORD at = 0, offset = 0, index;
    unsigned long adler;
    stream = (unsigned char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size);
    if (!stream) return FALSE;
    stream[at++] = 0x78;
    stream[at++] = 0x01;
    for (index = 0; index < blocks; ++index) {
        DWORD remaining = rawLength - offset;
        DWORD length = remaining > 65535UL ? 65535UL : remaining;
        BOOL last = index + 1u >= blocks;
        DWORD inverse = ~length & 0xFFFFUL;
        stream[at++] = last ? 1 : 0;
        stream[at++] = (unsigned char)(length & 0xFFu);
        stream[at++] = (unsigned char)((length >> 8) & 0xFFu);
        stream[at++] = (unsigned char)(inverse & 0xFFu);
        stream[at++] = (unsigned char)((inverse >> 8) & 0xFFu);
        if (length) CopyMemory(stream + at, raw + offset, length);
        at += length;
        offset += length;
    }
    adler = png_adler32(raw, rawLength);
    stream[at++] = (unsigned char)(adler >> 24);
    stream[at++] = (unsigned char)(adler >> 16);
    stream[at++] = (unsigned char)(adler >> 8);
    stream[at++] = (unsigned char)adler;
    *streamOut = stream;
    *streamLengthOut = at;
    return TRUE;
}

static BOOL write_window_png(const WCHAR *path, LONG width, LONG height,
                             const unsigned char *pixels, DWORD stride,
                             WCHAR *error, DWORD cap) {
    static const unsigned char signature[8] = { 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A };
    unsigned char ihdr[13];
    unsigned char *raw = NULL, *zlib = NULL, *file = NULL;
    DWORD rowBytes = (DWORD)width * 3u, rawLength = (DWORD)height * (rowBytes + 1u);
    DWORD zlibLength = 0, total, at = 0, y, x;
    BOOL result = FALSE;
    if (!width || !height || !pixels) return FALSE;
    if (rawLength / ((DWORD)height) != rowBytes + 1u || rawLength > CX_WINDOW_MAX_BYTES) {
        fail(error, cap, L"Window PNG exceeds the bounded capture size.", 0);
        return FALSE;
    }
    raw = (unsigned char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, rawLength);
    if (!raw) { fail(error, cap, L"Out of memory encoding the window PNG.", 0); goto done; }
    for (y = 0; y < (DWORD)height; ++y) {
        const unsigned char *source = pixels + (SIZE_T)(height - 1 - (LONG)y) * stride;
        unsigned char *target = raw + y * (rowBytes + 1u);
        *target++ = 0;
        for (x = 0; x < (DWORD)width; ++x) {
            target[x * 3u] = source[x * 3u + 2u];
            target[x * 3u + 1u] = source[x * 3u + 1u];
            target[x * 3u + 2u] = source[x * 3u];
        }
    }
    if (!png_deflate_store(raw, rawLength, &zlib, &zlibLength)) {
        fail(error, cap, L"Out of memory compressing the window PNG.", 0);
        goto done;
    }
    total = 8u + (12u + 13u) + (12u + zlibLength) + 12u;
    file = (unsigned char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, total);
    if (!file) { fail(error, cap, L"Out of memory writing the window PNG.", 0); goto done; }
    CopyMemory(file, signature, 8); at = 8;
    png_put32(ihdr, (unsigned long)width);
    png_put32(ihdr + 4, (unsigned long)height);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    if (!png_append_chunk(file, total, &at, (const unsigned char *)"IHDR", ihdr, 13)
        || !png_append_chunk(file, total, &at, (const unsigned char *)"IDAT", zlib, zlibLength)
        || !png_append_chunk(file, total, &at, (const unsigned char *)"IEND", NULL, 0))
        { fail(error, cap, L"Window PNG encoding overflowed its buffer.", 0); goto done; }
    result = write_window_bytes(path, file, at, error, cap, L"Unable to write the window PNG. Windows error ");
done:
    if (raw) HeapFree(GetProcessHeap(), 0, raw);
    if (zlib) HeapFree(GetProcessHeap(), 0, zlib);
    if (file) HeapFree(GetProcessHeap(), 0, file);
    return result;
}
typedef struct WINDOW_JSON {
    char *text;
    DWORD capacity;
    DWORD used;
    BOOL ok;
} WINDOW_JSON;

static void window_json_text(WINDOW_JSON *json, const char *text) {
    DWORD length, i;
    if (!json || !json->ok || !text) return;
    length = (DWORD)lstrlenA(text);
    if (json->used + length + 1 >= json->capacity) { json->ok = FALSE; return; }
    for (i = 0; i < length; ++i) json->text[json->used++] = text[i];
    json->text[json->used] = 0;
}

static void window_json_digits(WINDOW_JSON *json, unsigned long value, DWORD width) {
    char digits[11];
    DWORD count = 0, target, index;
    if (!json || !json->ok) return;
    do { digits[count++] = (char)('0' + (value % 10u)); value /= 10u; } while (value && count < sizeof(digits));
    target = width > count ? width : count;
    if (json->used + target + 1 >= json->capacity) { json->ok = FALSE; return; }
    for (index = target; index > count; --index) json->text[json->used++] = '0';
    while (count) json->text[json->used++] = digits[--count];
    json->text[json->used] = 0;
}

static void window_json_signed(WINDOW_JSON *json, long value) {
    unsigned long magnitude;
    if (value < 0) {
        window_json_text(json, "-");
        magnitude = (unsigned long)(-(value + 1)) + 1ul;
    } else {
        magnitude = (unsigned long)value;
    }
    window_json_digits(json, magnitude, 0);
}

static BOOL write_window_json(CX_DIAGNOSTICS *state, const char *status, DWORD clientPid,
                              const RECT *rect, BOOL visible, UINT systemDpi, UINT windowDpi,
                              const char *captureStatus, const char *captureMethod,
                              LONG captureWidth, LONG captureHeight,
                              WCHAR *error, DWORD cap) {
    static char text[CX_WINDOW_JSON_CAP];
    WINDOW_JSON json;
    SYSTEMTIME now;
    RECT empty;
    if (!rect) { ZeroMemory(&empty, sizeof(empty)); rect = &empty; }
    ZeroMemory(&json, sizeof(json));
    json.text = text;
    json.capacity = sizeof(text);
    json.ok = TRUE;
    GetSystemTime(&now);
    window_json_text(&json, "{\"version\":\"6.2.0\",\"host\":\"native\",\"source\":\"native-window\",\"collectedAt\":\"");
    window_json_digits(&json, now.wYear, 4); window_json_text(&json, "-");
    window_json_digits(&json, now.wMonth, 2); window_json_text(&json, "-");
    window_json_digits(&json, now.wDay, 2); window_json_text(&json, "T");
    window_json_digits(&json, now.wHour, 2); window_json_text(&json, ":");
    window_json_digits(&json, now.wMinute, 2); window_json_text(&json, ":");
    window_json_digits(&json, now.wSecond, 2); window_json_text(&json, ".");
    window_json_digits(&json, now.wMilliseconds, 3); window_json_text(&json, "Z\",\"clientPid\":");
    window_json_digits(&json, (unsigned long)clientPid, 0);
    window_json_text(&json, ",\"status\":\"");
    window_json_text(&json, status);
    window_json_text(&json, "\",\"systemDpi\":");
    window_json_digits(&json, systemDpi, 0);
    window_json_text(&json, ",\"windowDpi\":");
    window_json_digits(&json, windowDpi, 0);
    window_json_text(&json, ",\"visible\":");
    window_json_text(&json, visible ? "true" : "false");
    window_json_text(&json, ",\"window\":{\"x\":");
    window_json_signed(&json, (long)rect->left);
    window_json_text(&json, ",\"y\":");
    window_json_signed(&json, (long)rect->top);
    window_json_text(&json, ",\"width\":");
    window_json_signed(&json, (long)(rect->right - rect->left));
    window_json_text(&json, ",\"height\":");
    window_json_signed(&json, (long)(rect->bottom - rect->top));
    window_json_text(&json, "},\"screenshot\":{\"status\":\"");
    window_json_text(&json, captureStatus);
    window_json_text(&json, "\",\"file\":\"window-capture.bmp\",\"width\":");
    window_json_signed(&json, captureWidth);
    window_json_text(&json, ",\"height\":");
    window_json_signed(&json, captureHeight);
    window_json_text(&json, ",\"method\":\"");
    window_json_text(&json, captureMethod);
    window_json_text(&json, "\"}}\n");
    if (!json.ok) {
        fail(error, cap, L"Window diagnostics JSON exceeds its buffer.", 0);
        return FALSE;
    }
    return write_window_bytes(state->windowJsonPath, text, (DWORD)lstrlenA(text), error, cap,
                              L"Unable to write window diagnostics JSON. Windows error ");
}

static UINT window_dpi_for(HWND hwnd, UINT *systemDpiOut) {
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    typedef UINT (WINAPI *DPI_FOR_WINDOW)(HWND);
    typedef UINT (WINAPI *DPI_FOR_SYSTEM)(void);
    DPI_FOR_WINDOW getForWindow = user32 ? (DPI_FOR_WINDOW)GetProcAddress(user32, "GetDpiForWindow") : NULL;
    DPI_FOR_SYSTEM getForSystem = user32 ? (DPI_FOR_SYSTEM)GetProcAddress(user32, "GetDpiForSystem") : NULL;
    UINT windowDpi = getForWindow ? getForWindow(hwnd) : 0;
    UINT systemDpi = getForSystem ? getForSystem() : 0;
    if (!windowDpi) {
        HDC dc = hwnd ? GetDC(hwnd) : NULL;
        if (dc) { windowDpi = (UINT)GetDeviceCaps(dc, LOGPIXELSX); ReleaseDC(hwnd, dc); }
    }
    if (!systemDpi) {
        HDC screen = GetDC(NULL);
        if (screen) { systemDpi = (UINT)GetDeviceCaps(screen, LOGPIXELSX); ReleaseDC(NULL, screen); }
    }
    if (!windowDpi) windowDpi = 96;
    if (!systemDpi) systemDpi = 96;
    if (systemDpiOut) *systemDpiOut = systemDpi;
    return windowDpi;
}

BOOL cx_diagnostics_capture_window(CX_DIAGNOSTICS *state, DWORD clientPid,
                                   WCHAR *error, DWORD errorCap) {
    HWND hwnd;
    RECT rect;
    BOOL visible = FALSE;
    BOOL bmpWritten = FALSE, pngWritten = FALSE;
    UINT systemDpi = 96, windowDpi = 96;
    char method[32] = "none";
    const char *status = "unavailable";
    const char *captureStatus = "failed";
    LONG captureWidth = 0, captureHeight = 0;
    clear_error(error, errorCap);
    if (!state || !state->enabled) return TRUE;
    if (!state->pathReady) {
        fail(error, errorCap, L"Window diagnostics output path is unavailable.", 0);
        return FALSE;
    }
    hwnd = find_client_window(clientPid, &rect, &visible);
    if (!hwnd) {
        return write_window_json(state, "unavailable", clientPid, &rect, FALSE, 0, 0,
                                 "unavailable", "none", 0, 0, error, errorCap);
    }
    windowDpi = window_dpi_for(hwnd, &systemDpi);
    status = "captured";
    captureWidth = rect.right - rect.left;
    captureHeight = rect.bottom - rect.top;
    if (captureWidth > CX_WINDOW_MAX_DIMENSION || captureHeight > CX_WINDOW_MAX_DIMENSION) {
        captureStatus = "skipped";
        lstrcpynA(method, "too-large", (int)sizeof(method));
        captureWidth = 0;
        captureHeight = 0;
    } else {
        unsigned char *pixels = NULL;
        DWORD pixelStride = 0;
        if (!capture_window_pixels(hwnd, captureWidth, captureHeight, &pixels, &pixelStride,
                                   method, (DWORD)sizeof(method), error, errorCap)) {
            captureStatus = "failed";
        } else {
            BOOL bmpOk = write_window_bmp(state->windowCapturePath, captureWidth, captureHeight,
                                          pixels, pixelStride, error, errorCap);
            BOOL pngOk = write_window_png(state->windowPngPath, captureWidth, captureHeight,
                                          pixels, pixelStride, error, errorCap);
            bmpWritten = bmpOk;
            pngWritten = pngOk;
            if (bmpOk && pngOk) captureStatus = lstrcmpA(method, "blank") == 0 ? "failed" : "captured";
            else captureStatus = "failed";
            HeapFree(GetProcessHeap(), 0, pixels);
        }
    }
    /* Snapshot failures are nonfatal: the JSON still records DPI/rect and status. */
    clear_error(error, errorCap);
    if (write_window_json(state, status, clientPid, &rect, visible, systemDpi, windowDpi,
                          captureStatus, method, captureWidth, captureHeight, error, errorCap)) {
        state->artifactFlags |= CX_DIAGNOSTICS_ARTIFACT_WINDOW_JSON;
        if (bmpWritten) state->artifactFlags |= CX_DIAGNOSTICS_ARTIFACT_WINDOW_BMP;
        if (pngWritten) state->artifactFlags |= CX_DIAGNOSTICS_ARTIFACT_WINDOW_PNG;
        cx_diagnostics_record_window(state, clientPid, systemDpi, windowDpi, visible, &rect, captureStatus);
        return TRUE;
    }
    return FALSE;
}

const WCHAR *cx_diagnostics_window_json_path(const CX_DIAGNOSTICS *state) {
    return state && state->pathReady ? state->windowJsonPath : L"";
}

const WCHAR *cx_diagnostics_window_capture_path(const CX_DIAGNOSTICS *state) {
    return state && state->pathReady ? state->windowCapturePath : L"";
}

const WCHAR *cx_diagnostics_window_png_path(const CX_DIAGNOSTICS *state) {
    return state && state->pathReady ? state->windowPngPath : L"";
}

/* ---- Page screenshot (CDP Page.captureScreenshot) ---- */

#define CX_PAGE_PNG_MAX_BYTES (16u * 1024u * 1024u)
#define CX_PAGE_PNG_MAX_DIMENSION 16384

static BOOL png_base64_value(char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
        || c == '+' || c == '/';
}

static int png_base64_index(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static DWORD png_be32(const unsigned char *bytes) {
    return ((DWORD)bytes[0] << 24) | ((DWORD)bytes[1] << 16) | ((DWORD)bytes[2] << 8) | (DWORD)bytes[3];
}

BOOL cx_diagnostics_write_page_png(CX_DIAGNOSTICS *state, const char *base64, DWORD length,
                                   WCHAR *error, DWORD errorCap) {
    unsigned char *decoded = NULL;
    DWORD decodedLength, padding = 0, i, written;
    BOOL ok = FALSE;
    static const unsigned char signature[8] = { 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A };
    clear_error(error, errorCap);
    if (!state || !state->enabled) return TRUE;
    if (!state->pathReady) return fail(error, errorCap, L"Page screenshot output path is unavailable.", 0);
    if (!base64 || !length || length % 4 != 0) return fail(error, errorCap, L"Page screenshot data is empty or not base64.", 0);
    if (length > (CX_PAGE_PNG_MAX_BYTES / 3u) * 4u + 8u)
        return fail(error, errorCap, L"Page screenshot exceeds the bounded size.", 0);
    while (padding < 2 && length > padding && base64[length - padding - 1] == '=') ++padding;
    decodedLength = length / 4u * 3u - padding;
    if (decodedLength < 33 || decodedLength > CX_PAGE_PNG_MAX_BYTES)
        return fail(error, errorCap, L"Page screenshot decoded size is invalid.", 0);
    for (i = 0; i < length - padding; ++i) {
        if (!png_base64_value(base64[i]))
            return fail(error, errorCap, L"Page screenshot data contains invalid base64 characters.", 0);
    }
    decoded = (unsigned char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, decodedLength);
    if (!decoded) return fail(error, errorCap, L"Out of memory decoding the page screenshot.", 0);
    for (i = 0; i < length / 4u; ++i) {
        int a = png_base64_index(base64[i * 4]);
        int b = png_base64_index(base64[i * 4 + 1]);
        int c = i * 4 + 2 < length - padding ? png_base64_index(base64[i * 4 + 2]) : 0;
        int d = i * 4 + 3 < length - padding ? png_base64_index(base64[i * 4 + 3]) : 0;
        DWORD at = i * 3u;
        if (a < 0 || b < 0 || c < 0 || d < 0) goto done;
        if (at < decodedLength) decoded[at] = (unsigned char)(((unsigned)a << 2) | ((unsigned)b >> 4));
        if (at + 1 < decodedLength) decoded[at + 1] = (unsigned char)((((unsigned)b & 0x0Fu) << 4) | ((unsigned)c >> 2));
        if (at + 2 < decodedLength) decoded[at + 2] = (unsigned char)((((unsigned)c & 0x03u) << 6) | (unsigned)d);
    }
    for (i = 0; i < 8; ++i) if (decoded[i] != signature[i]) { fail(error, errorCap, L"Page screenshot is not a PNG file.", 0); goto done; }
    if (decoded[12] != 'I' || decoded[13] != 'H' || decoded[14] != 'D' || decoded[15] != 'R') {
        fail(error, errorCap, L"Page screenshot PNG lacks an IHDR chunk.", 0); goto done;
    }
    if (png_be32(decoded + 16) == 0 || png_be32(decoded + 20) == 0
        || png_be32(decoded + 16) > CX_PAGE_PNG_MAX_DIMENSION
        || png_be32(decoded + 20) > CX_PAGE_PNG_MAX_DIMENSION) {
        fail(error, errorCap, L"Page screenshot PNG dimensions are invalid.", 0); goto done;
    }
    {
        HANDLE file = CreateFileW(state->pagePngPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        if (file == INVALID_HANDLE_VALUE) {
            fail(error, errorCap, L"Unable to create the page screenshot file. Windows error ", GetLastError());
            goto done;
        }
        ok = WriteFile(file, decoded, decodedLength, &written, NULL) && written == decodedLength;
        if (!ok) fail(error, errorCap, L"Unable to write the page screenshot. Windows error ", GetLastError());
        CloseHandle(file);
        if (ok) state->artifactFlags |= CX_DIAGNOSTICS_ARTIFACT_PAGE_PNG;
    }
done:
    if (decoded) HeapFree(GetProcessHeap(), 0, decoded);
    return ok;
}

const WCHAR *cx_diagnostics_page_png_path(const CX_DIAGNOSTICS *state) {
    return state && state->pathReady ? state->pagePngPath : L"";
}

/* ---- Host diagnostics summary ---- */

void cx_diagnostics_record_window(CX_DIAGNOSTICS *state, DWORD clientPid,
                                  UINT systemDpi, UINT windowDpi, BOOL visible,
                                  const RECT *rect, const char *screenshotStatus) {
    if (!state) return;
    state->windowRecorded = TRUE;
    state->clientPid = clientPid;
    state->systemDpi = systemDpi;
    state->windowDpi = windowDpi;
    state->windowVisible = visible;
    if (rect) CopyMemory(&state->windowRect, rect, sizeof(RECT));
    else ZeroMemory(&state->windowRect, sizeof(RECT));
    lstrcpynA(state->screenshotStatus, screenshotStatus ? screenshotStatus : "unknown", 16);
}

BOOL cx_diagnostics_write_host_summary(CX_DIAGNOSTICS *state, BOOL attachMode,
                                       WCHAR *error, DWORD errorCap) {
    static char text[4096];
    WINDOW_JSON json;
    SYSTEMTIME now;
    const char *dpiStatus = "unknown";
    DWORD width = 0, height = 0;
    clear_error(error, errorCap);
    if (!state || !state->enabled) return TRUE;
    if (!state->pathReady) return fail(error, errorCap, L"Host diagnostics summary path is unavailable.", 0);
    if (state->windowRecorded && state->systemDpi && state->windowDpi)
        dpiStatus = state->systemDpi == state->windowDpi ? "match" : "mismatch";
    width = (DWORD)(state->windowRect.right - state->windowRect.left);
    height = (DWORD)(state->windowRect.bottom - state->windowRect.top);
    ZeroMemory(&json, sizeof(json));
    json.text = text;
    json.capacity = sizeof(text);
    json.ok = TRUE;
    GetSystemTime(&now);
    window_json_text(&json, "{\"version\":\"6.2.0\",\"host\":\"native\",\"source\":\"native-host\",\"collectedAt\":\"");
    window_json_digits(&json, now.wYear, 4); window_json_text(&json, "-");
    window_json_digits(&json, now.wMonth, 2); window_json_text(&json, "-");
    window_json_digits(&json, now.wDay, 2); window_json_text(&json, "T");
    window_json_digits(&json, now.wHour, 2); window_json_text(&json, ":");
    window_json_digits(&json, now.wMinute, 2); window_json_text(&json, ":");
    window_json_digits(&json, now.wSecond, 2); window_json_text(&json, ".");
    window_json_digits(&json, now.wMilliseconds, 3); window_json_text(&json, "Z\",\"launchMode\":");
    window_json_text(&json, attachMode ? "\"attach\"" : "\"launch\"");
    window_json_text(&json, ",\"clientPid\":");
    window_json_digits(&json, (unsigned long)state->clientPid, 0);
    window_json_text(&json, ",\"window\":{\"recorded\":");
    window_json_text(&json, state->windowRecorded ? "true" : "false");
    window_json_text(&json, ",\"screenshot\":\"");
    window_json_text(&json, state->screenshotStatus[0] ? state->screenshotStatus : "unavailable");
    window_json_text(&json, "\",\"visible\":");
    window_json_text(&json, state->windowVisible ? "true" : "false");
    window_json_text(&json, ",\"systemDpi\":");
    window_json_digits(&json, state->systemDpi, 0);
    window_json_text(&json, ",\"windowDpi\":");
    window_json_digits(&json, state->windowDpi, 0);
    window_json_text(&json, ",\"dpiStatus\":\"");
    window_json_text(&json, dpiStatus);
    window_json_text(&json, "\",\"x\":");
    window_json_signed(&json, (long)state->windowRect.left);
    window_json_text(&json, ",\"y\":");
    window_json_signed(&json, (long)state->windowRect.top);
    window_json_text(&json, ",\"width\":");
    window_json_digits(&json, (unsigned long)width, 0);
    window_json_text(&json, ",\"height\":");
    window_json_digits(&json, (unsigned long)height, 0);
    window_json_text(&json, "},\"artifacts\":{\"pageDiagnostics\":");
    window_json_text(&json, (state->artifactFlags & CX_DIAGNOSTICS_ARTIFACT_PAGE_JSON) ? "true" : "false");
    window_json_text(&json, ",\"pageScreenshot\":");
    window_json_text(&json, (state->artifactFlags & CX_DIAGNOSTICS_ARTIFACT_PAGE_PNG) ? "true" : "false");
    window_json_text(&json, ",\"windowDiagnostics\":");
    window_json_text(&json, (state->artifactFlags & CX_DIAGNOSTICS_ARTIFACT_WINDOW_JSON) ? "true" : "false");
    window_json_text(&json, ",\"windowCaptureBmp\":");
    window_json_text(&json, (state->artifactFlags & CX_DIAGNOSTICS_ARTIFACT_WINDOW_BMP) ? "true" : "false");
    window_json_text(&json, ",\"windowCapturePng\":");
    window_json_text(&json, (state->artifactFlags & CX_DIAGNOSTICS_ARTIFACT_WINDOW_PNG) ? "true" : "false");
    window_json_text(&json, "},\"files\":{\"pageDiagnostics\":\"render-diagnostics.json\",\"pageScreenshot\":\"render-diagnostics-page.png\",\"windowDiagnostics\":\"window-diagnostics.json\",\"windowCaptureBmp\":\"window-capture.bmp\",\"windowCapturePng\":\"window-capture.png\"}}\n");
    if (!json.ok) {
        fail(error, errorCap, L"Host diagnostics summary exceeds its buffer.", 0);
        return FALSE;
    }
    return write_window_bytes(state->hostSummaryPath, text, (DWORD)lstrlenA(text), error, errorCap,
                              L"Unable to write the host diagnostics summary. Windows error ");
}

const WCHAR *cx_diagnostics_host_summary_path(const CX_DIAGNOSTICS *state) {
    return state && state->pathReady ? state->hostSummaryPath : L"";
}