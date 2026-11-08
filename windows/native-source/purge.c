#include "purge.h"

/* 无 CRT 构建：只用 kernel32/advapi32/user32 导出的接口。 */

#ifndef SHUTDOWN_NORETRY
#define SHUTDOWN_NORETRY 0x00000001
#endif

#define P_WINDOW_CLASS L"CXPlusNativePurgeGuard"
#define P_SCRIPT_NAME L"cx-purge.ps1"
#define P_STATE_NAME L"attempt.txt"
#define P_SWEEP_PATTERN L"*.cxdel"
#define P_SCRIPT_HEADROOM 16384
#define P_RUN_KEY_DEFAULT L"Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce"

/* ---------- 小工具 ---------- */

static DWORD p_len(const WCHAR *text) {
    DWORD length = 0;
    if (!text) return 0;
    while (text[length]) ++length;
    return length;
}

static BOOL p_copy(WCHAR *dst, DWORD cap, const WCHAR *src) {
    DWORD i = 0;
    if (!dst || cap == 0) return FALSE;
    if (src) { while (src[i] && i + 1 < cap) { dst[i] = src[i]; ++i; } }
    dst[i] = 0;
    return src == NULL || src[i] == 0;
}

static BOOL p_cat(WCHAR *dst, DWORD cap, const WCHAR *src) {
    DWORD at = p_len(dst), i = 0;
    if (!dst || !src) return FALSE;
    while (src[i] && at + i + 1 < cap) { dst[at + i] = src[i]; ++i; }
    dst[at + i] = 0;
    return src[i] == 0;
}

static WCHAR p_lower(WCHAR c) { return (c >= L'A' && c <= L'Z') ? (WCHAR)(c - L'A' + L'a') : c; }

static BOOL p_ieq(const WCHAR *left, const WCHAR *right) {
    DWORD i = 0;
    if (!left || !right) return FALSE;
    for (;;) {
        if (p_lower(left[i]) != p_lower(right[i])) return FALSE;
        if (!left[i]) return TRUE;
        ++i;
    }
}

/* 随机 8 位十六进制主干：登记名与临时目录都不固定，便于和上一次运行区分。 */
static void p_stem(WCHAR *out, DWORD cap) {
    static const WCHAR hex[] = L"0123456789abcdef";
    LARGE_INTEGER counter;
    DWORD seed, value;
    int i;
    if (!out || cap < 9) { if (out && cap) out[0] = 0; return; }
    QueryPerformanceCounter(&counter);
    seed = GetTickCount() ^ (GetCurrentProcessId() * 2654435761u) ^ (DWORD)counter.LowPart
        ^ (DWORD)counter.HighPart;
    if (!seed) seed = 0x9E3779B9u;
    value = seed;
    for (i = 0; i < 8; ++i) {
        value ^= value << 13; value ^= value >> 17; value ^= value << 5;
        out[i] = hex[value & 0xF];
    }
    out[8] = 0;
}

static BOOL p_exists(const WCHAR *path) {
    return path && path[0] && GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
}

static void p_pending_all(CX_PURGE *purge);

/* ---------- 续删脚本生成（PowerShell 5.1，纯 ASCII） ---------- */

typedef struct {
    WCHAR *text;
    DWORD used;
    DWORD cap;
    BOOL valid;
} P_TEXT;

static void pt_put(P_TEXT *out, WCHAR ch) {
    if (!out->valid) return;
    if (out->used + 1 >= out->cap) { out->valid = FALSE; return; }
    out->text[out->used++] = ch;
    out->text[out->used] = 0;
}

static void pt_add(P_TEXT *out, const WCHAR *text) {
    while (text && *text) pt_put(out, *text++);
}

/* PowerShell 单引号字面量：内部的 ' 写成 ''。 */
static void pt_literal(P_TEXT *out, const WCHAR *text) {
    pt_put(out, L'\'');
    while (text && *text) {
        if (*text == L'\'') pt_put(out, L'\'');
        pt_put(out, *text++);
    }
    pt_put(out, L'\'');
}

static void pt_line(P_TEXT *out, const WCHAR *text) { pt_add(out, text); pt_put(out, L'\n'); }

