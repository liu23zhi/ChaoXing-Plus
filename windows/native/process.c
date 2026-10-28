#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <tlhelp32.h>
#include "process.h"

#define PROC_ROOT_LIMIT 16
#define PROC_SEEN_LIMIT 8192

typedef struct {
    DWORD pid;
    FILETIME created;
    HANDLE query;
} SeenProcess;

typedef struct {
    DWORD pid;
    SeenProcess *seen;
    DWORD count;
    DWORD capacity;
} OwnedRoot;

typedef struct { DWORD pid; DWORD parent; } ProcessNode;

static OwnedRoot roots[PROC_ROOT_LIMIT];
static volatile LONG rootLock;

static void p_zero(void *data, SIZE_T size) {
    volatile BYTE *p = (volatile BYTE *)data;
    while (size) { *p++ = 0; --size; }
}

static DWORD p_copy(WCHAR *out, DWORD cap, DWORD at, const WCHAR *s) {
    if (!out || !cap) return at;
    while (*s && at + 1 < cap) out[at++] = *s++;
    out[at < cap ? at : cap - 1] = 0;
    return at;
}

static DWORD p_decimal(WCHAR *out, DWORD cap, DWORD at, DWORD value) {
    WCHAR digits[16];
    DWORD count = 0;
    do { digits[count++] = (WCHAR)(L'0' + value % 10); value /= 10; } while (value);
    if (!out || !cap) return at;
    while (count && at + 1 < cap) out[at++] = digits[--count];
    out[at < cap ? at : cap - 1] = 0;
    return at;
}

static void p_error(WCHAR *err, DWORD cap, const WCHAR *text, DWORD code) {
    DWORD at = p_copy(err, cap, 0, text);
    if (code) { at = p_copy(err, cap, at, L" (Win32 "); at = p_decimal(err, cap, at, code); p_copy(err, cap, at, L")"); }
}

static void p_lock(void) {
    while (InterlockedCompareExchange(&rootLock, 1, 0) != 0) Sleep(0);
}

static void p_unlock(void) { InterlockedExchange(&rootLock, 0); }

static BOOL p_times(HANDLE handle, FILETIME *created, FILETIME *exited) {
    FILETIME kernel, user;
    return GetProcessTimes(handle, created, exited, &kernel, &user);
}

static BOOL p_time_equal(const FILETIME *a, const FILETIME *b) {
    return a->dwLowDateTime == b->dwLowDateTime && a->dwHighDateTime == b->dwHighDateTime;
}

static OwnedRoot *p_root(DWORD pid) {
    DWORD i;
    for (i = 0; i < PROC_ROOT_LIMIT; ++i) if (roots[i].pid == pid && pid) return &roots[i];
    return NULL;
}

static BOOL p_add(OwnedRoot *root, DWORD pid, HANDLE query, const FILETIME *created) {
    SeenProcess *memory;
    DWORD capacity;
    if (root->count == root->capacity) {
        capacity = root->capacity ? root->capacity * 2 : 32;
        if (capacity > PROC_SEEN_LIMIT) return FALSE;
        if (root->seen) memory = (SeenProcess *)HeapReAlloc(GetProcessHeap(), 0, root->seen, sizeof(SeenProcess) * capacity);
        else memory = (SeenProcess *)HeapAlloc(GetProcessHeap(), 0, sizeof(SeenProcess) * capacity);
        if (!memory) return FALSE;
        root->seen = memory;
        root->capacity = capacity;
    }
    root->seen[root->count].pid = pid;
    root->seen[root->count].created.dwLowDateTime = created->dwLowDateTime;
    root->seen[root->count].created.dwHighDateTime = created->dwHighDateTime;
    root->seen[root->count].query = query;
    ++root->count;
    return TRUE;
}

static void p_release(OwnedRoot *root) {
    DWORD i;
    for (i = 0; i < root->count; ++i) CloseHandle(root->seen[i].query);
    if (root->seen) HeapFree(GetProcessHeap(), 0, root->seen);
    p_zero(root, sizeof(*root));
}

static BOOL p_known(OwnedRoot *root, DWORD pid, const FILETIME *created) {
    DWORD i;
    for (i = 0; i < root->count; ++i)
        if (root->seen[i].pid == pid && p_time_equal(&root->seen[i].created, created)) return TRUE;
    return FALSE;
}

