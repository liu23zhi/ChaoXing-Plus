#include "../options.h"
#include "../json.h"

static CX_OPTIONS baseOptions;
static CX_OPTIONS cliOptions;
static CX_OPTIONS layerOptions;
static WCHAR errorText[512];
static char settingsJson[CX_OPTIONS_JSON_CAP];
static int failures;
static int assertions;

static int text_length(const char *s) { int n = 0; while (s[n]) n++; return n; }
static BOOL wide_equal(const WCHAR *a, const WCHAR *b) {
    int i = 0;
    while (a[i] && b[i] && a[i] == b[i]) i++;
    return a[i] == 0 && b[i] == 0;
}
static BOOL text_contains(const char *text, const char *needle) {
    int i, k;
    for (i = 0; text[i]; i++) {
        for (k = 0; needle[k] && text[i + k] == needle[k]; k++);
        if (!needle[k]) return TRUE;
    }
    return FALSE;
}
static void output(const char *s) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), s, (DWORD)text_length(s), &written, 0);
}
static int count_occurrences(const char *text, const char *needle) {
    int count = 0, i, j, n, m;
    if (!text || !needle) return 0;
    n = text_length(text); m = text_length(needle);
    if (!m) return 0;
    for (i = 0; i + m <= n; ++i) {
        for (j = 0; j < m; ++j) if (text[i + j] != needle[j]) break;
        if (j == m) ++count;
    }
    return count;
}
static void check(BOOL condition, const char *name) {
    assertions++;
    if (!condition) failures++;
    output(condition ? "PASS " : "FAIL "); output(name); output("\r\n");
}
static void reset(void) {
    cx_options_init(&baseOptions); cx_options_init(&cliOptions); errorText[0] = 0;
}
static BOOL apply(const char *json) {
    return cx_options_apply_json_utf8(&baseOptions, json, text_length(json), errorText, 512);
}

static void test_layer_priority(void) {
    WCHAR *arguments[] = {
        L"--answer-threads", L"4", L"--panel-width", L"600",
        L"--data-dir", L"D:\\Native Test\\CLI data",
        L"--options-json", L"{\"answerThreads\":1,\"panelWidth\":520,\"expectedBrowser\":\"Inline/\"}"
    };
    reset();
    check(apply("{\"answerThreads\":2,\"panelWidth\":460,\"expectedBrowser\":\"Base/\",\"settings\":{\"common.settings.windows-panel-collapsed\":false}}"), "base JSON layer parses");
    check(apply("{\"answerThreads\":3,\"expectedBrowser\":\"Selected/\",\"dataDir\":\"selected-data\"}"), "selected JSON layer parses");
    check(cx_options_parse_cli(&cliOptions, 8, arguments, errorText, 512), "CLI layer parses before inline JSON");
    check(cx_options_apply_pending_json(&baseOptions, &cliOptions, errorText, 512), "inline JSON applies after selected file");
    check(cx_options_merge(&baseOptions, &cliOptions, errorText, 512), "explicit CLI layer merges");
    check(cx_options_finalize(&baseOptions, errorText, 512), "merged options finalize");
    check(baseOptions.answerThreads == 4 && baseOptions.panelWidth == 600, "independent CLI values override later-position inline JSON");
    check(!baseOptions.panelCollapsed, "unoverridden lower-layer setting survives");
    check(wide_equal(baseOptions.expectedBrowser, L"Inline/"), "inline JSON string overrides selected JSON string");
    check(wide_equal(baseOptions.dataDir, L"D:\\Native Test\\CLI data"), "CLI WCHAR string is copied during merge");
    reset();
    {
        WCHAR *versionArgs[] = { L"--version" };
        check(cx_options_parse_cli(&cliOptions, 1, versionArgs, errorText, 512) && cliOptions.version,
              "version flag parses in the CLI layer");
        check(!baseOptions.version, "version flag stays off unless requested");
    }
}

static void test_strings_and_no_disk_write(void) {
    DWORD length = 0;
    WCHAR *arguments[] = {
        L"--no-disk-write", L"--log", L"--diagnose", L"--report", L"C:\\report.json",
        L"--panel-theme", L"pink", L"--answer-key", L"Ctrl+Alt+Shift+S"
    };
    reset();
    check(cx_options_parse_cli(&cliOptions, 9, arguments, errorText, 512), "noDiskWrite CLI combination parses");
    check(cx_options_merge(&baseOptions, &cliOptions, errorText, 512) && cx_options_finalize(&baseOptions, errorText, 512), "noDiskWrite merged configuration finalizes");
    check(baseOptions.noDiskWrite && !baseOptions.logFileEnabled && !baseOptions.diagnose && baseOptions.noDiagnose && !baseOptions.reportPath[0] && baseOptions.noScanCache, "noDiskWrite overrides all disk outputs");
    check(wide_equal(baseOptions.answerKey, L"Ctrl+Alt+Shift+S"), "shortcut string survives merge");
    check(cx_options_effective_settings_json_utf8(&baseOptions, settingsJson, sizeof(settingsJson), &length), "settings serializes without CRT");
    check(length > 0 && text_contains(settingsJson, "\"common.settings.windows-no-disk-write\":true") && text_contains(settingsJson, "\"common.settings.windows-log-enabled\":false"), "settings JSON contains noDiskWrite-derived state");
}

