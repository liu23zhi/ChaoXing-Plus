#include "wipe.h"
#include "options.h"

static WCHAR w_lower(WCHAR c) { return (c >= L'A' && c <= L'Z') ? (WCHAR)(c - L'A' + L'a') : c; }
static BOOL w_ieq(const WCHAR *a, const WCHAR *b) {
    int i = 0;
    if (!a || !b) return FALSE;
    while (a[i] && b[i] && w_lower(a[i]) == w_lower(b[i])) ++i;
    return a[i] == 0 && b[i] == 0;
}
static BOOL w_copy(WCHAR *dst, DWORD cap, const WCHAR *src) {
    DWORD i = 0;
    if (!dst || cap == 0) return FALSE;
    while (src && src[i] && i + 1 < cap) { dst[i] = src[i]; ++i; }
    dst[i] = 0;
    return src == NULL || src[i] == 0;
}
static BOOL w_append(WCHAR *dst, DWORD cap, const WCHAR *src) {
    DWORD at = (DWORD)lstrlenW(dst), i = 0;
    while (src && src[i] && at + i + 1 < cap) { dst[at + i] = src[i]; ++i; }
    dst[at + i] = 0;
    return src == NULL || src[i] == 0;
}
static BOOL w_join(WCHAR *dst, DWORD cap, const WCHAR *dir, const WCHAR *name) {
    return w_copy(dst, cap, dir) && w_append(dst, cap, L"\\") && w_append(dst, cap, name);
}
static BOOL path_exists(const WCHAR *path) {
    DWORD attrs = GetFileAttributesW(path);
    return attrs != INVALID_FILE_ATTRIBUTES && !(attrs & FILE_ATTRIBUTE_DIRECTORY);
}
static BOOL dir_exists(const WCHAR *path) {
    DWORD attrs = GetFileAttributesW(path);
    return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY);
}

/* 诊断目录名：YYYYMMDDTHHMMSSmmmZ-PID-attempt。 */
static BOOL diagnostic_run_name(const WCHAR *name) {
    int i = 0, digits = 0;
    if (!name) return FALSE;
    for (; digits < 8 && name[i] >= L'0' && name[i] <= L'9'; ++i, ++digits) { }
    if (digits != 8 || name[i] != L'T') return FALSE;
    ++i; digits = 0;
    for (; digits < 6 && name[i] >= L'0' && name[i] <= L'9'; ++i, ++digits) { }
    if (digits != 6) return FALSE;
    digits = 0;
    for (; digits < 3 && name[i] >= L'0' && name[i] <= L'9'; ++i, ++digits) { }
    if (digits != 3 || name[i] != L'Z' || name[i + 1] != L'-') return FALSE;
    i += 2;
    digits = 0;
    while (name[i] >= L'0' && name[i] <= L'9') { ++i; ++digits; }
    if (digits == 0 || name[i] != L'-') return FALSE;
    ++i; digits = 0;
    while (name[i] >= L'0' && name[i] <= L'9') { ++i; ++digits; }
    return digits > 0 && name[i] == 0;
}

static BOOL skip_external(const WCHAR *path, const WCHAR *externalConfig) {
    return externalConfig && externalConfig[0] && w_ieq(path, externalConfig);
}

static void add_file(CX_WIPE *wipe, const WCHAR *path, const WCHAR *externalConfig) {
    int i;
    if (!path || !path[0] || wipe->count >= CX_WIPE_MAX_FILES) return;
    if (!path_exists(path) || skip_external(path, externalConfig)) return;
    for (i = 0; i < wipe->count; ++i) if (w_ieq(wipe->paths[i], path)) return;
    w_copy(wipe->paths[wipe->count], CX_WIPE_PATH_CAP, path);
    wipe->pending[wipe->count] = TRUE;
    ++wipe->count;
}