/* 每行一条路径：'<escaped path>' */
static void pt_paths(P_TEXT *out, const CX_PURGE *purge, BOOL directories) {
    int index;
    for (index = purge->count - 1; index >= 0; --index) {
        const CX_PURGE_ITEM *item = &purge->items[index];
        if (!item->path[0]) continue;
        if (item->directory != directories) continue;
        pt_literal(out, item->path);
        pt_put(out, L'\n');
    }
}

BOOL cx_purge_script_text(const CX_PURGE *purge, WCHAR *out, DWORD cap, DWORD *length) {
    P_TEXT text;
    if (length) *length = 0;
    if (!purge || !out || cap < 64) return FALSE;
    out[0] = 0;
    text.text = out; text.used = 0; text.cap = cap; text.valid = TRUE;
    pt_line(&text, L"$ErrorActionPreference='SilentlyContinue'");
    pt_line(&text, L"$attemptMax=16");
    pt_add(&text, L"$valueName="); pt_literal(&text, purge->valueName); pt_put(&text, L'\n');
    pt_add(&text, L"$runKey="); pt_literal(&text, purge->runKey); pt_put(&text, L'\n');
    pt_add(&text, L"$markerDir="); pt_literal(&text, purge->journalDir); pt_put(&text, L'\n');
    pt_add(&text, L"$scriptPath="); pt_literal(&text, purge->script); pt_put(&text, L'\n');
    pt_add(&text, L"$statePath="); pt_literal(&text, purge->state); pt_put(&text, L'\n');
    pt_add(&text, L"$rootPath="); pt_literal(&text, purge->root); pt_put(&text, L'\n');
    pt_add(&text, L"$files=@("); pt_put(&text, L'\n');
    pt_paths(&text, purge, FALSE);
    pt_add(&text, L")"); pt_put(&text, L'\n');
    pt_add(&text, L"$dirs=@("); pt_put(&text, L'\n');
    pt_paths(&text, purge, TRUE);
    pt_add(&text, L")"); pt_put(&text, L'\n');
    /* 次数状态：单独一个文件，脚本本体不必在运行中改写自身。 */
    pt_line(&text, L"$attempt=1");
    pt_line(&text, L"try{if([System.IO.File]::Exists($statePath)){$raw=[System.IO.File]::ReadAllText($statePath).Trim();$attempt=[int]$raw}}catch{$attempt=1}");
    pt_line(&text, L"if($attempt -lt 1){$attempt=1}");
    pt_line(&text, L"$left=0");
    pt_line(&text, L"foreach($f in $files){");
    pt_line(&text, L"  if([string]::IsNullOrEmpty($f)){continue}");
    pt_line(&text, L"  $done=$false");
    pt_line(&text, L"  for($i=0;$i -lt 40;$i++){");
    pt_line(&text, L"    if(-not [System.IO.File]::Exists($f)){$done=$true;break}");
    pt_line(&text, L"    try{[System.IO.File]::SetAttributes($f,[System.IO.FileAttributes]::Normal)}catch{}");
    pt_line(&text, L"    try{[System.IO.File]::Delete($f)}catch{}");
    pt_line(&text, L"    if(-not [System.IO.File]::Exists($f)){$done=$true;break}");
    pt_line(&text, L"    Start-Sleep -Milliseconds 250");
    pt_line(&text, L"  }");
    pt_line(&text, L"  if(-not $done){$left++}");
    pt_line(&text, L"}");
    /* 目录只在已经空的情况下删除；CXExam 等保留文件会让这一步失败，属预期。 */
    pt_line(&text, L"foreach($d in $dirs){");
    pt_line(&text, L"  if([string]::IsNullOrEmpty($d)){continue}");
    pt_line(&text, L"  for($i=0;$i -lt 20;$i++){");
    pt_line(&text, L"    if(-not [System.IO.Directory]::Exists($d)){break}");
    pt_line(&text, L"    try{[System.IO.Directory]::Delete($d,$false)}catch{}");
    pt_line(&text, L"    if(-not [System.IO.Directory]::Exists($d)){break}");
    pt_line(&text, L"    Start-Sleep -Milliseconds 250");
    pt_line(&text, L"  }");
    pt_line(&text, L"}");
    /* 自身改名残留（*.cxdel）必须在 root 里收尾，然后尝试删除空的 root。 */
    pt_line(&text, L"if(-not [string]::IsNullOrEmpty($rootPath)){");
    pt_line(&text, L"  if([System.IO.Directory]::Exists($rootPath)){");
    pt_line(&text, L"    try{");
    pt_add(&text, L"      foreach($f in [System.IO.Directory]::GetFiles($rootPath,'");
    pt_add(&text, P_SWEEP_PATTERN);
    pt_add(&text, L"')){try{[System.IO.File]::Delete($f)}catch{if([System.IO.File]::Exists($f)){$left++}}}");
    pt_put(&text, L'\n');
    pt_line(&text, L"    }catch{}");
    pt_line(&text, L"    try{[System.IO.Directory]::Delete($rootPath,$false)}catch{}");
    pt_line(&text, L"  }");
    pt_line(&text, L"}");
    /* 还有残留：写回次数并重新登记到 RunOnce；否则撤销登记并自删。 */
    pt_line(&text, L"if(($left -gt 0) -and ($attempt -lt $attemptMax)){");
    pt_line(&text, L"  try{[System.IO.File]::WriteAllText($statePath,[string]($attempt+1))}catch{}");
    pt_line(&text, L"  $cmd='\"'+(Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')+'\" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"'+$scriptPath+'\"'");
    pt_line(&text, L"  try{New-ItemProperty -Path ('HKCU:\\'+$runKey) -Name $valueName -Value $cmd -PropertyType String -Force}catch{}");
    pt_line(&text, L"}else{");
    pt_line(&text, L"  try{Remove-ItemProperty -Path ('HKCU:\\'+$runKey) -Name $valueName -Force}catch{}");
    pt_line(&text, L"  try{[System.IO.File]::Delete($statePath)}catch{}");
    pt_line(&text, L"  try{[System.IO.File]::Delete($scriptPath)}catch{}");
    pt_line(&text, L"  try{[System.IO.Directory]::Delete($markerDir,$false)}catch{}");
    pt_line(&text, L"}");
    if (!text.valid) return FALSE;
    if (length) *length = text.used;
    return TRUE;
}

