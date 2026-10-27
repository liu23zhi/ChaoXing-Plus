/* Private adapter: the session model schedules tasks; only this layer performs I/O. */
static BOOL h_send_command(H_NATIVE_PAGE *page, const char *method, const char *params,
                           char **reply, DWORD *replyLength, WCHAR *error, DWORD errorCap) {
    DWORD id = page->nextId++, at = 0, size = (DWORD)h_len(params ? params : "{}") + 256;
    char number[16], *command = (char *)HeapAlloc(GetProcessHeap(), 0, size);
    BOOL ok;
    if (!command) { h_error(error, errorCap, L"out of memory building CDP command"); return FALSE; }
    h_decimal(number, id);
    ok = h_append_bytes(command, size, &at, "{\"id\":", 6)
        && h_append_bytes(command, size, &at, number, (DWORD)h_len(number))
        && h_append_bytes(command, size, &at, ",\"method\":", 10)
        && h_json_quote(command, size, &at, method, (DWORD)h_len(method))
        && h_append_bytes(command, size, &at, ",\"params\":", 10)
        && h_append_bytes(command, size, &at, params ? params : "{}", (DWORD)h_len(params ? params : "{}"))
        && h_append_bytes(command, size, &at, "}", 1);
    if (ok) ok = net_ws_send_text(page->ws, command, at, error, errorCap);
    HeapFree(GetProcessHeap(), 0, command);
    return ok && h_wait_reply(page->ws, id, FALSE, reply, replyLength, error, errorCap);
}

static void h_page_close(H_NATIVE_PAGE *page) {
    h_sample_page(page);
    if (page->state) cx_session_free(page->state);
    if (page->ws) net_ws_close(page->ws);
    page->state = NULL; page->ws = NULL;
    h_zero(&page->reported, sizeof(page->reported));
    if (h_current_page == page) { h_current_page = NULL; h_task_pending = FALSE; h_current_context = 0; }
}

static BOOL h_endpoint_owned(USHORT port, const CX_OPTIONS *options, WCHAR *error, DWORD errorCap) {
    DWORD owner = 0;
    if (options->attachPortSet) return TRUE;
    if (!h_client_pid) { h_error(error, errorCap, L"CDP endpoint has no owned client process"); return FALSE; }
    if (!proc_port_owner(port, h_client_pid, &owner, error, errorCap)) return FALSE;
    if (!owner) { h_error(error, errorCap, L"CDP listener ownership could not be verified"); return FALSE; }
    h_report.ownershipVerified = TRUE;
    return TRUE;
}

static BOOL h_page_open(H_NATIVE_PAGE *page, USHORT port, const CX_OPTIONS *options,
                        const char *trampoline, DWORD trampolineLength, WCHAR *error, DWORD errorCap) {
    char *reply = NULL, *params = NULL;
    DWORD length = 0, at = 0, size = trampolineLength * 6 + 64;
    BOOL ok = FALSE;
    if (!h_operation_active()) return FALSE;
    if (!h_endpoint_owned(port, options, error, errorCap)) { h_page_close(page); return FALSE; }
    page->ws = net_ws_open(port, page->websocket, error, errorCap);
    if (!page->ws) return FALSE;
    page->state = cx_session_create(page->url, options->injectBlankFrames, options->extensionEnabled);
    if (!page->state) { h_error(error, errorCap, L"out of memory creating page session"); goto done; }
    h_current_page = page; h_task_pending = FALSE; h_current_context = 0;
    page->nextId = 1;
    if (!h_send_command(page, "Page.enable", NULL, NULL, NULL, error, errorCap)) goto done;
    if (h_send_command(page, "Page.getFrameTree", NULL, &reply, &length, error, errorCap)) {
        cx_session_frame_tree(page->state, reply, length);
        h_sample_page(page);
        net_free(reply); reply = NULL;
    }
    if (!h_send_command(page, "Runtime.enable", NULL, NULL, NULL, error, errorCap)) goto done;
    params = (char *)HeapAlloc(GetProcessHeap(), 0, size);
    if (!params) { h_error(error, errorCap, L"out of memory registering new-document script"); goto done; }
    if (!h_append_bytes(params, size, &at, "{\"source\":", 10)
        || !h_json_quote(params, size, &at, trampoline, trampolineLength)
        || !h_append_bytes(params, size, &at, "}", 1)) goto done;
    if (!h_send_command(page, "Page.addScriptToEvaluateOnNewDocument", params, NULL, NULL, error, errorCap))
        h_audit_event("warn", "session", "New-document registration unavailable; retaining context and top-frame fallback");
    page->ensureAt = GetTickCount() + 2500; page->ensurePending = TRUE;
    page->retryAt = 0;
    ok = h_operation_active();
    if (ok) {
        ++h_report.pageSessions;
        if (page->openedBefore) ++h_report.reconnects;
        h_audit_event("info", "session", page->openedBefore ? "CDP page reconnected" : "CDP page connected");
        page->openedBefore = TRUE;
    }
done:
    if (reply) net_free(reply);
    if (params) HeapFree(GetProcessHeap(), 0, params);
    if (!ok) h_page_close(page);
    return ok;
}

