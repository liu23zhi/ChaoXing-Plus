/* Included in the native host. No credentials, general commands, or CRT dependency. */
#include "ordinary-channel.h"
#include <shellapi.h>
#include <shlobj.h>

#define CX_OC_UUID 36
#define CX_OC_EXTENSION 32
#define CX_OC_NAME 64
#define CX_OC_PIPE 96
#define CX_OC_PATH 1024
#define CX_OC_MESSAGE 160
#define CX_OC_IO_MS 1500
#define CX_OC_RESULT_MS 15000
#define CX_OC_PIPE_CLIENT_RIGHTS (FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE)

static const WCHAR cx_oc_origin_prefix[] = L"chrome-extension://";
static const WCHAR cx_oc_window_prefix[] = L"--parent-window=";
static const WCHAR cx_oc_chrome_key[] = L"Software\\Google\\Chrome\\NativeMessagingHosts";
static const WCHAR cx_oc_edge_key[] = L"Software\\Microsoft\\Edge\\NativeMessagingHosts";

typedef struct CX_OC_REQUEST {
    BYTE version;
    char extension[CX_OC_EXTENSION];
    char instance[CX_OC_UUID];
} CX_OC_REQUEST;

struct CX_ORDINARY_CHANNEL {
    CX_OC_REQUEST expected;
    WCHAR name[CX_OC_NAME], pipeName[CX_OC_PIPE], key[128];
    WCHAR directory[MAX_PATH + CX_OC_UUID + 32], manifest[MAX_PATH + CX_OC_UUID + 64];
    HANDLE stop, pipe, worker, job;
    SRWLOCK jobLock;
    HKEY registration;
    BOOL registeredValue, manifestOwned, directoryOwned;
    BY_HANDLE_FILE_INFORMATION manifestId;
    CX_ORDINARY_RESULT verify;
    void *context;
};

static BOOL cx_oc_uuid(const WCHAR *s) {
    int i;
    if (!s || lstrlenW(s) != CX_OC_UUID) return FALSE;
    for (i = 0; i < CX_OC_UUID; ++i) {
        WCHAR c = s[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (c != L'-') return FALSE;
        } else if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'))) return FALSE;
    }
    return TRUE;
}

static BOOL cx_oc_extension(const WCHAR *s, DWORD count) {
    DWORD i;
    if (!s || count != CX_OC_EXTENSION) return FALSE;
    for (i = 0; i < count; ++i) if (s[i] < L'a' || s[i] > L'p') return FALSE;
    return TRUE;
}

static BOOL cx_oc_wappend(WCHAR *out, DWORD cap, const WCHAR *suffix) {
    DWORD have = (DWORD)lstrlenW(out), extra = (DWORD)lstrlenW(suffix);
    if (have >= cap || extra >= cap - have) return FALSE;
    CopyMemory(out + have, suffix, (extra + 1) * sizeof(WCHAR));
    return TRUE;
}

static BOOL cx_oc_prefix(const WCHAR *s, const WCHAR *prefix, BOOL ignoreCase) {
    int n = lstrlenW(prefix);
    return lstrlenW(s) >= n && CompareStringOrdinal(s, n, prefix, n, ignoreCase) == CSTR_EQUAL;
}

static BOOL cx_oc_pipe_name(WCHAR out[CX_OC_PIPE], const WCHAR *instance) {
    out[0] = 0;
    return cx_oc_wappend(out, CX_OC_PIPE, L"\\\\.\\pipe\\org.cxplus.ordinary.") &&
           cx_oc_wappend(out, CX_OC_PIPE, instance);
}

static BOOL cx_oc_shape(const CX_OC_REQUEST *request, const CX_OC_REQUEST *expected) {
    int i;
    if (request->version != expected->version) return FALSE;
    for (i = 0; i < CX_OC_EXTENSION; ++i) if (request->extension[i] != expected->extension[i]) return FALSE;
    for (i = 0; i < CX_OC_UUID; ++i) if (request->instance[i] != expected->instance[i]) return FALSE;
    return TRUE;
}