static BOOL p_parent_owned(OwnedRoot *root, DWORD parent, const FILETIME *childCreated) {
    DWORD i;
    FILETIME created, exited;
    for (i = 0; i < root->count; ++i) {
        if (root->seen[i].pid != parent) continue;
        if (!p_times(root->seen[i].query, &created, &exited)) continue;
        if (CompareFileTime(childCreated, &created) < 0) continue;
        /* Retained query handles preserve exit times across parent PID reuse. */
        if ((exited.dwLowDateTime || exited.dwHighDateTime) && CompareFileTime(childCreated, &exited) > 0) continue;
        return TRUE;
    }
    return FALSE;
}

static BOOL p_refresh(OwnedRoot *root) {
    HANDLE snapshot;
    PROCESSENTRY32W entry;
    ProcessNode *nodes = NULL, *resized;
    DWORD count = 0, capacity = 0, i, changed;
    BOOL result = TRUE;
    snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return FALSE;
    p_zero(&entry, sizeof(entry));
    entry.dwSize = sizeof(entry);
    if (!Process32FirstW(snapshot, &entry)) { CloseHandle(snapshot); return FALSE; }
    do {
        if (count == capacity) {
            capacity = capacity ? capacity * 2 : 256;
            if (capacity > 65536) { result = FALSE; break; }
            if (nodes) resized = (ProcessNode *)HeapReAlloc(GetProcessHeap(), 0, nodes, sizeof(ProcessNode) * capacity);
            else resized = (ProcessNode *)HeapAlloc(GetProcessHeap(), 0, sizeof(ProcessNode) * capacity);
            if (!resized) { result = FALSE; break; }
            nodes = resized;
        }
        nodes[count].pid = entry.th32ProcessID;
        nodes[count].parent = entry.th32ParentProcessID;
        ++count;
    } while (Process32NextW(snapshot, &entry));
    CloseHandle(snapshot);
    if (result) do {
        changed = 0;
        for (i = 0; i < count; ++i) {
            HANDLE query;
            FILETIME created, exited;
            DWORD j;
            BOOL possible = FALSE;
            if (!nodes[i].pid || nodes[i].pid == GetCurrentProcessId()) continue;
            for (j = 0; j < root->count; ++j) if (root->seen[j].pid == nodes[i].parent) { possible = TRUE; break; }
            if (!possible) continue;
            query = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, nodes[i].pid);
            if (!query) continue;
            if (!p_times(query, &created, &exited) || p_known(root, nodes[i].pid, &created)
                || !p_parent_owned(root, nodes[i].parent, &created)) { CloseHandle(query); continue; }
            if (!p_add(root, nodes[i].pid, query, &created)) { CloseHandle(query); result = FALSE; break; }
            ++changed;
        }
    } while (changed && result);
    if (nodes) HeapFree(GetProcessHeap(), 0, nodes);
    return result;
}

