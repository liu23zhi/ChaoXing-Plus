#ifndef CX_NATIVE_SELECTION_H
#define CX_NATIVE_SELECTION_H

#include "discovery.h"

typedef enum CX_SELECTION_STATUS {
    CX_SELECTION_ERROR = -1,
    CX_SELECTION_CANCELLED = 0,
    CX_SELECTION_SELECTED = 1,
    CX_SELECTION_SCAN_ALL = 2
} CX_SELECTION_STATUS;

typedef struct CX_SELECTION_PROBE {
    DWORD itemCount;
    LONG selectedIndex;
    BOOL browseAvailable;
    BOOL scanAllAvailable;
    BOOL unicodeWindow;
    BOOL titleMatches;
    BOOL noticeShown;
    DWORD layoutScale;
} CX_SELECTION_PROBE;

/* `notice` is an optional first-line message (for example "全盘扫描已取消");
   NULL shows the default heading. */
CX_SELECTION_STATUS cx_select_client(const CX_DISCOVERY_RESULT *candidates,
                                     BOOL hostIs32Bit,
                                     const WCHAR *notice,
                                     WCHAR *out, DWORD outCap,
                                     WCHAR *error, DWORD errorCap);

/* Creates the same controls without showing a window or opening a file dialog. */
BOOL cx_selection_probe(const CX_DISCOVERY_RESULT *candidates,
                         BOOL hostIs32Bit,
                         const WCHAR *notice,
                         CX_SELECTION_PROBE *probe,
                         WCHAR *error, DWORD errorCap);

/* Full-scan progress window. It runs on its own thread so the host can keep
   recursing on the scan thread while the window shows directory/candidate
   counters and reports a user cancellation through the discovery hooks.
   The window class name is stable for automation probes. */
#define CX_SCAN_PROGRESS_CLASS L"CXPlusNativeScanProgress"
#define CX_SCAN_PROGRESS_CANCEL_ID 1201
typedef struct CX_SCAN_PROGRESS CX_SCAN_PROGRESS;

BOOL cx_scan_progress_begin(CX_SCAN_PROGRESS **progress, WCHAR *error, DWORD errorCap);
void cx_scan_progress_bind(CX_DISCOVERY_OPTIONS *scan, CX_SCAN_PROGRESS *progress);
/* Closes the progress window and joins its thread. TRUE means the user
   cancelled the scan (button, window close or test auto-cancel timer). */
BOOL cx_scan_progress_end(CX_SCAN_PROGRESS *progress, WCHAR *error, DWORD errorCap);

#endif