static DWORD cx_oc_remaining(ULONGLONG deadline) {
    ULONGLONG now = GetTickCount64();
    return deadline > now ? (DWORD)(deadline - now) : 0;
}

static BOOL cx_oc_finish(HANDLE pipe, OVERLAPPED *ov, HANDLE stop, DWORD timeout, DWORD *count) {
    HANDLE events[2];
    DWORD result;
    events[0] = ov->hEvent;
    events[1] = stop;
    result = WaitForMultipleObjects(stop ? 2 : 1, events, FALSE, timeout);
    if (result == WAIT_OBJECT_0) return GetOverlappedResult(pipe, ov, count, FALSE);
    CancelIoEx(pipe, ov);
    /* Don't return while an overlapped operation can still refer to this stack. */
    GetOverlappedResult(pipe, ov, count, TRUE);
    return FALSE;
}

static BOOL cx_oc_transfer(HANDLE pipe, HANDLE stop, BOOL write, void *buffer, DWORD length, DWORD maxMs) {
    HANDLE event = CreateEventW(NULL, TRUE, FALSE, NULL);
    ULONGLONG deadline = GetTickCount64() + maxMs;
    DWORD done = 0;
    if (!event) return FALSE;
    while (done < length) {
        OVERLAPPED ov = {0};
        DWORD count = 0, remaining = cx_oc_remaining(deadline);
        BOOL ok;
        if (!remaining || (stop && WaitForSingleObject(stop, 0) != WAIT_TIMEOUT)) break;
        ResetEvent(event);
        ov.hEvent = event;
        if (write) ok = WriteFile(pipe, (BYTE *)buffer + done, length - done, &count, &ov);
        else ok = ReadFile(pipe, (BYTE *)buffer + done, length - done, &count, &ov);
        if (!ok && GetLastError() == ERROR_IO_PENDING) ok = cx_oc_finish(pipe, &ov, stop, remaining, &count);
        if (!ok || !count || count > length - done) break;
        done += count;
    }
    CloseHandle(event);
    return done == length;
}

static BOOL cx_oc_connect(HANDLE pipe, HANDLE stop, HANDLE event) {
    OVERLAPPED ov = {0};
    DWORD completed = 0, error;
    ResetEvent(event);
    ov.hEvent = event;
    if (ConnectNamedPipe(pipe, &ov)) return TRUE;
    error = GetLastError();
    if (error == ERROR_PIPE_CONNECTED || error == ERROR_NO_DATA) return TRUE;
    return error == ERROR_IO_PENDING && cx_oc_finish(pipe, &ov, stop, INFINITE, &completed);
}

/* The kernel supplies the pipe peer PID. Require the same application image and
 * Windows session in both directions; the parent also requires its owned job. */
static HANDLE cx_oc_peer(ULONG pid) {
    HANDLE process = NULL;
    WCHAR *images;
    DWORD ourSession, peerSession, ours = CX_OC_PATH, theirs = CX_OC_PATH;
    if (!pid || pid == GetCurrentProcessId() ||
        !ProcessIdToSessionId(GetCurrentProcessId(), &ourSession) ||
        !ProcessIdToSessionId(pid, &peerSession) || ourSession != peerSession) return NULL;
    images = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, 2 * CX_OC_PATH * sizeof(WCHAR));
    if (!images) return NULL;
    process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
    if (process && (!QueryFullProcessImageNameW(GetCurrentProcess(), 0, images, &ours) ||
                    !QueryFullProcessImageNameW(process, 0, images + CX_OC_PATH, &theirs) ||
                    CompareStringOrdinal(images, (int)ours, images + CX_OC_PATH, (int)theirs, TRUE) != CSTR_EQUAL ||
                    WaitForSingleObject(process, 0) != WAIT_TIMEOUT)) {
        CloseHandle(process);
        process = NULL;
    }
    HeapFree(GetProcessHeap(), 0, images);
    return process;
}