static void *p_tcp_table(ULONG family) {
    DWORD size = 0, code, attempt;
    void *table;
    code = GetExtendedTcpTable(NULL, &size, FALSE, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
    if (code != ERROR_INSUFFICIENT_BUFFER || !size) { SetLastError(code); return NULL; }
    for (attempt = 0; attempt < 4; ++attempt) {
        table = HeapAlloc(GetProcessHeap(), 0, size);
        if (!table) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return NULL; }
        code = GetExtendedTcpTable(table, &size, FALSE, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
        if (code == NO_ERROR) return table;
        HeapFree(GetProcessHeap(), 0, table);
        if (code != ERROR_INSUFFICIENT_BUFFER) break;
    }
    SetLastError(code);
    return NULL;
}

static USHORT p_network_port(USHORT port) { return (USHORT)((port << 8) | (port >> 8)); }

BOOL proc_port_free(USHORT port) {
    MIB_TCPTABLE_OWNER_PID *v4;
    MIB_TCP6TABLE_OWNER_PID *v6;
    DWORD i;
    BOOL free = TRUE;
    USHORT network = p_network_port(port);
    if (!port) return FALSE;
    v4 = (MIB_TCPTABLE_OWNER_PID *)p_tcp_table(AF_INET);
    if (!v4) return FALSE;
    for (i = 0; i < v4->dwNumEntries; ++i)
        if ((USHORT)v4->table[i].dwLocalPort == network) { free = FALSE; break; }
    HeapFree(GetProcessHeap(), 0, v4);
    if (!free) return FALSE;
    v6 = (MIB_TCP6TABLE_OWNER_PID *)p_tcp_table(AF_INET6);
    if (!v6) return GetLastError() == ERROR_NOT_SUPPORTED;
    for (i = 0; i < v6->dwNumEntries; ++i)
        if ((USHORT)v6->table[i].dwLocalPort == network) { free = FALSE; break; }
    HeapFree(GetProcessHeap(), 0, v6);
    return free;
}

BOOL proc_port_bindable(USHORT port, WCHAR *err, DWORD cap) {
    SOCKET sock;
    struct sockaddr_in address;
    int code;
    BOOL okay = FALSE;
    p_error(err, cap, L"", 0);
    if (!port) { p_error(err, cap, L"Invalid port", 0); return FALSE; }
    sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) { p_error(err, cap, L"socket() failed", WSAGetLastError()); return FALSE; }
    p_zero(&address, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    address.sin_addr.s_addr = htonl(0x7f000001UL);
    if (bind(sock, (struct sockaddr *)&address, sizeof(address)) == 0) okay = TRUE;
    else {
        code = WSAGetLastError();
        if (code == WSAEADDRINUSE) p_error(err, cap, L"port already in use (WSAEADDRINUSE)", code);
        else if (code == WSAEACCES) p_error(err, cap, L"port is inside a Windows excluded range; bind refused (WSAEACCES)", code);
        else p_error(err, cap, L"loopback bind failed", code);
    }
    closesocket(sock);
    return okay;
}

static BOOL p_name_equal(const WCHAR *left, const WCHAR *right) {
    DWORD i = 0;
    for (;;) {
        WCHAR a = left[i], b = right[i];
        if (a >= L'A' && a <= L'Z') a = (WCHAR)(a + 32);
        if (b >= L'A' && b <= L'Z') b = (WCHAR)(b + 32);
        if (a != b) return FALSE;
        if (!a) return TRUE;
        ++i;
    }
}

static BOOL p_instances(const WCHAR *exePath, DWORD *pids, DWORD pidCap, DWORD *total,
                         WCHAR *err, DWORD errorCap) {
    HANDLE snapshot = INVALID_HANDLE_VALUE;
    PROCESSENTRY32W entry;
    const WCHAR *name = exePath;
    DWORD self = GetCurrentProcessId(), i, count = 0, code = ERROR_INVALID_PARAMETER;
    BOOL ok = FALSE;
    if (total) *total = 0;
    p_error(err, errorCap, L"", 0);
    if (!exePath || !*exePath || !total) goto done;
    for (i = 0; exePath[i]; ++i) if (exePath[i] == L'\\' || exePath[i] == L'/') name = exePath + i + 1;
    if (!*name) goto done;
    snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) { code = GetLastError(); goto done; }
    p_zero(&entry, sizeof(entry));
    entry.dwSize = sizeof(entry);
    if (!Process32FirstW(snapshot, &entry)) {
        code = GetLastError(); ok = code == ERROR_NO_MORE_FILES; goto done;
    }
    for (;;) {
        if (entry.th32ProcessID && entry.th32ProcessID != self && p_name_equal(entry.szExeFile, name)) {
            if (count == MAXDWORD) { code = ERROR_ARITHMETIC_OVERFLOW; goto done; }
            if (pids && count < pidCap) pids[count] = entry.th32ProcessID;
            ++count;
        }
        if (!Process32NextW(snapshot, &entry)) {
            code = GetLastError(); ok = code == ERROR_NO_MORE_FILES; break;
        }
    }
done:
    if (snapshot != INVALID_HANDLE_VALUE) CloseHandle(snapshot);
    if (ok) { *total = count; code = ERROR_SUCCESS; }
    else {
        if (!code) code = ERROR_GEN_FAILURE;
        p_error(err, errorCap, L"Cannot reliably inspect running client processes", code);
    }
    SetLastError(code); return ok;
}

BOOL proc_check_instances(const WCHAR *exePath, DWORD *count, WCHAR *err, DWORD cap) {
    return p_instances(exePath, NULL, 0, count, err, cap);
}

