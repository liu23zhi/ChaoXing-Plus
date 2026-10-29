#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "dpi.h"

#ifndef CX_DPI_LAYERS_KEY
#define CX_DPI_LAYERS_KEY L"Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers"
#endif
#define DPI_VALUE_CAP 65536

struct CX_DPI_OVERRIDE {
    HKEY key;
    HANDLE mutex;
    BOOL mutexOwned, existed, changed;
    DWORD originalType, originalSize, temporarySize;
    WCHAR name[32768];
    BYTE original[DPI_VALUE_CAP];
    BYTE observed[DPI_VALUE_CAP];
    WCHAR temporary[DPI_VALUE_CAP / sizeof(WCHAR)];
};

static void d_error(WCHAR *error, DWORD cap, const WCHAR *text, DWORD code) {
    if (error && cap) lstrcpynW(error, text, (int)cap);
    SetLastError(code);
}
static void d_free(CX_DPI_OVERRIDE *s) {
    if (!s) return;
    if (s->key) RegCloseKey(s->key);
    if (s->mutexOwned) ReleaseMutex(s->mutex);
    if (s->mutex) CloseHandle(s->mutex);
    HeapFree(GetProcessHeap(), 0, s);
}
static BOOL d_read(CX_DPI_OVERRIDE *s, BYTE *data, DWORD *type, DWORD *size, BOOL *exists) {
    LSTATUS status;
    *type = 0; *size = DPI_VALUE_CAP; *exists = FALSE;
    status = RegQueryValueExW(s->key, s->name, NULL, type, data, size);
    if (status == ERROR_FILE_NOT_FOUND) { *type = 0; *size = 0; return TRUE; }
    if (status != ERROR_SUCCESS) { SetLastError((DWORD)status); return FALSE; }
    *exists = TRUE; return TRUE;
}
static BOOL d_same(const BYTE *a, DWORD typeA, DWORD sizeA, BOOL existsA,
                    const BYTE *b, DWORD typeB, DWORD sizeB, BOOL existsB) {
    DWORD i;
    if (existsA != existsB) return FALSE;
    if (!existsA) return TRUE;
    if (typeA != typeB || sizeA != sizeB) return FALSE;
    for (i = 0; i < sizeA; ++i) if (a[i] != b[i]) return FALSE;
    return TRUE;
}
static BOOL d_space(WCHAR c) { return c == L' ' || c == L'\t' || c == L'\r' || c == L'\n'; }
static BOOL d_token(const WCHAR *text, DWORD length, const WCHAR *token) {
    return CompareStringOrdinal(text, (int)length, token, -1, TRUE) == CSTR_EQUAL;
}
static BOOL d_append(CX_DPI_OVERRIDE *s, DWORD *at, const WCHAR *text, DWORD length) {
    DWORD i;
    if (*at + length + (*at ? 1 : 0) + 1 > DPI_VALUE_CAP / sizeof(WCHAR)) return FALSE;
    if (*at) s->temporary[(*at)++] = L' ';
    for (i = 0; i < length; ++i) s->temporary[(*at)++] = text[i];
    s->temporary[*at] = 0; return TRUE;
}
static BOOL d_prepare(CX_DPI_OVERRIDE *s) {
    const WCHAR *text = (const WCHAR *)s->original;
    DWORD bound = s->originalSize / sizeof(WCHAR), length = 0, i, first, at = 0;
    BOOL aware = FALSE, conflict = FALSE;
    if (s->existed && ((s->originalType != REG_SZ && s->originalType != REG_EXPAND_SZ)
        || s->originalSize % sizeof(WCHAR))) return FALSE;
    while (length < bound && text[length]) ++length;
    for (i = length; i < bound; ++i) if (text[i]) return FALSE;
    for (i = 0; i < length;) {
        while (i < length && d_space(text[i])) ++i;
        first = i;
        while (i < length && !d_space(text[i])) ++i;
        if (first == i) continue;
        if (d_token(text + first, i - first, L"HIGHDPIAWARE")) aware = TRUE;
        else if (d_token(text + first, i - first, L"DPIUNAWARE")
            || d_token(text + first, i - first, L"GDIDPISCALING")) conflict = TRUE;
        else if (!d_append(s, &at, text + first, i - first)) return FALSE;
    }
    if (aware && !conflict) { s->changed = FALSE; return TRUE; }
    if (!at && !d_append(s, &at, L"~", 1)) return FALSE;
    if (!d_append(s, &at, L"HIGHDPIAWARE", 12)) return FALSE;
    s->temporarySize = (at + 1) * sizeof(WCHAR); s->changed = TRUE; return TRUE;
}