static char *h_bundle_source(const char *bundle, DWORD length, DWORD *wrappedLength) {
    const char prefix[] = "if(!window.__CX_WIN_BUNDLE_LOADED__){\n";
    const char suffix[] = "\n;window.__CX_WIN_BUNDLE_LOADED__=true;}true;";
    DWORD at = 0, size = length + sizeof(prefix) + sizeof(suffix);
    char *source = (char *)HeapAlloc(GetProcessHeap(), 0, size);
    if (!source) return NULL;
    if (!h_append_bytes(source, size, &at, prefix, sizeof(prefix) - 1)
        || !h_append_bytes(source, size, &at, bundle, length)
        || !h_append_bytes(source, size, &at, suffix, sizeof(suffix) - 1)) {
        HeapFree(GetProcessHeap(), 0, source); return NULL;
    }
    *wrappedLength = at; return source;
}

static BOOL h_page_pump(H_NATIVE_PAGE *page, const CX_OPTIONS *options, const char *bootstrap, DWORD bootstrapLength,
                        const char *bundle, DWORD bundleLength, const char *style, DWORD styleLength,
                        WCHAR *error, DWORD errorCap) {
    const char requestReady[] = "(function(){var h=window.__CX_WIN_HOST__;if(document.readyState!=='loading'&&h&&typeof h.requestBundle==='function'){h.requestBundle();}return true;})()";
    char *message = NULL;
    DWORD length, i;
    int result;
    BOOL success;
    CX_SESSION_TASK task;
    h_current_page = page; h_task_pending = FALSE; h_current_context = 0;
    for (i = 0; i < 64; ++i) {
        result = net_ws_read_timeout(page->ws, &message, &length, 0, error, errorCap);
        if (result < 0) return FALSE;
        if (!result) break;
        h_dispatch_event(message, length); net_free(message); message = NULL;
    }
    if (page->ensurePending && (LONG)(GetTickCount() - page->ensureAt) >= 0) {
        page->ensurePending = FALSE; cx_session_request_top_ensure(page->state);
    }
    for (i = 0; i < 32 && h_operation_active() && cx_session_next(page->state, &task); ++i) {
        h_current_task = task; h_task_pending = TRUE; h_current_context = task.contextId;
        if (task.type == CX_SESSION_TASK_BOOTSTRAP) {
            success = h_set_page_config(page->ws, &page->nextId, options, style, styleLength, FALSE, error, errorCap)
                && h_inject_asset(page->ws, &page->nextId, options->injectStrategy, (DWORD)options->injectRetries, bootstrap, bootstrapLength, error, errorCap);
            /* A reconnect must not depend on CDP retaining old console-ready events. */
            if (success) success = h_send_eval(page->ws, page->nextId++, requestReady, sizeof(requestReady) - 1, error, errorCap);
        } else {
            success = h_inject_asset(page->ws, &page->nextId, options->injectStrategy, (DWORD)options->injectRetries, bundle, bundleLength, error, errorCap);
        }
        /* A normal stop can cancel a valid in-flight task without failing it. */
        if ((success || h_operation_active()) && cx_session_complete(page->state, &task, success)) {
            if (success && task.type == CX_SESSION_TASK_BUNDLE) ++h_bundles_completed;
            h_audit_event(success ? "info" : "warn", task.type == CX_SESSION_TASK_BUNDLE ? "bundle" : "bootstrap",
                success ? "Injection acknowledged" : "Injection failed");
        }
        h_sample_page(page);
        h_task_pending = FALSE;
        if (!h_operation_active()) break;
    }
    h_current_context = 0;
    return TRUE;
}