static void test_shared_settings(void) {
    DWORD length = 0;
    reset();
    check(apply("{\"settings\":{\"common.settings.tiku-adapter.key\":\"secret\",\"cx.new.study.answer-source\":{\"mode\":\"cache\"},\"common.apps.question-caches\":[{\"question\":\"q\"}],\"common.settings.extension-enabled\":false}}"), "shared settings JSON parses");
    check(cx_options_finalize(&baseOptions, errorText, 512), "shared settings finalize");
    check(cx_options_effective_settings_json_utf8(&baseOptions, settingsJson, sizeof(settingsJson), &length), "shared settings serialize");
    check(text_contains(settingsJson, "\"common.settings.tiku-adapter.key\":\"secret\""), "tiku adapter setting survives");
    check(text_contains(settingsJson, "\"cx.new.study.answer-source\":{\"mode\":\"cache\"}"), "nested shared setting survives");
    check(text_contains(settingsJson, "\"common.apps.question-caches\":[{\"question\":\"q\"}]"), "question cache setting survives");
    check(text_contains(settingsJson, "\"common.settings.extension-enabled\":false"), "extension enabled setting survives");
    check(count_occurrences(settingsJson, "\"common.settings.extension-enabled\"") == 1,
          "managed extension setting is not duplicated");
    reset();
    check(apply("{\"settings\":{\"common.settings.windows-panel-enabled\":false,\"common.settings.windows-answer-key\":\"Ctrl+Alt+Shift+S\",\"common.settings.windows-panel-width\":520,\"common.settings.tiku-adapter.baseurl\":\"https://example.test\",\"common.settings.unknown-key\":\"keep\"}}"), "managed and unmanaged shared settings parse");
    check(cx_options_finalize(&baseOptions, errorText, 512), "mixed shared settings finalize");
    check(cx_options_effective_settings_json_utf8(&baseOptions, settingsJson, sizeof(settingsJson), &length), "mixed shared settings serialize");
    check(count_occurrences(settingsJson, "\"common.settings.windows-panel-enabled\"") == 1,
          "managed panel setting is written once");
    check(count_occurrences(settingsJson, "\"common.settings.windows-answer-key\"") == 1,
          "managed answer shortcut is written once");
    check(count_occurrences(settingsJson, "\"common.settings.windows-panel-width\"") == 1,
          "managed panel width is written once");
    check(text_contains(settingsJson, "\"common.settings.windows-panel-enabled\":false"), "managed value comes from typed field");
    check(text_contains(settingsJson, "\"common.settings.tiku-adapter.baseurl\":\"https://example.test\""), "unmanaged tiku setting survives filtering");
    check(text_contains(settingsJson, "\"common.settings.unknown-key\":\"keep\""), "unknown unmanaged setting survives filtering");
    reset();
    check(!apply("{\"log\":\"true\"}"), "JSON string boolean is rejected");
}

static void test_diagnostic_switches(void) {
    WCHAR *disable[] = { L"--diagnose", L"--no-diagnose" };
    WCHAR *enable[] = { L"--no-diagnose", L"--diagnose" };
    WCHAR *off[] = { L"--no-diagnose" };
    WCHAR *on[] = { L"--diagnose" };
    reset();
    check(cx_options_parse_cli(&baseOptions, 2, disable, errorText, 512)
        && !baseOptions.diagnose && baseOptions.noDiagnose, "last no-diagnose CLI flag disables diagnostics");
    reset();
    check(cx_options_parse_cli(&baseOptions, 2, enable, errorText, 512)
        && baseOptions.diagnose && !baseOptions.noDiagnose, "last diagnose CLI flag enables diagnostics");
    reset();
    check(apply("{\"diagnose\":true}") && cx_options_parse_cli(&cliOptions, 1, off, errorText, 512)
        && cx_options_merge(&baseOptions, &cliOptions, errorText, 512) && !baseOptions.diagnose
        && baseOptions.noDiagnose, "CLI no-diagnose overrides configured diagnostics");
    reset();
    check(apply("{\"noDiagnose\":true}") && cx_options_parse_cli(&cliOptions, 1, on, errorText, 512)
        && cx_options_merge(&baseOptions, &cliOptions, errorText, 512) && baseOptions.diagnose
        && !baseOptions.noDiagnose, "CLI diagnose overrides configured no-diagnose");
    reset();
    check(apply("{\"diagnose\":true}") && apply("{\"noDiagnose\":true}")
        && !baseOptions.diagnose && baseOptions.noDiagnose, "higher JSON no-diagnose disables diagnostics");
    reset();
    check(apply("{\"noDiagnose\":true}") && apply("{\"diagnose\":true}")
        && baseOptions.diagnose && !baseOptions.noDiagnose, "higher JSON diagnose re-enables diagnostics");
    reset();
    check(apply("{\"diagnose\":true}") && apply("{\"diagnose\":false}")
        && !baseOptions.diagnose && baseOptions.noDiagnose, "JSON diagnose false disables diagnostics");
    reset();
    check(apply("{\"noDiagnose\":true}") && apply("{\"noDiagnose\":false}")
        && baseOptions.diagnose && !baseOptions.noDiagnose, "JSON no-diagnose false enables diagnostics");
}

