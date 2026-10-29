/* 测试夹具：把环境变量 CX_INJECT_PORT 写到 argv[1] 指定的文件，验证 dll-proxy 的环境传递。 */
#include <windows.h>

void __stdcall EnvProbeMain(void) {
    WCHAR path[MAX_PATH];
    char value[32];
    DWORD got = 0, written = 0;
    HANDLE file;
    WCHAR *cmd = GetCommandLineW();
    int arg = 0, quote = 0, i = 0, n = 0;
    path[0] = 0;
    while (cmd && cmd[i]) {
        if (cmd[i] == L'"') { quote = !quote; ++i; continue; }
        if (!quote && cmd[i] == L' ') { if (arg == 1) break; ++arg; ++i; continue; }
        if (arg == 1 && n < MAX_PATH - 1) path[n++] = cmd[i];
        ++i;
    }
    path[n] = 0;
    for (i = 0; i < 32; ++i) value[i] = 0;
    GetEnvironmentVariableA("CX_INJECT_PORT", value, 32);
    if (!path[0]) {
        WCHAR temp[MAX_PATH];
        static const WCHAR tail[] = L"cx-env-probe.txt";
        DWORD k = 0, at = 0;
        if (!GetTempPathW(MAX_PATH, temp)) ExitProcess(2);
        while (temp[at]) { path[at] = temp[at]; ++at; }
        while (tail[k] && at < MAX_PATH - 1) path[at++] = tail[k++];
        path[at] = 0;
    }
    file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) ExitProcess(3);
    for (got = 0; value[got]; ++got) { }
    WriteFile(file, value, got, &written, NULL);
    CloseHandle(file);
    ExitProcess(0);
}
