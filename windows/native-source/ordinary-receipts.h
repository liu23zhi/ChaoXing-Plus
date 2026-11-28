#ifndef CX_NATIVE_ORDINARY_RECEIPTS_H
#define CX_NATIVE_ORDINARY_RECEIPTS_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

/*
   Worker-thread only; run after the host has verified ordinary admission.
   dir is the existing host-only, application-owned data directory. base is
   the verified HTTPS service; ordinaryKey is bare, agreementProof is private.
   Call with TRUE once per successful owned browser launch (never from web
   input). version is the actual extension manifest version, not the agreement.
   FALSE retries prior work; browser and version may then be NULL.
   TRUE result means one exact receipt was matched and its packet was retired.
   Diagnostics, including local or transport failure, never grant admission.
*/
BOOL cx_ordinary_receipts_pump(const WCHAR *dir, const WCHAR *base, const WCHAR *ordinaryKey,
    const WCHAR *agreementProof, const WCHAR *device, const WCHAR *browser,
    const WCHAR *version, BOOL recordReady);

/* Same contract as pump. keep is optional, fast and non-reentrant: it is
   checked with the outbox locked. FALSE cancels and purges local work, but
   cannot recall an already-dispatched request. Manual opt-out always applies. */
BOOL cx_ordinary_receipts_pump_guarded(const WCHAR *dir, const WCHAR *base, const WCHAR *ordinaryKey,
    const WCHAR *agreementProof, const WCHAR *device, const WCHAR *browser,
    const WCHAR *version, BOOL recordReady, BOOL (*keep)(void *), void *context);

/* Host-only directory; missing opt-out means enabled, read errors mean off.
   Disabling atomically publishes opt-out without waiting for the network.
   Re-enabling first purges pending work and returns FALSE if the queue is busy
   or cannot be purged; in that case the persisted opt-out remains in force. */
BOOL cx_ordinary_receipts_local_enabled(const WCHAR *dir);
BOOL cx_ordinary_receipts_set_local_enabled(const WCHAR *dir, BOOL enabled);

/* Worker-thread only. Drop this directory's pending diagnostics after an
   explicit denial or unbinding, with no HTTP request or new disk state. */
BOOL cx_ordinary_receipts_discard(const WCHAR *dir);

#endif