static void large_settings_layer(char *out, const char *key, char fill, DWORD count, BOOL duplicate) {
    DWORD used;
    lstrcpyA(out, "{\"settings\":{\"common.settings.keep\":17,");
    if (duplicate) lstrcatA(out, "\"common.settings.big\":0,");
    lstrcatA(out, "\""); lstrcatA(out, key); lstrcatA(out, "\":\"");
    used = (DWORD)text_length(out); FillMemory(out + used, count, fill);
    used += count; out[used] = 0; lstrcatA(out, "\"}}");
}
static BOOL shared_large_value(const CX_OPTIONS *options, const char *key, char fill, DWORD count) {
    char *object = (char *)HeapAlloc(GetProcessHeap(), 0, CX_OPTIONS_JSON_CAP);
    JT *tokens = (JT *)HeapAlloc(GetProcessHeap(), 0, sizeof(JT) * 64);
    int value, keep; DWORD i; BOOL ok = FALSE;
    if (!object || !tokens) ExitProcess(3);
    if (options->sharedSettingsLength > CX_OPTIONS_JSON_CAP - 3) goto done;
    object[0] = '{'; CopyMemory(object + 1, options->sharedSettingsJson, options->sharedSettingsLength);
    object[options->sharedSettingsLength + 1] = '}'; object[options->sharedSettingsLength + 2] = 0;
    if (jparse(object, (int)options->sharedSettingsLength + 2, tokens, 64) < 1 || tokens[0].count != 4) goto done;
    value = jkey(object, tokens, 0, key); keep = jkey(object, tokens, 0, "common.settings.keep");
    if (value < 0 || tokens[value].type != 's' || (DWORD)(tokens[value].end - tokens[value].start) != count
        || jint(object, tokens, keep, -1) != 17) goto done;
    for (i = 0; i < count; ++i) if (object[tokens[value].start + i] != fill) goto done;
    ok = TRUE;
done:
    HeapFree(GetProcessHeap(), 0, object); HeapFree(GetProcessHeap(), 0, tokens); return ok;
}
static BOOL bytes_equal(const void *left, const void *right, DWORD length) {
    const BYTE *a = (const BYTE *)left, *b = (const BYTE *)right; DWORD i;
    for (i = 0; i < length; ++i) if (a[i] != b[i]) return FALSE;
    return TRUE;
}
static void test_bounded_shared_merges(void) {
    const DWORD count = 34 * 1024;
    char *json = (char *)HeapAlloc(GetProcessHeap(), 0, CX_OPTIONS_JSON_CAP);
    CX_OPTIONS *before = (CX_OPTIONS *)HeapAlloc(GetProcessHeap(), 0, sizeof(CX_OPTIONS));
    DWORD previous, i; BOOL ok;
    if (!json || !before) ExitProcess(3);
    reset();
    large_settings_layer(json, "common.settings.big", 'a', count, TRUE);
    check(apply(json) && shared_large_value(&baseOptions, "common.settings.big", 'a', count),
        "one JSON layer deduplicates a repeated key before retaining its 34KiB final value");
    reset(); cx_options_init(&layerOptions);
    large_settings_layer(json, "common.settings.big", 'a', count, FALSE);
    check(apply(json), "first 34KiB shared settings layer parses");
    large_settings_layer(json, "\\u0063ommon.settings.big", 'b', count, FALSE);
    check(cx_options_apply_json_utf8(&layerOptions, json, text_length(json), errorText, 512),
        "escaped duplicate 34KiB shared settings layer parses");
    check(cx_options_merge(&baseOptions, &layerOptions, errorText, 512)
        && shared_large_value(&baseOptions, "common.settings.big", 'b', count),
        "separate 34KiB layers keep the last decoded value and other existing keys");
    previous = baseOptions.sharedSettingsLength; ok = TRUE;
    for (i = 0; i < 12 && ok; ++i) ok = cx_options_merge(&baseOptions, &layerOptions, errorText, 512)
        && baseOptions.sharedSettingsLength == previous && shared_large_value(&baseOptions, "common.settings.big", 'b', count);
    check(ok && i == 12, "repeated options merges never append duplicate 34KiB values");
    reset();
    large_settings_layer(json, "common.settings.big", 'a', count, FALSE); apply(json);
    large_settings_layer(json, "common.settings.big", 'b', count, FALSE);
    check(apply(json) && shared_large_value(&baseOptions, "common.settings.big", 'b', count),
        "applying another JSON layer replaces a large shared value without temporary duplication");
    cx_options_init(&layerOptions);
    large_settings_layer(json, "common.settings.different", 'c', count, FALSE);
    ok = cx_options_apply_json_utf8(&layerOptions, json, text_length(json), errorText, 512);
    layerOptions.panelWidthSet = TRUE; layerOptions.panelWidth = 600;
    CopyMemory(before, &baseOptions, sizeof(CX_OPTIONS));
    check(ok && !cx_options_merge(&baseOptions, &layerOptions, errorText, 512)
        && errorText[0] && bytes_equal(before, &baseOptions, sizeof(CX_OPTIONS)),
        "unique large values over the limit reject the entire merge without partial options changes");
    CopyMemory(before, &baseOptions, sizeof(CX_OPTIONS));
    check(!apply(json) && errorText[0] && bytes_equal(before, &baseOptions, sizeof(CX_OPTIONS)),
        "unique large JSON layer overflow leaves previous shared settings untouched");
    HeapFree(GetProcessHeap(), 0, before); HeapFree(GetProcessHeap(), 0, json);
}

