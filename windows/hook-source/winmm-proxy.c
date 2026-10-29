/* winmm.dll 代理：所有导出由生成的 naked 跳转桩转发到系统 winmm。
   设计要点（2026-10-29 真实客户端 0xc0000142 故障后修正）：
   - DllMain 只做 DisableThreadLibraryCalls、记录实例、启动工作线程；
     绝不能在加载器锁内 LoadLibrary / 枚举 Toolhelp（会让宿主 DLL 初始化失败）。
   - 跳转表由 lazy 桩按需填充：先看表项，为空则调用 proxy_ensure() 再跳。 */
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
static HINSTANCE g_proxyInstance;
static LONG g_initState; /* 0=未初始化 1=进行中 2=完成 */
static char g_fixedPort[16];
static WCHAR g_patchedCommandLine[4096];
static BOOL g_commandLineReady;
static LPWSTR (WINAPI *g_realGetCommandLineW)(void);

static void proxy_append(const char *text);
static void proxy_read_fixed_port(void);
static void proxy_prepare_command_line(void);
static void proxy_hook_command_line(void);
static void proxy_init_table(void);
void __cdecl proxy_ensure(void);
static DWORD WINAPI proxy_warmup(LPVOID unused);

/* ---- 日志：%TEMP%\cxhook-<pid>.log ---- */
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

/* ---- 固定端口：cxhook-port.txt（第三方拉起场景） ---- */
static void proxy_read_fixed_port(void) {
    WCHAR path[MAX_PATH];
    DWORD got, at = 0, i;
    HANDLE file;
    char text[16];
    DWORD read = 0;
    g_fixedPort[0] = 0;
    if (!g_proxyInstance) return;
    got = GetModuleFileNameW(g_proxyInstance, path, MAX_PATH);
    if (!got || got + 20 >= MAX_PATH) return;
    for (i = 0; i < got; ++i) {
        if (path[i] == L'\\' || path[i] == L'/') at = i;
    }
    if (!at) return;
    {
        static const WCHAR tail[] = L"\\cxhook-port.txt";
        DWORD k = 0;
        while (tail[k] && at + k + 1 < MAX_PATH) { path[at + k] = tail[k]; ++k; }
        path[at + k] = 0;
    }
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return;
    if (ReadFile(file, text, sizeof(text) - 1, &read, NULL) && read > 0) {
        DWORD k = 0, n = 0;
        text[read] = 0;
        while (text[k] == ' ' || text[k] == '\r' || text[k] == '\n') ++k;
        while (text[k] >= '0' && text[k] <= '9' && n < 15) g_fixedPort[n++] = text[k++];
        g_fixedPort[n] = 0;
    }
    CloseHandle(file);
}

static LPWSTR WINAPI proxy_GetCommandLineW(void) {
    if (g_commandLineReady) return g_patchedCommandLine;
    if (!g_realGetCommandLineW) g_realGetCommandLineW = (LPWSTR (WINAPI *)(void))GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "GetCommandLineW");
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
    if (!g_realGetCommandLineW) g_realGetCommandLineW = (LPWSTR (WINAPI *)(void))GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "GetCommandLineW");
    if (!g_realGetCommandLineW) return;
    got = GetEnvironmentVariableW(L"CX_INJECT_PORT", port, 16);
    if (!got) {
        DWORD k = 0;
        if (!g_fixedPort[0]) proxy_read_fixed_port();
        if (!g_fixedPort[0]) return;
        while (g_fixedPort[k] && k < 15) { port[k] = (WCHAR)g_fixedPort[k]; ++k; }
        port[k] = 0;
    }
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
    if (!nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress) return;
    descriptor = (IMAGE_IMPORT_DESCRIPTOR *)((BYTE *)module + nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress);
    while (descriptor && descriptor->Name) {
        IMAGE_THUNK_DATA *lookup = (IMAGE_THUNK_DATA *)((BYTE *)module + descriptor->OriginalFirstThunk);
        IMAGE_THUNK_DATA *address = (IMAGE_THUNK_DATA *)((BYTE *)module + descriptor->FirstThunk);
        if (!lookup) lookup = address;
        while (lookup && lookup->u1.AddressOfData) {
            if (!IMAGE_SNAP_BY_ORDINAL(lookup->u1.Ordinal)) {
                IMAGE_IMPORT_BY_NAME *name = (IMAGE_IMPORT_BY_NAME *)((BYTE *)module + lookup->u1.AddressOfData);
                if (name && lstrcmpA((const char *)name->Name, "GetCommandLineW") == 0) {
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
    if (!g_commandLineReady) proxy_prepare_command_line();
    if (!g_commandLineReady) return;
    snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId());
    if (snapshot == INVALID_HANDLE_VALUE) return;
    entry.dwSize = sizeof(entry);
    if (Module32FirstW(snapshot, &entry)) {
        do {
            proxy_patch_module_iat(entry.hModule);
        } while (Module32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
}

static void proxy_init_table(void) {
    WCHAR dir[MAX_PATH];
    WCHAR path[MAX_PATH];
    DWORD got, at = 0, i;
    got = GetSystemDirectoryW(dir, MAX_PATH);
    if (!got || got + 16 >= MAX_PATH) return;
    while (dir[at]) { path[at] = dir[at]; ++at; }
    path[at++] = L'\\'; path[at++] = L'w'; path[at++] = L'i'; path[at++] = L'n'; path[at++] = L'm'; path[at++] = L'm';
    path[at++] = L'.'; path[at++] = L'd'; path[at++] = L'l'; path[at++] = L'l'; path[at] = 0;
    g_realWinmm = LoadLibraryW(path);
    if (!g_realWinmm) { proxy_append("winmm proxy: real winmm not found"); return; }
    for (i = 0; i < (DWORD)g_winmm_count; ++i) {
        FARPROC proc = GetProcAddress(g_realWinmm, g_winmm_names[i]);
        g_winmm_table[i] = proc ? proc : (FARPROC)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "GetLastError");
    }
    proxy_append("winmm proxy loaded");
}

void __cdecl proxy_ensure(void) {
    if (InterlockedCompareExchange(&g_initState, 1, 0) == 0) {
        proxy_init_table();
        InterlockedExchange(&g_initState, 2);
        return;
    }
    while (InterlockedCompareExchange(&g_initState, 0, 0) != 2) Sleep(0);
}

static DWORD WINAPI proxy_warmup(LPVOID unused) {
    int attempt;
    (void)unused;
    proxy_prepare_command_line();
    if (!g_commandLineReady) proxy_append("winmm proxy: no injection port");
    for (attempt = 0; attempt < 20; ++attempt) {
        proxy_hook_command_line();
        if (g_commandLineReady) break;
        Sleep(10);
    }
    proxy_append(g_commandLineReady ? "winmm proxy: hook done" : "winmm proxy: hook skipped");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(instance);
        g_proxyInstance = instance;
        /* 只做 LoadLibrary + GetProcAddress 填表；Toolhelp/日志交给工作线程，
           避免在加载器锁内枚举模块导致宿主 0xc0000142。 */
        proxy_init_table();
        CreateThread(NULL, 0, proxy_warmup, NULL, 0, NULL);
    } else if (reason == DLL_PROCESS_DETACH) {
        if (g_realWinmm) { FreeLibrary(g_realWinmm); g_realWinmm = NULL; }
    }
    return TRUE;
}


