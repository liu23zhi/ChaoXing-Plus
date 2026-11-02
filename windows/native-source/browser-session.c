#include "browser-session.h"
#include "browser-extension.h"
#include "json.h"

#define BS_PATH_CAP 32768
#define BS_COMMAND_CAP 65536
#define BS_REPLY_CAP (1024UL * 1024UL)
#define BS_TOKEN_CAP 8192
#define BS_STARTUP_TIMEOUT 30000
#define BS_COMMAND_TIMEOUT 15000

struct CX_BROWSER_SESSION {
    HANDLE process;
    HANDLE job;
    HANDLE readPipe;
    HANDLE writePipe;
    DWORD pid;
    DWORD nextId;
    DWORD received;
    WCHAR root[BS_PATH_CAP];
    WCHAR profile[BS_PATH_CAP];
    WCHAR extension[BS_PATH_CAP];
    WCHAR extensionId[64];
    char *receive;
    BOOL cleaned;
    BOOL handshakeReady;
};

static void bs_error(WCHAR *out, DWORD cap, const WCHAR *message) {
    if (out && cap) lstrcpynW(out, message, (int)cap);
}

static DWORD bs_add(WCHAR *out, DWORD cap, DWORD at, const WCHAR *s) {
    if (!out || !cap || !s) return at;
    while (*s && at + 1 < cap) out[at++] = *s++;
    out[at < cap ? at : cap - 1] = 0;
    return at;
}

static DWORD bs_num(WCHAR *out, DWORD cap, DWORD at, ULONG_PTR n) {
    WCHAR digits[32]; DWORD count = 0;
    do { digits[count++] = (WCHAR)(L'0' + n % 10); n /= 10; } while (n);
    while (count && at + 1 < cap) out[at++] = digits[--count];
    out[at < cap ? at : cap - 1] = 0; return at;
}

static DWORD bs_arg(WCHAR *out, DWORD cap, DWORD at, const WCHAR *arg) {
    DWORD slashes = 0, i;
    if (!arg || at + 3 >= cap) return cap;
    at = bs_add(out, cap, at, L" \"");
    while (*arg) {
        if (*arg == L'\\') { ++slashes; ++arg; continue; }
        if (*arg == L'\"') { for (i = 0; i < slashes * 2 + 1; ++i) at = bs_add(out, cap, at, L"\\"); }
        else for (i = 0; i < slashes; ++i) at = bs_add(out, cap, at, L"\\");
        slashes = 0;
        if (at + 1 >= cap) return cap;
        out[at++] = *arg++; out[at] = 0;
    }
    for (i = 0; i < slashes * 2; ++i) at = bs_add(out, cap, at, L"\\");
    return bs_add(out, cap, at, L"\"");
}

static BOOL bs_text_add(char *out, DWORD cap, DWORD *at, const char *s) {
    while (*s) { if (*at + 1 >= cap) return FALSE; out[(*at)++] = *s++; }
    out[*at] = 0; return TRUE;
}

static BOOL bs_quote(char *out, DWORD cap, DWORD *at, const char *text) {
    if (!bs_text_add(out, cap, at, "\"")) return FALSE;
    while (*text) {
        BYTE c = (BYTE)*text++;
        if (c == '"' || c == '\\') { if (*at + 2 >= cap) return FALSE; out[(*at)++] = '\\'; out[(*at)++] = (char)c; }
        else if (c < 32) {
            static const char hex[] = "0123456789abcdef";
            if (*at + 6 >= cap) return FALSE;
            out[(*at)++] = '\\'; out[(*at)++] = 'u'; out[(*at)++] = '0'; out[(*at)++] = '0'; out[(*at)++] = hex[c >> 4]; out[(*at)++] = hex[c & 15];
        } else { if (*at + 1 >= cap) return FALSE; out[(*at)++] = (char)c; }
    }
    out[*at] = 0;
    return bs_text_add(out, cap, at, "\"");
}

static BOOL bs_wquote(char *out, DWORD cap, DWORD *at, const WCHAR *text) {
    char *utf8; int length; BOOL result;
    if (!text) text = L"";
    length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text, -1, NULL, 0, NULL, NULL);
    if (length <= 0) return FALSE;
    utf8 = (char *)HeapAlloc(GetProcessHeap(), 0, length); if (!utf8) return FALSE;
    result = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text, -1, utf8, length, NULL, NULL) && bs_quote(out, cap, at, utf8);
    HeapFree(GetProcessHeap(), 0, utf8); return result;
}

