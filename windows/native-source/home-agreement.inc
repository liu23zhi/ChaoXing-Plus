/* Ordinary native host agreement. Included only by home.c, not by Node or browser code.
 * Provider responses decide admission; the encrypted cache is never an authorization. */
#include <wincrypt.h>

#define HA_DOC_MAX (256 * 1024)
#define HA_WIRE_LIMIT (2 * 1024 * 1024)
#define HA_SMALL_LIMIT (16 * 1024)
#define HA_FORMAT 0x43414731UL
#define HA_READER L"CXPlusNativeAgreement"
#define HA_ACCEPT 1721
#define HA_CANCEL 1722
#define HA_BODY 1723

#ifndef CX_HOME_AGREEMENT_REQUEST
#define CX_HOME_AGREEMENT_REQUEST cx_adapter_agreement_request
#endif

typedef struct HA_RECORD {
    DWORD format;
    WCHAR device[37], proof[48];
    char tokenHash[65], version[49], hash[65];
    WCHAR body[HA_DOC_MAX + 1];
} HA_RECORD;
typedef struct HA_STATUS {
    char version[49], hash[65];
    BOOL pending;
} HA_STATUS;

typedef BOOL (WINAPI *HA_PROTECT)(DATA_BLOB *, LPCWSTR, DATA_BLOB *, PVOID,
    CRYPTPROTECT_PROMPTSTRUCT *, DWORD, DATA_BLOB *);
typedef BOOL (WINAPI *HA_UNPROTECT)(DATA_BLOB *, LPWSTR *, DATA_BLOB *, PVOID,
    CRYPTPROTECT_PROMPTSTRUCT *, DWORD, DATA_BLOB *);

static BOOL ha_cancelled(HOME_STATE *home) {
    return InterlockedCompareExchange(&home->agreementCancelled, 0, 0) != 0;
}
static void ha_free_record(HA_RECORD *record) {
    if (record) { SecureZeroMemory(record, sizeof(*record)); HeapFree(GetProcessHeap(), 0, record); }
}
static BOOL ha_hash_text(const WCHAR *text, char out[65]) {
    int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text, -1, NULL, 0, NULL, NULL);
    char *bytes; BOOL ok;
    if (n <= 1 || n > HA_DOC_MAX + 1) return FALSE;
    bytes = (char *)HeapAlloc(GetProcessHeap(), 0, n);
    if (!bytes) return FALSE;
    ok = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text, -1, bytes, n, NULL, NULL) == n
        && cx_adapter_agreement_sha256((BYTE *)bytes, (DWORD)n - 1, out);
    SecureZeroMemory(bytes, n); HeapFree(GetProcessHeap(), 0, bytes); return ok;
}
static BOOL ha_hex(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }
static BOOL ha_digest(const char *value) {
    DWORD i; for (i = 0; i < 64; ++i) if (!ha_hex(value[i])) return FALSE;
    return value[64] == 0;
}
static BOOL ha_version(const char *value) {
    DWORD i;
    for (i = 0; i < 48 && value[i]; ++i) {
        char c = value[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || (i && (c == '.' || c == '-' || c == '_'))))
            return FALSE;
    }
    return i != 0 && !value[i];
}
static BOOL ha_device(const WCHAR *value) {
    DWORD i;
    for (i = 0; i < 36; ++i) {
        WCHAR c = value[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != L'-') return FALSE; }
        else if (!(c <= 127 && ha_hex((char)c))) return FALSE;
    }
    return value[36] == 0;
}
static BOOL ha_proof(const WCHAR *value) {
    DWORD i;
    if (value[0] != L'a' || value[1] != L'g' || value[2] != L'd' || value[3] != L'_') return FALSE;
    for (i = 4; i < 47; ++i) if (!((value[i] >= L'0' && value[i] <= L'9')
        || (value[i] >= L'a' && value[i] <= L'z') || (value[i] >= L'A' && value[i] <= L'Z')
        || value[i] == L'_' || value[i] == L'-')) return FALSE;
    return value[47] == 0;
}
static WORD ha_decimal_pair(const char *v) {
    return (WORD)((v[0] - '0') * 10 + v[1] - '0');
}
static BOOL ha_date(const char *v) {
    int i; const char *shape = "0000-00-00T00:00:00";
    SYSTEMTIME civil = {0}; FILETIME checked;
    for (i = 0; shape[i]; ++i) if (shape[i] == '0' ? (v[i] < '0' || v[i] > '9') : v[i] != shape[i]) return FALSE;
    civil.wYear = (WORD)(ha_decimal_pair(v) * 100 + ha_decimal_pair(v + 2));
    civil.wMonth = ha_decimal_pair(v + 5); civil.wDay = ha_decimal_pair(v + 8);
    civil.wHour = ha_decimal_pair(v + 11); civil.wMinute = ha_decimal_pair(v + 14); civil.wSecond = ha_decimal_pair(v + 17);
    if (!SystemTimeToFileTime(&civil, &checked)) return FALSE;
    if (v[i] == '.') { ++i; if (v[i] < '0' || v[i] > '9') return FALSE; while (v[i] >= '0' && v[i] <= '9') ++i; }
    if (v[i] == 'Z') return !v[i + 1];
    if (v[i] != '+' && v[i] != '-') return FALSE;
    return lstrlenA(v + i) == 6 && v[i+3] == ':' && v[i+1] >= '0' && v[i+1] <= '2'
        && v[i+2] >= '0' && v[i+2] <= '9' && ha_decimal_pair(v+i+1) <= 23
        && v[i+4] >= '0' && v[i+4] <= '5' && v[i+5] >= '0' && v[i+5] <= '9';
}
static BOOL ha_cached_body(const HA_RECORD *r) {
    char actual[65]; DWORD i;
    if (!r->body[0] || r->body[HA_DOC_MAX] || !ha_version(r->version) || !ha_digest(r->hash)) return FALSE;
    for (i = 0; r->body[i]; ++i) if (r->body[i] > 32) break;
    return r->body[i] && ha_hash_text(r->body, actual) && !lstrcmpA(actual, r->hash);
}

