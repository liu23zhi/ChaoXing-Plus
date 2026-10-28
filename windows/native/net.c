#include "net.h"
#include <wincrypt.h>

#define BODY_LIMIT (8UL * 1024UL * 1024UL)
#define HEADER_LIMIT 16384UL
#define RX_LIMIT (BODY_LIMIT + 14UL)

struct NET_WS {
    SOCKET socket;
    HCRYPTPROV crypto;
    BYTE *rx;
    DWORD rxLength;
    BYTE *message;
    DWORD messageLength;
    BOOL fragmented;
    BOOL failed;
};

static DWORD text_length(const char *text) {
    DWORD n = 0;
    if (text) while (text[n]) n++;
    return n;
}

static void copy_bytes(void *target, const void *source, DWORD length) {
    DWORD i;
    BYTE *out = (BYTE *)target;
    const BYTE *in = (const BYTE *)source;
    for (i = 0; i < length; i++) out[i] = in[i];
}

static void set_error(WCHAR *error, DWORD cap, const WCHAR *message) {
    if (error && cap) lstrcpynW(error, message, (int)cap);
}

void net_free(void *memory) {
    if (memory) HeapFree(GetProcessHeap(), 0, memory);
}

static char lower_ascii(char value) {
    if (value >= 'A' && value <= 'Z') return (char)(value + 32);
    return value;
}

static BOOL equal_n(const char *left, const char *right, DWORD length, BOOL ignoreCase) {
    DWORD i;
    for (i = 0; i < length; i++) {
        char a = left[i], b = right[i];
        if (ignoreCase) { a = lower_ascii(a); b = lower_ascii(b); }
        if (a != b) return FALSE;
    }
    return TRUE;
}

static DWORD decimal(char *out, DWORD value) {
    char backwards[10];
    DWORD n = 0, i;
    do { backwards[n++] = (char)('0' + value % 10); value /= 10; } while (value);
    for (i = 0; i < n; i++) out[i] = backwards[n - i - 1];
    out[n] = 0;
    return n;
}

static char *append(char *out, const char *text) {
    while (*text) *out++ = *text++;
    *out = 0;
    return out;
}

static SOCKET open_loopback_timeout(USHORT port, DWORD timeoutMs, WCHAR *error, DWORD errorCap) {
    SOCKET sock;
    struct sockaddr_in address;
    u_long nonblocking = 1;
    fd_set writing, errors;
    struct timeval timeout;
    int result, code, codeLength;
    DWORD ioTimeout = 2000;
    if (!port || !timeoutMs) { set_error(error, errorCap, L"Invalid loopback port or expired deadline."); return INVALID_SOCKET; }
    sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) { set_error(error, errorCap, L"socket() failed."); return INVALID_SOCKET; }
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    address.sin_addr.s_addr = htonl(0x7f000001UL);
    address.sin_zero[0] = address.sin_zero[1] = address.sin_zero[2] = address.sin_zero[3] = 0;
    address.sin_zero[4] = address.sin_zero[5] = address.sin_zero[6] = address.sin_zero[7] = 0;
    if (ioctlsocket(sock, FIONBIO, &nonblocking) == SOCKET_ERROR) goto failed;
    result = connect(sock, (struct sockaddr *)&address, sizeof(address));
    if (result == SOCKET_ERROR) {
        code = WSAGetLastError();
        if (code != WSAEWOULDBLOCK && code != WSAEINPROGRESS) goto failed;
        FD_ZERO(&writing); FD_ZERO(&errors);
        FD_SET(sock, &writing); FD_SET(sock, &errors);
        timeout.tv_sec = (long)(timeoutMs / 1000); timeout.tv_usec = (long)((timeoutMs % 1000) * 1000);
        result = select(0, NULL, &writing, &errors, &timeout);
        if (result <= 0 || FD_ISSET(sock, &errors)) goto failed;
        code = 0; codeLength = sizeof(code);
        if (getsockopt(sock, SOL_SOCKET, SO_ERROR, (char *)&code, &codeLength) == SOCKET_ERROR || code) goto failed;
    }
    nonblocking = 0;
    if (ioctlsocket(sock, FIONBIO, &nonblocking) == SOCKET_ERROR) goto failed;
    if (setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char *)&ioTimeout, sizeof(ioTimeout)) == SOCKET_ERROR) goto failed;
    if (setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, (const char *)&ioTimeout, sizeof(ioTimeout)) == SOCKET_ERROR) goto failed;
    return sock;