static BOOL bs_prefix(const char *s, const char *prefix) {
    while (*prefix) if (*s++ != *prefix++) return FALSE;
    return TRUE;
}

static BOOL bs_settings(const char *json) {
    JT *tokens; int count, i; char key[512]; BOOL ok = FALSE;
    if (!json || !*json) return TRUE;
    if (lstrlenA(json) > 65536) return FALSE;
    tokens = (JT *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, BS_TOKEN_CAP * sizeof(JT)); if (!tokens) return FALSE;
    count = jparse(json, lstrlenA(json), tokens, BS_TOKEN_CAP);
    if (count > 0 && tokens[0].type == '{') {
        ok = TRUE;
        for (i = 1; i < tokens[0].next;) {
            if (!jstr(json, tokens, i, key, sizeof(key)) || tokens[i].end - tokens[i].start != lstrlenA(key) || (!bs_prefix(key, "common.settings.") && !bs_prefix(key, "cx.new."))) { ok = FALSE; break; }
            i = tokens[i + 1].next;
        }
    }
    HeapFree(GetProcessHeap(), 0, tokens); return ok;
}

static BOOL bs_remove(const WCHAR *directory) {
    WIN32_FIND_DATAW entry; HANDLE search; WCHAR *pattern, *path; DWORD length; BOOL ok = TRUE;
    DWORD attributes = GetFileAttributesW(directory);
    if (attributes == INVALID_FILE_ATTRIBUTES) return GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND;
    if (!(attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return RemoveDirectoryW(directory);
    pattern = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, BS_PATH_CAP * sizeof(WCHAR)); path = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, BS_PATH_CAP * sizeof(WCHAR));
    if (!pattern || !path) { if (pattern) HeapFree(GetProcessHeap(), 0, pattern); if (path) HeapFree(GetProcessHeap(), 0, path); return FALSE; }
    length = (DWORD)lstrlenW(directory);
    if (length + 4 >= BS_PATH_CAP) { HeapFree(GetProcessHeap(), 0, pattern); HeapFree(GetProcessHeap(), 0, path); return FALSE; }
    lstrcpyW(pattern, directory); lstrcatW(pattern, L"\\*"); search = FindFirstFileW(pattern, &entry);
    if (search != INVALID_HANDLE_VALUE) {
        do {
            if (lstrcmpW(entry.cFileName, L".") == 0 || lstrcmpW(entry.cFileName, L"..") == 0) continue;
            if (length + 2 + (DWORD)lstrlenW(entry.cFileName) >= BS_PATH_CAP) { ok = FALSE; continue; }
            lstrcpyW(path, directory); lstrcatW(path, L"\\"); lstrcatW(path, entry.cFileName);
            if (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) { if (!bs_remove(path)) ok = FALSE; }
            else { SetFileAttributesW(path, FILE_ATTRIBUTE_NORMAL); if (!DeleteFileW(path)) ok = FALSE; }
        } while (FindNextFileW(search, &entry));
        FindClose(search);
    }
    if (!RemoveDirectoryW(directory)) ok = FALSE;
    HeapFree(GetProcessHeap(), 0, pattern); HeapFree(GetProcessHeap(), 0, path); return ok;
}

static BOOL bs_cleanup(CX_BROWSER_SESSION *s, WCHAR *error, DWORD cap) {
    DWORD i;
    if (s->cleaned) return TRUE;
    for (i = 0; i < 200; ++i) { if (bs_remove(s->root)) { s->cleaned = TRUE; return TRUE; } Sleep(50); }
    bs_error(error, cap, L"浏览器已退出，但临时资料仍被占用，请稍后重试清理。"); return FALSE;
}

static BOOL bs_wait_job_empty(CX_BROWSER_SESSION *s, DWORD timeout) {
    DWORD started = GetTickCount();
    if (!s || !s->job) return TRUE;
    for (;;) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
        ZeroMemory(&info, sizeof(info));
        if (!QueryInformationJobObject(s->job, JobObjectBasicAccountingInformation, &info, sizeof(info), NULL)) return FALSE;
        if (!info.ActiveProcesses) return TRUE;
        if ((DWORD)(GetTickCount() - started) >= timeout) return FALSE;
        Sleep(20);
    }
}

