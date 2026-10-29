#include "../diagnostics.h"

static DWORD failures;
static CX_OPTIONS options;
static WCHAR testRoot[32768], blockedPath[32768];
static WCHAR successOutputPath[32768];
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

static void init_options(CX_OPTIONS *target, const WCHAR *suffix) {
    cx_options_init(target);
    target->diagnose = TRUE;
    path(target->diagnosticsDir, suffix);
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
    CX_DIAGNOSTICS *state; const WCHAR *outputPath;
    init_options(&options, L"success");
    state = cx_diagnostics_create(&options, errorText, 512);
    outputPath = state ? cx_diagnostics_output_path(state) : L"";
    check("create diagnostics run directory", state && cx_diagnostics_enabled(state) && errorText[0] == 0);
    check("write bounded page diagnostics JSON", state && cx_diagnostics_write_page_json(state, validJson, sizeof(validJson) - 1, errorText, 512));
    check("published diagnostics file is readable", outputPath && exists(outputPath) && read_equals(outputPath, validJson));
    lstrcpynW(successOutputPath, outputPath, 32768);
    cx_diagnostics_close(state);
    check("published diagnostics file survives state cleanup", successOutputPath[0] && exists(successOutputPath));

    init_options(&options, L"panel"); errorText[0] = 0;
    state = cx_diagnostics_create(&options, errorText, 512);
    outputPath = state ? cx_diagnostics_output_path(state) : L"";
    check("write panel geometry diagnostics JSON", state && cx_diagnostics_write_page_json(state, validPanelJson, sizeof(validPanelJson) - 1, errorText, 512));
    check("published panel diagnostics file is readable", outputPath && exists(outputPath) && read_equals(outputPath, validPanelJson));
    cx_diagnostics_close(state);
}

static void test_schema_rejection(void) {
    CX_DIAGNOSTICS *state;
    const char extra[] = "{\"version\":\"6.2.0\",\"host\":\"native\",\"source\":\"native-page\",\"collectedAt\":\"2026-10-28T12:34:56.789Z\",\"bundleLoaded\":true,\"devicePixelRatio\":1,\"innerWidth\":1,\"innerHeight\":1,\"visualViewport\":{\"width\":1,\"height\":1,\"scale\":1},\"panelCount\":0,\"topPanel\":null,\"scope\":{\"pageOnly\":true,\"windowDpi\":false,\"screenshots\":false},\"secret\":\"question-answer\"}";
    const char url[] = "{\"version\":\"6.2.0\",\"host\":\"native\",\"source\":\"native-page\",\"collectedAt\":\"2026-10-28T12:34:56.789Z\",\"bundleLoaded\":true,\"devicePixelRatio\":1,\"innerWidth\":1,\"innerHeight\":1,\"visualViewport\":{\"width\":1,\"height\":1,\"scale\":1},\"panelCount\":1,\"topPanel\":{\"visible\":true,\"rect\":{\"x\":0,\"y\":0,\"width\":1,\"height\":1},\"fractionalDevicePixel\":{\"x\":0,\"y\":0,\"width\":1,\"height\":1},\"style\":{\"backdropFilter\":\"url(http://private)\",\"boxShadow\":\"none\",\"transform\":\"none\",\"backgroundColor\":\"white\"}},\"scope\":{\"pageOnly\":true,\"windowDpi\":false,\"screenshots\":false}}";
    const char relativeUrl[] = "{\"version\":\"6.2.0\",\"host\":\"native\",\"source\":\"native-page\",\"collectedAt\":\"2026-10-28T12:34:56.789Z\",\"bundleLoaded\":true,\"devicePixelRatio\":1,\"innerWidth\":1,\"innerHeight\":1,\"visualViewport\":{\"width\":1,\"height\":1,\"scale\":1},\"panelCount\":1,\"topPanel\":{\"visible\":true,\"rect\":{\"x\":0,\"y\":0,\"width\":1,\"height\":1},\"fractionalDevicePixel\":{\"x\":0,\"y\":0,\"width\":1,\"height\":1},\"style\":{\"backdropFilter\":\"uRl (relative-private-canary)\",\"boxShadow\":\"none\",\"transform\":\"none\",\"backgroundColor\":\"white\"}},\"scope\":{\"pageOnly\":true,\"windowDpi\":false,\"screenshots\":false}}";
    init_options(&options, L"schema");
    state = cx_diagnostics_create(&options, errorText, 512);
    check("reject extra diagnostic fields", state && !cx_diagnostics_write_page_json(state, extra, sizeof(extra) - 1, errorText, 512) && errorText[0]);
    cx_diagnostics_close(state);
    init_options(&options, L"url"); errorText[0] = 0;
    state = cx_diagnostics_create(&options, errorText, 512);
    check("reject URL-bearing style values", state && !cx_diagnostics_write_page_json(state, url, sizeof(url) - 1, errorText, 512) && errorText[0]);
    cx_diagnostics_close(state);
    init_options(&options, L"relative-url"); errorText[0] = 0;
    state = cx_diagnostics_create(&options, errorText, 512);
    check("reject relative URL-bearing style values with mixed case and spaces", state && !cx_diagnostics_write_page_json(state, relativeUrl, sizeof(relativeUrl) - 1, errorText, 512) && errorText[0]);
    cx_diagnostics_close(state);
}

