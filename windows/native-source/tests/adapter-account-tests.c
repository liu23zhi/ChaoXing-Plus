#include "adapter-account.h"

static void out(const char *value) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), value, (DWORD)lstrlenA(value), &written, NULL);
}
static void check(BOOL condition, const char *message) {
    if (condition) { out("PASS "); out(message); out("\r\n"); return; }
    out("FAIL "); out(message); out("\r\n"); ExitProcess(1);
}
void WinMainCRTStartup(void) {
    static WCHAR base[2048], scenario[64], error[512], captchaToken[4096], version[128];
    static CX_ADAPTER_CAPTCHA captcha; static CX_ADAPTER_ACCOUNT account; HBITMAP bitmap; BITMAP dimensions;
    BYTE *package = NULL; DWORD size = 0; BOOL ok;
    check(GetEnvironmentVariableW(L"CX_ADAPTER_TEST_BASE", base, 2048) > 0, "mock base configured");
    GetEnvironmentVariableW(L"CX_ADAPTER_TEST_SCENARIO", scenario, 64);
    if (!lstrcmpW(scenario, L"account")) {
        static CX_ADAPTER_AUTH_SETTINGS settings;
        check(cx_adapter_auth_settings(base, &settings, error, 512), "public captcha settings request");
        check(!lstrcmpW(settings.captchaProvider, L"local"), "local captcha provider parsed");
        check(cx_adapter_captcha_begin(base, &captcha, error, 512), "captcha challenge request");
        check(!lstrcmpW(captcha.challengeId, L"challenge-1"), "captcha challenge parsed");
        bitmap = cx_adapter_captcha_bitmap(&captcha, error, 512);
        check(bitmap != NULL, "PNG decoded by system WIC");
        check(GetObjectW(bitmap, sizeof(dimensions), &dimensions) == sizeof(dimensions) && dimensions.bmWidth == 2 && dimensions.bmHeight == 2, "PNG dimensions preserved");
        DeleteObject(bitmap);
        check(!cx_adapter_captcha_verify(base, captcha.challengeId, L"wrong", captchaToken, 4096, error, 512), "incorrect captcha rejected");
        check(!lstrcmpW(error, L"incorrect captcha"), "captcha failure preserves the server message");
        error[0] = 0;
        check(cx_adapter_captcha_verify(base, captcha.challengeId, L"a7b9", captchaToken, 4096, error, 512), "captcha answer verified");
        check(!lstrcmpW(captchaToken, L"captcha-one-shot"), "captcha token parsed");
        check(!cx_adapter_account_login(base, L"mock-user", L"wrong", captchaToken, &account, error, 512), "incorrect password rejected");
        check(!lstrcmpW(error, L"incorrect password"), "login failure preserves the server message");
        check(!account.jwt[0] && !account.apiKey[0], "failed login clears credentials");
        error[0] = 0;
        check(cx_adapter_account_login(base, L"mock-user", L"p\"ass\\word", captchaToken, &account, error, 512), "login JSON quotes and password preserved");
        check(!lstrcmpW(account.jwt, L"mock-jwt"), "login JWT parsed");
        check(cx_adapter_account_token(base, FALSE, &account, error, 512), "existing enabled token selected");
        check(!lstrcmpW(account.apiKey, L"tk_mock-existing") && account.accessTokenId == 7, "token value and id preserved");
        check(cx_adapter_key_check(base, account.apiKey, error, 512), "Bearer API key validated");
        check(!cx_adapter_key_check(base, L"invalid", error, 512), "invalid API key rejected");
        cx_adapter_account_clear(&account);
        check(!account.jwt[0] && !account.apiKey[0], "credentials explicitly cleared");
    } else if (!lstrcmpW(scenario, L"create")) {
        cx_adapter_account_clear(&account); lstrcpyW(account.jwt, L"mock-jwt");
        check(cx_adapter_account_token(base, TRUE, &account, error, 512), "missing access token created");
        check(!lstrcmpW(account.apiKey, L"tk_mock-created"), "created token response parsed");
        cx_adapter_account_clear(&account);
    } else if (!lstrcmpW(scenario, L"remote-settings")) {
        static CX_ADAPTER_AUTH_SETTINGS settings;
        check(cx_adapter_auth_settings(base, &settings, error, 512), "remote captcha settings request");
        check(!lstrcmpW(settings.captchaProvider, L"remote"), "remote captcha provider parsed");
        check(!lstrcmpW(settings.captchaApiBaseUrl, L"https://captcha.example.test"), "remote captcha endpoint parsed");
        check(!lstrcmpW(settings.captchaType, L"SLIDER"), "remote captcha type parsed");
    } else if (!lstrcmpW(scenario, L"missing-provider")) {
        static CX_ADAPTER_AUTH_SETTINGS settings;
        check(!cx_adapter_auth_settings(base, &settings, error, 512), "missing captcha provider is rejected");
        check(!lstrcmpW(settings.captchaProvider, L"remote"), "missing provider fails closed as remote");
    } else if (!lstrcmpW(scenario, L"missing-token")) {
        cx_adapter_account_clear(&account); lstrcpyW(account.jwt, L"mock-jwt"); error[0] = 0;
        check(!cx_adapter_account_token(base, FALSE, &account, error, 512), "missing token requires explicit creation choice");
        check(!lstrcmpW(error, L"账号密码登录已成功，但账号没有可用访问令牌。请勾选“没有访问令牌时创建原生客户端专用令牌”后重试，或先在服务端创建令牌。"), "missing-token message explains the next action");
    } else if (!lstrcmpW(scenario, L"unauthorized")) {
        cx_adapter_account_clear(&account); lstrcpyW(account.jwt, L"invalid-jwt");
        check(!cx_adapter_account_token(base, TRUE, &account, error, 512), "unauthorized token listing cannot succeed or create a token");
        check(!account.apiKey[0], "unauthorized response leaves no API key");
    } else {
        ok = cx_adapter_extension_fetch(base, L"EDGE", &package, &size, version, 128, error, 512);
        if (!lstrcmpW(scenario, L"extension")) {
            check(ok && package != NULL && size == 20, "extension downloaded with matching size and SHA256");
            check(!lstrcmpW(version, L"1.2.3.4"), "extension version preserved");
            check(package[0] == 'C' && package[1] == 'r' && package[2] == '2' && package[3] == '4', "CRX bytes preserved");
        } else check(!ok && package == NULL && size == 0, "invalid extension metadata or package rejected");
        if (package) HeapFree(GetProcessHeap(), 0, package);
    }
    out("NATIVE ADAPTER TESTS PASS\r\n"); ExitProcess(0);
}