CX_DPI_OVERRIDE *cx_dpi_begin(const WCHAR *client, WCHAR *error, DWORD errorCap) {
    CX_DPI_OVERRIDE *s;
    DWORD length, wait, type, size, code = ERROR_INVALID_PARAMETER;
    BOOL exists;
    LSTATUS status;
    if (error && errorCap) error[0] = 0;
    if (!client || !*client) { d_error(error, errorCap, L"Cannot resolve DPI compatibility target", code); return NULL; }
    s = (CX_DPI_OVERRIDE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*s));
    if (!s) { d_error(error, errorCap, L"Cannot allocate DPI compatibility snapshot", ERROR_NOT_ENOUGH_MEMORY); return NULL; }
    length = GetFullPathNameW(client, 32768, s->name, NULL);
    if (!length || length >= 32768) { code = GetLastError(); goto failed; }
    /* Serialize our own instances. External registry writers still require the
       byte comparison below; the registry does not provide compare-and-swap. */
    s->mutex = CreateMutexW(NULL, FALSE, L"Local\\ChaoxingPlus.DpiLayer.v1");
    if (!s->mutex) { code = GetLastError(); goto failed; }
    wait = WaitForSingleObject(s->mutex, 10000);
    s->mutexOwned = wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED;
    if (wait != WAIT_OBJECT_0) {
        code = wait == WAIT_FAILED ? GetLastError() : ERROR_BUSY; goto failed;
    }
    status = RegCreateKeyExW(HKEY_CURRENT_USER, CX_DPI_LAYERS_KEY, 0, NULL,
        REG_OPTION_NON_VOLATILE, KEY_QUERY_VALUE | KEY_SET_VALUE | KEY_WOW64_64KEY, NULL, &s->key, NULL);
    if (status != ERROR_SUCCESS) { code = (DWORD)status; goto failed; }
    if (!d_read(s, s->original, &s->originalType, &s->originalSize, &s->existed)) {
        code = GetLastError(); goto failed;
    }
    if (!d_prepare(s)) { code = ERROR_INVALID_DATA; goto failed; }
    if (!s->changed) return s;
    if (!d_read(s, s->observed, &type, &size, &exists)) { code = GetLastError(); goto failed; }
    if (!d_same(s->original, s->originalType, s->originalSize, s->existed, s->observed, type, size, exists)) {
        code = ERROR_BUSY; goto failed;
    }
    status = RegSetValueExW(s->key, s->name, 0, REG_SZ, (const BYTE *)s->temporary, s->temporarySize);
    if (status != ERROR_SUCCESS) { code = (DWORD)status; goto failed; }
    return s;
failed:
    d_free(s); d_error(error, errorCap, L"Cannot apply temporary DPI compatibility setting; client was not launched", code);
    return NULL;
}

BOOL cx_dpi_restore(CX_DPI_OVERRIDE *s, WCHAR *error, DWORD errorCap) {
    BOOL ok = FALSE, exists;
    DWORD attempt, type, size, code = ERROR_INVALID_PARAMETER;
    LSTATUS status;
    if (error && errorCap) error[0] = 0;
    if (!s) return TRUE;
    if (!s->changed) { d_free(s); return TRUE; }
    for (attempt = 0; attempt < 3; ++attempt) {
        if (!d_read(s, s->observed, &type, &size, &exists)) { code = GetLastError(); break; }
        if (d_same(s->original, s->originalType, s->originalSize, s->existed, s->observed, type, size, exists)) {
            ok = TRUE; break;
        }
        if (!d_same((const BYTE *)s->temporary, REG_SZ, s->temporarySize, TRUE, s->observed, type, size, exists)) {
            code = ERROR_BUSY; break;
        }
        status = s->existed ? RegSetValueExW(s->key, s->name, 0, s->originalType, s->original, s->originalSize)
            : RegDeleteValueW(s->key, s->name);
        if (status == ERROR_SUCCESS || (!s->existed && status == ERROR_FILE_NOT_FOUND)) { ok = TRUE; break; }
        code = (DWORD)status;
        if (attempt < 2) Sleep(10);
    }
    d_free(s);
    if (!ok) d_error(error, errorCap, L"Cannot restore temporary DPI compatibility setting; check current-user AppCompatFlags Layers", code);
    return ok;
}
