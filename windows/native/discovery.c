#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <shlobj.h>
#include "discovery.h"
#include "process.h"

#define D_ROOT_LIMIT 4096
#define D_ENTRY_LIMIT 65536

typedef struct D_ROOT_LIST {
    WCHAR **items;
    DWORD count;
    DWORD capacity;
} D_ROOT_LIST;

typedef struct D_ENTRY {
    WCHAR *name;
    DWORD attributes;
} D_ENTRY;

typedef struct D_CONTEXT {
    CX_DISCOVERY_RESULT *result;
    BOOL hostIs32Bit;
    BOOL stopOnX86;
    BOOL stopped;
    BOOL complete;
    BOOL cancelled;
    DWORD directoriesVisited;
    DWORD lastProgressTick;
    void *progressContext;
    void (*onProgress)(void *progressContext, DWORD directoriesVisited, DWORD candidatesFound);
    BOOL (*cancelRequested)(void *progressContext);
    WCHAR *error;
    DWORD errorCap;
} D_CONTEXT;

static void d_zero(void *memory, SIZE_T size) {
    volatile BYTE *p = (volatile BYTE *)memory;
    while (size) { *p++ = 0; --size; }
}

static DWORD d_len(const WCHAR *text) {
    DWORD length = 0;
    if (!text) return 0;
    while (text[length]) ++length;
    return length;
}

static BOOL d_equal_ci(const WCHAR *left, const WCHAR *right) {
    DWORD i = 0;
    WCHAR a, b;
    if (!left || !right) return FALSE;
    for (;;) {
        a = left[i]; b = right[i];
        if (a >= L'A' && a <= L'Z') a = (WCHAR)(a + 32);
        if (b >= L'A' && b <= L'Z') b = (WCHAR)(b + 32);
        if (a != b) return FALSE;
        if (!a) return TRUE;
        ++i;
    }
}

static int d_compare_ci(const WCHAR *left, const WCHAR *right) {
    DWORD i = 0;
    WCHAR a, b;
    if (!left) return right ? -1 : 0;
    if (!right) return 1;
    for (;;) {
        a = left[i]; b = right[i];
        if (a >= L'A' && a <= L'Z') a = (WCHAR)(a + 32);
        if (b >= L'A' && b <= L'Z') b = (WCHAR)(b + 32);
        if (a < b) return -1;
        if (a > b) return 1;
        if (!a) return 0;
        ++i;
    }
}

static BOOL d_copy(WCHAR *output, DWORD cap, const WCHAR *input) {
    DWORD i = 0;
    if (!output || !cap) return FALSE;
    if (!input) { output[0] = 0; return TRUE; }
    while (input[i] && i + 1 < cap) { output[i] = input[i]; ++i; }
    output[i] = 0;
    return input[i] == 0;
}

static WCHAR *d_dup(const WCHAR *input) {
    DWORD length;
    WCHAR *copy;
    if (!input) return NULL;
    length = d_len(input);
    if (length >= CX_DISCOVERY_MAX_PATH) return NULL;
    copy = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, ((SIZE_T)length + 1) * sizeof(WCHAR));
    if (!copy) return NULL;
    d_copy(copy, length + 1, input);
    return copy;
}

static WCHAR *d_join(const WCHAR *directory, const WCHAR *name) {
    DWORD left, right, at;
    WCHAR *output;
    if (!directory || !name) return NULL;
    left = d_len(directory); right = d_len(name);
    if (left + right + 2 >= CX_DISCOVERY_MAX_PATH) return NULL;
    output = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, ((SIZE_T)left + right + 2) * sizeof(WCHAR));
    if (!output) return NULL;
    at = 0;
    while (directory[at]) { output[at] = directory[at]; ++at; }
    if (at && output[at - 1] != L'\\' && output[at - 1] != L'/') output[at++] = L'\\';
    while (*name) output[at++] = *name++;
    output[at] = 0;
    return output;
}

