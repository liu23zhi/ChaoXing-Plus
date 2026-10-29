/* Private adapter: the session model schedules tasks; only this layer performs I/O. */
static DWORD h_io_budget(DWORD maximum) {
    if (h_duration) {
        DWORD elapsed = GetTickCount() - h_started;
        DWORD remaining = elapsed < h_duration ? h_duration - elapsed : 0;
        if (remaining < maximum) maximum = remaining;
    }
    return maximum;
}

static BOOL h_ui_panel_enabled(const CX_OPTIONS *options) {
    DWORD length;
    const char *json = h_config_json(&length);
    int key;
    if (!json) return options->panelEnabled;
    if (jparse(json, (int)length, h_ui_tokens, HOST_REPLY_TOKENS) < 1) return FALSE;
    key = jkey(json, h_ui_tokens, 0, "common.settings.windows-panel-enabled");
    return key < 0 ? options->panelEnabled : (h_ui_tokens[key].type != '"' && jeq(json, h_ui_tokens, key, "true"));
}

static BOOL h_ui_text(DWORD *at, const char *text) {
    return h_append_bytes(h_ui_expression, HOST_UI_EXPRESSION_CAP, at, text, (DWORD)h_len(text));
}

/* This runs only between session tasks. Event callbacks only change memory. */
static void h_ui_send(H_NATIVE_PAGE *page, const CX_OPTIONS *options) {
    WCHAR error[256];
    DWORD at = 0, i, sequence, epoch, timeout;
    char number[16];
    BOOL ok = FALSE;
    if (!h_ui_active || !page->uiReady || !page->state || !page->ws) return;
    if (!h_ui_panel_enabled(options)) { page->uiDelivered = 0; return; }
    if (!cx_session_can_sync_config(page->state, page->uiContext)) { h_ui_reset_document(page); return; }
    if (page->uiDelivered == h_ui_sequence || (page->uiRetryAt && (LONG)(GetTickCount() - page->uiRetryAt) < 0)) return;
    sequence = h_ui_sequence; epoch = page->uiEpoch;
    if (!h_ui_text(&at, "(function(){if(window.self!==window.top)return false;var h=window.__CX_WIN_HOST__;if(!h||h.instance!==")) goto done;
    if (!h_json_quote(h_ui_expression, HOST_UI_EXPRESSION_CAP, &at, h_instance, (DWORD)h_len(h_instance))) goto done;
    if (!h_ui_text(&at, "||typeof h.setDiagnostics!=='function')return false;return h.setDiagnostics({source:'chaoxing-plus-windows-host',instance:")) goto done;
    if (!h_json_quote(h_ui_expression, HOST_UI_EXPRESSION_CAP, &at, h_instance, (DWORD)h_len(h_instance))) goto done;
    if (!h_ui_text(&at, ",entries:[")) goto done;
    for (i = 0; i < h_ui_count; ++i) {
        const H_UI_ENTRY *entry = &h_ui_entries[(h_ui_head + i) % HOST_UI_HISTORY_CAP];
        if (i && !h_ui_text(&at, ",")) goto done;
        h_decimal(number, entry->sequence);
        if (!h_ui_text(&at, "{sequence:") || !h_ui_text(&at, number)) goto done;
        h_decimal(number, entry->elapsed);
        if (!h_ui_text(&at, ",elapsedMs:") || !h_ui_text(&at, number)
            || !h_ui_text(&at, ",level:'") || !h_ui_text(&at, entry->level)
            || !h_ui_text(&at, "',code:'") || !h_ui_text(&at, entry->code) || !h_ui_text(&at, "'}")) goto done;
    }
    if (!h_ui_text(&at, "]})===true;})()")) goto done;
    timeout = h_command_timeout;
    if (h_command_timeout > 1000) h_command_timeout = 1000;
    h_current_context = page->uiContext; h_ui_epoch = epoch; h_ui_sending = TRUE;
    ok = h_send_eval_checked(page->ws, page->nextId++, h_ui_expression, at, TRUE, error, 256);
    h_ui_sending = FALSE; h_current_context = 0; h_command_timeout = timeout;
    if (ok && page->uiReady && page->uiEpoch == epoch
        && cx_session_can_sync_config(page->state, page->uiContext)) page->uiDelivered = sequence;
done:
    page->uiRetryAt = GetTickCount() + (ok ? 250 : 2000);
}