failed:
    closesocket(sock);
    set_error(error, errorCap, L"Loopback connection failed or timed out.");
    return INVALID_SOCKET;
}

static DWORD header_end(const BYTE *data, DWORD length) {
    DWORD i;
    for (i = 0; i + 3 < length; i++) {
        if (data[i] == '\r' && data[i + 1] == '\n' && data[i + 2] == '\r' && data[i + 3] == '\n') return i + 4;
    }
    return 0;
}

static BOOL header_value(const char *headers, DWORD length, const char *key,
                         const char **value, DWORD *valueLength) {
    DWORD p = 0, start, end, colon, keyLength = text_length(key);
    while (p < length) {
        start = p;
        while (p + 1 < length && !(headers[p] == '\r' && headers[p + 1] == '\n')) p++;
        end = p; p += 2;
        colon = start;
        while (colon < end && headers[colon] != ':') colon++;
        if (colon - start == keyLength && colon < end && equal_n(headers + start, key, keyLength, TRUE)) {
            start = colon + 1;
            while (start < end && (headers[start] == ' ' || headers[start] == '\t')) start++;
            while (end > start && (headers[end - 1] == ' ' || headers[end - 1] == '\t')) end--;
            *value = headers + start; *valueLength = end - start;
            return TRUE;
        }
    }
    return FALSE;
}

static BOOL header_has_token(const char *headers, DWORD length, const char *key, const char *token) {
    const char *value;
    DWORD n, start = 0, end, tokenLength = text_length(token);
    if (!header_value(headers, length, key, &value, &n)) return FALSE;
    while (start < n) {
        while (start < n && (value[start] == ' ' || value[start] == '\t' || value[start] == ',')) start++;
        end = start;
        while (end < n && value[end] != ',') end++;
        while (end > start && (value[end - 1] == ' ' || value[end - 1] == '\t')) end--;
        if (end - start == tokenLength && equal_n(value + start, token, tokenLength, TRUE)) return TRUE;
        while (end < n && value[end] != ',') end++;
        start = end + 1;
    }
    return FALSE;
}

static int socket_ready(SOCKET socket, BOOL writing, DWORD timeoutMs);
static BOOL send_ws_all(NET_WS *ws, const BYTE *data, DWORD length, DWORD started, DWORD timeoutMs);

static DWORD io_remaining(DWORD started, DWORD timeoutMs) {
    DWORD elapsed = GetTickCount() - started;
    return elapsed < timeoutMs ? timeoutMs - elapsed : 0;
}

