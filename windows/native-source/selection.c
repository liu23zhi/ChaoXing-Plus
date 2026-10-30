#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commdlg.h>
#include "selection.h"

#define SELECTION_LIST 1001
#define SELECTION_BROWSE 1002
#define SELECTION_TIMER 1003
#define SELECTION_SCAN_ALL 1004
#define SELECTION_INJECT 1005
#define SELECTION_CARRIER 1006

static const WCHAR selectionClass[] = L"CXPlusNativeClientSelection";
static const WCHAR selectionTitle[] = L"超星学习助手 - 选择考试客户端";
static const WCHAR selectionHeadingDefault[] = L"请选择考试客户端；全盘扫描后将重新打开并刷新列表，也可手动浏览。";

typedef struct SELECTION_WINDOW {
    const CX_DISCOVERY_RESULT *candidates;
    BOOL hostIs32Bit;
    WCHAR *out;
    DWORD outCap;
    WCHAR *error;
    DWORD errorCap;
    HWND window, heading, columns, list, browse, scanAll, choose, cancel, injectLabel, injectCombo, carrierLabel, carrierCombo;
    const WCHAR *notice;
    HFONT font;
    BOOL finished;
    CX_SELECTION_STATUS result;
    WCHAR injectMode[16];
    WCHAR proxyCarrier[16];
    DWORD injectDisabledMask;
    DWORD carrierDisabledMask;
    int lastInjectIndex;
    int lastCarrierIndex;
} SELECTION_WINDOW;

static WCHAR selection_last_inject_mode[16] = L"auto";
static WCHAR selection_last_carrier[16] = L"auto";
const WCHAR *cx_selection_proxy_carrier(void) { return selection_last_carrier; }
const WCHAR *cx_selection_inject_mode(void) { return selection_last_inject_mode; }

static void selection_error(SELECTION_WINDOW *state, const WCHAR *message) {
    if (state->error && state->errorCap) lstrcpynW(state->error, message, (int)state->errorCap);
}

static BOOL selection_copy(WCHAR *out, DWORD cap, const WCHAR *text) {
    DWORD length = (DWORD)lstrlenW(text);
    if (!out || length >= cap) return FALSE;
    CopyMemory(out, text, (length + 1) * sizeof(WCHAR));
    return TRUE;
}

static WCHAR *selection_append(WCHAR *out, const WCHAR *text) {
    while (*text) *out++ = *text++;
    return out;
}

static WCHAR *selection_number(WCHAR *out, DWORD value) {
    WCHAR digits[16]; DWORD count = 0;
    do { digits[count++] = (WCHAR)(L'0' + value % 10); value /= 10; } while (value);
    while (count) *out++ = digits[--count];
    return out;
}

/* Native selection/progress windows are DPI aware (host.manifest). Fixed
   pixel metrics are scaled from 96 DPI so text and controls stay crisp and
   correctly sized on high-DPI displays. CXPLUS_NATIVE_UI_DPI is a test-only
   override so layout scaling can be exercised on any machine. */
static DWORD selection_system_dpi;

static DWORD selection_ui_dpi(void) {
    WCHAR text[16];
    DWORD length, value = 0, i;
    length = GetEnvironmentVariableW(L"CXPLUS_NATIVE_UI_DPI", text, 16);
    if (length && length < 16) {
        for (i = 0; i < length; ++i) {
            if (text[i] < L'0' || text[i] > L'9') { value = 0; break; }
            value = value * 10 + (DWORD)(text[i] - L'0');
            if (value > 480) { value = 0; break; }
        }
        if (value >= 96) return value;
    }
    if (selection_system_dpi) return selection_system_dpi;
    {
        HMODULE user32 = GetModuleHandleW(L"user32.dll");
        typedef UINT (WINAPI *DPI_FOR_SYSTEM)(void);
        DPI_FOR_SYSTEM getForSystem = user32 ? (DPI_FOR_SYSTEM)GetProcAddress(user32, "GetDpiForSystem") : NULL;
        HDC screen;
        if (getForSystem) selection_system_dpi = getForSystem();
        if (!selection_system_dpi) {
            screen = GetDC(NULL);
            if (screen) { selection_system_dpi = (DWORD)GetDeviceCaps(screen, LOGPIXELSX); ReleaseDC(NULL, screen); }
        }
        if (!selection_system_dpi) selection_system_dpi = 96;
    }
    return selection_system_dpi;
}

static int selection_scale(int value) {
    return (int)MulDiv(value, (int)selection_ui_dpi(), 96);
}

static BOOL selection_fill(SELECTION_WINDOW *state) {
    DWORD index, count = state->candidates ? state->candidates->count : 0;
    LONG tabs[3] = { 24, 62, 152 };
    LONG extent = 0;
    SendMessageW(state->list, LB_SETTABSTOPS, 3, (LPARAM)tabs);
    for (index = 0; index < count; ++index) {
        const CX_CLIENT_CANDIDATE *item = state->candidates->items + index;
        DWORD pathLength = item->path ? (DWORD)lstrlenW(item->path) : 0;
        DWORD length = pathLength + (DWORD)lstrlenW(item->version) + 64;
        WCHAR *row = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, length * sizeof(WCHAR));
        WCHAR *at;
        LRESULT added;
        LONG rowExtent;
        if (!row) { selection_error(state, L"无法分配客户端列表内存。"); return FALSE; }
        at = selection_number(row, index + 1); *at++ = L'\t';
        at = selection_append(at, item->machine == CX_DISCOVERY_MACHINE_X86 ? L"x86" : L"x64");
        *at++ = L'\t'; at = selection_append(at, item->version[0] ? item->version : L"未知");
        *at++ = L'\t'; at = selection_append(at, item->path ? item->path : L"");
        if (index == state->candidates->recommendedIndex) at = selection_append(at, L"  [推荐]");
        *at = 0;
        added = SendMessageW(state->list, LB_ADDSTRING, 0, (LPARAM)row);
        HeapFree(GetProcessHeap(), 0, row);
        if (added == LB_ERR || added == LB_ERRSPACE) { selection_error(state, L"无法创建客户端列表。"); return FALSE; }
        rowExtent = (LONG)(pathLength * 16 + 400);
        if (rowExtent > extent) extent = rowExtent;
    }
    SendMessageW(state->list, LB_SETHORIZONTALEXTENT, (WPARAM)extent, 0);
    if (count) SendMessageW(state->list, LB_SETCURSEL,
        state->candidates->recommendedIndex < count ? state->candidates->recommendedIndex : 0, 0);
    EnableWindow(state->choose, count != 0);
    return TRUE;
}