/* ---------- 注册表登记 ---------- */

static BOOL p_reg_set(const WCHAR *subKey, const WCHAR *name, const WCHAR *value) {
    HKEY key = NULL;
    DWORD disposition = 0;
    LONG status;
    if (!subKey || !name || !value) return FALSE;
    status = RegCreateKeyExW(HKEY_CURRENT_USER, subKey, 0, NULL, 0, KEY_SET_VALUE, NULL,
                             &key, &disposition);
    if (status != ERROR_SUCCESS) return FALSE;
    status = RegSetValueExW(key, name, 0, REG_SZ, (const BYTE *)value,
                            (DWORD)((p_len(value) + 1) * sizeof(WCHAR)));
    RegCloseKey(key);
    return status == ERROR_SUCCESS;
}

static BOOL p_reg_delete(const WCHAR *subKey, const WCHAR *name) {
    HKEY key = NULL;
    LONG status;
    BOOL ok = FALSE;
    if (!subKey || !name) return FALSE;
    status = RegOpenKeyExW(HKEY_CURRENT_USER, subKey, 0, KEY_SET_VALUE, &key);
    if (status != ERROR_SUCCESS) return FALSE;
    ok = RegDeleteValueW(key, name) == ERROR_SUCCESS;
    RegCloseKey(key);
    return ok;
}

/* ---------- 生命周期 ---------- */

BOOL cx_purge_set_run_key(CX_PURGE *purge, const WCHAR *subKey) {
    if (!purge || !subKey || !subKey[0]) return FALSE;
    return p_copy(purge->runKey, CX_PURGE_RUNKEY_CAP, subKey);
}