BOOL net_http_get_timeout(USHORT port, const char *path, char **body, DWORD *length,
                          DWORD timeoutMs, WCHAR *error, DWORD errorCap) {
    SOCKET sock = INVALID_SOCKET;
    BYTE *buffer = NULL;
    char request[512], portText[11], *out;
    DWORD used = 0, offset = 0, expected = 0, n, i, begin = GetTickCount(), remaining, sent = 0, requestLength;
    u_long nonblocking = 1;
    BOOL hasLength = FALSE, okay = FALSE;
    const char *value;
    DWORD valueLength;
    if (body) *body = NULL;
    if (length) *length = 0;
    if (!body || !length || !path || text_length(path) > 256 || path[0] != '/') {
        set_error(error, errorCap, L"Invalid HTTP request."); return FALSE;
    }
    for (i = 0; path[i]; i++) if ((BYTE)path[i] < 0x21 || (BYTE)path[i] > 0x7e) {
        set_error(error, errorCap, L"Invalid HTTP request path."); return FALSE;
    }
    remaining = io_remaining(begin, timeoutMs);
    if (!remaining) { set_error(error, errorCap, L"HTTP response deadline exceeded."); return FALSE; }
    sock = open_loopback_timeout(port, remaining < 2000 ? remaining : 2000, error, errorCap);
    if (sock == INVALID_SOCKET) return FALSE;
    if (ioctlsocket(sock, FIONBIO, &nonblocking) == SOCKET_ERROR) {
        set_error(error, errorCap, L"HTTP socket setup failed."); goto done;
    }
    decimal(portText, port);
    out = request; out = append(out, "GET "); out = append(out, path);
    out = append(out, " HTTP/1.1\r\nHost: 127.0.0.1:"); out = append(out, portText);
    out = append(out, "\r\nConnection: close\r\nAccept: application/json\r\n\r\n");
    requestLength = (DWORD)(out - request);
    while (sent < requestLength) {
        int count;
        remaining = io_remaining(begin, timeoutMs);
        if (!remaining) { set_error(error, errorCap, L"HTTP response deadline exceeded."); goto done; }
        count = send(sock, request + sent, (int)(requestLength - sent), 0);
        if (count > 0) { sent += (DWORD)count; continue; }
        if (count == SOCKET_ERROR && WSAGetLastError() == WSAEWOULDBLOCK
            && socket_ready(sock, TRUE, remaining) > 0) continue;
        set_error(error, errorCap, L"HTTP send failed or timed out."); goto done;
    }
    buffer = (BYTE *)HeapAlloc(GetProcessHeap(), 0, BODY_LIMIT + HEADER_LIMIT + 1);
    if (!buffer) { set_error(error, errorCap, L"Out of memory."); goto done; }
    for (;;) {
        int received;
        remaining = io_remaining(begin, timeoutMs);
        if (!remaining) { set_error(error, errorCap, L"HTTP response deadline exceeded."); goto done; }
        if (offset && hasLength && used - offset >= expected) break;
        if (used >= BODY_LIMIT + HEADER_LIMIT) { set_error(error, errorCap, L"HTTP response exceeds limit."); goto done; }
        if (socket_ready(sock, FALSE, remaining) <= 0) { set_error(error, errorCap, L"HTTP receive failed or timed out."); goto done; }
        received = recv(sock, (char *)buffer + used, (int)(BODY_LIMIT + HEADER_LIMIT - used), 0);
        if (received == SOCKET_ERROR && WSAGetLastError() == WSAEWOULDBLOCK) continue;
        if (received == SOCKET_ERROR) { set_error(error, errorCap, L"HTTP receive failed or timed out."); goto done; }
        if (!received) {
            if (!offset || (hasLength && used - offset != expected)) { set_error(error, errorCap, L"Truncated HTTP response."); goto done; }
            break;
        }
        used += (DWORD)received;
        if (!offset) {
            offset = header_end(buffer, used);
            if (!offset) {
                if (used > HEADER_LIMIT) { set_error(error, errorCap, L"HTTP headers exceed limit."); goto done; }
                continue;
            }
            if (offset > HEADER_LIMIT || used < 13 ||
                !(equal_n((const char *)buffer, "HTTP/1.1 200 ", 13, FALSE) || equal_n((const char *)buffer, "HTTP/1.0 200 ", 13, FALSE))) {
                set_error(error, errorCap, L"HTTP endpoint did not return status 200."); goto done;
            }
            if (header_value((const char *)buffer, offset, "Transfer-Encoding", &value, &valueLength)) {
                set_error(error, errorCap, L"Transfer-Encoding is not supported by this probe."); goto done;
            }
            if (header_value((const char *)buffer, offset, "Content-Length", &value, &valueLength)) {
                if (!valueLength) { set_error(error, errorCap, L"Invalid Content-Length."); goto done; }
                expected = 0;
                for (n = 0; n < valueLength; n++) {
                    if (value[n] < '0' || value[n] > '9' || expected > BODY_LIMIT / 10) {
                        set_error(error, errorCap, L"Invalid or oversized Content-Length."); goto done;
                    }
                    expected = expected * 10 + (DWORD)(value[n] - '0');
                    if (expected > BODY_LIMIT) { set_error(error, errorCap, L"HTTP body exceeds 8 MiB."); goto done; }
                }
                hasLength = TRUE;
            }
        }
        if (offset && used - offset > BODY_LIMIT) { set_error(error, errorCap, L"HTTP body exceeds 8 MiB."); goto done; }
    }
    if (!io_remaining(begin, timeoutMs)) { set_error(error, errorCap, L"HTTP response deadline exceeded."); goto done; }
    n = hasLength ? expected : used - offset;
    *body = (char *)HeapAlloc(GetProcessHeap(), 0, n + 1);
    if (!*body) { set_error(error, errorCap, L"Out of memory."); goto done; }
    copy_bytes(*body, buffer + offset, n);
    (*body)[n] = 0;
    if (!io_remaining(begin, timeoutMs)) {
        net_free(*body); *body = NULL;
        set_error(error, errorCap, L"HTTP response deadline exceeded."); goto done;
    }
    *length = n; okay = TRUE;
done:
    if (sock != INVALID_SOCKET) closesocket(sock);
    net_free(buffer);
    return okay;
}

