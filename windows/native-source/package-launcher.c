/* Ordinary portable-package launcher. RCDATA 201 contains CXPKG001 and files. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#define PKG_RESOURCE 201
#define PKG_MAX_FILES 4096
#define PKG_MAX_DIRECTORIES 8192
#define PKG_MAX_ARCHIVE (512UL * 1024UL * 1024UL)
#define PKG_MAX_FILE (256UL * 1024UL * 1024UL)
#define PKG_MAX_PATH_BYTES 2048
#define PKG_PATH_CAP 32768
#define PKG_CLEANUP_ATTEMPTS 20
#define PKG_MAX_TEMP_LOCKS 128

typedef struct {
    WCHAR *relative;
    const BYTE *data;
    DWORD size;
    BY_HANDLE_FILE_INFORMATION identity;
    BOOL created;
    BOOL cleaned;
} PKG_FILE;

typedef struct {
    WCHAR *path;
    HANDLE lock;
    BY_HANDLE_FILE_INFORMATION identity;
    BOOL identified;
    BOOL cleaned;
} PKG_DIRECTORY;

typedef struct {
    PKG_FILE *files;
    PKG_DIRECTORY *directories;
    DWORD fileCount;
    DWORD directoryCount;
    HANDLE tempLocks[PKG_MAX_TEMP_LOCKS];
    DWORD tempLockCount;
    WCHAR root[PKG_PATH_CAP];
    WCHAR path[PKG_PATH_CAP];
    WCHAR child[PKG_PATH_CAP];
} PKG_STATE;

typedef BOOLEAN (WINAPI *PKG_RANDOM)(PVOID, ULONG);

static void *pkg_alloc(SIZE_T size) { return HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size); }
static void pkg_free(void *value) { if (value) HeapFree(GetProcessHeap(), 0, value); }

static void pkg_attach_parent_console(void) {
    DWORD kinds[3] = { STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE };
    HANDLE original[3];
    DWORD i;
    for (i = 0; i < 3; ++i) original[i] = GetStdHandle(kinds[i]);
    if (original[1] && original[1] != INVALID_HANDLE_VALUE) return;
    if (!AttachConsole(ATTACH_PARENT_PROCESS)) return;
    /* Attaching may replace standard handles; keep the caller's redirections. */
    for (i = 0; i < 3; ++i) {
        if (original[i] && original[i] != INVALID_HANDLE_VALUE) SetStdHandle(kinds[i], original[i]);
    }
}

static void pkg_error(const char *message) {
    DWORD written;
    HANDLE out = GetStdHandle(STD_ERROR_HANDLE);
    if (out && out != INVALID_HANDLE_VALUE) WriteFile(out, message, (DWORD)lstrlenA(message), &written, NULL);
    OutputDebugStringA(message);
}

static BOOL pkg_copy(WCHAR *target, const WCHAR *source) {
    DWORD i = 0;
    while (source[i]) {
        if (i >= PKG_PATH_CAP - 1) return FALSE;
        target[i] = source[i];
        ++i;
    }
    target[i] = 0;
    return TRUE;
}

static BOOL pkg_append(WCHAR *target, const WCHAR *source) {
    DWORD i = (DWORD)lstrlenW(target), j = 0;
    while (source[j]) {
        if (i >= PKG_PATH_CAP - 1) return FALSE;
        target[i++] = source[j++];
    }
    target[i] = 0;
    return TRUE;
}

static DWORD pkg_u32(const BYTE *value) {
    return (DWORD)value[0] | ((DWORD)value[1] << 8) | ((DWORD)value[2] << 16) | ((DWORD)value[3] << 24);
}

static WCHAR pkg_upper(WCHAR value) { return value >= L'a' && value <= L'z' ? value - L'a' + L'A' : value; }

