#ifndef CX_NATIVE_DIAGNOSTICS_H
#define CX_NATIVE_DIAGNOSTICS_H

#include "options.h"

typedef struct CX_DIAGNOSTICS CX_DIAGNOSTICS;

/* Writes one bounded page-render diagnostics JSON object for this host run.
   A non-NULL create result may carry a nonfatal path-creation error. If
   diagnostics are disabled or noDiskWrite is set, no directory is created. */
CX_DIAGNOSTICS *cx_diagnostics_create(const CX_OPTIONS *options,
                                      WCHAR *error, DWORD errorCap);
BOOL cx_diagnostics_write_page_json(CX_DIAGNOSTICS *diagnostics,
                                    const char *json, DWORD length,
                                    WCHAR *error, DWORD errorCap);
void cx_diagnostics_close(CX_DIAGNOSTICS *diagnostics);
BOOL cx_diagnostics_enabled(const CX_DIAGNOSTICS *diagnostics);
/* Empty when disabled or when the output path could not be prepared. */
const WCHAR *cx_diagnostics_output_path(const CX_DIAGNOSTICS *diagnostics);

#endif