static BOOL bs_read(CX_BROWSER_SESSION *s, DWORD wanted, DWORD timeout, char **reply, WCHAR *error, DWORD cap) {
    DWORD started = GetTickCount(), available, got, i;
    JT *tokens = (JT *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, BS_TOKEN_CAP * sizeof(JT));
    if (!tokens) return FALSE;
    while ((DWORD)(GetTickCount() - started) < timeout) {
        for (i = 0; i < s->received; ++i) if (!s->receive[i]) {
            int count = jparse(s->receive, (int)i, tokens, BS_TOKEN_CAP);
            BOOL matching = count > 0 && jint(s->receive, tokens, jkey(s->receive, tokens, 0, "id"), -1) == (int)wanted;
            if (matching) {
                int errorToken = jkey(s->receive, tokens, 0, "error");
                if (errorToken >= 0) {
                    int message = jkey(s->receive, tokens, errorToken, "message");
                    if (!jwstr(s->receive, tokens, message, error, (int)cap)) bs_error(error, cap, L"浏览器拒绝扩展调试请求。");
                    HeapFree(GetProcessHeap(), 0, tokens); return FALSE;
                }
                *reply = (char *)HeapAlloc(GetProcessHeap(), 0, i + 1);
                if (!*reply) { HeapFree(GetProcessHeap(), 0, tokens); return FALSE; }
                CopyMemory(*reply, s->receive, i + 1);
            }
            { DWORD rest = s->received - i - 1, k; for (k = 0; k < rest; ++k) s->receive[k] = s->receive[i + 1 + k]; s->received = rest; }
            if (matching) { HeapFree(GetProcessHeap(), 0, tokens); return TRUE; }
            i = (DWORD)-1;
        }
        if (WaitForSingleObject(s->process, 0) == WAIT_OBJECT_0) { bs_error(error, cap, L"浏览器在扩展加载完成前退出。"); break; }
        if (!PeekNamedPipe(s->readPipe, NULL, 0, NULL, &available, NULL)) { bs_error(error, cap, L"浏览器调试管道已关闭。"); break; }
        if (available) {
            if (available > BS_REPLY_CAP - s->received - 1) { bs_error(error, cap, L"浏览器调试响应超过限制。"); break; }
            if (!ReadFile(s->readPipe, s->receive + s->received, available, &got, NULL)) break;
            s->received += got; s->receive[s->received] = 0;
        } else Sleep(5);
    }
    HeapFree(GetProcessHeap(), 0, tokens); if (error && cap && !error[0]) bs_error(error, cap, L"等待浏览器扩展调试响应超时。"); return FALSE;
}

static BOOL bs_command_wait(CX_BROWSER_SESSION *s, const char *method, const char *params, const char *sessionId, DWORD timeout, char **reply, WCHAR *error, DWORD cap) {
    char *command; DWORD at = 0, id = ++s->nextId, written, n; WCHAR idWide[24]; char idText[24]; BOOL result;
    if (reply) *reply = NULL;
    command = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, BS_COMMAND_CAP * 2); if (!command) return FALSE;
    idWide[0] = 0; bs_num(idWide, 24, 0, id); WideCharToMultiByte(CP_UTF8, 0, idWide, -1, idText, sizeof(idText), NULL, NULL);
    result = bs_text_add(command, BS_COMMAND_CAP * 2, &at, "{\"id\":") && bs_text_add(command, BS_COMMAND_CAP * 2, &at, idText) && bs_text_add(command, BS_COMMAND_CAP * 2, &at, ",\"method\":") && bs_quote(command, BS_COMMAND_CAP * 2, &at, method);
    if (result && sessionId) result = bs_text_add(command, BS_COMMAND_CAP * 2, &at, ",\"sessionId\":") && bs_quote(command, BS_COMMAND_CAP * 2, &at, sessionId);
    if (result) result = bs_text_add(command, BS_COMMAND_CAP * 2, &at, ",\"params\":") && bs_text_add(command, BS_COMMAND_CAP * 2, &at, params ? params : "{}") && bs_text_add(command, BS_COMMAND_CAP * 2, &at, "}");
    n = at + 1;
    if (result) result = WriteFile(s->writePipe, command, n, &written, NULL) && written == n;
    SecureZeroMemory(command, BS_COMMAND_CAP * 2); HeapFree(GetProcessHeap(), 0, command);
    if (!result) bs_error(error, cap, L"无法发送浏览器扩展调试请求。");
    else result = bs_read(s, id, timeout, reply, error, cap);
    if (!result && error && cap) {
        WCHAR detail[1024], methodWide[128]; DWORD position;
        lstrcpynW(detail, error, 1024);
        if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, method, -1, methodWide, 128)) {
            error[0] = 0; position = bs_add(error, cap, 0, L"["); position = bs_add(error, cap, position, methodWide);
            position = bs_add(error, cap, position, L"] "); bs_add(error, cap, position, detail);
        }
    }
    return result;
}

