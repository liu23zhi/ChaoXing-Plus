/* Dedicated bounded format: never shares the Node host's JSON cache. */
#define D_CACHE_MAGIC 0x43535843UL
#define D_CACHE_LIMIT (8UL * 1024UL * 1024UL)
#define D_CACHE_ROOT_LIMIT 128
#define D_CACHE_TTL 3000000000ULL

typedef struct D_CACHE_HEADER {
    DWORD magic, version, depth, osArchitecture, hostIs32Bit;
    DWORD commonCount, fixedCount, count, bytes;
    FILETIME created;
} D_CACHE_HEADER;
typedef struct D_CACHE_FILE {
    DWORD chars, machine, volume, indexHigh, indexLow, sizeHigh, sizeLow;
    FILETIME written;
} D_CACHE_FILE;
typedef struct D_CACHE_BUFFER { BYTE *bytes; DWORD length, at; } D_CACHE_BUFFER;

static DWORD d_cache_architecture(void) {
    SYSTEM_INFO system; GetNativeSystemInfo(&system); return system.wProcessorArchitecture;
}
static BOOL d_cache_enabled(const CX_DISCOVERY_OPTIONS *options, const CX_DISCOVERY_ROOTS *roots) {
    return options && options->cachePath && *options->cachePath && !options->noDiskWrite && !options->noScanCache
        && options->mode != CX_DISCOVERY_SCAN_ALL && !(options->clientPath && *options->clientPath)
        && roots && roots->commonRootCount <= D_CACHE_ROOT_LIMIT && roots->fixedRootCount <= D_CACHE_ROOT_LIMIT;
}
static WCHAR *d_cache_full_path(const WCHAR *path) {
    WCHAR *full; DWORD length;
    if (!path || !*path) return NULL;
    full = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, CX_DISCOVERY_MAX_PATH * sizeof(WCHAR));
    if (!full) return NULL;
    length = GetFullPathNameW(path, CX_DISCOVERY_MAX_PATH, full, NULL);
    if (!length || length >= CX_DISCOVERY_MAX_PATH || length < 3 || full[1] != L':' || full[2] != L'\\') {
        HeapFree(GetProcessHeap(), 0, full); return NULL;
    }
    while (length > 3 && full[length - 1] == L'\\') full[--length] = 0;
    return full;
}