/* A validated top-level field is unique even if the JSON key used escapes. */
static BOOL ha_string_token(const char *, const JT *, int);
static int ha_field(const char *text, const JT *t, const char *name) {
    int i, found = -1; char key[128];
    for (i = 1; i < t[0].next; i = t[i + 1].next) {
        if (!ha_string_token(text, t, i) || !jstr(text, t, i, key, ARRAYSIZE(key))) return -1;
        if (!lstrcmpA(key, name)) { if (found >= 0) return -1; found = i + 1; }
    }
    return found;
}
/* Win32 edit controls cannot display embedded NUL. Reject it rather than hashing/rendering a prefix. */
static BOOL ha_string_token(const char *s, const JT *t, int i) {
    int p;
    if (i < 0 || t[i].type != 's') return FALSE;
    for (p = t[i].start; p < t[i].end; ++p) if (s[p] == '\\') {
        ++p;
        if (s[p] == 'u' && s[p+1] == '0' && s[p+2] == '0' && s[p+3] == '0' && s[p+4] == '0') return FALSE;
    }
    return TRUE;
}
static BOOL ha_copy_s(const CX_ADAPTER_REPLY *r, const JT *t, const char *name, char *out, int cap) {
    int i = ha_field(r->body, t, name);
    return ha_string_token(r->body, t, i) && jstr(r->body, t, i, out, cap);
}
static BOOL ha_copy_w(const CX_ADAPTER_REPLY *r, const JT *t, const char *name, WCHAR *out, int cap) {
    int i = ha_field(r->body, t, name);
    return ha_string_token(r->body, t, i) && jwstr(r->body, t, i, out, cap);
}
static BOOL ha_bool(const CX_ADAPTER_REPLY *r, const JT *t, const char *name, BOOL *out) {
    int i = ha_field(r->body, t, name);
    if (i < 0 || t[i].type != 'p') return FALSE;
    if (jeq(r->body, t, i, "true")) { *out = TRUE; return TRUE; }
    if (jeq(r->body, t, i, "false")) { *out = FALSE; return TRUE; }
    return FALSE;
}
static BOOL ha_object(const CX_ADAPTER_REPLY *r, JT *t, int cap) {
    return r->body && jparse(r->body, (int)r->length, t, cap) > 0 && t[0].type == '{';
}
static void ha_release(CX_ADAPTER_REPLY *r) {
    if (r->body) SecureZeroMemory(r->body, r->length);
    cx_adapter_reply_free(r);
}
static BOOL ha_enroll(const WCHAR *base, HA_RECORD *out) {
    CX_ADAPTER_REPLY r = {0}; JT t[32]; BOOL ok;
    ok = CX_HOME_AGREEMENT_REQUEST(base, L"POST", L"api/agreements/devices", NULL, NULL, NULL, HA_SMALL_LIMIT, &r)
        && r.status == 201 && ha_object(&r, t, ARRAYSIZE(t))
        && ha_copy_w(&r, t, "deviceId", out->device, ARRAYSIZE(out->device)) && ha_device(out->device)
        && ha_copy_w(&r, t, "deviceCredential", out->proof, ARRAYSIZE(out->proof)) && ha_proof(out->proof);
    ha_release(&r); return ok;
}
static BOOL ha_status(const WCHAR *base, const WCHAR *auth, const HA_RECORD *r, HA_STATUS *out, BOOL *unauthorized) {
    CX_ADAPTER_REPLY reply = {0}; JT t[64]; WCHAR device[37]; BOOL ok;
    ok = CX_HOME_AGREEMENT_REQUEST(base, L"GET", L"api/agreements/status", auth, r->proof, NULL, HA_SMALL_LIMIT, &reply)
        && reply.status == 200 && ha_object(&reply, t, ARRAYSIZE(t))
        && ha_copy_w(&reply, t, "deviceId", device, ARRAYSIZE(device)) && !lstrcmpW(device, r->device)
        && ha_copy_s(&reply, t, "version", out->version, ARRAYSIZE(out->version)) && ha_version(out->version)
        && ha_copy_s(&reply, t, "content_hash", out->hash, ARRAYSIZE(out->hash)) && ha_digest(out->hash)
        && ha_bool(&reply, t, "needsAcceptance", &out->pending);
    if (unauthorized) *unauthorized = reply.status == 401;
    ha_release(&reply); return ok;
}
static BOOL ha_current(const WCHAR *base, const WCHAR *auth, HA_RECORD *r, const HA_STATUS *status) {
    CX_ADAPTER_REPLY reply = {0}; JT t[80]; WCHAR path[120]; char type[32], date[48], *summary;
    char version[49], hash[65], actual[65]; BOOL ok, pending;
    lstrcpyW(path, L"api/agreements/current?version=");
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, status->version, -1, path + lstrlenW(path), 50)) return FALSE;
    summary = (char *)HeapAlloc(GetProcessHeap(), 0, 8193);
    if (!summary) return FALSE;
    ok = CX_HOME_AGREEMENT_REQUEST(base, L"GET", path, auth, r->proof, NULL, HA_WIRE_LIMIT, &reply)
        && reply.status == 200 && ha_object(&reply, t, ARRAYSIZE(t))
        && ha_copy_s(&reply, t, "type", type, ARRAYSIZE(type)) && !lstrcmpA(type, "user_agreement")
        && ha_copy_s(&reply, t, "version", version, ARRAYSIZE(version)) && !lstrcmpA(version, status->version)
        && ha_copy_s(&reply, t, "content_hash", hash, ARRAYSIZE(hash)) && !lstrcmpA(hash, status->hash)
        && ha_copy_s(&reply, t, "publishedAt", date, ARRAYSIZE(date)) && ha_date(date)
        && ha_copy_s(&reply, t, "summary", summary, 8193) && summary[0]
        && ha_bool(&reply, t, "needsAcceptance", &pending) && pending == status->pending
        && ha_copy_w(&reply, t, "body", r->body, ARRAYSIZE(r->body))
        && ha_hash_text(r->body, actual) && !lstrcmpA(actual, hash);
    if (ok) { lstrcpyA(r->version, version); lstrcpyA(r->hash, hash); ok = ha_cached_body(r); }
    ha_release(&reply); HeapFree(GetProcessHeap(), 0, summary); return ok;
}
static BOOL ha_submit(const WCHAR *base, const WCHAR *auth, const HA_RECORD *r) {
    CX_ADAPTER_REPLY reply = {0}; JT t[64]; char payload[72], version[49], date[48]; WCHAR device[37];
    BOOL ok, accepted;
    lstrcpyA(payload, "{\"version\":\""); lstrcatA(payload, r->version); lstrcatA(payload, "\"}");
    ok = CX_HOME_AGREEMENT_REQUEST(base, L"POST", L"api/agreements/consents", auth, r->proof, payload, HA_SMALL_LIMIT, &reply)
        && reply.status == 200 && ha_object(&reply, t, ARRAYSIZE(t))
        && ha_bool(&reply, t, "accepted", &accepted) && accepted
        && ha_copy_s(&reply, t, "version", version, ARRAYSIZE(version)) && !lstrcmpA(version, r->version)
        && ha_copy_s(&reply, t, "acceptedAt", date, ARRAYSIZE(date)) && ha_date(date)
        && ha_copy_w(&reply, t, "deviceId", device, ARRAYSIZE(device)) && !lstrcmpW(device, r->device);
    ha_release(&reply); return ok;
}