static BOOL bs_command(CX_BROWSER_SESSION *s, const char *method, const char *params, const char *sessionId, char **reply, WCHAR *error, DWORD cap) {
    return bs_command_wait(s, method, params, sessionId, BS_COMMAND_TIMEOUT, reply, error, cap);
}

static BOOL bs_reply_string(const char *reply, const char *key, char *out, DWORD cap) {
    JT *tokens = (JT *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, BS_TOKEN_CAP * sizeof(JT)); int count, resultToken, value; BOOL result = FALSE;
    if (!tokens) return FALSE;
    count = jparse(reply, lstrlenA(reply), tokens, BS_TOKEN_CAP);
    resultToken = count > 0 ? jkey(reply, tokens, 0, "result") : -1; value = resultToken >= 0 ? jkey(reply, tokens, resultToken, key) : -1;
    if (value >= 0) result = jstr(reply, tokens, value, out, (int)cap);
    HeapFree(GetProcessHeap(), 0, tokens); return result;
}

static BOOL bs_close_blank_tabs(CX_BROWSER_SESSION *s, const char *keepTarget, WCHAR *error, DWORD cap) {
    char *reply = NULL, *closed = NULL, id[128], params[256]; int count, result, targets, i; DWORD at; BOOL ok = FALSE;
    JT *tokens = (JT *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, BS_TOKEN_CAP * sizeof(JT));
    if (!tokens || !bs_command(s, "Target.getTargets", NULL, NULL, &reply, error, cap)) goto done;
    count = jparse(reply, lstrlenA(reply), tokens, BS_TOKEN_CAP); result = count > 0 ? jkey(reply, tokens, 0, "result") : -1;
    targets = jkey(reply, tokens, result, "targetInfos"); if (targets < 0 || tokens[targets].type != '[') goto done;
    for (i = targets + 1; i < tokens[targets].next; i = tokens[i].next) {
        if (!jeq(reply, tokens, jkey(reply, tokens, i, "type"), "page") || !jeq(reply, tokens, jkey(reply, tokens, i, "url"), "about:blank")) continue;
        if (!jstr(reply, tokens, jkey(reply, tokens, i, "targetId"), id, sizeof(id)) || lstrcmpA(id, keepTarget) == 0) continue;
        at = 0; if (!bs_text_add(params, sizeof(params), &at, "{\"targetId\":") || !bs_quote(params, sizeof(params), &at, id) || !bs_text_add(params, sizeof(params), &at, "}")) goto done;
        if (!bs_command(s, "Target.closeTarget", params, NULL, &closed, error, cap)) goto done; HeapFree(GetProcessHeap(), 0, closed); closed = NULL;
    }
    ok = TRUE;
done:
    if (closed) HeapFree(GetProcessHeap(), 0, closed); if (reply) HeapFree(GetProcessHeap(), 0, reply); if (tokens) HeapFree(GetProcessHeap(), 0, tokens); return ok;
}

static BOOL bs_wait_extension(CX_BROWSER_SESSION *s, const char *sessionId, WCHAR *error, DWORD cap) {
    char *reply = NULL; DWORD started = GetTickCount(); int result, tree, frame, url; BOOL ready = FALSE;
    JT *tokens = (JT *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, BS_TOKEN_CAP * sizeof(JT)); if (!tokens) return FALSE;
    do {
        if (!bs_command(s, "Page.getFrameTree", NULL, sessionId, &reply, error, cap)) break;
        result = jparse(reply, lstrlenA(reply), tokens, BS_TOKEN_CAP) > 0 ? jkey(reply, tokens, 0, "result") : -1;
        tree = jkey(reply, tokens, result, "frameTree"); frame = jkey(reply, tokens, tree, "frame"); url = jkey(reply, tokens, frame, "url");
        if (url >= 0 && tokens[url].type == 's' && tokens[url].end - tokens[url].start > 19 && bs_prefix(reply + tokens[url].start, "chrome-extension://")) ready = TRUE;
        HeapFree(GetProcessHeap(), 0, reply); reply = NULL; if (ready) break; Sleep(20);
    } while ((DWORD)(GetTickCount() - started) < 10000);
    if (reply) HeapFree(GetProcessHeap(), 0, reply); HeapFree(GetProcessHeap(), 0, tokens);
    if (!ready && (!error || !cap || !error[0])) bs_error(error, cap, L"等待扩展设置上下文超时。"); return ready;
}