static void d_error(D_CONTEXT *context, const WCHAR *text) {
    if (!context || !context->error || !context->errorCap) return;
    d_copy(context->error, context->errorCap, text ? text : L"");
}
static BOOL d_progress_cancelled(D_CONTEXT *context) {
    if (!context || context->cancelled) return TRUE;
    if (context->cancelRequested && context->cancelRequested(context->progressContext)) {
        context->cancelled = TRUE;
        context->stopped = TRUE;
        d_error(context, L"scan cancelled by user");
        return TRUE;
    }
    return FALSE;
}

static void d_report_progress(D_CONTEXT *context, BOOL force) {
    DWORD now, candidates;
    if (!context || !context->onProgress) return;
    now = GetTickCount();
    if (!force && now - context->lastProgressTick < 200) return;
    context->lastProgressTick = now;
    candidates = context->result ? context->result->count : 0;
    context->onProgress(context->progressContext, context->directoriesVisited, candidates);
}

static void d_init_progress(D_CONTEXT *context, const CX_DISCOVERY_OPTIONS *options) {
    if (!context) return;
    context->cancelled = FALSE;
    context->directoriesVisited = 0;
    context->lastProgressTick = 0;
    /* Explicit-client resolution has no options; never leave function pointers
       uninitialized because traversal polls them on every directory. */
    context->progressContext = NULL;
    context->onProgress = NULL;
    context->cancelRequested = NULL;
    if (!options) return;
    context->progressContext = options->progressContext;
    context->onProgress = options->onProgress;
    context->cancelRequested = options->cancelRequested;
}

static void d_result_reset(CX_DISCOVERY_RESULT *result) {
    if (!result) return;
    result->count = 0;
    result->recommendedIndex = 0;
    result->commonScanned = FALSE;
    result->fallbackScanned = FALSE;
    result->stoppedOnX86 = FALSE;
    result->truncated = FALSE;
    result->cacheHit = FALSE;
    result->cancelled = FALSE;
}

void cx_discovery_init(CX_DISCOVERY_RESULT *result) {
    if (!result) return;
    d_zero(result, sizeof(*result));
}

void cx_discovery_free(CX_DISCOVERY_RESULT *result) {
    DWORD i;
    if (!result) return;
    if (result->items) {
        for (i = 0; i < result->count; ++i) if (result->items[i].path) HeapFree(GetProcessHeap(), 0, result->items[i].path);
        HeapFree(GetProcessHeap(), 0, result->items);
    }
    d_zero(result, sizeof(*result));
}

static BOOL d_add_candidate(D_CONTEXT *context, const WCHAR *path, WORD machine, const WCHAR *version) {
    CX_DISCOVERY_RESULT *result = context->result;
    DWORD i;
    CX_CLIENT_CANDIDATE *resized;
    WCHAR *copy;
    if (context->hostIs32Bit && machine == CX_DISCOVERY_MACHINE_X64) return FALSE;
    for (i = 0; i < result->count; ++i) if (d_equal_ci(result->items[i].path, path)) return FALSE;
    if (result->count >= CX_DISCOVERY_MAX_CANDIDATES) {
        result->truncated = TRUE;
        d_error(context, L"client candidate limit reached (1024)");
        return FALSE;
    }
    if (result->count == result->capacity) {
        DWORD capacity = result->capacity ? result->capacity * 2 : 32;
        if (capacity > CX_DISCOVERY_MAX_CANDIDATES) capacity = CX_DISCOVERY_MAX_CANDIDATES;
        if (result->items) resized = (CX_CLIENT_CANDIDATE *)HeapReAlloc(GetProcessHeap(), 0, result->items, sizeof(CX_CLIENT_CANDIDATE) * capacity);
        else resized = (CX_CLIENT_CANDIDATE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(CX_CLIENT_CANDIDATE) * capacity);
        if (!resized) { context->complete = FALSE; d_error(context, L"out of memory while storing client candidates"); return FALSE; }
        result->items = resized;
        result->capacity = capacity;
    }
    copy = d_dup(path);
    if (!copy) { context->complete = FALSE; d_error(context, L"client path is too long or memory allocation failed"); return FALSE; }
    result->items[result->count].path = copy;
    result->items[result->count].machine = machine;
    d_copy(result->items[result->count].version, CX_DISCOVERY_VERSION_CAP, version ? version : L"unknown");
    ++result->count;
    if (context->stopOnX86 && machine == CX_DISCOVERY_MACHINE_X86) {
        context->stopped = TRUE;
        result->stoppedOnX86 = TRUE;
    }
    return TRUE;
}