int proc_instances(const WCHAR *exePath, DWORD *pids, int cap) {
    DWORD count;
    if (cap < 0) { SetLastError(ERROR_INVALID_PARAMETER); return -1; }
    if (!p_instances(exePath, pids, (DWORD)cap, &count, NULL, 0)) return -1;
    if (count > 2147483647UL) { SetLastError(ERROR_ARITHMETIC_OVERFLOW); return -1; }
    return (int)count;
}

BOOL proc_launch(const WCHAR *path, USHORT port, DWORD *pid, HANDLE *handle, WCHAR *err, DWORD cap) {
    WCHAR *full = NULL, *directory = NULL, *command = NULL;
    DWORD length, i, at, code = 0, slot, running;
    STARTUPINFOW startup;
    PROCESS_INFORMATION info;
    FILETIME created, exited;
    HANDLE query = NULL;
    BOOL launched = FALSE;
    if (pid) *pid = 0;
    if (handle) *handle = NULL;
    p_error(err, cap, L"", 0);
    if (!path || !*path || !pid || !handle || !port) { p_error(err, cap, L"Invalid launch arguments", 0); return FALSE; }
    if (!proc_port_free(port)) { p_error(err, cap, L"Debug port is occupied or cannot be inspected", 0); return FALSE; }
    full = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, 32768 * sizeof(WCHAR));
    if (!full) { p_error(err, cap, L"Cannot allocate executable path", ERROR_NOT_ENOUGH_MEMORY); return FALSE; }
    length = GetFullPathNameW(path, 32768, full, NULL);
    if (!length || length >= 32000) { code = GetLastError(); p_error(err, cap, L"Cannot resolve executable path", code); goto done; }
    directory = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, (length + 1) * sizeof(WCHAR));
    command = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, (length + 128) * sizeof(WCHAR));
    if (!directory || !command) { p_error(err, cap, L"Cannot allocate launch arguments", ERROR_NOT_ENOUGH_MEMORY); goto done; }
    p_copy(directory, length + 1, 0, full);
    for (i = length; i && full[i - 1] != L'\\' && full[i - 1] != L'/'; --i) {}
    if (!i) { p_error(err, cap, L"Executable has no parent directory", 0); goto done; }
    directory[i] = 0;
    for (i = 0; i < length; ++i) if (full[i] == L'"') { p_error(err, cap, L"Invalid quote in executable path", 0); goto done; }
    at = p_copy(command, length + 128, 0, L"\"");
    at = p_copy(command, length + 128, at, full);
    at = p_copy(command, length + 128, at, L"\" --remote-debugging-port=");
    at = p_decimal(command, length + 128, at, port);
    p_copy(command, length + 128, at, L" --remote-debugging-address=127.0.0.1");
    if (!proc_check_instances(full, &running, err, cap)) { code = GetLastError(); goto done; }
    if (running) { code = ERROR_ALREADY_EXISTS; p_error(err, cap, L"Client is already running; close it before starting a new owned client", code); goto done; }
    p_zero(&startup, sizeof(startup)); startup.cb = sizeof(startup);
    p_zero(&info, sizeof(info));
    p_lock();
    for (slot = 0; slot < PROC_ROOT_LIMIT; ++slot) if (!roots[slot].pid) break;
    if (slot == PROC_ROOT_LIMIT) { p_unlock(); p_error(err, cap, L"Too many owned launches; stop earlier launches first", 0); goto done; }
    if (!CreateProcessW(full, command, NULL, NULL, FALSE, CREATE_UNICODE_ENVIRONMENT, NULL, directory, &startup, &info)) {
        code = GetLastError(); p_unlock(); p_error(err, cap, L"CreateProcessW failed", code); goto done;
    }
    CloseHandle(info.hThread);
    if (!DuplicateHandle(GetCurrentProcess(), info.hProcess, GetCurrentProcess(), &query, 0, FALSE, DUPLICATE_SAME_ACCESS)
        || !p_times(info.hProcess, &created, &exited) || !p_add(&roots[slot], info.dwProcessId, query, &created)) {
        code = GetLastError();
        if (query) CloseHandle(query);
        TerminateProcess(info.hProcess, ERROR_CANCELLED);
        CloseHandle(info.hProcess);
        p_release(&roots[slot]); p_unlock();
        p_error(err, cap, L"Cannot retain launch ownership", code); goto done;
    }
    roots[slot].pid = info.dwProcessId;
    p_unlock();
    *pid = info.dwProcessId; *handle = info.hProcess;
    launched = TRUE;