static BOOL bs_launch(CX_BROWSER_SESSION *s, const CX_BROWSER_OPTIONS *options, WCHAR *error, DWORD cap) {
    SECURITY_ATTRIBUTES security = {sizeof(SECURITY_ATTRIBUTES), NULL, TRUE};
    HANDLE childRead = NULL, childWrite = NULL; STARTUPINFOEXW startup; PROCESS_INFORMATION info; SIZE_T attributesSize = 0;
    WCHAR *command = NULL, flag[256]; DWORD at = 0, i, flags; HANDLE inherited[2]; JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits; BOOL result = FALSE, attributesReady = FALSE;
    ZeroMemory(&startup, sizeof(startup)); ZeroMemory(&info, sizeof(info)); ZeroMemory(&limits, sizeof(limits)); startup.StartupInfo.cb = sizeof(startup);
    if (!CreatePipe(&childRead, &s->writePipe, &security, BS_REPLY_CAP) || !CreatePipe(&s->readPipe, &childWrite, &security, BS_REPLY_CAP)) goto done;
    SetHandleInformation(s->writePipe, HANDLE_FLAG_INHERIT, 0); SetHandleInformation(s->readPipe, HANDLE_FLAG_INHERIT, 0);
    inherited[0] = childRead; inherited[1] = childWrite;
    InitializeProcThreadAttributeList(NULL, 1, 0, &attributesSize);
    startup.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attributesSize);
    if (!startup.lpAttributeList || !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attributesSize)) goto done;
    attributesReady = TRUE;
    if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), NULL, NULL)) goto done;
    command = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, BS_COMMAND_CAP * sizeof(WCHAR)); if (!command) goto done;
    at = bs_arg(command, BS_COMMAND_CAP, 0, options->browserPath);
    flag[0] = 0; i = bs_add(flag, 256, 0, L"--remote-debugging-io-pipes="); i = bs_num(flag, 256, i, (ULONG_PTR)childRead); i = bs_add(flag, 256, i, L","); bs_num(flag, 256, i, (ULONG_PTR)childWrite);
    at = bs_arg(command, BS_COMMAND_CAP, at, flag);
    at = bs_arg(command, BS_COMMAND_CAP, at, L"--remote-debugging-pipe");
    at = bs_arg(command, BS_COMMAND_CAP, at, L"--enable-unsafe-extension-debugging");
    at = bs_arg(command, BS_COMMAND_CAP, at, L"--no-first-run");
    at = bs_arg(command, BS_COMMAND_CAP, at, L"--no-default-browser-check");
    at = bs_arg(command, BS_COMMAND_CAP, at, L"--disable-background-mode");
    at = bs_arg(command, BS_COMMAND_CAP, at, L"--disable-sync");
    at = bs_arg(command, BS_COMMAND_CAP, at, L"--disable-component-update");
    if (options->headless) at = bs_arg(command, BS_COMMAND_CAP, at, L"--headless=new");
    { WCHAR *profileArg = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, BS_PATH_CAP * sizeof(WCHAR)); if (!profileArg) goto done; i = bs_add(profileArg, BS_PATH_CAP, 0, L"--user-data-dir="); bs_add(profileArg, BS_PATH_CAP, i, s->profile); at = bs_arg(command, BS_COMMAND_CAP, at, profileArg); HeapFree(GetProcessHeap(), 0, profileArg); }
    at = bs_arg(command, BS_COMMAND_CAP, at, L"about:blank"); if (at >= BS_COMMAND_CAP - 1) goto done;
    s->job = CreateJobObjectW(NULL, NULL); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!s->job || !SetInformationJobObject(s->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) goto done;
    flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
    if (!CreateProcessW(options->browserPath, command + 1, NULL, NULL, TRUE, flags, NULL, NULL, &startup.StartupInfo, &info)) goto done;
    s->process = info.hProcess; s->pid = info.dwProcessId;
    if (!AssignProcessToJobObject(s->job, info.hProcess)) { TerminateProcess(info.hProcess, 1); CloseHandle(info.hThread); goto done; }
    ResumeThread(info.hThread); CloseHandle(info.hThread); result = TRUE;