BOOL net_http_get(USHORT port, const char *path, char **body, DWORD *length,
                  WCHAR *error, DWORD errorCap) {
    return net_http_get_timeout(port, path, body, length, 5000, error, errorCap);
}

static DWORD base64(char *out, const BYTE *bytes, DWORD count) {
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    DWORD n = 0, i;
    for (i = 0; i < count; i += 3) {
        DWORD value = (DWORD)bytes[i] << 16;
        if (i + 1 < count) value |= (DWORD)bytes[i + 1] << 8;
        if (i + 2 < count) value |= bytes[i + 2];
        out[n++] = alphabet[(value >> 18) & 63];
        out[n++] = alphabet[(value >> 12) & 63];
        out[n++] = i + 1 < count ? alphabet[(value >> 6) & 63] : '=';
        out[n++] = i + 2 < count ? alphabet[value & 63] : '=';
    }
    out[n] = 0;
    return n;
}

static BOOL websocket_accept(HCRYPTPROV crypto, const char *key, char *accept) {
    HCRYPTHASH hash = 0;
    BYTE digest[20];
    DWORD count = sizeof(digest);
    static const char guid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    BOOL okay = FALSE;
    if (!CryptCreateHash(crypto, CALG_SHA1, 0, 0, &hash)) return FALSE;
    if (!CryptHashData(hash, (const BYTE *)key, text_length(key), 0) ||
        !CryptHashData(hash, (const BYTE *)guid, sizeof(guid) - 1, 0) ||
        !CryptGetHashParam(hash, HP_HASHVAL, digest, &count, 0) || count != 20) goto done;
    base64(accept, digest, 20); okay = TRUE;
done:
    CryptDestroyHash(hash);
    return okay;
}

static BOOL websocket_path(USHORT port, const char *url, const char **path) {
    const char *p;
    DWORD value = 0, n = text_length(url), i;
    if (n < 12 || n > 2048 || !equal_n(url, "ws://", 5, FALSE)) return FALSE;
    p = url + 5;
    if (n >= 15 && equal_n(p, "127.0.0.1:", 10, FALSE)) p += 10;
    else if (n >= 15 && equal_n(p, "localhost:", 10, TRUE)) p += 10;
    else return FALSE;
    if (*p < '0' || *p > '9') return FALSE;
    while (*p >= '0' && *p <= '9') {
        value = value * 10 + (DWORD)(*p++ - '0');
        if (value > 65535) return FALSE;
    }
    if (value != port || *p != '/') return FALSE;
    for (i = 0; p[i]; i++) if ((BYTE)p[i] < 0x21 || (BYTE)p[i] > 0x7e || p[i] == '#') return FALSE;
    *path = p;
    return TRUE;
}