done:
    if (command) HeapFree(GetProcessHeap(), 0, command);
    if (directory) HeapFree(GetProcessHeap(), 0, directory);
    if (full) HeapFree(GetProcessHeap(), 0, full);
    SetLastError(launched ? ERROR_SUCCESS : code);
    return launched;
}

BOOL proc_port_owner(USHORT port, DWORD rootPid, DWORD *owner, WCHAR *err, DWORD cap) {
    MIB_TCPTABLE_OWNER_PID *v4;
    MIB_TCP6TABLE_OWNER_PID *v6;
    DWORD i, found = 0, code;
    USHORT network = p_network_port(port);
    BOOL accepted = FALSE;
    OwnedRoot *root;
    if (owner) *owner = 0;
    p_error(err, cap, L"", 0);
    if (!port || !rootPid || !owner) { p_error(err, cap, L"Invalid ownership arguments", 0); return FALSE; }
    v4 = (MIB_TCPTABLE_OWNER_PID *)p_tcp_table(AF_INET);
    if (!v4) { p_error(err, cap, L"Cannot inspect IPv4 listeners", GetLastError()); return FALSE; }
    for (i = 0; i < v4->dwNumEntries; ++i) if ((USHORT)v4->table[i].dwLocalPort == network) {
        if (v4->table[i].dwLocalAddr != 0x0100007fUL || (found && found != v4->table[i].dwOwningPid)) {
            p_error(err, cap, L"Port is not bound exclusively to 127.0.0.1 by one process", 0); goto cleanup4;
        }
        found = v4->table[i].dwOwningPid;
    }
    if (!found) { p_error(err, cap, L"No IPv4 listener on the debug port", 0); goto cleanup4; }
    v6 = (MIB_TCP6TABLE_OWNER_PID *)p_tcp_table(AF_INET6);
    if (!v6) {
        code = GetLastError();
        if (code != ERROR_NOT_SUPPORTED) { p_error(err, cap, L"Cannot inspect IPv6 listeners", code); goto cleanup4; }
    } else {
        for (i = 0; i < v6->dwNumEntries; ++i) if ((USHORT)v6->table[i].dwLocalPort == network) break;
        if (i < v6->dwNumEntries) {
            HeapFree(GetProcessHeap(), 0, v6);
            p_error(err, cap, L"Port also has an IPv6 listener; 127.0.0.1-only is required", 0); goto cleanup4;
        }
        HeapFree(GetProcessHeap(), 0, v6);
    }
    p_lock();
    root = p_root(rootPid);
    if (!root) p_error(err, cap, L"Root PID was not launched by this probe", 0);
    else if (!p_refresh(root)) p_error(err, cap, L"Cannot inspect the complete owned process tree", 0);
    else {
        HANDLE query = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, found);
        FILETIME created, exited;
        if (query) {
            if (p_times(query, &created, &exited) && p_known(root, found, &created)) { *owner = found; accepted = TRUE; }
            CloseHandle(query);
        }
        if (!accepted) p_error(err, cap, L"Listener PID is outside the owned process tree", 0);
    }
    p_unlock();
cleanup4:
    HeapFree(GetProcessHeap(), 0, v4);
    return accepted;
}

DWORD proc_stop_owned(DWORD rootPid) {
    DWORD i, stopped = 0;
    OwnedRoot *root;
    if (!rootPid || rootPid == GetCurrentProcessId()) return 0;
    p_lock();
    root = p_root(rootPid);
    if (!root) { p_unlock(); return 0; }
    p_refresh(root);
    for (i = root->count; i; --i) {
        SeenProcess *seen = &root->seen[i - 1];
        HANDLE process;
        FILETIME created, exited;
        if (seen->pid == GetCurrentProcessId()) continue;
        process = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, seen->pid);
        if (!process) continue;
        if (p_times(process, &created, &exited) && p_time_equal(&created, &seen->created)
            && WaitForSingleObject(process, 0) == WAIT_TIMEOUT && TerminateProcess(process, ERROR_CANCELLED)) ++stopped;
        CloseHandle(process);
    }
    p_release(root);
    p_unlock();
    return stopped;
}

