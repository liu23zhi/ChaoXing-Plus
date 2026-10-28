#ifndef CX_NATIVE_ELEVATION_H
#define CX_NATIVE_ELEVATION_H

#include <windows.h>

BOOL cx_elevation_query(BOOL *elevated);
BOOL cx_elevation_can_restart(DWORD launchError, BOOL noElevate, BOOL restarted);
BOOL cx_elevation_parameters(int argc, WCHAR *const *argv, const WCHAR *client,
                             WCHAR *out, DWORD capacity);
BOOL cx_elevation_restart(const WCHAR *executable, int argc, WCHAR *const *argv,
                          const WCHAR *client, DWORD *exitCode,
                          WCHAR *error, DWORD errorCap);

#endif