NET_WS *net_ws_open_timeout(USHORT port, const char *url, DWORD timeoutMs,
                            WCHAR *error, DWORD errorCap) {
    NET_WS *ws;
    const char *path, *value;
    DWORD valueLength, offset = 0, begin = GetTickCount(), remaining;
    char *request = NULL, *out, portText[11], key[25], expectedAccept[29];
    BYTE nonce[16];
    u_long nonblocking = 1;
    if (!timeoutMs) { set_error(error, errorCap, L"WebSocket upgrade deadline exceeded."); return NULL; }
    if (!url || !websocket_path(port, url, &path)) { set_error(error, errorCap, L"Rejected non-loopback or mismatched WebSocket URL."); return NULL; }
    ws = (NET_WS *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(NET_WS));
    if (!ws) { set_error(error, errorCap, L"Out of memory."); return NULL; }
    ws->socket = INVALID_SOCKET;
    if (!CryptAcquireContextW(&ws->crypto, NULL, NULL, PROV_RSA_FULL, CRYPT_VERIFYCONTEXT) ||
        !CryptGenRandom(ws->crypto, sizeof(nonce), nonce)) {
        set_error(error, errorCap, L"Windows cryptographic provider unavailable."); goto failed;
    }
    base64(key, nonce, sizeof(nonce));
    if (!websocket_accept(ws->crypto, key, expectedAccept)) { set_error(error, errorCap, L"WebSocket SHA1 failed."); goto failed; }
    ws->rx = (BYTE *)HeapAlloc(GetProcessHeap(), 0, RX_LIMIT);
    ws->message = (BYTE *)HeapAlloc(GetProcessHeap(), 0, BODY_LIMIT + 1);
    request = (char *)HeapAlloc(GetProcessHeap(), 0, 2600);
    if (!ws->rx || !ws->message || !request) { set_error(error, errorCap, L"Out of memory."); goto failed; }
    remaining = io_remaining(begin, timeoutMs);
    if (!remaining) { set_error(error, errorCap, L"WebSocket upgrade deadline exceeded."); goto failed; }
    ws->socket = open_loopback_timeout(port, remaining < 2000 ? remaining : 2000, error, errorCap);
    if (ws->socket == INVALID_SOCKET) goto failed;
    if (ioctlsocket(ws->socket, FIONBIO, &nonblocking) == SOCKET_ERROR) {
        set_error(error, errorCap, L"Cannot enable nonblocking WebSocket I/O."); goto failed;
    }
    decimal(portText, port);
    out = request; out = append(out, "GET "); out = append(out, path);
    out = append(out, " HTTP/1.1\r\nHost: 127.0.0.1:"); out = append(out, portText);
    out = append(out, "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: "); out = append(out, key);
    out = append(out, "\r\nSec-WebSocket-Version: 13\r\n\r\n");
    if (!send_ws_all(ws, (const BYTE *)request, (DWORD)(out - request), begin, timeoutMs)) {
        set_error(error, errorCap, L"WebSocket upgrade send failed or timed out."); goto failed;
    }
    while (!offset) {
        int received;
        remaining = io_remaining(begin, timeoutMs);
        if (!remaining || ws->rxLength >= HEADER_LIMIT) { set_error(error, errorCap, L"WebSocket upgrade headers exceed limit or deadline."); goto failed; }
        if (socket_ready(ws->socket, FALSE, remaining) <= 0) {
            set_error(error, errorCap, L"WebSocket upgrade receive failed or timed out."); goto failed;
        }
        received = recv(ws->socket, (char *)ws->rx + ws->rxLength, (int)(HEADER_LIMIT - ws->rxLength), 0);
        if (received == SOCKET_ERROR && WSAGetLastError() == WSAEWOULDBLOCK) continue;
        if (received <= 0) { set_error(error, errorCap, L"WebSocket upgrade receive failed."); goto failed; }
        ws->rxLength += (DWORD)received;
        offset = header_end(ws->rx, ws->rxLength);
    }
    if (offset < 13 || !equal_n((const char *)ws->rx, "HTTP/1.1 101 ", 13, FALSE) ||
        !header_has_token((const char *)ws->rx, offset, "Upgrade", "websocket") ||
        !header_has_token((const char *)ws->rx, offset, "Connection", "upgrade") ||
        !header_value((const char *)ws->rx, offset, "Sec-WebSocket-Accept", &value, &valueLength) ||
        valueLength != 28 || !equal_n(value, expectedAccept, 28, FALSE)) {
        set_error(error, errorCap, L"WebSocket upgrade validation failed."); goto failed;
    }
    ws->rxLength -= offset;
    copy_bytes(ws->rx, ws->rx + offset, ws->rxLength);
    if (!io_remaining(begin, timeoutMs)) { set_error(error, errorCap, L"WebSocket upgrade deadline exceeded."); goto failed; }
    net_free(request);
    return ws;
failed:
    net_free(request);
    net_ws_close(ws);
    return NULL;
}

NET_WS *net_ws_open(USHORT port, const char *url, WCHAR *error, DWORD errorCap) {
    return net_ws_open_timeout(port, url, 5000, error, errorCap);
}

static int socket_ready(SOCKET socket, BOOL writing, DWORD timeoutMs) {
    fd_set selected;
    struct timeval timeout;
    FD_ZERO(&selected); FD_SET(socket, &selected);
    timeout.tv_sec = (long)(timeoutMs / 1000);
    timeout.tv_usec = (long)((timeoutMs % 1000) * 1000);
    return select(0, writing ? NULL : &selected, writing ? &selected : NULL, NULL, &timeout);
}