/* ---- 客户端能力探测：决定 GUI 里哪些注入方式可选 ---- */
static const WCHAR *const selection_carrier_names[7] = {
    L"winmm", L"version", L"uxtheme", L"msimg32", L"sensapi", L"oledlg", L"wtsapi32"
};

typedef struct SELECTION_CAPS {
    BOOL portOk;        /* 是否支持命令行开关（未加壳） */
    DWORD carrierMask;  /* 位 0..6 对应 selection_carrier_names */
} SELECTION_CAPS;

static BOOL selection_pe_section(const WCHAR *path, const char *sectionName) {
    HANDLE file;
    IMAGE_DOS_HEADER dos;
    IMAGE_NT_HEADERS nt;
    DWORD read = 0, i;
    BOOL found = FALSE;
    if (!path || !sectionName) return FALSE;
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    if (ReadFile(file, &dos, sizeof(dos), &read, NULL) && read == sizeof(dos) && dos.e_magic == IMAGE_DOS_SIGNATURE &&
        SetFilePointer(file, dos.e_lfanew, NULL, FILE_BEGIN) != INVALID_SET_FILE_POINTER &&
        ReadFile(file, &nt, sizeof(nt), &read, NULL) && read == sizeof(nt) && nt.Signature == IMAGE_NT_SIGNATURE) {
        IMAGE_SECTION_HEADER section;
        for (i = 0; i < nt.FileHeader.NumberOfSections; ++i) {
            int k = 0, same = 1;
            if (!ReadFile(file, &section, sizeof(section), &read, NULL) || read != sizeof(section)) break;
            while (k < 8) {
                char a = (char)section.Name[k];
                char b = sectionName[k];
                if (a != b) { same = 0; break; }
                if (!b) break;
                ++k;
            }
            if (same) { found = TRUE; break; }
        }
    }
    CloseHandle(file);
    return found;
}

static BOOL selection_pe_imports(const WCHAR *path, const WCHAR *dllName) {
    HANDLE file;
    IMAGE_DOS_HEADER dos;
    IMAGE_NT_HEADERS nt;
    DWORD read = 0;
    BOOL found = FALSE;
    char target[64];
    int targetLength = 0, i;
    if (!path || !dllName) return FALSE;
    for (i = 0; dllName[i] && i < 63; ++i) target[targetLength++] = (char)dllName[i];
    target[targetLength] = 0;
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    if (ReadFile(file, &dos, sizeof(dos), &read, NULL) && read == sizeof(dos) && dos.e_magic == IMAGE_DOS_SIGNATURE &&
        SetFilePointer(file, dos.e_lfanew, NULL, FILE_BEGIN) != INVALID_SET_FILE_POINTER &&
        ReadFile(file, &nt, sizeof(nt), &read, NULL) && read == sizeof(nt) && nt.Signature == IMAGE_NT_SIGNATURE) {
        DWORD importRva = nt.OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress;
        if (importRva) {
            IMAGE_SECTION_HEADER section;
            DWORD count = nt.FileHeader.NumberOfSections, index;
            SetFilePointer(file, dos.e_lfanew + sizeof(DWORD) + sizeof(IMAGE_FILE_HEADER) + nt.FileHeader.SizeOfOptionalHeader, NULL, FILE_BEGIN);
            for (index = 0; index < count; ++index) {
                DWORD span, offset;
                if (!ReadFile(file, &section, sizeof(section), &read, NULL) || read != sizeof(section)) break;
                span = section.Misc.VirtualSize ? section.Misc.VirtualSize : section.SizeOfRawData;
                if (importRva < section.VirtualAddress || importRva >= section.VirtualAddress + span) continue;
                offset = section.PointerToRawData + (importRva - section.VirtualAddress);
                for (;;) {
                    IMAGE_IMPORT_DESCRIPTOR descriptor;
                    if (SetFilePointer(file, offset, NULL, FILE_BEGIN) == INVALID_SET_FILE_POINTER) break;
                    if (!ReadFile(file, &descriptor, sizeof(descriptor), &read, NULL) || read != sizeof(descriptor) || !descriptor.Name) break;
                    {
                        char moduleName[64];
                        DWORD got = 0, pos = section.PointerToRawData + (descriptor.Name - section.VirtualAddress);
                        if (SetFilePointer(file, pos, NULL, FILE_BEGIN) != INVALID_SET_FILE_POINTER &&
                            ReadFile(file, moduleName, 63, &got, NULL) && got) {
                            int k = 0, same = 1;
                            moduleName[got] = 0;
                            while (moduleName[k] || target[k]) {
                                char a = moduleName[k];
                                if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
                                if (a != target[k]) { same = 0; break; }
                                ++k;
                            }
                            if (same) { found = TRUE; break; }
                        }
                    }
                    offset += sizeof(descriptor);
                }
                break;
            }
        }
    }
    CloseHandle(file);
    return found;
}