static void test_shortcuts(void) {
    WCHAR *valid[] = { L"--answer-key", L"Ctrl+Alt+Shift+S" };
    WCHAR *invalid[] = { L"--answer-key", L"Ctrl+A+B" };
    WCHAR *functionKey[] = { L"--answer-key", NULL };
    WCHAR *functionKeys[] = { L"F1", L"F8", L"F24", L"F01", L"F08", L"F00000008", L"F25" };
    const char *functionJson[] = { "{\"answerKey\":\"F1\"}", "{\"answerKey\":\"F8\"}", "{\"answerKey\":\"F24\"}", "{\"answerKey\":\"F01\"}", "{\"answerKey\":\"F08\"}", "{\"answerKey\":\"F00000008\"}", "{\"answerKey\":\"F25\"}" };
    int i, accepted, validFunctionKeys = 1, rejectedFunctionKeys = 1;
    reset();
    check(cx_options_parse_cli(&baseOptions, 2, valid, errorText, 512) && cx_options_finalize(&baseOptions, errorText, 512), "one base key with modifiers is accepted");
    reset();
    check(!cx_options_parse_cli(&baseOptions, 2, invalid, errorText, 512) || !cx_options_finalize(&baseOptions, errorText, 512), "two base keys are rejected");
    for (i = 0; i < 7; i++) {
        reset(); functionKey[1] = functionKeys[i];
        accepted = cx_options_parse_cli(&baseOptions, 2, functionKey, errorText, 512) && cx_options_finalize(&baseOptions, errorText, 512);
        if (i < 3) validFunctionKeys = validFunctionKeys && accepted;
        else rejectedFunctionKeys = rejectedFunctionKeys && !accepted;
        reset(); accepted = apply(functionJson[i]) && cx_options_finalize(&baseOptions, errorText, 512);
        if (i < 3) validFunctionKeys = validFunctionKeys && accepted;
        else rejectedFunctionKeys = rejectedFunctionKeys && !accepted;
    }
    check(validFunctionKeys, "native F1 through F24 shortcuts remain accepted");
    check(rejectedFunctionKeys, "native function shortcuts reject leading zeroes and out-of-range keys");
}

static void test_invalid_inputs(void) {
    WCHAR *unknown[] = { L"--not-implemented-native-flag" };
    WCHAR *memory[] = { L"--execution-mode", L"memory" };
    WCHAR *range[] = { L"--answer-threads", L"5" };
    reset(); check(!apply("{\"panel\":}"), "malformed JSON is rejected");
    check(errorText[0] != 0, "malformed JSON includes a diagnostic");
    reset(); check(!apply("[]"), "non-object JSON root is rejected");
    reset(); check(!apply("{\"notImplementedNativeFlag\":true}"), "unknown top-level JSON field is rejected");
    reset(); check(!apply("{\"executionMode\":\"delete-suspend\"}"), "JSON delete-suspend execution mode is rejected");
    reset(); check(apply("{\"executionMode\":\"memory\"}")
        && cx_options_finalize(&baseOptions, errorText, 512)
        && baseOptions.executionModeMemory && baseOptions.noDiskWrite,
        "JSON memory execution mode enables host-side zero-disk-write");
    reset(); check(apply("{\"memoryExec\":true}")
        && cx_options_finalize(&baseOptions, errorText, 512)
        && baseOptions.executionModeMemory && baseOptions.noDiskWrite,
        "JSON memoryExec alias enables zero-disk-write");
    reset(); check(!apply("{\"memoryExec\":\"yes\"}"), "JSON memoryExec rejects non-boolean values");
    reset(); check(!apply("{\"settings\":{\"common.settings.windows-execution-mode\":\"memory\"}}"),
        "shared settings cannot switch launch execution mode");
    reset(); check(apply("{\"settings\":{\"common.settings.windows-execution-mode\":\"normal\"}}"),
        "shared settings keep tolerating explicit normal execution mode");
    reset(); check(!cx_options_parse_cli(&baseOptions, 1, unknown, errorText, 512), "unknown CLI flag is rejected");
    reset(); check(cx_options_parse_cli(&baseOptions, 2, memory, errorText, 512)
        && cx_options_finalize(&baseOptions, errorText, 512)
        && baseOptions.executionModeMemory && baseOptions.noDiskWrite,
        "CLI memory execution mode enables host-side zero-disk-write");
    reset(); check(!cx_options_parse_cli(&baseOptions, 2, range, errorText, 512), "out-of-range CLI answer threads are rejected");
    reset(); check(!apply("{\"answerThreads\":5}") || !cx_options_finalize(&baseOptions, errorText, 512), "out-of-range JSON answer threads are rejected");
}

