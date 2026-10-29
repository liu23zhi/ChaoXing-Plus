/* winmm.dll 代理：所有导出由生成的 naked 跳转桩转发到系统 winmm。
   设计要点（2026-10-29 真实客户端 0xc0000142 故障后修正）：
   - DllMain 只做 DisableThreadLibraryCalls、记录实例、启动工作线程；
     绝不能在加载器锁内 LoadLibrary / 枚举 Toolhelp（会让宿主 DLL 初始化失败）。
   - 跳转表由 lazy 桩按需填充：先看表项，为空则调用 proxy_ensure() 再跳。 */
#include <windows.h>

/* 目标系统 DLL：由构建脚本通过 /DCX_PROXY_TARGET_DLL=L"version.dll" 指定。 */
#ifndef CX_PROXY_TARGET_DLL
#define CX_PROXY_TARGET_DLL L"winmm.dll"
#endif
#include <tlhelp32.h>

#pragma function(memset)
void *__cdecl memset(void *dst, int value, size_t count) {
    unsigned char *p = (unsigned char *)dst;
    while (count--) *p++ = (unsigned char)value;
    return dst;
}


#pragma function(memcpy)
void *__cdecl memcpy(void *dst, const void *src, size_t count) {
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;
    while (count--) *d++ = *s++;
    return dst;
}
extern FARPROC g_winmm_table[];
extern const char *g_winmm_names[];
extern int g_winmm_count;

typedef struct MY_LIST_ENTRY { struct MY_LIST_ENTRY *Flink; struct MY_LIST_ENTRY *Blink; } MY_LIST_ENTRY;
typedef struct MY_LDR_ENTRY {
    MY_LIST_ENTRY InLoadOrder;
    MY_LIST_ENTRY InMemoryOrder;
    MY_LIST_ENTRY InInitializationOrder;
    PVOID DllBase;
} MY_LDR_ENTRY;
static HMODULE g_realWinmm;
static HINSTANCE g_proxyInstance;
static LONG g_initState;
static LONG g_patchedSlots; /* 0=未初始化 1=进行中 2=完成 */
static char g_fixedPort[16];
static WCHAR g_patchedCommandLine[4096];
static BOOL g_commandLineReady;
static LPWSTR (WINAPI *g_realGetCommandLineW)(void);

static LPWSTR WINAPI proxy_GetCommandLineW(void);
static void proxy_append(const char *text);
static void proxy_read_fixed_port(void);
static void proxy_prepare_command_line(void);
static void proxy_hook_command_line(void);
static void proxy_init_table(void);
void __cdecl proxy_ensure(void);
static DWORD WINAPI proxy_warmup(LPVOID unused);


/* ---- 内联钩子：kernel32!GetCommandLineW ----
   之前用 IAT 补丁，但 CEF 在 libcef 的静态初始化阶段就读命令行，补丁可能太晚。
   kernel32 的导出通常是 5 字节 jmp 转发，直接改写入口最可靠。 */
static BYTE *g_trampoline;
typedef LPWSTR (WINAPI *GETCMDLINE)(void);
static GETCMDLINE g_originalGetCommandLineW;