static SELECTION_CAPS selection_client_caps(const WCHAR *path) {
    SELECTION_CAPS caps;
    int i;
    caps.portOk = path && *path ? !selection_pe_section(path, ".themida") : TRUE;
    caps.carrierMask = 0;
    for (i = 0; i < 7; ++i) {
        WCHAR dll[32];
        int k = 0;
        while (selection_carrier_names[i][k] && k < 24) { dll[k] = selection_carrier_names[i][k]; ++k; }
        dll[k++] = L'.'; dll[k++] = L'd'; dll[k++] = L'l'; dll[k++] = L'l'; dll[k] = 0;
        if (selection_pe_imports(path, dll)) caps.carrierMask |= (1u << i);
    }
    return caps;
}
static void selection_layout(SELECTION_WINDOW *state) {
    RECT rect;
    int width, height;
    GetClientRect(state->window, &rect); width = rect.right; height = rect.bottom;
    int margin = selection_scale(18), gap = selection_scale(20), top = selection_scale(16);
    int headingHeight = selection_scale(26), columnsTop = selection_scale(52), columnsHeight = selection_scale(22);
    int listTop = selection_scale(78), bottomOffset = selection_scale(200), buttonTop = height - selection_scale(52);
    int buttonHeight = selection_scale(32), buttonWidth = selection_scale(138), chooseWidth = selection_scale(102);
    MoveWindow(state->heading, margin, top, width - selection_scale(36), headingHeight, TRUE);
    MoveWindow(state->columns, gap, columnsTop, width - selection_scale(40), columnsHeight, TRUE);
    MoveWindow(state->list, margin, listTop, width - selection_scale(36), height - bottomOffset, TRUE);
    {
        int injectTop = buttonTop - selection_scale(44);
        MoveWindow(state->injectLabel, margin, injectTop + selection_scale(6), selection_scale(96), selection_scale(24), TRUE);
        MoveWindow(state->injectCombo, margin + selection_scale(110), injectTop, selection_scale(210), selection_scale(200), TRUE);
        SendMessageW(state->injectCombo, CB_SETDROPPEDWIDTH, (WPARAM)selection_scale(300), 0);
        MoveWindow(state->carrierLabel, margin + selection_scale(340), injectTop + selection_scale(6), selection_scale(96), selection_scale(24), TRUE);
        MoveWindow(state->carrierCombo, margin + selection_scale(440), injectTop, selection_scale(210), selection_scale(200), TRUE);
        SendMessageW(state->carrierCombo, CB_SETDROPPEDWIDTH, (WPARAM)selection_scale(300), 0);
    }
    MoveWindow(state->browse, margin, buttonTop, buttonWidth, buttonHeight, TRUE);
    MoveWindow(state->scanAll, selection_scale(168), buttonTop, buttonWidth, buttonHeight, TRUE);
    MoveWindow(state->choose, width - selection_scale(238), buttonTop, chooseWidth, buttonHeight, TRUE);
    MoveWindow(state->cancel, width - selection_scale(120), buttonTop, chooseWidth, buttonHeight, TRUE);
}

static HWND selection_control(SELECTION_WINDOW *state, DWORD style, const WCHAR *kind,
                               const WCHAR *title, int id) {
    HWND control = CreateWindowExW(0, kind, title, WS_CHILD | WS_VISIBLE | style,
        0, 0, 0, 0, state->window, (HMENU)(INT_PTR)id, GetModuleHandleW(NULL), NULL);
    if (control && state->font) SendMessageW(control, WM_SETFONT, (WPARAM)state->font, FALSE);
    return control;
}

/* 依据当前选中的客户端刷新两个下拉框的可选状态（0 位表示"自动"，永远可用）。 */
static void selection_apply_caps(SELECTION_WINDOW *state) {
    LRESULT index = SendMessageW(state->list, LB_GETCURSEL, 0, 0);
    SELECTION_CAPS caps;
    if (index == LB_ERR || !state->candidates || (DWORD)index >= state->candidates->count) return;
    caps = selection_client_caps(state->candidates->items[index].path);
    state->injectDisabledMask = 0;
    if (!caps.portOk) state->injectDisabledMask |= 0x2u;           /* cdp-port */
    if (caps.carrierMask == 0) state->injectDisabledMask |= 0x4u;  /* dll-proxy */
    state->carrierDisabledMask = 0x1u;                             /* bit0 = auto 永远可用 */
    {
        int ci;
        for (ci = 0; ci < 7; ++ci) {
            if (!(caps.carrierMask & (1u << ci))) state->carrierDisabledMask |= (1u << (ci + 1));
        }
    }
    /* 当前选择若被禁用，回退到自动 */
    {
        LRESULT inj = SendMessageW(state->injectCombo, CB_GETCURSEL, 0, 0);
        if (inj > 0 && (state->injectDisabledMask & (1u << inj))) {
            SendMessageW(state->injectCombo, CB_SETCURSEL, 0, 0);
            lstrcpynW(state->injectMode, L"auto", 16);
            inj = 0;
        }
        state->lastInjectIndex = (int)(inj >= 0 ? inj : 0);
        {
            LRESULT car = SendMessageW(state->carrierCombo, CB_GETCURSEL, 0, 0);
            if (car >= 0 && (state->carrierDisabledMask & (1u << car))) {
                SendMessageW(state->carrierCombo, CB_SETCURSEL, 0, 0);
                lstrcpynW(state->proxyCarrier, L"auto", 16);
                car = 0;
            }
            state->lastCarrierIndex = (int)(car >= 0 ? car : 0);
        }
    }
    {
        static const WCHAR *const injectLabels[3] = { L"自动（推荐）", L"端口命令行（cdp-port）", L"DLL 代理（dll-proxy）" };
        static const WCHAR *const carrierLabels[8] = { L"自动（按导入表）", L"winmm.dll", L"version.dll", L"uxtheme.dll",
                                                       L"msimg32.dll", L"sensapi.dll", L"oledlg.dll", L"wtsapi32.dll" };
        int i;
        for (i = 0; i < 3; ++i) {
            WCHAR text[96];
            BOOL disabled = (state->injectDisabledMask & (1u << i)) != 0;
            if (i == 0) lstrcpynW(text, injectLabels[i], 96);
            else wsprintfW(text, disabled ? L"%s（不可用）" : L"%s", injectLabels[i]);
            SendMessageW(state->injectCombo, CB_DELETESTRING, (WPARAM)i, 0);
            SendMessageW(state->injectCombo, CB_INSERTSTRING, (WPARAM)i, (LPARAM)text);
        }
        SendMessageW(state->injectCombo, CB_SETCURSEL, (WPARAM)state->lastInjectIndex, 0);
        for (i = 0; i < 8; ++i) {
            WCHAR text[96];
            BOOL disabled = (state->carrierDisabledMask & (1u << i)) != 0;
            if (i == 0) lstrcpynW(text, carrierLabels[i], 96);
            else wsprintfW(text, disabled ? L"%s（不可用）" : L"%s", carrierLabels[i]);
            SendMessageW(state->carrierCombo, CB_DELETESTRING, (WPARAM)i, 0);
            SendMessageW(state->carrierCombo, CB_INSERTSTRING, (WPARAM)i, (LPARAM)text);
        }
        SendMessageW(state->carrierCombo, CB_SETCURSEL, (WPARAM)state->lastCarrierIndex, 0);
    }
    EnableWindow(state->carrierCombo, !(state->injectDisabledMask & 0x2u) || (state->injectDisabledMask & 0x4u) == 0);
    InvalidateRect(state->injectCombo, NULL, TRUE);
    InvalidateRect(state->carrierCombo, NULL, TRUE);
}
static BOOL selection_accept(SELECTION_WINDOW *state, const WCHAR *path) {
    CX_DISCOVERY_RESULT checked;
    DWORD attributes;
    BOOL valid;
    cx_discovery_init(&checked);
    attributes = path ? GetFileAttributesW(path) : INVALID_FILE_ATTRIBUTES;
    valid = attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY)
        && cx_discovery_resolve_client(path, state->hostIs32Bit, &checked, state->error, state->errorCap)
        && checked.count == 1;
    if (valid && !selection_copy(state->out, state->outCap, checked.items[0].path)) {
        selection_error(state, L"客户端路径超出输出缓冲区长度。"); valid = FALSE;
    }
    cx_discovery_free(&checked);
    if (!valid) {
        if (!state->error || !state->errorCap || !state->error[0]) selection_error(state, L"请选择有效且架构兼容的 CXExam.exe 文件。");
        MessageBoxW(state->window, state->error && state->errorCap && state->error[0] ? state->error : L"无法使用该客户端。",
            selectionTitle, MB_OK | MB_ICONERROR);
        return FALSE;
    }
    lstrcpynW(selection_last_inject_mode, state->injectMode[0] ? state->injectMode : L"auto", 16);
    lstrcpynW(selection_last_carrier, state->proxyCarrier[0] ? state->proxyCarrier : L"auto", 16);
    state->result = CX_SELECTION_SELECTED;
    if (state->error && state->errorCap) state->error[0] = 0;
    DestroyWindow(state->window);
    return TRUE;
}

