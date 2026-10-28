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
} CX_SELECTION_PROBE;

CX_SELECTION_STATUS cx_select_client(const CX_DISCOVERY_RESULT *candidates,
                                     BOOL hostIs32Bit,
                                     WCHAR *out, DWORD outCap,
                                     WCHAR *error, DWORD errorCap);

/* Creates the same controls without showing a window or opening a file dialog. */
BOOL cx_selection_probe(const CX_DISCOVERY_RESULT *candidates,
                         CX_SELECTION_PROBE *probe,
                         WCHAR *error, DWORD errorCap);

#endif