static BOOL send_ws_all(NET_WS *ws, const BYTE *data, DWORD length, DWORD started, DWORD timeoutMs) {
    DWORD sent = 0;
    while (sent < length) {
        int count;
        DWORD elapsed = GetTickCount() - started;
        if (timeoutMs && elapsed >= timeoutMs) return FALSE;
        count = send(ws->socket, (const char *)data + sent, (int)(length - sent), 0);
        if (count > 0) { sent += (DWORD)count; continue; }
        if (count != SOCKET_ERROR || WSAGetLastError() != WSAEWOULDBLOCK) return FALSE;
        elapsed = GetTickCount() - started;
        if (!timeoutMs || elapsed >= timeoutMs || socket_ready(ws->socket, TRUE, timeoutMs - elapsed) <= 0) return FALSE;
    }
    return TRUE;
}

static BOOL send_frame_timeout(NET_WS *ws, BYTE opcode, const BYTE *data, DWORD length, DWORD timeoutMs) {
    BYTE header[14], mask[4];
    BYTE *masked;
    DWORD headLength, i, started = GetTickCount();
    BOOL okay;
    if (length > BODY_LIMIT || ws->failed || !CryptGenRandom(ws->crypto, 4, mask)) return FALSE;
    header[0] = (BYTE)(0x80 | opcode);
    if (length < 126) { header[1] = (BYTE)(0x80 | length); headLength = 2; }
    else if (length <= 65535) {
        header[1] = 0xfe; header[2] = (BYTE)(length >> 8); header[3] = (BYTE)length; headLength = 4;
    } else {
        header[1] = 0xff;
        header[2] = header[3] = header[4] = header[5] = 0;
        header[6] = (BYTE)(length >> 24); header[7] = (BYTE)(length >> 16);
        header[8] = (BYTE)(length >> 8); header[9] = (BYTE)length; headLength = 10;
    }
    for (i = 0; i < 4; i++) header[headLength + i] = mask[i];
    headLength += 4;
    masked = (BYTE *)HeapAlloc(GetProcessHeap(), 0, length ? length : 1);
    if (!masked) return FALSE;
    for (i = 0; i < length; i++) masked[i] = data[i] ^ mask[i & 3];
    okay = send_ws_all(ws, header, headLength, started, timeoutMs) && send_ws_all(ws, masked, length, started, timeoutMs);
    net_free(masked);
    if (!okay) ws->failed = TRUE;
    return okay;
}

static BOOL send_frame(NET_WS *ws, BYTE opcode, const BYTE *data, DWORD length) {
    return send_frame_timeout(ws, opcode, data, length, 2000);
}

BOOL net_ws_send_text(NET_WS *ws, const char *text, DWORD length,
                      WCHAR *error, DWORD errorCap) {
    if (!ws || !text || !send_frame(ws, 1, (const BYTE *)text, length)) {
        set_error(error, errorCap, L"WebSocket text send failed."); return FALSE;
    }
    return TRUE;
}

