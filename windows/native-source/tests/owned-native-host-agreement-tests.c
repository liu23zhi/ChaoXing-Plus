/* Owned fixture: real Windows host gate and reader, with a bounded synthetic provider.
 * The existing process/package stubs do not open a browser or call a site. */
#include "../adapter-account.h"

struct HOME_STATE;
static BOOL fixture_agreement_request(const WCHAR *, const WCHAR *, const WCHAR *, const WCHAR *,
    const WCHAR *, const char *, DWORD, CX_ADAPTER_REPLY *);
static BOOL fixture_agreement_reader(struct HOME_STATE *, const WCHAR *, const WCHAR *, BOOL, BOOL);
#define CX_HOME_AGREEMENT_REQUEST fixture_agreement_request
#define CX_HOME_AGREEMENT_READER fixture_agreement_reader
#include "home-tests.c"

typedef struct PROJECT_PROOF {
    WCHAR device[37], proof[48], base[120];
    int owner, accepted;
} PROJECT_PROOF;
static PROJECT_PROOF fixtureProofs[10];
static int enrolls, submits, receipts, reads, prompts, readonlyViews, rebinds, version = 1;
static BOOL approve, rebind, offline, badBody, badReceipt, rotateAfterReader;
static const char *fixtureBody[3] = {"", "owned first exact agreement", "owned second exact agreement"};