static void collect_logs(CX_WIPE *wipe, const WCHAR *logs, const WCHAR *externalConfig) {
    WIN32_FIND_DATAW data;
    WCHAR pattern[CX_WIPE_PATH_CAP], path[CX_WIPE_PATH_CAP];
    HANDLE find;
    if (!w_join(pattern, CX_WIPE_PATH_CAP, logs, L"windows-host-*.log")) return;
    find = FindFirstFileW(pattern, &data);
    if (find == INVALID_HANDLE_VALUE) return;
    do {
        if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
        if (!w_join(path, CX_WIPE_PATH_CAP, logs, data.cFileName)) continue;
        add_file(wipe, path, externalConfig);
    } while (FindNextFileW(find, &data));
    FindClose(find);
}

static void collect_diagnostics(CX_WIPE *wipe, const WCHAR *diagnostics, const WCHAR *externalConfig) {
    static const WCHAR *const artifacts[] = {
        L"render-diagnostics.json", L"render-diagnostics-page.png",
        L"render-diagnostics-host.json", L"window-capture.bmp", L"window-capture.png"
    };
    WIN32_FIND_DATAW data;
    WCHAR pattern[CX_WIPE_PATH_CAP], run[CX_WIPE_PATH_CAP], path[CX_WIPE_PATH_CAP];
    HANDLE find;
    if (!w_join(pattern, CX_WIPE_PATH_CAP, diagnostics, L"*")) return;
    find = FindFirstFileW(pattern, &data);
    if (find == INVALID_HANDLE_VALUE) return;
    do {
        int i;
        if (!(data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
        if (data.cFileName[0] == L'.') continue;
        if (!diagnostic_run_name(data.cFileName)) continue;
        if (!w_join(run, CX_WIPE_PATH_CAP, diagnostics, data.cFileName)) continue;
        for (i = 0; i < (int)(sizeof(artifacts) / sizeof(artifacts[0])); ++i) {
            if (!w_join(path, CX_WIPE_PATH_CAP, run, artifacts[i])) continue;
            add_file(wipe, path, externalConfig);
        }
    } while (FindNextFileW(find, &data));
    FindClose(find);
}

int cx_wipe_add_file(CX_WIPE *wipe, const WCHAR *path, const WCHAR *externalConfig) {
    int before;
    if (!wipe || !path || !path[0] || wipe->count >= CX_WIPE_MAX_FILES) return 0;
    before = wipe->count;
    add_file(wipe, path, externalConfig);
    return wipe->count > before ? 1 : 0;
}
void cx_wipe_init(CX_WIPE *wipe) {
    if (!wipe) return;
    ZeroMemory(wipe, sizeof(*wipe));
    wipe->policy = CX_WIPE_RETRY;
    wipe->retries = 5;
    wipe->delayMs = 200;
    wipe->runtimeRetry = TRUE;
    wipe->runtimeIntervalMs = 30000;
    InitializeCriticalSection(&wipe->lock);
    wipe->lockReady = TRUE;
}

void cx_wipe_configure(CX_WIPE *wipe, CX_WIPE_POLICY policy, int retries, int delayMs,
                       BOOL runtimeRetry, DWORD runtimeIntervalMs) {
    if (!wipe) return;
    wipe->policy = policy;
    wipe->retries = retries < 1 ? 1 : (retries > 20 ? 20 : retries);
    wipe->delayMs = delayMs < 50 ? 50 : (delayMs > 5000 ? 5000 : delayMs);
    wipe->runtimeRetry = runtimeRetry;
    wipe->runtimeIntervalMs = runtimeIntervalMs < 1000 ? 1000 : runtimeIntervalMs;
}

int cx_wipe_collect(CX_WIPE *wipe, const WCHAR *dataDir, const WCHAR *externalConfig) {
    WCHAR root[CX_WIPE_PATH_CAP], path[CX_WIPE_PATH_CAP];
    WCHAR logs[CX_WIPE_PATH_CAP], diagnostics[CX_WIPE_PATH_CAP];
    if (!wipe || !dataDir || !dataDir[0]) return 0;
    wipe->count = 0;
    if (!w_join(root, CX_WIPE_PATH_CAP, dataDir, CX_HOST_DATA_SUBDIR)) return 0;
    if (!dir_exists(root)) return 0;
    if (w_join(path, CX_WIPE_PATH_CAP, root, L"native-scan-cache-v1.bin")) add_file(wipe, path, externalConfig);
    if (w_join(logs, CX_WIPE_PATH_CAP, root, L"logs") && dir_exists(logs)) collect_logs(wipe, logs, externalConfig);
    if (w_join(diagnostics, CX_WIPE_PATH_CAP, root, L"diagnostics") && dir_exists(diagnostics))
        collect_diagnostics(wipe, diagnostics, externalConfig);
    return wipe->count;
}

BOOL cx_wipe_has_pending(const CX_WIPE *wipe) {
    int i;
    if (!wipe) return FALSE;
    for (i = 0; i < wipe->count; ++i) if (wipe->pending[i]) return TRUE;
    return FALSE;
}

/* 对单个文件按策略尝试；返回 TRUE 表示已删除，FALSE 表示仍待处理。 */
static BOOL wipe_one(CX_WIPE *wipe, int index, int attempts) {
    int attempt;
    for (attempt = 0; attempt < attempts; ++attempt) {
        if (DeleteFileW(wipe->paths[index])) {
            wipe->pending[index] = FALSE;
            ++wipe->deleted;
            return TRUE;
        }
        if (attempt + 1 < attempts) Sleep((DWORD)wipe->delayMs);
    }
    ++wipe->failed;
    wipe->pending[index] = wipe->runtimeRetry && wipe->policy != CX_WIPE_IGNORE;
    return FALSE;
}

static DWORD WINAPI wipe_thread(LPVOID parameter) {
    CX_WIPE *wipe = (CX_WIPE *)parameter;
    for (;;) {
        int i, remaining = 0;
        Sleep(wipe->runtimeIntervalMs);
        if (InterlockedCompareExchange(&wipe->stop, 1, 1) == 1) break;
        EnterCriticalSection(&wipe->lock);
        for (i = 0; i < wipe->count; ++i) {
            if (!wipe->pending[i]) continue;
            if (DeleteFileW(wipe->paths[i])) { wipe->pending[i] = FALSE; ++wipe->deleted; }
            else ++remaining;
        }
        LeaveCriticalSection(&wipe->lock);
        if (!remaining) break;
    }
    return 0;
}

BOOL cx_wipe_start(CX_WIPE *wipe) {
    int i, attempts, remaining = 0;
    if (!wipe) return TRUE;
    if (wipe->thread) return TRUE;
    attempts = wipe->policy == CX_WIPE_IGNORE ? 1 : (wipe->policy == CX_WIPE_BACKGROUND ? 1 : wipe->retries);
    for (i = 0; i < wipe->count; ++i) {
        if (!wipe->pending[i]) continue;
        if (!wipe_one(wipe, i, attempts)) ++remaining;
        if (wipe->policy == CX_WIPE_BACKGROUND && remaining) break;
        if (wipe->policy == CX_WIPE_ABORT && remaining) return FALSE;
    }
    if (wipe->policy == CX_WIPE_BACKGROUND) {
        for (; i < wipe->count; ++i) if (wipe->pending[i]) ++remaining;
    }
    if (remaining && wipe->runtimeRetry && wipe->policy != CX_WIPE_IGNORE) {
        wipe->thread = CreateThread(NULL, 0, wipe_thread, wipe, 0, NULL);
    }
    return !(wipe->policy == CX_WIPE_ABORT && cx_wipe_has_pending(wipe));
}

void cx_wipe_stop(CX_WIPE *wipe) {
    if (!wipe) return;
    InterlockedExchange(&wipe->stop, 1);
    if (wipe->thread) {
        WaitForSingleObject(wipe->thread, 10000);
        CloseHandle(wipe->thread);
        wipe->thread = NULL;
    }
}
