#ifndef CXPROBE_NET_H
#define CXPROBE_NET_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <windows.h>

typedef struct NET_WS NET_WS;

/* Initialize Winsock once before using these functions. */
BOOL net_http_get(USHORT port, const char *path, char **body, DWORD *length,
                  WCHAR *error, DWORD errorCap);
/* timeoutMs bounds connect, send and receive together; zero fails without I/O. */
BOOL net_http_get_timeout(USHORT port, const char *path, char **body, DWORD *length,
                          DWORD timeoutMs, WCHAR *error, DWORD errorCap);
NET_WS *net_ws_open(USHORT port, const char *url, WCHAR *error, DWORD errorCap);
/* One total budget includes connect, upgrade send, receive and validation; zero does no I/O. */
NET_WS *net_ws_open_timeout(USHORT port, const char *url, DWORD timeoutMs,
                            WCHAR *error, DWORD errorCap);
BOOL net_ws_send_text(NET_WS *ws, const char *text, DWORD length,
                      WCHAR *error, DWORD errorCap);
/* 1: complete text message, 0: timeout, -1: closed or failed. */
int net_ws_read(NET_WS *ws, char **text, DWORD *length,
                WCHAR *error, DWORD errorCap);
/* timeoutMs is a total budget. Zero polls without waiting and preserves partial frames. */
int net_ws_read_timeout(NET_WS *ws, char **text, DWORD *length, DWORD timeoutMs,
                        WCHAR *error, DWORD errorCap);
void net_ws_close(NET_WS *ws);
void net_free(void *memory);

/* 匿名管道上的 CDP 帧发送（4 字节小端长度 + 正文）。 */
BOOL net_pipe_send_frame(HANDLE writeHandle, const char *payload, DWORD length);
/* 1: 完整帧, 0: 超时, -1: 错误。payload 由调用方用 net_free 释放。 */
int net_pipe_recv_frame(HANDLE readHandle, char **payload, DWORD *length, DWORD timeoutMs);

/* Chromium --remote-debugging-pipe 帧：4 字节小端长度 + JSON 正文。 */
#define CX_PIPE_MAX_FRAME (64u * 1024u * 1024u)
BOOL net_pipe_frame_encode(const char *payload, DWORD length, char *out, DWORD cap, DWORD *written);
/* 1 完整帧；0 数据不足；-1 非法（超长或参数错误）。 */
int net_pipe_frame_parse(const char *buffer, DWORD available,
                         DWORD *payloadOffset, DWORD *payloadLength, DWORD *frameLength);

#endif





