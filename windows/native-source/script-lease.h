#ifndef CX_NATIVE_SCRIPT_LEASE_H
#define CX_NATIVE_SCRIPT_LEASE_H
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

/* Every credential is process memory only. Stop joins the bounded HTTP worker
   before clearing memory; the activation deadline is never renewed. */
BOOL cx_script_identity(WCHAR *out, DWORD cap);
BOOL cx_script_lease_start(const WCHAR *origin, const WCHAR *heartbeatUrl,
    const WCHAR *token, const WCHAR *identity, const WCHAR *expiresAt,
    WCHAR *error, DWORD errorCap);
BOOL cx_script_lease_valid(void);
BOOL cx_script_lease_active(void);
void cx_script_lease_cancel(void);
void cx_script_lease_stop(void);
#endif
