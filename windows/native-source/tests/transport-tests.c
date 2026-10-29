/* Exercise the actual transport over connected loopback sockets. */
#include "../net.c"

#ifdef CX_TEST_OLD_READ
#define net_ws_read_timeout(ws, text, length, timeout, error, cap) net_ws_read(ws, text, length, error, cap)
#endif

typedef struct { NET_WS *ws; SOCKET peer; } TestPair;
typedef struct { SOCKET peer; volatile LONG stop; } ControlWriter;
static DWORD failedChecks;

static void output(const char *text) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, lstrlenA(text), &written, NULL);
}
static void check(const char *name, BOOL result) {
    output(result ? "PASS " : "FAIL "); output(name); output("\n");
    if (!result) ++failedChecks;
}
static BOOL pair_open(TestPair *pair) {
    SOCKET listener = INVALID_SOCKET, client = INVALID_SOCKET;
    struct sockaddr_in address;
    int size = sizeof(address);
    DWORD ioTimeout = 100;
    u_long nonblocking = 1;
    pair->ws = NULL; pair->peer = INVALID_SOCKET;
    listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == INVALID_SOCKET) return FALSE;
    ZeroMemory(&address, sizeof(address));
    address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) == SOCKET_ERROR
        || listen(listener, 1) == SOCKET_ERROR
        || getsockname(listener, (struct sockaddr *)&address, &size) == SOCKET_ERROR) goto failed;
    client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (client == INVALID_SOCKET || connect(client, (struct sockaddr *)&address, sizeof(address)) == SOCKET_ERROR) goto failed;
    pair->peer = accept(listener, NULL, NULL);
    if (pair->peer == INVALID_SOCKET) goto failed;
    closesocket(listener); listener = INVALID_SOCKET;
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, (const char *)&ioTimeout, sizeof(ioTimeout));
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, (const char *)&ioTimeout, sizeof(ioTimeout));
#ifndef CX_TEST_OLD_READ
    if (ioctlsocket(client, FIONBIO, &nonblocking) == SOCKET_ERROR) goto failed;
#else
    (void)nonblocking;
#endif
    pair->ws = (NET_WS *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(NET_WS));
    if (!pair->ws) goto failed;
    pair->ws->socket = client; client = INVALID_SOCKET;
    pair->ws->rx = (BYTE *)HeapAlloc(GetProcessHeap(), 0, RX_LIMIT);
    pair->ws->message = (BYTE *)HeapAlloc(GetProcessHeap(), 0, BODY_LIMIT + 1);
    if (!pair->ws->rx || !pair->ws->message
        || !CryptAcquireContextW(&pair->ws->crypto, NULL, NULL, PROV_RSA_FULL, CRYPT_VERIFYCONTEXT)) goto failed;
    return TRUE;