static BOOL d_is_candidate_name(const WCHAR *name) { return d_equal_ci(name, L"CXExam.exe"); }

static BOOL d_is_candidate_path(const WCHAR *path) {
    const WCHAR *name = path;
    DWORD i;
    if (!path) return FALSE;
    for (i = 0; path[i]; ++i) if (path[i] == L'\\' || path[i] == L'/') name = path + i + 1;
    return d_is_candidate_name(name);
}

static BOOL d_safe_root(const WCHAR *directory) {
    const WCHAR *segment;
    DWORD i, start = 0;
    WCHAR component[256];
    if (!directory || !*directory) return FALSE;
    segment = directory;
    if (directory[0] && directory[1] == L':') segment = directory + 2;
    else if (directory[0] == L'\\' && directory[1] == L'\\') {
        segment = directory + 2;
        while (*segment && *segment != L'\\' && *segment != L'/') ++segment;
        if (*segment) ++segment;
        while (*segment && *segment != L'\\' && *segment != L'/') ++segment;
    }
    while (*segment == L'\\' || *segment == L'/') ++segment;
    i = 0;
    for (;;) {
        WCHAR c = segment[i];
        if (!c || c == L'\\' || c == L'/') {
            DWORD count = i - start, j;
            if (count && count < 256) {
                for (j = 0; j < count; ++j) component[j] = segment[start + j];
                component[count] = 0;
                if (d_equal_ci(component, L"Windows") || d_equal_ci(component, L"System32")
                    || d_equal_ci(component, L"SysWOW64") || d_equal_ci(component, L"$Recycle.Bin")
                    || d_equal_ci(component, L"System Volume Information") || d_equal_ci(component, L"Recovery")
                    || d_equal_ci(component, L"WinSxS")) return FALSE;
            }
            if (!c) break;
            start = i + 1;
        }
        ++i;
    }
    return TRUE;
}

static BOOL d_add_file(D_CONTEXT *context, const WCHAR *path) {
    WORD machine = 0, major = 0, minor = 0;
    WCHAR version[CX_DISCOVERY_VERSION_CAP];
    if (!proc_pe(path, &machine, &major, &minor, version, CX_DISCOVERY_VERSION_CAP)) return FALSE;
    if (machine != CX_DISCOVERY_MACHINE_X86 && machine != CX_DISCOVERY_MACHINE_X64) return FALSE;
    return d_add_candidate(context, path, machine, version);
}

static BOOL d_skip_directory(const WCHAR *name, DWORD attributes) {
    if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) return TRUE;
    if (!name || !*name) return TRUE;
    if (d_equal_ci(name, L"Windows") || d_equal_ci(name, L"System32") || d_equal_ci(name, L"SysWOW64")
        || d_equal_ci(name, L"$Recycle.Bin") || d_equal_ci(name, L"System Volume Information")
        || d_equal_ci(name, L"Recovery") || d_equal_ci(name, L"WinSxS")) return TRUE;
    return FALSE;
}

static void d_entries_free(D_ENTRY *entries, DWORD count) {
    DWORD i;
    if (!entries) return;
    for (i = 0; i < count; ++i) if (entries[i].name) HeapFree(GetProcessHeap(), 0, entries[i].name);
    HeapFree(GetProcessHeap(), 0, entries);
}