static BOOL h_browser_matches(const char *json, DWORD length, const WCHAR *expected) {
    JT tokens[64];
    WCHAR *browser;
    DWORD i, j;
    BOOL found = FALSE;
    if (jparse(json, (int)length, tokens, 64) < 1) return FALSE;
    browser = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, 4096 * sizeof(WCHAR));
    if (!browser) return FALSE;
    if (jwstr(json, tokens, jkey(json, tokens, 0, "Browser"), browser, 4096)) {
        if (!expected[0]) found = TRUE;
        for (i = 0; browser[i] && !found; ++i) {
            for (j = 0; expected[j] && browser[i + j] == expected[j]; ++j) { }
            if (!expected[j]) found = TRUE;
        }
    }
    HeapFree(GetProcessHeap(), 0, browser); return found;
}

static BOOL h_targets_refresh(H_NATIVE_PAGE *pages, USHORT port, const CX_OPTIONS *options,
                              const char *trampoline, DWORD trampolineLength, WCHAR *error, DWORD errorCap) {
    char *body = NULL;
    JT *tokens = NULL;
    DWORD length = 0, i, slot;
    int token, count, idToken, urlToken, wsToken;
    BOOL ok = FALSE;
    H_NATIVE_PAGE *entry = (H_NATIVE_PAGE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(H_NATIVE_PAGE));
    if (!h_operation_active()) goto done;
    if (!h_endpoint_owned(port, options, error, errorCap)) {
        for (i = 0; i < HOST_MAX_PAGES; ++i) h_page_close(&pages[i]);
        goto done;
    }
    if (!entry || !net_http_get(port, "/json/list", &body, &length, error, errorCap)) goto done;
    tokens = (JT *)HeapAlloc(GetProcessHeap(), 0, sizeof(JT) * HOST_REPLY_TOKENS);
    if (!tokens) goto done;
    count = jparse(body, (int)length, tokens, HOST_REPLY_TOKENS);
    if (count < 1 || tokens[0].type != '[') goto done;
    for (i = 0; i < HOST_MAX_PAGES; ++i) pages[i].seen = FALSE;
    for (token = 1; token < count; token = tokens[token].next) {
        if (!h_operation_active()) goto done;
        if (tokens[token].type != '{' || !jeq(body, tokens, jkey(body, tokens, token, "type"), "page")) continue;
        idToken = jkey(body, tokens, token, "id"); urlToken = jkey(body, tokens, token, "url"); wsToken = jkey(body, tokens, token, "webSocketDebuggerUrl");
        if (!jstr(body, tokens, idToken, entry->id, sizeof(entry->id))
            || !jstr(body, tokens, urlToken, entry->url, sizeof(entry->url))
            || !jstr(body, tokens, wsToken, entry->websocket, sizeof(entry->websocket))) continue;
        slot = HOST_MAX_PAGES;
        for (i = 0; i < HOST_MAX_PAGES; ++i) if (pages[i].id[0] && lstrcmpA(pages[i].id, entry->id) == 0) { slot = i; break; }
        if (slot == HOST_MAX_PAGES) for (i = 0; i < HOST_MAX_PAGES; ++i) if (!pages[i].id[0]) { slot = i; break; }
        if (slot == HOST_MAX_PAGES) continue;
        if (pages[slot].id[0] && lstrcmpA(pages[slot].websocket, entry->websocket) != 0) h_page_close(&pages[slot]);
        lstrcpynA(pages[slot].id, entry->id, sizeof(entry->id));
        lstrcpynA(pages[slot].url, entry->url, sizeof(entry->url));
        lstrcpynA(pages[slot].websocket, entry->websocket, sizeof(entry->websocket));
        pages[slot].seen = TRUE;
        if (!pages[slot].ws && (!pages[slot].retryAt || (LONG)(GetTickCount() - pages[slot].retryAt) >= 0)) {
            if (!h_page_open(&pages[slot], port, options, trampoline, trampolineLength, error, errorCap)) {
                if (!h_operation_active()) goto done;
                pages[slot].retryAt = GetTickCount() + 1000;
                ++h_report.errors;
                h_audit_event("warn", "session", "CDP connection failed; retry scheduled");
            }
        }
    }
    for (i = 0; i < HOST_MAX_PAGES; ++i) if (pages[i].id[0] && !pages[i].seen) { h_page_close(&pages[i]); h_zero(&pages[i], sizeof(pages[i])); }
    ok = TRUE;
done:
    if (entry) HeapFree(GetProcessHeap(), 0, entry);
    if (tokens) HeapFree(GetProcessHeap(), 0, tokens);
    if (body) net_free(body);
    return ok;
}

