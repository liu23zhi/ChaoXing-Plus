#define WIN32_LEAN_AND_MEAN
#include <windows.h>

static WCHAR fixture_directory[32768];
static char fixture_input[1024];

static BOOL fixture_write(HANDLE output, const char *text, DWORD length) {
    DWORD written;
    while (length) {
        if (!WriteFile(output, text, length, &written, NULL) || !written) return FALSE;
        text += written;
        length -= written;
    }
    return TRUE;
}

static BOOL fixture_wide(HANDLE output, const WCHAR *text) {
    int length = WideCharToMultiByte(CP_UTF8, 0, text, -1, NULL, 0, NULL, NULL);
    char *utf8;
    BOOL result;
    if (!length) return FALSE;
    utf8 = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)length);
    if (!utf8) return FALSE;
    if (WideCharToMultiByte(CP_UTF8, 0, text, -1, utf8, length, NULL, NULL) != length) {
        HeapFree(GetProcessHeap(), 0, utf8);
        return FALSE;
    }
    result = fixture_write(output, utf8, (DWORD)length - 1);
    HeapFree(GetProcessHeap(), 0, utf8);
    return result;
}

/* Safe GUI child: report argv/CWD and echo stdin without opening any windows. */
void __stdcall ConsoleHelperFixtureMain(void) {
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    DWORD length;
    if (!GetCurrentDirectoryW(32768, fixture_directory)
        || !fixture_wide(output, L"COMMAND_LINE=")
        || !fixture_wide(output, GetCommandLineW())
        || !fixture_wide(output, L"\nCWD=")
        || !fixture_wide(output, fixture_directory)
        || !fixture_wide(output, L"\nINPUT=")) ExitProcess(90);
    while (ReadFile(input, fixture_input, sizeof(fixture_input), &length, NULL) && length) {
        if (!fixture_write(output, fixture_input, length)) ExitProcess(91);
    }
    if (!fixture_wide(GetStdHandle(STD_ERROR_HANDLE), L"stderr \x4e2d\x6587\n")) ExitProcess(92);
    ExitProcess(37);
}
