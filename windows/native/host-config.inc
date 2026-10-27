/* Configuration I/O runs between CDP tasks, never from the event callback. */
typedef struct H_CONFIG_STAMP {
    BOOL exists;
    FILETIME modified;
    DWORD sizeHigh, sizeLow;
} H_CONFIG_STAMP;

struct H_CONFIG {
    CX_OPTIONS candidate, layer;
    char current[CX_OPTIONS_JSON_CAP], pending[CX_OPTIONS_JSON_CAP];
    char merged[CX_OPTIONS_JSON_CAP], serialized[CX_OPTIONS_JSON_CAP];
    char chosen[CX_OPTIONS_JSON_CAP], journal[CX_OPTIONS_JSON_CAP];
    char dirty[CX_OPTIONS_JSON_CAP], document[CX_OPTIONS_JSON_CAP + 16];
    WCHAR defaultPath[CX_OPTIONS_PATH_CAP], selectedPath[CX_OPTIONS_PATH_CAP];
    H_CONFIG_STAMP defaultStamp, selectedStamp;
    DWORD currentLength, pendingLength, dirtyLength, writeAt, pollAt;
    BOOL pendingSet, dirtySet, noDiskWrite, logEnabled, enabled, pendingEnabled;
};

static void h_config_stamp(const WCHAR *path, H_CONFIG_STAMP *stamp) {
    WIN32_FILE_ATTRIBUTE_DATA data;
    h_zero(stamp, sizeof(*stamp));
    if (path[0] && GetFileAttributesExW(path, GetFileExInfoStandard, &data)) {
        stamp->exists = TRUE; stamp->modified = data.ftLastWriteTime;
        stamp->sizeHigh = data.nFileSizeHigh; stamp->sizeLow = data.nFileSizeLow;
    }
}
static BOOL h_config_stamp_equal(const H_CONFIG_STAMP *a, const H_CONFIG_STAMP *b) {
    return a->exists == b->exists && a->sizeHigh == b->sizeHigh && a->sizeLow == b->sizeLow
        && a->modified.dwLowDateTime == b->modified.dwLowDateTime
        && a->modified.dwHighDateTime == b->modified.dwHighDateTime;
}
static BOOL h_config_finish_candidate(H_CONFIG *config, char *out, DWORD *length, WCHAR *error, DWORD cap) {
    DWORD serializedLength;
    config->candidate.noDiskWrite = config->noDiskWrite;
    config->candidate.logFileEnabled = config->logEnabled;
    if (!cx_options_finalize(&config->candidate, error, cap)
        || !cx_options_effective_settings_json_utf8(&config->candidate, config->serialized, sizeof(config->serialized), &serializedLength)) return FALSE;
    return cx_config_merge_settings("{}", 2, config->serialized, serializedLength, out, CX_OPTIONS_JSON_CAP, length, error, cap);
}
static BOOL h_config_candidate_from_settings(H_CONFIG *config, const char *settings, DWORD length, WCHAR *error, DWORD cap) {
    DWORD at = 0;
    cx_options_init(&config->candidate);
    if (!h_append_bytes(config->document, sizeof(config->document), &at, "{\"settings\":", 12)
        || !h_append_bytes(config->document, sizeof(config->document), &at, settings, length)
        || !h_append_bytes(config->document, sizeof(config->document), &at, "}", 1)) return FALSE;
    return cx_options_apply_json_utf8(&config->candidate, config->document, (int)at, error, cap)
        && cx_options_merge(&config->candidate, &h_json_options, error, cap)
        && cx_options_merge(&config->candidate, &h_cli_options, error, cap);
}
static const char *h_config_json(DWORD *length) {
    if (!h_config) return NULL;
    if (length) *length = h_config->currentLength;
    return h_config->current;
}
static BOOL h_config_enabled(const CX_OPTIONS *options) {
    return h_config ? h_config->enabled : options->extensionEnabled;
}
static BOOL h_config_begin(const CX_OPTIONS *options, WCHAR *error, DWORD cap) {
    H_CONFIG *config;
    DWORD size, length, at;
    char digits[16];
    config = (H_CONFIG *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*config));
    if (!config) { h_error(error, cap, L"out of memory creating configuration state"); return FALSE; }
    config->noDiskWrite = options->noDiskWrite; config->logEnabled = options->logFileEnabled;
    config->enabled = options->extensionEnabled;
    if (!cx_options_effective_settings_json_utf8(options, config->serialized, sizeof(config->serialized), &size)
        || !cx_config_merge_settings("{}", 2, config->serialized, size, config->current, sizeof(config->current), &config->currentLength, error, cap)) goto failed;
    length = (DWORD)h_wlen(h_exe_path);
    while (length && h_exe_path[length - 1] != L'\\' && h_exe_path[length - 1] != L'/') --length;
    if (length + 19 >= CX_OPTIONS_PATH_CAP) { h_error(error, cap, L"native default configuration path exceeds its limit"); goto failed; }
    CopyMemory(config->defaultPath, h_exe_path, length * sizeof(WCHAR));
    lstrcpyW(config->defaultPath + length, L"chaoxing-plus.json");
    if (!h_copy(config->selectedPath, CX_OPTIONS_PATH_CAP, options->configPathSet ? options->configPath : config->defaultPath)) goto failed;
    h_config_stamp(config->defaultPath, &config->defaultStamp);
    h_config_stamp(config->selectedPath, &config->selectedStamp);
    config->dirty[0] = '{'; config->dirty[1] = '}'; config->dirty[2] = 0; config->dirtyLength = 2;
    /* PID plus monotonic start tick distinguishes each running native host. */
    at = 0; h_append_bytes(h_instance, sizeof(h_instance), &at, "native-", 7);
    size = h_decimal(digits, GetCurrentProcessId()); h_append_bytes(h_instance, sizeof(h_instance), &at, digits, size);
    h_append_bytes(h_instance, sizeof(h_instance), &at, "-", 1);
    size = h_decimal(digits, GetTickCount()); h_append_bytes(h_instance, sizeof(h_instance), &at, digits, size);
    config->pollAt = GetTickCount() + 1500;
    h_config = config; return TRUE;
