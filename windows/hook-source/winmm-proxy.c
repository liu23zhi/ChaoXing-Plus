/* winmm.dll 代理：所有导出由生成的 naked 跳转桩转发到系统 winmm。
   本文件只负责加载真实 winmm、填充跳转表、写装载日志。 */
#include <windows.h>

#pragma function(memset)
void *__cdecl memset(void *dst, int value, size_t count) {
    unsigned char *p = (unsigned char *)dst;
    while (count--) *p++ = (unsigned char)value;
    return dst;
}

extern FARPROC g_winmm_table[];
extern const char *g_winmm_names[];
extern int g_winmm_count;

static HMODULE g_realWinmm;

static void proxy_append(const char *text) {
    WCHAR temp[MAX_PATH];
    WCHAR path[MAX_PATH];
    WCHAR exe[MAX_PATH];
    DWORD got, at = 0, i = 0, written = 0;
    HANDLE file;
    char line[512];
    int n = 0;
    if (!text) return;
    got = GetTempPathW(MAX_PATH, temp);
    if (!got || got + 24 >= MAX_PATH) return;
    while (temp[at]) { path[at] = temp[at]; ++at; }
    path[at++] = L'c'; path[at++] = L'x'; path[at++] = L'h'; path[at++] = L'o'; path[at++] = L'o'; path[at++] = L'k'; path[at++] = L'-';
    {
        DWORD pid = GetCurrentProcessId();
        WCHAR digits[16];
        int digitsAt = 0;
        if (!pid) digits[digitsAt++] = L'0';
        while (pid) { digits[digitsAt++] = (WCHAR)(L'0' + (pid % 10)); pid /= 10; }
        while (digitsAt > 0) path[at++] = digits[--digitsAt];
    }
    path[at++] = L'.'; path[at++] = L'l'; path[at++] = L'o'; path[at++] = L'g'; path[at] = 0;
    file = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                       OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return;
    for (i = 0; i < (DWORD)sizeof(line); ++i) line[i] = 0;
    exe[0] = 0;
    GetModuleFileNameW(NULL, exe, MAX_PATH);
    while (text[n] && n < 300) { line[n] = text[n]; ++n; }
    line[n++] = ' '; line[n++] = '|'; line[n++] = ' ';
    for (i = 0; exe[i] && n < 460; ++i) line[n++] = (char)(exe[i] < 128 ? exe[i] : '?');
    line[n++] = '\r'; line[n++] = '\n';
    WriteFile(file, line, n, &written, NULL);
    CloseHandle(file);
}

static int proxy_load_real(void) {
    WCHAR dir[MAX_PATH];
    WCHAR path[MAX_PATH];
    DWORD got, at = 0, i;
    int filled = 0;
    if (g_realWinmm) return g_winmm_count;
    got = GetSystemDirectoryW(dir, MAX_PATH);
    if (!got || got + 16 >= MAX_PATH) return 0;
    while (dir[at]) { path[at] = dir[at]; ++at; }
    path[at++] = L'\\'; path[at++] = L'w'; path[at++] = L'i'; path[at++] = L'n'; path[at++] = L'm'; path[at++] = L'm';
    path[at++] = L'.'; path[at++] = L'd'; path[at++] = L'l'; path[at++] = L'l'; path[at] = 0;
    g_realWinmm = LoadLibraryW(path);
    if (!g_realWinmm) return 0;
    for (i = 0; i < (DWORD)g_winmm_count; ++i) {
        FARPROC proc = GetProcAddress(g_realWinmm, g_winmm_names[i]);
        g_winmm_table[i] = proc ? proc : (FARPROC)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "GetLastError");
        if (proc) ++filled;
    }
    return filled;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        int filled;
        DisableThreadLibraryCalls(instance);
        filled = proxy_load_real();
        if (filled <= 0) proxy_append("winmm proxy: real winmm not found");
        else proxy_append("winmm proxy loaded");
    } else if (reason == DLL_PROCESS_DETACH) {
        if (g_realWinmm) { FreeLibrary(g_realWinmm); g_realWinmm = NULL; }
    }
    return TRUE;
}