static BOOL pkg_device(const WCHAR *part, DWORD length) {
    DWORD stem = 0;
    while (stem < length && part[stem] != L'.') ++stem;
    if (stem == 3 && ((pkg_upper(part[0]) == L'C' && pkg_upper(part[1]) == L'O' && pkg_upper(part[2]) == L'N') ||
        (pkg_upper(part[0]) == L'P' && pkg_upper(part[1]) == L'R' && pkg_upper(part[2]) == L'N') ||
        (pkg_upper(part[0]) == L'A' && pkg_upper(part[1]) == L'U' && pkg_upper(part[2]) == L'X') ||
        (pkg_upper(part[0]) == L'N' && pkg_upper(part[1]) == L'U' && pkg_upper(part[2]) == L'L'))) return TRUE;
    if (stem == 4 && ((part[3] >= L'1' && part[3] <= L'9') || part[3] == 0x00b9 || part[3] == 0x00b2 || part[3] == 0x00b3) &&
        ((pkg_upper(part[0]) == L'C' && pkg_upper(part[1]) == L'O' && pkg_upper(part[2]) == L'M') ||
         (pkg_upper(part[0]) == L'L' && pkg_upper(part[1]) == L'P' && pkg_upper(part[2]) == L'T'))) return TRUE;
    if ((stem == 6 && CompareStringOrdinal(part, 6, L"CONIN$", 6, TRUE) == CSTR_EQUAL) ||
        (stem == 7 && CompareStringOrdinal(part, 7, L"CONOUT$", 7, TRUE) == CSTR_EQUAL) ||
        (stem == 6 && CompareStringOrdinal(part, 6, L"CLOCK$", 6, TRUE) == CSTR_EQUAL)) return TRUE;
    return FALSE;
}

static BOOL pkg_valid_relative(WCHAR *value) {
    DWORD i = 0, start = 0, components = 0;
    for (;;) {
        WCHAR ch = value[i];
        if (!ch || ch == L'/') {
            DWORD length = i - start;
            if (!length || ++components > 64 || length > 255 || value[i - 1] == L'.' || value[i - 1] == L' ' ||
                (length == 1 && value[start] == L'.') ||
                (length == 2 && value[start] == L'.' && value[start + 1] == L'.') ||
                pkg_device(value + start, length)) return FALSE;
            if (!ch) break;
            value[i] = L'\\';
            start = i + 1;
        } else if (ch < 32 || ch == 127 || ch == L'\\' || ch == L':' || ch == L'"' || ch == L'<' ||
                   ch == L'>' || ch == L'|' || ch == L'?' || ch == L'*') return FALSE;
        ++i;
    }
    return TRUE;
}

static BOOL pkg_parse(PKG_STATE *state, const BYTE *archive, DWORD size) {
    static const BYTE magic[8] = { 'C','X','P','K','G','0','0','1' };
    DWORD offset = 12, i, j;
    BOOL hasMain = FALSE;
    if (!archive || size < 12 || size > PKG_MAX_ARCHIVE) return FALSE;
    for (i = 0; i < 8; ++i) if (archive[i] != magic[i]) return FALSE;
    state->fileCount = pkg_u32(archive + 8);
    if (!state->fileCount || state->fileCount > PKG_MAX_FILES) return FALSE;
    state->files = (PKG_FILE *)pkg_alloc(sizeof(PKG_FILE) * state->fileCount);
    if (!state->files) return FALSE;
    for (i = 0; i < state->fileCount; ++i) {
        DWORD pathBytes, dataBytes;
        int chars;
        PKG_FILE *file = state->files + i;
        if (offset > size || size - offset < 8) return FALSE;
        pathBytes = pkg_u32(archive + offset);
        dataBytes = pkg_u32(archive + offset + 4);
        offset += 8;
        if (!pathBytes || pathBytes > PKG_MAX_PATH_BYTES || pathBytes > size - offset || dataBytes > PKG_MAX_FILE) return FALSE;
        chars = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)archive + offset, (int)pathBytes, NULL, 0);
        if (chars <= 0) return FALSE;
        file->relative = (WCHAR *)pkg_alloc(((SIZE_T)chars + 1) * sizeof(WCHAR));
        if (!file->relative || MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
            (const char *)archive + offset, (int)pathBytes, file->relative, chars) != chars) return FALSE;
        for (j = 0; j < (DWORD)chars; ++j) if (!file->relative[j]) return FALSE;
        if (!pkg_valid_relative(file->relative)) return FALSE;
        for (j = 0; j < i; ++j) {
            if (CompareStringOrdinal(file->relative, -1, state->files[j].relative, -1, TRUE) == CSTR_EQUAL) return FALSE;
        }
        offset += pathBytes;
        if (dataBytes > size - offset) return FALSE;
        file->data = archive + offset;
        file->size = dataBytes;
        offset += dataBytes;
        if (lstrcmpiW(file->relative, L"chaoxing_plus.exe") == 0) hasMain = TRUE;
    }
    return hasMain && offset == size;
}