static BOOL h_http_get(USHORT port, const char *path, DWORD maximum,
                       char **body, DWORD *length, WCHAR *error, DWORD errorCap) {
    DWORD budget = h_io_budget(maximum < 5000 ? maximum : 5000);
    BOOL ok;
    if (!budget || !h_operation_active()) {
        h_error(error, errorCap, L"HTTP operation cancelled at its deadline"); return FALSE;
    }
    ok = net_http_get_timeout(port, path, body, length, budget, error, errorCap);
    if (!h_operation_active()) {
        net_free(*body); *body = NULL; *length = 0;
        h_error(error, errorCap, L"HTTP operation cancelled at its deadline"); return FALSE;
    }
    return ok;
}

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
    h_ui_reset_document(page);
    h_sample_page(page);
    if (page->state) cx_session_free(page->state);
    if (page->ws) net_ws_close(page->ws);
    page->state = NULL; page->ws = NULL;
    h_zero(&page->reported, sizeof(page->reported));
    if (h_current_page == page) { h_current_page = NULL; h_task_pending = FALSE; h_current_context = 0; }
}

static BOOL h_endpoint_owned_reason(USHORT port, const CX_OPTIONS *options,
                                    CX_PORT_OWNER_REASON *reason, WCHAR *error, DWORD errorCap) {
    DWORD owner = 0;
    if (reason) *reason = CX_PORT_OWNER_QUERY_FAILED;
    if (options->attachPortSet) return TRUE;
    if (!h_client_pid) { h_error(error, errorCap, L"CDP endpoint has no owned client process"); return FALSE; }
    if (!proc_port_owner_ex(port, h_client_pid, &owner, reason, error, errorCap)) return FALSE;
    if (!owner) { h_error(error, errorCap, L"CDP listener ownership could not be verified"); return FALSE; }
    h_report.ownershipVerified = TRUE;
    return TRUE;
}

static BOOL h_endpoint_owned(USHORT port, const CX_OPTIONS *options, WCHAR *error, DWORD errorCap) {
    return h_endpoint_owned_reason(port, options, NULL, error, errorCap);
}

static BOOL h_page_open(H_NATIVE_PAGE *page, USHORT port, const CX_OPTIONS *options,
                        const char *trampoline, DWORD trampolineLength, WCHAR *error, DWORD errorCap) {
    char *reply = NULL, *params = NULL;
    DWORD length = 0, at = 0, size = trampolineLength * 6 + 64;
    BOOL ok = FALSE;
    if (!h_operation_active()) return FALSE;
    if (!h_endpoint_owned(port, options, error, errorCap)) { h_page_close(page); return FALSE; }
    page->ws = net_ws_open_timeout(port, page->websocket, h_io_budget(5000), error, errorCap);
    if (!page->ws) return FALSE;
    if (!h_operation_active()) { h_error(error, errorCap, L"WebSocket operation cancelled at its deadline"); goto done; }
    page->state = cx_session_create(page->url, options->injectBlankFrames, h_config_enabled(options));
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
        } else if (task.type == CX_SESSION_TASK_CONFIG) {
            success = h_config_send(page, error, errorCap);
        } else {
            success = h_inject_asset(page->ws, &page->nextId, options->injectStrategy, (DWORD)options->injectRetries, bundle, bundleLength, error, errorCap);
        }
        /* A normal stop can cancel a valid in-flight task without failing it. */
        if ((success || h_operation_active()) && cx_session_complete(page->state, &task, success)) {
            if (success && task.top && task.type == CX_SESSION_TASK_BOOTSTRAP) {
                page->uiReady = TRUE; page->uiContext = task.contextId;
                ++page->uiEpoch; page->uiDelivered = 0; page->uiRetryAt = 0;
            }
            if (success && task.type == CX_SESSION_TASK_BUNDLE) {
                ++h_bundles_completed;
                if (task.top) h_collect_page_diagnostics(page);
            }
            h_audit_event(success ? "info" : "warn", task.type == CX_SESSION_TASK_CONFIG ? "config" : (task.type == CX_SESSION_TASK_BUNDLE ? "bundle" : "bootstrap"),
                task.type == CX_SESSION_TASK_CONFIG ? (success ? "Configuration acknowledged" : "Configuration delivery failed") : (success ? "Injection acknowledged" : "Injection failed"));
        }
        h_sample_page(page);
        h_task_pending = FALSE;
        if (!h_operation_active()) break;
    }
    h_current_context = 0;
    if (h_operation_active()) h_ui_send(page, options);
    return TRUE;
}

