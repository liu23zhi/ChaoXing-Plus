/* 最小 CDP HTTP 端点夹具：读 CX_INJECT_PORT 监听 127.0.0.1，
   应答 /json/version 与 /json/list，用于验证宿主端点探测与后续阶段。 */
#include <winsock2.h>
#include <ws2tcpip.h>

static int contains_a(const char *haystack, const char *needle) {
    int i, k;
    if (!haystack || !needle) return 0;
    for (i = 0; haystack[i]; ++i) {
        for (k = 0; needle[k] && haystack[i + k] == needle[k]; ++k) { }
        if (!needle[k]) return 1;
    }
    return 0;
}

static unsigned short parse_port(const char *text) {
    unsigned short value = 0;
    int i = 0;
    while (text[i] >= '0' && text[i] <= '9') { value = (unsigned short)(value * 10 + (text[i] - '0')); ++i; }
    return value;
}
static char g_reply[1024];
static int g_replyLength;

static void out(const char *text) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &written, NULL);
}

static void build_version(const char *port) {
    lstrcpyA(g_reply, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n");
    lstrcatA(g_reply, "{\"Browser\":\"Chrome/75.0.3770.100\",\"Protocol-Version\":\"1.2\",\"webSocketDebuggerUrl\":\"ws://127.0.0.1:");
    lstrcatA(g_reply, port);
    lstrcatA(g_reply, "/devtools/browser/cx-fixture\"}");
    g_replyLength = lstrlenA(g_reply);
}

static void build_list(const char *port) {
    lstrcpyA(g_reply, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n");
    lstrcatA(g_reply, "[{\"description\":\"\",\"id\":\"CXFIXTURE\",\"title\":\"fixture\",\"type\":\"page\",\"url\":\"https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/fixture\",\"webSocketDebuggerUrl\":\"ws://127.0.0.1:");
    lstrcatA(g_reply, port);
    lstrcatA(g_reply, "/devtools/page/CXFIXTURE\"}]");
    g_replyLength = lstrlenA(g_reply);
}

void __stdcall CdpServerMain(void) {
    WSADATA wsa;
    SOCKET listener;
    struct sockaddr_in addr;
    char port[16];
    DWORD started;
    if (!GetEnvironmentVariableA("CX_INJECT_PORT", port, 16)) { out("cdp-server: CX_INJECT_PORT missing\n"); ExitProcess(2); }
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) { out("cdp-server: WSAStartup failed\n"); ExitProcess(2); }
    listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == INVALID_SOCKET) { out("cdp-server: socket failed\n"); ExitProcess(2); }
    ZeroMemory(&addr, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(parse_port(port));
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");
    if (bind(listener, (struct sockaddr *)&addr, sizeof(addr)) != 0) { out("cdp-server: bind failed\n"); ExitProcess(3); }
    if (listen(listener, 4) != 0) { out("cdp-server: listen failed\n"); ExitProcess(3); }
    out("cdp-server: listening\n");
    started = GetTickCount();
    while (GetTickCount() - started < 25000) {
        fd_set set;
        struct timeval timeout;
        SOCKET client;
        char request[2048];
        int got;
        FD_ZERO(&set);
        FD_SET(listener, &set);
        timeout.tv_sec = 1;
        timeout.tv_usec = 0;
        if (select(0, &set, NULL, NULL, &timeout) <= 0) continue;
        client = accept(listener, NULL, NULL);
        if (client == INVALID_SOCKET) continue;
        got = recv(client, request, sizeof(request) - 1, 0);
        if (got > 0) {
            request[got] = 0;
            if (contains_a(request, "/json/version")) build_version(port);
            else if (contains_a(request, "/json/list")) build_list(port);
            else {
                lstrcpyA(g_reply, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                g_replyLength = lstrlenA(g_reply);
            }
            send(client, g_reply, g_replyLength, 0);
        }
        closesocket(client);
    }
    closesocket(listener);
    WSACleanup();
    ExitProcess(0);
}
