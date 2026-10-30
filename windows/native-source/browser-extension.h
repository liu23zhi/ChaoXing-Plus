#ifndef CX_BROWSER_EXTENSION_H
#define CX_BROWSER_EXTENSION_H

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

/* Validates the complete package in memory without creating files. */
BOOL cx_browser_extension_verify(const BYTE *data, DWORD size,
                                 const WCHAR *expectedExtensionId,
                                 WCHAR *error, DWORD errorCapacity);

/* Extracts a signed CRX3 into a newly created, private session directory.
   The caller owns that directory. Archive paths, CRCs, sizes and the CRX
   developer signature are checked before any browser loads the result. */
BOOL cx_browser_extension_extract(const BYTE *data, DWORD size, const WCHAR *directory,
                                  WCHAR *extensionId, DWORD idCapacity,
                                  WCHAR *error, DWORD errorCapacity);
BOOL cx_browser_extension_extract_file(const WCHAR *file, const WCHAR *directory,
                                       WCHAR *extensionId, DWORD idCapacity,
                                       WCHAR *error, DWORD errorCapacity);

#endif