failed:
    HeapFree(GetProcessHeap(), 0, config); return FALSE;
}
static void h_config_queue(const char *json, DWORD length) {
    H_CONFIG *config = h_config;
    DWORD patchLength, chosenLength, selectedLength, mergedLength;
    WCHAR error[256];
    if (!config) return;
    if (!cx_config_merge_settings("{}", 2, json, length, config->journal, sizeof(config->journal), &patchLength, error, 256)) goto invalid;
    if (patchLength == 2) return;
    if (!cx_config_merge_settings(config->pendingSet ? config->pending : config->current,
            config->pendingSet ? config->pendingLength : config->currentLength,
            config->journal, patchLength, config->merged, sizeof(config->merged), &mergedLength, error, 256)
        || !h_config_candidate_from_settings(config, config->merged, mergedLength, error, 256)
        || !h_config_finish_candidate(config, config->chosen, &chosenLength, error, 256)
        || !cx_config_select_settings(config->chosen, chosenLength, config->journal, patchLength,
            config->merged, sizeof(config->merged), &selectedLength, error, 256)
        || !cx_config_merge_settings(config->dirty, config->dirtyLength, config->merged, selectedLength,
            config->journal, sizeof(config->journal), &mergedLength, error, 256)) goto invalid;
    CopyMemory(config->pending, config->chosen, chosenLength + 1); config->pendingLength = chosenLength;
    config->pendingEnabled = config->candidate.extensionEnabled; config->pendingSet = TRUE;
    if (!config->noDiskWrite) {
        CopyMemory(config->dirty, config->journal, mergedLength + 1); config->dirtyLength = mergedLength;
        config->dirtySet = TRUE; config->writeAt = GetTickCount() + 250;
    }
    return;
invalid:
    h_audit_event("warn", "config", "Invalid page configuration ignored; keeping the last valid settings");
}
static void h_config_publish(H_NATIVE_PAGE *pages, const char *settings, DWORD length, BOOL enabled) {
    DWORD i;
    CopyMemory(h_config->current, settings, length + 1); h_config->currentLength = length;
    h_config->enabled = enabled;
    for (i = 0; i < HOST_MAX_PAGES; ++i) if (pages[i].state) cx_session_update_config(pages[i].state, enabled);
}
static void h_config_flush(void) {
    WCHAR error[256];
    if (!h_config || h_config->noDiskWrite || !h_config->dirtySet) return;
    if (cx_config_patch_file(h_config->selectedPath, h_config->dirty, h_config->dirtyLength, error, 256)) {
        h_config->dirtySet = FALSE;
        h_config->dirty[0] = '{'; h_config->dirty[1] = '}'; h_config->dirty[2] = 0; h_config->dirtyLength = 2;
        h_audit_event("info", "config", "Shared configuration saved");
    } else {
        h_config->writeAt = GetTickCount() + 1500;
        h_audit_event("warn", "config", "Configuration write unavailable; continuing with the in-memory settings");
    }
}
static BOOL h_config_load_candidate(WCHAR *error, DWORD cap) {
    H_CONFIG *config = h_config;
    cx_options_init(&config->candidate); cx_options_init(&config->layer);
    if (!cx_options_load_default(&config->candidate, h_exe_path, error, cap)) return FALSE;
    if (h_cli_options.configPathSet && (!cx_options_load_file(&config->layer, h_cli_options.configPath, error, cap)
        || !cx_options_merge(&config->candidate, &config->layer, error, cap))) return FALSE;
    return cx_options_merge(&config->candidate, &h_json_options, error, cap)
        && cx_options_merge(&config->candidate, &h_cli_options, error, cap);
}
static void h_config_tick(H_NATIVE_PAGE *pages) {
    H_CONFIG_STAMP nextDefault, nextSelected;
    H_CONFIG *config = h_config;
    DWORD now = GetTickCount(), length;
    WCHAR error[256];
    BOOL changed;
    if (!config || !h_operation_active()) return;
    if (config->pendingSet) {
        h_config_publish(pages, config->pending, config->pendingLength, config->pendingEnabled);
        config->pendingSet = FALSE;
        h_audit_event("info", "config", "Shared page settings queued for all live contexts");
    }
    if (config->dirtySet && (LONG)(now - config->writeAt) >= 0) h_config_flush();
    if ((LONG)(now - config->pollAt) < 0) return;
    config->pollAt = now + 1500;
    h_config_stamp(config->defaultPath, &nextDefault); h_config_stamp(config->selectedPath, &nextSelected);
    changed = !h_config_stamp_equal(&nextDefault, &config->defaultStamp) || !h_config_stamp_equal(&nextSelected, &config->selectedStamp);
    if (!changed) return;
    /* Merge a pending page patch into the newest disk document before reloading. */
    if (config->dirtySet) h_config_flush();
    if (config->dirtySet) return;
    config->defaultStamp = nextDefault; config->selectedStamp = nextSelected;
    if (!h_config_load_candidate(error, 256) || !h_config_finish_candidate(config, config->chosen, &length, error, 256)) {
        h_audit_event("warn", "config", "Configuration reload rejected; keeping the last valid settings"); return;
    }
    if (length != config->currentLength || lstrcmpA(config->chosen, config->current) != 0) {
        h_config_publish(pages, config->chosen, length, config->candidate.extensionEnabled);
        h_audit_event("info", "config", "Configuration reloaded; shared settings queued for all live contexts");
    }
}
static BOOL h_config_send(H_NATIVE_PAGE *page, WCHAR *error, DWORD cap) {
    const char prefix[] = "window.__CX_WIN_CONFIG_JSON__=";
    const char suffix[] = ";(function(){if(typeof window.__CX_WIN_ON_CONFIG__!=='function')return false;window.__CX_WIN_ON_CONFIG__({kind:'config',values:window.__CX_WIN_CONFIG_JSON__,replace:true});return true;})()";
    char *expression;
    DWORD at = 0, size;
    BOOL ok;
    if (!h_config) return TRUE;
    size = h_config->currentLength + sizeof(prefix) + sizeof(suffix) + 4;
    expression = (char *)HeapAlloc(GetProcessHeap(), 0, size);
    if (!expression) { h_error(error, cap, L"out of memory broadcasting native settings"); return FALSE; }
    ok = h_append_bytes(expression, size, &at, prefix, sizeof(prefix) - 1)
        && h_append_bytes(expression, size, &at, h_config->current, h_config->currentLength)
        && h_append_bytes(expression, size, &at, suffix, sizeof(suffix) - 1)
        && h_send_eval_checked(page->ws, page->nextId++, expression, at, TRUE, error, cap);
    HeapFree(GetProcessHeap(), 0, expression); return ok;
}
static void h_config_close(void) {
    if (!h_config) return;
    h_config_flush();
    HeapFree(GetProcessHeap(), 0, h_config); h_config = NULL;
}
