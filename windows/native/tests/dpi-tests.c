#define WIN32_LEAN_AND_MEAN
#include <windows.h>

static WCHAR testRegistryPath[256];
static const WCHAR clientName[] = L"C:\\ChaoxingPlus test\\Unicode 客户端\\CXExam.exe";
static const WCHAR canaryName[] = L"other-client-canary";
static const BYTE canaryBytes[] = { 0, 17, 255, 31 };
static DWORD failures, setCalls, deleteCalls, setFailures, deleteFailures;
static HKEY testKey;
static WCHAR errorText[512];
static BYTE readBytes[131072], oversizedValue[65538];
static BYTE originalReadback[131072];
static DWORD originalReadbackType, originalReadbackSize;
static BOOL malformedRead;

static LSTATUS WINAPI test_reg_set(HKEY key, LPCWSTR name, DWORD reserved,
                                   DWORD type, const BYTE *data, DWORD size) {
    ++setCalls;
    if (setFailures) { --setFailures; return ERROR_ACCESS_DENIED; }
    return RegSetValueExW(key, name, reserved, type, data, size);
}
static LSTATUS WINAPI test_reg_delete(HKEY key, LPCWSTR name) {
    ++deleteCalls;
    if (deleteFailures) { --deleteFailures; return ERROR_ACCESS_DENIED; }
    return RegDeleteValueW(key, name);
}
static LSTATUS WINAPI test_reg_query(HKEY key, LPCWSTR name, LPDWORD reserved,
                                     LPDWORD type, LPBYTE data, LPDWORD size) {
    const BYTE odd[] = { 'a', 0, 'b' };
    DWORD capacity;
    if (!malformedRead || lstrcmpW(name, clientName))
        return RegQueryValueExW(key, name, reserved, type, data, size);
    if (!size) return ERROR_INVALID_PARAMETER;
    capacity = *size; *size = sizeof(odd);
    if (type) *type = REG_SZ;
    if (!data) return ERROR_SUCCESS;
    if (capacity < sizeof(odd)) return ERROR_MORE_DATA;
    CopyMemory(data, odd, sizeof(odd)); return ERROR_SUCCESS;
}

/* The actual AppCompat key is never opened by this test executable. */
#define CX_DPI_LAYERS_KEY testRegistryPath
#define RegSetValueExW test_reg_set
#define RegDeleteValueW test_reg_delete
#define RegQueryValueExW test_reg_query
#include "../dpi.c"
#undef RegSetValueExW
#undef RegDeleteValueW
#undef RegQueryValueExW