static void selection_browse(SELECTION_WINDOW *state) {
    OPENFILENAMEW dialog;
    WCHAR *path = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_DISCOVERY_MAX_PATH * sizeof(WCHAR));
    if (!path) { selection_error(state, L"无法分配文件选择缓冲区。"); return; }
    ZeroMemory(&dialog, sizeof(dialog));
    dialog.lStructSize = sizeof(dialog); dialog.hwndOwner = state->window;
    dialog.lpstrFilter = L"考试客户端 (CXExam.exe)\0CXExam.exe\0可执行文件 (*.exe)\0*.exe\0\0";
    dialog.lpstrFile = path; dialog.nMaxFile = CX_DISCOVERY_MAX_PATH;
    dialog.lpstrTitle = L"选择 CXExam.exe";
    dialog.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_EXPLORER | OFN_HIDEREADONLY;
    if (GetOpenFileNameW(&dialog)) selection_accept(state, path);
    else if (CommDlgExtendedError()) {
        selection_error(state, L"系统文件选择窗口无法打开。");
        MessageBoxW(state->window, state->error && state->errorCap && state->error[0] ? state->error : L"系统文件选择窗口无法打开。",
            selectionTitle, MB_OK | MB_ICONERROR);
    }
    HeapFree(GetProcessHeap(), 0, path);
}

