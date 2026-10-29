#include "silent.h"

/* ---------- 小工具（无 CRT） ---------- */

static DWORD s_len(const WCHAR *text) {
    DWORD length = 0;
    if (!text) return 0;
    while (text[length]) ++length;
    return length;
}

static BOOL s_copy(WCHAR *dst, DWORD cap, const WCHAR *src) {
    DWORD i = 0;
    if (!dst || cap == 0) return FALSE;
    if (src) {
        while (src[i] && i + 1 < cap) { dst[i] = src[i]; ++i; }
    }
    dst[i] = 0;
    return src == NULL || src[i] == 0;
}

static BOOL s_append(WCHAR *dst, DWORD cap, const WCHAR *src) {
    DWORD at = s_len(dst), i = 0;
    if (!dst || !src) return FALSE;
    while (src[i] && at + i + 1 < cap) { dst[at + i] = src[i]; ++i; }
    dst[at + i] = 0;
    return src[i] == 0;
}

static WCHAR s_lower(WCHAR c) {
    return (c >= L'A' && c <= L'Z') ? (WCHAR)(c - L'A' + L'a') : c;
}

static BOOL s_ieq(const WCHAR *left, const WCHAR *right) {
    DWORD i = 0;
    if (!left || !right) return FALSE;
    for (;;) {
        WCHAR a = s_lower(left[i]), b = s_lower(right[i]);
        if (a != b) return FALSE;
        if (!a) return TRUE;
        ++i;
    }
}

static BOOL s_iprefix(const WCHAR *text, const WCHAR *prefix) {
    DWORD i = 0;
    if (!text || !prefix) return FALSE;
    while (prefix[i]) {
        if (s_lower(text[i]) != s_lower(prefix[i])) return FALSE;
        ++i;
    }
    return TRUE;
}

static const WCHAR *s_basename(const WCHAR *path) {
    const WCHAR *name = path;
    if (!path) return L"";
    while (*path) {
        if (*path == L'\\' || *path == L'/') name = path + 1;
        ++path;
    }
    return name;
}


/* CXExam（含 cxexam.exe.~1 之类）与 runtime 运行时目录永不进入删除计划。 */
static BOOL s_protected_name(const WCHAR *name) {
    return s_iprefix(name, L"cxexam");
}

/* ---------- 自毁状态机 ---------- */

void cx_silent_init(CX_SILENT *silent, BOOL fullscreenExit) {
    if (!silent) return;
    silent->state = CX_SILENT_IDLE;
    silent->clientPid = 0;
    silent->fullscreenSeen = FALSE;
    silent->fullscreenExit = fullscreenExit ? TRUE : FALSE;
    silent->requested = FALSE;
    silent->reason[0] = 0;
    silent->keyCount = 0;
    if (s_copy(silent->keys[0], CX_SILENT_KEY_CAP, L"Ctrl+Alt+Shift+E")) ++silent->keyCount;
    if (s_copy(silent->keys[1], CX_SILENT_KEY_CAP, L"F8")) ++silent->keyCount;
}

BOOL cx_silent_client_started(CX_SILENT *silent, DWORD pid) {
    if (!silent || pid == 0) return FALSE;
    if (silent->state != CX_SILENT_IDLE) return FALSE;
    silent->clientPid = pid;
    silent->state = CX_SILENT_WATCHING;
    return TRUE;
}

BOOL cx_silent_hotkey(CX_SILENT *silent, const WCHAR *shortcut) {
    int i;
    if (!silent || !shortcut || !*shortcut) return FALSE;
    if (silent->state != CX_SILENT_WATCHING && silent->state != CX_SILENT_FULLSCREEN_SEEN) return FALSE;
    for (i = 0; i < silent->keyCount; ++i) {
        if (s_ieq(silent->keys[i], shortcut)) {
            silent->state = CX_SILENT_DESTRUCT_REQUESTED;
            silent->requested = TRUE;
            s_copy(silent->reason, CX_SILENT_REASON_CAP, L"shortcut");
            return TRUE;
        }
    }
    return FALSE;
}