static CX_ENDPOINT_REASON h_version_reason(const char *json, DWORD length, const WCHAR *expected) {
    JT tokens[64];
    WCHAR *browser;
    DWORD i, j;
    BOOL found = FALSE;
    if (jparse(json, (int)length, tokens, 64) < 1 || tokens[0].type != '{') return CX_ENDPOINT_INVALID_VERSION;
    browser = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, 4096 * sizeof(WCHAR));
    if (!browser) return CX_ENDPOINT_INVALID_VERSION;
    if (!jwstr(json, tokens, jkey(json, tokens, 0, "Browser"), browser, 4096) || !browser[0]) {
        HeapFree(GetProcessHeap(), 0, browser); return CX_ENDPOINT_INVALID_VERSION;
    }
    if (!expected[0]) found = TRUE;
    for (i = 0; browser[i] && !found; ++i) {
        for (j = 0; expected[j] && browser[i + j] == expected[j]; ++j) { }
        if (!expected[j]) found = TRUE;
    }
    HeapFree(GetProcessHeap(), 0, browser);
    return found ? CX_ENDPOINT_READY : CX_ENDPOINT_BROWSER_MISMATCH;
}

static void h_probe_record(CX_ENDPOINT_REASON reason) {
    CX_ENDPOINT_PROBE *probe = &h_report.endpointProbe;
    if (reason <= CX_ENDPOINT_NOT_STARTED || reason >= CX_ENDPOINT_REASON_COUNT) return;
    probe->lastReason = reason;
    if (probe->attempts < MAXDWORD) ++probe->attempts;
    if (probe->reasonCounts[reason] < MAXDWORD) ++probe->reasonCounts[reason];
}

