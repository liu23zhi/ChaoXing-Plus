/* First-party integration: actual Chromium, fresh signed synthetic CRX,
 * production session and broker, and no website or user credentials. */
#include <stdio.h>
#include <wchar.h>
#include "../browser-session.c"
#include "../ordinary-channel.inc"

static volatile LONG permitted, reads;
static BOOL own_result(void *unused) {
    (void)unused; InterlockedIncrement(&reads);
    return InterlockedCompareExchange(&permitted, 0, 0) != 0;
}
static BOOL own_attach(void *context, HANDLE job) {
    return cx_ordinary_channel_attach_job(context, job);
}
static BOOL independent_job(void *context, HANDLE job) { return context == NULL && job != NULL; }

static BOOL fixture_tab(CX_BROWSER_SESSION *s, const char *url, char id[128], WCHAR error[1024]) {
    JT t[512]; char *reply = NULL, target[128], params[256];
    DWORD start = GetTickCount(), at;
    int result, targets, i;
    BOOL ok = FALSE;
    do {
        if (!bs_command(s, "Target.getTargets", NULL, NULL, &reply, error, 1024)) goto done;
        if (jparse(reply, lstrlenA(reply), t, ARRAYSIZE(t)) <= 0) goto done;
        result = jkey(reply, t, 0, "result");
        targets = jkey(reply, t, result, "targetInfos");
        if (targets < 0 || t[targets].type != '[') goto done;
        for (i = targets + 1; i < t[targets].next; i = t[i].next) {
            if (!jeq(reply, t, jkey(reply, t, i, "url"), url)) continue;
            if (!jstr(reply, t, jkey(reply, t, i, "targetId"), target, ARRAYSIZE(target))) goto done;
            HeapFree(GetProcessHeap(), 0, reply); reply = NULL; at = 0;
            if (!bs_text_add(params, ARRAYSIZE(params), &at, "{\"targetId\":")
                || !bs_quote(params, ARRAYSIZE(params), &at, target)
                || !bs_text_add(params, ARRAYSIZE(params), &at, ",\"flatten\":true}")) goto done;
            ok = bs_command(s, "Target.attachToTarget", params, NULL, &reply, error, 1024)
                && bs_reply_string(reply, "sessionId", id, 128);
            goto done;
        }
        HeapFree(GetProcessHeap(), 0, reply); reply = NULL;
        Sleep(50);
    } while (GetTickCount() - start < 3000);
done:
    if (reply) HeapFree(GetProcessHeap(), 0, reply);
    return ok;
}

static BOOL own_probe(CX_BROWSER_SESSION *s, const char *target, BOOL wanted, WCHAR error[1024]) {
    JT t[256]; char *reply = NULL;
    const char *request = "{\"awaitPromise\":true,\"returnByValue\":true,\"expression\":"
        "\"import('./ordinary-native-authority.js').then(async m=>{"
        "const r=await m.readNativeAuthorization(chrome,5000);"
        "const v=await chrome.runtime.sendMessage({kind:'chaoxing-plus:agreement',operation:'refresh'});"
        "return {allowed:r.allowed,keys:Object.keys(r).join(','),phase:v.phase};})\"}";
    int outer, remote = 0, data, allowed, keys, phase;
    BOOL ok = FALSE;
    if (!bs_command(s, "Runtime.evaluate", request, target, &reply, error, 1024)) goto done;
    if (jparse(reply, lstrlenA(reply), t, ARRAYSIZE(t)) <= 0) goto done;
    outer = jkey(reply, t, 0, "result");
    remote = jkey(reply, t, outer, "result");
    data = jkey(reply, t, remote, "value");
    allowed = jkey(reply, t, data, "allowed"); keys = jkey(reply, t, data, "keys"); phase = jkey(reply, t, data, "phase");
    ok = allowed >= 0 && t[allowed].type == 'p' && jeq(reply, t, allowed, wanted ? "true" : "false")
        && jeq(reply, t, keys, "allowed") && jeq(reply, t, phase, wanted ? "accepted" : "host-pending");
    if (!ok && reply) fprintf(stderr, "unexpected fixture reply: %s\n", reply);
done:
    if (reply) HeapFree(GetProcessHeap(), 0, reply);
    return ok;
}

