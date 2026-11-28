/* Ordinary host, receipt-v1; only the host's own ready event can enter this outbox. */
#include "ordinary-receipts.h"
#include "adapter-account.h"
#include "device-quota.h"
#include "json.h"
#include <wincrypt.h>

BOOL cx_adapter_agreement_request(const WCHAR *base, const WCHAR *method, const WCHAR *path,
    const WCHAR *authorization, const WCHAR *proof, const char *json, DWORD limit, CX_ADAPTER_REPLY *reply);

#define CX_OR_LIMIT 64
#define CX_OR_PACKET_CAP 768
#define CX_OR_REPLY_CAP 2048
#define CX_OR_DAY (24ULL * 60 * 60 * 10000000)
#define CX_OR_HEADER "cx-ordinary-receipts-v1 "
#define CX_OR_FILE L"ordinary-receipts.v1.outbox"
#define CX_OR_DISK_CAP (sizeof(CX_OR_HEADER) + 66 + CX_OR_LIMIT * CX_OR_PACKET_CAP)
static const WCHAR cx_or_policy_path[] = L"api/extension-logs/receipt-policy?mode=native_browser";
static const WCHAR cx_or_batches_path[] = L"api/extension-logs/batches";

typedef struct CX_OR_FIELDS {
    char device[129], browser[129], version[28], launch[37], batch[37], event[37], time[25];
} CX_OR_FIELDS;
typedef struct CX_OR_PACKET {
    char wire[CX_OR_PACKET_CAP];
    ULONGLONG at;
} CX_OR_PACKET;
typedef struct CX_OR_QUEUE {
    DWORD count;
    CX_OR_PACKET packets[CX_OR_LIMIT];
} CX_OR_QUEUE;

static BOOL cx_or_equals(const char *a, const char *b, DWORD n) {
    while (n--) if (*a++ != *b++) return FALSE;
    return TRUE;
}
static BOOL cx_or_word(const char *s, const JT *tokens, int n, const char *word) {
    return n >= 0 && tokens[n].type == 's' && jeq(s, tokens, n, word);
}
static BOOL cx_or_field(const char *s, const JT *tokens, int parent, const char *name, char *out, int cap) {
    int n = jkey(s, tokens, parent, name), size;
    if (n < 0 || tokens[n].type != 's') return FALSE;
    size = tokens[n].end - tokens[n].start;
    if (size < 1 || size >= cap) return FALSE;
    /* Values have strict ASCII alphabets; never decode escapes or embedded NULs. */
    CopyMemory(out, s + tokens[n].start, size);
    out[size] = 0;
    return lstrlenA(out) == size;
}
static BOOL cx_or_digit(char c) { return c >= '0' && c <= '9'; }
static BOOL cx_or_alnum(char c) {
    return cx_or_digit(c) || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}