BOOL cx_purge_set_journal_dir(CX_PURGE *purge, const WCHAR *directory) {
    DWORD length;
    if (!purge || !directory || !directory[0]) return FALSE;
    if (!p_copy(purge->journalDir, CX_PURGE_PATH_CAP, directory)) return FALSE;
    length = p_len(purge->journalDir);
    if (length && purge->journalDir[length - 1] != L'\\' && purge->journalDir[length - 1] != L'/') {
        if (!p_cat(purge->journalDir, CX_PURGE_PATH_CAP, L"\\")) return FALSE;
    }
    /* 目录路径统一带尾部分隔符，脚本路径再拼文件名。 */
    if (!p_copy(purge->script, CX_PURGE_PATH_CAP, purge->journalDir)) return FALSE;
    if (!p_cat(purge->script, CX_PURGE_PATH_CAP, P_SCRIPT_NAME)) return FALSE;
    if (!p_copy(purge->state, CX_PURGE_PATH_CAP, purge->journalDir)) return FALSE;
    if (!p_cat(purge->state, CX_PURGE_PATH_CAP, P_STATE_NAME)) return FALSE;
    purge->journalCount = 0;
    purge->journaled = FALSE;
    return TRUE;
}

BOOL cx_purge_init(CX_PURGE *purge, const WCHAR *root, const WCHAR *exe) {
    WCHAR temp[CX_PURGE_PATH_CAP], stem[16], value[CX_PURGE_NAME_CAP], windir[CX_PURGE_PATH_CAP];
    DWORD got;
    if (!purge) return FALSE;
    if (purge->lockReady) { DeleteCriticalSection(&purge->lock); purge->lockReady = FALSE; }
    ZeroMemory(purge, sizeof(*purge));
    if (!p_copy(purge->root, CX_PURGE_PATH_CAP, root ? root : L"")) return FALSE;
    if (!p_copy(purge->exe, CX_PURGE_PATH_CAP, exe ? exe : L"")) return FALSE;
    p_stem(stem, 16);
    if (!p_copy(value, CX_PURGE_NAME_CAP, L"cxplus-purge-")) return FALSE;
    if (!p_cat(value, CX_PURGE_NAME_CAP, stem)) return FALSE;
    if (!p_copy(purge->valueName, CX_PURGE_NAME_CAP, value)) return FALSE;
    if (!p_copy(purge->runKey, CX_PURGE_RUNKEY_CAP, P_RUN_KEY_DEFAULT)) return FALSE;
    got = GetTempPathW(CX_PURGE_PATH_CAP, temp);
    if (!got || got >= CX_PURGE_PATH_CAP) return FALSE;
    if (!p_copy(temp + (got), CX_PURGE_PATH_CAP - got, L"cx-purge-")) return FALSE;
    if (!p_cat(temp, CX_PURGE_PATH_CAP, stem)) return FALSE;
    if (!cx_purge_set_journal_dir(purge, temp)) return FALSE;
    /* PowerShell 路径按系统目录拼接；GetSystemDirectory 在 WOW64 下也指向可执行副本。 */
    got = GetSystemDirectoryW(windir, CX_PURGE_PATH_CAP);
    if (!got || got >= CX_PURGE_PATH_CAP) {
        got = GetEnvironmentVariableW(L"windir", windir, CX_PURGE_PATH_CAP);
        if (!got || got >= CX_PURGE_PATH_CAP) { if (!p_copy(windir, CX_PURGE_PATH_CAP, L"C:\\Windows")) return FALSE; }
        if (!p_cat(windir, CX_PURGE_PATH_CAP, L"\\System32")) return FALSE;
    }
    if (!p_copy(purge->powershell, CX_PURGE_PATH_CAP, windir)) return FALSE;
    if (!p_cat(purge->powershell, CX_PURGE_PATH_CAP,
               L"\\WindowsPowerShell\\v1.0\\powershell.exe")) return FALSE;
    InitializeCriticalSection(&purge->lock);
    purge->lockReady = TRUE;
    return TRUE;
}

void cx_purge_close(CX_PURGE *purge) {
    if (!purge) return;
    cx_purge_watch_stop(purge);
    if (purge->lockReady) {
        DeleteCriticalSection(&purge->lock);
        purge->lockReady = FALSE;
    }
}

