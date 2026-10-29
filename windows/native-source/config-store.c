#include "config-store.h"
#include "json.h"

#define CONFIG_PATH_CAP 32768

typedef struct { const char *text; DWORD length; JT *tokens; } CONFIG_DOCUMENT;
typedef struct {
    const CONFIG_DOCUMENT *document;
    int value;
    WCHAR *name;
} CONFIG_ENTRY;
typedef struct { CONFIG_ENTRY *entries; DWORD count, capacity; } CONFIG_MAP;
typedef struct { char *text; DWORD length, capacity; BOOL valid; } CONFIG_TEXT;

static volatile LONG temporarySequence;

static BOOL fail(WCHAR *error, DWORD cap, const WCHAR *message) {
    if (error && cap) lstrcpynW(error, message, (int)cap);
    return FALSE;
}
static void clear_error(WCHAR *error, DWORD cap) {
    if (error && cap) error[0] = 0;
}
static void release_document(CONFIG_DOCUMENT *document) {
    if (document->tokens) HeapFree(GetProcessHeap(), 0, document->tokens);
    document->tokens = NULL;
}
static BOOL parse_document(CONFIG_DOCUMENT *document, const char *text, DWORD length,
    WCHAR *error, DWORD errorCap) {
    document->text = text; document->length = length; document->tokens = NULL;
    if (!text || !length || length >= CX_CONFIG_JSON_CAP)
        return fail(error, errorCap, L"Configuration JSON is empty or exceeds its size limit.");
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, (int)length, NULL, 0))
        return fail(error, errorCap, L"Configuration JSON is not valid UTF-8.");
    document->tokens = (JT *)HeapAlloc(GetProcessHeap(), 0, ((SIZE_T)length + 1) * sizeof(JT));
    if (!document->tokens) return fail(error, errorCap, L"Unable to allocate configuration JSON tokens.");
    if (jparse(text, (int)length, document->tokens, (int)length + 1) < 1 || document->tokens[0].type != '{') {
        release_document(document);
        return fail(error, errorCap, L"Configuration JSON must be a valid object.");
    }
    return TRUE;
}
static WCHAR *decode_key(const CONFIG_DOCUMENT *document, int index) {
    const JT *token = document->tokens + index;
    const char *text = document->text;
    WCHAR *name; int i;
    /* jwstr preserves embedded NULs; reject them before C string comparison. */
    for (i = token->start; i < token->end; ++i) {
        if (text[i] == '\\') {
            ++i;
            if (text[i] == 'u') {
                if (text[i + 1] == '0' && text[i + 2] == '0' && text[i + 3] == '0' && text[i + 4] == '0')
                    return NULL;
                i += 4;
            }
        }
    }
    name = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, ((SIZE_T)(token->end - token->start) + 1) * sizeof(WCHAR));
    if (!name) return NULL;
    if (!jwstr(text, document->tokens, index, name, token->end - token->start + 1)) {
        HeapFree(GetProcessHeap(), 0, name); return NULL;
    }
    return name;
}
static BOOL prefix(const WCHAR *text, const WCHAR *start) {
    while (*start) { if (*text++ != *start++) return FALSE; }
    return TRUE;
}
static BOOL equal_key(const WCHAR *left, const WCHAR *right) {
    while (*left && *left == *right) { ++left; ++right; }
    return *left == *right;
}
static BOOL shared_key(const WCHAR *name) {
    if (equal_key(name, L"common.work-results.results")) return FALSE;
    return equal_key(name, L"common.apps.question-caches")
        || prefix(name, L"common.settings.") || prefix(name, L"cx.new.study.")
        || prefix(name, L"cx.new.work.") || prefix(name, L"cx.new.auto-read.")
        || prefix(name, L"cx.new.study-dispatcher.");
}
static void release_map(CONFIG_MAP *map) {
    DWORD i;
    for (i = 0; i < map->count; ++i) HeapFree(GetProcessHeap(), 0, map->entries[i].name);
    if (map->entries) HeapFree(GetProcessHeap(), 0, map->entries);
    ZeroMemory(map, sizeof(*map));
}
static int find_entry(const CONFIG_MAP *map, const WCHAR *name) {
    DWORD i;
    for (i = 0; i < map->count; ++i)
        if (equal_key(map->entries[i].name, name)) return (int)i;
    return -1;
}
static BOOL add_object(CONFIG_MAP *map, const CONFIG_DOCUMENT *document, int object,
    BOOL sharedOnly, WCHAR *error, DWORD errorCap) {
    int key, index; WCHAR *name;
    DWORD required = map->count + (DWORD)document->tokens[object].count / 2;
    if (required > map->capacity) {
        CONFIG_ENTRY *entries = (CONFIG_ENTRY *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)required * sizeof(CONFIG_ENTRY));
        if (!entries) return fail(error, errorCap, L"Unable to allocate configuration settings.");
        if (map->count) CopyMemory(entries, map->entries, (SIZE_T)map->count * sizeof(CONFIG_ENTRY));
        if (map->entries) HeapFree(GetProcessHeap(), 0, map->entries);
        map->entries = entries; map->capacity = required;
    }
    for (key = object + 1; key < document->tokens[object].next; key = document->tokens[key + 1].next) {
        name = decode_key(document, key);
        if (!name) return fail(error, errorCap, L"Configuration key contains NUL or cannot be decoded.");
        if (sharedOnly && !shared_key(name)) { HeapFree(GetProcessHeap(), 0, name); continue; }
        index = find_entry(map, name);
        if (index < 0) {
            index = (int)map->count++;
            map->entries[index].name = name;
        } else HeapFree(GetProcessHeap(), 0, name);
        map->entries[index].document = document;
        map->entries[index].value = key + 1;
    }
    return TRUE;
}
static void append(CONFIG_TEXT *out, const char *text, DWORD length) {
    if (!out->valid) return;
    if (length >= out->capacity - out->length) { out->valid = FALSE; return; }
    if (length) CopyMemory(out->text + out->length, text, length);
    out->length += length; out->text[out->length] = 0;
}
static void append_key(CONFIG_TEXT *out, const WCHAR *name) {
    static const char hex[] = "0123456789abcdef";
    DWORD i = 0;
    append(out, "\"", 1);
    while (name[i] && out->valid) {
        WCHAR ch = name[i]; int units = 1, bytes; char encoded[8];
        if (ch >= 0xd800 && ch <= 0xdbff && name[i + 1] >= 0xdc00 && name[i + 1] <= 0xdfff) units = 2;
        if (ch < 32 || (ch >= 0xd800 && ch <= 0xdfff && units == 1)) {
            encoded[0] = '\\'; encoded[1] = 'u';
            encoded[2] = hex[(ch >> 12) & 15]; encoded[3] = hex[(ch >> 8) & 15];
            encoded[4] = hex[(ch >> 4) & 15]; encoded[5] = hex[ch & 15];
            append(out, encoded, 6);
        } else if (ch == L'"' || ch == L'\\') {
            encoded[0] = '\\'; encoded[1] = (char)ch; append(out, encoded, 2);
        } else {
            bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name + i, units, encoded, sizeof(encoded), NULL, NULL);
            if (!bytes) { out->valid = FALSE; break; }
            append(out, encoded, (DWORD)bytes);
        }
        i += (DWORD)units;
    }
    append(out, "\"", 1);
}
static void append_entry(CONFIG_TEXT *out, const CONFIG_ENTRY *entry) {
    const JT *value = entry->document->tokens + entry->value;
    append_key(out, entry->name);
    append(out, ":", 1);
    if (value->type == 's') append(out, entry->document->text + value->start - 1, (DWORD)(value->end - value->start + 2));
    else append(out, entry->document->text + value->start, (DWORD)(value->end - value->start));
}
static void serialize_map(CONFIG_TEXT *out, const CONFIG_MAP *map, const CONFIG_MAP *mask) {
    DWORD i, written = 0;
    append(out, "{", 1);
    for (i = 0; i < map->count; ++i) {
        if (mask && find_entry(mask, map->entries[i].name) < 0) continue;
        if (written++) append(out, ",", 1);
        append_entry(out, map->entries + i);
    }
    append(out, "}", 1);
}
static BOOL transform(const char *base, DWORD baseLen, const char *patch, DWORD patchLen,
    char *out, DWORD outCap, DWORD *outLen, BOOL select, WCHAR *error, DWORD errorCap) {
    CONFIG_DOCUMENT first = {0}, second = {0};
    CONFIG_MAP values = {0}, mask = {0}; CONFIG_TEXT result = {0}; BOOL ok = FALSE;
    clear_error(error, errorCap);
    if (!out || !outLen || outCap < 3) return fail(error, errorCap, L"Configuration output buffer is too small.");
    if (!parse_document(&first, base, baseLen, error, errorCap)
        || !parse_document(&second, patch, patchLen, error, errorCap)) goto done;
    if (!add_object(&values, &first, 0, TRUE, error, errorCap)) goto done;
    if (!add_object(select ? &mask : &values, &second, 0, TRUE, error, errorCap)) goto done;
    result.capacity = outCap < CX_CONFIG_JSON_CAP ? outCap : CX_CONFIG_JSON_CAP;
    result.text = (char *)HeapAlloc(GetProcessHeap(), 0, result.capacity);
    if (!result.text) { fail(error, errorCap, L"Unable to allocate configuration output."); goto done; }
    result.valid = TRUE; result.text[0] = 0;
    serialize_map(&result, &values, select ? &mask : NULL);
    if (!result.valid) { fail(error, errorCap, L"Merged configuration exceeds the output size limit."); goto done; }
    CopyMemory(out, result.text, result.length + 1); *outLen = result.length; ok = TRUE;
done:
    if (result.text) HeapFree(GetProcessHeap(), 0, result.text);
    release_map(&values); release_map(&mask); release_document(&first); release_document(&second);
    return ok;
}
BOOL cx_config_merge_settings(const char *base, DWORD baseLen,
    const char *patch, DWORD patchLen, char *out, DWORD outCap,
    DWORD *outLen, WCHAR *error, DWORD errorCap) {
    return transform(base, baseLen, patch, patchLen, out, outCap, outLen, FALSE, error, errorCap);
}
BOOL cx_config_select_settings(const char *values, DWORD valuesLen,
    const char *mask, DWORD maskLen, char *out, DWORD outCap,
    DWORD *outLen, WCHAR *error, DWORD errorCap) {
    return transform(values, valuesLen, mask, maskLen, out, outCap, outLen, TRUE, error, errorCap);
}
static BOOL separator(WCHAR ch) { return ch == L'\\' || ch == L'/'; }
static BOOL ensure_parent(const WCHAR *fullPath) {
    WCHAR *copy; DWORD i, start = 0, length = (DWORD)lstrlenW(fullPath); BOOL ok = TRUE;
    copy = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)(length + 1) * sizeof(WCHAR));
    if (!copy) return FALSE;
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
        DWORD attributes;
        if (!separator(copy[i]) || !i || separator(copy[i - 1])) continue;
        copy[i] = 0;
        if (!CreateDirectoryW(copy, NULL)) {
            attributes = GetFileAttributesW(copy);
            if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY)) ok = FALSE;
        }
        copy[i] = fullPath[i];
        if (!ok) break;
    }
    HeapFree(GetProcessHeap(), 0, copy); return ok;
}
static void append_number(WCHAR *out, DWORD *used, DWORD number) {
    WCHAR digits[11]; DWORD count = 0;
    do { digits[count++] = (WCHAR)(L'0' + number % 10); number /= 10; } while (number);
    while (count) out[(*used)++] = digits[--count];
    out[*used] = 0;
}
static BOOL replace_file(const WCHAR *fullPath, const char *text, DWORD length,
    WCHAR *error, DWORD errorCap) {
    WCHAR *temporary; HANDLE file = INVALID_HANDLE_VALUE; DWORD attempt, used, n, written, total = 0;
    BOOL owned = FALSE, ok = FALSE;
    n = (DWORD)lstrlenW(fullPath);
    if (n + 64 >= CONFIG_PATH_CAP) return fail(error, errorCap, L"Configuration path is too long for a temporary file.");
    temporary = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, CONFIG_PATH_CAP * sizeof(WCHAR));
    if (!temporary) return fail(error, errorCap, L"Unable to allocate configuration temporary path.");
    if (!ensure_parent(fullPath)) { fail(error, errorCap, L"Unable to create configuration parent directory."); goto done; }
    for (attempt = 0; attempt < 64; ++attempt) {
        lstrcpyW(temporary, fullPath); lstrcatW(temporary, L".cx-"); used = (DWORD)lstrlenW(temporary);
        append_number(temporary, &used, GetCurrentProcessId()); temporary[used++] = L'-';
        append_number(temporary, &used, GetTickCount()); temporary[used++] = L'-';
        append_number(temporary, &used, (DWORD)InterlockedIncrement(&temporarySequence));
        lstrcatW(temporary, L".tmp");
        file = CreateFileW(temporary, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
        if (file != INVALID_HANDLE_VALUE) { owned = TRUE; break; }
        if (GetLastError() != ERROR_FILE_EXISTS && GetLastError() != ERROR_ALREADY_EXISTS) break;
    }
    if (!owned) { fail(error, errorCap, L"Unable to create a unique configuration temporary file."); goto done; }
    while (total < length) {
        if (!WriteFile(file, text + total, length - total, &written, NULL) || !written) {
            fail(error, errorCap, L"Unable to write complete configuration temporary file."); goto done;
        }
        total += written;
    }
    if (!FlushFileBuffers(file)) { fail(error, errorCap, L"Unable to flush configuration temporary file."); goto done; }
    CloseHandle(file); file = INVALID_HANDLE_VALUE;
    if (!MoveFileExW(temporary, fullPath, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        fail(error, errorCap, L"Unable to replace configuration file; previous file was preserved."); goto done;
    }
    owned = FALSE; ok = TRUE;
done:
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    if (owned) DeleteFileW(temporary);
    HeapFree(GetProcessHeap(), 0, temporary); return ok;
}
BOOL cx_config_patch_file(const WCHAR *path, const char *settings,
    DWORD settingsLen, WCHAR *error, DWORD errorCap) {
    CONFIG_DOCUMENT patch = {0}, original = {0}; CONFIG_MAP shared = {0}, roots = {0}, merged = {0};
    CONFIG_TEXT result = {0}; WCHAR *fullPath = NULL; char *disk = NULL;
    HANDLE file = INVALID_HANDLE_VALUE; DWORD length, high, got, n, i, written = 0;
    int settingsIndex; BOOL ok = FALSE;
    clear_error(error, errorCap);
    if (!parse_document(&patch, settings, settingsLen, error, errorCap)
        || !add_object(&shared, &patch, 0, TRUE, error, errorCap)) goto done;
    if (!shared.count) { ok = TRUE; goto done; }
    if (!path || !path[0]) { fail(error, errorCap, L"Configuration file path is empty."); goto done; }
    fullPath = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, CONFIG_PATH_CAP * sizeof(WCHAR));
    disk = (char *)HeapAlloc(GetProcessHeap(), 0, CX_CONFIG_JSON_CAP);
    result.text = (char *)HeapAlloc(GetProcessHeap(), 0, CX_CONFIG_JSON_CAP);
    if (!fullPath || !disk || !result.text) { fail(error, errorCap, L"Unable to allocate configuration file buffers."); goto done; }
    n = GetFullPathNameW(path, CONFIG_PATH_CAP, fullPath, NULL);
    if (!n || n >= CONFIG_PATH_CAP) { fail(error, errorCap, L"Unable to resolve configuration file path."); goto done; }
    file = CreateFileW(fullPath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        DWORD code = GetLastError();
        if (code != ERROR_FILE_NOT_FOUND && code != ERROR_PATH_NOT_FOUND) {
            fail(error, errorCap, L"Unable to read existing configuration file."); goto done;
        }
        disk[0] = '{'; disk[1] = '}'; disk[2] = 0; length = 2;
    } else {
        high = 0; length = GetFileSize(file, &high);
        if (high || length >= CX_CONFIG_JSON_CAP) { fail(error, errorCap, L"Existing configuration exceeds the size limit."); goto done; }
        if (!ReadFile(file, disk, length, &got, NULL) || got != length) {
            fail(error, errorCap, L"Unable to read complete configuration file."); goto done;
        }
        disk[length] = 0; CloseHandle(file); file = INVALID_HANDLE_VALUE;
    }
    n = length >= 3 && (BYTE)disk[0] == 0xef && (BYTE)disk[1] == 0xbb && (BYTE)disk[2] == 0xbf ? 3 : 0;
    if (!parse_document(&original, disk + n, length - n, error, errorCap)
        || !add_object(&roots, &original, 0, FALSE, error, errorCap)) goto done;
    settingsIndex = find_entry(&roots, L"settings");
    if (settingsIndex >= 0) {
        int object = roots.entries[settingsIndex].value;
        if (original.tokens[object].type != '{') {
            fail(error, errorCap, L"Existing configuration settings must be an object."); goto done;
        }
        if (!add_object(&merged, &original, object, TRUE, error, errorCap)) goto done;
    }
    if (!add_object(&merged, &patch, 0, TRUE, error, errorCap)) goto done;
    result.capacity = CX_CONFIG_JSON_CAP; result.valid = TRUE; result.text[0] = 0;
    append(&result, "{", 1);
    for (i = 0; i < roots.count; ++i) {
        if (equal_key(roots.entries[i].name, L"settings")) continue;
        if (written++) append(&result, ",", 1);
        append_entry(&result, roots.entries + i);
    }
    if (written) append(&result, ",", 1);
    append(&result, "\"settings\":", 11); serialize_map(&result, &merged, NULL); append(&result, "}", 1);
    if (!result.valid) { fail(error, errorCap, L"Updated configuration exceeds the size limit."); goto done; }
    ok = replace_file(fullPath, result.text, result.length, error, errorCap);
done:
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    if (fullPath) HeapFree(GetProcessHeap(), 0, fullPath);
    if (disk) HeapFree(GetProcessHeap(), 0, disk);
    if (result.text) HeapFree(GetProcessHeap(), 0, result.text);
    release_map(&shared); release_map(&roots); release_map(&merged);
    release_document(&patch); release_document(&original); return ok;
}
