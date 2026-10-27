#ifndef CX_NATIVE_AUDIT_H
#define CX_NATIVE_AUDIT_H

#include "options.h"

typedef struct CX_AUDIT CX_AUDIT;

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
} CX_AUDIT_REPORT;

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