static void test_nested_unsupported_options(void) {
    static const char *rejected[] = {
        "{\"settings\":{\"common.settings.windows-execution-mode\":\"memory\"}}",
        "{\"settings\":{\"common.settings.windows-memory_exec\":true}}",
        "{\"settings\":{\"COMMON.SETTINGS.WINDOWS-delete_suspend\":true}}",
        "{\"settings\":{\"\\u0063ommon.settings.windows-wipe-owned-files-on-start\":false}}",
        "{\"settings\":{\"common.settings.windows-self-destruct-key\":\"F8\"}}",
        "{\"settings\":{\"cx.new.study.nested\":{\"self_Destruct_Delay\":0}}}",
        "{\"settings\":{\"common.settings.nested\":[{\"wipe_retries\":5}]}}",
        "{\"settings\":{\"common.settings.nested\":{\"execution_Mode\":null}}}",
        "{\"settings\":{\"common.settings.windows-no-self-destruct-confirm\":true}}"
    };
    int i;
    for (i = 0; i < (int)(sizeof(rejected) / sizeof(rejected[0])); ++i) {
        reset();
        check(!apply(rejected[i]), "nested unsupported JSON capability is rejected");
        check(errorText[0] != 0, "nested unsupported JSON capability has a diagnostic");
    }
    reset();
    check(apply("{\"executionMode\":\"normal\",\"settings\":{\"common.settings.keep\":17,\"common.settings.windows-execution-mode\":\"normal\",\"common.settings.windows-memory-exec\":false,\"common.settings.windows-delete-suspend\":false,\"common.settings.windows-self-destruct-key\":false}}"),
        "normal mode and disabled optional capabilities preserve shared settings");
    check(cx_options_effective_settings_json_utf8(&baseOptions, settingsJson, sizeof(settingsJson), 0)
        && text_contains(settingsJson, "\"common.settings.keep\":17"),
        "ordinary shared settings still serialize after capability validation");
    reset();
    check(apply("{\"panel\":false}"), "transaction fixture parses before rejected capability");
    check(!apply("{\"panel\":true,\"settings\":{\"common.settings.windows-memory-exec\":true}}")
        && !baseOptions.panelEnabled,
        "rejected nested capability leaves previously merged options unchanged");
}

static void test_selection_conflicts(void) {
    WCHAR *arguments[] = { L"--client", L"D:\\Exam\\CXExam.exe", L"--client-first" };
    reset();
    check(!cx_options_parse_cli(&baseOptions, 3, arguments, errorText, 512) || !cx_options_finalize(&baseOptions, errorText, 512), "client path conflicts with client-first");
}

static void test_scan_aliases(void) {
    WCHAR *disabled[] = { L"--no-scan-all" };
    WCHAR *enabled[] = { L"--scan-all" };
    WCHAR *lastDisabled[] = { L"--scan-mode", L"all", L"--no-scan-all" };
    WCHAR *lastEnabled[] = { L"--no-scan-all", L"--scan-all" };
    reset();
    check(cx_options_parse_cli(&baseOptions, 1, disabled, errorText, 512) && wide_equal(baseOptions.scanMode, L"common") && baseOptions.scanClients, "no-scan-all changes the actual scan mode to common");
    reset();
    check(cx_options_parse_cli(&baseOptions, 1, enabled, errorText, 512) && wide_equal(baseOptions.scanMode, L"fallback-all"), "scan-all selects fallback-all");
    reset();
    check(cx_options_parse_cli(&baseOptions, 3, lastDisabled, errorText, 512) && wide_equal(baseOptions.scanMode, L"common"), "last scan alias wins after scan-mode");
    reset();
    check(cx_options_parse_cli(&baseOptions, 2, lastEnabled, errorText, 512) && wide_equal(baseOptions.scanMode, L"fallback-all"), "last scan-all wins after no-scan-all");
    reset();
    check(apply("{\"scanAll\":false}") && wide_equal(baseOptions.scanMode, L"common") && baseOptions.scanClients, "JSON scanAll false selects common scanning");
    reset();
    check(apply("{\"scanAll\":true,\"scanMode\":\"all\"}") && wide_equal(baseOptions.scanMode, L"all"), "explicit JSON scanMode takes precedence over its alias");
}