failed:
    if (listener != INVALID_SOCKET) closesocket(listener);
    if (client != INVALID_SOCKET) closesocket(client);
    if (pair->peer != INVALID_SOCKET) closesocket(pair->peer);
    if (pair->ws) net_ws_close(pair->ws);
    pair->peer = INVALID_SOCKET; pair->ws = NULL;
    return FALSE;
}
static void pair_close(TestPair *pair) {
    if (pair->peer != INVALID_SOCKET) closesocket(pair->peer);
    net_ws_close(pair->ws); pair->ws = NULL; pair->peer = INVALID_SOCKET;
}
static BOOL peer_send(TestPair *pair, const BYTE *frame, DWORD length) {
    return send(pair->peer, (const char *)frame, (int)length, 0) == (int)length;
}
static int read_for(TestPair *pair, DWORD timeout, char **text, DWORD *length) {
    WCHAR error[256];
#ifdef CX_TEST_OLD_READ
    (void)timeout;
#endif
    return net_ws_read_timeout(pair->ws, text, length, timeout, error, 256);
}
static DWORD WINAPI write_controls(void *context) {
    ControlWriter *writer = (ControlWriter *)context;
    const BYTE pong[2] = { 0x8a, 0 };
    while (!InterlockedCompareExchange(&writer->stop, 0, 0)) {
        if (send(writer->peer, (const char *)pong, sizeof(pong), 0) != sizeof(pong)) break;
        Sleep(1);
    }
    return 0;
}
static void test_upgrade_zero_deadline(void) {
    SOCKET listener;
    struct sockaddr_in address;
    int size = sizeof(address);
    DWORD started, elapsed;
    char url[100], number[11], *out;
    WCHAR error[256];
    NET_WS *ws;
    listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == INVALID_SOCKET) { check("create Upgrade deadline listener", FALSE); return; }
    ZeroMemory(&address, sizeof(address));
    address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) == SOCKET_ERROR
        || listen(listener, 1) == SOCKET_ERROR
        || getsockname(listener, (struct sockaddr *)&address, &size) == SOCKET_ERROR) {
        closesocket(listener); check("bind Upgrade deadline listener", FALSE); return;
    }
    decimal(number, ntohs(address.sin_port));
    out = append(url, "ws://127.0.0.1:"); out = append(out, number); append(out, "/devtools/page/fixture");
    started = GetTickCount();
    ws = net_ws_open_timeout(ntohs(address.sin_port), url, 0, error, 256);
    elapsed = GetTickCount() - started;
    check("zero Upgrade timeout performs no connection", !ws && elapsed < 50 && socket_ready(listener, FALSE, 0) == 0);
    net_ws_close(ws); closesocket(listener);
}
static void test_deadlines(void) {
    TestPair pair; char *text = NULL; DWORD length = 0, started, elapsed; int result;
    if (!pair_open(&pair)) { check("create timing loopback pair", FALSE); return; }
    started = GetTickCount(); result = read_for(&pair, 0, &text, &length); elapsed = GetTickCount() - started;
    check("zero timeout never waits for an empty socket", result == 0 && elapsed < 50 && !text && !length);
    started = GetTickCount(); result = read_for(&pair, 25, &text, &length); elapsed = GetTickCount() - started;
    check("positive timeout bounds an idle socket", result == 0 && elapsed < 90 && !text && !length);
    pair_close(&pair);
    if (pair_open(&pair)) {
        ControlWriter writer; HANDLE thread;
        writer.peer = pair.peer; writer.stop = 0;
        thread = CreateThread(NULL, 0, write_controls, &writer, 0, NULL);
        if (!thread) { check("create continuous control writer", FALSE); pair_close(&pair); return; }
        started = GetTickCount(); result = read_for(&pair, 35, &text, &length); elapsed = GetTickCount() - started;
        InterlockedExchange(&writer.stop, 1);
        WaitForSingleObject(thread, 1000); CloseHandle(thread);
        check("continuous control frames respect the total deadline", result == 0 && elapsed < 300 && !pair.ws->failed);
        pair_close(&pair);
    } else check("create continuous control pair", FALSE);
}
static void test_frames(void) {
    TestPair pair; char *text = NULL; DWORD length = 0; int result;
    const BYTE message[] = { 0x81, 2, 'O', 'K' };
    const BYTE fragment[] = { 0x01, 3, 'h', 'e', 'l' };
    const BYTE continuation[] = { 0x80, 2, 'l', 'o' };
    const BYTE pingText[] = { 0x89, 0, 0x81, 1, 'x' };
    BYTE pong[8];
    if (!pair_open(&pair)) { check("create frame pair", FALSE); return; }
    CopyMemory(pair.ws->rx, message, sizeof(message)); pair.ws->rxLength = sizeof(message);
    result = read_for(&pair, 0, &text, &length);
    check("zero timeout consumes an already buffered message", result == 1 && length == 2 && lstrcmpA(text, "OK") == 0);
    net_free(text); text = NULL;
    peer_send(&pair, message, 1);
    result = read_for(&pair, 0, &text, &length);
    check("partial header survives a polling timeout", result == 0 && pair.ws->rxLength == 1 && !text);
    peer_send(&pair, message + 1, sizeof(message) - 1);
    result = read_for(&pair, 100, &text, &length);
    check("partial header resumes on the next read", result == 1 && length == 2 && lstrcmpA(text, "OK") == 0);
    net_free(text); text = NULL;
    peer_send(&pair, fragment, sizeof(fragment));
    result = read_for(&pair, 0, &text, &length);
    check("fragment payload survives a polling timeout", result == 0 && pair.ws->fragmented && pair.ws->messageLength == 3);
    peer_send(&pair, continuation, sizeof(continuation));
    result = read_for(&pair, 100, &text, &length);
    check("continuation completes a preserved fragmented message", result == 1 && length == 5 && lstrcmpA(text, "hello") == 0);
    net_free(text); text = NULL;
    peer_send(&pair, pingText, sizeof(pingText));
    result = read_for(&pair, 100, &text, &length);
    check("ping does not hide the following text frame", result == 1 && length == 1 && text[0] == 'x');
    net_free(text); text = NULL;
    check("ping reply is a masked client pong", recv(pair.peer, (char *)pong, sizeof(pong), 0) >= 6 && pong[0] == 0x8a && (pong[1] & 0x80));
    pair_close(&pair);
}
static void test_poll_fairness(void) {
    TestPair pair; char *text = NULL; DWORD length, i; int result;
    if (!pair_open(&pair)) { check("create fairness pair", FALSE); return; }
    for (i = 0; i < 128; i += 2) { pair.ws->rx[i] = 0x8a; pair.ws->rx[i + 1] = 0; }
    pair.ws->rx[128] = 0x81; pair.ws->rx[129] = 1; pair.ws->rx[130] = 'z'; pair.ws->rxLength = 131;
    result = read_for(&pair, 0, &text, &length);
    check("zero timeout yields after a bounded control-frame batch", result == 0 && pair.ws->rxLength == 3);
    result = read_for(&pair, 0, &text, &length);
    check("a yielded polling batch preserves the following message", result == 1 && length == 1 && text[0] == 'z');
    net_free(text); pair_close(&pair);
}
static void test_failures(void) {
    TestPair pair; char *text = NULL; DWORD length; int result;
    const BYTE invalid[] = { 0x81, 0x80, 0, 0, 0, 0 };
    const BYTE invalidUtf8[] = { 0x81, 2, 0xc0, 0xaf };
    const BYTE closeFrame[] = { 0x88, 0 };
    if (pair_open(&pair)) {
        closesocket(pair.peer); pair.peer = INVALID_SOCKET;
        result = read_for(&pair, 100, &text, &length);
        check("socket EOF marks the WebSocket closed", result == -1 && pair.ws->failed);
        pair_close(&pair);
    } else check("create EOF pair", FALSE);
    if (pair_open(&pair)) {
        peer_send(&pair, invalid, sizeof(invalid)); result = read_for(&pair, 100, &text, &length);
        check("masked server frames fail safely", result == -1 && pair.ws->failed);
        pair_close(&pair);
    } else check("create invalid-frame pair", FALSE);
    if (pair_open(&pair)) {
        peer_send(&pair, invalidUtf8, sizeof(invalidUtf8)); result = read_for(&pair, 100, &text, &length);
        check("invalid text UTF-8 fails safely", result == -1 && pair.ws->failed);
        pair_close(&pair);
    } else check("create UTF-8 pair", FALSE);
    if (pair_open(&pair)) {
        peer_send(&pair, closeFrame, sizeof(closeFrame)); result = read_for(&pair, 100, &text, &length);
        check("peer close frame ends the session", result == -1 && pair.ws->failed);
        pair_close(&pair);
    } else check("create close-frame pair", FALSE);
}
static BOOL http_get_mode(void) {
    const WCHAR *command = GetCommandLineW(), *flag = L"--http-get";
    char path[257], *body = NULL;
    WCHAR error[256];
    DWORD port = 0, length = 0, written;
    int i, pathLength;
    if (*command == L'"') { ++command; while (*command && *command != L'"') ++command; if (*command) ++command; }
    else while (*command && *command != L' ' && *command != L'\t') ++command;
    while (*command == L' ' || *command == L'\t') ++command;
    for (i = 0; flag[i] && command[i] == flag[i]; ++i) {}
    if (flag[i] || (command[i] != L' ' && command[i] != L'\t')) return FALSE;
    command += i;
    while (*command == L' ' || *command == L'\t') ++command;
    while (*command >= L'0' && *command <= L'9') { port = port * 10 + *command++ - L'0'; if (port > 65535) ExitProcess(2); }
    while (*command == L' ' || *command == L'\t') ++command;
    pathLength = WideCharToMultiByte(CP_UTF8, 0, command, -1, path, sizeof(path), NULL, NULL);
    if (!port || pathLength <= 0) ExitProcess(2);
    if (!net_http_get((USHORT)port, path, &body, &length, error, 256)) {
        char message[1024];
        int n = WideCharToMultiByte(CP_UTF8, 0, error, -1, message, sizeof(message), NULL, NULL);
        if (n > 0) output(message);
        WSACleanup(); ExitProcess(1);
    }
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), body, length, &written, NULL);
    net_free(body); WSACleanup(); ExitProcess(0);
}
void __stdcall TransportTestMain(void) {
    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data)) ExitProcess(2);
    http_get_mode();
    test_upgrade_zero_deadline(); test_deadlines(); test_frames(); test_poll_fairness(); test_failures();
    WSACleanup();
    output(failedChecks ? "PROTOCOL SELF TEST FAIL\n" : "PROTOCOL SELF TEST PASS\n");
    ExitProcess(failedChecks ? 1 : 0);
}
