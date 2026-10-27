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
NET_WS *net_ws_open(USHORT port, const char *url, WCHAR *error, DWORD errorCap);
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

#endif


