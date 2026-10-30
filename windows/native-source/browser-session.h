#ifndef CX_BROWSER_SESSION_H
#define CX_BROWSER_SESSION_H

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

typedef struct CX_BROWSER_SESSION CX_BROWSER_SESSION;
typedef struct CX_BROWSER_OPTIONS {
    const WCHAR *browserPath;
    const WCHAR *crxPath;
    /* Downloaded package bytes take priority over the test/import file path. */
    const BYTE *crxData;
    DWORD crxSize;
    /* Defaults to the currently published helper. Explicitly select a future
       store identity rather than trusting a newly downloaded signed package. */
    const WCHAR *expectedExtensionId;
    const WCHAR *initialUrl;
    /* UTF-8 JSON object; only common.settings.* / cx.new.* shared keys. */
    const char *settingsJsonUTF8;
    /* Test-only headless mode. Normal sessions always show the browser. */
    BOOL headless;
} CX_BROWSER_OPTIONS;

BOOL cx_browser_start(const CX_BROWSER_OPTIONS *options, CX_BROWSER_SESSION **session,
                       WCHAR *error, DWORD errorCapacity);
/* Poll removes the temporary directory once the owned browser job has exited.
   running is FALSE only when all owned browser processes have finished. */
BOOL cx_browser_poll(CX_BROWSER_SESSION *session, BOOL *running,
                     WCHAR *error, DWORD errorCapacity);
BOOL cx_browser_close(CX_BROWSER_SESSION *session, WCHAR *error, DWORD errorCapacity);
void cx_browser_destroy(CX_BROWSER_SESSION *session);
DWORD cx_browser_pid(const CX_BROWSER_SESSION *session);
const WCHAR *cx_browser_profile(const CX_BROWSER_SESSION *session);
const WCHAR *cx_browser_extension_id(const CX_BROWSER_SESSION *session);
/* Owned UTF-8 CDP response; release with HeapFree(GetProcessHeap(), 0, json). */
BOOL cx_browser_read_settings(CX_BROWSER_SESSION *session, char **json,
                              WCHAR *error, DWORD errorCapacity);

#endif