static BOOL fixture_reply(CX_ADAPTER_REPLY *r, DWORD status, const char *body, DWORD limit) {
    r->status = status; r->length = lstrlenA(body);
    if (r->length > limit) return FALSE;
    r->body = (char *)HeapAlloc(GetProcessHeap(), 0, r->length + 1);
    if (!r->body) return FALSE;
    lstrcpyA(r->body, body); return TRUE;
}
static BOOL fixture_agreement_request(const WCHAR *base, const WCHAR *method, const WCHAR *path,
    const WCHAR *authorization, const WCHAR *credential, const char *data, DWORD limit, CX_ADAPTER_REPLY *reply) {
    char json[512], hash[65], id[37], proofAscii[48];
    PROJECT_PROOF *p; int i, owner = 0;
    ZeroMemory(reply, sizeof(*reply));
    if (offline) return FALSE;
    if (authorization && (!lstrcmpW(authorization, L"Bearer owned-a")
        || !lstrcmpW(authorization, L"Bearer owned-a-rotated"))) owner = 1;
    if (authorization && !lstrcmpW(authorization, L"Bearer owned-b")) owner = 2;
    if (!lstrcmpW(path, L"api/agreements/devices") && !lstrcmpW(method, L"POST")) {
        if (credential || authorization || data || enrolls >= 9) return FALSE;
        p = &fixtureProofs[enrolls++];
        wsprintfW(p->device, L"11111111-2222-4333-8444-55555555555%d", enrolls);
        lstrcpyW(p->proof, L"agd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0");
        p->proof[46] = (WCHAR)(L'0' + enrolls);
        lstrcpynW(p->base, base, ARRAYSIZE(p->base));
        WideCharToMultiByte(CP_UTF8, 0, p->device, -1, id, ARRAYSIZE(id), NULL, NULL);
        WideCharToMultiByte(CP_UTF8, 0, p->proof, -1, proofAscii, ARRAYSIZE(proofAscii), NULL, NULL);
        wsprintfA(json, "{\"deviceId\":\"%s\",\"deviceCredential\":\"%s\"}", id, proofAscii);
        return fixture_reply(reply, 201, json, limit);
    }
    for (i = 0; i < enrolls; ++i) if (credential && !lstrcmpW(fixtureProofs[i].proof, credential)) break;
    if (!owner || i == enrolls || lstrcmpW(base, fixtureProofs[i].base)
        || (fixtureProofs[i].owner && fixtureProofs[i].owner != owner)) return fixture_reply(reply, 401, "{}", limit);
    p = &fixtureProofs[i];
    if (!cx_adapter_agreement_sha256((const BYTE *)fixtureBody[version], (DWORD)lstrlenA(fixtureBody[version]), hash)) return FALSE;
    WideCharToMultiByte(CP_UTF8, 0, p->device, -1, id, ARRAYSIZE(id), NULL, NULL);
    if (!lstrcmpW(path, L"api/agreements/status") && !lstrcmpW(method, L"GET") && !data) {
        wsprintfA(json, "{\"deviceId\":\"%s\",\"version\":\"v%d\",\"content_hash\":\"%s\",\"needsAcceptance\":%s}",
            id, version, hash, p->accepted == version ? "false" : "true");
        return fixture_reply(reply, 200, json, limit);
    }
    if (!lstrcmpW(path, version == 1 ? L"api/agreements/current?version=v1" : L"api/agreements/current?version=v2")
        && !lstrcmpW(method, L"GET") && !data) {
        ++reads;
        wsprintfA(json, "{\"type\":\"user_agreement\",\"version\":\"v%d\",\"summary\":\"fixture\","
            "\"content_hash\":\"%s\",\"needsAcceptance\":%s,\"publishedAt\":\"2026-11-27T00:00:01Z\",\"body\":\"%s\"}",
            version, hash, p->accepted == version ? "false" : "true", badBody ? "wrong bytes" : fixtureBody[version]);
        return fixture_reply(reply, 200, json, limit);
    }
    if (!lstrcmpW(path, L"api/agreements/consents") && !lstrcmpW(method, L"POST")
        && data && !lstrcmpA(data, version == 1 ? "{\"version\":\"v1\"}" : "{\"version\":\"v2\"}")) {
        ++submits;
        if (!badReceipt) { p->owner = owner; p->accepted = version; ++receipts; }
        wsprintfA(json, "{\"accepted\":true,\"deviceId\":\"%s\",\"version\":\"v%d\",\"acceptedAt\":\"2026-11-27T00:00:02Z\"}",
            id, badReceipt ? 9 : version);
        return fixture_reply(reply, 200, json, limit);
    }
    return FALSE;
}
static BOOL fixture_agreement_reader(struct HOME_STATE *home, const WCHAR *header, const WCHAR *body, BOOL consent, BOOL isRebind) {
    (void)home; (void)header; (void)body;
    if (isRebind) { ++rebinds; return rebind; }
    if (consent) { ++prompts; if (approve && rotateAfterReader) version = 2; return approve; }
    ++readonlyViews; return FALSE;
}
static void ordinary(HOME_STATE *home, DWORD op) {
    DWORD begin = GetTickCount();
    home_begin(home, op, op == HOME_EDGE ? L"edge" : L"chrome", &shared);
    while (home->worker && GetTickCount() - begin < 7000) {
        clear_messages(); MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
    }
    clear_messages();
    check(!home->worker, "ordinary worker returned (native browser remains stubbed)");
}
static HOME_STATE *make_profile(void) {
    HOME_STATE *state = make_home();
    home_copy(state->deviceId, CX_DEVICE_ID_CAP, L"11111111-2222-4333-8444-555555555555");
    return state;
}

