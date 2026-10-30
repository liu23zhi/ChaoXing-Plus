#ifndef CX_NATIVE_ASSETS_H
#define CX_NATIVE_ASSETS_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#define CX_ASSET_MAX_BYTES (8UL * 1024UL * 1024UL)

DWORD cx_asset_count(void);
const WCHAR *cx_asset_name(DWORD index);
BOOL cx_asset_resources_embedded(void);

/* Returned data is NUL-terminated and owned by the caller (HeapFree).
   A nonempty override directory never falls back to default resources.
   Multi-file defaults are resolved from the executable directory and cached
   together with the proxy for the process lifetime on their first validation/load. */
BOOL cx_asset_load(const WCHAR *name, const WCHAR *overrideDir,
                   char **data, DWORD *length, WCHAR *error, DWORD errorCap);
BOOL cx_asset_validate_embedded(WCHAR *error, DWORD errorCap);

/* Proxy resources are separate from the four injection assets. The single-file
   build embeds them; the multi-file build uses the cached winmm-proxy.dll sidecar.
   Returned proxy buffers are also owned by the caller (HeapFree). */
DWORD cx_asset_proxy_count(void);
const WCHAR *cx_asset_proxy_name(DWORD index);
BOOL cx_asset_proxy_exists(const WCHAR *dllName);
BOOL cx_asset_load_proxy(const WCHAR *dllName, char **data, DWORD *length,
                         WCHAR *error, DWORD errorCap);

#endif
