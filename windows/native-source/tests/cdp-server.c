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

/* ---- 最小 WebSocket 服务端：握手 + 文本帧回声（记录收到的方法名） ---- */
static unsigned int rol(unsigned int value, int bits) { return (value << bits) | (value >> (32 - bits)); }

static void sha1_block(const unsigned char *block, unsigned int *state) {
    unsigned int w[80];
    unsigned int a, b, c, d, e;
    int i;
    for (i = 0; i < 16; ++i) {
        w[i] = ((unsigned int)block[i * 4] << 24) | ((unsigned int)block[i * 4 + 1] << 16) |
               ((unsigned int)block[i * 4 + 2] << 8) | (unsigned int)block[i * 4 + 3];
    }
    for (i = 16; i < 80; ++i) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    a = state[0]; b = state[1]; c = state[2]; d = state[3]; e = state[4];
    for (i = 0; i < 80; ++i) {
        unsigned int f, k;
        if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999; }
        else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        {
            unsigned int temp = rol(a, 5) + f + e + k + w[i];
            e = d; d = c; c = rol(b, 30); b = a; a = temp;
        }
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d; state[4] += e;
}

static void sha1(const unsigned char *data, int length, unsigned char out[20]) {
    unsigned int state[5] = { 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0 };
    unsigned char block[64];
    int i, full = length / 64, rest = length % 64;
    for (i = 0; i < full; ++i) sha1_block(data + i * 64, state);
    for (i = 0; i < 64; ++i) block[i] = 0;
    for (i = 0; i < rest; ++i) block[i] = data[full * 64 + i];
    block[rest] = 0x80;
    if (rest >= 56) { sha1_block(block, state); for (i = 0; i < 64; ++i) block[i] = 0; }
    {
        unsigned int bits = (unsigned int)length * 8;
        block[63] = (unsigned char)(bits & 0xFF);
        block[62] = (unsigned char)((bits >> 8) & 0xFF);
        block[61] = (unsigned char)((bits >> 16) & 0xFF);
        block[60] = (unsigned char)((bits >> 24) & 0xFF);
    }
    sha1_block(block, state);
    for (i = 0; i < 5; ++i) {
        out[i * 4] = (unsigned char)(state[i] >> 24);
        out[i * 4 + 1] = (unsigned char)(state[i] >> 16);
        out[i * 4 + 2] = (unsigned char)(state[i] >> 8);
        out[i * 4 + 3] = (unsigned char)state[i];
    }
}

static int base64(const unsigned char *input, int length, char *out, int cap) {
    static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    int i = 0, at = 0;
    while (i + 2 < length && at + 4 < cap) {
        unsigned int value = ((unsigned int)input[i] << 16) | ((unsigned int)input[i + 1] << 8) | input[i + 2];
        out[at++] = table[(value >> 18) & 0x3F];
        out[at++] = table[(value >> 12) & 0x3F];
        out[at++] = table[(value >> 6) & 0x3F];
        out[at++] = table[value & 0x3F];
        i += 3;
    }
    if (i < length && at + 4 < cap) {
        unsigned int value = (unsigned int)input[i] << 16;
        if (i + 1 < length) value |= (unsigned int)input[i + 1] << 8;
        out[at++] = table[(value >> 18) & 0x3F];
        out[at++] = table[(value >> 12) & 0x3F];
        out[at++] = (i + 1 < length) ? table[(value >> 6) & 0x3F] : '=';
        out[at++] = '=';
    }
    out[at] = 0;
    return at;
}

static void record_method(const char *request) {
    const char *needle = "\"method\":\"";
    int i, k;
    char path[MAX_PATH];
    char name[64];
    HANDLE file;
    DWORD written = 0;
    for (i = 0; request[i]; ++i) {
        for (k = 0; needle[k] && request[i + k] == needle[k]; ++k) { }
        if (!needle[k]) {
            int at = 0;
            int start = i + k;
            while (request[start + at] && request[start + at] != '"' && at < 60) { name[at] = request[start + at]; ++at; }
            name[at] = 0;
            if (!GetTempPathA(MAX_PATH, path)) return;
            lstrcatA(path, "cx-cdp-methods.txt");
            file = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
            if (file != INVALID_HANDLE_VALUE) {
                lstrcatA(name, "\r\n");
                WriteFile(file, name, (DWORD)lstrlenA(name), &written, NULL);
                CloseHandle(file);
            }
            return;
        }
    }
}

