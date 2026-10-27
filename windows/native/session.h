#ifndef CX_NATIVE_SESSION_H
#define CX_NATIVE_SESSION_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#define CX_SESSION_MAX_CONTEXTS 256
#define CX_SESSION_MAX_FRAMES 512
#define CX_SESSION_URL_CAP 2048

typedef struct CX_SESSION CX_SESSION;

typedef enum CX_SESSION_TASK_TYPE {
    CX_SESSION_TASK_BOOTSTRAP = 1,
    CX_SESSION_TASK_BUNDLE = 2
} CX_SESSION_TASK_TYPE;

typedef struct CX_SESSION_TASK {
    CX_SESSION_TASK_TYPE type;
    int contextId; /* Zero is the top document fallback when CDP omitted contexts. */
    DWORD generation;
    DWORD token;
    BOOL top;
    BOOL ensure;
} CX_SESSION_TASK;

typedef struct CX_SESSION_STATS {
    DWORD contexts;
    DWORD bootstraps;
    DWORD bundles;
    DWORD errors;
    BOOL closed;
} CX_SESSION_STATS;

CX_SESSION *cx_session_create(const char *targetUrl, BOOL injectBlankFrames, BOOL extensionEnabled);
void cx_session_close(CX_SESSION *session);
void cx_session_free(CX_SESSION *session);
const CX_SESSION_STATS *cx_session_stats(const CX_SESSION *session);

/* These functions only update state. They never call a transport or inject code. */
BOOL cx_session_feed(CX_SESSION *session, const char *json, DWORD length);
BOOL cx_session_frame_tree(CX_SESSION *session, const char *json, DWORD length);
void cx_session_request_top_ensure(CX_SESSION *session);

/* next marks a task in flight; complete rejects stale/destroyed context tokens. */
BOOL cx_session_next(CX_SESSION *session, CX_SESSION_TASK *task);
BOOL cx_session_task_active(const CX_SESSION *session, const CX_SESSION_TASK *task);
BOOL cx_session_complete(CX_SESSION *session, const CX_SESSION_TASK *task, BOOL success);

#endif
