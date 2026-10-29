/* x86 self test: load the winmm proxy, verify exports, jump table and log file. */
#include <windows.h>

static void out(const char *text) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &written, NULL);
}

void __stdcall ProxyTestMain(void) {
    WCHAR dll[MAX_PATH];
    WCHAR temp[MAX_PATH];
    WCHAR log[MAX_PATH];
    HMODULE module;
    FARPROC timeProc;
    FARPROC joyProc;
    DWORD pid = GetCurrentProcessId();
    DWORD at = 0, i;
    HANDLE file;
    WCHAR *cmd = GetCommandLineW();
    int arg = 0, quote = 0, k = 0, n = 0;
    dll[0] = 0;
    while (cmd[k]) {
        if (cmd[k] == L'"') { quote = !quote; ++k; continue; }
        if (!quote && cmd[k] == L' ') { if (arg == 1) break; ++arg; ++k; continue; }
        if (arg == 1 && n < MAX_PATH - 1) dll[n++] = cmd[k];
        ++k;
    }
    dll[n] = 0;
    if (!dll[0]) { out("FAIL missing dll path\n"); ExitProcess(1); }
    module = LoadLibraryW(dll);
    if (!module) { out("FAIL LoadLibrary\n"); ExitProcess(1); }
    timeProc = GetProcAddress(module, "timeGetTime");
    joyProc = GetProcAddress(module, "joyGetDevCapsA");
    if (!timeProc || !joyProc) { out("FAIL exports\n"); ExitProcess(1); }
    out("PASS exports\n");
    ((DWORD (WINAPI *)(void))timeProc)();
    GetTempPathW(MAX_PATH, temp);
    for (i = 0; temp[i] && at < MAX_PATH - 24; ++i) log[at++] = temp[i];
    log[at++] = L'c'; log[at++] = L'x'; log[at++] = L'h'; log[at++] = L'o'; log[at++] = L'o'; log[at++] = L'k'; log[at++] = L'-';
    {
        WCHAR digits[16];
        int digitsAt = 0;
        DWORD value = pid;
        while (value) { digits[digitsAt++] = (WCHAR)(L'0' + (value % 10)); value /= 10; }
        while (digitsAt > 0) log[at++] = digits[--digitsAt];
    }
    log[at++] = L'.'; log[at++] = L'l'; log[at++] = L'o'; log[at++] = L'g'; log[at] = 0;
    file = CreateFileW(log, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) { out("FAIL log\n"); ExitProcess(1); }
    CloseHandle(file);
    out("PASS log\nPROXY SELF TEST PASS\n");
    ExitProcess(0);
}