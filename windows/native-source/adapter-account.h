#ifndef CX_NATIVE_ADAPTER_ACCOUNT_H
#define CX_NATIVE_ADAPTER_ACCOUNT_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#define CX_ADAPTER_TOKEN_CAP 4096
#define CX_ADAPTER_CAPTCHA_IMAGE_CAP 32768

typedef struct CX_ADAPTER_REPLY {
    DWORD status;
    char *body;
    DWORD length;
} CX_ADAPTER_REPLY;

typedef struct CX_ADAPTER_CAPTCHA {
    WCHAR challengeId[128];
    char imageData[CX_ADAPTER_CAPTCHA_IMAGE_CAP];
    WCHAR expiresAt[64];
} CX_ADAPTER_CAPTCHA;

typedef struct CX_ADAPTER_AUTH_SETTINGS {
    WCHAR captchaProvider[32];
    WCHAR captchaApiBaseUrl[CX_ADAPTER_TOKEN_CAP];
    WCHAR captchaType[64];
} CX_ADAPTER_AUTH_SETTINGS;

typedef struct CX_ADAPTER_ACCOUNT {
    WCHAR jwt[CX_ADAPTER_TOKEN_CAP];
    WCHAR apiKey[CX_ADAPTER_TOKEN_CAP];
    WCHAR username[256];
    int accessTokenId;
} CX_ADAPTER_ACCOUNT;

/* Paths are relative API paths such as L"/public/captcha/challenge".
   baseUrl is the site root (an optional /adapter-service suffix is accepted).
   Authorization is the complete header value: raw JWT or L"Bearer <key>".
   No cookies, implicit Windows authentication, redirects, logging or disk I/O.
   TRUE means HTTP transport completed, including non-2xx status responses.
   The caller owns reply and must call cx_adapter_reply_free, including errors. */
BOOL cx_adapter_request(const WCHAR *baseUrl, const WCHAR *method,
    const WCHAR *path, const WCHAR *authorization, const char *json,
    DWORD timeoutMs, DWORD bodyLimit, CX_ADAPTER_REPLY *reply,
    WCHAR *error, DWORD errorCap);
void cx_adapter_reply_free(CX_ADAPTER_REPLY *reply);
void cx_adapter_account_clear(CX_ADAPTER_ACCOUNT *account);

/* Public auth settings select the only captcha flow the native UI may use.
   Missing or unrecognized providers must not be treated as local. */
BOOL cx_adapter_auth_settings(const WCHAR *baseUrl, CX_ADAPTER_AUTH_SETTINGS *settings,
    WCHAR *error, DWORD errorCap);
/* Local image challenge; callers must first confirm captchaProvider == local. */
BOOL cx_adapter_captcha_begin(const WCHAR *baseUrl, CX_ADAPTER_CAPTCHA *captcha,
    WCHAR *error, DWORD errorCap);
/* The returned bitmap belongs to the caller (DeleteObject). No disk files. */
HBITMAP cx_adapter_captcha_bitmap(const CX_ADAPTER_CAPTCHA *captcha,
    WCHAR *error, DWORD errorCap);
BOOL cx_adapter_captcha_verify(const WCHAR *baseUrl, const WCHAR *challengeId,
    const WCHAR *answer, WCHAR *captchaToken, DWORD tokenCap,
    WCHAR *error, DWORD errorCap);
BOOL cx_adapter_account_login(const WCHAR *baseUrl, const WCHAR *username,
    const WCHAR *password, const WCHAR *captchaToken,
    CX_ADAPTER_ACCOUNT *account, WCHAR *error, DWORD errorCap);

/* Reuses the newest enabled, readable token from the existing account API.
   When there is no token, createIfMissing explicitly permits creating one.
   POST is never retried; a network failure may leave a token server-side. */
BOOL cx_adapter_account_token(const WCHAR *baseUrl, BOOL createIfMissing,
    CX_ADAPTER_ACCOUNT *account, WCHAR *error, DWORD errorCap);
BOOL cx_adapter_key_check(const WCHAR *baseUrl, const WCHAR *apiKey,
    WCHAR *error, DWORD errorCap);

/* Downloads the same-origin package advertised by /extensions/{source}/latest.
   Validates advertised size and SHA-256 before handing data to the CRX loader.
   This public request never includes the account JWT or API key. */
BOOL cx_adapter_extension_fetch(const WCHAR *baseUrl, const WCHAR *source,
    BYTE **data, DWORD *size, WCHAR *version, DWORD versionCap,
    WCHAR *error, DWORD errorCap);

/*
   Fetches a verified extension package and optionally reuses a local cache.
   cacheDir is a host-owned directory; no files are read or written when
   noDiskWrite is TRUE. forceRefresh bypasses a valid cache and replaces it
   with the newly verified online package. Cache failures are treated as
   misses/write diagnostics: a verified online package is still returned.
   The consumer must still verify the CRX signature and expected extension ID,
   including cache hits; on failure it may retry once with forceRefresh.
*/
BOOL cx_adapter_extension_fetch_cached(const WCHAR *baseUrl, const WCHAR *source,
    const WCHAR *cacheDir, BOOL noDiskWrite, BOOL forceRefresh,
    BYTE **data, DWORD *size, WCHAR *version, DWORD versionCap,
    WCHAR *error, DWORD errorCap);

#endif