static HANDLE cx_oc_job_peer(CX_ORDINARY_CHANNEL *channel) {
    HANDLE peer, job;
    ULONG pid = 0;
    BOOL member = FALSE;
    AcquireSRWLockShared(&channel->jobLock);
    job = channel->job; /* Remains open until this worker has stopped. */
    ReleaseSRWLockShared(&channel->jobLock);
    if (!job || !GetNamedPipeClientProcessId(channel->pipe, &pid)) return NULL;
    peer = cx_oc_peer(pid);
    if (peer && (!IsProcessInJob(peer, job, &member) || !member)) {
        CloseHandle(peer);
        peer = NULL;
    }
    return peer;
}

static DWORD WINAPI cx_oc_serve(void *opaque) {
    CX_ORDINARY_CHANNEL *channel = (CX_ORDINARY_CHANNEL *)opaque;
    HANDLE event = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!event) return 1;
    while (WaitForSingleObject(channel->stop, 0) == WAIT_TIMEOUT) {
        HANDLE peer;
        if (!cx_oc_connect(channel->pipe, channel->stop, event)) break;
        peer = cx_oc_job_peer(channel);
        if (peer) {
            CX_OC_REQUEST request;
            BYTE answer = 0, received;
            BOOL valid = cx_oc_transfer(channel->pipe, channel->stop, FALSE, &request, sizeof(request), CX_OC_IO_MS);
            if (valid && cx_oc_shape(&request, &channel->expected) &&
                WaitForSingleObject(peer, 0) == WAIT_TIMEOUT &&
                WaitForSingleObject(channel->stop, 0) == WAIT_TIMEOUT) {
                answer = (BYTE)(channel->verify(channel->context) != FALSE);
            }
            if (valid && cx_oc_transfer(channel->pipe, channel->stop, TRUE, &answer, sizeof(answer), CX_OC_IO_MS)) {
                /* DisconnectNamedPipe discards unread data. Wait for a bounded read receipt,
                 * not FlushFileBuffers (which could wait forever on a peer). */
                cx_oc_transfer(channel->pipe, channel->stop, FALSE, &received, sizeof(received), CX_OC_IO_MS);
            }
            CloseHandle(peer);
        }
        DisconnectNamedPipe(channel->pipe);
    }
    CloseHandle(event);
    return 0;
}

static HANDLE cx_oc_create_pipe(const WCHAR *name) {
    union { TOKEN_GROUPS groups; BYTE bytes[256]; } logon;
    union { ACL acl; BYTE bytes[256]; } access;
    HANDLE token, pipe = INVALID_HANDLE_VALUE;
    DWORD size;
    SECURITY_DESCRIPTOR sd;
    SECURITY_ATTRIBUTES sa = {sizeof(sa), &sd, FALSE};
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return INVALID_HANDLE_VALUE;
    if (GetTokenInformation(token, TokenLogonSid, &logon, sizeof(logon), &size) &&
        logon.groups.GroupCount == 1 && IsValidSid(logon.groups.Groups[0].Sid) &&
        (logon.groups.Groups[0].Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID &&
        InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION) &&
        InitializeAcl(&access.acl, sizeof(access), ACL_REVISION) &&
        AddAccessAllowedAce(&access.acl, ACL_REVISION, CX_OC_PIPE_CLIENT_RIGHTS, logon.groups.Groups[0].Sid) &&
        SetSecurityDescriptorDacl(&sd, TRUE, &access.acl, FALSE)) {
        pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                               PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_REJECT_REMOTE_CLIENTS,
                               1, 256, 256, CX_OC_IO_MS, &sa);
    }
    CloseHandle(token);
    return pipe;
}