BOOL cx_silent_fullscreen(CX_SILENT *silent, BOOL fullscreen, DWORD pid) {
    if (!silent || pid == 0 || pid != silent->clientPid) return FALSE;
    if (fullscreen) {
        if (silent->state != CX_SILENT_WATCHING) return FALSE;
        silent->state = CX_SILENT_FULLSCREEN_SEEN;
        silent->fullscreenSeen = TRUE;
        return TRUE;
    }
    if (!silent->fullscreenExit) return FALSE;
    if (silent->state != CX_SILENT_FULLSCREEN_SEEN) return FALSE;
    silent->state = CX_SILENT_DESTRUCT_REQUESTED;
    silent->requested = TRUE;
    s_copy(silent->reason, CX_SILENT_REASON_CAP, L"fullscreen-exit");
    return TRUE;
}

BOOL cx_silent_client_exited(CX_SILENT *silent, DWORD pid) {
    if (!silent || pid == 0 || pid != silent->clientPid) return FALSE;
    if (silent->state != CX_SILENT_WATCHING && silent->state != CX_SILENT_FULLSCREEN_SEEN) return FALSE;
    silent->state = CX_SILENT_DESTRUCT_REQUESTED;
    silent->requested = TRUE;
    s_copy(silent->reason, CX_SILENT_REASON_CAP, L"client-exited");
    return TRUE;
}

BOOL cx_silent_finish(CX_SILENT *silent, WCHAR *reason, DWORD reasonCap) {
    if (!silent) return FALSE;
    if (silent->state != CX_SILENT_DESTRUCT_REQUESTED) return FALSE;
    silent->state = CX_SILENT_FINISHED;
    if (reason && reasonCap) s_copy(reason, reasonCap, silent->reason);
    return TRUE;
}

/* ---------- 程序痕迹清理 ---------- */

static BOOL s_push(CX_CLEANUP_PLAN *plan, const WCHAR *path, BOOL directory) {
    CX_CLEANUP_ITEM *item;
    if (!plan || !path) return FALSE;
    if (plan->count >= CX_CLEANUP_MAX_ITEMS) { plan->truncated = 1; return FALSE; }
    item = &plan->items[plan->count];
    if (!s_copy(item->path, CX_CLEANUP_PATH_CAP, path)) return FALSE;
    item->directory = directory ? TRUE : FALSE;
    ++plan->count;
    return TRUE;
}

