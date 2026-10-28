#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include "elevation.h"

#define E_COMMAND_CAP 32768

typedef struct E_WRITER { WCHAR *out; DWORD capacity, used; BOOL ok; } E_WRITER;

static void e_put(E_WRITER *w, WCHAR c) {
    if (!w->ok || w->used + 1 >= w->capacity) { w->ok = FALSE; return; }
    w->out[w->used++] = c;
}
static void e_quote(E_WRITER *w, const WCHAR *text) {
    DWORD slashes, i;
    e_put(w, L'"');
    while (*text && w->ok) {
        slashes = 0;
        while (*text == L'\\') { ++slashes; ++text; }
        /* Windows doubles backslashes before a closing quote or a literal quote. */
        for (i = 0; i < slashes; ++i) {
            e_put(w, L'\\');
            if (!*text || *text == L'"') e_put(w, L'\\');
        }
        if (!*text) break;
        if (*text == L'"') e_put(w, L'\\');
        e_put(w, *text++);
    }
    e_put(w, L'"');
}
static void e_error(WCHAR *error, DWORD capacity, const WCHAR *text) {
    if (error && capacity) lstrcpynW(error, text, (int)capacity);
}

BOOL cx_elevation_query(BOOL *elevated) {
    HANDLE token = NULL;
    TOKEN_ELEVATION info;
    DWORD size = 0, code;
    BOOL ok;
    if (!elevated) { SetLastError(ERROR_INVALID_PARAMETER); return FALSE; }
    *elevated = FALSE;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return FALSE;
    ZeroMemory(&info, sizeof(info));
    ok = GetTokenInformation(token, TokenElevation, &info, sizeof(info), &size);
    code = ok ? ERROR_SUCCESS : GetLastError();
    CloseHandle(token);
    if (ok) *elevated = info.TokenIsElevated != 0;
    SetLastError(code); return ok;
}

BOOL cx_elevation_can_restart(DWORD launchError, BOOL noElevate, BOOL restarted) {
    BOOL elevated;
    if (launchError != ERROR_ELEVATION_REQUIRED || noElevate || restarted) return FALSE;
    return cx_elevation_query(&elevated) && !elevated;
}

BOOL cx_elevation_parameters(int argc, WCHAR *const *argv, const WCHAR *client,
                             WCHAR *out, DWORD capacity) {
    E_WRITER w; int i;
    if (out && capacity) out[0] = 0;
    if (argc < 0 || (argc && !argv) || !client || !*client || !out || capacity < 2) {
        SetLastError(ERROR_INVALID_PARAMETER); return FALSE;
    }
    w.out = out; w.capacity = capacity; w.used = 0; w.ok = TRUE;
    for (i = 0; i < argc && w.ok; ++i) {
        if (!argv[i]) { w.ok = FALSE; break; }
        if (i) e_put(&w, L' ');
        e_quote(&w, argv[i]);
    }
    if (argc) e_put(&w, L' ');
    e_quote(&w, L"--elevated"); e_put(&w, L' ');
    e_quote(&w, L"--elevated-client"); e_put(&w, L' '); e_quote(&w, client);
    if (!w.ok) { out[0] = 0; SetLastError(ERROR_BUFFER_OVERFLOW); return FALSE; }
    out[w.used] = 0; return TRUE;
}

BOOL cx_elevation_restart(const WCHAR *executable, int argc, WCHAR *const *argv,
                          const WCHAR *client, DWORD *exitCode,
                          WCHAR *error, DWORD errorCap) {
    SHELLEXECUTEINFOW shell;
    WCHAR *parameters = NULL, *directory = NULL;
    DWORD size, actual, code = ERROR_INVALID_PARAMETER, childCode = 1;
    BOOL ok = FALSE;
    if (exitCode) *exitCode = 1;
    e_error(error, errorCap, L"Cannot prepare administrator restart");
    if (!executable || !*executable || !exitCode) goto done;
    parameters = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, E_COMMAND_CAP * sizeof(WCHAR));
    if (!parameters) { code = ERROR_NOT_ENOUGH_MEMORY; goto done; }
    if (!cx_elevation_parameters(argc, argv, client, parameters, E_COMMAND_CAP)) {
        code = GetLastError(); e_error(error, errorCap, L"Administrator restart arguments exceed Windows command capacity"); goto done;
    }
    if ((DWORD)lstrlenW(parameters) + (DWORD)lstrlenW(executable) + 4 >= E_COMMAND_CAP) {
        code = ERROR_BUFFER_OVERFLOW; e_error(error, errorCap, L"Administrator restart command exceeds Windows command capacity"); goto done;
    }
    size = GetCurrentDirectoryW(0, NULL);
    if (!size) { code = GetLastError(); goto done; }
    directory = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)size * sizeof(WCHAR));
    if (!directory) { code = ERROR_NOT_ENOUGH_MEMORY; goto done; }
    actual = GetCurrentDirectoryW(size, directory);
    if (!actual || actual >= size) { code = actual ? ERROR_BUFFER_OVERFLOW : GetLastError(); goto done; }
    ZeroMemory(&shell, sizeof(shell)); shell.cbSize = sizeof(shell);
    shell.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
    shell.lpVerb = L"runas"; shell.lpFile = executable;
    shell.lpParameters = parameters; shell.lpDirectory = directory; shell.nShow = SW_SHOWNORMAL;
    if (!ShellExecuteExW(&shell)) {
        code = GetLastError();
        if (code == ERROR_CANCELLED) {
            *exitCode = 3; e_error(error, errorCap, L"Administrator restart cancelled; client was not launched");
        } else e_error(error, errorCap, L"Windows could not start the administrator host");
        goto done;
    }
    if (!shell.hProcess) {
        code = ERROR_INVALID_HANDLE; e_error(error, errorCap, L"Cannot verify administrator host process"); goto done;
    }
    if (WaitForSingleObject(shell.hProcess, INFINITE) != WAIT_OBJECT_0) {
        code = GetLastError(); e_error(error, errorCap, L"Cannot wait for administrator host");
    } else if (!GetExitCodeProcess(shell.hProcess, &childCode)) {
        code = GetLastError(); e_error(error, errorCap, L"Cannot read administrator host exit code");
    } else {
        *exitCode = childCode; code = ERROR_SUCCESS; ok = TRUE; e_error(error, errorCap, L"");
    }
    CloseHandle(shell.hProcess);
done:
    if (directory) HeapFree(GetProcessHeap(), 0, directory);
    if (parameters) HeapFree(GetProcessHeap(), 0, parameters);
    SetLastError(code); return ok;
}
