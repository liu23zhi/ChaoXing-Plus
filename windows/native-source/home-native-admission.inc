/* Ordinary parent only. This is the real producer of verified host state. */
static BOOL home_ordinary_same_owner(const HA_NATIVE_OWNER *a, const HA_NATIVE_OWNER *b) {
    return a && b && a->key[0] && b->key[0] && !lstrcmpW(a->base, b->base) && !lstrcmpW(a->key, b->key);
}

static BOOL home_ordinary_config_matches(const HA_NATIVE_OWNER *owner, const CX_HOME_CONFIG *config) {
    WCHAR base[CX_HOME_ADAPTER_URL_CAP];
    return cx_adapter_agreement_base(config->adapterBaseUrl, base, ARRAYSIZE(base))
        && !lstrcmpW(base, owner->base) && !lstrcmpW(config->apiKey, owner->key);
}

static HOME_NATIVE_DECISION home_ordinary_owner_decision(const HA_NATIVE_OWNER *owner) {
    WCHAR bearer[CX_HOME_API_KEY_CAP + 8];
    HA_STATUS status = {0};
    DWORD httpStatus = 0;
    CX_ADAPTER_REPLY reply = {0};
    JT *tokens = NULL;
    int schema, devices, i, matches = 0;
    HOME_NATIVE_DECISION decision = HOME_NATIVE_UNKNOWN;
    if (!owner || !owner->key[0] || !ha_device(owner->device) || !ha_device(owner->logicalDevice)
        || !ha_proof(owner->proof) || !ha_version(owner->version) || !ha_digest(owner->hash)) return decision;
    lstrcpyW(bearer, L"Bearer "); lstrcatW(bearer, owner->key);
    if (!cx_adapter_ordinary_device_probe(owner->base, bearer, owner->device, TRUE, &reply) || reply.status != 200) goto done;
    tokens = (JT *)HeapAlloc(GetProcessHeap(), 0, 8192 * sizeof(JT));
    if (!tokens || !ha_object(&reply, tokens, 8192)) goto done;
    schema = ha_field(reply.body, tokens, "schemaReady");
    devices = ha_field(reply.body, tokens, "devices");
    if (schema < 0 || tokens[schema].type != 'p' || !jeq(reply.body, tokens, schema, "true")
        || devices < 0 || tokens[devices].type != '[') goto done;
    for (i = devices + 1; i < tokens[devices].next; i = tokens[i].next) {
        WCHAR id[37];
        int field = jkey(reply.body, tokens, i, "deviceId");
        if (field < 0) goto done;
        if (jwstr(reply.body, tokens, field, id, ARRAYSIZE(id)) && !lstrcmpW(id, owner->device)) ++matches;
    }
    if (matches != 1) { if (matches == 0) decision = HOME_NATIVE_DENIED; goto done; }
    ha_release(&reply);
    if (!cx_adapter_ordinary_device_probe(owner->base, bearer, owner->device, FALSE, &reply) || reply.status != 200) goto done;
    if (ha_status_subject(owner->base, bearer, owner->proof, owner->logicalDevice, &status, &httpStatus)) {
        decision = !status.pending && !lstrcmpA(status.version, owner->version) && !lstrcmpA(status.hash, owner->hash)
            ? HOME_NATIVE_CURRENT : HOME_NATIVE_DENIED;
    }
done:
    if (reply.status == 401 || reply.status == 403 || httpStatus == 401 || httpStatus == 403)
        decision = HOME_NATIVE_DENIED;
    if (tokens) HeapFree(GetProcessHeap(), 0, tokens);
    ha_release(&reply);
    SecureZeroMemory(bearer, sizeof(bearer));
    return decision;
}

static BOOL home_ordinary_owner_current(const HA_NATIVE_OWNER *owner) {
    return home_ordinary_owner_decision(owner) == HOME_NATIVE_CURRENT;
}

static BOOL home_ordinary_verify_channel(void *context) {
    HOME_NATIVE_SCOPE *scope = (HOME_NATIVE_SCOPE *)context;
    HOME_NATIVE_DECISION decision;
    if (InterlockedCompareExchange(&scope->revoked, 0, 0) || ha_cancelled(scope->home)) return FALSE;
    decision = home_ordinary_owner_decision(&scope->owner);
    if (decision == HOME_NATIVE_DENIED) {
        if (!InterlockedExchange(&scope->revoked, 1)) home_diagnostic_revoke(scope->home);
    }
    return decision == HOME_NATIVE_CURRENT
        && !InterlockedCompareExchange(&scope->revoked, 0, 0) && !ha_cancelled(scope->home);
}