BOOL proc_alive(DWORD pid) {
    HANDLE process;
    BOOL alive;
    OwnedRoot *root;
    if (!pid) return FALSE;
    p_lock();
    root = p_root(pid);
    if (root && root->count) {
        alive = WaitForSingleObject(root->seen[0].query, 0) == WAIT_TIMEOUT;
        p_unlock();
        return alive;
    }
    p_unlock();
    process = OpenProcess(SYNCHRONIZE, FALSE, pid);
    if (!process) return FALSE;
    alive = WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
    CloseHandle(process);
    return alive;
}

static BOOL p_read(HANDLE file, void *buffer, DWORD size) {
    DWORD read = 0;
    return ReadFile(file, buffer, size, &read, NULL) && read == size;
}

static WORD p_word(const BYTE *buffer) { return (WORD)(buffer[0] | ((WORD)buffer[1] << 8)); }

BOOL proc_pe(const WCHAR *path, WORD *machine, WORD *subsystemMajor, WORD *subsystemMinor, WCHAR *version, DWORD cap) {
    HANDLE file;
    IMAGE_DOS_HEADER dos;
    IMAGE_FILE_HEADER header;
    DWORD signature, size, ignored;
    BYTE optional[72];
    LARGE_INTEGER length, offset;
    BOOL valid = FALSE;
    if (machine) *machine = 0;
    if (subsystemMajor) *subsystemMajor = 0;
    if (subsystemMinor) *subsystemMinor = 0;
    p_copy(version, cap, 0, L"unknown");
    if (!path || !machine || !subsystemMajor || !subsystemMinor) return FALSE;
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    if (!GetFileSizeEx(file, &length) || length.QuadPart < sizeof(dos) || !p_read(file, &dos, sizeof(dos))
        || dos.e_magic != IMAGE_DOS_SIGNATURE || dos.e_lfanew < (LONG)sizeof(dos)) goto close;
    offset.QuadPart = dos.e_lfanew;
    if (offset.QuadPart > length.QuadPart - 24 || !SetFilePointerEx(file, offset, NULL, FILE_BEGIN)
        || !p_read(file, &signature, sizeof(signature)) || signature != IMAGE_NT_SIGNATURE
        || !p_read(file, &header, sizeof(header)) || header.SizeOfOptionalHeader < sizeof(optional)
        || offset.QuadPart > length.QuadPart - 24 - sizeof(optional) || !p_read(file, optional, sizeof(optional))) goto close;
    if (p_word(optional) != IMAGE_NT_OPTIONAL_HDR32_MAGIC && p_word(optional) != IMAGE_NT_OPTIONAL_HDR64_MAGIC) goto close;
    *machine = header.Machine;
    *subsystemMajor = p_word(optional + 48);
    *subsystemMinor = p_word(optional + 50);
    valid = TRUE;
close:
    CloseHandle(file);
    if (!valid) return FALSE;
    size = GetFileVersionInfoSizeW(path, &ignored);
    if (size && version && cap) {
        BYTE *data = (BYTE *)HeapAlloc(GetProcessHeap(), 0, size);
        if (data) {
            VS_FIXEDFILEINFO *fixed = NULL;
            UINT fixedSize = 0;
            if (GetFileVersionInfoW(path, 0, size, data) && VerQueryValueW(data, L"\\", (LPVOID *)&fixed, &fixedSize)
                && fixedSize >= sizeof(*fixed) && fixed->dwSignature == 0xFEEF04BD) {
                DWORD at = p_decimal(version, cap, 0, HIWORD(fixed->dwFileVersionMS));
                at = p_copy(version, cap, at, L"."); at = p_decimal(version, cap, at, LOWORD(fixed->dwFileVersionMS));
                at = p_copy(version, cap, at, L"."); at = p_decimal(version, cap, at, HIWORD(fixed->dwFileVersionLS));
                at = p_copy(version, cap, at, L"."); p_decimal(version, cap, at, LOWORD(fixed->dwFileVersionLS));
            }
            HeapFree(GetProcessHeap(), 0, data);
        }
    }
    return TRUE;
}