static HWND readerWindow;
static BOOL CALLBACK owned_reader_window(HWND window, LPARAM unused) {
    WCHAR klass[64];
    (void)unused;
    if (GetClassNameW(window, klass, ARRAYSIZE(klass)) && !lstrcmpW(klass, HA_READER) && GetDlgItem(window, HA_ACCEPT)) {
        readerWindow = window; return FALSE;
    }
    return TRUE;
}
static DWORD WINAPI owned_reader(void *state) {
    WCHAR text[1024]; DWORD i;
    for (i = 0; i < ARRAYSIZE(text) - 1; ++i) text[i] = i % 8 == 7 ? L'\n' : L'x';
    text[i] = 0;
    return ha_reader((HOME_STATE *)state, L"Owned test of real native HTML-free text reader", text, TRUE, FALSE);
}
static void owned_real_reader_tests(HOME_STATE *state) {
    DWORD id, result = 99, start = GetTickCount();
    HANDLE thread = CreateThread(NULL, 0, owned_reader, state, 0, &id);
    HWND edit, accept;
    readerWindow = NULL;
    if (!thread) { check(FALSE, "owned reader thread"); return; }
    while (!readerWindow && GetTickCount() - start < 3000) {
        EnumThreadWindows(id, owned_reader_window, 0); Sleep(25);
    }
    if (!readerWindow) {
        check(FALSE, "owned native agreement reader visible");
        InterlockedExchange(&state->agreementCancelled, 1);
        WaitForSingleObject(thread, 2000); CloseHandle(thread); return;
    }
    edit = GetDlgItem(readerWindow, HA_BODY); accept = GetDlgItem(readerWindow, HA_ACCEPT);
    check(edit && accept && !IsWindowEnabled(accept), "native reader starts with consent disabled");
    SendMessageW(readerWindow, WM_COMMAND, MAKEWPARAM(HA_ACCEPT, BN_CLICKED), (LPARAM)accept);
    check(IsWindow(readerWindow), "pre-bottom click cannot confirm");
    SendMessageW(edit, EM_SETSEL, (WPARAM)-1, -1);
    SendMessageW(edit, EM_SETSEL, GetWindowTextLengthW(edit), GetWindowTextLengthW(edit));
    SendMessageW(edit, EM_SCROLLCARET, 0, 0);
    SendMessageW(edit, WM_VSCROLL, SB_BOTTOM, 0);
    Sleep(4700);
    SendMessageW(readerWindow, WM_COMMAND, MAKEWPARAM(HA_ACCEPT, BN_CLICKED), (LPARAM)accept);
    check(IsWindow(readerWindow) && !IsWindowEnabled(accept), "bottom reached but under 5s cannot confirm");
    Sleep(550);
    check(IsWindowEnabled(accept), "real bottom scroll and 5s make confirm available");
    SendMessageW(readerWindow, WM_COMMAND, MAKEWPARAM(HA_ACCEPT, BN_CLICKED), (LPARAM)accept);
    if (WaitForSingleObject(thread, 1500) != WAIT_OBJECT_0) {
        PostMessageW(readerWindow, WM_CLOSE, 0, 0); WaitForSingleObject(thread, 1500);
    }
    (void)GetExitCodeThread(thread, &result);
    check(result == 1, "real native reader accepts only explicit timely action");
    CloseHandle(thread);

    readerWindow = NULL; result = 99; start = GetTickCount();
    thread = CreateThread(NULL, 0, owned_reader, state, 0, &id);
    if (!thread) { check(FALSE, "owned cancel reader thread"); return; }
    while (!readerWindow && GetTickCount() - start < 3000) {
        EnumThreadWindows(id, owned_reader_window, 0); Sleep(25);
    }
    if (readerWindow) SendMessageW(readerWindow, WM_CLOSE, 0, 0);
    else InterlockedExchange(&state->agreementCancelled, 1);
    WaitForSingleObject(thread, 1500);
    (void)GetExitCodeThread(thread, &result);
    check(readerWindow && result == 0, "closing real native reader is not consent");
    CloseHandle(thread);
}