static D_ENTRY *d_entries_read(D_CONTEXT *context, const WCHAR *directory, DWORD *count) {
    HANDLE find;
    WIN32_FIND_DATAW data;
    WCHAR *pattern;
    D_ENTRY *entries = NULL, *resized;
    DWORD used = 0, capacity = 0;
    if (count) *count = 0;
    pattern = d_join(directory, L"*");
    if (!pattern) { context->complete = FALSE; return NULL; }
    find = FindFirstFileW(pattern, &data);
    HeapFree(GetProcessHeap(), 0, pattern);
    if (find == INVALID_HANDLE_VALUE) {
        DWORD code = GetLastError();
        if (code != ERROR_FILE_NOT_FOUND && code != ERROR_PATH_NOT_FOUND) context->complete = FALSE;
        return NULL;
    }
    do {
        if (d_equal_ci(data.cFileName, L".") || d_equal_ci(data.cFileName, L"..")) continue;
        if (used >= D_ENTRY_LIMIT) { context->result->truncated = TRUE; d_error(context, L"directory entry limit reached (65536)"); break; }
        if (used == capacity) {
            capacity = capacity ? capacity * 2 : 32;
            resized = entries ? (D_ENTRY *)HeapReAlloc(GetProcessHeap(), 0, entries, sizeof(D_ENTRY) * capacity)
                               : (D_ENTRY *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(D_ENTRY) * capacity);
            if (!resized) { context->complete = FALSE; d_entries_free(entries, used); FindClose(find); return NULL; }
            entries = resized;
        }
        entries[used].name = d_dup(data.cFileName);
        if (!entries[used].name) { context->complete = FALSE; d_entries_free(entries, used); FindClose(find); return NULL; }
        entries[used].attributes = data.dwFileAttributes;
        ++used;
    } while (FindNextFileW(find, &data));
    if (GetLastError() != ERROR_NO_MORE_FILES) context->complete = FALSE;
    FindClose(find);
    if (entries) {
        DWORD i, j;
        for (i = 1; i < used; ++i) {
            D_ENTRY hold = entries[i];
            j = i;
            while (j && d_compare_ci(entries[j - 1].name, hold.name) > 0) { entries[j] = entries[j - 1]; --j; }
            entries[j] = hold;
        }
    }
    if (count) *count = used;
    return entries;
}

static void d_visit(D_CONTEXT *context, const WCHAR *directory, LONG depth) {
    D_ENTRY *entries;
    DWORD count = 0, i;
    DWORD attributes;
    if (context->stopped) return;
    if (d_progress_cancelled(context)) return;
    if (!d_safe_root(directory)) return;
    attributes = GetFileAttributesW(directory);
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        DWORD code = GetLastError();
        if (code != ERROR_FILE_NOT_FOUND && code != ERROR_PATH_NOT_FOUND) context->complete = FALSE;
        return;
    }
    if (!(attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return;
    entries = d_entries_read(context, directory, &count);
    context->directoriesVisited += 1;
    d_report_progress(context, FALSE);
    if (d_progress_cancelled(context)) {
        d_entries_free(entries, count);
        return;
    }
    if (!entries) return;
    for (i = 0; i < count && !context->stopped; ++i) {
        WCHAR *path;
        if (d_progress_cancelled(context)) break;
        if (entries[i].attributes & FILE_ATTRIBUTE_DIRECTORY) continue;
        if (!d_is_candidate_name(entries[i].name) || (entries[i].attributes & FILE_ATTRIBUTE_REPARSE_POINT)) continue;
        path = d_join(directory, entries[i].name);
        if (path) { d_add_file(context, path); HeapFree(GetProcessHeap(), 0, path); }
        else context->complete = FALSE;
    }
    if (depth != 0) {
        for (i = 0; i < count && !context->stopped; ++i) {
            WCHAR *path;
            if (d_progress_cancelled(context)) break;
            if (!(entries[i].attributes & FILE_ATTRIBUTE_DIRECTORY) || d_skip_directory(entries[i].name, entries[i].attributes)) continue;
            path = d_join(directory, entries[i].name);
            if (path) { d_visit(context, path, depth < 0 ? -1 : depth - 1); HeapFree(GetProcessHeap(), 0, path); }
            else context->complete = FALSE;
        }
    }
    d_entries_free(entries, count);
}

static BOOL d_root_list_add(D_ROOT_LIST *list, const WCHAR *root) {
    WCHAR **resized;
    WCHAR *copy;
    DWORD i;
    if (!list || !root || !*root || list->count >= D_ROOT_LIMIT) return FALSE;
    for (i = 0; i < list->count; ++i) if (d_equal_ci(list->items[i], root)) return TRUE;
    copy = d_dup(root);
    if (!copy) return FALSE;
    if (list->count == list->capacity) {
        DWORD capacity = list->capacity ? list->capacity * 2 : 16;
        resized = list->items ? (WCHAR **)HeapReAlloc(GetProcessHeap(), 0, list->items, sizeof(WCHAR *) * capacity)
                               : (WCHAR **)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(WCHAR *) * capacity);
        if (!resized) { HeapFree(GetProcessHeap(), 0, copy); return FALSE; }
        list->items = resized; list->capacity = capacity;
    }
    list->items[list->count++] = copy;
    return TRUE;
}