static void s_walk(CX_CLEANUP_PLAN *plan, const WCHAR *directory, int depth) {
    WCHAR pattern[CX_CLEANUP_PATH_CAP];
    WIN32_FIND_DATAW *found;
    HANDLE handle;
    if (!plan || !directory || depth > CX_CLEANUP_MAX_DEPTH) return;
    if (!s_copy(pattern, CX_CLEANUP_PATH_CAP, directory) || !s_append(pattern, CX_CLEANUP_PATH_CAP, L"\\*")) return;
    found = (WIN32_FIND_DATAW *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(WIN32_FIND_DATAW));
    if (!found) return;
    handle = FindFirstFileW(pattern, found);
    if (handle == INVALID_HANDLE_VALUE) { HeapFree(GetProcessHeap(), 0, found); return; }
    do {
        WCHAR full[CX_CLEANUP_PATH_CAP];
        BOOL isDirectory;
        if (s_ieq(found->cFileName, L".") || s_ieq(found->cFileName, L"..")) continue;
        if (found->dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) continue;
        isDirectory = (found->dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? TRUE : FALSE;
        if (!s_copy(full, CX_CLEANUP_PATH_CAP, directory) || !s_append(full, CX_CLEANUP_PATH_CAP, L"\\")
            || !s_append(full, CX_CLEANUP_PATH_CAP, found->cFileName)) continue;
        if (isDirectory) {
            /* 运行时目录不是程序痕迹：删掉它等于删正在执行的东西。 */
            if (s_ieq(found->cFileName, L"runtime")) continue;
            s_push(plan, full, TRUE);
            s_walk(plan, full, depth + 1);
        } else {
            if (s_protected_name(found->cFileName)) { ++plan->protectedCount; continue; }
            s_push(plan, full, FALSE);
        }
    } while (FindNextFileW(handle, found));
    FindClose(handle);
    HeapFree(GetProcessHeap(), 0, found);
}

BOOL cx_cleanup_is_release_layout(const WCHAR *root) {
    WCHAR marker[CX_CLEANUP_PATH_CAP];
    if (!root || !*root) return FALSE;
    if (!s_copy(marker, CX_CLEANUP_PATH_CAP, root) || !s_append(marker, CX_CLEANUP_PATH_CAP, L"\\SHA256SUMS.txt")) return FALSE;
    return GetFileAttributesW(marker) != INVALID_FILE_ATTRIBUTES;
}

BOOL cx_cleanup_collect(const WCHAR *root, CX_CLEANUP_PLAN *plan) {
    if (!root || !plan) return FALSE;
    plan->count = 0;
    plan->truncated = 0;
    plan->protectedCount = 0;
    if (!s_copy(plan->root, CX_CLEANUP_PATH_CAP, root)) return FALSE;
    s_walk(plan, plan->root, 0);
    return TRUE;
}

static BOOL s_remove_file(const WCHAR *path, int attempts) {
    int attempt;
    for (attempt = 0; attempt < attempts; ++attempt) {
        DWORD error;
        if (DeleteFileW(path)) return TRUE;
        error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return TRUE;
        if (attempt + 1 < attempts) Sleep(50);
    }
    return FALSE;
}

int cx_cleanup_apply(CX_CLEANUP_PLAN *plan, BOOL simulate, int attempts, int *failed) {
    int index, deleted = 0, failures = 0;
    if (failed) *failed = 0;
    if (!plan) return 0;
    if (attempts < 1) attempts = 1;
    /* 逆序即"最深先删"：目录总在其子项之前入队。 */
    for (index = plan->count - 1; index >= 0; --index) {
        CX_CLEANUP_ITEM *item = &plan->items[index];
        if (item->directory) continue;
        if (simulate) { ++deleted; continue; }
        if (s_remove_file(item->path, attempts)) ++deleted;
        else ++failures;
    }
    if (!simulate) {
        for (index = plan->count - 1; index >= 0; --index) {
            if (plan->items[index].directory) RemoveDirectoryW(plan->items[index].path);
        }
    }
    if (failed) *failed = failures;
    return deleted;
}

BOOL cx_cleanup_detach_self(const WCHAR *exePath, WCHAR *parked, DWORD parkedCap) {
    if (!exePath || !*exePath || !parked || parkedCap < 8) return FALSE;
    parked[0] = 0;
    if (!s_copy(parked, parkedCap, exePath) || !s_append(parked, parkedCap, L".cxdel")) return FALSE;
    if (!MoveFileExW(exePath, parked, MOVEFILE_REPLACE_EXISTING)) { parked[0] = 0; return FALSE; }
    return TRUE;
}

void cx_cleanup_release_self(const WCHAR *parked) {
    /* 运行中的镜像（本进程自己的 .cxdel）删不掉：先尝试直删，失败后交给看门狗。
       看门狗必须重试：单次 ping+del 很可能在本进程真正退出前就执行完，那时删除
       仍是 ACCESS_DENIED，文件会永久留在磁盘上（实测 .cxdel 在退出 10 秒后仍在）。 */
    static WCHAR command[CX_CLEANUP_PATH_CAP * 2 + 384];
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    if (!parked || !*parked) return;
    if (DeleteFileW(parked)) return;
    MoveFileExW(parked, NULL, MOVEFILE_DELAY_UNTIL_REBOOT);
    command[0] = 0;
    if (!s_copy(command, CX_CLEANUP_PATH_CAP * 2 + 384,
                L"cmd.exe /c for /l %i in (1,1,60) do @(del /f /q \"")) return;
    if (!s_append(command, CX_CLEANUP_PATH_CAP * 2 + 384, parked)) return;
    if (!s_append(command, CX_CLEANUP_PATH_CAP * 2 + 384, L"\" >nul 2>nul & ")) return;
    if (!s_append(command, CX_CLEANUP_PATH_CAP * 2 + 384, L"if not exist \"")) return;
    if (!s_append(command, CX_CLEANUP_PATH_CAP * 2 + 384, parked)) return;
    if (!s_append(command, CX_CLEANUP_PATH_CAP * 2 + 384, L"\" rmdir /q \"")) return;
    {
        WCHAR folder[CX_CLEANUP_PATH_CAP];
        DWORD cut = 0, k = 0;
        while (parked[k]) { if (parked[k] == L'\\' || parked[k] == L'/') cut = k; ++k; }
        if (cut == 0) return;
        for (k = 0; k < cut; ++k) folder[k] = parked[k];
        folder[cut] = 0;
        if (!s_append(command, CX_CLEANUP_PATH_CAP * 2 + 384, folder)) return;
    }
    if (!s_append(command, CX_CLEANUP_PATH_CAP * 2 + 384,
                  L"\" >nul 2>nul & ping -n 2 127.0.0.1 >nul)")) return;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));
    if (CreateProcessW(NULL, command, NULL, NULL, FALSE,
                       CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
}








