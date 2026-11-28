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
   input). FALSE retries prior work; browser and version may then be NULL.
   TRUE result means one exact receipt was matched and its packet was retired.
   Diagnostics, including local or transport failure, never grant admission.
*/
BOOL cx_ordinary_receipts_pump(const WCHAR *dir, const WCHAR *base, const WCHAR *ordinaryKey,
    const WCHAR *agreementProof, const WCHAR *device, const WCHAR *browser,
    const WCHAR *version, BOOL recordReady);

#endif