static LRESULT CALLBACK selection_proc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    SELECTION_WINDOW *state = (SELECTION_WINDOW *)GetWindowLongPtrW(window, GWLP_USERDATA);
    if (message == WM_NCCREATE) {
        state = (SELECTION_WINDOW *)((CREATESTRUCTW *)lParam)->lpCreateParams;
        state->window = window;
        SetWindowLongPtrW(window, GWLP_USERDATA, (LONG_PTR)state);
    }
    if (!state) return DefWindowProcW(window, message, wParam, lParam);
    if (message == WM_CREATE) {
        state->heading = selection_control(state, 0, L"STATIC",
            state->notice && state->notice[0] ? state->notice : selectionHeadingDefault, 0);
        state->columns = selection_control(state, 0, L"STATIC", L"序号 / 架构 / 文件版本 / 完整路径", 0);
        state->list = selection_control(state, WS_TABSTOP | WS_BORDER | WS_VSCROLL | WS_HSCROLL
            | LBS_NOTIFY | LBS_NOINTEGRALHEIGHT | LBS_USETABSTOPS, L"LISTBOX", L"", SELECTION_LIST);
        state->browse = selection_control(state, WS_TABSTOP | BS_PUSHBUTTON, L"BUTTON", L"手动浏览…", SELECTION_BROWSE);
        state->scanAll = selection_control(state, WS_TABSTOP | BS_PUSHBUTTON, L"BUTTON", L"全盘扫描…", SELECTION_SCAN_ALL);
        state->choose = selection_control(state, WS_TABSTOP | BS_DEFPUSHBUTTON, L"BUTTON", L"选择并启动", IDOK);
        state->cancel = selection_control(state, WS_TABSTOP | BS_PUSHBUTTON, L"BUTTON", L"取消", IDCANCEL);
        if (!state->heading || !state->columns || !state->list || !state->browse || !state->scanAll || !state->choose || !state->cancel
            || !selection_fill(state)) { selection_error(state, L"无法创建原生客户端选择控件。"); return -1; }
        state->injectLabel = selection_control(state, SS_LEFT, L"STATIC", L"注入方式：", -1);
        state->injectCombo = selection_control(state, CBS_DROPDOWNLIST | CBS_OWNERDRAWFIXED | CBS_HASSTRINGS | WS_VSCROLL, L"COMBOBOX", L"", SELECTION_INJECT);
        if (state->injectLabel && state->injectCombo) {
            SendMessageW(state->injectCombo, CB_ADDSTRING, 0, (LPARAM)L"自动（推荐）");
            SendMessageW(state->injectCombo, CB_ADDSTRING, 0, (LPARAM)L"端口命令行（cdp-port）");
            SendMessageW(state->injectCombo, CB_ADDSTRING, 0, (LPARAM)L"DLL 代理（dll-proxy）");
            SendMessageW(state->injectCombo, CB_SETCURSEL, 0, 0);
            lstrcpynW(state->injectMode, L"auto", 16);
        } else { selection_error(state, L"无法创建注入方式选择控件。"); return -1; }
        state->carrierLabel = selection_control(state, SS_LEFT, L"STATIC", L"代理载体：", -1);
        state->carrierCombo = selection_control(state, CBS_DROPDOWNLIST | CBS_OWNERDRAWFIXED | CBS_HASSTRINGS | WS_VSCROLL, L"COMBOBOX", L"", SELECTION_CARRIER);
        if (state->carrierLabel && state->carrierCombo) {
            static const WCHAR *const carriers[] = { L"自动（按导入表）", L"winmm.dll", L"version.dll", L"uxtheme.dll",
                                                     L"msimg32.dll", L"sensapi.dll", L"oledlg.dll", L"wtsapi32.dll" };
            int ci;
            for (ci = 0; ci < 8; ++ci) SendMessageW(state->carrierCombo, CB_ADDSTRING, 0, (LPARAM)carriers[ci]);
            SendMessageW(state->carrierCombo, CB_SETCURSEL, 0, 0);
            lstrcpynW(state->proxyCarrier, L"auto", 16);
            EnableWindow(state->carrierCombo, FALSE);
        } else { selection_error(state, L"无法创建代理载体选择控件。"); return -1; }
        selection_apply_caps(state);
        selection_layout(state); return 0;
    }
    if (message == WM_SIZE) { selection_layout(state); return 0; }
    if (message == WM_GETMINMAXINFO) {
        MINMAXINFO *info = (MINMAXINFO *)lParam;
        info->ptMinTrackSize.x = selection_scale(640); info->ptMinTrackSize.y = selection_scale(420); return 0;
    }
    if (message == WM_MEASUREITEM) {
        MEASUREITEMSTRUCT *measure = (MEASUREITEMSTRUCT *)lParam;
        if (measure && (measure->CtlID == SELECTION_INJECT || measure->CtlID == SELECTION_CARRIER)) {
            measure->itemHeight = (UINT)selection_scale(22);
            return TRUE;
        }
    }
    if (message == WM_DRAWITEM) {
        DRAWITEMSTRUCT *drawItem = (DRAWITEMSTRUCT *)lParam;
        if (drawItem && (drawItem->CtlID == SELECTION_INJECT || drawItem->CtlID == SELECTION_CARRIER)) {
            WCHAR text[64];
            DWORD mask = drawItem->CtlID == SELECTION_INJECT ? state->injectDisabledMask : state->carrierDisabledMask;
            BOOL disabled = drawItem->itemID != (UINT)-1 && (mask & (1u << drawItem->itemID)) != 0;
            text[0] = 0;
            if (drawItem->itemID != (UINT)-1) SendMessageW(drawItem->hwndItem, CB_GETLBTEXT, drawItem->itemID, (LPARAM)text);
            FillRect(drawItem->hDC, &drawItem->rcItem, (HBRUSH)(COLOR_WINDOW + 1));
            if ((drawItem->itemState & ODS_SELECTED) && !disabled) FillRect(drawItem->hDC, &drawItem->rcItem, (HBRUSH)(COLOR_HIGHLIGHT + 1));
            SetBkMode(drawItem->hDC, TRANSPARENT);
            SetTextColor(drawItem->hDC, disabled ? GetSysColor(COLOR_GRAYTEXT)
                : ((drawItem->itemState & ODS_SELECTED) ? GetSysColor(COLOR_HIGHLIGHTTEXT) : GetSysColor(COLOR_WINDOWTEXT)));
            if (state->font) SelectObject(drawItem->hDC, state->font);
            {
                RECT textRect = drawItem->rcItem;
                textRect.left += selection_scale(6);
                DrawTextW(drawItem->hDC, text, -1, &textRect, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
            }
            if (drawItem->itemState & ODS_FOCUS) DrawFocusRect(drawItem->hDC, &drawItem->rcItem);
            return TRUE;
        }
    }
    if (message == WM_COMMAND) {
        int command = LOWORD(wParam);
        if (command == IDCANCEL) { DestroyWindow(window); return 0; }
        if (command == SELECTION_BROWSE) { selection_browse(state); return 0; }
        if (command == SELECTION_INJECT && HIWORD(wParam) == CBN_SELCHANGE) {
            LRESULT pick = SendMessageW(state->injectCombo, CB_GETCURSEL, 0, 0);
            if (pick > 0 && (state->injectDisabledMask & (1u << pick))) {
                MessageBeep(MB_ICONWARNING);
                SendMessageW(state->injectCombo, CB_SETCURSEL, (WPARAM)state->lastInjectIndex, 0);
                return 0;
            }
            state->lastInjectIndex = (int)(pick >= 0 ? pick : 0);
            lstrcpynW(state->injectMode, pick == 1 ? L"cdp-port" : (pick == 2 ? L"dll-proxy" : L"auto"), 16);
            EnableWindow(state->carrierCombo, pick != 1); /* cdp-port 时载体无意义 */
            return 0;
        }
        if (command == SELECTION_CARRIER && HIWORD(wParam) == CBN_SELCHANGE) {
            static const WCHAR *const names[] = { L"auto", L"winmm", L"version", L"uxtheme", L"msimg32", L"sensapi", L"oledlg", L"wtsapi32" };
            LRESULT pick = SendMessageW(state->carrierCombo, CB_GETCURSEL, 0, 0);
            if (pick < 0 || pick > 7) pick = 0;
            if (state->carrierDisabledMask & (1u << pick)) {
                MessageBeep(MB_ICONWARNING);
                SendMessageW(state->carrierCombo, CB_SETCURSEL, (WPARAM)state->lastCarrierIndex, 0);
                return 0;
            }
            state->lastCarrierIndex = (int)pick;
            lstrcpynW(state->proxyCarrier, names[pick], 16);
            return 0;
        }
        if (command == SELECTION_LIST && HIWORD(wParam) == LBN_SELCHANGE) { selection_apply_caps(state); return 0; }
        if (command == SELECTION_SCAN_ALL) {
            state->result = CX_SELECTION_SCAN_ALL; DestroyWindow(window); return 0;
        }
        if (command == IDOK || (command == SELECTION_LIST && HIWORD(wParam) == LBN_DBLCLK)) {
            LRESULT index = SendMessageW(state->list, LB_GETCURSEL, 0, 0);
            if (index != LB_ERR && state->candidates && (DWORD)index < state->candidates->count)
                selection_accept(state, state->candidates->items[index].path);
            return 0;
        }
    }
    if (message == WM_TIMER && wParam == SELECTION_TIMER) { DestroyWindow(window); return 0; }
    if (message == WM_CLOSE) { DestroyWindow(window); return 0; }
    if (message == WM_DESTROY) { KillTimer(window, SELECTION_TIMER); state->finished = TRUE; return 0; }
    return DefWindowProcW(window, message, wParam, lParam);
}