void HomeOwnedAgreementMatrixMain(void) {
    HOME_STATE *state;
    fetchEntered = CreateEventW(NULL, TRUE, FALSE, NULL);
    fetchRelease = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!fetchEntered || !fetchRelease) ExitProcess(2);
    cx_options_init(&options); cx_home_config_init(&shared);
    options.configPathSet = TRUE;
    GetCurrentDirectoryW(CX_OPTIONS_PATH_CAP, options.configPath);
    {
        WCHAR name[80];
        wsprintfW(name, L"\\fixture-matrix-%08lx-%08lx.json", GetCurrentProcessId(), GetTickCount());
        home_append(options.configPath, CX_OPTIONS_PATH_CAP, name);
    }
    home_copy(shared.adapterBaseUrl, CX_HOME_ADAPTER_URL_CAP, L"https://127.0.0.1:1/");
    home_copy(shared.apiKey, CX_HOME_API_KEY_CAP, L"owned-a");
    home_instance = GetModuleHandleW(NULL); home_default_font = (HFONT)GetStockObject(DEFAULT_GUI_FONT);
    if (!home_register_class()) ExitProcess(3);
    mockCachePackage = TRUE;
    state = make_profile();
    ordinary(state, HOME_EDGE);
    check(enrolls == 1 && prompts == 1 && submits == 0 && browserStarts == 0,
        "fresh unknown/closed reader blocks launch and sends no consent");
    approve = TRUE;
    ordinary(state, HOME_CHROME);
    check(enrolls == 1 && submits == 1 && receipts == 1 && browserStarts == 1,
        "same exact proof -> explicit receipt plus current status admits Chrome");
    free_home(state);
    state = make_profile(); // new HOME_STATE, same host and disk
    home_copy(shared.apiKey, CX_HOME_API_KEY_CAP, L"owned-a-rotated");
    ordinary(state, HOME_EDGE);
    check(enrolls == 1 && submits == 1 && browserStarts == 2,
        "same host and source, rotated same-account token revalidates receipt for Edge");
    home_copy(shared.apiKey, CX_HOME_API_KEY_CAP, L"owned-b");
    ordinary(state, HOME_EDGE);
    check(enrolls == 1 && rebinds == 1 && browserStarts == 2,
        "different account cannot inherit previous host consent");
    rebind = TRUE; approve = FALSE;
    ordinary(state, HOME_EDGE);
    check(enrolls == 2 && submits == 1 && browserStarts == 2,
        "explicit re-enrollment is not consent for the new account");
    home_copy(shared.apiKey, CX_HOME_API_KEY_CAP, L"owned-a");
    approve = TRUE; offline = TRUE;
    ordinary(state, HOME_EDGE);
    check(browserStarts == 2 && readonlyViews > 0, "offline with verified historical body is display-only");
    offline = FALSE; version = 2; badBody = TRUE;
    ordinary(state, HOME_EDGE);
    check(submits == 1 && browserStarts == 2, "malformed v2 body cannot replace cache or start");
    badBody = FALSE; badReceipt = TRUE;
    ordinary(state, HOME_EDGE);
    check(submits == 2 && receipts == 1 && browserStarts == 2,
        "wrong v2 receipt can never count as authorization");
    badReceipt = FALSE;
    ordinary(state, HOME_EDGE);
    check(submits == 3 && receipts == 2 && browserStarts == 3, "verified v2 receipt and live status admit");
    home_copy(shared.adapterBaseUrl, CX_HOME_ADAPTER_URL_CAP, L"https://127.0.0.1:2/");
    approve = FALSE;
    ordinary(state, HOME_CHROME);
    check(enrolls == 3 && browserStarts == 3 && reads >= 4, "another HTTPS service never uses old proof or consent");
    home_copy(shared.adapterBaseUrl, CX_HOME_ADAPTER_URL_CAP, L"https://127.0.0.1:3/");
    approve = TRUE; version = 1; rotateAfterReader = TRUE;
    ordinary(state, HOME_EDGE);
    check(enrolls == 4 && submits == 3 && browserStarts == 3, "release advances after reading: no stale submit or start");
    {
        CX_ADAPTER_REPLY rejected = {0};
        check(!cx_adapter_agreement_request(L"http://127.0.0.1:1", L"POST", L"api/agreements/devices",
            NULL, NULL, NULL, HA_SMALL_LIMIT, &rejected) && rejected.status == 0,
            "native agreement transport cannot downgrade to HTTP");
        check(!cx_adapter_agreement_request(L"https://127.0.0.1:1", L"POST", L"api/other",
            NULL, NULL, NULL, HA_SMALL_LIMIT, &rejected) && rejected.status == 0,
            "native agreement transport is limited to the four agreement endpoints");
    }
    owned_real_reader_tests(state);
    free_home(state);
    CloseHandle(fetchEntered); CloseHandle(fetchRelease);
    SecureZeroMemory(&shared, sizeof(shared));
    ExitProcess(failures ? 1 : 0);
}