#define HA_PATH_CAP (CX_HOME_EXTENSION_PATH_CAP + 180)
static BOOL ha_path(HOME_STATE *home, const WCHAR *scope, const char *token, WCHAR *out) {
    WCHAR backing[CX_HOME_EXTENSION_PATH_CAP];
    if (!home_device_config_path(home, backing, ARRAYSIZE(backing))) return FALSE;
    out[0] = 0;
    home_copy(out, HA_PATH_CAP, backing);
    home_append(out, HA_PATH_CAP, L".agreement-");
    home_append(out, HA_PATH_CAP, scope);
    if (token) {
        WCHAR w[65];
        if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, token, -1, w, ARRAYSIZE(w))) return FALSE;
        home_append(out, HA_PATH_CAP, L"-"); home_append(out, HA_PATH_CAP, w);
    }
    return lstrlenW(out) < HA_PATH_CAP - 25;
}
/* Protected to this Windows user and scope; failed reads never imply missing consent. */
static BOOL ha_load(const WCHAR *path, const WCHAR *scope, HA_RECORD *out, BOOL *exists) {
    HMODULE crypt; HA_UNPROTECT unprotect; HANDLE f; DWORD n = 0, got; BOOL ok = FALSE;
    DATA_BLOB input = {0}, clear = {0}, entropy = {128, (BYTE *)scope};
    *exists = TRUE;
    f = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) {
        if (GetLastError() == ERROR_FILE_NOT_FOUND) { *exists = FALSE; return TRUE; }
        return FALSE;
    }
    n = GetFileSize(f, NULL);
    if (!n || n > sizeof(*out) + 2048) goto done;
    input.cbData = n; input.pbData = (BYTE *)HeapAlloc(GetProcessHeap(), 0, n);
    if (!input.pbData || !ReadFile(f, input.pbData, n, &got, NULL) || got != n) goto done;
    crypt = LoadLibraryW(L"crypt32.dll");
    unprotect = crypt ? (HA_UNPROTECT)GetProcAddress(crypt, "CryptUnprotectData") : NULL;
    if (unprotect && unprotect(&input, NULL, &entropy, NULL, NULL, CRYPTPROTECT_UI_FORBIDDEN, &clear)
        && clear.cbData == sizeof(*out)) {
        CopyMemory(out, clear.pbData, sizeof(*out));
        ok = out->format == HA_FORMAT && ha_device(out->device) && ha_proof(out->proof) && ha_digest(out->tokenHash);
    }
    if (crypt) FreeLibrary(crypt);