done:
    if (startup.lpAttributeList) { if (attributesReady) DeleteProcThreadAttributeList(startup.lpAttributeList); HeapFree(GetProcessHeap(), 0, startup.lpAttributeList); }
    if (childRead) CloseHandle(childRead); if (childWrite) CloseHandle(childWrite); if (command) HeapFree(GetProcessHeap(), 0, command);
    if (!result) bs_error(error, cap, L"无法启动所选浏览器的独立临时会话。"); return result;
}

static BOOL bs_prepare(CX_BROWSER_SESSION *s, const CX_BROWSER_OPTIONS *options, WCHAR *error, DWORD cap) {
    WCHAR temp[MAX_PATH], unique[MAX_PATH]; DWORD n;
    if (!GetTempPathW(MAX_PATH, temp) || !GetTempFileNameW(temp, L"cxB", 0, unique) || !DeleteFileW(unique) || !CreateDirectoryW(unique, NULL)) { bs_error(error, cap, L"无法创建浏览器临时会话目录。"); return FALSE; }
    lstrcpyW(s->root, unique); n = (DWORD)lstrlenW(unique); if (n + 16 >= BS_PATH_CAP) return FALSE;
    lstrcpyW(s->profile, unique); lstrcatW(s->profile, L"\\profile"); lstrcpyW(s->extension, unique); lstrcatW(s->extension, L"\\extension");
    if (!CreateDirectoryW(s->profile, NULL) || !CreateDirectoryW(s->extension, NULL)) return FALSE;
    if (options->crxData && options->crxSize) {
        if (!cx_browser_extension_extract(options->crxData, options->crxSize, s->extension, s->extensionId, 64, error, cap)) return FALSE;
    } else if (!cx_browser_extension_extract_file(options->crxPath, s->extension, s->extensionId, 64, error, cap)) return FALSE;
    if (lstrcmpW(s->extensionId, options->expectedExtensionId && options->expectedExtensionId[0] ? options->expectedExtensionId : L"lcmeenlnjihhjcjoakekikoaldigonac") != 0) { bs_error(error, cap, L"扩展包身份与所选商店扩展不一致。"); return FALSE; }
    return TRUE;
}