static CX_ORDINARY_CHANNEL *cx_oc_start(const WCHAR *instance, const WCHAR *extension,
                                        CX_ORDINARY_RESULT verify, void *context) {
    CX_ORDINARY_CHANNEL *channel;
    int i, at;
    if (!verify || !cx_oc_uuid(instance) || !extension || !cx_oc_extension(extension, (DWORD)lstrlenW(extension))) return NULL;
    channel = (CX_ORDINARY_CHANNEL *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*channel));
    if (!channel) return NULL;
    channel->expected.version = 1;
    for (i = 0; i < CX_OC_UUID; ++i) channel->expected.instance[i] = (char)instance[i];
    for (i = 0; i < CX_OC_EXTENSION; ++i) channel->expected.extension[i] = (char)extension[i];
    channel->verify = verify;
    channel->context = context;
    InitializeSRWLock(&channel->jobLock);
    if (cx_oc_pipe_name(channel->pipeName, instance) &&
        cx_oc_wappend(channel->name, CX_OC_NAME, L"org.cxplus.ordinary_")) {
        at = lstrlenW(channel->name);
        for (i = 0; i < CX_OC_UUID; ++i) if (instance[i] != L'-') channel->name[at++] = instance[i];
        channel->name[at] = 0;
        channel->pipe = cx_oc_create_pipe(channel->pipeName);
        channel->stop = CreateEventW(NULL, TRUE, FALSE, NULL);
        if (channel->pipe != INVALID_HANDLE_VALUE && channel->stop)
            channel->worker = CreateThread(NULL, 0, cx_oc_serve, channel, 0, NULL);
    }
    if (channel->worker) return channel;
    cx_ordinary_channel_close(channel);
    return NULL;
}

typedef struct CX_OC_MANIFEST_JSON {
    WCHAR exe[CX_OC_PATH];
    char utf8[CX_OC_PATH * 3];
    char json[CX_OC_PATH * 3 + 512];
} CX_OC_MANIFEST_JSON;

static void cx_oc_text(char **out, const char *value) {
    while (*value) *(*out)++ = *value++;
}

static BOOL cx_oc_manifest(CX_ORDINARY_CHANNEL *channel, const WCHAR *instance) {
    WCHAR appData[MAX_PATH];
    CX_OC_MANIFEST_JSON *data = NULL;
    HANDLE file = INVALID_HANDLE_VALUE;
    BOOL ok = FALSE;
    DWORD size, written;
    char *out, *p;
    int i;
    if (FAILED(SHGetFolderPathW(NULL, CSIDL_LOCAL_APPDATA, NULL, SHGFP_TYPE_CURRENT, appData)) ||
        !cx_oc_wappend(channel->directory, ARRAYSIZE(channel->directory), appData) ||
        !cx_oc_wappend(channel->directory, ARRAYSIZE(channel->directory), L"\\CXPlus-ordinary-") ||
        !cx_oc_wappend(channel->directory, ARRAYSIZE(channel->directory), instance) ||
        !cx_oc_wappend(channel->manifest, ARRAYSIZE(channel->manifest), channel->directory) ||
        !cx_oc_wappend(channel->manifest, ARRAYSIZE(channel->manifest), L"\\native-host.json")) return FALSE;
    data = (CX_OC_MANIFEST_JSON *)HeapAlloc(GetProcessHeap(), 0, sizeof(*data));
    if (!data) return FALSE;
    size = GetModuleFileNameW(NULL, data->exe, ARRAYSIZE(data->exe));
    if (!size || size >= ARRAYSIZE(data->exe) ||
        !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, data->exe, -1, data->utf8, sizeof(data->utf8), NULL, NULL))
        goto done;
    out = data->json;
    cx_oc_text(&out, "{\"name\":\"");
    for (i = 0; channel->name[i]; ++i) *out++ = (char)channel->name[i];
    cx_oc_text(&out, "\",\"description\":\"CXPlus ordinary authorization result\",\"path\":\"");
    for (p = data->utf8; *p; ++p) {
        if ((BYTE)*p < 0x20) goto done;
        if (*p == '"' || *p == '\\') *out++ = '\\';
        *out++ = *p;
    }
    cx_oc_text(&out, "\",\"type\":\"stdio\",\"allowed_origins\":[\"chrome-extension://");
    for (i = 0; i < CX_OC_EXTENSION; ++i) *out++ = channel->expected.extension[i];
    cx_oc_text(&out, "/\"]}");
    size = (DWORD)(out - data->json);
    if (!CreateDirectoryW(channel->directory, NULL)) goto done;
    channel->directoryOwned = TRUE;
    file = CreateFileW(channel->manifest, GENERIC_WRITE | FILE_READ_ATTRIBUTES | DELETE, 0, NULL, CREATE_NEW,
                       FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (file == INVALID_HANDLE_VALUE) goto done;
    if (!GetFileInformationByHandle(file, &channel->manifestId)) {
        FILE_DISPOSITION_INFO discard = {TRUE};
        SetFileInformationByHandle(file, FileDispositionInfo, &discard, sizeof(discard));
        goto done;
    }
    channel->manifestOwned = TRUE;
    ok = WriteFile(file, data->json, size, &written, NULL) && written == size;
done:
    if (file != INVALID_HANDLE_VALUE && !CloseHandle(file)) ok = FALSE;
    HeapFree(GetProcessHeap(), 0, data);
    return ok;
}

