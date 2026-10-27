#include "../diagnostics.h"

static DWORD failures;
static WCHAR testRoot[32768], blockedPath[32768];
static WCHAR errorText[512];

static void output(const char *text) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &written, NULL);
}

static void check(const char *name, BOOL ok) {
    output(ok ? "PASS " : "FAIL "); output(name); output("\n");
    if (!ok) ++failures;
}

static BOOL exists(const WCHAR *path) {
    return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
}

static void path(WCHAR *out, const WCHAR *suffix) {
    lstrcpyW(out, testRoot); lstrcatW(out, L"\\"); lstrcatW(out, suffix);
}

static BOOL write_file(const WCHAR *name, const char *text, DWORD length) {
    HANDLE file = CreateFileW(name, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);
    DWORD written; BOOL ok;
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    ok = WriteFile(file, text, length, &written, NULL) && written == length;
    CloseHandle(file); return ok;
}

static BOOL read_equals(const WCHAR *name, const char *expected) {
    HANDLE file = CreateFileW(name, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    DWORD size, read, expectedLength, i; char *text; BOOL ok;
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    size = GetFileSize(file, NULL);
    text = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size + 1);
    expectedLength = (DWORD)lstrlenA(expected);
    ok = text && size < 65536 && ReadFile(file, text, size, &read, NULL) && read == size
        && size == expectedLength + 1 && text[size - 1] == '\n';
    if (ok) {
        for (i = 0; i < expectedLength; ++i) {
            if (text[i] != expected[i]) { ok = FALSE; break; }
        }
    }
    if (text) HeapFree(GetProcessHeap(), 0, text);
    CloseHandle(file); return ok;
}

static void init_options(CX_OPTIONS *options, const WCHAR *suffix) {
    cx_options_init(options);
    options->diagnose = TRUE;
    path(options->diagnosticsDir, suffix);
}

static const char validJson[] =
    "{\"version\":\"6.2.0\",\"host\":\"native\",\"source\":\"native-page\","
    "\"collectedAt\":\"2026-10-28T12:34:56.789Z\",\"bundleLoaded\":true,"
    "\"devicePixelRatio\":1.25,\"innerWidth\":1280,\"innerHeight\":720,"
    "\"visualViewport\":{\"width\":1280,\"height\":720,\"scale\":1},"
    "\"panelCount\":0,\"topPanel\":null,"
    "\"scope\":{\"pageOnly\":true,\"windowDpi\":false,\"screenshots\":false}}";

static const char validPanelJson[] =
    "{\"version\":\"6.2.0\",\"host\":\"native\",\"source\":\"native-page\","
    "\"collectedAt\":\"2026-10-28T12:34:56.789Z\",\"bundleLoaded\":true,"
    "\"devicePixelRatio\":1,\"innerWidth\":1280,\"innerHeight\":720,"
    "\"visualViewport\":{\"width\":1280,\"height\":720,\"scale\":1},"
    "\"panelCount\":1,\"topPanel\":{\"visible\":true,"
    "\"rect\":{\"x\":10.5,\"y\":12,\"width\":460,\"height\":100},"
    "\"fractionalDevicePixel\":{\"x\":10.5,\"y\":12,\"width\":460,\"height\":100},"
    "\"style\":{\"backdropFilter\":\"none\",\"boxShadow\":\"rgba(0, 0, 0, 0.2) 0px 4px 12px\",\"transform\":\"none\",\"backgroundColor\":\"rgb(255, 255, 255)\"}},"
    "\"scope\":{\"pageOnly\":true,\"windowDpi\":false,\"screenshots\":false}}";

static void test_disabled(void) {
    CX_OPTIONS options;
    CX_DIAGNOSTICS *state;
    init_options(&options, L"disabled"); options.noDiskWrite = TRUE;
    state = cx_diagnostics_create(&options, errorText, 512);
    check("noDiskWrite disables diagnostics without creating a directory", state && !cx_diagnostics_enabled(state) && !exists(options.diagnosticsDir));
    check("disabled diagnostics accepts no-op writes", state && cx_diagnostics_write_page_json(state, validJson, sizeof(validJson) - 1, errorText, 512));
    cx_diagnostics_close(state);

    init_options(&options, L"not-enabled"); options.diagnose = FALSE;
    state = cx_diagnostics_create(&options, errorText, 512);
    check("diagnose=false disables diagnostics without creating a directory", state && !cx_diagnostics_enabled(state) && !exists(options.diagnosticsDir));
    cx_diagnostics_close(state);
}