static void output(const char *text) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &written, NULL);
}
static void check(BOOL ok, const char *name) {
    output(ok ? "PASS " : "FAIL "); output(name); output("\n");
    if (!ok) ++failures;
}
static BOOL bytes_equal(const BYTE *a, const BYTE *b, DWORD size) {
    DWORD i;
    for (i = 0; i < size; ++i) if (a[i] != b[i]) return FALSE;
    return TRUE;
}
static BOOL value_equals(const WCHAR *name, DWORD expectedType, const BYTE *expected, DWORD expectedSize) {
    DWORD type = 0, size = sizeof(readBytes);
    LSTATUS status = RegQueryValueExW(testKey, name, NULL, &type, readBytes, &size);
    return status == ERROR_SUCCESS && type == expectedType && size == expectedSize
        && bytes_equal(readBytes, expected, size);
}
static BOOL client_absent(void) {
    DWORD type = 0, size = 0;
    return RegQueryValueExW(testKey, clientName, NULL, &type, NULL, &size) == ERROR_FILE_NOT_FOUND;
}
static BOOL write_original(DWORD type, const void *data, DWORD size) {
    return RegSetValueExW(testKey, clientName, 0, type, (const BYTE *)data, size) == ERROR_SUCCESS;
}
static BOOL capture_original(void) {
    originalReadbackSize = sizeof(originalReadback); originalReadbackType = 0;
    return RegQueryValueExW(testKey, clientName, NULL, &originalReadbackType,
        originalReadback, &originalReadbackSize) == ERROR_SUCCESS;
}
static void size_note(const char *label, DWORD size) {
    char digits[16]; DWORD at = 0;
    output(label);
    do { digits[at++] = (char)('0' + size % 10); size /= 10; } while (size);
    while (at) { char one[2]; one[0] = digits[--at]; one[1] = 0; output(one); }
    output("\n");
}
static DWORD string_bytes(const WCHAR *text) { return ((DWORD)lstrlenW(text) + 1) * sizeof(WCHAR); }
static void reset_client(void) {
    RegDeleteValueW(testKey, clientName);
    setCalls = deleteCalls = setFailures = deleteFailures = 0;
    malformedRead = FALSE;
    errorText[0] = 0;
}
static BOOL canary_unchanged(void) {
    return value_equals(canaryName, REG_BINARY, canaryBytes, sizeof(canaryBytes));
}
static WCHAR fold(WCHAR c) { return c >= L'a' && c <= L'z' ? c - L'a' + L'A' : c; }
static BOOL whitespace(WCHAR c) { return c == L' ' || c == L'\t' || c == L'\r' || c == L'\n'; }
static DWORD token_count(const WCHAR *needle) {
    DWORD type = 0, size = sizeof(readBytes), at = 0, start, i, count = 0;
    WCHAR *text = (WCHAR *)readBytes;
    DWORD length = (DWORD)lstrlenW(needle);
    if (RegQueryValueExW(testKey, clientName, NULL, &type, readBytes, &size) != ERROR_SUCCESS
        || (type != REG_SZ && type != REG_EXPAND_SZ) || size < sizeof(WCHAR)
        || size % sizeof(WCHAR) || text[size / sizeof(WCHAR) - 1]) return 0;
    while (text[at]) {
        while (whitespace(text[at])) ++at;
        start = at;
        while (text[at] && !whitespace(text[at])) ++at;
        if (at - start == length) {
            for (i = 0; i < length && fold(text[start + i]) == fold(needle[i]); ++i) {}
            if (i == length) ++count;
        }
    }
    return count;
}
static void test_absent_value(void) {
    CX_DPI_OVERRIDE *snapshot;
    reset_client();
    snapshot = cx_dpi_begin(clientName, errorText, 512);
    check(snapshot && setCalls == 1 && token_count(L"HIGHDPIAWARE") == 1,
        "absent client receives one temporary DPI layer");
    check(snapshot && cx_dpi_restore(snapshot, errorText, 512) && client_absent() && deleteCalls == 1,
        "absent original value is deleted after restore");
    check(canary_unchanged(), "other client values survive temporary DPI override");
}
static void test_exact_restore(void) {
    const WCHAR regular[] = L"~ WIN7RTM RUNASADMIN";
    const WCHAR expandable[] = L"~ %CUSTOM_COMPAT% RUNASADMIN";
    const WCHAR *values[] = { regular, expandable };
    DWORD types[] = { REG_SZ, REG_EXPAND_SZ };
    DWORD i;
    CX_DPI_OVERRIDE *snapshot;
    BOOL temporaryValid, restored;
    for (i = 0; i < 2; ++i) {
        reset_client();
        check(write_original(types[i], values[i], string_bytes(values[i])), "test original string is installed");
        snapshot = cx_dpi_begin(clientName, errorText, 512);
        check(snapshot && token_count(L"RUNASADMIN") == 1 && token_count(L"HIGHDPIAWARE") == 1,
            "temporary DPI layer retains existing non-DPI flags");
        check(snapshot && cx_dpi_restore(snapshot, errorText, 512)
            && value_equals(clientName, types[i], (const BYTE *)values[i], string_bytes(values[i])),
            "restore preserves original registry type and exact bytes");
    }
    reset_client();
    check(write_original(REG_SZ, regular, string_bytes(regular) - sizeof(WCHAR)), "unterminated original is installed");
    check(capture_original(), "unterminated-input original is read back before override");
    size_note("INFO unterminated-input registry readback bytes=", originalReadbackSize);
    snapshot = cx_dpi_begin(clientName, errorText, 512);
    temporaryValid = token_count(L"HIGHDPIAWARE") == 1;
    restored = snapshot && cx_dpi_restore(snapshot, errorText, 512);
    check(snapshot && temporaryValid && restored
        && value_equals(clientName, originalReadbackType, originalReadback, originalReadbackSize),
        "unterminated input restores actual pre-launch registry bytes");
    reset_client();
    check(write_original(REG_SZ, L"", 0), "zero-byte string original is installed");
    snapshot = cx_dpi_begin(clientName, errorText, 512);
    check(snapshot && cx_dpi_restore(snapshot, errorText, 512)
        && value_equals(clientName, REG_SZ, (const BYTE *)L"", 0),
        "zero-byte original stays present and empty");
    reset_client();
    check(write_original(REG_SZ, L"", sizeof(WCHAR)), "NUL-only original is installed");
    snapshot = cx_dpi_begin(clientName, errorText, 512);
    check(snapshot && cx_dpi_restore(snapshot, errorText, 512)
        && value_equals(clientName, REG_SZ, (const BYTE *)L"", sizeof(WCHAR)),
        "NUL-only original is not confused with a missing value");
}
static void test_dpi_tokens(void) {
    const WCHAR conflicts[] = L"~  DPIUNAWARE WIN7RTM\tgdidpiscaling HighDpiAware RUNASADMIN DPIUNAWAREX";
    const WCHAR already[] = L"~ WIN7RTM HighDpiAware RUNASADMIN";
    CX_DPI_OVERRIDE *snapshot;
    BOOL unchanged, restored;
    reset_client(); write_original(REG_SZ, conflicts, sizeof(conflicts));
    snapshot = cx_dpi_begin(clientName, errorText, 512);
    check(snapshot && !token_count(L"DPIUNAWARE") && !token_count(L"GDIDPISCALING")
        && token_count(L"HIGHDPIAWARE") == 1 && token_count(L"WIN7RTM") == 1
        && token_count(L"RUNASADMIN") == 1 && token_count(L"DPIUNAWAREX") == 1,
        "conflicting DPI tokens are replaced while unrelated and near-match tokens remain");
    check(snapshot && cx_dpi_restore(snapshot, errorText, 512)
        && value_equals(clientName, REG_SZ, (const BYTE *)conflicts, sizeof(conflicts)),
        "DPI token normalization does not alter the restored original bytes");
    reset_client(); write_original(REG_SZ, already, sizeof(already));
    snapshot = cx_dpi_begin(clientName, errorText, 512);
    unchanged = setCalls == 0 && deleteCalls == 0;
    restored = snapshot && cx_dpi_restore(snapshot, errorText, 512);
    check(snapshot && unchanged && restored
        && setCalls == 0 && deleteCalls == 0
        && value_equals(clientName, REG_SZ, (const BYTE *)already, sizeof(already)),
        "existing compatible DPI layer is never rewritten");
}
static void test_invalid_values(void) {
    const DWORD number = 123;
    const BYTE odd[] = { 'a', 0, 'b' };
    const WCHAR embedded[] = { L'~', 0, L'X', 0 };
    const BYTE *values[] = { (const BYTE *)&number, odd, (const BYTE *)embedded, oversizedValue };
    DWORD types[] = { REG_DWORD, REG_SZ, REG_SZ, REG_SZ };
    DWORD sizes[] = { sizeof(number), sizeof(odd), sizeof(embedded), sizeof(oversizedValue) };
    DWORD i;
    for (i = 0; i < sizeof(oversizedValue) / sizeof(WCHAR) - 1; ++i) {
        oversizedValue[i * sizeof(WCHAR)] = 'A'; oversizedValue[i * sizeof(WCHAR) + 1] = 0;
    }
    for (i = 0; i < 4; ++i) {
        CX_DPI_OVERRIDE *snapshot;
        reset_client(); check(write_original(types[i], values[i], sizes[i]), "invalid test original is installed");
        check(capture_original(), "invalid-input original is read back before override");
        if (i == 1) {
            size_note("INFO odd-input registry readback bytes=", originalReadbackSize);
            malformedRead = TRUE;
        }
        snapshot = cx_dpi_begin(clientName, errorText, 512);
        check(!snapshot && !setCalls && !deleteCalls && errorText[0]
            && value_equals(clientName, originalReadbackType, originalReadback, originalReadbackSize),
            "invalid or oversized original is rejected without changing it");
        if (snapshot) cx_dpi_restore(snapshot, errorText, 512);
    }
}
static void test_external_change(void) {
    const WCHAR original[] = L"~ RUNASADMIN";
    const WCHAR external[] = L"external-setting-canary";
    CX_DPI_OVERRIDE *snapshot;
    DWORD beforeSet, beforeDelete;
    reset_client(); write_original(REG_SZ, original, sizeof(original));
    snapshot = cx_dpi_begin(clientName, errorText, 512);
    check(snapshot != NULL, "external-change test obtains snapshot");
    write_original(REG_EXPAND_SZ, external, sizeof(external));
    beforeSet = setCalls; beforeDelete = deleteCalls;
    check(snapshot && !cx_dpi_restore(snapshot, errorText, 512) && errorText[0]
        && setCalls == beforeSet && deleteCalls == beforeDelete
        && value_equals(clientName, REG_EXPAND_SZ, (const BYTE *)external, sizeof(external)),
        "visible external type or byte changes are retained instead of overwritten");
}
static void test_write_failure(void) {
    const WCHAR original[] = L"~ WIN7RTM";
    CX_DPI_OVERRIDE *snapshot;
    reset_client(); write_original(REG_SZ, original, sizeof(original)); setFailures = MAXDWORD;
    snapshot = cx_dpi_begin(clientName, errorText, 512);
    check(!snapshot && setCalls >= 1 && setCalls <= 3 && errorText[0]
        && value_equals(clientName, REG_SZ, (const BYTE *)original, sizeof(original)),
        "temporary write failure does not pretend DPI was applied");
    setFailures = 0;
    if (snapshot) cx_dpi_restore(snapshot, errorText, 512);
}
static void test_restore_retries(void) {
    const WCHAR original[] = L"~ WIN7RTM RUNASADMIN";
    CX_DPI_OVERRIDE *snapshot;
    DWORD before;
    reset_client(); write_original(REG_SZ, original, sizeof(original));
    snapshot = cx_dpi_begin(clientName, errorText, 512); before = setCalls; setFailures = 2;
    check(snapshot && cx_dpi_restore(snapshot, errorText, 512) && setCalls - before == 3
        && value_equals(clientName, REG_SZ, (const BYTE *)original, sizeof(original)),
        "restore succeeds on its third bounded set attempt");
    reset_client(); write_original(REG_SZ, original, sizeof(original));
    snapshot = cx_dpi_begin(clientName, errorText, 512); before = setCalls; setFailures = MAXDWORD;
    check(snapshot && !cx_dpi_restore(snapshot, errorText, 512) && setCalls - before == 3
        && errorText[0] && token_count(L"HIGHDPIAWARE") == 1,
        "persistent restore-set failure returns false after three attempts");
    reset_client(); snapshot = cx_dpi_begin(clientName, errorText, 512); before = deleteCalls; deleteFailures = 2;
    check(snapshot && cx_dpi_restore(snapshot, errorText, 512) && deleteCalls - before == 3 && client_absent(),
        "restore succeeds on its third bounded delete attempt");
    reset_client(); snapshot = cx_dpi_begin(clientName, errorText, 512); before = deleteCalls; deleteFailures = MAXDWORD;
    check(snapshot && !cx_dpi_restore(snapshot, errorText, 512) && deleteCalls - before == 3
        && errorText[0] && token_count(L"HIGHDPIAWARE") == 1,
        "persistent restore-delete failure returns false after three attempts");
    reset_client(); check(canary_unchanged(), "DPI error paths never delete other client canaries");
}
static void append_decimal(WCHAR *out, DWORD value) {
    WCHAR digits[16]; DWORD used = 0, at = (DWORD)lstrlenW(out);
    do { digits[used++] = (WCHAR)(L'0' + value % 10); value /= 10; } while (value);
    while (used) out[at++] = digits[--used]; out[at] = 0;
}
void __stdcall DpiTestMain(void) {
    DWORD disposition = 0;
    LSTATUS status;
    lstrcpyW(testRegistryPath, L"Software\\ChaoxingPlus\\Tests\\");
    append_decimal(testRegistryPath, GetCurrentProcessId());
    status = RegCreateKeyExW(HKEY_CURRENT_USER, testRegistryPath, 0, NULL, REG_OPTION_NON_VOLATILE,
        KEY_QUERY_VALUE | KEY_SET_VALUE, NULL, &testKey, &disposition);
    if (status != ERROR_SUCCESS || disposition != REG_CREATED_NEW_KEY) {
        if (status == ERROR_SUCCESS) RegCloseKey(testKey);
        output("FAIL cannot create an isolated owned registry test key\nNATIVE DPI TESTS FAIL\n"); ExitProcess(3);
    }
    check(RegSetValueExW(testKey, canaryName, 0, REG_BINARY, canaryBytes, sizeof(canaryBytes)) == ERROR_SUCCESS,
        "owned registry key has an independent canary value");
    test_absent_value(); test_exact_restore(); test_dpi_tokens(); test_invalid_values();
    test_external_change(); test_write_failure(); test_restore_retries();
    check(canary_unchanged(), "all test scenarios preserve the unrelated canary");
    RegCloseKey(testKey); testKey = NULL;
    status = RegDeleteTreeW(HKEY_CURRENT_USER, testRegistryPath);
    check(status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND, "owned test registry values are cleaned");
    status = RegDeleteKeyW(HKEY_CURRENT_USER, testRegistryPath);
    check(status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND, "only the owned PID registry key is removed");
    output(failures ? "NATIVE DPI TESTS FAIL\n" : "NATIVE DPI TESTS PASS\n");
    ExitProcess(failures ? 1 : 0);
}