static void test_selection_layer_priority(void) {
    WCHAR *first[] = { L"--client-first" };
    WCHAR *index[] = { L"--client-index", L"2" };
    WCHAR *list[] = { L"--list-clients" };
    WCHAR *select[] = { L"--select-client" };
    WCHAR *scan[] = { L"--scan-mode", L"common" };
    WCHAR *rescan[] = { L"--rescan" };
    WCHAR *noCache[] = { L"--no-scan-cache" };
    WCHAR *gui[] = { L"--ui", L"gui" };
    WCHAR *cli[] = { L"--ui", L"cli" };
    WCHAR **arguments[] = { first, index, list, select, scan, rescan, noCache, gui, cli };
    int counts[] = { 1, 2, 1, 1, 2, 1, 1, 2, 2 };
    const char *names[] = { "CLI client-first overrides configured path", "CLI client-index overrides configured path", "CLI list-clients overrides configured path", "CLI select-client overrides configured path", "CLI scan-mode overrides configured path", "CLI rescan overrides configured path", "CLI no-scan-cache overrides configured path", "CLI gui overrides configured path", "CLI cli overrides configured path" };
    WCHAR *direct[] = { L"--client", L"D:\\Explicit\\CXExam.exe", L"--ui", L"gui" };
    WCHAR *conflictScan[] = { L"--client", L"D:\\Exam\\CXExam.exe", L"--scan-mode", L"common" };
    WCHAR *conflictRescan[] = { L"--client", L"D:\\Exam\\CXExam.exe", L"--rescan" };
    WCHAR *conflictCache[] = { L"--client", L"D:\\Exam\\CXExam.exe", L"--no-scan-cache" };
    int i;
    for (i = 0; i < 9; ++i) {
        reset();
        check(apply("{\"clientPath\":\"C:\\\\Configured\\\\CXExam.exe\"}") && cx_options_parse_cli(&cliOptions, counts[i], arguments[i], errorText, 512) && cx_options_merge(&baseOptions, &cliOptions, errorText, 512) && cx_options_finalize(&baseOptions, errorText, 512) && !baseOptions.clientPathSet, names[i]);
    }
    reset();
    check(apply("{\"clientFirst\":true,\"scanMode\":\"all\"}") && cx_options_parse_cli(&cliOptions, 4, direct, errorText, 512) && cx_options_merge(&baseOptions, &cliOptions, errorText, 512) && cx_options_finalize(&baseOptions, errorText, 512) && baseOptions.clientPathSet && wide_equal(baseOptions.clientPath, L"D:\\Explicit\\CXExam.exe") && !baseOptions.scanClients, "CLI direct path overrides lower selection flags and scanning");
    reset();
    check(cx_options_parse_cli(&baseOptions, 4, conflictScan, errorText, 512) && !cx_options_finalize(&baseOptions, errorText, 512), "same CLI layer path and scan mode remain a conflict");
    reset();
    check(cx_options_parse_cli(&baseOptions, 3, conflictRescan, errorText, 512) && !cx_options_finalize(&baseOptions, errorText, 512), "same CLI layer path and rescan remain a conflict");
    reset();
    check(cx_options_parse_cli(&baseOptions, 3, conflictCache, errorText, 512) && !cx_options_finalize(&baseOptions, errorText, 512), "same CLI layer path and no-scan-cache remain a conflict");
    reset();
    check(apply("{\"clientPath\":\"C:\\\\Configured\\\\CXExam.exe\"}") && apply("{\"ui\":\"gui\"}") && cx_options_finalize(&baseOptions, errorText, 512) && !baseOptions.clientPathSet, "higher JSON gui selects instead of using a lower path");
    reset();
    check(apply("{\"clientPath\":\"C:\\\\Configured\\\\CXExam.exe\"}") && apply("{\"ui\":\"gui\"}") && apply("{\"ui\":\"auto\"}") && cx_options_finalize(&baseOptions, errorText, 512) && baseOptions.clientPathSet, "higher JSON auto preserves the original path after gui");
    reset();
    check(apply("{\"ui\":\"gui\",\"clientPath\":\"D:\\\\Same\\\\CXExam.exe\"}") && cx_options_finalize(&baseOptions, errorText, 512) && baseOptions.clientPathSet, "JSON path at the same UI layer wins");
    reset();
    check(apply("{\"ui\":\"gui\"}") && apply("{\"clientPath\":\"D:\\\\Later\\\\CXExam.exe\"}") && cx_options_finalize(&baseOptions, errorText, 512) && baseOptions.clientPathSet, "higher JSON path wins over lower UI");
    reset();
    cx_options_init(&layerOptions);
    check(apply("{\"clientPath\":\"C:\\\\Configured\\\\CXExam.exe\"}") && cx_options_apply_json_utf8(&layerOptions, "{\"ui\":\"cli\"}", 12, errorText, 512) && cx_options_merge(&baseOptions, &layerOptions, errorText, 512) && cx_options_finalize(&baseOptions, errorText, 512) && !baseOptions.clientPathSet, "separately parsed JSON UI layer overrides a lower path");
    reset();
    check(apply("{\"clientPath\":\"\",\"scanMode\":\"common\"}") && cx_options_finalize(&baseOptions, errorText, 512) && !baseOptions.clientPathSet, "empty JSON client path does not conflict with scanning");
    reset();
    check(apply("{\"clientPath\":\"C:\\\\Configured\\\\CXExam.exe\"}") && apply("{\"clientPath\":\"\",\"scanMode\":\"common\"}") && cx_options_finalize(&baseOptions, errorText, 512) && !baseOptions.clientPathSet && !baseOptions.clientPath[0], "higher empty JSON path clears an earlier configured path");
    reset();
    check(apply("{\"clientIndex\":0}") && !cx_options_finalize(&baseOptions, errorText, 512), "zero JSON client index is rejected before launch");
    reset();
    check(apply("{\"clientIndex\":-1}") && !cx_options_finalize(&baseOptions, errorText, 512), "negative JSON client index is rejected before launch");
}