static CX_ENDPOINT_REASON h_owner_probe_reason(CX_PORT_OWNER_REASON reason) {
    switch (reason) {
        case CX_PORT_OWNER_NO_LISTENER: return CX_ENDPOINT_NO_LISTENER;
        case CX_PORT_OWNER_NOT_OWNED: return CX_ENDPOINT_LISTENER_NOT_OWNED;
        case CX_PORT_OWNER_BINDING_REJECTED: return CX_ENDPOINT_LISTENER_BINDING_REJECTED;
        default: return CX_ENDPOINT_LISTENER_QUERY_FAILED;
    }
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
    if (!entry || !h_http_get(port, "/json/list", 5000, &body, &length, error, errorCap)) goto done;
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
    h_zero(&h_report.endpointProbe, sizeof(h_report.endpointProbe));
    pages = (H_NATIVE_PAGE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(H_NATIVE_PAGE) * HOST_MAX_PAGES);
    wrapped = h_bundle_source(bundle, bundleLength, &wrappedLength);
    if (!pages || !wrapped) { h_error(error, errorCap, L"out of memory allocating native sessions"); goto done; }
    h_report.stopReason = "endpoint-unavailable";
    h_ui_record("info", "endpoint-waiting");
    h_command_timeout = (DWORD)options->bundleTimeoutMs;
    while (h_operation_active() && GetTickCount() - waitStart < (DWORD)options->debugTimeoutMs) {
        DWORD elapsed, remaining;
        CX_PORT_OWNER_REASON ownerReason;
        if (h_endpoint_owned_reason(port, options, &ownerReason, error, errorCap)) {
            if (!options->attachPortSet) {
                h_report.endpointProbe.listenerSeen = TRUE;
                h_report.endpointProbe.ownershipVerified = TRUE;
            }
            elapsed = GetTickCount() - waitStart;
            if (elapsed >= (DWORD)options->debugTimeoutMs) { h_probe_record(CX_ENDPOINT_HTTP_FAILED); break; }
            remaining = (DWORD)options->debugTimeoutMs - elapsed;
            if (h_http_get(port, "/json/version", remaining, &body, &length, error, errorCap)) {
                if (GetTickCount() - waitStart >= (DWORD)options->debugTimeoutMs) {
                    net_free(body); body = NULL; h_probe_record(CX_ENDPOINT_HTTP_FAILED); break;
                }
                h_report.endpointProbe.listenerSeen = TRUE;
                h_report.endpointProbe.versionResponseReceived = TRUE;
                {
                    CX_ENDPOINT_REASON versionReason = h_version_reason(body, length, options->expectedBrowser);
                    ready = versionReason == CX_ENDPOINT_READY;
                    net_free(body); body = NULL;
                    if (!h_operation_active() || GetTickCount() - waitStart >= (DWORD)options->debugTimeoutMs) {
                        ready = FALSE; h_probe_record(CX_ENDPOINT_HTTP_FAILED); break;
                    }
                    h_probe_record(versionReason);
                    if (versionReason == CX_ENDPOINT_READY) h_ui_record("info", "endpoint-ready");
                }
                if (!ready) { h_report.stopReason = "browser-mismatch"; h_error(error, errorCap, L"CDP Browser does not match --expected-browser"); goto done; }
                /* The CDP endpoint is ready and the owned client window now exists. */
                if (!options->attachPortSet) h_capture_window_diagnostics();
                break;
            } else h_probe_record(CX_ENDPOINT_HTTP_FAILED);
        } else {
            if (ownerReason == CX_PORT_OWNER_NOT_OWNED || ownerReason == CX_PORT_OWNER_BINDING_REJECTED)
                h_report.endpointProbe.listenerSeen = TRUE;
            h_probe_record(h_owner_probe_reason(ownerReason));
        }
        elapsed = GetTickCount() - waitStart;
        if (!h_operation_active() || elapsed >= (DWORD)options->debugTimeoutMs) break;
        remaining = h_io_budget((DWORD)options->debugTimeoutMs - elapsed);
        if (remaining) Sleep(remaining < 100 ? remaining : 100);
    }
    h_report.endpointProbe.elapsedMs = GetTickCount() - waitStart;
    if (!ready) {
        if (h_client_pid && !proc_alive(h_client_pid)) {
            h_report.stopReason = "client-exit-before-endpoint";
            h_error(error, errorCap, L"Owned client exited before the CDP endpoint became ready");
        } else if (h_duration && GetTickCount() - h_started >= h_duration) {
            h_report.stopReason = "duration-before-endpoint";
            h_error(error, errorCap, L"Run duration elapsed before the CDP endpoint became ready");
        } else {
            h_report.stopReason = "endpoint-unavailable";
            h_error(error, errorCap, L"CXExam CDP endpoint did not become ready before its deadline");
        }
        goto done;
    }
    do {
        DWORD now = GetTickCount();
        h_current_page = NULL; h_task_pending = FALSE;
        h_config_tick(pages);
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
        h_silent_tick();
        Sleep(20);
    } while (h_operation_active());
    ok = !h_config_enabled(options) || h_bundles_completed > 0;
    h_report.stopReason = h_duration && GetTickCount() - h_started >= h_duration ? "duration" : "client-exit";
    if (!ok) h_error(error, errorCap, L"native session ended without any completed business injection");
done:
    if (!ready && h_report.endpointProbe.attempts) {
        h_report.endpointProbe.elapsedMs = GetTickCount() - waitStart;
        h_audit_event("warn", "endpoint-probe", cx_endpoint_reason_name(h_report.endpointProbe.lastReason));
    }
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