static BOOL cx_oc_register(CX_ORDINARY_CHANNEL *channel, const WCHAR *base) {
    DWORD disposition;
    HKEY parent = NULL, key = NULL;
    LONG status;
    if (!cx_oc_wappend(channel->key, ARRAYSIZE(channel->key), base) ||
        !cx_oc_wappend(channel->key, ARRAYSIZE(channel->key), L"\\") ||
        !cx_oc_wappend(channel->key, ARRAYSIZE(channel->key), channel->name)) return FALSE;
    status = RegOpenKeyExW(HKEY_CURRENT_USER, channel->key, 0, KEY_QUERY_VALUE | KEY_WOW64_64KEY, &key);
    if (key) RegCloseKey(key);
    if (status != ERROR_FILE_NOT_FOUND && status != ERROR_PATH_NOT_FOUND) return FALSE;
    key = NULL;
    /* On first use create missing standard containers as nonvolatile so other
     * installers can use them. They hold no settings; never remove shared containers.
     * Only our uniquely named leaf is volatile and belongs to this instance. */
    if (RegCreateKeyExW(HKEY_CURRENT_USER, base, 0, NULL, REG_OPTION_NON_VOLATILE,
                        KEY_CREATE_SUB_KEY | KEY_WOW64_32KEY, NULL, &parent, NULL) != ERROR_SUCCESS) return FALSE;
    status = RegCreateKeyExW(parent, channel->name, 0, NULL, REG_OPTION_VOLATILE,
                             KEY_QUERY_VALUE | KEY_SET_VALUE | KEY_WOW64_32KEY, NULL, &key, &disposition);
    RegCloseKey(parent);
    if (status != ERROR_SUCCESS) return FALSE;
    if (disposition != REG_CREATED_NEW_KEY) {
        RegCloseKey(key);
        return FALSE;
    }
    channel->registration = key;
    channel->registeredValue = RegSetValueExW(key, NULL, 0, REG_SZ, (const BYTE *)channel->manifest,
                                              ((DWORD)lstrlenW(channel->manifest) + 1) * sizeof(WCHAR)) == ERROR_SUCCESS;
    return channel->registeredValue;
}

BOOL cx_ordinary_channel_open(const WCHAR *instance, const WCHAR *extensionId, const WCHAR *browserKind,
                              CX_ORDINARY_RESULT verify, void *context, CX_ORDINARY_CHANNEL **out) {
    const WCHAR *base;
    CX_ORDINARY_CHANNEL *channel;
    if (!out) return FALSE;
    *out = NULL;
    if (!browserKind) return FALSE;
    if (CompareStringOrdinal(browserKind, -1, L"chrome", -1, TRUE) == CSTR_EQUAL) base = cx_oc_chrome_key;
    else if (CompareStringOrdinal(browserKind, -1, L"edge", -1, TRUE) == CSTR_EQUAL) base = cx_oc_edge_key;
    else return FALSE;
    channel = cx_oc_start(instance, extensionId, verify, context);
    if (!channel) return FALSE;
    if (!cx_oc_manifest(channel, instance) || !cx_oc_register(channel, base)) {
        cx_ordinary_channel_close(channel);
        return FALSE;
    }
    *out = channel;
    return TRUE;
}

const WCHAR *cx_ordinary_channel_name(const CX_ORDINARY_CHANNEL *channel) {
    return channel ? channel->name : NULL;
}