BOOL cx_browser_start(const CX_BROWSER_OPTIONS *options, CX_BROWSER_SESSION **session, WCHAR *error, DWORD errorCapacity) {
    CX_BROWSER_SESSION *s; char *reply = NULL, *params = NULL; char extensionId[64], targetId[128], sessionId[128]; DWORD at; BOOL result = FALSE;
    if (session) *session = NULL; if (error && errorCapacity) error[0] = 0;
    if (!options || !session || !options->browserPath || (!options->crxPath && (!options->crxData || !options->crxSize)) || !bs_settings(options->settingsJsonUTF8)) { bs_error(error, errorCapacity, L"浏览器路径、扩展包或共享设置无效。"); return FALSE; }
    s = (CX_BROWSER_SESSION *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*s)); if (!s) return FALSE;
    s->receive = (char *)HeapAlloc(GetProcessHeap(), 0, BS_REPLY_CAP); params = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, BS_COMMAND_CAP * 2);
    if (!s->receive || !params || !bs_prepare(s, options, error, errorCapacity) || !bs_launch(s, options, error, errorCapacity)) goto done;
    /* A fresh installed browser needs a longer first protocol handshake than
       an already running page command. Keep one deadline and never relaunch. */
    if (!bs_command_wait(s, "Browser.getVersion", NULL, NULL, BS_STARTUP_TIMEOUT, &reply, error, errorCapacity)) goto done;
    s->handshakeReady = TRUE; HeapFree(GetProcessHeap(), 0, reply); reply = NULL;
    at = 0; if (!bs_text_add(params, BS_COMMAND_CAP * 2, &at, "{\"path\":") || !bs_wquote(params, BS_COMMAND_CAP * 2, &at, s->extension) || !bs_text_add(params, BS_COMMAND_CAP * 2, &at, "}")) goto done;
    if (!bs_command(s, "Extensions.loadUnpacked", params, NULL, &reply, error, errorCapacity) || !bs_reply_string(reply, "id", extensionId, sizeof(extensionId))) goto done;
    { WCHAR loadedId[64]; if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, extensionId, -1, loadedId, 64) || lstrcmpW(loadedId, s->extensionId) != 0) { bs_error(error, errorCapacity, L"浏览器加载的扩展标识与签名身份不一致。"); goto done; } }
    HeapFree(GetProcessHeap(), 0, reply); reply = NULL;
    at = 0; if (!bs_text_add(params, BS_COMMAND_CAP * 2, &at, "{\"url\":\"chrome-extension://") || !bs_text_add(params, BS_COMMAND_CAP * 2, &at, extensionId) || !bs_text_add(params, BS_COMMAND_CAP * 2, &at, "/manifest.json\"}")) goto done;
    if (!bs_command(s, "Target.createTarget", params, NULL, &reply, error, errorCapacity) || !bs_reply_string(reply, "targetId", targetId, sizeof(targetId))) goto done; HeapFree(GetProcessHeap(), 0, reply); reply = NULL;
    at = 0; if (!bs_text_add(params, BS_COMMAND_CAP * 2, &at, "{\"targetId\":") || !bs_quote(params, BS_COMMAND_CAP * 2, &at, targetId) || !bs_text_add(params, BS_COMMAND_CAP * 2, &at, ",\"flatten\":true}")) goto done;
    if (!bs_command(s, "Target.attachToTarget", params, NULL, &reply, error, errorCapacity) || !bs_reply_string(reply, "sessionId", sessionId, sizeof(sessionId))) goto done; HeapFree(GetProcessHeap(), 0, reply); reply = NULL;
    /* Extension storage belongs to its own page context, never to a generic tab. */
    if (!bs_wait_extension(s, sessionId, error, errorCapacity)) goto done;
    at = 0; if (!bs_text_add(params, BS_COMMAND_CAP * 2, &at, "{\"id\":") || !bs_quote(params, BS_COMMAND_CAP * 2, &at, extensionId) || !bs_text_add(params, BS_COMMAND_CAP * 2, &at, ",\"storageArea\":\"local\",\"values\":") || !bs_text_add(params, BS_COMMAND_CAP * 2, &at, options->settingsJsonUTF8 && options->settingsJsonUTF8[0] ? options->settingsJsonUTF8 : "{}") || !bs_text_add(params, BS_COMMAND_CAP * 2, &at, "}")) goto done;
    if (!bs_command(s, "Extensions.setStorageItems", params, sessionId, &reply, error, errorCapacity)) goto done; HeapFree(GetProcessHeap(), 0, reply); reply = NULL;
    at = 0; if (!bs_text_add(params, BS_COMMAND_CAP * 2, &at, "{\"url\":") || !bs_wquote(params, BS_COMMAND_CAP * 2, &at, options->initialUrl && options->initialUrl[0] ? options->initialUrl : L"https://www.chaoxing.com/") || !bs_text_add(params, BS_COMMAND_CAP * 2, &at, "}")) goto done;
    if (!bs_command(s, "Page.navigate", params, sessionId, &reply, error, errorCapacity)) goto done;
    { char navigationError[256]; if (bs_reply_string(reply, "errorText", navigationError, sizeof(navigationError)) && navigationError[0]) { bs_error(error, errorCapacity, L"浏览器无法打开所选学习页面。"); goto done; } }
    HeapFree(GetProcessHeap(), 0, reply); reply = NULL;
    if (!bs_close_blank_tabs(s, targetId, error, errorCapacity)) goto done;
    result = TRUE; *session = s;
done:
    if (reply) HeapFree(GetProcessHeap(), 0, reply); if (params) { SecureZeroMemory(params, BS_COMMAND_CAP * 2); HeapFree(GetProcessHeap(), 0, params); }
    if (!result) { (void)cx_browser_close(s, NULL, 0); cx_browser_destroy(s); if (error && errorCapacity && !error[0]) bs_error(error, errorCapacity, L"浏览器扩展加载失败。"); }
    return result;
}

BOOL cx_browser_poll(CX_BROWSER_SESSION *s, BOOL *running, WCHAR *error, DWORD errorCapacity) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
    if (running) *running = FALSE; if (!s || !running) return FALSE;
    ZeroMemory(&info, sizeof(info));
    if (s->job && !QueryInformationJobObject(s->job, JobObjectBasicAccountingInformation, &info, sizeof(info), NULL)) { bs_error(error, errorCapacity, L"无法确认临时浏览器进程状态。"); return FALSE; }
    *running = info.ActiveProcesses != 0;
    if (*running) return TRUE;
    return bs_cleanup(s, error, errorCapacity);
}