static BOOL selection_create(SELECTION_WINDOW *state) {
    WNDCLASSEXW windowClass;
    RECT work;
    int width = selection_scale(960), height = selection_scale(510);
    ZeroMemory(&windowClass, sizeof(windowClass));
    windowClass.cbSize = sizeof(windowClass); windowClass.lpfnWndProc = selection_proc;
    windowClass.hInstance = GetModuleHandleW(NULL); windowClass.hCursor = LoadCursorW(NULL, IDC_ARROW);
    windowClass.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1); windowClass.lpszClassName = selectionClass;
    if (!RegisterClassExW(&windowClass) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        selection_error(state, L"无法注册原生客户端选择窗口。"); return FALSE;
    }
    if (!SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0)) {
        work.left = work.top = 0; work.right = GetSystemMetrics(SM_CXSCREEN); work.bottom = GetSystemMetrics(SM_CYSCREEN);
    }
    if (width > work.right - work.left) width = work.right - work.left;
    if (height > work.bottom - work.top) height = work.bottom - work.top;
    state->font = CreateFontW(-selection_scale(16), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
    state->window = CreateWindowExW(WS_EX_CONTROLPARENT, selectionClass, selectionTitle,
        WS_OVERLAPPEDWINDOW & ~WS_MAXIMIZEBOX,
        work.left + (work.right - work.left - width) / 2, work.top + (work.bottom - work.top - height) / 2,
        width, height, NULL, NULL, GetModuleHandleW(NULL), state);
    if (!state->window) { selection_error(state, L"无法创建原生客户端选择窗口。"); return FALSE; }
    state->result = CX_SELECTION_CANCELLED;
    return TRUE;
}

static DWORD selection_auto_close(void) {
    WCHAR text[16]; DWORD length, value = 0, i;
    length = GetEnvironmentVariableW(L"CXPLUS_NATIVE_SELECTION_AUTO_CLOSE_MS", text, 16);
    if (!length || length >= 16) return 0;
    for (i = 0; i < length; ++i) {
        if (text[i] < L'0' || text[i] > L'9' || value > 6000) return 0;
        value = value * 10 + (DWORD)(text[i] - L'0');
    }
    return value >= 50 && value <= 60000 ? value : 0;
}

CX_SELECTION_STATUS cx_select_client(const CX_DISCOVERY_RESULT *candidates,
                                     BOOL hostIs32Bit, const WCHAR *notice,
                                     WCHAR *out, DWORD outCap,
                                     WCHAR *error, DWORD errorCap) {
    SELECTION_WINDOW state;
    MSG message;
    DWORD closeMs;
    int received;
    SYSTEM_INFO system;
    ZeroMemory(&state, sizeof(state));
    if (out && outCap) out[0] = 0;
    if (error && errorCap) error[0] = 0;
    state.error = error; state.errorCap = errorCap;
    if (!out || !outCap || (candidates && ((candidates->count && !candidates->items)
        || candidates->count > CX_DISCOVERY_MAX_CANDIDATES))) {
        selection_error(&state, L"客户端选择参数无效。"); return CX_SELECTION_ERROR;
    }
    state.candidates = candidates; state.hostIs32Bit = hostIs32Bit; state.notice = notice;
    state.out = out; state.outCap = outCap;
    GetNativeSystemInfo(&system);
    if (system.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_INTEL) state.hostIs32Bit = TRUE;
    if (!selection_create(&state)) { if (state.font) DeleteObject(state.font); return CX_SELECTION_ERROR; }
    closeMs = selection_auto_close();
    if (closeMs && !SetTimer(state.window, SELECTION_TIMER, closeMs, NULL)) {
        selection_error(&state, L"无法创建自动关闭测试计时器。");
        DestroyWindow(state.window); if (state.font) DeleteObject(state.font); return CX_SELECTION_ERROR;
    }
    ShowWindow(state.window, SW_SHOWNORMAL); UpdateWindow(state.window);
    SetFocus(IsWindowEnabled(state.list) ? state.list : state.browse);
    while (!state.finished) {
        received = GetMessageW(&message, NULL, 0, 0);
        if (received <= 0) {
            if (received < 0) { selection_error(&state, L"原生客户端选择消息处理失败。"); state.result = CX_SELECTION_ERROR; }
            else PostQuitMessage((int)message.wParam);
            DestroyWindow(state.window); break;
        }
        if (!IsDialogMessageW(state.window, &message)) { TranslateMessage(&message); DispatchMessageW(&message); }
    }
    if (state.font) DeleteObject(state.font);
    if (state.result == CX_SELECTION_CANCELLED && error && errorCap) error[0] = 0;
    return state.result;
}

BOOL cx_selection_probe(const CX_DISCOVERY_RESULT *candidates, BOOL hostIs32Bit,
                         const WCHAR *notice, CX_SELECTION_PROBE *probe,
                         WCHAR *error, DWORD errorCap) {
    SELECTION_WINDOW state;
    WCHAR title[128], heading[512];
    ZeroMemory(&state, sizeof(state)); state.candidates = candidates;
    state.hostIs32Bit = hostIs32Bit; state.notice = notice;
    state.error = error; state.errorCap = errorCap;
    if (error && errorCap) error[0] = 0;
    if (!probe || (candidates && ((candidates->count && !candidates->items)
        || candidates->count > CX_DISCOVERY_MAX_CANDIDATES))) {
        selection_error(&state, L"客户端选择探针参数无效。"); return FALSE;
    }
    ZeroMemory(probe, sizeof(*probe));
    if (!selection_create(&state)) { if (state.font) DeleteObject(state.font); return FALSE; }
    probe->itemCount = (DWORD)SendMessageW(state.list, LB_GETCOUNT, 0, 0);
    probe->selectedIndex = (LONG)SendMessageW(state.list, LB_GETCURSEL, 0, 0);
    probe->browseAvailable = IsWindow(state.browse) && IsWindowEnabled(state.browse);
    probe->scanAllAvailable = IsWindow(state.scanAll) && IsWindowEnabled(state.scanAll);
    probe->unicodeWindow = IsWindowUnicode(state.window);
    GetWindowTextW(state.window, title, 128); probe->titleMatches = lstrcmpW(title, selectionTitle) == 0;
    probe->layoutScale = selection_ui_dpi();
    probe->injectOptionCount = IsWindow(state.injectCombo) ? (DWORD)SendMessageW(state.injectCombo, CB_GETCOUNT, 0, 0) : 0;
    probe->injectSelectedIndex = IsWindow(state.injectCombo) ? (LONG)SendMessageW(state.injectCombo, CB_GETCURSEL, 0, 0) : -1;
    probe->carrierOptionCount = IsWindow(state.carrierCombo) ? (DWORD)SendMessageW(state.carrierCombo, CB_GETCOUNT, 0, 0) : 0;
    probe->carrierSelectedIndex = IsWindow(state.carrierCombo) ? (LONG)SendMessageW(state.carrierCombo, CB_GETCURSEL, 0, 0) : -1;
    {
        RECT comboRect = {0,0,0,0};
        if (IsWindow(state.injectCombo) && GetWindowRect(state.injectCombo, &comboRect)) {
            probe->injectComboWidth = comboRect.right - comboRect.left;
            probe->injectComboHeight = comboRect.bottom - comboRect.top;
        }
    }
    GetWindowTextW(state.heading, heading, 512);
    probe->noticeShown = notice && notice[0]
        ? lstrcmpW(heading, notice) == 0
        : lstrcmpW(heading, selectionHeadingDefault) == 0;
    DestroyWindow(state.window);
    if (state.font) DeleteObject(state.font);
    return TRUE;
}

