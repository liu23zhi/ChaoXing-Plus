/* Drive real CLI selection without showing a window or starting a client. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
BOOL WINAPI test_console_mode(HANDLE handle, LPDWORD mode);
BOOL WINAPI test_read_console(HANDLE handle, LPVOID buffer, DWORD capacity,
                              LPDWORD read, PCONSOLE_READCONSOLE_CONTROL control);
#define GetConsoleMode test_console_mode
#define ReadConsoleW test_read_console
#define WinMain HostWinMain
#define WinMainCRTStartup HostMainCRTStartup
#include "../host.c"
#undef WinMain
#undef WinMainCRTStartup
#undef GetConsoleMode
#undef ReadConsoleW

static CX_OPTIONS testOptions;
static CX_DISCOVERY_RESULT candidates;
static CX_CLIENT_CANDIDATE items[2];
static WCHAR fixtureDirectory[HOST_PATH_CAP], fixtureClient[HOST_PATH_CAP];
static WCHAR consoleInput[HOST_PATH_CAP];
static BOOL readAllowed;
static DWORD readCalls, failures;

BOOL WINAPI test_console_mode(HANDLE handle, LPDWORD mode) {
    (void)handle; if (mode) *mode = ENABLE_LINE_INPUT; return TRUE;
}

BOOL WINAPI test_read_console(HANDLE handle, LPVOID buffer, DWORD capacity,
                              LPDWORD read, PCONSOLE_READCONSOLE_CONTROL control) {
    DWORD at = 0;
    WCHAR *out = (WCHAR *)buffer;
    (void)handle; (void)control; ++readCalls; *read = 0;
    if (!readAllowed) { SetLastError(ERROR_READ_FAULT); return FALSE; }
    while (consoleInput[at] && at < capacity) { out[at] = consoleInput[at]; ++at; }
    *read = at; return TRUE;
}

static void check(BOOL passed, const char *name) {
    h_print_utf8(passed ? "PASS " : "FAIL ");
    h_print_utf8(name); h_print_utf8("\n");
    if (!passed) ++failures;
}

static void reset(const WCHAR *input) {
    cx_options_init(&testOptions);
    h_copy(testOptions.ui, CX_OPTIONS_SHORT_CAP, L"cli");
    h_selected_path[0] = 0; h_main_error[0] = 0; h_exit_code = 0;
    readAllowed = TRUE; readCalls = 0;
    h_copy(consoleInput, HOST_PATH_CAP, input);
}

static void reject(const WCHAR *input, const char *name) {
    BOOL result;
    reset(input);
    result = h_pick_client(&testOptions, &candidates, h_main_error, HOST_ERROR_CAP);
    check(!result && !h_selected_path[0] && h_exit_code == 0 && readCalls == 1, name);
}

static void choose(const WCHAR *input, const WCHAR *expected, const char *name) {
    BOOL result;
    reset(input);
    result = h_pick_client(&testOptions, &candidates, h_main_error, HOST_ERROR_CAP);
    check(result && !lstrcmpiW(h_selected_path, expected) && !h_exit_code && readCalls == 1, name);
}

static void cancel(const WCHAR *input, const char *name) {
    BOOL result;
    reset(input);
    result = h_pick_client(&testOptions, &candidates, h_main_error, HOST_ERROR_CAP);
    check(!result && h_exit_code == 3 && !h_selected_path[0] && readCalls == 1, name);
}

static void manual_paths(void) {
    WCHAR *quoted;
    DWORD length = (DWORD)h_wlen(fixtureClient);
    choose(fixtureClient, fixtureClient, "CLI accepts a validated manual Unicode executable path");
    choose(fixtureDirectory, fixtureClient, "CLI resolves a manual installation directory");
    choose(L"2026 Exam\\CXExam.exe", L"2026 Exam\\CXExam.exe", "CLI accepts a digit-leading relative executable path");
    quoted = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, ((SIZE_T)length + 8) * sizeof(WCHAR));
    if (!quoted) { check(FALSE, "allocate quoted fixture path"); return; }
    quoted[0] = L' '; quoted[1] = L'\"';
    CopyMemory(quoted + 2, fixtureClient, length * sizeof(WCHAR));
    quoted[length + 2] = L'\"'; quoted[length + 3] = L' ';
    quoted[length + 4] = L'\r'; quoted[length + 5] = L'\n'; quoted[length + 6] = 0;
    choose(quoted, fixtureClient, "CLI trims whitespace and matching quotes around a Unicode path");
    HeapFree(GetProcessHeap(), 0, quoted);
}

void __stdcall CliSelectionTestMain(void) {
    int argc;
    WCHAR **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    BOOL result;
    if (!argv || argc != 2 || !h_copy(fixtureDirectory, HOST_PATH_CAP, argv[1])) {
        if (argv) LocalFree(argv);
        h_print_utf8("FAIL fixture directory argument is missing\n"); ExitProcess(2);
    }
    LocalFree(argv);
    if (h_wlen(fixtureDirectory) + 12 >= HOST_PATH_CAP) ExitProcess(2);
    h_copy(fixtureClient, HOST_PATH_CAP, fixtureDirectory);
    lstrcatW(fixtureClient, L"\\CXExam.exe");
    items[0].path = L"C:\\First scanned\\CXExam.exe";
    items[0].machine = CX_DISCOVERY_MACHINE_X86;
    lstrcpyW(items[0].version, L"4.1.4.25512");
    items[1].path = L"D:\\Second scanned\\CXExam.exe";
    items[1].machine = CX_DISCOVERY_MACHINE_X64;
    lstrcpyW(items[1].version, L"4.3.0.4");
    candidates.items = items; candidates.count = candidates.capacity = 2;
    candidates.recommendedIndex = 0;

    choose(L"2\r\n", items[1].path, "CLI chooses a complete numeric index");
    choose(L" \t2 \t\r\n", items[1].path, "CLI trims surrounding whitespace from a numeric index");
    choose(L"\r\n", items[0].path, "an empty Enter accepts the recommended candidate");
    choose(L" \t\r\n", items[0].path, "whitespace-only Enter accepts the recommended candidate");
    reject(L"1junk\r\n", "CLI rejects a numeric prefix followed by junk");
    reject(L"2 trailing\r\n", "CLI rejects trailing text after an index");
    reject(L"999999999999999999999999999999\r\n", "CLI rejects an overflowing numeric index");
    reject(L"0\r\n", "CLI rejects the zero index");
    reject(L"3\r\n", "CLI rejects an index beyond the candidate list");
    reject(L"unrecognised text\r\n", "CLI never defaults to a candidate for arbitrary text");
    reject(L"", "CLI treats a successful zero-byte read as EOF instead of Enter");
    reset(L"\r\n"); readAllowed = FALSE;
    result = h_pick_client(&testOptions, &candidates, h_main_error, HOST_ERROR_CAP);
    check(!result && !h_selected_path[0] && !h_exit_code && readCalls == 1,
        "CLI read failure cannot select a candidate");
    cancel(L"q\r\n", "CLI lower-case q cancels with exit code three");
    cancel(L" Q \r\n", "CLI upper-case Q with whitespace cancels with exit code three");
    manual_paths();
    candidates.count = 0;
    choose(fixtureClient, fixtureClient, "CLI accepts a manual path when discovery found no candidates");
    reject(L"\r\n", "CLI cannot accept a recommended candidate from an empty list");
    cancel(L"q\r\n", "CLI can cancel an empty candidate list");
    h_print_utf8(failures ? "NATIVE CLI SELECTION TESTS FAIL\n" : "NATIVE CLI SELECTION TESTS PASS\n");
    ExitProcess(failures ? 1 : 0);
}
