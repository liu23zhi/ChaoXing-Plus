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
/* Decodes a bounded base64 PNG (Page.captureScreenshot data) after validating
   the PNG signature/IHDR dimensions, then publishes render-diagnostics-page.png
   in the same run directory. Attach and owned launches may both use this. */
BOOL cx_diagnostics_write_page_png(CX_DIAGNOSTICS *diagnostics,
                                   const char *base64, DWORD length,
                                   WCHAR *error, DWORD errorCap);
const WCHAR *cx_diagnostics_page_png_path(const CX_DIAGNOSTICS *diagnostics);

/* Host-level diagnostics summary (render-diagnostics-host.json): records which
   artifacts this run produced plus window DPI diagnosis. Written once after the
   run; failures are nonfatal like the other diagnostics files. */
void cx_diagnostics_record_window(CX_DIAGNOSTICS *diagnostics, DWORD clientPid,
                                  UINT systemDpi, UINT windowDpi, BOOL visible,
                                  const RECT *rect, const char *screenshotStatus);
BOOL cx_diagnostics_write_host_summary(CX_DIAGNOSTICS *diagnostics, BOOL attachMode,
                                       WCHAR *error, DWORD errorCap);
const WCHAR *cx_diagnostics_host_summary_path(const CX_DIAGNOSTICS *diagnostics);
void cx_diagnostics_close(CX_DIAGNOSTICS *diagnostics);
BOOL cx_diagnostics_enabled(const CX_DIAGNOSTICS *diagnostics);
/* Empty when disabled or when the output path could not be prepared. */
const WCHAR *cx_diagnostics_output_path(const CX_DIAGNOSTICS *diagnostics);

/* Window render diagnostics for an owned client launch: window DPI/rect plus a
   best-effort BMP snapshot in the same run directory. Attach mode has no owned
   client, so callers must skip these APIs there. Capture failures are recorded
   in window-diagnostics.json and do not abort the host run. */
BOOL cx_diagnostics_client_window_ready(DWORD clientPid);
BOOL cx_diagnostics_capture_window(CX_DIAGNOSTICS *diagnostics, DWORD clientPid,
                                   WCHAR *error, DWORD errorCap);
const WCHAR *cx_diagnostics_window_json_path(const CX_DIAGNOSTICS *diagnostics);
const WCHAR *cx_diagnostics_window_capture_path(const CX_DIAGNOSTICS *diagnostics);
const WCHAR *cx_diagnostics_window_png_path(const CX_DIAGNOSTICS *diagnostics);

#endif