done:
    CloseHandle(f);
    if (clear.pbData) { SecureZeroMemory(clear.pbData, clear.cbData); LocalFree(clear.pbData); }
    if (input.pbData) HeapFree(GetProcessHeap(), 0, input.pbData);
    return ok;
}
static BOOL ha_store(const WCHAR *path, const WCHAR *scope, HA_RECORD *r) {
    HMODULE crypt = LoadLibraryW(L"crypt32.dll"); HA_PROTECT protect;
    WCHAR temp[HA_PATH_CAP]; DATA_BLOB input = {sizeof(*r), (BYTE *)r}, cipher = {0}, entropy = {128, (BYTE *)scope};
    HANDLE f; DWORD wrote; BOOL ok = FALSE;
    if (!crypt) return FALSE;
    protect = (HA_PROTECT)GetProcAddress(crypt, "CryptProtectData");
    if (!protect || !protect(&input, NULL, &entropy, NULL, NULL, CRYPTPROTECT_UI_FORBIDDEN, &cipher)) goto done;
    lstrcpyW(temp, path); wsprintfW(temp + lstrlenW(temp), L".%08lx.%08lx.tmp", GetCurrentProcessId(), GetCurrentThreadId());
    f = CreateFileW(temp, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f != INVALID_HANDLE_VALUE) {
        ok = WriteFile(f, cipher.pbData, cipher.cbData, &wrote, NULL) && wrote == cipher.cbData && FlushFileBuffers(f);
        CloseHandle(f);
        ok = ok && MoveFileExW(temp, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
        if (!ok) DeleteFileW(temp);
    }
done:
    if (cipher.pbData) LocalFree(cipher.pbData);
    FreeLibrary(crypt); return ok;
}

typedef struct HA_READER_STATE {
    HOME_STATE *home;
    HWND edit, accept, label;
    BOOL consent, rebind, bottom, confirmed;
    DWORD reached;
} HA_READER_STATE;
static void ha_reader_tick(HWND hwnd, HA_READER_STATE *r) {
    SCROLLINFO scroll = { sizeof(scroll), SIF_RANGE | SIF_PAGE | SIF_POS };
    BOOL bottom, ready;
    if (ha_cancelled(r->home)) { DestroyWindow(hwnd); return; }
    if (!r->consent || !r->edit) return;
    bottom = GetScrollInfo(r->edit, SB_VERT, &scroll) && scroll.nPage > 0
        && (LONG)scroll.nPos + (LONG)scroll.nPage - 1 >= scroll.nMax;
    if (bottom && !r->bottom) r->reached = GetTickCount();
    r->bottom = bottom;
    ready = bottom && GetTickCount() - r->reached >= 5000;
    EnableWindow(r->accept, ready);
    SetWindowTextW(r->label, ready ? L"已到达底部；你现在可以明确同意或关闭。"
        : bottom ? L"请在底部至少等待 5 秒。" : L"请先滚动到协议底部。");
}
static LRESULT CALLBACK ha_reader_proc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    HA_READER_STATE *r = (HA_READER_STATE *)GetWindowLongPtrW(hwnd, GWLP_USERDATA);
    if (message == WM_NCCREATE) {
        r = (HA_READER_STATE *)((CREATESTRUCTW *)lParam)->lpCreateParams;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, (LONG_PTR)r);
    }
    if (!r) return DefWindowProcW(hwnd, message, wParam, lParam);
    if (message == WM_TIMER) { ha_reader_tick(hwnd, r); return 0; }
    if (message == WM_CLOSE || (message == WM_COMMAND && LOWORD(wParam) == HA_CANCEL)) {
        DestroyWindow(hwnd); return 0;
    }
    if (message == WM_COMMAND && LOWORD(wParam) == HA_ACCEPT && HIWORD(wParam) == BN_CLICKED
        && lParam && (HWND)lParam == r->accept) {
        ha_reader_tick(hwnd, r);
        if (!ha_cancelled(r->home) && (r->rebind || (r->consent && r->bottom && GetTickCount() - r->reached >= 5000))) {
            r->confirmed = TRUE; DestroyWindow(hwnd);
        }
        return 0;
    }
    return DefWindowProcW(hwnd, message, wParam, lParam);
}
static BOOL ha_reader(HOME_STATE *home, const WCHAR *banner, const WCHAR *body, BOOL consent, BOOL rebind) {
    WNDCLASSW klass = {0}; HA_READER_STATE r = {0}; HWND hwnd, cancel; MSG msg;
    WCHAR *display; DWORD n, i, at = 0;
    if (ha_cancelled(home)) return FALSE;
    klass.lpfnWndProc = ha_reader_proc; klass.hInstance = home_instance;
    klass.hCursor = LoadCursorW(NULL, IDC_ARROW); klass.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    klass.lpszClassName = HA_READER;
    if (!RegisterClassW(&klass) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return FALSE;
    n = (DWORD)lstrlenW(body);
    display = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, (n * 2 + 1) * sizeof(WCHAR));
    if (!display) return FALSE;
    for (i = 0; i < n; ++i) {
        if (body[i] == L'\n' && (!i || body[i - 1] != L'\r')) display[at++] = L'\r';
        display[at++] = body[i];
    }
    display[at] = 0;
    r.home = home; r.consent = consent; r.rebind = rebind;
    hwnd = CreateWindowExW(WS_EX_DLGMODALFRAME, HA_READER, L"原生浏览器 · 用户协议",
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, CW_USEDEFAULT, CW_USEDEFAULT,
        MulDiv(740, home_dpi, 96), MulDiv(535, home_dpi, 96), NULL, NULL, home_instance, &r);
    if (!hwnd) { HeapFree(GetProcessHeap(), 0, display); return FALSE; }
    home_control(0, L"STATIC", banner, WS_CHILD | WS_VISIBLE, 14, 12, 690, 54, hwnd, 0);
    r.edit = home_control(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_VSCROLL
        | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL, 14, 68, 690, 350, hwnd, HA_BODY);
    if (r.edit) {
        SendMessageW(r.edit, EM_SETLIMITTEXT, HA_DOC_MAX * 2 + 1, 0);
        if (!SetWindowTextW(r.edit, display) || (DWORD)GetWindowTextLengthW(r.edit) != at) {
            DestroyWindow(hwnd); HeapFree(GetProcessHeap(), 0, display); return FALSE;
        }
        SendMessageW(r.edit, EM_SETSEL, 0, 0);
        SendMessageW(r.edit, EM_SCROLLCARET, 0, 0);
    }
    HeapFree(GetProcessHeap(), 0, display);
    r.label = home_control(0, L"STATIC", L"", WS_CHILD | WS_VISIBLE, 14, 425, 420, 48, hwnd, 0);
    cancel = home_control(0, L"BUTTON", consent ? L"拒绝 / 关闭" : L"关闭", WS_CHILD | WS_VISIBLE | WS_TABSTOP
        | BS_DEFPUSHBUTTON, 470, 439, 106, 30, hwnd, HA_CANCEL);
    if (consent || rebind) r.accept = home_control(0, L"BUTTON", rebind ? L"重新登记" : L"同意并继续",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | (consent ? WS_DISABLED : 0), 586, 439, 118, 30, hwnd, HA_ACCEPT);
    if (!r.edit || !r.label || !cancel || ((consent || rebind) && !r.accept) || !SetTimer(hwnd, 1, 100, NULL)) {
        DestroyWindow(hwnd); return FALSE;
    }
    ShowWindow(hwnd, SW_SHOW); UpdateWindow(hwnd); SetFocus(cancel);
    while (IsWindow(hwnd)) {
        // A synchronous close/confirm may be dispatched during a message wait without
        // queuing any further message for this private worker thread.
        if (!PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
            MsgWaitForMultipleObjects(0, NULL, FALSE, 100, QS_ALLINPUT);
        } else if (msg.message == WM_QUIT || (msg.message == WM_KEYDOWN && msg.wParam == VK_ESCAPE)) {
            DestroyWindow(hwnd);
        } else if (!IsDialogMessageW(hwnd, &msg)) {
            TranslateMessage(&msg); DispatchMessageW(&msg);
        }
    }
    if (IsWindow(hwnd)) DestroyWindow(hwnd);
    return r.confirmed && !ha_cancelled(home);
}
#ifndef CX_HOME_AGREEMENT_READER
#define CX_HOME_AGREEMENT_READER ha_reader
#endif
static BOOL ha_same(const HA_STATUS *s, const HA_RECORD *r) {
    return !lstrcmpA(s->hash, r->hash) && !lstrcmpA(s->version, r->version);
}
typedef struct HA_WORK {
    WCHAR base[CX_HOME_ADAPTER_URL_CAP], input[CX_HOME_ADAPTER_URL_CAP + CX_DEVICE_ID_CAP + 2];
    WCHAR auth[CX_HOME_API_KEY_CAP + 8], scope[65], guardName[96], anchor[HA_PATH_CAP], account[HA_PATH_CAP];
    char hash[65], token[65];
} HA_WORK;
static BOOL home_agreement_admit(HOME_STATE *home) {
    HA_RECORD *r = NULL, *stage = NULL;
    HA_WORK *work = NULL;
    HA_STATUS status = {0};
    HANDLE guard = NULL;
    BOOL ok = FALSE, locked = FALSE, exists = FALSE, denied = FALSE, readyBody = FALSE;
    const WCHAR *error = L"无法在线核对当前用户协议，普通浏览器会话未启动。内置说明仅供阅读，不代表已同意。";
    DWORD i, length;
    const CX_HOME_CONFIG *config = &home->pendingConfig;
    if (ha_cancelled(home)) goto done;
    work = (HA_WORK *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*work));
    if (!work) goto done;
    if (!home->deviceId[0] || !config->apiKey[0] || !cx_adapter_agreement_base(config->adapterBaseUrl, work->base, ARRAYSIZE(work->base))) {
        error = L"普通浏览器需要 HTTPS 题库地址、有效账号配置和宿主设备标识才能确认用户协议。"; goto done;
    }
    /* With the configured ordinary bearer only; no host/grant identity, cookies or fallback authorization. */
    for (i = 0; config->apiKey[i]; ++i) if (config->apiKey[i] <= 32 || config->apiKey[i] > 126) goto done;
    lstrcpyW(work->auth, L"Bearer "); lstrcatW(work->auth, config->apiKey);
    lstrcpyW(work->input, work->base); length = (DWORD)lstrlenW(work->input) + 1;
    lstrcpyW(work->input + length, home->deviceId); length += (DWORD)lstrlenW(home->deviceId) + 1;
    if (!ha_hash_text(config->apiKey, work->token)
        || !cx_adapter_agreement_sha256((BYTE *)work->input, length * sizeof(WCHAR), work->hash)
        || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, work->hash, -1, work->scope, ARRAYSIZE(work->scope))) goto done;

    r = (HA_RECORD *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*r));
    stage = (HA_RECORD *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*stage));
    if (!r || !stage) goto done;
    if (home->options->noDiskWrite) {
        if (home->agreementMemory && !lstrcmpW(work->scope, home->agreementMemoryScope)) {
            CopyMemory(r, home->agreementMemory, sizeof(*r)); exists = TRUE;
        }
    } else {
        lstrcpyW(work->guardName, L"Local\\CXPlusAgreement-"); lstrcatW(work->guardName, work->scope);
        guard = CreateMutexW(NULL, FALSE, work->guardName);
        if (!guard) goto done;
        for (i = 0; i < 120 && !ha_cancelled(home); ++i) {
            DWORD wait = WaitForSingleObject(guard, 100);
            if (wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED) { locked = TRUE; break; }
            if (wait != WAIT_TIMEOUT) break;
        }
        if (!locked || ha_cancelled(home)) goto done;
        if (!ha_path(home, work->scope, NULL, work->anchor) || !ha_path(home, work->scope, work->token, work->account)
            || !ha_load(work->account, work->scope, r, &exists) || (!exists && !ha_load(work->anchor, work->scope, r, &exists))) {
            error = L"无法安全读取宿主协议缓存，普通浏览器会话未启动。"; goto done;
        }
    }
    if (ha_cancelled(home)) goto done;
    if (!exists && !ha_enroll(work->base, r)) goto done;
    if (ha_cancelled(home)) goto done;
    if (!ha_status(work->base, work->auth, r, &status, &denied)) {
        if (denied && exists && !ha_cancelled(home) && CX_HOME_AGREEMENT_READER(home, L"当前账号无法证明已有协议主体",
            L"可能已切换账号或凭据已失效。重新登记仅创建独立的协议主体，不代表已经同意；原有账号的记录不会作为当前账号的凭据。",
            FALSE, TRUE)) {
            SecureZeroMemory(r, sizeof(*r));
            if (ha_cancelled(home) || !ha_enroll(work->base, r) || ha_cancelled(home) || !ha_status(work->base, work->auth, r, &status, NULL)) goto done;
        } else goto done;
    }
    if (ha_cancelled(home)) goto done;
    if (!ha_same(&status, r) || !ha_cached_body(r)) {
        /* A published version is immutable; neither altered bytes nor a partial fetch replace the cache. */
        if (!lstrcmpA(status.version, r->version) && lstrcmpA(status.hash, r->hash)) goto done;
        CopyMemory(stage, r, sizeof(*stage));
        if (!ha_current(work->base, work->auth, stage, &status)) goto done;
        CopyMemory(r, stage, sizeof(*r));
    }
    readyBody = TRUE;
    r->format = HA_FORMAT; lstrcpyA(r->tokenHash, work->token);
    if (!home->options->noDiskWrite) {
        if (!ha_store(work->account, work->scope, r) || !ha_store(work->anchor, work->scope, r)) {
            error = L"未能原子保存已校验的宿主协议缓存，普通浏览器会话未启动。"; goto done;
        }
    } else {
        if (!home->agreementMemory) home->agreementMemory = (HA_RECORD *)HeapAlloc(GetProcessHeap(), 0, sizeof(*r));
        if (!home->agreementMemory) goto done;
        CopyMemory(home->agreementMemory, r, sizeof(*r)); lstrcpyW(home->agreementMemoryScope, work->scope);
    }
    if (status.pending) {
        WCHAR banner[CX_HOME_ADAPTER_URL_CAP + 100];
        lstrcpyW(banner, L"请阅读当前用户协议 · 版本 ");
        MultiByteToWideChar(CP_UTF8, 0, r->version, -1, banner + lstrlenW(banner), 49);
        home_append(banner, ARRAYSIZE(banner), L"\r\n来源：");
        home_append(banner, ARRAYSIZE(banner), work->base);
        if (!CX_HOME_AGREEMENT_READER(home, banner, r->body, TRUE, FALSE)) {
            error = L"当前用户协议未明确同意，普通浏览器会话未启动。";
            readyBody = FALSE;
            goto done;
        }
        if (ha_cancelled(home) || !ha_status(work->base, work->auth, r, &status, NULL) || !ha_same(&status, r)) goto done;
        if (status.pending && !ha_submit(work->base, work->auth, r)) goto done;
    }
    /* Fresh proof immediately before admitting a browser; a receipt or cache alone is insufficient. */
    ok = !ha_cancelled(home) && ha_status(work->base, work->auth, r, &status, NULL)
        && ha_same(&status, r) && !status.pending && !ha_cancelled(home);
done:
    if (locked) ReleaseMutex(guard);
    if (guard) CloseHandle(guard);
    if (!ok) {
        home_copy(home->error, ARRAYSIZE(home->error), error);
        /* Only show cached verified plaintext from this exact token scope, never an authorization. */
        if (r && !ha_cancelled(home) && (readyBody || (!lstrcmpA(r->tokenHash, work->token) && ha_cached_body(r))))
            (void)CX_HOME_AGREEMENT_READER(home, L"已校验的旧正文（只读，不能作为同意）", r->body, FALSE, FALSE);
    }
    if (work) { SecureZeroMemory(work, sizeof(*work)); HeapFree(GetProcessHeap(), 0, work); }
    ha_free_record(stage); ha_free_record(r); return ok;
}
