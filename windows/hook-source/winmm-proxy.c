/* winmm.dll 代理：所有导出由生成的 naked 跳转桩转发到系统 winmm。
   本文件只负责加载真实 winmm、填充跳转表、写装载日志。 */
#include <windows.h>
#include <tlhelp32.h>

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


/* ---- 命令行注入：让未带调试开关启动的客户端也能被宿主连接 ----
   思路：DllMain 里把各模块 IAT 中 GetCommandLineW 的地址换成我们的包装函数，
   在原始命令行后追加 --remote-debugging-port=<端口>（端口来自环境变量 CX_INJECT_PORT）。
   Chromium 在 base::CommandLine::Init 里读到的就是追加后的命令行。 */
typedef LPWSTR (WINAPI *GETCOMMANDLINEW)(void);

static WCHAR g_patchedCommandLine[4096];
static BOOL g_commandLineReady = FALSE;
static GETCOMMANDLINEW g_realGetCommandLineW = NULL;

static LPWSTR WINAPI proxy_GetCommandLineW(void) {
    if (g_commandLineReady) return g_patchedCommandLine;
    if (!g_realGetCommandLineW) g_realGetCommandLineW = (GETCOMMANDLINEW)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "GetCommandLineW");
    return g_realGetCommandLineW ? g_realGetCommandLineW() : NULL;
}

static BOOL proxy_contains(const WCHAR *haystack, const WCHAR *needle) {
    int i, k;
    if (!haystack || !needle) return FALSE;
    for (i = 0; haystack[i]; ++i) {
        for (k = 0; needle[k] && haystack[i + k] == needle[k]; ++k) { }
        if (!needle[k]) return TRUE;
    }
    return FALSE;
}

static void proxy_prepare_command_line(void) {
    WCHAR port[16];
    WCHAR *original;
    DWORD got, at = 0;
    if (g_commandLineReady) return;
    if (!g_realGetCommandLineW) g_realGetCommandLineW = (GETCOMMANDLINEW)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "GetCommandLineW");
    if (!g_realGetCommandLineW) return;
    got = GetEnvironmentVariableW(L"CX_INJECT_PORT", port, 16);
    if (!got) return;
    original = g_realGetCommandLineW();
    if (!original || !*original) return;
    if (proxy_contains(original, L"--remote-debugging-port=")) return;
    while (original[at] && at < 4000) { g_patchedCommandLine[at] = original[at]; ++at; }
    {
        static const WCHAR prefix[] = L" --remote-debugging-port=";
        DWORD k = 0;
        while (prefix[k] && at < 4050) g_patchedCommandLine[at++] = prefix[k++];
        k = 0;
        while (port[k] && at < 4080) g_patchedCommandLine[at++] = port[k++];
    }
    g_patchedCommandLine[at] = 0;
    g_commandLineReady = TRUE;
}

static void proxy_patch_module_iat(HMODULE module) {
    IMAGE_DOS_HEADER *dos;
    IMAGE_NT_HEADERS *nt;
    IMAGE_IMPORT_DESCRIPTOR *descriptor;
    if (!module) return;
    dos = (IMAGE_DOS_HEADER *)module;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return;
    nt = (IMAGE_NT_HEADERS *)((BYTE *)module + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return;
    descriptor = (IMAGE_IMPORT_DESCRIPTOR *)((BYTE *)module + nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress);
    if (!nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress) return;
    while (descriptor && descriptor->Name) {
        IMAGE_THUNK_DATA *lookup = (IMAGE_THUNK_DATA *)((BYTE *)module + descriptor->OriginalFirstThunk);
        IMAGE_THUNK_DATA *address = (IMAGE_THUNK_DATA *)((BYTE *)module + descriptor->FirstThunk);
        if (!lookup) lookup = address;
        while (lookup && lookup->u1.AddressOfData) {
            if (!IMAGE_SNAP_BY_ORDINAL(lookup->u1.Ordinal)) {
                IMAGE_IMPORT_BY_NAME *name = (IMAGE_IMPORT_BY_NAME *)((BYTE *)module + lookup->u1.AddressOfData);
                if (name && name->Name[0] == 'G' && lstrcmpA((const char *)name->Name, "GetCommandLineW") == 0) {
                    DWORD protect = 0;
                    if (VirtualProtect(&address->u1.Function, sizeof(void *), PAGE_READWRITE, &protect)) {
                        address->u1.Function = (ULONG_PTR)proxy_GetCommandLineW;
                        VirtualProtect(&address->u1.Function, sizeof(void *), protect, &protect);
                    }
                }
            }
            ++lookup;
            ++address;
        }
        ++descriptor;
    }
}

static void proxy_hook_command_line(void) {
    HANDLE snapshot;
    MODULEENTRY32W entry;
    proxy_prepare_command_line();
    if (!g_commandLineReady) return;
    snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId());
    if (snapshot == INVALID_HANDLE_VALUE) return;
    entry.dwSize = sizeof(entry);
    if (Module32FirstW(snapshot, &entry)) {
        do {
            DWORD protect = 0;
            if (!VirtualProtect(&g_realGetCommandLineW, sizeof(void *), PAGE_READWRITE, &protect)) { }
            proxy_patch_module_iat(entry.hModule);
        } while (Module32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
}
BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        int filled;
        DisableThreadLibraryCalls(instance);
        filled = proxy_load_real();
        proxy_hook_command_line();
        if (filled <= 0) proxy_append("winmm proxy: real winmm not found");
        else proxy_append("winmm proxy loaded");
    } else if (reason == DLL_PROCESS_DETACH) {
        if (g_realWinmm) { FreeLibrary(g_realWinmm); g_realWinmm = NULL; }
    }
    return TRUE;
}