void cx_purge_reset(CX_PURGE *purge) {
    if (!purge) return;
    if (purge->lockReady) EnterCriticalSection(&purge->lock);
    purge->count = 0;
    purge->truncated = 0;
    purge->rootQueued = FALSE;
    if (purge->lockReady) LeaveCriticalSection(&purge->lock);
}

int cx_purge_count(const CX_PURGE *purge) {
    int count;
    CX_PURGE *mutable = (CX_PURGE *)purge;
    if (!purge) return 0;
    if (purge->lockReady) EnterCriticalSection(&mutable->lock);
    count = purge->count;
    if (purge->lockReady) LeaveCriticalSection(&mutable->lock);
    return count;
}

BOOL cx_purge_add(CX_PURGE *purge, const WCHAR *path, BOOL directory) {
    int index;
    BOOL added = FALSE;
    if (!purge || !path || !path[0]) return FALSE;
    if (purge->lockReady) EnterCriticalSection(&purge->lock);
    for (index = 0; index < purge->count; ++index) {
        if (p_ieq(purge->items[index].path, path)) { added = TRUE; break; }
    }
    if (!added) {
        if (purge->count >= CX_PURGE_MAX_ITEMS) {
            purge->truncated = 1;
        } else {
            CX_PURGE_ITEM *item = &purge->items[purge->count];
            if (p_copy(item->path, CX_PURGE_PATH_CAP, path)) {
                item->directory = directory ? TRUE : FALSE;
                ++purge->count;
                added = TRUE;
            }
        }
    }
    if (purge->lockReady) LeaveCriticalSection(&purge->lock);
    return added;
}

BOOL cx_purge_add_root(CX_PURGE *purge) {
    if (!purge || !purge->root[0]) return FALSE;
    if (purge->lockReady) EnterCriticalSection(&purge->lock);
    purge->rootQueued = TRUE;
    if (purge->lockReady) LeaveCriticalSection(&purge->lock);
    return TRUE;
}

/* ---------- 开机续删 ---------- */

static BOOL p_write_bytes(const WCHAR *path, const void *data, DWORD length) {
    HANDLE file;
    BOOL ok = FALSE;
    DWORD written = 0;
    file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    if (!length || WriteFile(file, data, length, &written, NULL)) ok = !length || written == length;
    CloseHandle(file);
    return ok;
}

/* Windows PowerShell 5.1 只在有 BOM 时按 UTF-8 解析 -File 脚本；
   没有 BOM 会被当成 ANSI，含中文路径的清单就会失效。 */
static BOOL p_write_script_utf8(const WCHAR *path, const WCHAR *text) {
    static const BYTE bom[3] = { 0xEF, 0xBB, 0xBF };
    DWORD wide = p_len(text);
    int bytes;
    BYTE *buffer;
    BOOL ok;
    bytes = WideCharToMultiByte(CP_UTF8, 0, text, (int)wide, NULL, 0, NULL, NULL);
    if (bytes <= 0) return FALSE;
    buffer = (BYTE *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)bytes + 3);
    if (!buffer) return FALSE;
    CopyMemory(buffer, bom, 3);
    ok = WideCharToMultiByte(CP_UTF8, 0, text, (int)wide, (char *)buffer + 3, bytes, NULL, NULL) == bytes
        && p_write_bytes(path, buffer, (DWORD)bytes + 3);
    HeapFree(GetProcessHeap(), 0, buffer);
    return ok;
}

static BOOL p_write_script(CX_PURGE *purge, WCHAR *error, DWORD errorCap) {
    DWORD capacity = (DWORD)purge->count * (CX_PURGE_PATH_CAP * 3 + 8) + P_SCRIPT_HEADROOM;
    WCHAR *text;
    BOOL ok;
    if (capacity > 8u * 1024u * 1024u) capacity = 8u * 1024u * 1024u;
    text = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (SIZE_T)capacity * sizeof(WCHAR));
    if (!text) { if (error && errorCap) p_copy(error, errorCap, L"purge journal allocation failed"); return FALSE; }
    ok = cx_purge_script_text(purge, text, capacity, NULL) && p_write_script_utf8(purge->script, text);
    SecureZeroMemory(text, (SIZE_T)capacity * sizeof(WCHAR));
    HeapFree(GetProcessHeap(), 0, text);
    if (!ok && error && errorCap) p_copy(error, errorCap, L"purge journal script could not be written");
    return ok;
}