/* ---- Full disk scan progress window (own thread) ---- */

#define SCAN_PROGRESS_UPDATE (WM_APP + 1)
#define SCAN_PROGRESS_CANCEL_ID 1201
#define SCAN_PROGRESS_DETAIL_ID 1202
#define SCAN_PROGRESS_AUTO_TIMER 1203

struct CX_SCAN_PROGRESS {
    HANDLE thread;
    DWORD threadId;
    HANDLE ready;
    HWND window;
    HWND detailControl;
    HFONT font;
    volatile LONG directories;
    volatile LONG candidates;
    volatile LONG cancelRequested;
    volatile LONG finished;
    volatile LONG visible;
    BOOL hidden;
    DWORD autoCancelMs;
};

static BOOL scan_progress_registered;

static DWORD scan_progress_env_number(const WCHAR *name, DWORD fallback) {
    WCHAR text[32];
    DWORD value = 0, index = 0, length;
    length = GetEnvironmentVariableW(name, text, 32);
    if (!length || length >= 32) return fallback;
    while (index < length && text[index] >= L'0' && text[index] <= L'9') {
        value = value * 10 + (DWORD)(text[index] - L'0');
        if (value > 600000) return fallback;
        ++index;
    }
    if (!index || index != length) return fallback;
    return value;
}

static void scan_progress_detail(WCHAR *out, DWORD cap, DWORD directories, DWORD candidates) {
    WCHAR *at = out;
    if (!out || cap < 64) { if (out && cap) out[0] = 0; return; }
    at = selection_append(at, L"已检查 ");
    at = selection_number(at, directories);
    at = selection_append(at, L" 个目录，发现 ");
    at = selection_number(at, candidates);
    at = selection_append(at, L" 个候选。");
    *at = 0;
}