/* Inspect every existing ancestor, not just the final file. */
static BOOL d_cache_safe_path(WCHAR *path, BOOL file, BOOL createParents) {
    DWORD i, attributes;
    if (!path || !d_safe_root(path)) return FALSE;
    for (i = 3;; ++i) if (!path[i] || path[i] == L'\\') {
        WCHAR saved = path[i];
        path[i] = 0; attributes = GetFileAttributesW(path);
        if (attributes == INVALID_FILE_ATTRIBUTES && createParents) {
            DWORD code = GetLastError();
            if (!saved && file && (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND)) { path[i] = saved; return TRUE; }
            if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) {
                if (CreateDirectoryW(path, NULL) || GetLastError() == ERROR_ALREADY_EXISTS) attributes = GetFileAttributesW(path);
            }
        }
        path[i] = saved;
        if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return FALSE;
        if ((!saved && file) ? (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 : (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) return FALSE;
        if (!saved) return TRUE;
    }
}
static BOOL d_cache_fingerprint(WCHAR *path, D_CACHE_FILE *fingerprint) {
    HANDLE file; BY_HANDLE_FILE_INFORMATION info; BOOL ok = FALSE;
    if (!d_cache_safe_path(path, TRUE, FALSE)) return FALSE;
    file = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    if (GetFileInformationByHandle(file, &info) && !(info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) {
        fingerprint->volume = info.dwVolumeSerialNumber; fingerprint->indexHigh = info.nFileIndexHigh; fingerprint->indexLow = info.nFileIndexLow;
        fingerprint->sizeHigh = info.nFileSizeHigh; fingerprint->sizeLow = info.nFileSizeLow; fingerprint->written = info.ftLastWriteTime; ok = TRUE;
    }
    CloseHandle(file); return ok;
}
static BOOL d_cache_same_file(const D_CACHE_FILE *a, const D_CACHE_FILE *b) {
    return a->volume == b->volume && a->indexHigh == b->indexHigh && a->indexLow == b->indexLow
        && a->sizeHigh == b->sizeHigh && a->sizeLow == b->sizeLow
        && a->written.dwHighDateTime == b->written.dwHighDateTime && a->written.dwLowDateTime == b->written.dwLowDateTime;
}
static BOOL d_cache_under_root(const WCHAR *path, const WCHAR *root) {
    WCHAR *full = d_cache_full_path(root);
    DWORD i, start, separators = 0; BOOL ok = FALSE;
    if (!full) return FALSE;
    for (i = 0; full[i]; ++i) {
        WCHAR a = path[i], b = full[i];
        if (!a) goto done;
        if (a >= L'A' && a <= L'Z') a = (WCHAR)(a + 32);
        if (b >= L'A' && b <= L'Z') b = (WCHAR)(b + 32);
        if (a != b) goto done;
    }
    if (i > 3) { if (path[i] != L'\\') goto done; ++i; }
    start = i;
    for (; path[i]; ++i) if (path[i] == L'\\') { if (++separators > 1 || i == start) goto done; start = i + 1; }
    ok = d_is_candidate_name(path + start);
done:
    HeapFree(GetProcessHeap(), 0, full); return ok;
}
static BOOL d_cache_in_scope(const WCHAR *path, const CX_DISCOVERY_ROOTS *roots) {
    DWORD i;
    for (i = 0; i < roots->commonRootCount; ++i) if (d_cache_under_root(path, roots->commonRoots[i])) return TRUE;
    for (i = 0; i < roots->fixedRootCount; ++i) if (d_cache_under_root(path, roots->fixedRoots[i])) return TRUE;
    return FALSE;
}
static BOOL d_cache_append(D_CACHE_BUFFER *buffer, const void *bytes, DWORD length) {
    if (buffer->at > buffer->length || length > buffer->length - buffer->at) return FALSE;
    CopyMemory(buffer->bytes + buffer->at, bytes, length); buffer->at += length; return TRUE;
}
static const void *d_cache_take(D_CACHE_BUFFER *buffer, DWORD length) {
    const void *value;
    if (buffer->at > buffer->length || length > buffer->length - buffer->at) return NULL;
    value = buffer->bytes + buffer->at; buffer->at += length; return value;
}
static BOOL d_cache_append_root(D_CACHE_BUFFER *buffer, const WCHAR *path) {
    WCHAR *full = d_cache_full_path(path); DWORD chars; BOOL ok;
    if (!full) return FALSE;
    chars = d_len(full) + 1;
    ok = d_cache_append(buffer, &chars, sizeof(chars)) && d_cache_append(buffer, full, chars * sizeof(WCHAR));
    HeapFree(GetProcessHeap(), 0, full); return ok;
}
static const WCHAR *d_cache_take_string(D_CACHE_BUFFER *buffer, DWORD chars) {
    const WCHAR *path;
    if (!chars || chars > CX_DISCOVERY_MAX_PATH) return NULL;
    path = (const WCHAR *)d_cache_take(buffer, chars * sizeof(WCHAR));
    if (!path || path[chars - 1] || d_len(path) != chars - 1) return NULL;
    return path;
}
static BOOL d_cache_root_matches(D_CACHE_BUFFER *buffer, const WCHAR *root) {
    const DWORD *chars = (const DWORD *)d_cache_take(buffer, sizeof(DWORD));
    const WCHAR *cached; WCHAR *full; BOOL ok;
    if (!chars || !(cached = d_cache_take_string(buffer, *chars))) return FALSE;
    full = d_cache_full_path(root); ok = full && d_equal_ci(full, cached);
    if (full) HeapFree(GetProcessHeap(), 0, full); return ok;
}
static BOOL d_cache_read(const WCHAR *cachePath, const CX_DISCOVERY_ROOTS *roots, BOOL hostIs32Bit, CX_DISCOVERY_RESULT *result) {
    WCHAR *full = d_cache_full_path(cachePath); HANDLE file = INVALID_HANDLE_VALUE;
    LARGE_INTEGER size; BY_HANDLE_FILE_INFORMATION fileInfo; DWORD read, i; D_CACHE_BUFFER buffer;
    const D_CACHE_HEADER *header; FILETIME now; ULARGE_INTEGER created, current;
    D_CONTEXT context; BOOL ok = FALSE;
    d_zero(&buffer, sizeof(buffer)); d_zero(&context, sizeof(context));
    if (!full || !d_cache_safe_path(full, TRUE, FALSE)) goto done;
    file = CreateFileW(full, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (file == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(file, &fileInfo)
        || (fileInfo.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
        || !GetFileSizeEx(file, &size) || size.QuadPart < sizeof(D_CACHE_HEADER) || size.QuadPart > D_CACHE_LIMIT) goto done;
    buffer.length = (DWORD)size.QuadPart; buffer.bytes = (BYTE *)HeapAlloc(GetProcessHeap(), 0, buffer.length);
    if (!buffer.bytes || !ReadFile(file, buffer.bytes, buffer.length, &read, NULL) || read != buffer.length) goto done;
    header = (const D_CACHE_HEADER *)d_cache_take(&buffer, sizeof(*header));
    if (!header || header->magic != D_CACHE_MAGIC || header->version != CX_DISCOVERY_CACHE_FORMAT_VERSION || header->depth != 1
        || header->osArchitecture != d_cache_architecture() || header->hostIs32Bit != (DWORD)hostIs32Bit
        || header->commonCount != roots->commonRootCount || header->fixedCount != roots->fixedRootCount
        || !header->count || header->count > CX_DISCOVERY_MAX_CANDIDATES || header->bytes != buffer.length) goto done;
    GetSystemTimeAsFileTime(&now); current.LowPart = now.dwLowDateTime; current.HighPart = now.dwHighDateTime;
    created.LowPart = header->created.dwLowDateTime; created.HighPart = header->created.dwHighDateTime;
    if (created.QuadPart > current.QuadPart || current.QuadPart - created.QuadPart > D_CACHE_TTL) goto done;
    for (i = 0; i < roots->commonRootCount; ++i) if (!d_cache_root_matches(&buffer, roots->commonRoots[i])) goto done;
    for (i = 0; i < roots->fixedRootCount; ++i) if (!d_cache_root_matches(&buffer, roots->fixedRoots[i])) goto done;
    context.result = result; context.hostIs32Bit = hostIs32Bit; context.complete = TRUE;
    for (i = 0; i < header->count; ++i) {
        const D_CACHE_FILE *stored = (const D_CACHE_FILE *)d_cache_take(&buffer, sizeof(D_CACHE_FILE));
        const WCHAR *path; WCHAR *canonical; D_CACHE_FILE actual; WORD machine, major, minor;
        WCHAR version[CX_DISCOVERY_VERSION_CAP]; BOOL valid;
        if (!stored || !(path = d_cache_take_string(&buffer, stored->chars))) goto done;
        canonical = d_cache_full_path(path);
        valid = canonical && d_equal_ci(path, canonical) && d_cache_in_scope(canonical, roots)
            && d_cache_fingerprint(canonical, &actual) && d_cache_same_file(stored, &actual)
            && proc_pe(canonical, &machine, &major, &minor, version, CX_DISCOVERY_VERSION_CAP)
            && machine == stored->machine && (machine == CX_DISCOVERY_MACHINE_X86 || machine == CX_DISCOVERY_MACHINE_X64)
            && (!hostIs32Bit || machine == CX_DISCOVERY_MACHINE_X86)
            && d_add_candidate(&context, canonical, machine, version);
        if (canonical) HeapFree(GetProcessHeap(), 0, canonical);
        if (!valid) goto done;
    }
    if (buffer.at != buffer.length || result->count != header->count) goto done;
    result->commonScanned = TRUE; result->cacheHit = TRUE; d_choose(result, FALSE); ok = TRUE;
done:
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    if (full) HeapFree(GetProcessHeap(), 0, full);
    if (buffer.bytes) HeapFree(GetProcessHeap(), 0, buffer.bytes);
    if (!ok) cx_discovery_free(result);
    return ok;
}
static void d_cache_decimal(WCHAR *out, DWORD value) {
    WCHAR digits[16]; DWORD n = 0, i = 0;
    do { digits[n++] = (WCHAR)(L'0' + value % 10); value /= 10; } while (value);
    while (n) out[i++] = digits[--n]; out[i] = 0;
}
static void d_cache_write(const WCHAR *cachePath, const CX_DISCOVERY_ROOTS *roots, BOOL hostIs32Bit, const CX_DISCOVERY_RESULT *result) {
    WCHAR *full = d_cache_full_path(cachePath), *temporary = NULL;
    D_CACHE_BUFFER buffer; D_CACHE_HEADER *header; HANDLE file = INVALID_HANDLE_VALUE;
    DWORD i, written, length, attempt; BOOL owned = FALSE, ok = FALSE;
    d_zero(&buffer, sizeof(buffer));
    if (!full || !result->count || result->truncated || result->fallbackScanned || result->stoppedOnX86) goto done;
    buffer.length = D_CACHE_LIMIT; buffer.bytes = (BYTE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, buffer.length);
    if (!buffer.bytes) goto done;
    header = (D_CACHE_HEADER *)buffer.bytes; buffer.at = sizeof(*header);
    header->magic = D_CACHE_MAGIC; header->version = CX_DISCOVERY_CACHE_FORMAT_VERSION; header->depth = 1;
    header->osArchitecture = d_cache_architecture(); header->hostIs32Bit = hostIs32Bit;
    header->commonCount = roots->commonRootCount; header->fixedCount = roots->fixedRootCount; header->count = result->count;
    GetSystemTimeAsFileTime(&header->created);
    for (i = 0; i < roots->commonRootCount; ++i) if (!d_cache_append_root(&buffer, roots->commonRoots[i])) goto done;
    for (i = 0; i < roots->fixedRootCount; ++i) if (!d_cache_append_root(&buffer, roots->fixedRoots[i])) goto done;
    for (i = 0; i < result->count; ++i) {
        WCHAR *canonical = d_cache_full_path(result->items[i].path); D_CACHE_FILE info; BOOL valid;
        d_zero(&info, sizeof(info));
        valid = canonical && d_cache_in_scope(canonical, roots) && d_cache_fingerprint(canonical, &info);
        if (valid) {
            info.chars = d_len(canonical) + 1; info.machine = result->items[i].machine;
            valid = d_cache_append(&buffer, &info, sizeof(info)) && d_cache_append(&buffer, canonical, info.chars * sizeof(WCHAR));
        }
        if (canonical) HeapFree(GetProcessHeap(), 0, canonical);
        if (!valid) goto done;
    }
    header->bytes = buffer.at;
    if (!d_cache_safe_path(full, TRUE, TRUE)) goto done;
    length = d_len(full);
    if (length + 64 >= CX_DISCOVERY_MAX_PATH) goto done;
    temporary = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, (length + 64) * sizeof(WCHAR));
    if (!temporary) goto done;
    for (attempt = 0; attempt < 8; ++attempt) {
        DWORD at; WCHAR decimal[16];
        d_copy(temporary, length + 64, full); at = length;
        temporary[at++] = L'.'; temporary[at++] = L't'; temporary[at++] = L'm'; temporary[at++] = L'p'; temporary[at++] = L'-';
        d_cache_decimal(decimal, GetCurrentProcessId()); d_copy(temporary + at, length + 64 - at, decimal); at += d_len(decimal);
        temporary[at++] = L'-'; d_cache_decimal(decimal, GetTickCount()); d_copy(temporary + at, length + 64 - at, decimal); at += d_len(decimal);
        temporary[at++] = L'-'; temporary[at++] = (WCHAR)(L'0' + attempt); temporary[at] = 0;
        file = CreateFileW(temporary, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
        if (file != INVALID_HANDLE_VALUE) { owned = TRUE; break; }
        if (GetLastError() != ERROR_FILE_EXISTS && GetLastError() != ERROR_ALREADY_EXISTS) goto done;
    }
    if (!owned) goto done;
    ok = WriteFile(file, buffer.bytes, buffer.at, &written, NULL) && written == buffer.at && FlushFileBuffers(file);
    CloseHandle(file); file = INVALID_HANDLE_VALUE;
    if (ok) ok = MoveFileExW(temporary, full, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
done:
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    if (owned && !ok) DeleteFileW(temporary);
    if (temporary) HeapFree(GetProcessHeap(), 0, temporary);
    if (full) HeapFree(GetProcessHeap(), 0, full);
    if (buffer.bytes) HeapFree(GetProcessHeap(), 0, buffer.bytes);
}
