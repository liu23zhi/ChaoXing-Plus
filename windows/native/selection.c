#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commdlg.h>
#include "selection.h"

#define SELECTION_LIST 1001
#define SELECTION_BROWSE 1002
#define SELECTION_TIMER 1003

static const WCHAR selectionClass[] = L"CXPlusNativeClientSelection";
static const WCHAR selectionTitle[] = L"超星学习助手 - 选择考试客户端";

typedef struct SELECTION_WINDOW {
    const CX_DISCOVERY_RESULT *candidates;
    BOOL hostIs32Bit;
    WCHAR *out;
    DWORD outCap;
    WCHAR *error;
    DWORD errorCap;
    HWND window, heading, columns, list, browse, choose, cancel;
    HFONT font;
    BOOL finished;
    CX_SELECTION_STATUS result;
} SELECTION_WINDOW;

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

static void selection_layout(SELECTION_WINDOW *state) {
    RECT rect;
    int width, height;
    GetClientRect(state->window, &rect); width = rect.right; height = rect.bottom;
    MoveWindow(state->heading, 18, 16, width - 36, 26, TRUE);
    MoveWindow(state->columns, 20, 52, width - 40, 22, TRUE);
    MoveWindow(state->list, 18, 78, width - 36, height - 146, TRUE);
    MoveWindow(state->browse, 18, height - 52, 138, 32, TRUE);
    MoveWindow(state->choose, width - 238, height - 52, 102, 32, TRUE);
    MoveWindow(state->cancel, width - 120, height - 52, 102, 32, TRUE);
}

static HWND selection_control(SELECTION_WINDOW *state, DWORD style, const WCHAR *kind,
                               const WCHAR *title, int id) {
    HWND control = CreateWindowExW(0, kind, title, WS_CHILD | WS_VISIBLE | style,
        0, 0, 0, 0, state->window, (HMENU)(INT_PTR)id, GetModuleHandleW(NULL), NULL);
    if (control && state->font) SendMessageW(control, WM_SETFONT, (WPARAM)state->font, FALSE);
    return control;
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
        state->heading = selection_control(state, 0, L"STATIC", L"请选择需要启动的考试客户端，也可手动浏览。", 0);
        state->columns = selection_control(state, 0, L"STATIC", L"序号 / 架构 / 文件版本 / 完整路径", 0);
        state->list = selection_control(state, WS_TABSTOP | WS_BORDER | WS_VSCROLL | WS_HSCROLL
            | LBS_NOTIFY | LBS_NOINTEGRALHEIGHT | LBS_USETABSTOPS, L"LISTBOX", L"", SELECTION_LIST);
        state->browse = selection_control(state, WS_TABSTOP | BS_PUSHBUTTON, L"BUTTON", L"手动浏览…", SELECTION_BROWSE);
        state->choose = selection_control(state, WS_TABSTOP | BS_DEFPUSHBUTTON, L"BUTTON", L"选择并启动", IDOK);
        state->cancel = selection_control(state, WS_TABSTOP | BS_PUSHBUTTON, L"BUTTON", L"取消", IDCANCEL);
        if (!state->heading || !state->columns || !state->list || !state->browse || !state->choose || !state->cancel
            || !selection_fill(state)) { selection_error(state, L"无法创建原生客户端选择控件。"); return -1; }
        selection_layout(state); return 0;
    }
    if (message == WM_SIZE) { selection_layout(state); return 0; }
    if (message == WM_GETMINMAXINFO) {
        MINMAXINFO *info = (MINMAXINFO *)lParam;
        info->ptMinTrackSize.x = 640; info->ptMinTrackSize.y = 360; return 0;
    }
    if (message == WM_COMMAND) {
        int command = LOWORD(wParam);
        if (command == IDCANCEL) { DestroyWindow(window); return 0; }
        if (command == SELECTION_BROWSE) { selection_browse(state); return 0; }
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
    int width = 960, height = 510;
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
    state->font = CreateFontW(-16, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
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
                                     BOOL hostIs32Bit, WCHAR *out, DWORD outCap,
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
    state.candidates = candidates; state.hostIs32Bit = hostIs32Bit; state.out = out; state.outCap = outCap;
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

BOOL cx_selection_probe(const CX_DISCOVERY_RESULT *candidates, CX_SELECTION_PROBE *probe,
                         WCHAR *error, DWORD errorCap) {
    SELECTION_WINDOW state;
    WCHAR title[128];
    ZeroMemory(&state, sizeof(state)); state.candidates = candidates;
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
    probe->unicodeWindow = IsWindowUnicode(state.window);
    GetWindowTextW(state.window, title, 128); probe->titleMatches = lstrcmpW(title, selectionTitle) == 0;
    DestroyWindow(state.window);
    if (state.font) DeleteObject(state.font);
    return TRUE;
}