BOOL cx_ordinary_channel_attach_job(CX_ORDINARY_CHANNEL *channel, HANDLE ownedBrowserJob) {
    HANDLE query = NULL;
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    BOOL attached = FALSE;
    if (!channel || !ownedBrowserJob ||
        !DuplicateHandle(GetCurrentProcess(), ownedBrowserJob, GetCurrentProcess(), &query, JOB_OBJECT_QUERY, FALSE, 0))
        return FALSE;
    /* DuplicateHandle alone doesn't establish object type. */
    if (QueryInformationJobObject(query, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL)) {
        AcquireSRWLockExclusive(&channel->jobLock);
        if (!channel->job) { channel->job = query; attached = TRUE; }
        ReleaseSRWLockExclusive(&channel->jobLock);
    }
    if (!attached) CloseHandle(query);
    return attached;
}

static void cx_oc_unregister(CX_ORDINARY_CHANNEL *channel) {
    if (channel->registration) {
        DWORD subkeys = 0, values = 0;
        BOOL own = FALSE;
        if (RegQueryInfoKeyW(channel->registration, NULL, NULL, NULL, &subkeys, NULL, NULL, &values,
                             NULL, NULL, NULL, NULL) == ERROR_SUCCESS && !subkeys) {
            own = !channel->registeredValue && values == 0;
            if (channel->registeredValue && values == 1) {
                WCHAR path[ARRAYSIZE(channel->manifest)] = {0};
                DWORD bytes = sizeof(path), kind = 0;
                own = RegQueryValueExW(channel->registration, NULL, NULL, &kind, (BYTE *)path, &bytes) == ERROR_SUCCESS &&
                      kind == REG_SZ && bytes == ((DWORD)lstrlenW(channel->manifest) + 1) * sizeof(WCHAR) &&
                      path[bytes / sizeof(WCHAR) - 1] == 0 &&
                      CompareStringOrdinal(path, -1, channel->manifest, -1, FALSE) == CSTR_EQUAL;
            }
        }
        if (own) RegDeleteKeyExW(HKEY_CURRENT_USER, channel->key, KEY_WOW64_32KEY, 0);
        RegCloseKey(channel->registration);
    }
    if (channel->manifestOwned) {
        HANDLE file = CreateFileW(channel->manifest, FILE_READ_ATTRIBUTES | DELETE,
                                  FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
                                  FILE_FLAG_OPEN_REPARSE_POINT, NULL);
        if (file != INVALID_HANDLE_VALUE) {
            BY_HANDLE_FILE_INFORMATION id;
            if (GetFileInformationByHandle(file, &id) && !(id.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
                id.dwVolumeSerialNumber == channel->manifestId.dwVolumeSerialNumber &&
                id.nFileIndexHigh == channel->manifestId.nFileIndexHigh && id.nFileIndexLow == channel->manifestId.nFileIndexLow) {
                FILE_DISPOSITION_INFO discard = {TRUE};
                SetFileInformationByHandle(file, FileDispositionInfo, &discard, sizeof(discard));
            }
            CloseHandle(file);
        }
    }
    if (channel->directoryOwned) RemoveDirectoryW(channel->directory); /* Empty owned directory only. */
}

void cx_ordinary_channel_close(CX_ORDINARY_CHANNEL *channel) {
    if (!channel) return;
    if (channel->stop) SetEvent(channel->stop);
    if (channel->worker) {
        WaitForSingleObject(channel->worker, INFINITE); /* verifier owns its bounded network deadline */
        CloseHandle(channel->worker);
    }
    if (channel->pipe && channel->pipe != INVALID_HANDLE_VALUE) CloseHandle(channel->pipe);
    if (channel->stop) CloseHandle(channel->stop);
    if (channel->job) CloseHandle(channel->job);
    cx_oc_unregister(channel);
    HeapFree(GetProcessHeap(), 0, channel);
}

static void cx_oc_space(const char **cursor, const char *end) {
    while (*cursor < end && (**cursor == ' ' || **cursor == '\r' || **cursor == '\n' || **cursor == '\t')) ++*cursor;
}

static BOOL cx_oc_take(const char **cursor, const char *end, const char *token) {
    const char *p = *cursor;
    while (*token && p < end && *p == *token) { ++p; ++token; }
    if (*token) return FALSE;
    *cursor = p;
    return TRUE;
}

static BOOL cx_oc_parse(const char *message, DWORD bytes, WCHAR instance[CX_OC_UUID + 1]) {
    const char *p = message, *end = message + bytes;
    BOOL op = FALSE, scope = FALSE;
    int field, i;
    cx_oc_space(&p, end);
    if (!cx_oc_take(&p, end, "{")) return FALSE;
    for (field = 0; field < 2; ++field) {
        BOOL isOp;
        cx_oc_space(&p, end);
        isOp = cx_oc_take(&p, end, "\"op\"");
        if (!isOp && !cx_oc_take(&p, end, "\"instance\"")) return FALSE;
        cx_oc_space(&p, end);
        if (!cx_oc_take(&p, end, ":")) return FALSE;
        cx_oc_space(&p, end);
        if (isOp) {
            if (op || !cx_oc_take(&p, end, "\"authorize\"")) return FALSE;
            op = TRUE;
        } else {
            if (scope || !cx_oc_take(&p, end, "\"") || end - p < CX_OC_UUID) return FALSE;
            for (i = 0; i < CX_OC_UUID; ++i) instance[i] = (BYTE)*p++;
            instance[CX_OC_UUID] = 0;
            if (!cx_oc_uuid(instance) || !cx_oc_take(&p, end, "\"")) return FALSE;
            scope = TRUE;
        }
        cx_oc_space(&p, end);
        if (!cx_oc_take(&p, end, field == 0 ? "," : "}")) return FALSE;
    }
    cx_oc_space(&p, end);
    return op && scope && p == end;
}

static HANDLE cx_oc_client(const WCHAR *pipeName) {
    HANDLE pipe;
    ULONGLONG deadline = GetTickCount64() + CX_OC_IO_MS;
    DWORD remaining;
    do {
        pipe = CreateFileW(pipeName, CX_OC_PIPE_CLIENT_RIGHTS, 0, NULL, OPEN_EXISTING,
                           FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS, NULL);
        if (pipe != INVALID_HANDLE_VALUE) return pipe;
        if (GetLastError() != ERROR_PIPE_BUSY) break;
        remaining = cx_oc_remaining(deadline);
    } while (remaining && WaitNamedPipeW(pipeName, remaining));
    return INVALID_HANDLE_VALUE;
}

static BOOL cx_oc_ask(const WCHAR *instance, const WCHAR *extension) {
    WCHAR pipeName[CX_OC_PIPE];
    CX_OC_REQUEST request;
    HANDLE pipe, peer = NULL;
    ULONG pid = 0;
    int i;
    BYTE answer = 0, readReceipt = 1;
    BOOL allowed = FALSE;
    if (!cx_oc_pipe_name(pipeName, instance)) return FALSE;
    pipe = cx_oc_client(pipeName);
    if (pipe == INVALID_HANDLE_VALUE) return FALSE;
    if (GetNamedPipeServerProcessId(pipe, &pid)) peer = cx_oc_peer(pid);
    if (peer) {
        request.version = 1;
        for (i = 0; i < CX_OC_EXTENSION; ++i) request.extension[i] = (char)extension[i];
        for (i = 0; i < CX_OC_UUID; ++i) request.instance[i] = (char)instance[i];
        if (cx_oc_transfer(pipe, NULL, TRUE, &request, sizeof(request), CX_OC_IO_MS) &&
            cx_oc_transfer(pipe, NULL, FALSE, &answer, sizeof(answer), CX_OC_RESULT_MS)) {
            allowed = answer == 1 && WaitForSingleObject(peer, 0) == WAIT_TIMEOUT;
            cx_oc_transfer(pipe, NULL, TRUE, &readReceipt, sizeof(readReceipt), CX_OC_IO_MS);
        }
        CloseHandle(peer);
    }
    CloseHandle(pipe);
    return allowed;
}

static BOOL cx_oc_read_native(HANDLE input, void *data, DWORD count, ULONGLONG deadline) {
    DWORD done = 0;
    /* Chromium gives us fresh stdio pipes (which can be synchronous). Only
     * read bytes already present so malformed/truncated input has a deadline. */
    while (done < count && cx_oc_remaining(deadline)) {
        DWORD available = 0, copied = 0;
        if (!PeekNamedPipe(input, NULL, 0, NULL, &available, NULL)) return FALSE;
        if (!available) { Sleep(5); continue; }
        if (available > count - done) available = count - done;
        if (!ReadFile(input, (BYTE *)data + done, available, &copied, NULL) || !copied) return FALSE;
        done += copied;
    }
    return done == count;
}

static BOOL cx_oc_write_native(HANDLE output, BOOL allowed) {
    static const char yes[] = "{\"allowed\":true}";
    static const char no[] = "{\"allowed\":false}";
    BYTE frame[sizeof(DWORD) + sizeof(no) - 1] = {0};
    DWORD length = (DWORD)(allowed ? sizeof(yes) : sizeof(no)) - 1, written;
    frame[0] = (BYTE)length; /* Little-endian Chrome message length on Windows. */
    CopyMemory(frame + sizeof(DWORD), allowed ? yes : no, length);
    return WriteFile(output, frame, sizeof(DWORD) + length, &written, NULL) &&
           written == sizeof(DWORD) + length;
}

static BOOL cx_oc_window(const WCHAR *arg) {
    int digits = 0;
    if (!cx_oc_prefix(arg, cx_oc_window_prefix, FALSE)) return FALSE;
    arg += ARRAYSIZE(cx_oc_window_prefix) - 1;
    while (*arg >= L'0' && *arg <= L'9' && digits < 20) { ++arg; ++digits; }
    return digits > 0 && !*arg;
}

BOOL cx_ordinary_channel_broker(int *exitCode) {
    int argc, i;
    WCHAR **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    BOOL handled = FALSE;
    if (!argv) { if (exitCode) *exitCode = 1; return TRUE; }
    for (i = 1; i < argc; ++i) {
        if (cx_oc_prefix(argv[i], L"chrome-extension:", TRUE) || cx_oc_prefix(argv[i], cx_oc_window_prefix, TRUE)) {
            handled = TRUE;
            break;
        }
    }
    if (handled) {
        HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE), input = GetStdHandle(STD_INPUT_HANDLE);
        BOOL allowed = FALSE, written = FALSE;
        if (GetFileType(output) == FILE_TYPE_PIPE) {
            if (argc == 3 && GetFileType(input) == FILE_TYPE_PIPE &&
                cx_oc_prefix(argv[1], cx_oc_origin_prefix, FALSE) &&
                lstrlenW(argv[1]) == (int)(ARRAYSIZE(cx_oc_origin_prefix) - 1 + CX_OC_EXTENSION + 1) &&
                cx_oc_extension(argv[1] + ARRAYSIZE(cx_oc_origin_prefix) - 1, CX_OC_EXTENSION) &&
                argv[1][ARRAYSIZE(cx_oc_origin_prefix) - 1 + CX_OC_EXTENSION] == L'/' && cx_oc_window(argv[2])) {
                DWORD length = 0;
                char request[CX_OC_MESSAGE];
                WCHAR instance[CX_OC_UUID + 1];
                ULONGLONG deadline = GetTickCount64() + CX_OC_IO_MS;
                if (cx_oc_read_native(input, &length, sizeof(length), deadline) &&
                    length && length <= sizeof(request) && cx_oc_read_native(input, request, length, deadline) &&
                    cx_oc_parse(request, length, instance)) {
                    allowed = cx_oc_ask(instance, argv[1] + ARRAYSIZE(cx_oc_origin_prefix) - 1);
                }
            }
            written = cx_oc_write_native(output, allowed);
        }
        if (exitCode) *exitCode = written ? 0 : 1;
    }
    LocalFree(argv);
    return handled;
}
