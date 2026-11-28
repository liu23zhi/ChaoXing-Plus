#ifndef CX_NATIVE_CONFIG_STORE_H
#define CX_NATIVE_CONFIG_STORE_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#define CX_CONFIG_JSON_CAP 65536

/* Inputs are complete UTF-8 objects and must not overlap output. On failure,
   output and its length remain unchanged. Lengths exclude the trailing NUL. */
BOOL cx_config_merge_settings(const char *base, DWORD baseLen,
    const char *patch, DWORD patchLen, char *out, DWORD outCap,
    DWORD *outLen, WCHAR *error, DWORD errorCap);
BOOL cx_config_select_settings(const char *values, DWORD valuesLen,
    const char *mask, DWORD maskLen, char *out, DWORD outCap,
    DWORD *outLen, WCHAR *error, DWORD errorCap);
BOOL cx_config_patch_file(const WCHAR *path, const char *settings,
    DWORD settingsLen, WCHAR *error, DWORD errorCap);
/* T07 only: atomically update private root recovery metadata and optional
   canonical settings in an envelope. Never sync the pending state to the
   settings object; preserve existing root and settings values. */
BOOL cx_config_patch_device_admission_file(const WCHAR *path, const char *envelope,
    DWORD envelopeLen, WCHAR *error, DWORD errorCap);

#endif