static BOOL proxy_inline_hook_getcmdline(void) {
    HMODULE k32;
    BYTE *target;
    DWORD oldProtect = 0;
    BYTE *trampoline;
    k32 = GetModuleHandleW(L"kernel32.dll");
    if (!k32) return FALSE;
    target = (BYTE *)GetProcAddress(k32, "GetCommandLineW");
    if (!target) return FALSE;
    if (g_trampoline) return TRUE;
    if (target[0] != 0xE9) return FALSE; /* 只处理转发跳转（jmp rel32）形式 */
    trampoline = (BYTE *)VirtualAlloc(NULL, 64, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (!trampoline) return FALSE;
    CopyMemory(trampoline, target, 5);
    trampoline[5] = 0xE9;
    *(DWORD *)(trampoline + 6) = (DWORD)((target + 5) - (trampoline + 10));
    g_trampoline = trampoline;
    g_originalGetCommandLineW = (GETCMDLINE)trampoline;
    if (!VirtualProtect(target, 8, PAGE_EXECUTE_READWRITE, &oldProtect)) return FALSE;
    target[0] = 0xE9;
    *(DWORD *)(target + 1) = (DWORD)((BYTE *)proxy_GetCommandLineW - (target + 5));
    VirtualProtect(target, 8, oldProtect, &oldProtect);
    return TRUE;
}
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
    if (g_originalGetCommandLineW) return g_originalGetCommandLineW();
    return NULL;
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
                        InterlockedIncrement(&g_patchedSlots);
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



/* 直接改写 PEB 里的命令行（RTL_USER_PROCESS_PARAMETERS.CommandLine），
   这样真实 GetCommandLineW 返回的就是带 --remote-debugging-port 的版本，
   不需要枚举模块或打 IAT 补丁——DllMain 里最安全的做法。 */
typedef struct MY_UNICODE_STRING {
    USHORT Length;
    USHORT MaximumLength;
    PWSTR Buffer;
} MY_UNICODE_STRING;

static void proxy_rewrite_peb_command_line(void) {
    void *peb = NULL;
    unsigned char *params;
    MY_UNICODE_STRING *commandLine;
    WCHAR *original;
    WCHAR port[16];
    DWORD got;
    DWORD originalLength = 0, suffixLength = 0, total;
    WCHAR *buffer;
    static const WCHAR suffixPrefix[] = L" --remote-debugging-port=";
    if (!g_commandLineReady) {
        /* 复用已有逻辑先确定端口 */
        proxy_prepare_command_line();
    }
    if (!g_commandLineReady) return;
    __asm {
        mov eax, fs:[0x30]
        mov peb, eax
    }
    if (!peb) return;
    params = *(unsigned char **)((unsigned char *)peb + 0x10);
    if (!params) return;
    commandLine = (MY_UNICODE_STRING *)(params + 0x40);
    original = commandLine->Buffer;
    if (!original || !commandLine->Length) return;
    originalLength = commandLine->Length / 2;
    while (original[originalLength] && originalLength < 8192) ++originalLength;
    {
        int i, k;
        for (i = 0; original[i]; ++i) {
            for (k = 0; suffixPrefix[k] && original[i + k] == suffixPrefix[k]; ++k) { }
            if (!suffixPrefix[k]) return; /* 已有开关 */
        }
    }
    got = GetEnvironmentVariableW(L"CX_INJECT_PORT", port, 16);
    if (!got) {
        DWORD k2 = 0;
        if (!g_fixedPort[0]) proxy_read_fixed_port();
        if (!g_fixedPort[0]) return;
        while (g_fixedPort[k2] && k2 < 15) { port[k2] = (WCHAR)g_fixedPort[k2]; ++k2; }
        port[k2] = 0;
    }
    suffixLength = (DWORD)(sizeof(suffixPrefix) / sizeof(WCHAR) - 1) + (DWORD)lstrlenW(port);
    total = (originalLength + suffixLength + 1) * sizeof(WCHAR);
    buffer = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, total + sizeof(WCHAR));
    if (!buffer) return;
    CopyMemory(buffer, original, originalLength * sizeof(WCHAR));
    CopyMemory(buffer + originalLength, suffixPrefix, (sizeof(suffixPrefix) - sizeof(WCHAR)));
    CopyMemory(buffer + originalLength + (sizeof(suffixPrefix) / sizeof(WCHAR) - 1), port, lstrlenW(port) * sizeof(WCHAR));
    commandLine->Buffer = buffer;
    commandLine->Length = (USHORT)((originalLength + suffixLength) * sizeof(WCHAR));
    commandLine->MaximumLength = (USHORT)(total + sizeof(WCHAR));
    g_commandLineReady = TRUE;
    proxy_append("winmm proxy: peb command line rewritten");
}

/* ---- 通过 cef_initialize 强制端口 ----
   超星 4.3.0.4 忽略命令行开关，但 CEF 仍会读 CefSettings。
   在 cef_initialize 调用前把 settings->remote_debugging_port 设为固定端口。 */
typedef int (__cdecl *CEF_INITIALIZE)(const void *args, void *settings, void *application, void *sandbox);
static CEF_INITIALIZE g_realCefInit;
static int g_forcedPort;

static int __cdecl proxy_cef_init_hook(const void *args, void *settings, void *application, void *sandbox) {
    if (settings) {
        DWORD reportedSize = *(DWORD *)settings;
        char line[64];
        static const char prefix[] = "winmm proxy: cef_settings size=";
        int k = 0, v = (int)reportedSize, d = 0;
        char digits[12];
        while (prefix[k]) { line[k] = prefix[k]; ++k; }
        if (!v) digits[d++] = '0';
        while (v > 0 && d < 11) { digits[d++] = (char)('0' + v % 10); v /= 10; }
        while (d > 0) line[k++] = digits[--d];
        line[k] = 0;
        proxy_append(line);
    }
    if (settings && g_forcedPort) {
        DWORD size = *(DWORD *)settings;
        int offset = -1;
        if (size >= 228) offset = 184;        /* CEF 75 + root_cache_path */
        else if (size == 216) offset = 172;    /* 无 root_cache_path */
        if (offset > 0 && (DWORD)offset + 4 <= size) {
            int *port = (int *)((BYTE *)settings + offset);
            *port = g_forcedPort;
            proxy_append("winmm proxy: cef settings port applied");
        } else {
            proxy_append("winmm proxy: unexpected cef_settings size");
        }
    }
    if (!g_realCefInit) return -1;
    return g_realCefInit(args, settings, application, sandbox);
}