static void test_dpi_options(void) {
    WCHAR *on[] = { L"--dpi-aware" };
    reset();
    check(apply("{\"dpiAwareness\":\"system\"}") && baseOptions.dpiAware && baseOptions.dpiAwareSet,
        "JSON system DPI mode enables the actual launch option");
    check(apply("{\"dpiAwareness\":\"\"}") && !baseOptions.dpiAware, "higher empty DPI mode disables an earlier override");
    check(apply("{\"dpiAwareness\":\"system\",\"dpiAware\":false}") && !baseOptions.dpiAware,
        "explicit boolean DPI alias overrides string alias in one JSON layer");
    check(cx_options_parse_cli(&cliOptions, 1, on, errorText, 512)
        && cx_options_merge(&baseOptions, &cliOptions, errorText, 512) && baseOptions.dpiAware,
        "independent DPI CLI flag wins over configured disabled mode");
    reset();
    check(!apply("{\"dpiAwareness\":47}"), "invalid numeric DPI mode rejected rather than silently ignored");
    reset();
    check(!apply("{\"dpiAwareness\":\"per-monitor\"}"), "unsupported DPI mode rejected");
}

static void test_elevation_options(void) {
    WCHAR *disable[] = { L"--no-elevate" };
    WCHAR *early[] = { L"--elevate-on-start" };
    WCHAR *conflict[] = { L"--elevate-on-start", L"--no-elevate" };
    WCHAR *value[] = { L"--expected-browser", L"--elevated" };
    WCHAR *resume[] = { L"--client-index", L"2", L"--elevated", L"--elevated-client", L"D:\\选定\\CXExam.exe" };
    reset();
    check(cx_options_parse_cli(&cliOptions, 1, disable, errorText, 512)
        && cx_options_merge(&baseOptions, &cliOptions, errorText, 512)
        && baseOptions.noElevate, "no-elevate is an effective CLI policy after merge");
    reset();
    check(cx_options_parse_cli(&cliOptions, 2, value, errorText, 512)
        && !cliOptions.elevated && wide_equal(cliOptions.expectedBrowser, L"--elevated"),
        "marker text inside an option value never marks the host elevated");
    reset();
    check(cx_options_parse_cli(&cliOptions, 5, resume, errorText, 512)
        && cx_options_merge(&baseOptions, &cliOptions, errorText, 512)
        && cx_options_finalize(&baseOptions, errorText, 512)
        && baseOptions.elevated && baseOptions.elevatedClientSet && baseOptions.clientIndex == 2
        && wide_equal(baseOptions.elevatedClientPath, L"D:\\选定\\CXExam.exe"),
        "internal resume preserves original selection flags in a separate CLI field");
    reset();
    check(cx_options_parse_cli(&cliOptions, 1, early, errorText, 512)
        && cx_options_merge(&baseOptions, &cliOptions, errorText, 512)
        && cx_options_finalize(&baseOptions, errorText, 512) && baseOptions.elevateOnStart,
        "elevate-on-start CLI survives layered merging");
    reset();
    check(apply("{\"elevateOnStart\":true}") && baseOptions.elevateOnStart
        && apply("{\"elevateOnStart\":false}") && !baseOptions.elevateOnStart
        && cx_options_finalize(&baseOptions, errorText, 512), "higher JSON can disable early elevation");
    reset();
    check(apply("{\"elevateOnStart\":false}")
        && cx_options_parse_cli(&cliOptions, 1, early, errorText, 512)
        && cx_options_merge(&baseOptions, &cliOptions, errorText, 512)
        && cx_options_finalize(&baseOptions, errorText, 512) && baseOptions.elevateOnStart,
        "CLI early elevation overrides configured false");
    reset();
    check(cx_options_parse_cli(&baseOptions, 2, conflict, errorText, 512)
        && !cx_options_finalize(&baseOptions, errorText, 512), "early elevation conflicts with no-elevate");
    reset();
    check(apply("{\"elevateOnStart\":true}")
        && cx_options_parse_cli(&cliOptions, 1, disable, errorText, 512)
        && cx_options_merge(&baseOptions, &cliOptions, errorText, 512)
        && !cx_options_finalize(&baseOptions, errorText, 512), "configured early elevation conflicts with CLI no-elevate");
    reset();
    check(!apply("{\"elevateOnStart\":\"true\"}"), "early elevation JSON requires a boolean");
}

