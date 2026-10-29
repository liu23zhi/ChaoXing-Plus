/* winmm.dll 代理（参考项目 cef-hook 的装载方式）。
   三份目标客户端都只从 WINMM 导入 PlaySoundW，因此代理只需转发这一个导出。
   当前阶段是"装载探针"：DllMain 里写一行日志，证明 DLL 能被客户端加载；
   CEF 钩子（Detours）留到下一步，避免一次引入太多变量。 */
#include <windows.h>

#pragma function(memset)
void *__cdecl memset(void *dst, int value, size_t count) {
    unsigned char *p = (unsigned char *)dst;
    while (count--) *p++ = (unsigned char)value;
    return dst;
}

static HMODULE g_realWinmm;
static FARPROC g_playSound;

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
    { int z; for (z = 0; z < (int)sizeof(line); ++z) line[z] = 0; }
    exe[0] = 0;
    GetModuleFileNameW(NULL, exe, MAX_PATH);
    while (text[n] && n < 300) { line[n] = text[n]; ++n; }
    line[n++] = ' '; line[n++] = '|'; line[n++] = ' ';
    for (i = 0; exe[i] && n < 460; ++i) line[n++] = (char)(exe[i] < 128 ? exe[i] : '?');
    line[n++] = '\r'; line[n++] = '\n';
    WriteFile(file, line, n, &written, NULL);
    CloseHandle(file);
}

static BOOL proxy_load_real(void) {
    WCHAR dir[MAX_PATH];
    WCHAR path[MAX_PATH];
    DWORD got, at = 0, i = 0;
    if (g_realWinmm) return TRUE;
    got = GetSystemDirectoryW(dir, MAX_PATH);
    if (!got || got + 16 >= MAX_PATH) return FALSE;
    while (dir[at]) { path[at] = dir[at]; ++at; }
    path[at++] = L'\\'; path[at++] = L'w'; path[at++] = L'i'; path[at++] = L'n'; path[at++] = L'm'; path[at++] = L'm';
    path[at++] = L'.'; path[at++] = L'd'; path[at++] = L'l'; path[at++] = L'l'; path[at] = 0;
    g_realWinmm = LoadLibraryW(path);
    if (!g_realWinmm) return FALSE;
    g_playSound = GetProcAddress(g_realWinmm, "PlaySoundW");
    (void)i;
    return TRUE;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(instance);
        if (!proxy_load_real()) proxy_append("winmm proxy: real winmm not found");
        else proxy_append("winmm proxy loaded");
    } else if (reason == DLL_PROCESS_DETACH) {
        if (g_realWinmm) { FreeLibrary(g_realWinmm); g_realWinmm = NULL; g_playSound = NULL; }
    }
    return TRUE;
}

BOOL WINAPI ProxyPlaySoundW(LPCWSTR name, HMODULE module, DWORD flags) {
    typedef BOOL (WINAPI *PLAYSOUNDW)(LPCWSTR, HMODULE, DWORD);
    if (!g_playSound) proxy_load_real();
    if (!g_playSound) return FALSE;
    return ((PLAYSOUNDW)g_playSound)(name, module, flags);
}