BOOL cx_purge_journal(CX_PURGE *purge, WCHAR *error, DWORD errorCap) {
    WCHAR command[CX_PURGE_PATH_CAP * 2 + 256];
    BOOL ok;
    if (error && errorCap) error[0] = 0;
    if (!purge) return FALSE;
    if (purge->lockReady) EnterCriticalSection(&purge->lock);
    if (purge->journaled && purge->journalCount == purge->count) {
        if (purge->lockReady) LeaveCriticalSection(&purge->lock);
        return TRUE;
    }
    if (!purge->journalDir[0] || !purge->script[0] || !purge->valueName[0]) {
        if (purge->lockReady) LeaveCriticalSection(&purge->lock);
        if (error && errorCap) p_copy(error, errorCap, L"purge journal paths are unavailable");
        return FALSE;
    }
    CreateDirectoryW(purge->journalDir, NULL);
    if (!p_write_bytes(purge->state, "1", 1)) {
        if (purge->lockReady) LeaveCriticalSection(&purge->lock);
        if (error && errorCap) p_copy(error, errorCap, L"purge journal state could not be written");
        return FALSE;
    }
    if (!p_write_script(purge, error, errorCap)) {
        if (purge->lockReady) LeaveCriticalSection(&purge->lock);
        return FALSE;
    }
    /* 强制关机保障：即使本进程被断电/强制结束，系统也会在下次启动时删除这些路径。
       这里需要管理员权限，失败只记录，不影响 RunOnce 续删。 */
    p_pending_all(purge);
    command[0] = 0;
    ok = p_copy(command, sizeof(command) / sizeof(WCHAR), L"\"") && p_cat(command, sizeof(command) / sizeof(WCHAR), purge->powershell)
        && p_cat(command, sizeof(command) / sizeof(WCHAR), L"\" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"")
        && p_cat(command, sizeof(command) / sizeof(WCHAR), purge->script)
        && p_cat(command, sizeof(command) / sizeof(WCHAR), L"\"");
    if (ok) ok = p_reg_set(purge->runKey, purge->valueName, command);
    if (!ok && error && errorCap) p_copy(error, errorCap, L"purge journal could not be registered for the next sign-in");
    purge->journaled = ok;
    purge->journalCount = ok ? purge->count : 0;
    purge->settled = FALSE;
    if (purge->lockReady) LeaveCriticalSection(&purge->lock);
    return ok;
}

BOOL cx_purge_pending_delete(const WCHAR *path) {
    if (!path || !path[0]) return FALSE;
    return MoveFileExW(path, NULL, MOVEFILE_DELAY_UNTIL_REBOOT) ? TRUE : FALSE;
}

static void p_pending_all(CX_PURGE *purge) {
    int index;
    purge->pendingCount = 0;
    purge->pendingFailed = 0;
    for (index = 0; index < purge->count; ++index) {
        if (!purge->items[index].path[0]) continue;
        if (cx_purge_pending_delete(purge->items[index].path)) ++purge->pendingCount;
        else ++purge->pendingFailed;
    }
    if (purge->rootQueued && purge->root[0]) {
        if (cx_purge_pending_delete(purge->root)) ++purge->pendingCount;
        else ++purge->pendingFailed;
    }
}

BOOL cx_purge_journal_clear(CX_PURGE *purge) {
    BOOL removed = FALSE;
    if (!purge) return FALSE;
    if (purge->lockReady) EnterCriticalSection(&purge->lock);
    if (purge->journaled || purge->journalCount) {
        removed = p_reg_delete(purge->runKey, purge->valueName);
        if (purge->script[0]) DeleteFileW(purge->script);
        if (purge->state[0]) DeleteFileW(purge->state);
        if (purge->journalDir[0]) RemoveDirectoryW(purge->journalDir);
    }
    purge->journaled = FALSE;
    purge->journalCount = 0;
    if (purge->lockReady) LeaveCriticalSection(&purge->lock);
    return removed;
}

/* ---------- 删除与校验 ---------- */

static BOOL p_remove_file(const WCHAR *path, int attempts) {
    int attempt;
    for (attempt = 0; attempt < attempts; ++attempt) {
        DWORD code;
        if (DeleteFileW(path)) return TRUE;
        code = GetLastError();
        if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) return TRUE;
        if (attempt + 1 < attempts) Sleep(50);
    }
    return FALSE;
}

