#ifndef CXPROBE_PROCESS_H
#define CXPROBE_PROCESS_H

#include <windows.h>

BOOL proc_launch(const WCHAR *path, USHORT port, DWORD *pid, HANDLE *handle,
                 WCHAR *err, DWORD cap);
typedef enum CX_PORT_OWNER_REASON {
    CX_PORT_OWNER_VERIFIED,
    CX_PORT_OWNER_NO_LISTENER,
    CX_PORT_OWNER_NOT_OWNED,
    CX_PORT_OWNER_QUERY_FAILED,
    CX_PORT_OWNER_BINDING_REJECTED
} CX_PORT_OWNER_REASON;
/* Fixed diagnostic classification; the accepted ownership policy is unchanged. */
BOOL proc_port_owner_ex(USHORT port, DWORD rootPid, DWORD *owner,
                        CX_PORT_OWNER_REASON *reason, WCHAR *err, DWORD cap);
BOOL proc_port_owner(USHORT port, DWORD rootPid, DWORD *owner,
                     WCHAR *err, DWORD cap);
BOOL proc_port_free(USHORT port);
/* Verifies that 127.0.0.1:port can actually be bound right now. Windows may
   reject otherwise-free ports that fall inside an excluded/reserved range
   (bind fails with WSAEACCES); CEF's devtools server would fail the same way. */
BOOL proc_port_bindable(USHORT port, WCHAR *err, DWORD cap);
/* A completed process snapshot is required to establish the count. On failure
   returns FALSE and leaves count at zero; zero alone is never proof of absence. */
BOOL proc_check_instances(const WCHAR *exePath, DWORD *count, WCHAR *err, DWORD cap);
/* Legacy PID-list wrapper: returns -1 on inspection failure. */
int proc_instances(const WCHAR *exePath, DWORD *pids, int cap);
DWORD proc_stop_owned(DWORD rootPid);
BOOL proc_pe(const WCHAR *path, WORD *machine, WORD *subsystemMajor,
             WORD *subsystemMinor, WCHAR *version, DWORD cap);
BOOL proc_alive(DWORD pid);

#endif