int wmain(int argc, WCHAR **argv) {
    static WCHAR url[128], error[1024], first[BS_PATH_CAP], second[BS_PATH_CAP], name[128], manifest[MAX_PATH], directory[MAX_PATH];
    char tab[128], url8[128];
    CX_BROWSER_SESSION *owned = NULL, *other = NULL, *legacy = NULL;
    CX_ORDINARY_CHANNEL *channel = NULL;
    CX_BROWSER_OPTIONS opts = {0};
    CX_BROWSER_ORDINARY cfg = {0};
    int status = 1, broker;
    if (cx_ordinary_channel_broker(&broker)) return broker;
    if (argc != 8) return 2;
    if (!cx_ordinary_channel_open(argv[6], argv[4], argv[5], own_result, NULL, &channel)) {
        fprintf(stderr, "cannot open ordinary result-only channel, system=%lu\n", GetLastError()); goto done;
    }
    cfg.hostName = cx_ordinary_channel_name(channel); cfg.instance = argv[6]; cfg.attach = own_attach; cfg.context = channel;
    lstrcpynW(name, cfg.hostName, ARRAYSIZE(name));
    lstrcpynW(manifest, channel->manifest, ARRAYSIZE(manifest));
    lstrcpynW(directory, channel->directory, ARRAYSIZE(directory));
    opts.browserPath = argv[1]; opts.ordinary = &cfg; opts.expectedExtensionId = argv[4]; opts.headless = TRUE;
    opts.crxPath = argv[3]; opts.initialUrl = L"about:blank";
    if (cx_browser_start(&opts, &legacy, error, 1024) || !wcsstr(error, L"不支持普通 Windows 授权通道")) goto done;
    printf("legacy signed package rejected before attaching a browser job\n");

    opts.crxPath = argv[2];
    swprintf_s(url, ARRAYSIZE(url), L"chrome-extension://%s/extension-agreement.html", argv[4]);
    if (!WideCharToMultiByte(CP_UTF8, 0, url, -1, url8, ARRAYSIZE(url8), NULL, NULL)) goto done;
    /* The signed synthetic internal route stands in for a site; no origin override or site visit. */
    opts.initialUrl = url;
    InterlockedExchange(&permitted, 1);
    if (!cx_browser_start(&opts, &owned, error, 1024)) goto done;
    lstrcpynW(first, cx_browser_profile(owned), ARRAYSIZE(first));
    if (!fixture_tab(owned, url8, tab, error) || !own_probe(owned, tab, TRUE, error) || reads != 2
        || lstrcmpW(cx_browser_extension_version(owned), argv[7])) goto done;
    printf("actual owned browser extension and worker observed allowed=true with exactly one field\n");

    cfg.attach = independent_job; cfg.context = NULL;
    if (!cx_browser_start(&opts, &other, error, 1024)) goto done;
    lstrcpynW(second, cx_browser_profile(other), ARRAYSIZE(second));
    if (!fixture_tab(other, url8, tab, error) || !own_probe(other, tab, FALSE, error) || reads != 2) goto done;
    printf("independent actual browser job with the same locator was denied\n");

    InterlockedExchange(&permitted, 0);
    if (!fixture_tab(owned, url8, tab, error) || !own_probe(owned, tab, FALSE, error) || reads != 4) goto done;
    printf("the same owned browser observed fresh allowed=false without a cached allow\n");
    cx_ordinary_channel_close(channel); channel = NULL;
    if (!own_probe(owned, tab, FALSE, error) || reads != 4) goto done;
    {
        HKEY handle;
        WCHAR key[256];
        swprintf_s(key, ARRAYSIZE(key), L"%s\\%s", lstrcmpW(argv[5], L"edge") == 0 ? cx_oc_edge_key : cx_oc_chrome_key, name);
        if (RegOpenKeyExW(HKEY_CURRENT_USER, key, 0, KEY_READ | KEY_WOW64_32KEY, &handle) == ERROR_SUCCESS) {
            RegCloseKey(handle); goto done;
        }
    }
    if (!cx_browser_close(other, error, 1024) || !cx_browser_close(owned, error, 1024)) goto done;
    if (GetFileAttributesW(first) != INVALID_FILE_ATTRIBUTES || GetFileAttributesW(second) != INVALID_FILE_ATTRIBUTES) goto done;
    if (GetFileAttributesW(manifest) != INVALID_FILE_ATTRIBUTES || GetFileAttributesW(directory) != INVALID_FILE_ATTRIBUTES) goto done;
    printf("closed channel denied; owned registration, manifest and two fresh profiles cleaned\n");
    status = 0;
done:
    if (status) fwprintf(stderr, L"ordinary browser integration failed (observed callbacks=%ld): %ls\n", reads, error);
    cx_ordinary_channel_close(channel);
    if (legacy) { cx_browser_close(legacy, NULL, 0); cx_browser_destroy(legacy); }
    if (other) { cx_browser_close(other, NULL, 0); cx_browser_destroy(other); }
    if (owned) { cx_browser_close(owned, NULL, 0); cx_browser_destroy(owned); }
    return status;
}