static void d_root_list_free(D_ROOT_LIST *list) {
    DWORD i;
    if (!list) return;
    for (i = 0; i < list->count; ++i) if (list->items[i]) HeapFree(GetProcessHeap(), 0, list->items[i]);
    if (list->items) HeapFree(GetProcessHeap(), 0, list->items);
    d_zero(list, sizeof(*list));
}

static void d_env_root(D_ROOT_LIST *common, const WCHAR *name, const WCHAR *suffix) {
    WCHAR *value;
    WCHAR *root;
    DWORD length;
    value = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, CX_DISCOVERY_MAX_PATH * sizeof(WCHAR));
    if (!value) return;
    length = GetEnvironmentVariableW(name, value, CX_DISCOVERY_MAX_PATH);
    if (!length || length >= CX_DISCOVERY_MAX_PATH) { HeapFree(GetProcessHeap(), 0, value); return; }
    root = suffix ? d_join(value, suffix) : d_dup(value);
    HeapFree(GetProcessHeap(), 0, value);
    if (root) { d_root_list_add(common, root); HeapFree(GetProcessHeap(), 0, root); }
}

static void d_known_desktop(D_ROOT_LIST *common) {
    WCHAR path[MAX_PATH];
    /* SHGetFolderPathW resolves the user's redirected Known Folder (including
       OneDrive policy) without relying on USERPROFILE or registry expansion. */
    if (SHGetFolderPathW(NULL, CSIDL_DESKTOPDIRECTORY, NULL, SHGFP_TYPE_CURRENT, path) == S_OK)
        d_root_list_add(common, path);
}

static void d_default_roots(D_ROOT_LIST *common, D_ROOT_LIST *fixed) {
    DWORD mask, i;
    d_known_desktop(common);
    d_env_root(common, L"OneDrive", L"Desktop");
    d_env_root(common, L"OneDriveConsumer", L"Desktop");
    /* Under WOW64, ProgramFiles is redirected to x86.  ProgramW6432 is the
       native x64 location and is intentionally considered first. */
    d_env_root(common, L"ProgramW6432", NULL);
    d_env_root(common, L"ProgramFiles(x86)", NULL);
    d_env_root(common, L"ProgramFiles", NULL);
    d_env_root(common, L"APPDATA", NULL);
    d_env_root(common, L"LOCALAPPDATA", NULL);
    d_env_root(common, L"PROGRAMDATA", NULL);
    mask = GetLogicalDrives();
    for (i = 0; i < 26; ++i) if ((mask & (1UL << i)) != 0) {
        WCHAR root[4];
        root[0] = (WCHAR)(L'A' + i); root[1] = L':'; root[2] = L'\\'; root[3] = 0;
        if (GetDriveTypeW(root) == DRIVE_FIXED) { d_root_list_add(fixed, root); d_root_list_add(common, root); }
    }
}