static BOOL home_ordinary_attach_channel(void *context, HANDLE job) {
    return cx_ordinary_channel_attach_job((CX_ORDINARY_CHANNEL *)context, job);
}

static BOOL home_ordinary_candidate(const WCHAR *device, void *context) {
    HOME_STATE *home = (HOME_STATE *)context;
    if (!home || ha_cancelled(home)) return FALSE;
    if (home_open_sessions(home) && lstrcmpW(home->admittedOwner.device, device)) {
        home_copy(home->error, ARRAYSIZE(home->error), L"请先关闭普通会话，再确认新的设备标识。");
        return FALSE;
    }
    return home_agreement_admit_for(home, device, &home->pendingOwner);
}

static BOOL home_ordinary_device_admit(HOME_STATE *home) {
    WCHAR base[CX_HOME_ADAPTER_URL_CAP], path[CX_HOME_EXTENSION_PATH_CAP], id[CX_DEVICE_ID_CAP], error[256];
    const CX_HOME_CONFIG *cfg = &home->pendingConfig;
    if (home->examPage || cfg->examTestPage || cfg->scriptIdentity[0] || cx_script_lease_active()
        || home->options->noDiskWrite || !cfg->apiKey[0] || !cx_adapter_agreement_base(cfg->adapterBaseUrl, base, ARRAYSIZE(base))
        || !home_device_config_path(home, path, ARRAYSIZE(path))) {
        home_copy(home->error, ARRAYSIZE(home->error), L"普通会话需要可写配置、HTTPS 题库地址、普通账号凭据及当前协议。");
        return FALSE;
    }
    if (lstrcmpW(cfg->adapterBaseUrl, home->config->adapterBaseUrl)
        || lstrcmpW(cfg->apiKey, home->config->apiKey)
        || (home->admittedOwner.key[0] && !home_ordinary_config_matches(&home->admittedOwner, cfg))) {
        home_copy(home->error, ARRAYSIZE(home->error), L"请先关闭会话并在 Windows 宿主账号或设置中切换账号或题库地址。");
        return FALSE;
    }
    error[0] = id[0] = 0;
    if (home->admittedOwner.key[0]) home_copy(id, ARRAYSIZE(id), home->admittedOwner.device);
    else (void)cx_device_host_confirmed(path, base, cfg->apiKey, id, ARRAYSIZE(id));
    if (id[0]) {
        /* A recorded device may have been revoked. Revalidate rather than POST
           on startup/launch: reopening the EXE must not restore a removed slot. */
        if (!home_agreement_admit_for(home, id, &home->pendingOwner)
            || !home_ordinary_owner_current(&home->pendingOwner)) {
            if (!home->error[0]) home_copy(home->error, ARRAYSIZE(home->error), L"当前设备没有有效绑定或授权。");
            SecureZeroMemory(&home->pendingOwner, sizeof(home->pendingOwner));
            return FALSE;
        }
        home->pendingAdmitted = TRUE;
        return TRUE;
    }
    if (home->operation == HOME_ORDINARY_ADMIT) {
        home_copy(home->error, ARRAYSIZE(home->error), L"首次使用请点击新会话，在 Windows 宿主确认并登记普通设备。");
        return FALSE;
    }
    if (!cx_device_host_admit(path, base, cfg->apiKey, CX_DEVICE_HOST_ORDINARY, FALSE, 8000,
        home_ordinary_candidate, home, id, ARRAYSIZE(id), error, ARRAYSIZE(error))
        || lstrcmpW(id, home->pendingOwner.device) || ha_cancelled(home)) {
        if (!home->error[0]) home_copy(home->error, ARRAYSIZE(home->error),
            error[0] ? error : L"普通设备登记未确认，未启动浏览器。");
        SecureZeroMemory(&home->pendingOwner, sizeof(home->pendingOwner));
        return FALSE;
    }
    home->pendingAdmitted = TRUE;
    return TRUE;
}