static void test_success(void) {
    CX_OPTIONS options; CX_DIAGNOSTICS *state; const WCHAR *outputPath;
    init_options(&options, L"success");
    state = cx_diagnostics_create(&options, errorText, 512);
    outputPath = state ? cx_diagnostics_output_path(state) : L"";
    check("create diagnostics run directory", state && cx_diagnostics_enabled(state) && errorText[0] == 0);
    check("write bounded page diagnostics JSON", state && cx_diagnostics_write_page_json(state, validJson, sizeof(validJson) - 1, errorText, 512));
    check("published diagnostics file is readable", outputPath && exists(outputPath) && read_equals(outputPath, validJson));
    cx_diagnostics_close(state);
    check("published diagnostics file survives state cleanup", outputPath && exists(outputPath));

    init_options(&options, L"panel"); errorText[0] = 0;
    state = cx_diagnostics_create(&options, errorText, 512);
    outputPath = state ? cx_diagnostics_output_path(state) : L"";
    check("write panel geometry diagnostics JSON", state && cx_diagnostics_write_page_json(state, validPanelJson, sizeof(validPanelJson) - 1, errorText, 512));
    check("published panel diagnostics file is readable", outputPath && exists(outputPath) && read_equals(outputPath, validPanelJson));
    cx_diagnostics_close(state);
}

static void test_schema_rejection(void) {
    CX_OPTIONS options; CX_DIAGNOSTICS *state;
    const char extra[] = "{\"version\":\"6.2.0\",\"host\":\"native\",\"source\":\"native-page\",\"collectedAt\":\"2026-10-28T12:34:56.789Z\",\"bundleLoaded\":true,\"devicePixelRatio\":1,\"innerWidth\":1,\"innerHeight\":1,\"visualViewport\":{\"width\":1,\"height\":1,\"scale\":1},\"panelCount\":0,\"topPanel\":null,\"scope\":{\"pageOnly\":true,\"windowDpi\":false,\"screenshots\":false},\"secret\":\"question-answer\"}";
    const char url[] = "{\"version\":\"6.2.0\",\"host\":\"native\",\"source\":\"native-page\",\"collectedAt\":\"2026-10-28T12:34:56.789Z\",\"bundleLoaded\":true,\"devicePixelRatio\":1,\"innerWidth\":1,\"innerHeight\":1,\"visualViewport\":{\"width\":1,\"height\":1,\"scale\":1},\"panelCount\":1,\"topPanel\":{\"visible\":true,\"rect\":{\"x\":0,\"y\":0,\"width\":1,\"height\":1},\"fractionalDevicePixel\":{\"x\":0,\"y\":0,\"width\":1,\"height\":1},\"style\":{\"backdropFilter\":\"url(http://private)\",\"boxShadow\":\"none\",\"transform\":\"none\",\"backgroundColor\":\"white\"}},\"scope\":{\"pageOnly\":true,\"windowDpi\":false,\"screenshots\":false}}";
    init_options(&options, L"schema");
    state = cx_diagnostics_create(&options, errorText, 512);
    check("reject extra diagnostic fields", state && !cx_diagnostics_write_page_json(state, extra, sizeof(extra) - 1, errorText, 512) && errorText[0]);
    cx_diagnostics_close(state);
    init_options(&options, L"url"); errorText[0] = 0;
    state = cx_diagnostics_create(&options, errorText, 512);
    check("reject URL-bearing style values", state && !cx_diagnostics_write_page_json(state, url, sizeof(url) - 1, errorText, 512) && errorText[0]);
    cx_diagnostics_close(state);
}

static void test_input_limits(void) {
    CX_OPTIONS options; CX_DIAGNOSTICS *state; char *large;
    const char invalidUtf8[] = "{\"version\":\"6.2.0\",\xC0\xAF}";
    init_options(&options, L"limits"); state = cx_diagnostics_create(&options, errorText, 512);
    check("reject invalid UTF-8 before publishing", state && !cx_diagnostics_write_page_json(state, invalidUtf8, sizeof(invalidUtf8) - 1, errorText, 512) && errorText[0]);
    cx_diagnostics_close(state);
    init_options(&options, L"oversized"); state = cx_diagnostics_create(&options, errorText, 512);
    large = (char *)HeapAlloc(GetProcessHeap(), 0, 65537);
    if (!large) ExitProcess(3);
    FillMemory(large, 65536, 'x'); large[65536] = 0;
    check("reject oversized diagnostics payload", state && !cx_diagnostics_write_page_json(state, large, 65536, errorText, 512) && errorText[0]);
    HeapFree(GetProcessHeap(), 0, large); cx_diagnostics_close(state);
}

static void test_path_failure(void) {
    CX_OPTIONS options; CX_DIAGNOSTICS *state; HANDLE file;
    path(blockedPath, L"blocked");
    file = CreateFileW(blockedPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    init_options(&options, L"blocked\\child");
    state = cx_diagnostics_create(&options, errorText, 512);
    check("path preparation failure remains nonfatal and returns a state", state && !cx_diagnostics_enabled(state) && errorText[0]);
    cx_diagnostics_close(state);
}

void DiagnosticsTestMain(void) {
    DWORD length = GetEnvironmentVariableW(L"CX_DIAGNOSTICS_TEST_DIR", testRoot, 32768);
    if (!length || length >= 32768) ExitProcess(2);
    CreateDirectoryW(testRoot, NULL);
    test_disabled(); test_success(); test_schema_rejection(); test_input_limits(); test_path_failure();
    output(failures ? "DIAGNOSTICS SELF-TEST FAIL\n" : "DIAGNOSTICS SELF-TEST PASS\n");
    ExitProcess(failures ? 1 : 0);
}