/* ---- 通过 cef_command_line_get_global 追加开关 ----
   4.3.0.4 只从 libcef 导入这一个函数，说明它用 CEF 的全局命令行对象。
   拿到对象后调用其 append_switch_with_value（vtable 偏移 76）追加调试端口。 */
typedef struct { unsigned short *str; unsigned int length; void *dtor; } MY_CEF_STRING;
typedef void *(__cdecl *CEF_CMDLINE_GET_GLOBAL)(void);
typedef void (__cdecl *CEF_APPEND_SWITCH_VALUE)(void *self, const MY_CEF_STRING *name, const MY_CEF_STRING *value);

static CEF_CMDLINE_GET_GLOBAL g_realCmdlineGetGlobal;
static BOOL g_switchAppended;

static void proxy_make_cef_string(MY_CEF_STRING *out, const WCHAR *text) {
    int length = 0;
    while (text[length]) ++length;
    out->str = (unsigned short *)text;
    out->length = (unsigned int)length;
    out->dtor = NULL;
}

static void *__cdecl proxy_cmdline_get_global_hook(void) {
    void *cmdline;
    if (!g_realCmdlineGetGlobal) return NULL;
    cmdline = g_realCmdlineGetGlobal();
    if (cmdline && !g_switchAppended && g_forcedPort > 0) {
        CHAR **vtable = (CHAR **)cmdline;
        CEF_APPEND_SWITCH_VALUE append;
        MY_CEF_STRING name, value;
        static const WCHAR nameText[] = L"remote-debugging-port";
        static WCHAR portText[16];
        int i = 0, v = g_forcedPort;
        char digits[12];
        int d = 0;
        if (!v) digits[d++] = '0';
        while (v > 0 && d < 11) { digits[d++] = (char)('0' + v % 10); v /= 10; }
        {
            char tmp[12];
            int t = 0;
            while (d > 0) tmp[t++] = digits[--d];
            for (i = 0; i < t; ++i) portText[i] = (WCHAR)tmp[i];
            portText[t] = 0;
        }
        append = (CEF_APPEND_SWITCH_VALUE)(*(void **)((BYTE *)vtable + 76));
        if (append) {
            proxy_make_cef_string(&name, nameText);
            proxy_make_cef_string(&value, portText);
            append(cmdline, &name, &value);
            g_switchAppended = TRUE;
            proxy_append("winmm proxy: cef command line switch appended");
        } else {
            proxy_append("winmm proxy: cef command line vtable unexpected");
        }
    }
    return cmdline;
}
static BOOL proxy_patch_iat_by_value(HMODULE module, void *target, void *replacement, void **original) {
    IMAGE_DOS_HEADER *dos;
    IMAGE_NT_HEADERS *nt;
    IMAGE_IMPORT_DESCRIPTOR *descriptor;
    BOOL patched = FALSE;
    if (!module || !target) return FALSE;
    dos = (IMAGE_DOS_HEADER *)module;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return FALSE;
    nt = (IMAGE_NT_HEADERS *)((BYTE *)module + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return FALSE;
    if (!nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress) return FALSE;
    descriptor = (IMAGE_IMPORT_DESCRIPTOR *)((BYTE *)module + nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress);
    while (descriptor && descriptor->Name) {
        IMAGE_THUNK_DATA *address = (IMAGE_THUNK_DATA *)((BYTE *)module + descriptor->FirstThunk);
        while (address && address->u1.Function) {
            if ((void *)address->u1.Function == target) {
                DWORD protect = 0;
                if (VirtualProtect(&address->u1.Function, sizeof(void *), PAGE_READWRITE, &protect)) {
                    if (original && !*original) *original = (void *)address->u1.Function;
                    address->u1.Function = (ULONG_PTR)replacement;
                    VirtualProtect(&address->u1.Function, sizeof(void *), protect, &protect);
                    patched = TRUE;
                }
            }
            ++address;
        }
        ++descriptor;
    }
    return patched;
}

/* 遍历 PEB 模块列表，按地址替换 IAT 项。 */
static int proxy_patch_all_by_value(void *target, void *replacement, void **original) {
    void *peb = NULL;
    MY_LIST_ENTRY *head, *cursor;
    int guard = 0, count = 0;
    __asm { mov eax, fs:[0x30]
            mov peb, eax }
    if (!peb) return 0;
    {
        unsigned char *ldr = *(unsigned char **)((unsigned char *)peb + 0x0C);
        if (!ldr) return 0;
        head = (MY_LIST_ENTRY *)(ldr + 0x14);
    }
    cursor = head->Flink;
    while (cursor && cursor != head && guard++ < 512) {
        HMODULE base = *(HMODULE *)((BYTE *)cursor + 0x10);
        if (base && proxy_patch_iat_by_value(base, target, replacement, original)) ++count;
        cursor = cursor->Flink;
    }
    return count;
}
/* 通过 PEB 遍历已加载模块（不调用 Toolhelp，避免加载器锁死锁）。 */

static void proxy_patch_all_modules_peb(void) {
    void *peb = NULL;
    MY_LIST_ENTRY *head;
    MY_LIST_ENTRY *cursor;
    int guard = 0;
    __asm {
        mov eax, fs:[0x30]
        mov peb, eax
    }
    if (!peb) return;
    /* PEB->Ldr 在 0x0C；Ldr->InMemoryOrderModuleList 在 0x14 */
    {
        unsigned char *ldr = *(unsigned char **)((unsigned char *)peb + 0x0C);
        if (!ldr) return;
        head = (MY_LIST_ENTRY *)(ldr + 0x14);
    }
    cursor = head->Flink;
    while (cursor && cursor != head && guard++ < 512) {
        BYTE *entry = (BYTE *)cursor;
        HMODULE base = *(HMODULE *)(entry + 0x10); /* InMemoryOrderLinks(0x08) + DllBase(0x18) */
        if (base) proxy_patch_module_iat(base);
        cursor = cursor->Flink;
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


/* ---- CEF 入口补丁 ----
   libcef 的导入序号早于 winmm，命令行可能在我们的 DllMain 之前就被读取。
   因此在工作线程里替换主程序 IAT 中的 cef_initialize：调用真实函数前再改写一次 PEB 命令行。 */
typedef int (__cdecl *CEF_INITIALIZE)(const void *args, const void *settings, void *application, void *sandbox);
static CEF_INITIALIZE g_realCefInitialize;

static int __cdecl proxy_cef_initialize_hook(const void *args, const void *settings, void *application, void *sandbox) {
    proxy_rewrite_peb_command_line();
    proxy_append("winmm proxy: cef_initialize intercepted");
    if (!g_realCefInitialize) return -1;
    return g_realCefInitialize(args, settings, application, sandbox);
}

static BOOL proxy_patch_module_iat_named(HMODULE module, const char *importName, void *replacement, void **original) {
    IMAGE_DOS_HEADER *dos;
    IMAGE_NT_HEADERS *nt;
    IMAGE_IMPORT_DESCRIPTOR *descriptor;
    BOOL patched = FALSE;
    if (!module) return FALSE;
    dos = (IMAGE_DOS_HEADER *)module;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return FALSE;
    nt = (IMAGE_NT_HEADERS *)((BYTE *)module + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return FALSE;
    if (!nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress) return FALSE;
    descriptor = (IMAGE_IMPORT_DESCRIPTOR *)((BYTE *)module + nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress);
    while (descriptor && descriptor->Name) {
        IMAGE_THUNK_DATA *lookup = (IMAGE_THUNK_DATA *)((BYTE *)module + descriptor->OriginalFirstThunk);
        IMAGE_THUNK_DATA *address = (IMAGE_THUNK_DATA *)((BYTE *)module + descriptor->FirstThunk);
        if (!lookup) lookup = address;
        while (lookup && lookup->u1.AddressOfData) {
            if (!IMAGE_SNAP_BY_ORDINAL(lookup->u1.Ordinal)) {
                IMAGE_IMPORT_BY_NAME *name = (IMAGE_IMPORT_BY_NAME *)((BYTE *)module + lookup->u1.AddressOfData);
                if (name && lstrcmpA((const char *)name->Name, importName) == 0) {
                    DWORD protect = 0;
                    if (VirtualProtect(&address->u1.Function, sizeof(void *), PAGE_READWRITE, &protect)) {
                        if (original && !*original) *original = (void *)address->u1.Function;
                        address->u1.Function = (ULONG_PTR)replacement;
                        VirtualProtect(&address->u1.Function, sizeof(void *), protect, &protect);
                        patched = TRUE;
                    }
                }
            }
            ++lookup;
            ++address;
        }
        ++descriptor;
    }
    return patched;
}

/* ---- 通过 GetProcAddress 钩子拦截 cef_initialize（应对 Themida 运行时重建导入表） ---- */
typedef FARPROC (WINAPI *GPA_FN)(HMODULE module, LPCSTR name);
static GPA_FN g_realGetProcAddress;
static void *g_realCefInitAddr;

static int __cdecl proxy_cef_init_wrapper(const void *args, void *settings, void *application, void *sandbox) {
    typedef int (__cdecl *CEF_INIT_FN)(const void *, void *, void *, void *);
    CEF_INIT_FN real = (CEF_INIT_FN)g_realCefInitAddr;
    if (settings) {
        DWORD reportedSize = *(DWORD *)settings;
        char line[64];
        static const char prefix[] = "winmm proxy: cef_settings size=";
        int k = 0, v = (int)reportedSize, d = 0;
        char digits[12];
        while (prefix[k]) { line[k] = prefix[k]; ++k; }
        if (!v) digits[d++] = '0';
        while (v > 0 && d < 11) { digits[d++] = (char)('0' + v % 10); v /= 10; }
        while (d > 0) line[k++] = digits[--d];
        line[k] = 0;
        proxy_append(line);
    }
    if (settings && g_forcedPort) {
        DWORD size = *(DWORD *)settings;
        int offset = -1;
        /* IG5 反编译 libcef!FUN_100030bc 证实：remote_debugging_port 固定位于 +0xB8(184)，
           其后的字段（background_color / accept_language_list / application_client_id…）
           只影响 sizeof。因此只要结构体覆盖到 +188 就用 184，不能再按 sizeof 回退偏移。 */
        if (size >= 188) offset = 184;
        if (offset > 0 && (DWORD)offset + 4 <= size) {
            /* IG5 实测 cef_settings_t 布局：size=0xE4(228)、command_line_args_disabled=0x2C(44)、
               remote_debugging_port=0xB8(184)。这里同时解除命令行开关禁用。 */
            if (size >= 0x30) {
                int *disabled = (int *)((BYTE *)settings + 44);
                if (*disabled != 0) {
                    char line[72];
                    static const char prefix[] = "winmm proxy: command_line_args_disabled=";
                    int k = 0;
                    while (prefix[k]) { line[k] = prefix[k]; ++k; }
                    line[k++] = (char)('0' + (*disabled % 10));
                    line[k++] = '>'; line[k++] = '0';
                    line[k] = 0;
                    proxy_append(line);
                    *disabled = 0;
                }
            }
            *(int *)((BYTE *)settings + offset) = g_forcedPort;
            proxy_append("winmm proxy: cef settings port applied");
        }
    }
    if (!real) return -1;
    return real(args, settings, application, sandbox);
}

static BOOL proxy_inline_hook(void *targetAddr, void *hookAddr, void **trampolineOut) {
    BYTE *target = (BYTE *)targetAddr;
    BYTE *trampoline;
    DWORD oldProtect = 0;
    int patchLength;
    if (!target || !hookAddr) return FALSE;
    if (target[0] == 0xE9) patchLength = 5;
    else if (target[0] == 0xFF && target[1] == 0x25) patchLength = 6;
    else return FALSE;
    trampoline = (BYTE *)VirtualAlloc(NULL, 64, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (!trampoline) return FALSE;
    CopyMemory(trampoline, target, patchLength);
    trampoline[patchLength] = 0xE9;
    *(DWORD *)(trampoline + patchLength + 1) = (DWORD)((target + patchLength) - (trampoline + patchLength + 5));
    if (!VirtualProtect(target, 16, PAGE_EXECUTE_READWRITE, &oldProtect)) return FALSE;
    if (patchLength == 5) {
        target[0] = 0xE9;
        *(DWORD *)(target + 1) = (DWORD)((BYTE *)hookAddr - (target + 5));
    } else {
        void **slot = (void **)VirtualAlloc(NULL, sizeof(void *), MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if (!slot) return FALSE;
        *slot = hookAddr;
        target[0] = 0xFF;
        target[1] = 0x25;
        *(DWORD *)(target + 2) = (DWORD)slot;
    }
    VirtualProtect(target, 16, oldProtect, &oldProtect);
    if (trampolineOut) *trampolineOut = trampoline;
    return TRUE;
}

static FARPROC WINAPI proxy_GetProcAddress(HMODULE module, LPCSTR name) {
    FARPROC result;
    if (!g_realGetProcAddress) return NULL;
    result = g_realGetProcAddress(module, name);
    if (name && result && lstrcmpA(name, "cef_initialize") == 0) {
        g_realCefInitAddr = (void *)result;
        proxy_append("winmm proxy: cef_initialize resolved");
        return (FARPROC)proxy_cef_init_wrapper;
    }
    return result;
}

static void proxy_hook_getprocaddress(void) {
    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    void *target;
    void *trampoline = NULL;
    if (!k32 || g_realGetProcAddress) return;
    target = (void *)GetProcAddress(k32, "GetProcAddress");
    if (!target) return;
    if (!proxy_inline_hook(target, (void *)proxy_GetProcAddress, &trampoline)) {
        proxy_append("winmm proxy: GetProcAddress hook skipped");
        return;
    }
    g_realGetProcAddress = (GPA_FN)trampoline;
    proxy_append("winmm proxy: GetProcAddress hooked");
}

/* 6 字节 prologue 补丁：55 8B EC 83 EC xx → push <hook>; ret
   用于 libcef!cef_initialize（不能假设 5 字节边界，但 6 字节是完整指令边界）。 */
static void *g_cefInitTrampoline;

static BOOL proxy_patch_pushret(void *targetAddr, void *hookAddr, void **trampolineOut) {
    BYTE *target = (BYTE *)targetAddr;
    BYTE *trampoline;
    DWORD oldProtect = 0;
    if (!target || !hookAddr) return FALSE;
    /* 支持两种 32 位序言：
       55 8B EC 83 EC xx        → 6 字节 push/ret 补丁
       8B FF 55 8B EC           → 热补丁序言，5 字节边界，patch 在 +2 */
    if (target[0] == 0x8B && target[1] == 0xFF && target[2] == 0x55 && target[3] == 0x8B && target[4] == 0xEC) {
        BYTE *tramp2 = (BYTE *)VirtualAlloc(NULL, 64, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
        if (!tramp2) return FALSE;
        CopyMemory(tramp2, target, 5);
        tramp2[5] = 0xE9;
        *(DWORD *)(tramp2 + 6) = (DWORD)((target + 5) - (tramp2 + 10));
        if (!VirtualProtect(target, 16, PAGE_EXECUTE_READWRITE, &oldProtect)) return FALSE;
        target[2] = 0xE9;
        *(DWORD *)(target + 3) = (DWORD)((BYTE *)hookAddr - (target + 7));
        VirtualProtect(target, 16, oldProtect, &oldProtect);
        if (trampolineOut) *trampolineOut = tramp2;
        return TRUE;
    }
    /* GCC/MinGW 序言：55 89 E5 53 57 56（6 字节边界）→ 同样用 push/ret */
    if (target[0] == 0x55 && target[1] == 0x89 && target[2] == 0xE5 && target[3] == 0x53 && target[4] == 0x57 && target[5] == 0x56) {
        BYTE *tramp3 = (BYTE *)VirtualAlloc(NULL, 64, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
        if (!tramp3) return FALSE;
        CopyMemory(tramp3, target, 6);
        tramp3[6] = 0xE9;
        *(DWORD *)(tramp3 + 7) = (DWORD)((target + 6) - (tramp3 + 11));
        if (!VirtualProtect(target, 16, PAGE_EXECUTE_READWRITE, &oldProtect)) return FALSE;
        target[0] = 0x68;
        *(DWORD *)(target + 1) = (DWORD)hookAddr;
        target[5] = 0xC3;
        VirtualProtect(target, 16, oldProtect, &oldProtect);
        if (trampolineOut) *trampolineOut = tramp3;
        return TRUE;
    }
    if (target[0] != 0x55 || target[1] != 0x8B || target[2] != 0xEC || target[3] != 0x83 || target[4] != 0xEC) {
        char line[96];
        int k = 0, i;
        static const char *hex = "0123456789abcdef";
        static const char prefix[] = "winmm proxy: cef_init prologue=";
        while (prefix[k]) { line[k] = prefix[k]; ++k; }
        for (i = 0; i < 8 && k < 90; ++i) { line[k++] = hex[target[i] >> 4]; line[k++] = hex[target[i] & 0xF]; line[k++] = ' '; }
        line[k] = 0;
        proxy_append(line);
        return FALSE;
    }
    trampoline = (BYTE *)VirtualAlloc(NULL, 64, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (!trampoline) return FALSE;
    CopyMemory(trampoline, target, 6);
    trampoline[6] = 0xE9;
    *(DWORD *)(trampoline + 7) = (DWORD)((target + 6) - (trampoline + 11));
    if (!VirtualProtect(target, 16, PAGE_EXECUTE_READWRITE, &oldProtect)) return FALSE;
    target[0] = 0x68;                 /* push imm32 */
    *(DWORD *)(target + 1) = (DWORD)hookAddr;
    target[5] = 0xC3;                 /* ret */
    VirtualProtect(target, 16, oldProtect, &oldProtect);
    if (trampolineOut) *trampolineOut = trampoline;
    return TRUE;
}

static BOOL proxy_hook_cef_initialize(void) {
    HMODULE cef = GetModuleHandleW(L"libcef.dll");
    void *target;
    void *trampoline = NULL;
    if (!cef || g_cefInitTrampoline) return g_cefInitTrampoline != NULL;
    target = (void *)GetProcAddress(cef, "cef_initialize");
    if (!target) { proxy_append("winmm proxy: cef_initialize not exported"); return FALSE; }
    g_realCefInitAddr = target;
    if (!proxy_patch_pushret(target, (void *)proxy_cef_init_wrapper, &trampoline)) {
        proxy_append("winmm proxy: cef_initialize patch skipped");
        return FALSE;
    }
    g_cefInitTrampoline = trampoline;
    /* wrapper 通过 g_realCefInitAddr 调用真实函数；我们改用 trampoline */
    g_realCefInitAddr = trampoline;
    proxy_append("winmm proxy: cef_initialize patched (pushret)");
    return TRUE;
}
static void proxy_init_table(void) {
    WCHAR dir[MAX_PATH];
    WCHAR path[MAX_PATH];
    DWORD got, at = 0, i;
    got = GetSystemDirectoryW(dir, MAX_PATH);
    if (!got || got + 16 >= MAX_PATH) return;
    while (dir[at]) { path[at] = dir[at]; ++at; }
    path[at++] = L'\\';
    {
        const WCHAR *target = CX_PROXY_TARGET_DLL;
        int k;
        for (k = 0; target[k] && at < MAX_PATH - 2; ++k) path[at++] = target[k];
    }
    path[at] = 0;
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


/* 诊断：打印 GetCommandLineW 前 8 字节，以及当前真实命令行是否含开关。 */
static void proxy_diag(void) {
    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    BYTE *fn = (BYTE *)GetProcAddress(k32, "GetCommandLineW");
    char line[160];
    int n = 0, i;
    static const char *hex = "0123456789abcdef";
    LPWSTR cmd;
    if (!fn) return;
    for (i = 0; i < 12 && n < 20; ++i) { line[n++] = hex[fn[i] >> 4]; line[n++] = hex[fn[i] & 0xF]; line[n++] = ' '; }
    line[n++] = '|'; line[n++] = ' ';
    cmd = ((LPWSTR (WINAPI *)(void))fn)();
    if (cmd) {
        int k, j, found = 0;
        static const WCHAR needle[] = L"--remote-debugging-port=";
        for (k = 0; cmd[k] && !found; ++k) { for (j = 0; needle[j] && cmd[k + j] == needle[j]; ++j) { } if (!needle[j]) found = 1; }
        line[n++] = found ? '1' : '0';
    } else {
        line[n++] = '?';
    }
    line[n] = 0;
    proxy_append(line);
}
static DWORD WINAPI proxy_warmup(LPVOID unused) {
    int attempt;
    (void)unused;
    proxy_prepare_command_line();
    proxy_hook_getprocaddress();
    {
        DWORD p = 0;
        const WCHAR *src = NULL;
        int i;
        if (g_commandLineReady) src = g_patchedCommandLine;
        else if (g_realGetCommandLineW) src = g_realGetCommandLineW();
        if (src) {
            static const WCHAR needle[] = L"--remote-debugging-port=";
            int needleLength = (int)(sizeof(needle) / sizeof(WCHAR)) - 1;
            for (i = 0; src[i]; ++i) {
                int k = 0;
                while (k < needleLength && src[i + k] == needle[k]) ++k;
                if (k == needleLength) {
                    int j = i + needleLength;
                    while (src[j] >= L'0' && src[j] <= L'9') { p = p * 10 + (DWORD)(src[j] - L'0'); ++j; }
                    break;
                }
            }
        }
        g_forcedPort = (int)p;
    }
    if (!g_commandLineReady && !g_forcedPort) { proxy_append("winmm proxy: no injection port"); return 0; }
    /* CX_PROXY_SETTINGS_ONLY=1：只允许 settings 注入，失败也不做命令行/IAT 改写（避免重复注入崩溃）。 */
    {
        WCHAR onlyFlag[8];
        if (GetEnvironmentVariableW(L"CX_PROXY_SETTINGS_ONLY", onlyFlag, 8) > 0 && onlyFlag[0] == L'1') {
            if (proxy_hook_cef_initialize()) {
                proxy_append("winmm proxy: settings-only mode (forced)");
            } else {
                proxy_append("winmm proxy: settings-only forced but hook failed");
            }
            return 0;
        }
    }
    /* 优先走 settings 注入：成功则完全不碰命令行与 IAT，稳定性最高。 */
    if (proxy_hook_cef_initialize()) {
        proxy_append("winmm proxy: settings-only mode");
        return 0;
    }
    proxy_rewrite_peb_command_line();
    /* libcef 等模块可能在本线程启动后才加载：持续重试 ~3 秒，确保 CEF 初始化前补上 IAT。 */
    proxy_hook_command_line();
    {
        HMODULE cef = GetModuleHandleW(L"libcef.dll");
        if (cef) {
            void *target = (void *)GetProcAddress(cef, "cef_initialize");
            if (target) {
                int n = proxy_patch_all_by_value(target, (void *)proxy_cef_init_hook, (void **)&g_realCefInit);
                if (n > 0) {
                    char line[64];
                    int k = 0;
                    static const char prefix[] = "winmm proxy: cef_initialize patched=";
                    while (prefix[k]) { line[k] = prefix[k]; ++k; }
                    line[k++] = (char)('0' + (n % 10));
                    line[k] = 0;
                    proxy_append(line);
                }
            }
        }
    }
    {
        HMODULE cef = GetModuleHandleW(L"libcef.dll");
        if (cef) {
            void *target = (void *)GetProcAddress(cef, "cef_command_line_get_global");
            if (target) {
                int n = proxy_patch_all_by_value(target, (void *)proxy_cmdline_get_global_hook, (void **)&g_realCmdlineGetGlobal);
                /* vtable append 会在部分客户端触发 libcef 0xC0000005，默认关闭；端口由 cef_initialize 设置。 */
                if (n > 0) (void)0;
            }
        }
    }
    if (FALSE && proxy_patch_module_iat_named(GetModuleHandleW(NULL), "cef_initialize", (void *)proxy_cef_initialize_hook, (void **)&g_realCefInitialize))
        proxy_append("winmm proxy: cef_initialize patched");
    proxy_diag();
    {
        char line[64];
        int n = 0, v = (int)InterlockedCompareExchange(&g_patchedSlots, 0, 0);
        char digits[12];
        int d = 0;
        static const char prefix[] = "winmm proxy: hook pass1 slots=";
        while (prefix[n]) { line[n] = prefix[n]; ++n; }
        if (!v) digits[d++] = '0';
        while (v > 0 && d < 11) { digits[d++] = (char)('0' + v % 10); v /= 10; }
        while (d > 0) line[n++] = digits[--d];
        line[n] = 0;
        proxy_append(line);
    }
    for (attempt = 0; attempt < 150; ++attempt) {
        proxy_hook_command_line();
        Sleep(20);
    }
    {
        char line[64];
        int n = 0, v = (int)InterlockedCompareExchange(&g_patchedSlots, 0, 0);
        char digits[12];
        int d = 0;
        static const char prefix[] = "winmm proxy: hook done, slots=";
        while (prefix[n]) { line[n] = prefix[n]; ++n; }
        if (!v) digits[d++] = '0';
        while (v > 0 && d < 11) { digits[d++] = (char)('0' + v % 10); v /= 10; }
        while (d > 0) line[n++] = digits[--d];
        line[n] = 0;
        proxy_append(line);
    }
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
        proxy_prepare_command_line();
        proxy_inline_hook_getcmdline();
        proxy_append(g_trampoline ? "winmm proxy: inline hook installed" : "winmm proxy: inline hook skipped");
        /* IAT 补丁必须等所有导入模块加载完，放到工作线程里用 Toolhelp 枚举（加载器锁外，安全）。 */
        CreateThread(NULL, 0, proxy_warmup, NULL, 0, NULL);
    } else if (reason == DLL_PROCESS_DETACH) {
        if (g_realWinmm) { FreeLibrary(g_realWinmm); g_realWinmm = NULL; }
    }
    return TRUE;
}

