static BOOL cx_or_identifier(const char *s) {
    int i;
    if (!cx_or_alnum(s[0])) return FALSE;
    for (i = 1; s[i]; ++i) if (!cx_or_alnum(s[i]) && s[i] != '-' && s[i] != '_'
        && s[i] != ':' && (s[i] != '.' || s[i - 1] == '.')) return FALSE;
    return i <= 128;
}
static BOOL cx_or_version(const char *s) {
    int count = 1, digits = 0;
    if (!lstrcmpA(s, "dev")) return TRUE;
    for (; *s; ++s) {
        if (*s == '.' && digits && ++count <= 4) digits = 0;
        else if (!cx_or_digit(*s) || ++digits > 6) return FALSE;
    }
    return count >= 2 && digits > 0;
}
static BOOL cx_or_uuid(const char *s) {
    int i;
    if (lstrlenA(s) != 36 || s[14] != '4' ||
        (s[19] != '8' && s[19] != '9' && s[19] != 'a' && s[19] != 'b')) return FALSE;
    for (i = 0; i < 36; ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (s[i] != '-') return FALSE; }
        else if (!cx_or_digit(s[i]) && (s[i] < 'a' || s[i] > 'f')) return FALSE;
    }
    return TRUE;
}
static BOOL cx_or_ascii(const WCHAR *s, char *out, int cap) {
    int n = 0;
    if (!s) return FALSE;
    while (*s) {
        if (n >= cap - 1 || *s <= 32 || *s > 126) return FALSE;
        out[n++] = (char)*s++;
    }
    out[n] = 0;
    return n > 0;
}
static ULONGLONG cx_or_ticks(const FILETIME *time) {
    ULARGE_INTEGER ticks;
    ticks.LowPart = time->dwLowDateTime;
    ticks.HighPart = time->dwHighDateTime;
    return ticks.QuadPart;
}
static BOOL cx_or_fresh(ULONGLONG at) {
    FILETIME time;
    ULONGLONG now;
    GetSystemTimeAsFileTime(&time);
    now = cx_or_ticks(&time);
    return at <= now && now - at < CX_OR_DAY;
}
static BOOL cx_or_time(const char *text, ULONGLONG *at) {
    static const int pos[] = {0, 5, 8, 11, 14, 17, 20};
    static const int len[] = {4, 2, 2, 2, 2, 2, 3};
    SYSTEMTIME utc;
    FILETIME filetime;
    WORD numbers[7];
    int i, j;
    if (lstrlenA(text) != 24 || text[4] != '-' || text[7] != '-' || text[10] != 'T' ||
        text[13] != ':' || text[16] != ':' || text[19] != '.' || text[23] != 'Z') return FALSE;
    for (i = 0; i < 7; ++i) {
        int value = 0;
        for (j = 0; j < len[i]; ++j) {
            char c = text[pos[i] + j];
            if (!cx_or_digit(c)) return FALSE;
            value = value * 10 + (c - '0');
        }
        numbers[i] = (WORD)value;
    }
    utc.wYear = numbers[0]; utc.wMonth = numbers[1]; utc.wDayOfWeek = 0; utc.wDay = numbers[2];
    utc.wHour = numbers[3]; utc.wMinute = numbers[4]; utc.wSecond = numbers[5]; utc.wMilliseconds = numbers[6];
    if (utc.wYear < 2000 || !SystemTimeToFileTime(&utc, &filetime)) return FALSE;
    *at = cx_or_ticks(&filetime);
    return TRUE;
}
static BOOL cx_or_packet_decode(const char *wire, const char *device, CX_OR_FIELDS *s, ULONGLONG *at) {
    JT t[40];
    int entries, event, seq;
    if (jparse(wire, lstrlenA(wire), t, ARRAYSIZE(t)) <= 0 || t[0].type != '{' || t[0].count != 14
        || !cx_or_word(wire, t, jkey(wire, t, 0, "mode"), "native_browser")
        || !cx_or_field(wire, t, 0, "device_id", s->device, sizeof(s->device)) || lstrcmpA(s->device, device)
        || !cx_or_field(wire, t, 0, "browser_id", s->browser, sizeof(s->browser)) || !cx_or_identifier(s->browser)
        || !cx_or_field(wire, t, 0, "version", s->version, sizeof(s->version)) || !cx_or_version(s->version)
        || !cx_or_field(wire, t, 0, "launch_id", s->launch, sizeof(s->launch)) || !cx_or_uuid(s->launch)
        || !cx_or_field(wire, t, 0, "batch_id", s->batch, sizeof(s->batch)) || !cx_or_uuid(s->batch)) return FALSE;
    entries = jkey(wire, t, 0, "entries");
    if (entries < 0 || t[entries].type != '[' || t[entries].count != 1) return FALSE;
    event = entries + 1;
    seq = jkey(wire, t, event, "event_seq");
    return t[event].type == '{' && t[event].count == 10 && jint(wire, t, seq, 0) == 1
        && cx_or_field(wire, t, event, "event_id", s->event, sizeof(s->event)) && cx_or_uuid(s->event)
        && cx_or_field(wire, t, event, "time", s->time, sizeof(s->time)) && cx_or_time(s->time, at)
        && cx_or_word(wire, t, jkey(wire, t, event, "event"), "extension.ready")
        && cx_or_word(wire, t, jkey(wire, t, event, "level"), "info");
}
static BOOL cx_or_make(CX_OR_PACKET *packet, const char *device, const char *browser,
    const char *version, const FILETIME *observed) {
    WCHAR uuid[37];
    CX_OR_FIELDS access;
    SYSTEMTIME utc;
    if (!FileTimeToSystemTime(observed, &utc) || utc.wYear < 2000 || utc.wYear > 9999
        || !cx_device_uuid_v4(uuid, ARRAYSIZE(uuid)) || !cx_or_ascii(uuid, access.launch, sizeof(access.launch))
        || !cx_device_uuid_v4(uuid, ARRAYSIZE(uuid)) || !cx_or_ascii(uuid, access.batch, sizeof(access.batch))
        || !cx_device_uuid_v4(uuid, ARRAYSIZE(uuid)) || !cx_or_ascii(uuid, access.event, sizeof(access.event))) return FALSE;
    wsprintfA(access.time, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", (UINT)utc.wYear, (UINT)utc.wMonth,
        (UINT)utc.wDay, (UINT)utc.wHour, (UINT)utc.wMinute, (UINT)utc.wSecond, (UINT)utc.wMilliseconds);
    /* Identifiers are validated ASCII and the maximum result is below this fixed buffer. */
    wsprintfA(packet->wire, "{\"mode\":\"native_browser\",\"version\":\"%s\",\"device_id\":\"%s\",\"browser_id\":\"%s\","
        "\"launch_id\":\"%s\",\"batch_id\":\"%s\",\"entries\":[{\"event_id\":\"%s\",\"event_seq\":1,"
        "\"time\":\"%s\",\"event\":\"extension.ready\",\"level\":\"info\"}]}",
        version, device, browser, access.launch, access.batch, access.event, access.time);
    /* Store exactly the serialized UTC milliseconds for the original packet. */
    return cx_or_time(access.time, &packet->at);
}

