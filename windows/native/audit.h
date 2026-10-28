#ifndef CX_NATIVE_AUDIT_H
#define CX_NATIVE_AUDIT_H

#include "options.h"

typedef struct CX_AUDIT CX_AUDIT;

typedef enum CX_ENDPOINT_REASON {
    CX_ENDPOINT_NOT_STARTED,
    CX_ENDPOINT_NO_LISTENER,
    CX_ENDPOINT_LISTENER_NOT_OWNED,
    CX_ENDPOINT_LISTENER_QUERY_FAILED,
    CX_ENDPOINT_LISTENER_BINDING_REJECTED,
    CX_ENDPOINT_HTTP_FAILED,
    CX_ENDPOINT_INVALID_VERSION,
    CX_ENDPOINT_BROWSER_MISMATCH,
    CX_ENDPOINT_READY,
    CX_ENDPOINT_REASON_COUNT
} CX_ENDPOINT_REASON;

typedef struct CX_ENDPOINT_PROBE {
    DWORD attempts;
    DWORD elapsedMs;
    DWORD reasonCounts[CX_ENDPOINT_REASON_COUNT];
    BOOL listenerSeen;
    BOOL ownershipVerified;
    BOOL versionResponseReceived;
    CX_ENDPOINT_REASON lastReason;
} CX_ENDPOINT_PROBE;

typedef struct CX_AUDIT_REPORT {
    DWORD durationMs;
    DWORD clientPid;
    DWORD port;
    DWORD contexts;
    DWORD bootstraps;
    DWORD bundles;
    DWORD errors;
    DWORD reconnects;
    DWORD pageSessions;
    BOOL attached;
    BOOL ownershipVerified;
    BOOL success;
    const char *injectStrategy;
    const char *stopReason;
    CX_ENDPOINT_PROBE endpointProbe;
} CX_AUDIT_REPORT;

/* Maps only an enum to fixed text; never serializes remote or user text. */
const char *cx_endpoint_reason_name(CX_ENDPOINT_REASON reason);

/* Only pass fixed, redacted events. Configuration, answers, tokens and URL
   queries must never be passed to the audit module. Strings are UTF-8.
   A non-NULL create result may carry a nonfatal file error. Log write errors
   disable that file permanently; the caller should warn and continue.
   Paths resolve from the process working directory at create time.
   quiet controls console output only; noDiskWrite disables all file output. */
CX_AUDIT *cx_audit_create(const CX_OPTIONS *options, WCHAR *error, DWORD errorCap);
BOOL cx_audit_log(CX_AUDIT *audit, const char *level, const char *event,
                  const char *message, WCHAR *error, DWORD errorCap);
BOOL cx_audit_write_report(CX_AUDIT *audit, const CX_AUDIT_REPORT *report,
                           WCHAR *error, DWORD errorCap);
void cx_audit_close(CX_AUDIT *audit);
/* Empty when file logging was disabled or the log could not be created. */
const WCHAR *cx_audit_log_path(const CX_AUDIT *audit);

#endif