static BOOL h_watch_targets(USHORT port, const CX_OPTIONS *options, const char *bootstrap, DWORD bootstrapLength,
                            const char *bundle, DWORD bundleLength, const char *style, DWORD styleLength,
                            const char *trampoline, DWORD trampolineLength, WCHAR *error, DWORD errorCap) {
    H_NATIVE_PAGE *pages;
    char *body = NULL, *wrapped;
    DWORD length, wrappedLength, i, lastPoll = 0, waitStart = GetTickCount();
    BOOL ready = FALSE, ok = FALSE;
    pages = (H_NATIVE_PAGE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(H_NATIVE_PAGE) * HOST_MAX_PAGES);
    wrapped = h_bundle_source(bundle, bundleLength, &wrappedLength);
    if (!pages || !wrapped) { h_error(error, errorCap, L"out of memory allocating native sessions"); goto done; }
    h_report.stopReason = "endpoint-unavailable";
    h_command_timeout = (DWORD)options->bundleTimeoutMs;
    while (h_operation_active() && GetTickCount() - waitStart < (DWORD)options->debugTimeoutMs) {
        if (h_endpoint_owned(port, options, error, errorCap)
            && net_http_get(port, "/json/version", &body, &length, error, errorCap)) {
            ready = h_browser_matches(body, length, options->expectedBrowser);
            net_free(body); body = NULL;
            if (!ready) { h_report.stopReason = "browser-mismatch"; h_error(error, errorCap, L"CDP Browser does not match --expected-browser"); goto done; }
            break;
        }
        Sleep(100);
    }
    if (!ready) { h_error(error, errorCap, L"CXExam CDP endpoint did not become ready before its deadline"); goto done; }
    do {
        DWORD now = GetTickCount();
        h_current_page = NULL; h_task_pending = FALSE;
        if (!lastPoll || now - lastPoll >= (DWORD)options->targetPollIntervalMs) {
            h_targets_refresh(pages, port, options, trampoline, trampolineLength, error, errorCap);
            lastPoll = GetTickCount();
        }
        for (i = 0; i < HOST_MAX_PAGES && h_operation_active(); ++i) if (pages[i].ws) {
            if (!h_page_pump(&pages[i], options, bootstrap, bootstrapLength, wrapped, wrappedLength, style, styleLength, error, errorCap)) {
                if (!h_operation_active()) break;
                ++h_report.errors;
                h_audit_event("warn", "session", "CDP connection closed; retry scheduled");
                h_page_close(&pages[i]); pages[i].retryAt = GetTickCount() + 250;
            }
        }
        h_current_page = NULL; h_task_pending = FALSE;
        Sleep(20);
    } while (h_operation_active());
    ok = !options->extensionEnabled || h_bundles_completed > 0;
    h_report.stopReason = h_duration && GetTickCount() - h_started >= h_duration ? "duration" : "client-exit";
    if (!ok) h_error(error, errorCap, L"native session ended without any completed business injection");
done:
    h_report.contexts = 0;
    if (pages) {
        /* Gauge at stop, before close frees live contexts; execution totals are cumulative. */
        for (i = 0; i < HOST_MAX_PAGES; ++i) if (pages[i].state) h_report.contexts += cx_session_stats(pages[i].state)->contexts;
        for (i = 0; i < HOST_MAX_PAGES; ++i) h_page_close(&pages[i]);
        HeapFree(GetProcessHeap(), 0, pages);
    }
    if (wrapped) HeapFree(GetProcessHeap(), 0, wrapped);
    if (body) net_free(body);
    h_current_page = NULL; h_task_pending = FALSE; h_current_context = 0;
    return ok;
}
