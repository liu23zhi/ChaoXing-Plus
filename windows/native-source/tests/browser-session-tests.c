#include "browser-session.h"
#include "browser-extension.h"
#include "json.h"
#include <shellapi.h>

static void output(const WCHAR *message) {
    char buffer[4096]; DWORD written; int n = WideCharToMultiByte(CP_UTF8, 0, message, -1, buffer, sizeof(buffer), NULL, NULL);
    if (n > 1) WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), buffer, (DWORD)n - 1, &written, NULL);
}

static BOOL CALLBACK close_owned_window(HWND window, LPARAM parameter) {
    DWORD pid; GetWindowThreadProcessId(window, &pid);
    if (pid == (DWORD)parameter && IsWindowVisible(window)) PostMessageW(window, WM_CLOSE, 0, 0);
    return TRUE;
}

/* The test executable also acts as an owned CDP peer. Delay only its first
   response to reproduce a cold browser without sleeping in the test runner. */
static BOOL fixture_peer(WCHAR **args, int count) {
    HANDLE input = NULL, pipe = NULL; int argument; WCHAR id[64], delayText[24]; DWORD delay = 0, length = 0, got, written; static char request[4096], reply[4096]; char extensionId[64];
    for (argument = 1; argument < count; ++argument) {
        const WCHAR *p = args[argument], *prefix = L"--remote-debugging-io-pipes="; ULONG_PTR value = 0;
        while (*prefix && *p == *prefix) { ++p; ++prefix; }
        if (*prefix) continue;
        while (*p >= L'0' && *p <= L'9') { value = value * 10 + *p++ - L'0'; } input = (HANDLE)value; value = 0;
        if (*p++ != L',') ExitProcess(3);
        while (*p >= L'0' && *p <= L'9') { value = value * 10 + *p++ - L'0'; } pipe = (HANDLE)value;
    }
    if (!input || !pipe) return FALSE;
    if (!GetEnvironmentVariableW(L"CX_BROWSER_SESSION_FIXTURE_ID", id, 64)) ExitProcess(3);
    WideCharToMultiByte(CP_UTF8, 0, id, -1, extensionId, 64, NULL, NULL);
    if (GetEnvironmentVariableW(L"CX_BROWSER_SESSION_FIXTURE_DELAY_MS", delayText, 24)) { const WCHAR *p = delayText; while (*p >= L'0' && *p <= L'9') delay = delay * 10 + *p++ - L'0'; }
    for (;;) {
        static JT tokens[256]; char method[64]; int parsed, wanted;
        do {
            if (length + 1 >= sizeof(request) || !ReadFile(input, request + length, 1, &got, NULL) || got != 1) ExitProcess(0);
        } while (request[length++]);
        parsed = jparse(request, length - 1, tokens, 256);
        if (parsed <= 0 || !jstr(request, tokens, jkey(request, tokens, 0, "method"), method, sizeof(method))) ExitProcess(3);
        wanted = jint(request, tokens, jkey(request, tokens, 0, "id"), 0); length = 0;
        if (lstrcmpA(method, "Browser.getVersion") == 0) Sleep(delay);
        if (lstrcmpA(method, "Extensions.loadUnpacked") == 0) wsprintfA(reply, "{\"id\":%d,\"result\":{\"id\":\"%s\"}}", wanted, extensionId);
        else if (lstrcmpA(method, "Target.createTarget") == 0) wsprintfA(reply, "{\"id\":%d,\"result\":{\"targetId\":\"fixture-target\"}}", wanted);
        else if (lstrcmpA(method, "Target.attachToTarget") == 0) wsprintfA(reply, "{\"id\":%d,\"result\":{\"sessionId\":\"fixture-session\"}}", wanted);
        else if (lstrcmpA(method, "Page.getFrameTree") == 0) wsprintfA(reply, "{\"id\":%d,\"result\":{\"frameTree\":{\"frame\":{\"url\":\"chrome-extension://%s/manifest.json\"}}}}", wanted, extensionId);
        else if (lstrcmpA(method, "Target.getTargets") == 0) wsprintfA(reply, "{\"id\":%d,\"result\":{\"targetInfos\":[]}}", wanted);
        else wsprintfA(reply, "{\"id\":%d,\"result\":{}}", wanted);
        if (!WriteFile(pipe, reply, (DWORD)lstrlenA(reply) + 1, &written, NULL)) ExitProcess(0);
        if (lstrcmpA(method, "Browser.close") == 0) ExitProcess(0);
    }
}