int cx_purge_run(CX_PURGE *purge, int attempts, int *failed) {
    int index, removed = 0, failures = 0;
    DWORD started;
    if (failed) *failed = 0;
    if (!purge) return 0;
    if (attempts < 1) attempts = 1;
    started = GetTickCount();
    if (purge->lockReady) EnterCriticalSection(&purge->lock);
    /* 逆序即"最深先删"：目录总在其子项之前入队。
       关机路径有预算上限，超过就停下并把剩余项交给开机续删。 */
    for (index = purge->count - 1; index >= 0; --index) {
        CX_PURGE_ITEM *item = &purge->items[index];
        if (item->directory || !item->path[0]) continue;
        if (GetTickCount() - started > CX_PURGE_RUN_BUDGET_MS) { ++failures; continue; }
        if (p_remove_file(item->path, attempts)) ++removed;
        else ++failures;
    }
    for (index = purge->count - 1; index >= 0; --index) {
        if (purge->items[index].directory && purge->items[index].path[0]) {
            if (RemoveDirectoryW(purge->items[index].path)) ++removed;
        }
    }
    if (purge->rootQueued && purge->root[0]) {
        if (RemoveDirectoryW(purge->root)) ++removed;
    }
    purge->removed += removed;
    if (purge->lockReady) LeaveCriticalSection(&purge->lock);
    if (failed) *failed = failures;
    return removed;
}

static int p_remaining_files(CX_PURGE *purge) {
    int index, remaining = 0;
    for (index = 0; index < purge->count; ++index) {
        if (purge->items[index].directory) continue;
        if (p_exists(purge->items[index].path)) ++remaining;
    }
    return remaining;
}

void cx_purge_settle(CX_PURGE *purge) {
    int remaining;
    if (!purge) return;
    if (purge->lockReady) EnterCriticalSection(&purge->lock);
    remaining = p_remaining_files(purge);
    purge->remaining = remaining;
    purge->settled = TRUE;
    if (!remaining) {
        /* 痕迹已清空：注销开机续删，避免留下登记项与临时脚本。 */
        if (purge->journaled || purge->journalCount) {
            p_reg_delete(purge->runKey, purge->valueName);
            if (purge->script[0]) DeleteFileW(purge->script);
            if (purge->state[0]) DeleteFileW(purge->state);
            if (purge->journalDir[0]) RemoveDirectoryW(purge->journalDir);
        }
        purge->journaled = FALSE;
        purge->journalCount = 0;
    }
    if (purge->lockReady) LeaveCriticalSection(&purge->lock);
}

/* ---------- 退出后继删 ---------- */

BOOL cx_purge_after_exit(CX_PURGE *purge) {
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    static WCHAR command[CX_PURGE_PATH_CAP * 2 + 256];
    DWORD cap = (DWORD)(sizeof(command) / sizeof(WCHAR));
    BOOL ok;
    if (!purge || !purge->journaled) return FALSE;
    if (!purge->script[0] || !p_exists(purge->script)) return FALSE;
    command[0] = 0;
    if (!p_copy(command, cap, L"\"") || !p_cat(command, cap, purge->powershell)) return FALSE;
    if (!p_cat(command, cap, L"\" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"")) return FALSE;
    if (!p_cat(command, cap, purge->script) || !p_cat(command, cap, L"\"")) return FALSE;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));
    /* 不等待：本进程即将退出，脚本自己重试到文件锁释放为止。 */
    ok = CreateProcessW(NULL, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi);
    if (ok) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
    return ok;
}

