#ifndef CX_ORDINARY_CHANNEL_H
#define CX_ORDINARY_CHANNEL_H
#include <windows.h>

typedef struct CX_ORDINARY_CHANNEL CX_ORDINARY_CHANNEL;
/* Called on the channel worker: no synchronous UI calls, and bound any network I/O.
 * The context remains live until close returns. The callback sends no data to the browser. */
typedef BOOL (*CX_ORDINARY_RESULT)(void *context);

/* One app-owned Chrome/Edge instance, exact extension ID, canonical lowercase UUID. */
BOOL cx_ordinary_channel_open(const WCHAR *instance, const WCHAR *extensionId, const WCHAR *browserKind,
                              CX_ORDINARY_RESULT verify, void *context, CX_ORDINARY_CHANNEL **out);
const WCHAR *cx_ordinary_channel_name(const CX_ORDINARY_CHANNEL *channel);
/* One immutable binding. Close the channel before disposing of the browser session. */
BOOL cx_ordinary_channel_attach_job(CX_ORDINARY_CHANNEL *channel, HANDLE ownedBrowserJob);
void cx_ordinary_channel_close(CX_ORDINARY_CHANNEL *channel);

/* TRUE means this was a native-messaging invocation; do not enter the ordinary UI. */
BOOL cx_ordinary_channel_broker(int *exitCode);
#endif