void BrowserSessionTestMain(void) {
    int count; WCHAR **args = CommandLineToArgvW(GetCommandLineW(), &count); static WCHAR error[1024], profile[32768];
    CX_BROWSER_OPTIONS options; CX_BROWSER_SESSION *session = NULL, *second = NULL; BOOL running, windowClose = FALSE; int argument;
    char *settings = NULL; static WCHAR secondProfile[32768]; static JT tokens[256]; int data, result;
    ZeroMemory(&options, sizeof(options)); ZeroMemory(error, sizeof(error));
    if (fixture_peer(args, count)) ExitProcess(0);
    if (count < 3) { output(L"usage: browser-session-tests.exe browser.exe package.crx\n"); ExitProcess(2); }
    options.browserPath = args[1]; options.crxPath = args[2]; options.initialUrl = L"about:blank"; options.headless = TRUE;
    options.settingsJsonUTF8 = "{\"common.settings.probe\":1,\"cx.new.work.answer-retry\":2}";
    if (count > 3 && lstrcmpW(args[3], L"--extract") == 0) {
        WCHAR id[64]; BOOL extracted = cx_browser_extension_extract_file(args[2], args[1], id, 64, error, 1024);
        output(extracted ? L"EXTRACTED " : L"REJECTED "); output(extracted ? id : error); output(L"\n"); LocalFree(args); ExitProcess(extracted ? 0 : 1);
    }
    if (count > 3 && lstrcmpW(args[3], L"--verify") == 0) {
        HANDLE file = CreateFileW(args[2], GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        LARGE_INTEGER size; BYTE *bytes = NULL; DWORD read; BOOL verified = FALSE;
        if (file != INVALID_HANDLE_VALUE && GetFileSizeEx(file, &size) && size.QuadPart > 0 && size.QuadPart <= 64 * 1024 * 1024) {
            bytes = (BYTE *)HeapAlloc(GetProcessHeap(), 0, size.LowPart);
            if (bytes && ReadFile(file, bytes, size.LowPart, &read, NULL) && read == size.LowPart)
                verified = cx_browser_extension_verify(bytes, read, lstrcmpW(args[1], L"-") == 0 ? NULL : args[1], error, 1024);
        }
        if (bytes) HeapFree(GetProcessHeap(), 0, bytes); if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
        output(verified ? L"VERIFIED\n" : L"REJECTED "); if (!verified) { output(error); output(L"\n"); } LocalFree(args); ExitProcess(verified ? 0 : 1);
    }
    if (count > 3 && lstrcmpW(args[3], L"--wrong-id") == 0) options.expectedExtensionId = L"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    if (count > 4 && lstrcmpW(args[3], L"--expected-id") == 0) options.expectedExtensionId = args[4];
    for (argument = 3; argument < count; ++argument) if (lstrcmpW(args[argument], L"--window-close") == 0) { options.headless = FALSE; windowClose = TRUE; }
    if (!cx_browser_start(&options, &session, error, 1024)) { output(error); output(L"\n"); ExitProcess(1); }
    for (argument = 3; argument < count; ++argument) if (lstrcmpW(args[argument], L"--startup-probe") == 0) {
        cx_browser_destroy(session); output(L"PASS delayed-startup cleaned\n"); LocalFree(args); ExitProcess(0);
    }
    lstrcpynW(profile, cx_browser_profile(session), 32768);
    output(L"STARTED id="); output(cx_browser_extension_id(session)); output(L" profile="); output(profile); output(L"\n");
    if (!cx_browser_poll(session, &running, error, 1024) || !running) { output(error); cx_browser_destroy(session); ExitProcess(1); }
    if (!cx_browser_read_settings(session, &settings, error, 1024) || jparse(settings, lstrlenA(settings), tokens, 256) <= 0) { output(error); cx_browser_destroy(session); ExitProcess(1); }
    result = jkey(settings, tokens, 0, "result"); data = jkey(settings, tokens, result, "data");
    if (jint(settings, tokens, jkey(settings, tokens, data, "common.settings.probe"), 0) != 1) { output(L"FIRST_STORAGE_MISMATCH\n"); HeapFree(GetProcessHeap(), 0, settings); cx_browser_destroy(session); ExitProcess(1); }
    HeapFree(GetProcessHeap(), 0, settings); settings = NULL;
    options.settingsJsonUTF8 = "{\"common.settings.probe\":2}";
    if (!cx_browser_start(&options, &second, error, 1024)) { output(error); cx_browser_destroy(session); ExitProcess(1); }
    lstrcpynW(secondProfile, cx_browser_profile(second), 32768);
    output(L"SECOND profile="); output(secondProfile); output(L"\n");
    if (lstrcmpiW(profile, secondProfile) == 0 || cx_browser_pid(session) == cx_browser_pid(second)) { output(L"PROFILES_NOT_ISOLATED\n"); cx_browser_destroy(second); cx_browser_destroy(session); ExitProcess(1); }
    if (!cx_browser_read_settings(second, &settings, error, 1024) || jparse(settings, lstrlenA(settings), tokens, 256) <= 0) { output(error); cx_browser_destroy(second); cx_browser_destroy(session); ExitProcess(1); }
    result = jkey(settings, tokens, 0, "result"); data = jkey(settings, tokens, result, "data");
    if (jint(settings, tokens, jkey(settings, tokens, data, "common.settings.probe"), 0) != 2 || jkey(settings, tokens, data, "cx.new.work.answer-retry") >= 0) { output(L"SECOND_STORAGE_MISMATCH\n"); HeapFree(GetProcessHeap(), 0, settings); cx_browser_destroy(second); cx_browser_destroy(session); ExitProcess(1); }
    HeapFree(GetProcessHeap(), 0, settings); settings = NULL;
    if (!cx_browser_read_settings(session, &settings, error, 1024) || jparse(settings, lstrlenA(settings), tokens, 256) <= 0) { output(error); cx_browser_destroy(second); cx_browser_destroy(session); ExitProcess(1); }
    result = jkey(settings, tokens, 0, "result"); data = jkey(settings, tokens, result, "data");
    if (jint(settings, tokens, jkey(settings, tokens, data, "common.settings.probe"), 0) != 1) { output(L"FIRST_STORAGE_WAS_CHANGED\n"); HeapFree(GetProcessHeap(), 0, settings); cx_browser_destroy(second); cx_browser_destroy(session); ExitProcess(1); }
    HeapFree(GetProcessHeap(), 0, settings); settings = NULL;
    cx_browser_destroy(second);
    if (GetFileAttributesW(secondProfile) != INVALID_FILE_ATTRIBUTES) { output(L"SECOND_PROFILE_REMAINS\n"); cx_browser_destroy(session); ExitProcess(1); }
    if (windowClose) {
        DWORD started = GetTickCount(); EnumWindows(close_owned_window, (LPARAM)cx_browser_pid(session));
        do { if (!cx_browser_poll(session, &running, error, 1024)) { output(error); cx_browser_destroy(session); ExitProcess(1); } if (!running) break; Sleep(20); } while ((DWORD)(GetTickCount() - started) < 15000);
        if (running) { output(L"WINDOW_CLOSE_DID_NOT_END_SESSION\n"); cx_browser_destroy(session); ExitProcess(1); }
        output(L"PASS last-window-close cleaned\n");
    } else if (!cx_browser_close(session, error, 1024)) { output(error); cx_browser_destroy(session); ExitProcess(1); }
    cx_browser_destroy(session);
    if (GetFileAttributesW(profile) != INVALID_FILE_ATTRIBUTES) { output(L"PROFILE_REMAINS\n"); ExitProcess(1); }
    output(L"PASS loaded-extension settings-injected two-isolated-profiles both-cleaned\n");
    LocalFree(args); ExitProcess(0);
}
