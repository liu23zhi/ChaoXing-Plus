#ifndef CX_NATIVE_ASSETS_H
#define CX_NATIVE_ASSETS_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#define CX_ASSET_MAX_BYTES (8UL * 1024UL * 1024UL)

DWORD cx_asset_count(void);
const WCHAR *cx_asset_name(DWORD index);

/* Returned data is NUL-terminated and owned by the caller (HeapFree).
   A nonempty override directory never falls back to embedded resources. */
BOOL cx_asset_load(const WCHAR *name, const WCHAR *overrideDir,
                   char **data, DWORD *length, WCHAR *error, DWORD errorCap);
BOOL cx_asset_validate_embedded(WCHAR *error, DWORD errorCap);

/* 内嵌的 dll-proxy 代理 DLL（发布包只有单个 EXE，代理不再随包外置）。
   这些资源不进 cx_asset_count()：注入资源仍固定四项，代理按需单独释放。 */
DWORD cx_asset_proxy_count(void);
const WCHAR *cx_asset_proxy_name(DWORD index);
BOOL cx_asset_proxy_exists(const WCHAR *dllName);
BOOL cx_asset_load_proxy(const WCHAR *dllName, char **data, DWORD *length,
                         WCHAR *error, DWORD errorCap);

#endif