int net_ws_read_timeout(NET_WS *ws, char **text, DWORD *length, DWORD timeoutMs,
                        WCHAR *error, DWORD errorCap) {
    DWORD started = GetTickCount(), steps = 0;
    if (text) *text = NULL;
    if (length) *length = 0;
    if (!ws || !text || !length || ws->failed) { set_error(error, errorCap, L"WebSocket is closed."); return -1; }
    for (;;) {
        DWORD headLength = 2, payload = 0, frameLength = 0;
        BYTE opcode = 0, final = 0;
        BOOL complete = FALSE;
        DWORD elapsed = GetTickCount() - started;
        /* A busy control stream must yield to other targets even in polling mode. */
        if ((!timeoutMs && steps++ >= 64) || (timeoutMs && elapsed >= timeoutMs)) return 0;
        if (ws->rxLength >= 2) {
            final = ws->rx[0] & 0x80; opcode = ws->rx[0] & 15;
            if ((ws->rx[0] & 0x70) || (ws->rx[1] & 0x80)) goto protocol_error;
            payload = ws->rx[1] & 127;
            if (payload == 126) {
                headLength = 4;
                if (ws->rxLength >= 4) {
                    payload = ((DWORD)ws->rx[2] << 8) | ws->rx[3];
                    if (payload < 126) goto protocol_error;
                }
            } else if (payload == 127) {
                headLength = 10;
                if (ws->rxLength >= 10) {
                    if (ws->rx[2] || ws->rx[3] || ws->rx[4] || ws->rx[5]) goto protocol_error;
                    payload = ((DWORD)ws->rx[6] << 24) | ((DWORD)ws->rx[7] << 16) | ((DWORD)ws->rx[8] << 8) | ws->rx[9];
                    if (payload < 65536) goto protocol_error;
                }
            }
            if (ws->rxLength >= headLength) {
                if (payload > BODY_LIMIT) goto protocol_error;
                frameLength = headLength + payload;
                complete = ws->rxLength >= frameLength;
                if (opcode >= 8 && (!final || payload > 125)) goto protocol_error;
            }
        }
        if (complete) {
            BYTE *data = ws->rx + headLength;
            if (opcode == 8) {
                if (payload == 1) goto protocol_error;
                send_frame_timeout(ws, 8, data, payload, timeoutMs ? timeoutMs - elapsed : 0);
                ws->failed = TRUE;
                set_error(error, errorCap, L"WebSocket peer closed the connection."); return -1;
            } else if (opcode == 9) {
                if (!send_frame_timeout(ws, 10, data, payload, timeoutMs ? timeoutMs - elapsed : 0)) { set_error(error, errorCap, L"WebSocket pong send failed."); return -1; }
            } else if (opcode == 10) {
                /* Unsolicited pongs are legal and do not affect message assembly. */
            } else if (opcode == 1 || opcode == 0) {
                if ((opcode == 1 && ws->fragmented) || (opcode == 0 && !ws->fragmented)) goto protocol_error;
                if (payload > BODY_LIMIT - ws->messageLength) goto protocol_error;
                copy_bytes(ws->message + ws->messageLength, data, payload);
                ws->messageLength += payload;
                ws->fragmented = !final;
                if (final) {
                    if (ws->messageLength && !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                        (const char *)ws->message, (int)ws->messageLength, NULL, 0)) goto protocol_error;
                    *text = (char *)HeapAlloc(GetProcessHeap(), 0, ws->messageLength + 1);
                    if (!*text) { set_error(error, errorCap, L"Out of memory."); ws->failed = TRUE; return -1; }
                    copy_bytes(*text, ws->message, ws->messageLength);
                    (*text)[ws->messageLength] = 0; *length = ws->messageLength; ws->messageLength = 0;
                    ws->rxLength -= frameLength;
                    copy_bytes(ws->rx, ws->rx + frameLength, ws->rxLength);
                    return 1;
                }
            } else goto protocol_error;
            ws->rxLength -= frameLength;
            copy_bytes(ws->rx, ws->rx + frameLength, ws->rxLength);
            continue;
        }
        if (ws->rxLength >= RX_LIMIT) goto protocol_error;
        {
            int count, ready;
            elapsed = GetTickCount() - started;
            if (timeoutMs && elapsed >= timeoutMs) return 0;
            ready = socket_ready(ws->socket, FALSE, timeoutMs ? timeoutMs - elapsed : 0);
            if (!ready) return 0;
            if (ready < 0) { set_error(error, errorCap, L"WebSocket read readiness failed."); ws->failed = TRUE; return -1; }
            count = recv(ws->socket, (char *)ws->rx + ws->rxLength, (int)(RX_LIMIT - ws->rxLength), 0);
            if (count == SOCKET_ERROR) {
                int code = WSAGetLastError();
                if (code == WSAETIMEDOUT || code == WSAEWOULDBLOCK) return 0;
                set_error(error, errorCap, L"WebSocket receive failed."); ws->failed = TRUE; return -1;
            }
            if (!count) { set_error(error, errorCap, L"WebSocket connection ended."); ws->failed = TRUE; return -1; }
            ws->rxLength += (DWORD)count;
        }
    }
protocol_error:
    ws->failed = TRUE;
    set_error(error, errorCap, L"Rejected invalid or oversized WebSocket frame.");
    return -1;
}

int net_ws_read(NET_WS *ws, char **text, DWORD *length,
                WCHAR *error, DWORD errorCap) {
    return net_ws_read_timeout(ws, text, length, 2000, error, errorCap);
}

void net_ws_close(NET_WS *ws) {
    if (!ws) return;
    if (ws->socket != INVALID_SOCKET) {
        shutdown(ws->socket, SD_BOTH);
        closesocket(ws->socket);
    }
    if (ws->crypto) CryptReleaseContext(ws->crypto, 0);
    net_free(ws->rx); net_free(ws->message); net_free(ws);
}


