#ifndef CX_NATIVE_DPI_H
#define CX_NATIVE_DPI_H

#include <windows.h>

typedef struct CX_DPI_OVERRIDE CX_DPI_OVERRIDE;
CX_DPI_OVERRIDE *cx_dpi_begin(const WCHAR *client, WCHAR *error, DWORD errorCap);
/* Consumes the snapshot and releases all handles, even when restoration fails. */
BOOL cx_dpi_restore(CX_DPI_OVERRIDE *state, WCHAR *error, DWORD errorCap);

#endif