static void test_launch_ports(void) {
    WCHAR *valid[] = { L"0", L"1024", L"9333", L"65534" };
    WCHAR *invalid[] = { L"1", L"1023", L"65535" };
    const char *validJson[] = { "{\"port\":0}", "{\"port\":1024}", "{\"port\":9333}", "{\"port\":65534}" };
    const char *invalidJson[] = { "{\"port\":1}", "{\"port\":1023}", "{\"port\":65535}" };
    WCHAR *arguments[] = { L"--port", NULL };
    DWORD i; BOOL rejected = TRUE, attached = TRUE;
    for (i = 0; i < 4; ++i) {
        reset(); arguments[1] = valid[i];
        check(cx_options_parse_cli(&baseOptions, 2, arguments, errorText, 512)
            && cx_options_finalize(&baseOptions, errorText, 512), "valid CEF75 launch port CLI finalizes");
        reset(); check(apply(validJson[i]) && cx_options_finalize(&baseOptions, errorText, 512), "valid CEF75 launch port JSON finalizes");
    }
    for (i = 0; i < 3; ++i) {
        reset(); arguments[0] = L"--port"; arguments[1] = invalid[i];
        rejected = rejected && cx_options_parse_cli(&baseOptions, 2, arguments, errorText, 512)
            && !cx_options_finalize(&baseOptions, errorText, 512);
        reset(); rejected = rejected && apply(invalidJson[i]) && !cx_options_finalize(&baseOptions, errorText, 512);
        reset(); arguments[0] = L"--attach";
        attached = attached && cx_options_parse_cli(&baseOptions, 2, arguments, errorText, 512)
            && cx_options_finalize(&baseOptions, errorText, 512);
    }
    check(rejected, "CEF75 launch port range rejects reserved and excluded values");
    check(attached, "attach retains generic TCP port limits");
    reset(); arguments[0] = L"--port"; arguments[1] = L"9333";
    check(apply("{\"port\":1023}") && cx_options_parse_cli(&cliOptions, 2, arguments, errorText, 512)
        && cx_options_merge(&baseOptions, &cliOptions, errorText, 512)
        && cx_options_finalize(&baseOptions, errorText, 512) && baseOptions.port == 9333,
        "CLI valid launch port overrides lower unsupported JSON port");
    reset(); check(apply("{\"port\":65535}") && apply("{\"port\":9333}")
        && cx_options_finalize(&baseOptions, errorText, 512), "higher JSON valid launch port overrides earlier unsupported value");
}

static void test_data_lifecycle(void) {
    WCHAR *retain[] = { L"--no-retain-data" };
    WCHAR *deleteConfig[] = { L"--delete-config", L"--config", L"D:\\Native Test\\lifecycle.json" };
    WCHAR *deleteWithoutConfig[] = { L"--delete-config" };
    WCHAR *deleteWithNoDiskWrite[] = { L"--delete-config", L"--config", L"D:\\Native Test\\lifecycle.json", L"--no-disk-write" };
    reset();
    check(cx_options_parse_cli(&baseOptions, 1, retain, errorText, 512)
        && cx_options_finalize(&baseOptions, errorText, 512) && !baseOptions.retainData,
        "no-retain-data finalizes and disables retention");
    reset();
    check(cx_options_parse_cli(&baseOptions, 3, deleteConfig, errorText, 512)
        && cx_options_finalize(&baseOptions, errorText, 512)
        && baseOptions.deleteConfig && baseOptions.configPathSet,
        "delete-config with explicit config finalizes");
    reset();
    check(cx_options_parse_cli(&baseOptions, 1, deleteWithoutConfig, errorText, 512)
        && !cx_options_finalize(&baseOptions, errorText, 512) && errorText[0],
        "delete-config requires explicit config");
    reset();
    check(cx_options_parse_cli(&baseOptions, 4, deleteWithNoDiskWrite, errorText, 512)
        && !cx_options_finalize(&baseOptions, errorText, 512),
        "delete-config conflicts with no-disk-write");
    reset();
    check(apply("{\"retainData\":false}") && cx_options_finalize(&baseOptions, errorText, 512) && !baseOptions.retainData,
        "JSON retainData=false finalizes");
    reset();
    check(apply("{\"deleteConfig\":true}") && !cx_options_finalize(&baseOptions, errorText, 512),
        "JSON deleteConfig requires explicit CLI config");
    reset();
    check(apply("{\"deleteConfig\":true}") && cx_options_parse_cli(&cliOptions, 3, deleteConfig, errorText, 512)
        && cx_options_merge(&baseOptions, &cliOptions, errorText, 512)
        && cx_options_finalize(&baseOptions, errorText, 512) && baseOptions.deleteConfig,
        "JSON deleteConfig finalizes with explicit CLI config");
}

void WINAPI WinMainCRTStartup(void) {
    test_layer_priority(); test_strings_and_no_disk_write(); test_shared_settings(); test_diagnostic_switches(); test_bounded_shared_merges(); test_shortcuts();
    test_invalid_inputs(); test_nested_unsupported_options(); test_selection_conflicts(); test_scan_aliases(); test_selection_layer_priority();
    test_elevation_options();
    test_dpi_options();
    test_data_lifecycle();
    test_launch_ports();
    output(failures ? "RESULT FAIL\r\n" : "RESULT PASS\r\n");
    (void)assertions;
    ExitProcess(failures ? 1 : 0);
}