static void test_input_limits(void) {
    CX_DIAGNOSTICS *state; char *large;
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
    CX_DIAGNOSTICS *state; HANDLE file;
    path(blockedPath, L"blocked");
    file = CreateFileW(blockedPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    init_options(&options, L"blocked\\child");
    state = cx_diagnostics_create(&options, errorText, 512);
    check("path preparation failure remains nonfatal and returns a state", state && !cx_diagnostics_enabled(state) && errorText[0]);
    cx_diagnostics_close(state);
}

static HWND testWindow = NULL;

static BOOL create_test_window(void) {
    WNDCLASSW cls;
    HINSTANCE instance = GetModuleHandleW(NULL);
    ZeroMemory(&cls, sizeof(cls));
    cls.lpfnWndProc = DefWindowProcW;
    cls.hInstance = instance;
    cls.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    cls.lpszClassName = L"CxDiagnosticsTestWindow";
    if (!RegisterClassW(&cls) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return FALSE;
    testWindow = CreateWindowExW(0, cls.lpszClassName, L"CxDiagnosticsTest", WS_OVERLAPPEDWINDOW,
        0, 0, 320, 200, NULL, NULL, instance, NULL);
    return testWindow != NULL;
}

static BOOL file_contains(const WCHAR *name, const char *needle) {
    HANDLE file;
    DWORD size, read = 0, i, needleLength;
    char *text;
    BOOL found = FALSE;
    if (!name || !name[0] || !needle) return FALSE;
    file = CreateFileW(name, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    size = GetFileSize(file, NULL);
    if (size == INVALID_FILE_SIZE || size > 65536) { CloseHandle(file); return FALSE; }
    text = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size + 1);
    if (!text) { CloseHandle(file); return FALSE; }
    if (ReadFile(file, text, size, &read, NULL) && read == size) {
        needleLength = (DWORD)lstrlenA(needle);
        for (i = 0; i + needleLength <= size; ++i) {
            DWORD k = 0;
            while (k < needleLength && text[i + k] == needle[k]) ++k;
            if (k == needleLength) { found = TRUE; break; }
        }
    }
    HeapFree(GetProcessHeap(), 0, text);
    CloseHandle(file);
    return found;
}

static DWORD read_le32(const unsigned char *bytes) {
    return (DWORD)bytes[0] | ((DWORD)bytes[1] << 8) | ((DWORD)bytes[2] << 16) | ((DWORD)bytes[3] << 24);
}

static unsigned long test_crc32(const unsigned char *data, DWORD length) {
    unsigned long crc = 0xFFFFFFFFUL;
    DWORD i, bit;
    for (i = 0; i < length; ++i) {
        crc ^= data[i];
        for (bit = 0; bit < 8; ++bit) crc = (crc & 1UL) ? (0xEDB88320UL ^ (crc >> 1)) : (crc >> 1);
    }
    return crc ^ 0xFFFFFFFFUL;
}

static BOOL read_window_png_meta(const WCHAR *name, DWORD *width, DWORD *height, DWORD *fileSize) {
    HANDLE file;
    unsigned char *bytes = NULL;
    DWORD size, read = 0, i;
    BOOL ok = FALSE;
    static const unsigned char signature[8] = { 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A };
    if (!name || !name[0] || !width || !height || !fileSize) return FALSE;
    file = CreateFileW(name, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    size = GetFileSize(file, NULL);
    if (size == INVALID_FILE_SIZE || size < 57 || size > 64u * 1024u * 1024u) { CloseHandle(file); return FALSE; }
    bytes = (unsigned char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size);
    if (!bytes || !ReadFile(file, bytes, size, &read, NULL) || read != size) goto done;
    for (i = 0; i < 8; ++i) if (bytes[i] != signature[i]) goto done;
    if ((bytes[8] != 0 || bytes[9] != 0 || bytes[10] != 0 || bytes[11] != 13)
        || bytes[12] != 'I' || bytes[13] != 'H' || bytes[14] != 'D' || bytes[15] != 'R') goto done;
    *width = ((DWORD)bytes[16] << 24) | ((DWORD)bytes[17] << 16) | ((DWORD)bytes[18] << 8) | bytes[19];
    *height = ((DWORD)bytes[20] << 24) | ((DWORD)bytes[21] << 16) | ((DWORD)bytes[22] << 8) | bytes[23];
    if (!*width || !*height || bytes[24] != 8 || bytes[25] != 2) goto done;
    {
        unsigned long crc = test_crc32(bytes + 12, 17);
        unsigned long stored = ((unsigned long)bytes[29] << 24) | ((unsigned long)bytes[30] << 16)
            | ((unsigned long)bytes[31] << 8) | bytes[32];
        if (crc != stored) goto done;
    }
    if (size < 12 || bytes[size - 12] != 0 || bytes[size - 11] != 0 || bytes[size - 10] != 0 || bytes[size - 9] != 0
        || bytes[size - 8] != 'I' || bytes[size - 7] != 'E' || bytes[size - 6] != 'N' || bytes[size - 5] != 'D') goto done;
    *fileSize = size;
    ok = *width > 0 && *height > 0;
done:
    if (bytes) HeapFree(GetProcessHeap(), 0, bytes);
    CloseHandle(file);
    return ok;
}

static BOOL read_bmp_meta(const WCHAR *name, DWORD *width, DWORD *height, DWORD *fileSize) {
    HANDLE file;
    DWORD size, read = 0;
    unsigned char header[54];
    BOOL ok = FALSE;
    if (!name || !name[0] || !width || !height || !fileSize) return FALSE;
    file = CreateFileW(name, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    size = GetFileSize(file, NULL);
    if (size >= 54 && ReadFile(file, header, 54, &read, NULL) && read == 54
        && header[0] == 'B' && header[1] == 'M'
        && read_le32(header + 2) == size && read_le32(header + 14) == 40
        && read_le32(header + 28) == 24) {
        *width = read_le32(header + 18);
        *height = read_le32(header + 22);
        *fileSize = size;
        ok = *width > 0 && *height > 0;
    }
    CloseHandle(file);
    return ok;
}

static void test_window_capture(void) {
    CX_DIAGNOSTICS *state; const WCHAR *jsonPath, *bmpPath;
    DWORD width = 0, height = 0, fileSize = 0;
    check("create a test client window for capture", create_test_window());
    init_options(&options, L"window");
    state = cx_diagnostics_create(&options, errorText, 512);
    jsonPath = state ? cx_diagnostics_window_json_path(state) : L"";
    bmpPath = state ? cx_diagnostics_window_capture_path(state) : L"";
    check("window diagnostics paths are prepared", state && jsonPath[0] && bmpPath[0]);
    check("client window readiness detects the test window", cx_diagnostics_client_window_ready(GetCurrentProcessId()));
    check("capture records window DPI/rect JSON", state && cx_diagnostics_capture_window(state, GetCurrentProcessId(), errorText, 512));
    check("window diagnostics JSON is published", jsonPath[0] && exists(jsonPath));
    check("window diagnostics JSON identifies the native window source",
        file_contains(jsonPath, "\"source\":\"native-window\"") && file_contains(jsonPath, "\"status\":\"captured\""));
    check("window diagnostics records DPIs and client PID",
        file_contains(jsonPath, "\"systemDpi\":") && file_contains(jsonPath, "\"windowDpi\":")
        && file_contains(jsonPath, "\"clientPid\":") && file_contains(jsonPath, "\"screen"));
    check("window snapshot BMP is published with bytes",
        bmpPath[0] && exists(bmpPath) && read_bmp_meta(bmpPath, &width, &height, &fileSize));
    check("window snapshot BMP size matches its row stride",
        fileSize == 54u + ((((width * 3u) + 3u) & ~3u) * height));
    {
        const WCHAR *pngPath = state ? cx_diagnostics_window_png_path(state) : L"";
        DWORD pngWidth = 0, pngHeight = 0, pngSize = 0;
        check("window snapshot PNG path is prepared next to the BMP",
            pngPath[0] && contains_text(pngPath, L"window-capture.png"));
        check("window snapshot PNG is published as a valid PNG with IHDR/IDAT/IEND",
            pngPath[0] && exists(pngPath) && read_window_png_meta(pngPath, &pngWidth, &pngHeight, &pngSize)
            && pngWidth == width && pngHeight == height);
        check("window snapshot PNG contains stored zlib IDAT data",
            pngSize > 8u + 25u + 12u + 12u + width * height * 3u);
    }
    if (state) cx_diagnostics_close(state);

    init_options(&options, L"window-none"); errorText[0] = 0;
    state = cx_diagnostics_create(&options, errorText, 512);
    jsonPath = state ? cx_diagnostics_window_json_path(state) : L"";
    check("capture without a client window is nonfatal",
        state && cx_diagnostics_capture_window(state, 0xFFFFFFFEu, errorText, 512));
    check("capture without a client window records unavailable",
        exists(jsonPath) && file_contains(jsonPath, "\"status\":\"unavailable\""));
    if (state) cx_diagnostics_close(state);

    init_options(&options, L"window-disabled"); options.diagnose = FALSE;
    state = cx_diagnostics_create(&options, errorText, 512);
    check("disabled window diagnostics capture is a no-op",
        state && cx_diagnostics_capture_window(state, GetCurrentProcessId(), errorText, 512)
        && !exists(options.diagnosticsDir));
    if (state) cx_diagnostics_close(state);
    if (testWindow) { DestroyWindow(testWindow); testWindow = NULL; }
}
static BOOL contains_text(const WCHAR *text, const WCHAR *needle) {
    DWORD i, j;
    if (!text || !needle) return FALSE;
    for (i = 0; text[i]; ++i) {
        for (j = 0; needle[j] && text[i + j] == needle[j]; ++j) { }
        if (!needle[j]) return TRUE;
    }
    return FALSE;
}

static BOOL bytes_equal(const unsigned char *left, const unsigned char *right, DWORD length) {
    DWORD i;
    for (i = 0; i < length; ++i) if (left[i] != right[i]) return FALSE;
    return TRUE;
}

static BOOL read_prefix(const WCHAR *name, unsigned char *out, DWORD length) {
    HANDLE file;
    DWORD read = 0;
    BOOL ok;
    file = CreateFileW(name, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    ok = ReadFile(file, out, length, &read, NULL) && read == length;
    CloseHandle(file);
    return ok;
}

static DWORD file_size(const WCHAR *name) {
    HANDLE file;
    DWORD size;
    file = CreateFileW(name, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) return 0;
    size = GetFileSize(file, NULL);
    CloseHandle(file);
    return size;
}

static void test_page_screenshot(void) {
    static const char pngBase64[] = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAAAAAA";
    static const char badSignatureBase64[] = "/9j/4AAAAAAAAAAAAAAAAAAAAAEAAAABAAAAAAAAAAAA";
    static const char oversizedBase64[] = "iVBORw0KGgoAAAANSUhEUgAATiAAAAABCAYAAAAAAAAA";
    static const char invalidCharsBase64[] = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAA!!AA";
    static const unsigned char pngSignature[8] = { 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A };
    unsigned char prefix[8];
    CX_DIAGNOSTICS *state;
    const WCHAR *jsonPath, *pngPath;
    init_options(&options, L"png"); options.diagnose = TRUE;
    state = cx_diagnostics_create(&options, errorText, 512);
    jsonPath = state ? cx_diagnostics_output_path(state) : L"";
    pngPath = state ? cx_diagnostics_page_png_path(state) : L"";
    check("page screenshot path is prepared next to the page diagnostics JSON",
        state && jsonPath[0] && pngPath[0] && contains_text(pngPath, L"render-diagnostics-page.png"));
    check("a bounded base64 PNG is decoded and published",
        state && cx_diagnostics_write_page_png(state, pngBase64, sizeof(pngBase64) - 1, errorText, 512)
        && exists(pngPath) && file_size(pngPath) == 33 && read_prefix(pngPath, prefix, 8)
        && bytes_equal(prefix, pngSignature, sizeof(pngSignature)));
    check("invalid base64 characters are rejected without replacing the PNG",
        state && !cx_diagnostics_write_page_png(state, invalidCharsBase64, sizeof(invalidCharsBase64) - 1, errorText, 512)
        && file_size(pngPath) == 33);
    check("a non-PNG screenshot is rejected",
        state && !cx_diagnostics_write_page_png(state, badSignatureBase64, sizeof(badSignatureBase64) - 1, errorText, 512));
    check("oversized PNG dimensions are rejected",
        state && !cx_diagnostics_write_page_png(state, oversizedBase64, sizeof(oversizedBase64) - 1, errorText, 512));
    if (state) cx_diagnostics_close(state);

    init_options(&options, L"png-disabled"); options.diagnose = FALSE;
    state = cx_diagnostics_create(&options, errorText, 512);
    check("disabled page screenshots are a no-op",
        state && cx_diagnostics_write_page_png(state, pngBase64, sizeof(pngBase64) - 1, errorText, 512)
        && !exists(options.diagnosticsDir));
    if (state) cx_diagnostics_close(state);
}
static void test_host_summary(void) {
    static const char pngBase64[] = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAAAAAA";
    CX_DIAGNOSTICS *state;
    const WCHAR *path;
    RECT rect;
    rect.left = 10; rect.top = 20; rect.right = 300; rect.bottom = 200;
    init_options(&options, L"host-summary");
    state = cx_diagnostics_create(&options, errorText, 512);
    path = state ? cx_diagnostics_host_summary_path(state) : L"";
    check("host diagnostics summary path is prepared", state && path[0] && contains_text(path, L"render-diagnostics-host.json"));
    check("an empty host summary reports launch mode without artifacts",
        state && cx_diagnostics_write_host_summary(state, FALSE, errorText, 512) && exists(path)
        && file_contains(path, "\"source\":\"native-host\"")
        && file_contains(path, "\"launchMode\":\"launch\"")
        && file_contains(path, "\"recorded\":false")
        && file_contains(path, "\"dpiStatus\":\"unknown\"")
        && file_contains(path, "\"pageDiagnostics\":false"));
    check("host summary records page diagnostics and screenshot artifacts",
        state && cx_diagnostics_write_page_json(state, validJson, sizeof(validJson) - 1, errorText, 512)
        && cx_diagnostics_write_page_png(state, pngBase64, sizeof(pngBase64) - 1, errorText, 512)
        && cx_diagnostics_write_host_summary(state, TRUE, errorText, 512)
        && file_contains(path, "\"launchMode\":\"attach\"")
        && file_contains(path, "\"pageDiagnostics\":true")
        && file_contains(path, "\"pageScreenshot\":true"));
    cx_diagnostics_record_window(state, 4321, 120, 144, TRUE, &rect, "captured");
    check("host summary records window DPI diagnosis and geometry",
        state && cx_diagnostics_write_host_summary(state, FALSE, errorText, 512)
        && file_contains(path, "\"clientPid\":4321")
        && file_contains(path, "\"systemDpi\":120")
        && file_contains(path, "\"windowDpi\":144")
        && file_contains(path, "\"dpiStatus\":\"mismatch\"")
        && file_contains(path, "\"visible\":true")
        && file_contains(path, "\"width\":290")
        && file_contains(path, "\"height\":180")
        && file_contains(path, "\"screenshot\":\"captured\""));
    check("host summary lists every artifact file name",
        file_contains(path, "render-diagnostics.json")
        && file_contains(path, "render-diagnostics-page.png")
        && file_contains(path, "window-diagnostics.json")
        && file_contains(path, "window-capture.bmp")
        && file_contains(path, "window-capture.png"));
    if (state) cx_diagnostics_close(state);

    init_options(&options, L"host-summary-disabled"); options.diagnose = FALSE;
    state = cx_diagnostics_create(&options, errorText, 512);
    check("disabled host summaries are a no-op",
        state && cx_diagnostics_write_host_summary(state, FALSE, errorText, 512) && !exists(options.diagnosticsDir));
    if (state) cx_diagnostics_close(state);
}
void DiagnosticsTestMain(void) {
    DWORD length = GetEnvironmentVariableW(L"CX_DIAGNOSTICS_TEST_DIR", testRoot, 32768);
    if (!length || length >= 32768) ExitProcess(2);
    CreateDirectoryW(testRoot, NULL);
    test_disabled(); test_success(); test_schema_rejection(); test_input_limits(); test_path_failure(); test_window_capture(); test_page_screenshot(); test_host_summary();
    output(failures ? "DIAGNOSTICS SELF-TEST FAIL\n" : "DIAGNOSTICS SELF-TEST PASS\n");
    ExitProcess(failures ? 1 : 0);
}