static BOOL pkg_same(const BY_HANDLE_FILE_INFORMATION *a, const BY_HANDLE_FILE_INFORMATION *b) {
    return a->dwVolumeSerialNumber == b->dwVolumeSerialNumber && a->nFileIndexHigh == b->nFileIndexHigh &&
        a->nFileIndexLow == b->nFileIndexLow;
}

static BOOL pkg_create_directory(PKG_STATE *state, const WCHAR *path) {
    PKG_DIRECTORY *directory;
    DWORD i;
    if (state->directoryCount >= PKG_MAX_DIRECTORIES) return FALSE;
    directory = state->directories + state->directoryCount;
    directory->path = (WCHAR *)pkg_alloc(((SIZE_T)lstrlenW(path) + 1) * sizeof(WCHAR));
    if (!directory->path) return FALSE;
    for (i = 0; path[i]; ++i) directory->path[i] = path[i];
    if (!CreateDirectoryW(path, NULL)) {
        DWORD error = GetLastError();
        pkg_free(directory->path);
        directory->path = NULL;
        SetLastError(error);
        return FALSE;
    }
    ++state->directoryCount;
    directory->lock = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, NULL, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (directory->lock == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(directory->lock, &directory->identity) ||
        !(directory->identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
        (directory->identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
        if (directory->lock != INVALID_HANDLE_VALUE) CloseHandle(directory->lock);
        directory->lock = NULL;
        return FALSE;
    }
    directory->identified = TRUE;
    return TRUE;
}

static BOOL pkg_safe_temp(PKG_STATE *state, WCHAR *path) {
    DWORD i, length = (DWORD)lstrlenW(path);
    if (length < 3 || path[1] != L':' || path[2] != L'\\') return FALSE;
    if (length > 3 && path[length - 1] == L'\\') path[--length] = 0;
    for (i = 3; i <= length; ++i) {
        BY_HANDLE_FILE_INFORMATION information;
        HANDLE handle;
        BOOL safe;
        if (i != 3 && path[i] && path[i] != L'\\') continue;
        if (state->tempLockCount >= PKG_MAX_TEMP_LOCKS) return FALSE;
        {
            WCHAR saved = path[i];
            path[i] = 0;
            handle = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
            path[i] = saved;
        }
        if (handle == INVALID_HANDLE_VALUE) return FALSE;
        safe = GetFileInformationByHandle(handle, &information) &&
            (information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
            !(information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT);
        if (!safe) { CloseHandle(handle); return FALSE; }
        /* Ancestors stay locked so a later reparse replacement cannot redirect extraction or cleanup. */
        state->tempLocks[state->tempLockCount++] = handle;
    }
    return TRUE;
}

static BOOL pkg_create_root(PKG_STATE *state) {
    HMODULE library;
    PKG_RANDOM random;
    DWORD length, attempt, i, pid = GetCurrentProcessId();
    BYTE bytes[16];
    WCHAR suffix[80];
    static const WCHAR hex[] = L"0123456789abcdef";
    length = GetTempPathW(PKG_PATH_CAP, state->path);
    if (!length || length >= PKG_PATH_CAP) return FALSE;
    length = GetFullPathNameW(state->path, PKG_PATH_CAP, state->root, NULL);
    if (!length || length >= PKG_PATH_CAP || !pkg_safe_temp(state, state->root)) return FALSE;
    length = GetSystemDirectoryW(state->path, PKG_PATH_CAP);
    if (!length || length >= PKG_PATH_CAP || !pkg_append(state->path, L"\\advapi32.dll")) return FALSE;
    library = LoadLibraryW(state->path);
    if (!library) return FALSE;
    random = (PKG_RANDOM)(void *)GetProcAddress(library, "SystemFunction036");
    if (!random) { FreeLibrary(library); return FALSE; }
    for (attempt = 0; attempt < 32; ++attempt) {
        DWORD at = 0;
        const WCHAR *prefix = state->root[lstrlenW(state->root) - 1] == L'\\' ? L"CXPlusPackage-" : L"\\CXPlusPackage-";
        if (!random(bytes, sizeof(bytes))) break;
        while (*prefix) suffix[at++] = *prefix++;
        for (i = 0; i < 8; ++i) suffix[at++] = hex[(pid >> ((7 - i) * 4)) & 15];
        suffix[at++] = L'-';
        for (i = 0; i < sizeof(bytes); ++i) { suffix[at++] = hex[bytes[i] >> 4]; suffix[at++] = hex[bytes[i] & 15]; }
        suffix[at] = 0;
        if (!pkg_copy(state->path, state->root) || !pkg_append(state->path, suffix)) break;
        if (pkg_create_directory(state, state->path)) {
            BOOL result = pkg_copy(state->root, state->path);
            FreeLibrary(library);
            return result;
        }
        if (state->directoryCount) break;
        if (GetLastError() != ERROR_ALREADY_EXISTS) break;
    }
    FreeLibrary(library);
    return FALSE;
}

static BOOL pkg_file_path(PKG_STATE *state, const WCHAR *relative) {
    return pkg_copy(state->path, state->root) && pkg_append(state->path, L"\\") && pkg_append(state->path, relative);
}

static BOOL pkg_parents(PKG_STATE *state) {
    DWORD i = (DWORD)lstrlenW(state->root) + 1, j;
    for (; state->path[i]; ++i) {
        if (state->path[i] != L'\\') continue;
        state->path[i] = 0;
        for (j = 0; j < state->directoryCount; ++j) {
            if (lstrcmpiW(state->path, state->directories[j].path) == 0) break;
        }
        if (j == state->directoryCount) {
            if (!pkg_create_directory(state, state->path)) {
                state->path[i] = L'\\';
                return FALSE;
            }
        }
        state->path[i] = L'\\';
    }
    return TRUE;
}

static BOOL pkg_extract(PKG_STATE *state) {
    DWORD i;
    for (i = 0; i < state->fileCount; ++i) {
        PKG_FILE *file = state->files + i;
        HANDLE handle;
        DWORD offset = 0;
        BOOL ok;
        if (!pkg_file_path(state, file->relative) || !pkg_parents(state)) return FALSE;
        handle = CreateFileW(state->path, GENERIC_WRITE | FILE_READ_ATTRIBUTES | DELETE, 0, NULL, CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
        if (handle == INVALID_HANDLE_VALUE) return FALSE;
        ok = GetFileInformationByHandle(handle, &file->identity);
        file->created = ok;
        if (!ok) {
            FILE_DISPOSITION_INFO disposition;
            disposition.DeleteFile = TRUE;
            SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition));
        }
        while (ok && offset < file->size) {
            DWORD written = 0, amount = file->size - offset;
            if (amount > 1024 * 1024) amount = 1024 * 1024;
            ok = WriteFile(handle, file->data + offset, amount, &written, NULL) && written == amount;
            offset += written;
        }
        CloseHandle(handle);
        if (!ok) return FALSE;
    }
    return pkg_file_path(state, L"chaoxing_plus.exe") && pkg_copy(state->child, state->path);
}

static const WCHAR *pkg_argument_tail(void) {
    const WCHAR *cursor = GetCommandLineW();
    BOOL quoted = FALSE;
    while (*cursor) {
        if (*cursor == L'"') quoted = !quoted;
        else if (!quoted && (*cursor == L' ' || *cursor == L'\t')) break;
        ++cursor;
    }
    while (*cursor == L' ' || *cursor == L'\t') ++cursor;
    return cursor;
}

static BOOL pkg_child(PKG_STATE *state, DWORD *exitCode) {
    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    HANDLE inherited[3] = { NULL, NULL, NULL };
    DWORD kinds[3] = { STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE };
    const WCHAR *tail = pkg_argument_tail();
    WCHAR *command;
    DWORD i, childLength = (DWORD)lstrlenW(state->child), tailLength = (DWORD)lstrlenW(tail);
    BOOL ok = FALSE, anyHandle = FALSE;
    if (childLength + tailLength + 4 >= PKG_PATH_CAP) return FALSE;
    command = (WCHAR *)pkg_alloc((childLength + tailLength + 4) * sizeof(WCHAR));
    if (!command) return FALSE;
    command[0] = L'"';
    for (i = 0; i < childLength; ++i) command[i + 1] = state->child[i];
    command[childLength + 1] = L'"';
    command[childLength + 2] = L' ';
    for (i = 0; i <= tailLength; ++i) command[childLength + 3 + i] = tail[i];
    ZeroMemory(&startup, sizeof(startup));
    ZeroMemory(&process, sizeof(process));
    startup.cb = sizeof(startup);
    for (i = 0; i < 3; ++i) {
        HANDLE original = GetStdHandle(kinds[i]);
        if (!original || original == INVALID_HANDLE_VALUE) {
            SECURITY_ATTRIBUTES security;
            security.nLength = sizeof(security);
            security.lpSecurityDescriptor = NULL;
            security.bInheritHandle = TRUE;
            inherited[i] = CreateFileW(L"NUL", (i == 0) ? GENERIC_READ : GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
            if (inherited[i] == INVALID_HANDLE_VALUE) inherited[i] = NULL;
        } else if (!DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(), inherited + i, 0, TRUE, DUPLICATE_SAME_ACCESS)) goto done;
        if (!inherited[i]) goto done;
        anyHandle = TRUE;
    }
    if (anyHandle) {
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = inherited[0];
        startup.hStdOutput = inherited[1];
        startup.hStdError = inherited[2];
    }
    /* NULL current directory preserves the caller's working directory. */
    if (!CreateProcessW(state->child, command, NULL, NULL, anyHandle, 0, NULL, NULL, &startup, &process)) goto done;
    CloseHandle(process.hThread);
    if (WaitForSingleObject(process.hProcess, INFINITE) == WAIT_OBJECT_0) ok = GetExitCodeProcess(process.hProcess, exitCode);
    CloseHandle(process.hProcess);
done:
    for (i = 0; i < 3; ++i) if (inherited[i]) CloseHandle(inherited[i]);
    pkg_free(command);
    return ok;
}

static BOOL pkg_delete_owned(const WCHAR *path, const BY_HANDLE_FILE_INFORMATION *identity, BOOL directory) {
    BY_HANDLE_FILE_INFORMATION current;
    FILE_DISPOSITION_INFO disposition;
    HANDLE handle = CreateFileW(path, DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), NULL);
    BOOL ok = FALSE;
    if (handle == INVALID_HANDLE_VALUE) {
        DWORD error = GetLastError();
        return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
    }
    if (GetFileInformationByHandle(handle, &current) && pkg_same(identity, &current) &&
        !(current.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
        !!(current.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == !!directory) {
        disposition.DeleteFile = TRUE;
        ok = SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition));
    }
    CloseHandle(handle);
    return ok;
}

static void pkg_cleanup(PKG_STATE *state) {
    DWORD attempt, i;
    BOOL pending = FALSE;
    for (attempt = 0; attempt < PKG_CLEANUP_ATTEMPTS; ++attempt) {
        pending = FALSE;
        for (i = 0; state->files && i < state->fileCount; ++i) {
            PKG_FILE *file = state->files + i;
            if (!file->created || file->cleaned) continue;
            if (pkg_file_path(state, file->relative)) file->cleaned = pkg_delete_owned(state->path, &file->identity, FALSE);
            if (!file->cleaned) pending = TRUE;
        }
        if (!pending) break;
        if (attempt + 1 < PKG_CLEANUP_ATTEMPTS) Sleep(50);
    }
    /* Keep every parent locked until no later file cleanup can traverse it. */
    if (!pending) {
        DWORD remaining = state->directoryCount;
        for (attempt = 0; remaining && attempt < PKG_CLEANUP_ATTEMPTS; ++attempt) {
            while (remaining) {
                PKG_DIRECTORY *directory = state->directories + remaining - 1;
                if (directory->lock && directory->lock != INVALID_HANDLE_VALUE) {
                    CloseHandle(directory->lock);
                    directory->lock = NULL;
                }
                directory->cleaned = directory->identified && pkg_delete_owned(directory->path, &directory->identity, TRUE);
                if (!directory->cleaned) break;
                --remaining;
            }
            if (remaining && attempt + 1 < PKG_CLEANUP_ATTEMPTS) Sleep(50);
        }
    }
    for (i = 0; state->files && i < state->fileCount; ++i) pkg_free(state->files[i].relative);
    for (i = 0; i < state->directoryCount; ++i) {
        if (state->directories[i].lock && state->directories[i].lock != INVALID_HANDLE_VALUE) CloseHandle(state->directories[i].lock);
        pkg_free(state->directories[i].path);
    }
    for (i = state->tempLockCount; i > 0; --i) CloseHandle(state->tempLocks[i - 1]);
    pkg_free(state->files);
    pkg_free(state->directories);
}

void __stdcall PackageLauncherMain(void) {
    PKG_STATE *state = (PKG_STATE *)pkg_alloc(sizeof(PKG_STATE));
    HMODULE module = GetModuleHandleW(NULL);
    HRSRC resource = FindResourceW(module, MAKEINTRESOURCEW(PKG_RESOURCE), RT_RCDATA);
    HGLOBAL loaded = resource ? LoadResource(module, resource) : NULL;
    DWORD exitCode = ERROR_BAD_FORMAT;
    pkg_attach_parent_console();
    if (!state) { pkg_error("Portable package: out of memory.\r\n"); ExitProcess(ERROR_NOT_ENOUGH_MEMORY); }
    state->directories = (PKG_DIRECTORY *)pkg_alloc(sizeof(PKG_DIRECTORY) * PKG_MAX_DIRECTORIES);
    if (!state->directories || !loaded || !pkg_parse(state, (const BYTE *)LockResource(loaded), SizeofResource(module, resource))) {
        pkg_error("Portable package: embedded file archive is invalid.\r\n");
    } else if (!pkg_create_root(state) || !pkg_extract(state)) {
        exitCode = ERROR_WRITE_FAULT;
        pkg_error("Portable package: could not create the private temporary files.\r\n");
    } else if (!pkg_child(state, &exitCode)) {
        exitCode = ERROR_PROCESS_ABORTED;
        pkg_error("Portable package: could not run the extracted application.\r\n");
    }
    pkg_cleanup(state);
    pkg_free(state);
    ExitProcess(exitCode);
}
