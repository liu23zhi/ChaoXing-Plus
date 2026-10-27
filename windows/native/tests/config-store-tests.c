#include "../config-store.h"
#include "../json.h"

static DWORD failures;
static WCHAR testRoot[32768], filePath[32768], errorText[256];
static WCHAR auxiliaryPath[32768];

static void output(const char *text) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &written, NULL);
}
static void check(const char *name, BOOL ok) {
    output(ok ? "PASS " : "FAIL "); output(name); output("\n");
    if (!ok) ++failures;
}
static void path(const WCHAR *suffix) {
    lstrcpyW(filePath, testRoot); lstrcatW(filePath, L"\\"); lstrcatW(filePath, suffix);
}
static BOOL write_file(const WCHAR *name, const char *text, DWORD length) {
    HANDLE file = CreateFileW(name, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);
    DWORD written; BOOL ok;
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    ok = WriteFile(file, text, length, &written, NULL) && written == length;
    CloseHandle(file); return ok;
}
static char *read_file(const WCHAR *name, DWORD *length) {
    HANDLE file = CreateFileW(name, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
    char *text; DWORD size, got;
    if (file == INVALID_HANDLE_VALUE) return NULL;
    size = GetFileSize(file, NULL);
    if (size == INVALID_FILE_SIZE || size > 131072) { CloseHandle(file); return NULL; }
    text = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size + 1);
    if (!text || !ReadFile(file, text, size, &got, NULL) || got != size) {
        if (text) HeapFree(GetProcessHeap(), 0, text);
        text = NULL;
    }
    CloseHandle(file); if (text) *length = size; return text;
}
static BOOL saved_equal(const WCHAR *name, const char *expected) {
    DWORD length; char *text = read_file(name, &length);
    BOOL ok = text && lstrcmpA(text, expected) == 0;
    if (text) HeapFree(GetProcessHeap(), 0, text);
    return ok;
}
static BOOL merge(const char *base, const char *patch, char *out, DWORD *length) {
    return cx_config_merge_settings(base, (DWORD)lstrlenA(base), patch,
        (DWORD)lstrlenA(patch), out, CX_CONFIG_JSON_CAP, length, errorText, 256);
}
static void test_merge(void) {
    const char *base = "{\"common.settings.a\":1,\"common.settings.a\":2,\"common.settings.keep\":null,\"question.123\":\"secret\"}";
    const char *patch = "{\"\\u0063ommon.settings.a\":3,\"common.settings.a\":[1,{\"nested\":true}],\"cx.new.work.retry\":false,\"common.apps.question-caches\":[],\"common.work-results.results\":[1],\"cx.question.cache\":{}}";
    char *out = (char *)HeapAlloc(GetProcessHeap(), 0, CX_CONFIG_JSON_CAP);
    char *again = (char *)HeapAlloc(GetProcessHeap(), 0, CX_CONFIG_JSON_CAP);
    DWORD length = 0, next = 0, i; BOOL ok;
    if (!out || !again) ExitProcess(3);
    ok = merge(base, patch, out, &length);
    check("merge decoded duplicate keys with last value and nested types", ok && lstrcmpA(out,
        "{\"common.settings.a\":[1,{\"nested\":true}],\"common.settings.keep\":null,\"cx.new.work.retry\":false,\"common.apps.question-caches\":[]}") == 0);
    path(L"merged.json"); if (ok) write_file(filePath, out, length);
    for (i = 0; i < 40 && ok; ++i) {
        ok = merge(out, patch, again, &next) && next == length && lstrcmpA(out, again) == 0;
        if (ok) CopyMemory(out, again, next + 1);
    }
    check("repeating a settings patch does not grow duplicate keys", ok && i == 40);
    check("shared prefixes include every host namespace and exclude per-question state",
        merge("{}", "{\"common.settings.x\":1,\"cx.new.study.x\":2,\"cx.new.work.x\":3,\"cx.new.auto-read.x\":4,\"cx.new.study-dispatcher.x\":5,\"common.apps.question-caches\":6,\"common.work-results.results\":7,\"common.apps.question-caches.item\":8,\"cx.new.unknown.x\":9}", out, &length)
        && lstrcmpA(out, "{\"common.settings.x\":1,\"cx.new.study.x\":2,\"cx.new.work.x\":3,\"cx.new.auto-read.x\":4,\"cx.new.study-dispatcher.x\":5,\"common.apps.question-caches\":6}") == 0);
    check("embedded null in decoded keys is rejected without aliasing",
        !merge("{}", "{\"common.apps.question-caches\\u0000hidden\":1,\"common.settings.x\":3}", out, &length));
    check("escaped literal backslash-u is a valid key suffix",
        merge("{}", "{\"common.settings.x\\\\u0000\":2}", out, &length)
        && lstrcmpA(out, "{\"common.settings.x\\\\u0000\":2}") == 0);
    check("Unicode keys use exact code units rather than Windows linguistic comparison",
        merge("{\"common.settings.a\":1}", "{\"common.settings.a\\u00ad\":2}", out, &length)
        && lstrcmpA(out, "{\"common.settings.a\":1,\"common.settings.a\xC2\xAD\":2}") == 0);
    check("UTF-8 and surrogate escapes identify the same decoded Unicode key",
        merge("{\"common.settings.\xF0\x9F\x98\x80\":1}", "{\"common.settings.\\ud83d\\ude00\":2}", out, &length)
        && lstrcmpA(out, "{\"common.settings.\xF0\x9F\x98\x80\":2}") == 0);
    check("canonical keys expose escaped ASCII settings to typed consumers",
        merge("{}", "{\"\\u0063ommon.settings.\\u0062\":2}", out, &length)
        && lstrcmpA(out, "{\"common.settings.b\":2}") == 0);
    check("canonical keys escape only JSON syntax controls and unpaired surrogates",
        merge("{}", "{\"common.settings.\\u0022\\u005c\\u000a\\u00e9\":1,\"common.settings.\\ud800\":2}", out, &length)
        && lstrcmpA(out, "{\"common.settings.\\\"\\\\\\u000a\xC3\xA9\":1,\"common.settings.\\ud800\":2}") == 0);
    path(L"canonical.json"); write_file(filePath, out, length);
    HeapFree(GetProcessHeap(), 0, out); HeapFree(GetProcessHeap(), 0, again);
}
static void test_selection(void) {
    const char *values = "{\"common.settings.a\":1,\"common.settings.a\":9,\"common.settings.b\":false,\"cx.new.work.x\":{\"z\":[null]}}";
    const char *mask = "{\"\\u0063ommon.settings.a\":99,\"common.settings.missing\":true,\"cx.new.work.x\":0,\"question.123\":true}";
    char *out = (char *)HeapAlloc(GetProcessHeap(), 0, CX_CONFIG_JSON_CAP);
    DWORD length = 0; BOOL ok;
    if (!out) ExitProcess(3);
    ok = cx_config_select_settings(values, (DWORD)lstrlenA(values), mask,
        (DWORD)lstrlenA(mask), out, CX_CONFIG_JSON_CAP, &length, errorText, 256);
    check("select changed shared keys using final current values", ok && lstrcmpA(out,
        "{\"common.settings.a\":9,\"cx.new.work.x\":{\"z\":[null]}}") == 0);
    path(L"selected.json"); if (ok) write_file(filePath, out, length);
    HeapFree(GetProcessHeap(), 0, out);
}
static void test_invalid(void) {
    const char *invalid[] = { "[]", "{", "{\"common.settings.x\":NaN}", "{\"common.settings.x\":\"\xC0\xAF\"}", "{\"x\":1} {}" };
    DWORD i, length = 123; char out[16] = "unchanged"; BOOL ok = TRUE;
    char *large = (char *)HeapAlloc(GetProcessHeap(), 0, CX_CONFIG_JSON_CAP + 1);
    if (!large) ExitProcess(3);
    for (i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i) {
        length = 123;
        ok = ok && !cx_config_merge_settings("{}", 2, invalid[i], (DWORD)lstrlenA(invalid[i]), out, sizeof(out), &length, errorText, 256)
            && length == 123 && lstrcmpA(out, "unchanged") == 0 && errorText[0];
    }
    check("invalid syntax root and UTF-8 leave output and length unchanged", ok);
    length = 123;
    check("capacity failure leaves output and length unchanged", !cx_config_merge_settings("{}", 2,
        "{\"common.settings.long\":true}", 29, out, sizeof(out), &length, errorText, 256)
        && length == 123 && lstrcmpA(out, "unchanged") == 0 && errorText[0]);
    FillMemory(large, CX_CONFIG_JSON_CAP, ' '); large[0] = '{'; large[1] = '}'; large[CX_CONFIG_JSON_CAP] = 0;
    check("JSON input over the configured limit is rejected", !cx_config_merge_settings(large,
        CX_CONFIG_JSON_CAP, "{}", 2, out, sizeof(out), &length, errorText, 256));
    check("selector validates both values and mask", !cx_config_select_settings("[]", 2, "{}", 2,
        out, sizeof(out), &length, errorText, 256) && !cx_config_select_settings("{}", 2, "[]", 2,
        out, sizeof(out), &length, errorText, 256));
    HeapFree(GetProcessHeap(), 0, large);
}
static void test_files(void) {
    const char *patch = "{\"common.settings.a\":2,\"cx.new.work.retry\":3,\"question.123\":\"must-drop\"}";
    const char *initial = "\xEF\xBB\xBF{\"clientPath\":\"C:\\\\client.exe\",\"future\":{\"mode\":[1,\"\xE4\xB8\xAD\xE6\x96\x87\"]},\"settings\":{\"common.settings.a\":1,\"common.settings.keep\":true}}";
    const char *expected = "{\"clientPath\":\"C:\\\\client.exe\",\"future\":{\"mode\":[1,\"\xE4\xB8\xAD\xE6\x96\x87\"]},\"settings\":{\"common.settings.a\":2,\"common.settings.keep\":true,\"cx.new.work.retry\":3}}";
    char *text; DWORD length = 0, previous = 0, i; HANDLE lock; BOOL ok;
    path(L"\x914D\x7F6E space\\nested\\host.json");
    ok = cx_config_patch_file(filePath, patch, (DWORD)lstrlenA(patch), errorText, 256);
    check("create nested Unicode and space configuration path", ok);
    if (!ok) return;
    check("load UTF-8 BOM and preserve unknown root fields", write_file(filePath, initial, (DWORD)lstrlenA(initial))
        && cx_config_patch_file(filePath, patch, (DWORD)lstrlenA(patch), errorText, 256) && saved_equal(filePath, expected));
    text = read_file(filePath, &previous); if (text) HeapFree(GetProcessHeap(), 0, text);
    ok = TRUE;
    for (i = 0; i < 25 && ok; ++i) {
        ok = cx_config_patch_file(filePath, patch, (DWORD)lstrlenA(patch), errorText, 256);
        text = read_file(filePath, &length); ok = ok && text && length == previous;
        if (text) HeapFree(GetProcessHeap(), 0, text);
    }
    check("repeated file patches retain bounded size", ok && i == 25);
    check("invalid patch preserves existing configuration", !cx_config_patch_file(filePath, "{", 1, errorText, 256) && saved_equal(filePath, expected));
    lstrcpyW(auxiliaryPath, filePath); lstrcatW(auxiliaryPath, L".cx-unrelated.tmp");
    write_file(auxiliaryPath, "unrelated temporary content", 27);
    lock = CreateFileW(filePath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    check("replace failure preserves original and removes only owned temporary file", lock != INVALID_HANDLE_VALUE
        && !cx_config_patch_file(filePath, "{\"common.settings.a\":4}", 23, errorText, 256) && saved_equal(filePath, expected)
        && saved_equal(auxiliaryPath, "unrelated temporary content"));
    if (lock != INVALID_HANDLE_VALUE) CloseHandle(lock);
    path(L"relative space"); CreateDirectoryW(filePath, NULL);
    check("relative configuration path resolves from process working directory", SetCurrentDirectoryW(filePath)
        && cx_config_patch_file(L"nested\\relative.json", patch, (DWORD)lstrlenA(patch), errorText, 256));
    SetCurrentDirectoryW(testRoot);
    path(L"not-created\\empty.json");
    check("empty shared patch creates no file or parent", cx_config_patch_file(filePath, "{\"question.123\":1}", 18, errorText, 256)
        && GetFileAttributesW(filePath) == INVALID_FILE_ATTRIBUTES);
    path(L"invalid.json"); write_file(filePath, "{broken", 7);
    check("invalid original JSON is never overwritten", !cx_config_patch_file(filePath, patch, (DWORD)lstrlenA(patch), errorText, 256) && saved_equal(filePath, "{broken"));
    write_file(filePath, "{\"x\":\"\xED\xA0\x80\"}", 11);
    check("invalid original UTF-8 is never overwritten", !cx_config_patch_file(filePath, patch, (DWORD)lstrlenA(patch), errorText, 256)
        && saved_equal(filePath, "{\"x\":\"\xED\xA0\x80\"}"));
    write_file(filePath, "{\"settings\":[]}", 15);
    check("invalid settings object preserves original file", !cx_config_patch_file(filePath, patch, (DWORD)lstrlenA(patch), errorText, 256) && saved_equal(filePath, "{\"settings\":[]}"));
    {
        char *large = (char *)HeapAlloc(GetProcessHeap(), 0, CX_CONFIG_JSON_CAP + 1);
        DWORD count = CX_CONFIG_JSON_CAP - 6;
        if (!large) ExitProcess(3);
        lstrcpyA(large, "{\"unknown\":\""); FillMemory(large + 12, count - 14, 'x');
        large[count - 2] = '"'; large[count - 1] = '}'; large[count] = 0;
        path(L"near-limit.json"); write_file(filePath, large, count);
        check("generation overflow preserves the previous complete configuration", !cx_config_patch_file(filePath,
            patch, (DWORD)lstrlenA(patch), errorText, 256) && saved_equal(filePath, large));
        FillMemory(large, CX_CONFIG_JSON_CAP, ' '); large[0] = '{'; large[1] = '}'; large[CX_CONFIG_JSON_CAP] = 0;
        path(L"over-limit.json"); write_file(filePath, large, CX_CONFIG_JSON_CAP);
        check("oversized original configuration is rejected without replacement", !cx_config_patch_file(filePath,
            patch, (DWORD)lstrlenA(patch), errorText, 256) && saved_equal(filePath, large));
        HeapFree(GetProcessHeap(), 0, large);
    }
    path(L"blocking-file"); write_file(filePath, "keep", 4); lstrcatW(filePath, L"\\child.json");
    check("parent file blocks creation safely", !cx_config_patch_file(filePath, patch, (DWORD)lstrlenA(patch), errorText, 256));
    path(L"blocking-directory"); CreateDirectoryW(filePath, NULL);
    check("target directory blocks replacement safely", !cx_config_patch_file(filePath, patch, (DWORD)lstrlenA(patch), errorText, 256));
    path(L"root-duplicate.json"); {
        const char *duplicate = "{\"settings\":{\"common.settings.old\":1},\"\\u0073ettings\":{\"common.settings.last\":9},\"settings\\u00ad\":7,\"unknown\":[false]}";
        write_file(filePath, duplicate, (DWORD)lstrlenA(duplicate));
    }
    check("duplicate decoded settings root uses the last object", cx_config_patch_file(filePath, "{\"common.settings.a\":2}", 23, errorText, 256));
}
void ConfigStoreTestMain(void) {
    DWORD n = GetEnvironmentVariableW(L"CX_CONFIG_TEST_DIR", testRoot, 32768);
    if (!n || n >= 32768) ExitProcess(3);
    test_merge(); test_selection(); test_invalid(); test_files();
    output(failures ? "CONFIG SELF-TEST FAIL\n" : "CONFIG SELF-TEST PASS\n");
    ExitProcess(failures ? 1 : 0);
}