static int read_frame(SOCKET client, char *payload, int cap) {
    unsigned char header[8];
    int got = recv(client, (char *)header, 2, 0);
    int length, masked, offset = 2, i;
    unsigned char mask[4];
    if (got != 2) return -1;
    length = header[1] & 0x7F;
    masked = (header[1] & 0x80) != 0;
    if (length == 126) {
        if (recv(client, (char *)header, 2, 0) != 2) return -1;
        length = ((int)header[0] << 8) | header[1];
        offset += 2;
    } else if (length == 127) {
        if (recv(client, (char *)header, 8, 0) != 8) return -1;
        length = ((int)header[4] << 24) | ((int)header[5] << 16) | ((int)header[6] << 8) | header[7];
        offset += 8;
    }
    if (masked) {
        if (recv(client, (char *)mask, 4, 0) != 4) return -1;
    }
    if (length >= cap) length = cap - 1;
    got = recv(client, payload, length, 0);
    if (got <= 0) return -1;
    payload[got] = 0;
    if (masked) for (i = 0; i < got; ++i) payload[i] = (char)(payload[i] ^ mask[i % 4]);
    return got;
}

static int write_frame(SOCKET client, const char *payload, int length) {
    unsigned char header[8];
    int headerLength;
    header[0] = 0x81;
    if (length < 126) { header[1] = (unsigned char)length; headerLength = 2; }
    else { header[1] = 126; header[2] = (unsigned char)(length >> 8); header[3] = (unsigned char)(length & 0xFF); headerLength = 4; }
    if (send(client, (const char *)header, headerLength, 0) != headerLength) return 0;
    if (send(client, payload, length, 0) != length) return 0;
    return 1;
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


static void header_copy(const char *request, const char *name, char *out, int cap) {
    int i, k, at = 0;
    out[0] = 0;
    for (i = 0; request[i]; ++i) {
        for (k = 0; name[k] && request[i + k] == name[k]; ++k) { }
        if (!name[k]) {
            int start = i + k;
            while (request[start] == ' ' || request[start] == ':') ++start;
            while (request[start] && request[start] != '\r' && request[start] != '\n' && at < cap - 1) out[at++] = request[start++];
            out[at] = 0;
            return;
        }
    }
}

static void ws_serve(SOCKET client, const char *request) {
    char key[128];
    char combined[256];
    unsigned char digest[20];
    char accept[64];
    char response[512];
    static char payload[65536];
    int payloadLength;
    DWORD started;
    header_copy(request, "Sec-WebSocket-Key", key, sizeof(key));
    if (!key[0]) return;
    lstrcpyA(combined, key);
    lstrcatA(combined, "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    sha1((const unsigned char *)combined, lstrlenA(combined), digest);
    base64(digest, 20, accept, sizeof(accept));
    lstrcpyA(response, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ");
    lstrcatA(response, accept);
    lstrcatA(response, "\r\n\r\n");
    if (send(client, response, lstrlenA(response), 0) <= 0) return;
    started = GetTickCount();
    while (GetTickCount() - started < 20000) {
        char reply[128];
        int id = 1;
        int i;
        payloadLength = read_frame(client, payload, sizeof(payload));
        if (payloadLength <= 0) break;
        record_method(payload);
        for (i = 0; payload[i]; ++i) {
            if (payload[i] == '"' && payload[i + 1] == 'i' && payload[i + 2] == 'd' && payload[i + 3] == '"') {
                int j = i + 4;
                while (payload[j] == ':' || payload[j] == ' ') ++j;
                id = 0;
                while (payload[j] >= '0' && payload[j] <= '9') { id = id * 10 + (payload[j] - '0'); ++j; }
                break;
            }
        }
        wsprintfA(reply, "{\"id\":%d,\"result\":{}}", id);
        if (!write_frame(client, reply, lstrlenA(reply))) break;
    }
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
            if (contains_a(request, "Sec-WebSocket-Key")) { ws_serve(client, request); closesocket(client); continue; }
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