static void d_sort_result(CX_DISCOVERY_RESULT *result) {
    DWORD i, j;
    if (!result || result->count < 2) return;
    for (i = 1; i < result->count; ++i) {
        CX_CLIENT_CANDIDATE hold = result->items[i];
        j = i;
        while (j && (result->items[j - 1].machine > hold.machine
            || (result->items[j - 1].machine == hold.machine && d_compare_ci(result->items[j - 1].path, hold.path) > 0))) {
            result->items[j] = result->items[j - 1]; --j;
        }
        result->items[j] = hold;
    }
}

static void d_choose(CX_DISCOVERY_RESULT *result, BOOL fallback) {
    DWORD i;
    result->recommendedIndex = 0;
    if (!result->count) return;
    if (fallback) {
        for (i = 0; i < result->count; ++i) if (result->items[i].machine == CX_DISCOVERY_MACHINE_X86) { result->recommendedIndex = i; return; }
        return;
    }
    d_sort_result(result);
    for (i = 0; i < result->count; ++i) if (result->items[i].machine == CX_DISCOVERY_MACHINE_X86) { result->recommendedIndex = i; return; }
}

static BOOL d_is_32bit_os(void) {
    SYSTEM_INFO info;
    GetNativeSystemInfo(&info);
    return info.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_INTEL;
}

#include "discovery-cache.inc"

BOOL cx_discovery_resolve_client(const WCHAR *clientPath, BOOL hostIs32Bit, CX_DISCOVERY_RESULT *result, WCHAR *error, DWORD errorCap) {
    D_CONTEXT context;
    DWORD attributes;
    if (result) cx_discovery_free(result);
    d_result_reset(result);
    if (error && errorCap) error[0] = 0;
    if (!clientPath || !*clientPath || !result) { if (error && errorCap) d_copy(error, errorCap, L"client path is empty"); return FALSE; }
    context.result = result; context.hostIs32Bit = hostIs32Bit; context.stopOnX86 = FALSE; context.stopped = FALSE; context.complete = TRUE; context.error = error; context.errorCap = errorCap;
    d_init_progress(&context, NULL);
    attributes = GetFileAttributesW(clientPath);
    if (attributes == INVALID_FILE_ATTRIBUTES) { d_error(&context, L"client path is not accessible"); return FALSE; }
    if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) { d_error(&context, L"client path is a reparse point"); return FALSE; }
    if (!(attributes & FILE_ATTRIBUTE_DIRECTORY)) {
        if (!d_is_candidate_path(clientPath) || !d_add_file(&context, clientPath)) { d_error(&context, L"client path is not a valid CXExam.exe"); return FALSE; }
        return TRUE;
    }
    d_visit(&context, clientPath, 1);
    d_choose(result, FALSE);
    if (!result->count) d_error(&context, L"client directory contains no valid CXExam.exe");
    return result->count != 0;
}