BOOL cx_browser_close(CX_BROWSER_SESSION *s, WCHAR *error, DWORD errorCapacity) {
    char *reply = NULL;
    if (!s) return TRUE;
    if (s->handshakeReady && s->process && WaitForSingleObject(s->process, 0) == WAIT_TIMEOUT && s->writePipe && s->readPipe) { (void)bs_command(s, "Browser.close", NULL, NULL, &reply, NULL, 0); if (reply) HeapFree(GetProcessHeap(), 0, reply); }
    if (!bs_wait_job_empty(s, 3000)) {
        if (s->job) TerminateJobObject(s->job, 0);
        if (!bs_wait_job_empty(s, 5000)) { bs_error(error, errorCapacity, L"无法等待临时浏览器进程组退出。"); return FALSE; }
    }
    if (s->process) WaitForSingleObject(s->process, 0);
    return bs_cleanup(s, error, errorCapacity);
}

void cx_browser_destroy(CX_BROWSER_SESSION *s) {
    DWORD i;
    if (!s) return;
    (void)cx_browser_close(s, NULL, 0);
    for (i = 0; !s->cleaned && i < 3; ++i) { Sleep(100); (void)bs_cleanup(s, NULL, 0); }
    if (s->job) CloseHandle(s->job); if (s->process) CloseHandle(s->process); if (s->readPipe) CloseHandle(s->readPipe); if (s->writePipe) CloseHandle(s->writePipe);
    if (s->receive) HeapFree(GetProcessHeap(), 0, s->receive); SecureZeroMemory(s, sizeof(*s)); HeapFree(GetProcessHeap(), 0, s);
}

DWORD cx_browser_pid(const CX_BROWSER_SESSION *s) { return s ? s->pid : 0; }
const WCHAR *cx_browser_profile(const CX_BROWSER_SESSION *s) { return s ? s->profile : L""; }
const WCHAR *cx_browser_extension_id(const CX_BROWSER_SESSION *s) { return s ? s->extensionId : L""; }

BOOL cx_browser_read_settings(CX_BROWSER_SESSION *s, char **json, WCHAR *error, DWORD cap) {
    char *params = NULL, *reply = NULL; char id[64], target[128], targetSession[128]; DWORD at; BOOL ok = FALSE;
    if (json) *json = NULL; if (!s || !json) return FALSE;
    params = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 4096); if (!params) return FALSE;
    WideCharToMultiByte(CP_UTF8, 0, s->extensionId, -1, id, sizeof(id), NULL, NULL);
    at = 0; if (!bs_text_add(params, 4096, &at, "{\"url\":\"chrome-extension://") || !bs_text_add(params, 4096, &at, id) || !bs_text_add(params, 4096, &at, "/manifest.json\"}")) goto done;
    if (!bs_command(s, "Target.createTarget", params, NULL, &reply, error, cap) || !bs_reply_string(reply, "targetId", target, sizeof(target))) goto done; HeapFree(GetProcessHeap(), 0, reply); reply = NULL;
    at = 0; if (!bs_text_add(params, 4096, &at, "{\"targetId\":") || !bs_quote(params, 4096, &at, target) || !bs_text_add(params, 4096, &at, ",\"flatten\":true}")) goto done;
    if (!bs_command(s, "Target.attachToTarget", params, NULL, &reply, error, cap) || !bs_reply_string(reply, "sessionId", targetSession, sizeof(targetSession))) goto done; HeapFree(GetProcessHeap(), 0, reply); reply = NULL;
    if (!bs_wait_extension(s, targetSession, error, cap)) goto done;
    at = 0; if (!bs_text_add(params, 4096, &at, "{\"id\":") || !bs_quote(params, 4096, &at, id) || !bs_text_add(params, 4096, &at, ",\"storageArea\":\"local\"}")) goto done;
    ok = bs_command(s, "Extensions.getStorageItems", params, targetSession, json, error, cap);
    at = 0; if (bs_text_add(params, 4096, &at, "{\"targetId\":") && bs_quote(params, 4096, &at, target) && bs_text_add(params, 4096, &at, "}")) { (void)bs_command(s, "Target.closeTarget", params, NULL, &reply, NULL, 0); }
done:
    if (reply) HeapFree(GetProcessHeap(), 0, reply); if (params) HeapFree(GetProcessHeap(), 0, params); return ok;
}
