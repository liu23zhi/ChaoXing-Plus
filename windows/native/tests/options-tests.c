#include "../options.h"

static CX_OPTIONS baseOptions;
static CX_OPTIONS cliOptions;
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
    reset();
    check(!apply("{\"log\":\"true\"}"), "JSON string boolean is rejected");
}

static void test_shortcuts(void) {
    WCHAR *valid[] = { L"--answer-key", L"Ctrl+Alt+Shift+S" };
    WCHAR *invalid[] = { L"--answer-key", L"Ctrl+A+B" };
    reset();
    check(cx_options_parse_cli(&baseOptions, 2, valid, errorText, 512) && cx_options_finalize(&baseOptions, errorText, 512), "one base key with modifiers is accepted");
    reset();
    check(!cx_options_parse_cli(&baseOptions, 2, invalid, errorText, 512) || !cx_options_finalize(&baseOptions, errorText, 512), "two base keys are rejected");
}

static void test_invalid_inputs(void) {
    WCHAR *unknown[] = { L"--not-implemented-native-flag" };
    WCHAR *memory[] = { L"--execution-mode", L"memory" };
    WCHAR *range[] = { L"--answer-threads", L"5" };
    reset(); check(!apply("{\"panel\":}"), "malformed JSON is rejected");
    check(errorText[0] != 0, "malformed JSON includes a diagnostic");
    reset(); check(!apply("[]"), "non-object JSON root is rejected");
    reset(); check(!apply("{\"notImplementedNativeFlag\":true}"), "unknown top-level JSON field is rejected");
    reset(); check(!apply("{\"executionMode\":\"memory\"}"), "unimplemented JSON execution mode is rejected");
    reset(); check(!cx_options_parse_cli(&baseOptions, 1, unknown, errorText, 512), "unknown CLI flag is rejected");
    reset(); check(!cx_options_parse_cli(&baseOptions, 2, memory, errorText, 512), "unimplemented CLI execution mode is rejected");
    reset(); check(!cx_options_parse_cli(&baseOptions, 2, range, errorText, 512), "out-of-range CLI answer threads are rejected");
    reset(); check(!apply("{\"answerThreads\":5}") || !cx_options_finalize(&baseOptions, errorText, 512), "out-of-range JSON answer threads are rejected");
}

static void test_selection_conflicts(void) {
    WCHAR *arguments[] = { L"--client", L"D:\\Exam\\CXExam.exe", L"--client-first" };
    reset();
    check(!cx_options_parse_cli(&baseOptions, 3, arguments, errorText, 512) || !cx_options_finalize(&baseOptions, errorText, 512), "client path conflicts with client-first");
}

void WINAPI WinMainCRTStartup(void) {
    test_layer_priority(); test_strings_and_no_disk_write(); test_shared_settings(); test_shortcuts();
    test_invalid_inputs(); test_selection_conflicts();
    output(failures ? "RESULT FAIL\r\n" : "RESULT PASS\r\n");
    (void)assertions;
    ExitProcess(failures ? 1 : 0);
}