BOOL cx_discovery_scan(const CX_DISCOVERY_OPTIONS *options, CX_DISCOVERY_RESULT *result, WCHAR *error, DWORD errorCap) {
    D_ROOT_LIST defaultCommon, defaultFixed;
    CX_DISCOVERY_ROOTS defaults;
    const CX_DISCOVERY_ROOTS *roots;
    D_CONTEXT context;
    DWORD i;
    BOOL full = FALSE;
    BOOL hostIs32Bit;
    CX_DISCOVERY_SCAN_MODE scanMode;
    if (!result) return FALSE;
    cx_discovery_free(result);
    d_result_reset(result);
    if (error && errorCap) error[0] = 0;
    scanMode = options ? options->mode : CX_DISCOVERY_SCAN_FALLBACK_ALL;
    hostIs32Bit = options ? options->hostIs32Bit : FALSE;
    if (!hostIs32Bit) hostIs32Bit = d_is_32bit_os();
    if (options && options->clientPath && *options->clientPath) return cx_discovery_resolve_client(options->clientPath, hostIs32Bit, result, error, errorCap);

    d_zero(&defaultCommon, sizeof(defaultCommon)); d_zero(&defaultFixed, sizeof(defaultFixed));
    if (options && options->roots) roots = options->roots;
    else { d_default_roots(&defaultCommon, &defaultFixed); defaults.commonRoots = (const WCHAR *const *)defaultCommon.items; defaults.commonRootCount = defaultCommon.count; defaults.fixedRoots = (const WCHAR *const *)defaultFixed.items; defaults.fixedRootCount = defaultFixed.count; roots = &defaults; }
    if (d_cache_enabled(options, roots) && !options->rescan && d_cache_read(options->cachePath, roots, hostIs32Bit, result)) {
        d_root_list_free(&defaultCommon); d_root_list_free(&defaultFixed); return TRUE;
    }
    context.result = result; context.hostIs32Bit = hostIs32Bit; context.stopOnX86 = FALSE; context.stopped = FALSE; context.complete = TRUE; context.error = error; context.errorCap = errorCap;
    d_init_progress(&context, options);
    if (scanMode != CX_DISCOVERY_SCAN_ALL) {
        result->commonScanned = TRUE;
        for (i = 0; i < roots->commonRootCount && !context.stopped; ++i) d_visit(&context, roots->commonRoots[i], 1);
        for (i = 0; i < roots->fixedRootCount && !context.stopped; ++i) {
            BOOL duplicate = FALSE; DWORD j;
            for (j = 0; j < roots->commonRootCount; ++j) if (d_equal_ci(roots->fixedRoots[i], roots->commonRoots[j])) { duplicate = TRUE; break; }
            if (!duplicate) d_visit(&context, roots->fixedRoots[i], 1);
        }
    }
    if (result->count && scanMode != CX_DISCOVERY_SCAN_ALL) {
        d_choose(result, FALSE);
        if (context.complete && !result->truncated && d_cache_enabled(options, roots)) d_cache_write(options->cachePath, roots, hostIs32Bit, result);
        d_root_list_free(&defaultCommon); d_root_list_free(&defaultFixed);
        return TRUE;
    }
    if (scanMode == CX_DISCOVERY_SCAN_COMMON) {
        d_choose(result, FALSE);
        d_root_list_free(&defaultCommon); d_root_list_free(&defaultFixed);
        return TRUE;
    }
    if (!result->count || scanMode == CX_DISCOVERY_SCAN_ALL) {
        full = TRUE; result->fallbackScanned = TRUE;
        {
            BOOL hadCommonScan = result->commonScanned;
        /* all mode may have collected common roots only in a future caller;
           release paths before resetting so the result remains leak-free. */
        cx_discovery_free(result);
        d_result_reset(result);
            result->commonScanned = hadCommonScan;
        }
        result->fallbackScanned = TRUE;
        context.stopOnX86 = scanMode == CX_DISCOVERY_SCAN_FALLBACK_ALL
            && !(options && options->enumerateAll);
        context.stopped = FALSE;
        for (i = 0; i < roots->fixedRootCount && !context.stopped; ++i) d_visit(&context, roots->fixedRoots[i], -1);
        if (scanMode == CX_DISCOVERY_SCAN_ALL && roots->fixedRootCount == 0) for (i = 0; i < roots->commonRootCount && !context.stopped; ++i) d_visit(&context, roots->commonRoots[i], -1);
        d_report_progress(&context, TRUE);
        if (context.cancelled) { result->cancelled = TRUE; d_error(&context, L"scan cancelled by user"); }
        d_choose(result, context.stopOnX86);
    }
    if (!result->count && error && errorCap) d_copy(error, errorCap, L"no valid CXExam.exe found");
    if (full && result->stoppedOnX86) result->fallbackScanned = TRUE;
    d_root_list_free(&defaultCommon); d_root_list_free(&defaultFixed);
    return TRUE;
}
