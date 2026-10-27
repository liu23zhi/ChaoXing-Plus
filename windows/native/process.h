#ifndef CXPROBE_PROCESS_H
#define CXPROBE_PROCESS_H

#include <windows.h>

BOOL proc_launch(const WCHAR *path, USHORT port, DWORD *pid, HANDLE *handle,
                 WCHAR *err, DWORD cap);
BOOL proc_port_owner(USHORT port, DWORD rootPid, DWORD *owner,
                     WCHAR *err, DWORD cap);
BOOL proc_port_free(USHORT port);
/* Verifies that 127.0.0.1:port can actually be bound right now. Windows may
   reject otherwise-free ports that fall inside an excluded/reserved range
   (bind fails with WSAEACCES); CEF's devtools server would fail the same way. */
BOOL proc_port_bindable(USHORT port, WCHAR *err, DWORD cap);
/* Counts running processes whose executable file name matches the target.
   Used to refuse testing while another CXExam.exe instance is running. */
int proc_instances(const WCHAR *exePath, DWORD *pids, int cap);
DWORD proc_stop_owned(DWORD rootPid);
BOOL proc_pe(const WCHAR *path, WORD *machine, WORD *subsystemMajor,
             WORD *subsystemMinor, WCHAR *version, DWORD cap);
BOOL proc_alive(DWORD pid);

#endif