static LRESULT CALLBACK scan_progress_proc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    CX_SCAN_PROGRESS *state = (CX_SCAN_PROGRESS *)GetWindowLongPtrW(window, GWLP_USERDATA);
    if (message == WM_NCCREATE) {
        CREATESTRUCTW *create = (CREATESTRUCTW *)lParam;
        state = (CX_SCAN_PROGRESS *)create->lpCreateParams;
        SetWindowLongPtrW(window, GWLP_USERDATA, (LONG_PTR)state);
    }
    if (!state) return DefWindowProcW(window, message, wParam, lParam);
    if (message == WM_CREATE) {
        HINSTANCE instance = GetModuleHandleW(NULL);
        HFONT font;
        HWND heading, detail, cancel;
        WCHAR detailText[160];
        font = CreateFontW(-selection_scale(16), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
        if (!font) font = (HFONT)GetStockObject(DEFAULT_GUI_FONT);
        state->font = font;
        heading = CreateWindowExW(0, L"STATIC", L"正在全盘扫描固定磁盘根目录…",
                                  WS_CHILD | WS_VISIBLE, selection_scale(18), selection_scale(16),
                                  selection_scale(420), selection_scale(26), window, NULL, instance, NULL);
        scan_progress_detail(detailText, 160, 0, 0);
        detail = CreateWindowExW(0, L"STATIC", detailText, WS_CHILD | WS_VISIBLE,
                                 selection_scale(18), selection_scale(52), selection_scale(420), selection_scale(40),
                                 window, (HMENU)(INT_PTR)SCAN_PROGRESS_DETAIL_ID, instance, NULL);
        cancel = CreateWindowExW(0, L"BUTTON", L"取消扫描",
                                 WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                                 selection_scale(326), selection_scale(108), selection_scale(116), selection_scale(34),
                                 window, (HMENU)(INT_PTR)SCAN_PROGRESS_CANCEL_ID, instance, NULL);
        if (heading) SendMessageW(heading, WM_SETFONT, (WPARAM)font, TRUE);
        if (detail) SendMessageW(detail, WM_SETFONT, (WPARAM)font, TRUE);
        if (cancel) SendMessageW(cancel, WM_SETFONT, (WPARAM)font, TRUE);
        state->detailControl = detail;
        state->window = window;
        if (state->autoCancelMs) SetTimer(window, SCAN_PROGRESS_AUTO_TIMER, state->autoCancelMs, NULL);
        return 0;
    }
    if (message == SCAN_PROGRESS_UPDATE) {
        WCHAR text[160];
        DWORD directories = (DWORD)InterlockedCompareExchange(&state->directories, 0, 0);
        DWORD candidates = (DWORD)InterlockedCompareExchange(&state->candidates, 0, 0);
        scan_progress_detail(text, 160, directories, candidates);
        if (state->detailControl) SetWindowTextW(state->detailControl, text);
        return 0;
    }
    if (message == WM_COMMAND && LOWORD(wParam) == SCAN_PROGRESS_CANCEL_ID) {
        InterlockedExchange(&state->cancelRequested, 1);
        DestroyWindow(window);
        return 0;
    }
    if (message == WM_TIMER && wParam == SCAN_PROGRESS_AUTO_TIMER) {
        InterlockedExchange(&state->cancelRequested, 1);
        DestroyWindow(window);
        return 0;
    }
    if (message == WM_CLOSE) {
        if (InterlockedCompareExchange(&state->finished, 0, 0) == 0)
            InterlockedExchange(&state->cancelRequested, 1);
        DestroyWindow(window);
        return 0;
    }
    if (message == WM_DESTROY) {
        KillTimer(window, SCAN_PROGRESS_AUTO_TIMER);
        if (state->font) DeleteObject(state->font);
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(window, message, wParam, lParam);
}

static DWORD WINAPI scan_progress_thread(void *parameter) {
    CX_SCAN_PROGRESS *state = (CX_SCAN_PROGRESS *)parameter;
    HINSTANCE instance = GetModuleHandleW(NULL);
    WNDCLASSEXW cls;
    MSG message;
    int width = selection_scale(460), height = selection_scale(170), x, y;
    if (!scan_progress_registered) {
        ZeroMemory(&cls, sizeof(cls));
        cls.cbSize = sizeof(cls);
        cls.lpfnWndProc = scan_progress_proc;
        cls.hInstance = instance;
        cls.hCursor = LoadCursorW(NULL, IDC_ARROW);
        cls.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
        cls.lpszClassName = CX_SCAN_PROGRESS_CLASS;
        if (!RegisterClassExW(&cls)) { SetEvent(state->ready); return 1; }
        scan_progress_registered = TRUE;
    }
    x = (GetSystemMetrics(SM_CXSCREEN) - width) / 2;
    y = (GetSystemMetrics(SM_CYSCREEN) - height) / 2;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    state->window = CreateWindowExW(WS_EX_TOPMOST | WS_EX_DLGMODALFRAME, CX_SCAN_PROGRESS_CLASS,
                                    L"超星学习助手 - 全盘扫描",
                                    WS_POPUP | WS_CAPTION | WS_SYSMENU, x, y, width, height,
                                    NULL, NULL, instance, state);
    if (!state->window) { SetEvent(state->ready); return 1; }
    if (!state->hidden) {
        /* The first ShowWindow in a process may be overridden by
           STARTUPINFO.wShowWindow (for example windowsHide:true under spawn);
           a second call with SW_SHOW makes the progress window truly visible. */
        ShowWindow(state->window, SW_SHOWNORMAL);
        if (!IsWindowVisible(state->window)) ShowWindow(state->window, SW_SHOW);
        UpdateWindow(state->window);
        SetForegroundWindow(state->window);
    }
    InterlockedExchange(&state->visible, IsWindowVisible(state->window) ? 1 : 0);
    SetEvent(state->ready);
    while (GetMessageW(&message, NULL, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    return 0;
}

BOOL cx_scan_progress_begin(CX_SCAN_PROGRESS **progress, WCHAR *error, DWORD errorCap) {
    CX_SCAN_PROGRESS *state;
    DWORD wait;
    if (error && errorCap) error[0] = 0;
    if (!progress) return FALSE;
    *progress = NULL;
    state = (CX_SCAN_PROGRESS *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*state));
    if (!state) {
        if (error && errorCap) lstrcpynW(error, L"内存不足，无法创建全盘扫描进度窗口。", (int)errorCap);
        return FALSE;
    }
    state->ready = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!state->ready) {
        HeapFree(GetProcessHeap(), 0, state);
        if (error && errorCap) lstrcpynW(error, L"无法创建进度窗口同步事件。", (int)errorCap);
        return FALSE;
    }
    state->hidden = scan_progress_env_number(L"CXPLUS_NATIVE_SCAN_PROGRESS_HIDDEN", 0) != 0;
    state->autoCancelMs = scan_progress_env_number(L"CXPLUS_NATIVE_SCAN_PROGRESS_AUTOCANCEL_MS", 0);
    if (state->autoCancelMs < 10) state->autoCancelMs = 0;
    state->thread = CreateThread(NULL, 0, scan_progress_thread, state, 0, &state->threadId);
    if (!state->thread) {
        CloseHandle(state->ready);
        HeapFree(GetProcessHeap(), 0, state);
        if (error && errorCap) lstrcpynW(error, L"无法创建全盘扫描进度窗口线程。", (int)errorCap);
        return FALSE;
    }
    wait = WaitForSingleObject(state->ready, 5000);
    if (wait != WAIT_OBJECT_0 || !state->window) {
        WaitForSingleObject(state->thread, 2000);
        CloseHandle(state->thread);
        CloseHandle(state->ready);
        HeapFree(GetProcessHeap(), 0, state);
        if (error && errorCap) lstrcpynW(error, L"全盘扫描进度窗口创建失败。", (int)errorCap);
        return FALSE;
    }
    *progress = state;
    return TRUE;
}

static void scan_progress_update(void *context, DWORD directories, DWORD candidatesFound) {
    CX_SCAN_PROGRESS *state = (CX_SCAN_PROGRESS *)context;
    if (!state || InterlockedCompareExchange(&state->finished, 0, 0) != 0) return;
    InterlockedExchange(&state->directories, (LONG)directories);
    InterlockedExchange(&state->candidates, (LONG)candidatesFound);
    if (state->window) PostMessageW(state->window, SCAN_PROGRESS_UPDATE, 0, 0);
}

static BOOL scan_progress_cancel(void *context) {
    CX_SCAN_PROGRESS *state = (CX_SCAN_PROGRESS *)context;
    if (!state) return FALSE;
    return InterlockedCompareExchange(&state->cancelRequested, 0, 0) != 0;
}

void cx_scan_progress_bind(CX_DISCOVERY_OPTIONS *scan, CX_SCAN_PROGRESS *progress) {
    if (!scan) return;
    if (!progress) {
        scan->progressContext = NULL;
        scan->onProgress = NULL;
        scan->cancelRequested = NULL;
        return;
    }
    scan->progressContext = progress;
    scan->onProgress = scan_progress_update;
    scan->cancelRequested = scan_progress_cancel;
}

BOOL cx_scan_progress_end(CX_SCAN_PROGRESS *state, WCHAR *error, DWORD errorCap) {
    BOOL cancelled;
    if (error && errorCap) error[0] = 0;
    if (!state) return FALSE;
    InterlockedExchange(&state->finished, 1);
    if (state->window) PostMessageW(state->window, WM_CLOSE, 0, 0);
    if (state->thread) WaitForSingleObject(state->thread, 5000);
    cancelled = InterlockedCompareExchange(&state->cancelRequested, 0, 0) != 0;
    if (state->thread) CloseHandle(state->thread);
    if (state->ready) CloseHandle(state->ready);
    HeapFree(GetProcessHeap(), 0, state);
    return cancelled;
}












