/* This action stays outside h_run: no automatic discovery, launch, CDP or output files. */
#define H_CHECK_MAX_ITEMS 16
#define H_CHECK_REPORT_CAP 16384

typedef struct H_CHECK_ITEM {
    const char *id;
    const char *status;
    const char *detail;
    BOOL ok;
} H_CHECK_ITEM;

static H_CHECK_ITEM h_check_items[H_CHECK_MAX_ITEMS];
static char h_check_report[H_CHECK_REPORT_CAP];
static DWORD h_check_count, h_check_at;
static BOOL h_check_valid;

static void h_check_add(const char *id, const char *status, const char *detail) {
    H_CHECK_ITEM *item;
    if (h_check_count >= H_CHECK_MAX_ITEMS) { h_check_valid = FALSE; return; }
    item = &h_check_items[h_check_count++];
    item->id = id; item->status = status; item->detail = detail;
    item->ok = lstrcmpA(status, "passed") == 0 || lstrcmpA(status, "skipped") == 0;
}

static void h_check_text(const char *text) {
    if (h_check_valid && !h_append_bytes(h_check_report, H_CHECK_REPORT_CAP, &h_check_at, text, (DWORD)h_len(text))) h_check_valid = FALSE;
}

static void h_check_string(const char *text) {
    if (h_check_valid && !h_json_quote(h_check_report, H_CHECK_REPORT_CAP, &h_check_at, text, (DWORD)h_len(text))) h_check_valid = FALSE;
}

static void h_check_list(const char *status) {
    DWORD i, count = 0;
    h_check_text("[");
    for (i = 0; i < h_check_count; ++i) if (lstrcmpA(h_check_items[i].status, status) == 0) {
        if (count++) h_check_text(",");
        h_check_string(h_check_items[i].id);
    }
    h_check_text("]");
}

static int h_self_check(const CX_OPTIONS *options) {
    static const char *const assetIds[] = {
        "windows-bootstrap.js", "chaoxing-plus.windows.js", "trampoline.js", "sweetalert2.min.css"
    };
    char *assets[4] = { NULL, NULL, NULL, NULL };
    DWORD lengths[4] = { 0, 0, 0, 0 }, i, required, failures = 0;
    BOOL loaded = TRUE, winsock = FALSE;
    HANDLE token = NULL;
    TOKEN_ELEVATION elevation;
    SYSTEM_INFO system;
    CX_DISCOVERY_RESULT client;
    WCHAR error[HOST_ERROR_CAP];
    WSADATA data;
    USHORT port = 0;
    char portText[16];
    h_check_count = 0; h_check_at = 0; h_check_valid = TRUE;
    h_zero(h_check_report, sizeof(h_check_report)); h_zero(error, sizeof(error));
    cx_discovery_init(&client);
    h_check_add("configuration", "passed", "Startup configuration parsed; values omitted");
    GetNativeSystemInfo(&system);
    h_check_add("architecture", system.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_INTEL
        || system.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_AMD64 ? "passed" : "warning",
        system.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_INTEL ? "x86"
        : system.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_AMD64 ? "x64" : "Unverified Windows architecture");
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)
        && GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &required)) {
        h_check_add("permissions", elevation.TokenIsElevated ? "passed" : "warning",
            elevation.TokenIsElevated ? "elevated" : "standard-user; run as administrator for administrator-required clients");
    } else h_check_add("permissions", "warning", "Unable to determine token elevation");
    if (token) CloseHandle(token);
    h_check_add(cx_asset_resources_embedded() ? "embedded-resources" : "external-resources",
        cx_asset_validate_embedded(error, HOST_ERROR_CAP) ? "passed" : "failed",
        cx_asset_resources_embedded() ? "Embedded resources must be readable and nonempty"
            : "Five external sidecar resources must be readable and nonempty");
    for (i = 0; i < 4; ++i) {
        BOOL ok = cx_asset_load(cx_asset_name(i), options->assetsDirSet ? options->assetsDir : NULL,
            &assets[i], &lengths[i], error, HOST_ERROR_CAP);
        h_check_add(assetIds[i], ok ? "passed" : "failed", options->assetsDirSet ? "Explicit external resource; no embedded fallback"
            : cx_asset_resources_embedded() ? "Embedded resource" : "External sidecar beside the executable");
        if (!ok) loaded = FALSE;
    }
    if (loaded) {
        BOOL ok = h_preflight_assets(options, lengths[0], lengths[1], assets[3], lengths[3], error, HOST_ERROR_CAP)
            && lengths[2] <= HOST_EVAL_SOURCE_CAP / 6
            && lengths[0] + 128 <= HOST_EVAL_SOURCE_CAP && lengths[1] + 128 <= HOST_EVAL_SOURCE_CAP;
        h_check_add("resource-limits", ok ? "passed" : "failed", "Effective resources must fit the ordinary CDP wrappers");
    } else h_check_add("resource-limits", "skipped", "Effective resources are incomplete");
    for (i = 0; i < 4; ++i) if (assets[i]) HeapFree(GetProcessHeap(), 0, assets[i]);
    if (options->clientPathSet) {
        BOOL ok = cx_discovery_resolve_client(options->clientPath,
            system.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_INTEL, &client, error, HOST_ERROR_CAP) && client.count > 0;
        h_check_add("client", ok ? "passed" : "failed", !ok ? "Explicit client is missing, invalid or incompatible"
            : client.items[0].machine == CX_DISCOVERY_MACHINE_X86 ? "x86" : "x64");
    } else h_check_add("client", "warning", "No explicit client; discovery and launch were skipped");
    cx_discovery_free(&client);
    if (options->attachPortSet) h_check_add("port", "skipped", "Attach endpoint was not contacted or bound");
    else {
        winsock = WSAStartup(MAKEWORD(2, 2), &data) == 0;
        h_check_add("port", winsock && h_choose_port(options, &port) ? "passed" : "failed",
            "Loopback bind probe only; port availability can change before launch");
    }
    if (winsock) WSACleanup();
    for (i = 0; i < h_check_count; ++i) if (lstrcmpA(h_check_items[i].status, "failed") == 0) ++failures;
    h_check_text("{\"mode\":\"self-check\",\"host\":\"native\",\"version\":\"6.2.0\",\"success\":");
    h_check_text(failures ? "false" : "true");
    h_check_text(",\"scope\":{\"discoveryScan\":false,\"launch\":false,\"connect\":false,\"write\":false},\"port\":");
    h_decimal(portText, port); h_check_text(portText);
    h_check_text(",\"checks\":[");
    for (i = 0; i < h_check_count; ++i) {
        if (i) h_check_text(",");
        h_check_text("{\"id\":"); h_check_string(h_check_items[i].id);
        h_check_text(",\"ok\":"); h_check_text(h_check_items[i].ok ? "true" : "false");
        h_check_text(",\"status\":"); h_check_string(h_check_items[i].status);
        h_check_text(",\"detail\":"); h_check_string(h_check_items[i].detail); h_check_text("}");
    }
    h_check_text("],\"failures\":"); h_check_list("failed");
    h_check_text(",\"warnings\":"); h_check_list("warning");
    h_check_text(",\"limitations\":[\"Client execution and CEF page compatibility are not tested\","
        "\"No automatic discovery, selection UI, UAC, injection or file output\"]}\n");
    if (!h_check_valid) {
        if (!options->quiet) h_print_utf8("{\"mode\":\"self-check\",\"host\":\"native\",\"success\":false,\"failures\":[\"report-capacity\"]}\n");
        return 2;
    }
    if (!options->quiet) h_print_utf8(h_check_report);
    return failures ? 1 : 0;
}