static BOOL cx_or_hash(const WCHAR *const *parts, DWORD count, char out[65]) {
    static const char hex[] = "0123456789abcdef";
    HCRYPTPROV provider = 0;
    HCRYPTHASH hash = 0;
    BYTE digest[32];
    DWORD size = sizeof(digest), i;
    BOOL ok = FALSE;
    if (!CryptAcquireContextW(&provider, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT | CRYPT_SILENT)
        || !CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash)) goto done;
    for (i = 0; i < count; ++i)
        if (!CryptHashData(hash, (const BYTE *)parts[i], ((DWORD)lstrlenW(parts[i]) + 1) * sizeof(WCHAR), 0)) goto done;
    if (!CryptGetHashParam(hash, HP_HASHVAL, digest, &size, 0) || size != sizeof(digest)) goto done;
    for (i = 0; i < size; ++i) {
        out[i * 2] = hex[digest[i] >> 4];
        out[i * 2 + 1] = hex[digest[i] & 15];
    }
    out[64] = 0;
    ok = TRUE;
done:
    SecureZeroMemory(digest, sizeof(digest));
    if (hash) CryptDestroyHash(hash);
    if (provider) CryptReleaseContext(provider, 0);
    return ok;
}
static BOOL cx_or_drop(const WCHAR *path) {
    return DeleteFileW(path) || GetLastError() == ERROR_FILE_NOT_FOUND;
}
static BOOL cx_or_write_bytes(HANDLE file, const char *bytes, DWORD size) {
    DWORD count = 0;
    return WriteFile(file, bytes, size, &count, NULL) && count == size;
}
static BOOL cx_or_save(const WCHAR *path, const WCHAR *temp, const char *binding, const CX_OR_QUEUE *queue) {
    HANDLE file;
    char header[sizeof(CX_OR_HEADER) + 66];
    DWORD i, len;
    BOOL ok;
    if (!queue->count) return cx_or_drop(path);
    file = CreateFileW(temp, GENERIC_WRITE, 0, NULL, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    len = (DWORD)wsprintfA(header, CX_OR_HEADER "%s\n", binding);
    ok = cx_or_write_bytes(file, header, len);
    for (i = 0; ok && i < queue->count; ++i) {
        const char *wire = queue->packets[i].wire;
        ok = cx_or_write_bytes(file, wire, (DWORD)lstrlenA(wire)) && cx_or_write_bytes(file, "\n", 1);
    }
    ok = ok && FlushFileBuffers(file);
    if (!CloseHandle(file)) ok = FALSE;
    if (ok) ok = MoveFileExW(temp, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
    if (!ok) (void)cx_or_drop(temp);
    return ok;
}
static BOOL cx_or_load(const WCHAR *path, const WCHAR *temp, const char *binding, const char *device, CX_OR_QUEUE *queue) {
    BY_HANDLE_FILE_INFORMATION info;
    DWORD size = 0, start, end, length, records = 0;
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    char header[sizeof(CX_OR_HEADER) + 66], *text;
    CX_OR_FIELDS fields;
    BOOL ok, changed = FALSE;
    if (file == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND;
    if (!GetFileInformationByHandle(file, &info)) { CloseHandle(file); return FALSE; }
    if ((info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
        || info.nFileSizeHigh || info.nFileSizeLow >= CX_OR_DISK_CAP) {
        CloseHandle(file);
        return cx_or_drop(path);
    }
    text = (char *)HeapAlloc(GetProcessHeap(), 0, CX_OR_DISK_CAP);
    if (!text) { CloseHandle(file); return FALSE; }
    ok = ReadFile(file, text, CX_OR_DISK_CAP, &size, NULL) && size == info.nFileSizeLow;
    CloseHandle(file);
    if (!ok) goto done;
    start = (DWORD)wsprintfA(header, CX_OR_HEADER "%s\n", binding);
    if (size <= start || !cx_or_equals(text, header, start)) { ok = cx_or_drop(path); goto done; }
    for (end = start; end < size; ++end) {
        CX_OR_PACKET *packet;
        if (text[end] != '\n') continue;
        length = end - start;
        if (++records > CX_OR_LIMIT || length == 0 || length >= CX_OR_PACKET_CAP) {
            queue->count = 0;
            ok = cx_or_drop(path);
            goto done;
        }
        packet = &queue->packets[queue->count];
        CopyMemory(packet->wire, text + start, length);
        packet->wire[length] = 0;
        if (lstrlenA(packet->wire) != (int)length || !cx_or_packet_decode(packet->wire, device, &fields, &packet->at)
            || !cx_or_fresh(packet->at)) changed = TRUE;
        else ++queue->count;
        start = end + 1;
    }
    if (start != size) { queue->count = 0; ok = cx_or_drop(path); goto done; }
    if (changed) ok = cx_or_save(path, temp, binding, queue);
done:
    HeapFree(GetProcessHeap(), 0, text);
    return ok;
}

typedef enum CX_OR_POLICY { CX_OR_UNKNOWN, CX_OR_DENIED, CX_OR_ALLOWED } CX_OR_POLICY;
static BOOL cx_or_denied(DWORD status) { return status == 401 || status == 403; }
static CX_OR_POLICY cx_or_check(const WCHAR *base, const WCHAR *auth, const WCHAR *proof) {
    CX_ADAPTER_REPLY reply = {0};
    CX_OR_POLICY decision = CX_OR_UNKNOWN;
    JT t[24];
    int enabled;
    if (cx_adapter_agreement_request(base, L"GET", cx_or_policy_path, auth, proof, NULL, CX_OR_REPLY_CAP, &reply)) {
        if (cx_or_denied(reply.status)) decision = CX_OR_DENIED;
        else if (reply.status == 200 && reply.body && reply.length <= CX_OR_REPLY_CAP
            && jparse(reply.body, (int)reply.length, t, ARRAYSIZE(t)) > 0 && t[0].type == '{' && t[0].count == 4
            && cx_or_word(reply.body, t, jkey(reply.body, t, 0, "transport"), "receipt-v1")) {
            enabled = jkey(reply.body, t, 0, "enabled");
            if (enabled >= 0 && t[enabled].type == 'p') {
                if (jeq(reply.body, t, enabled, "true")) decision = CX_OR_ALLOWED;
                if (jeq(reply.body, t, enabled, "false")) decision = CX_OR_DENIED;
            }
        }
    }
    cx_adapter_reply_free(&reply);
    return decision;
}
static BOOL cx_or_receipt(const CX_ADAPTER_REPLY *reply, const CX_OR_FIELDS *s) {
    const char *body = reply->body;
    JT t[32];
    int scope, ids;
    if (reply->status != 200 || !body || reply->length > CX_OR_REPLY_CAP
        || jparse(body, (int)reply->length, t, ARRAYSIZE(t)) <= 0 || t[0].type != '{' || t[0].count != 6
        || !cx_or_word(body, t, jkey(body, t, 0, "batch_id"), s->batch)) return FALSE;
    scope = jkey(body, t, 0, "scope");
    ids = jkey(body, t, 0, "accepted_event_ids");
    return scope >= 0 && t[scope].type == '{' && t[scope].count == 10
        && cx_or_word(body, t, jkey(body, t, scope, "mode"), "native_browser")
        && cx_or_word(body, t, jkey(body, t, scope, "version"), s->version)
        && cx_or_word(body, t, jkey(body, t, scope, "device_id"), s->device)
        && cx_or_word(body, t, jkey(body, t, scope, "browser_id"), s->browser)
        && cx_or_word(body, t, jkey(body, t, scope, "launch_id"), s->launch)
        && ids >= 0 && t[ids].type == '[' && t[ids].count == 1 && cx_or_word(body, t, ids + 1, s->event);
}
static BOOL cx_or_key(const WCHAR *key, const WCHAR *proof) {
    DWORD i;
    if (!key || !proof || !*key || lstrlenW(key) >= CX_ADAPTER_TOKEN_CAP
        || lstrlenW(proof) != 47 || proof[0] != 'a' || proof[1] != 'g' || proof[2] != 'd' || proof[3] != '_') return FALSE;
    for (i = 0; key[i]; ++i) if (key[i] <= 32 || key[i] > 126) return FALSE;
    for (i = 4; proof[i]; ++i)
        if (proof[i] > 126 || (!cx_or_alnum((char)proof[i]) && proof[i] != '-' && proof[i] != '_')) return FALSE;
    return TRUE;
}
static void cx_or_shift(CX_OR_QUEUE *queue) {
    DWORD i;
    for (i = 1; i < queue->count; ++i) queue->packets[i - 1] = queue->packets[i];
    --queue->count;
}

typedef struct CX_OR_LOCATION {
    WCHAR path[MAX_PATH], temp[MAX_PATH];
    HANDLE mutex;
} CX_OR_LOCATION;
static BOOL cx_or_lock(const WCHAR *dir, CX_OR_LOCATION *location) {
    WCHAR root[MAX_PATH], folded[MAX_PATH], mutexName[96];
    char dirHash[65];
    const WCHAR *parts[] = {folded};
    DWORD n, attrs, wait;
    if (!dir || !*dir) return FALSE;
    n = GetFullPathNameW(dir, ARRAYSIZE(root), root, NULL);
    if (!n || n >= ARRAYSIZE(root) - ARRAYSIZE(CX_OR_FILE) - 6) return FALSE;
    while (n > 3 && root[n - 1] == '\\') root[--n] = 0;
    attrs = GetFileAttributesW(root);
    if (attrs == INVALID_FILE_ATTRIBUTES || !(attrs & FILE_ATTRIBUTE_DIRECTORY) || (attrs & FILE_ATTRIBUTE_REPARSE_POINT)
        || !LCMapStringW(LOCALE_INVARIANT, LCMAP_UPPERCASE, root, -1, folded, ARRAYSIZE(folded))
        || !cx_or_hash(parts, ARRAYSIZE(parts), dirHash)) return FALSE;
    wsprintfW(mutexName, L"Local\\CXOrdinaryDiagnostic-%S", dirHash);
    wsprintfW(location->path, L"%s%s%s", root, root[n - 1] == '\\' ? L"" : L"\\", CX_OR_FILE);
    wsprintfW(location->temp, L"%s.tmp", location->path);
    location->mutex = CreateMutexW(NULL, FALSE, mutexName);
    if (!location->mutex) return FALSE;
    wait = WaitForSingleObject(location->mutex, 1500);
    if (wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED) return TRUE;
    CloseHandle(location->mutex);
    return FALSE;
}
static void cx_or_unlock(CX_OR_LOCATION *location) {
    ReleaseMutex(location->mutex);
    CloseHandle(location->mutex);
}
BOOL cx_ordinary_receipts_discard(const WCHAR *dir) {
    CX_OR_LOCATION location;
    BOOL removedTemp, removedOutbox;
    if (!cx_or_lock(dir, &location)) return FALSE;
    removedTemp = cx_or_drop(location.temp);
    removedOutbox = cx_or_drop(location.path);
    cx_or_unlock(&location);
    return removedTemp && removedOutbox;
}

BOOL cx_ordinary_receipts_pump(const WCHAR *dir, const WCHAR *base, const WCHAR *ordinaryKey,
    const WCHAR *agreementProof, const WCHAR *device, const WCHAR *browser, const WCHAR *version, BOOL recordReady) {
    CX_OR_LOCATION location;
    WCHAR *auth = NULL;
    char deviceId[129], browserId[129], release[28], binding[65];
    const WCHAR *scopeParts[] = {L"cx-ordinary-diagnostic-binding-v1", base, ordinaryKey, agreementProof, device};
    FILETIME observed;
    DWORD authSize = 0;
    CX_ADAPTER_REPLY reply = {0};
    CX_OR_FIELDS fields;
    CX_OR_QUEUE *queue = NULL;
    CX_OR_POLICY permission;
    BOOL received = FALSE;
    if (!base || lstrlenW(base) < 9 || lstrlenW(base) >= CX_ADAPTER_TOKEN_CAP
        || CompareStringOrdinal(base, 8, L"https://", 8, TRUE) != CSTR_EQUAL || !cx_or_key(ordinaryKey, agreementProof)
        || !cx_or_ascii(device, deviceId, sizeof(deviceId)) || !cx_or_identifier(deviceId)
        || (recordReady && (!cx_or_ascii(browser, browserId, sizeof(browserId)) || !cx_or_identifier(browserId)
            || !cx_or_ascii(version, release, sizeof(release)) || !cx_or_version(release)))) return FALSE;
    GetSystemTimeAsFileTime(&observed);
    if (!cx_or_hash(scopeParts, ARRAYSIZE(scopeParts), binding) || !cx_or_lock(dir, &location)) return FALSE;
    if (!cx_or_drop(location.temp)) goto done;
    queue = (CX_OR_QUEUE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*queue));
    if (!queue || !cx_or_load(location.path, location.temp, binding, deviceId, queue) || (!recordReady && !queue->count)) goto done;

    authSize = ((DWORD)lstrlenW(ordinaryKey) + 8) * sizeof(WCHAR);
    auth = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, authSize);
    if (!auth) goto done;
    lstrcpyW(auth, L"Bearer ");
    lstrcpyW(auth + 7, ordinaryKey);
    permission = cx_or_check(base, auth, agreementProof);
    if (permission == CX_OR_DENIED) { (void)cx_or_drop(location.path); goto done; }
    if (permission != CX_OR_ALLOWED) goto done;
    if (recordReady && queue->count < CX_OR_LIMIT && cx_or_fresh(cx_or_ticks(&observed))
        && cx_or_make(&queue->packets[queue->count], deviceId, browserId, release, &observed)) {
        ++queue->count;
        if (!cx_or_save(location.path, location.temp, binding, queue)) goto done;
    }
    /* Recheck age immediately before dispatch; network policy lookup can cross the TTL. */
    if (!queue->count || !cx_or_packet_decode(queue->packets[0].wire, deviceId, &fields, &queue->packets[0].at)) goto done;
    if (!cx_or_fresh(queue->packets[0].at)) {
        cx_or_shift(queue);
        (void)cx_or_save(location.path, location.temp, binding, queue);
        goto done;
    }
    if (cx_adapter_agreement_request(base, L"POST", cx_or_batches_path, auth, agreementProof,
        queue->packets[0].wire, CX_OR_REPLY_CAP, &reply)) {
        if (cx_or_denied(reply.status)) (void)cx_or_drop(location.path);
        else if (cx_or_receipt(&reply, &fields)) {
            cx_or_shift(queue);
            received = cx_or_save(location.path, location.temp, binding, queue);
        }
    }
done:
    cx_adapter_reply_free(&reply);
    if (auth) { SecureZeroMemory(auth, authSize); HeapFree(GetProcessHeap(), 0, auth); }
    if (queue) HeapFree(GetProcessHeap(), 0, queue);
    cx_or_unlock(&location);
    return received;
}