/* ---------- 关机/注销监视 ---------- */
static LRESULT CALLBACK p_window_proc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    CX_PURGE *purge = (CX_PURGE *)(LONG_PTR)GetWindowLongPtrW(window, GWLP_USERDATA);
    switch (message) {
        case WM_QUERYENDSESSION:
            /* 关机、重启或注销：允许继续，但先把自毁做完。 */
            if (purge && purge->onShutdown) purge->onShutdown();
            return TRUE;
        case WM_ENDSESSION:
            /* wParam=TRUE 表示会话确实结束；强制结束会话（ENDSESSION_CRITICAL）也走这里。 */
            if (wParam && purge && purge->onShutdown) purge->onShutdown();
            (void)lParam;
            return 0;
        case WM_CLOSE:
            DestroyWindow(window);
            return 0;
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
        default:
            return DefWindowProcW(window, message, wParam, lParam);
    }
}

static DWORD WINAPI p_watch_thread(LPVOID parameter) {
    CX_PURGE *purge = (CX_PURGE *)parameter;
    WNDCLASSW klass;
    MSG message;
    if (!purge) return 0;
    /* 尽早拿到关机通知，并声明不弹重试框，避免拖住关机。 */
    SetProcessShutdownParameters(0x4FF, SHUTDOWN_NORETRY);
    ZeroMemory(&klass, sizeof(klass));
    klass.lpfnWndProc = p_window_proc;
    klass.hInstance = GetModuleHandleW(NULL);
    klass.lpszClassName = P_WINDOW_CLASS;
    if (!RegisterClassW(&klass) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return 0;
    purge->window = CreateWindowExW(WS_EX_TOOLWINDOW, P_WINDOW_CLASS, L"", WS_POPUP,
                                    0, 0, 0, 0, NULL, NULL, klass.hInstance, NULL);
    if (!purge->window) return 0;
    SetWindowLongPtrW(purge->window, GWLP_USERDATA, (LONG_PTR)purge);
    while (InterlockedCompareExchange(&purge->stop, 0, 0) == 0 && GetMessageW(&message, NULL, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    purge->window = NULL;
    return 0;
}

BOOL cx_purge_watch_shutdown(CX_PURGE *purge, void (*onShutdown)(void)) {
    if (!purge || !onShutdown) return FALSE;
    purge->onShutdown = onShutdown;
    if (purge->thread) return TRUE;
    InterlockedExchange(&purge->stop, 0);
    purge->thread = CreateThread(NULL, 0, p_watch_thread, purge, 0, &purge->threadId);
    if (!purge->thread) return FALSE;
    return TRUE;
}

void cx_purge_watch_stop(CX_PURGE *purge) {
    if (!purge) return;
    InterlockedExchange(&purge->stop, 1);
    if (purge->window) PostMessageW(purge->window, WM_CLOSE, 0, 0);
    if (purge->thread) {
        WaitForSingleObject(purge->thread, 5000);
        CloseHandle(purge->thread);
        purge->thread = NULL;
    }
    purge->window = NULL;
}

BOOL cx_purge_watch_ready(const CX_PURGE *purge) {
    return purge && purge->window ? TRUE : FALSE;
}

BOOL cx_purge_simulate_shutdown(CX_PURGE *purge, BOOL critical) {
    DWORD waited = 0;
    if (!purge) return FALSE;
    /* 窗口在线程里创建，最多等 2 秒，避免测试里出现竞态。 */
    while (!purge->window && waited < 2000) { Sleep(20); waited += 20; }
    if (!purge->window) return FALSE;
    if (critical) SendMessageW(purge->window, WM_ENDSESSION, TRUE, 0);
    else SendMessageW(purge->window, WM_QUERYENDSESSION, 0, 0);
    return TRUE;
}

/* ---------- 只读视图 ---------- */

const WCHAR *cx_purge_script_path(const CX_PURGE *purge) { return purge ? purge->script : L""; }
const WCHAR *cx_purge_journal_dir(const CX_PURGE *purge) { return purge ? purge->journalDir : L""; }
const WCHAR *cx_purge_value_name(const CX_PURGE *purge) { return purge ? purge->valueName : L""; }
const WCHAR *cx_purge_run_key(const CX_PURGE *purge) { return purge ? purge->runKey : L""; }
