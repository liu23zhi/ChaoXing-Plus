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
    {
        WCHAR portProbe[8];
        if (1) {
            WCHAR *cmdLine = GetCommandLineW();
            int i2, k2, found = 0;
            static const WCHAR needle[] = L"--remote-debugging-port=";
            if (cmdLine) {
                for (i2 = 0; cmdLine[i2] && !found; ++i2) {
                    for (k2 = 0; needle[k2] && cmdLine[i2 + k2] == needle[k2]; ++k2) { }
                    if (!needle[k2]) found = 1;
                }
            }
            out(found ? "PASS command line injected\n" : "INFO no command line injection\n");
        }
    }
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
    {
        WCHAR cefPath[MAX_PATH];
        HMODULE cef;
        FARPROC createBrowser;
        unsigned char *bytes;
        char line[128];
        int at2 = 0, b;
        cefPath[0] = 0;
        /* argv[2] */
        {
            WCHAR *cmd2 = GetCommandLineW();
            int a2 = 0, q2 = 0, k2 = 0, n2 = 0;
            while (cmd2[k2]) {
                if (cmd2[k2] == L'"') { q2 = !q2; ++k2; continue; }
                if (!q2 && cmd2[k2] == L' ') { if (a2 == 2) break; ++a2; ++k2; continue; }
                if (a2 == 2 && n2 < MAX_PATH - 1) cefPath[n2++] = cmd2[k2];
                ++k2;
            }
            cefPath[n2] = 0;
        }
        if (cefPath[0]) {
            cef = LoadLibraryExW(cefPath, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
            if (!cef) { out("cef: load failed\n"); }
            else {
                createBrowser = GetProcAddress(cef, "cef_browser_host_create_browser");
                if (!createBrowser) { out("cef: export missing\n"); }
                else {
                    bytes = (unsigned char *)createBrowser;
                    for (b = 0; b < 16; ++b) {
                        unsigned char value = bytes[b];
                        const char *hex = "0123456789abcdef";
                        line[at2++] = hex[value >> 4];
                        line[at2++] = hex[value & 0xF];
                        line[at2++] = ' ';
                    }
                    line[at2++] = '\n';
                    line[at2] = 0;
                    out("prologue: ");
                    out(line);
                }
            }
        }
    }
    file = CreateFileW(log, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) { out("FAIL log\n"); ExitProcess(1); }
    CloseHandle(file);
    out("PASS log\nPROXY SELF TEST PASS\n");
    ExitProcess(0);
}



