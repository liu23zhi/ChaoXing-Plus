#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#define CX_COMMAND_CAP 32768

static STARTUPINFOW launcher_startup;
static PROCESS_INFORMATION launcher_process;
static HANDLE launcher_streams[3];

static const WCHAR *launcher_argument_tail(const WCHAR *command) {
    BOOL quoted = FALSE;
    while (*command) {
        if (*command == L'"') quoted = !quoted;
        else if (!quoted && (*command == L' ' || *command == L'\t')) break;
        ++command;
    }
    return command;
}

static BOOL WINAPI launcher_control(DWORD event) {
    /* Let the child handle Ctrl+C while the console helper keeps waiting. */
    return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}

static void launcher_error(void) {
    static const char text[] = "chaoxing_plus.com: cannot launch sibling chaoxing_plus.exe\r\n";
    DWORD written;
    HANDLE output = GetStdHandle(STD_ERROR_HANDLE);
    if (output && output != INVALID_HANDLE_VALUE)
        WriteFile(output, text, sizeof(text) - 1, &written, NULL);
}

void __stdcall ConsoleLauncherMain(void) {
    static const WCHAR filename[] = L"chaoxing_plus.exe";
    HANDLE heap = GetProcessHeap();
    WCHAR *executable = NULL, *command = NULL;
    const WCHAR *tail;
    DWORD length = 0, directory, tailLength = 0, at, i, status = ERROR_NOT_ENOUGH_MEMORY;
    DWORD streamIds[3] = { STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE };
    BOOL started = FALSE;

    executable = (WCHAR *)HeapAlloc(heap, 0, CX_COMMAND_CAP * sizeof(WCHAR));
    if (!executable) goto done;
    length = GetModuleFileNameW(NULL, executable, CX_COMMAND_CAP);
    if (!length || length >= CX_COMMAND_CAP) {
        status = length ? ERROR_FILENAME_EXCED_RANGE : GetLastError();
        goto done;
    }
    directory = length;
    while (directory && executable[directory - 1] != L'\\' && executable[directory - 1] != L'/') --directory;
    if (!directory || directory + (sizeof(filename) / sizeof(filename[0])) > CX_COMMAND_CAP) {
        status = ERROR_FILENAME_EXCED_RANGE;
        goto done;
    }
    for (i = 0; i < sizeof(filename) / sizeof(filename[0]); ++i) executable[directory + i] = filename[i];
    length = directory + (DWORD)(sizeof(filename) / sizeof(filename[0])) - 1;
    tail = launcher_argument_tail(GetCommandLineW());
    tailLength = (DWORD)lstrlenW(tail);
    if (length + tailLength + 3 > CX_COMMAND_CAP - 1) {
        status = ERROR_FILENAME_EXCED_RANGE;
        goto done;
    }
    command = (WCHAR *)HeapAlloc(heap, 0, (SIZE_T)(length + tailLength + 3) * sizeof(WCHAR));
    if (!command) goto done;
    at = 0;
    command[at++] = L'"';
    for (i = 0; i < length; ++i) command[at++] = executable[i];
    command[at++] = L'"';
    /* Only argv[0] changes. Do not parse, quote or normalize the original tail. */
    for (i = 0; i <= tailLength; ++i) command[at++] = tail[i];

    for (i = 0; i < 3; ++i) {
        HANDLE source = GetStdHandle(streamIds[i]);
        if (source && source != INVALID_HANDLE_VALUE
            && !DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &launcher_streams[i],
                                0, TRUE, DUPLICATE_SAME_ACCESS)) {
            status = GetLastError();
            goto done;
        }
    }
    launcher_startup.cb = sizeof(launcher_startup);
    launcher_startup.dwFlags = STARTF_USESTDHANDLES;
    launcher_startup.hStdInput = launcher_streams[0];
    launcher_startup.hStdOutput = launcher_streams[1];
    launcher_startup.hStdError = launcher_streams[2];
    SetConsoleCtrlHandler(launcher_control, TRUE);
    if (!CreateProcessW(executable, command, NULL, NULL, TRUE, 0, NULL, NULL,
                        &launcher_startup, &launcher_process)) {
        status = GetLastError();
        goto done;
    }
    started = TRUE;
    CloseHandle(launcher_process.hThread);
    if (WaitForSingleObject(launcher_process.hProcess, INFINITE) == WAIT_FAILED
        || !GetExitCodeProcess(launcher_process.hProcess, &status)) status = GetLastError();
    CloseHandle(launcher_process.hProcess);

done:
    for (i = 0; i < 3; ++i) if (launcher_streams[i]) CloseHandle(launcher_streams[i]);
    if (command) {
        volatile WCHAR *clear = command;
        for (i = 0; i < length + tailLength + 3; ++i) clear[i] = 0;
        HeapFree(heap, 0, command);
    }
    if (executable) HeapFree(heap, 0, executable);
    if (!started) launcher_error();
    ExitProcess(status);
}
