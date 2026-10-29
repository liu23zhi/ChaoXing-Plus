#include "options.h"
#include "json.h"
#include "config-store.h"

static int cx_wlen(const WCHAR *s) { int n = 0; if (!s) return 0; while (s[n]) n++; return n; }
static BOOL cx_wcopy(WCHAR *dst, int cap, const WCHAR *src) {
    int i = 0;
    if (!dst || cap < 1 || !src) return FALSE;
    while (src[i] && i < cap - 1) { dst[i] = src[i]; i++; }
    dst[i] = 0;
    return src[i] == 0;
}
static BOOL cx_scopy(char *dst, int cap, const char *src, int n) {
    int i;
    if (!dst || cap < 1 || !src || n < 0) return FALSE;
    if (n >= cap) n = cap - 1;
    for (i = 0; i < n; i++) dst[i] = src[i];
    dst[n] = 0;
    return TRUE;
}
static void cx_error(WCHAR *error, DWORD cap, const WCHAR *message) {
    if (error && cap) lstrcpynW(error, message, (int)cap);
}
static BOOL cx_streq(const WCHAR *a, const WCHAR *b) {
    int i = 0;
    if (!a || !b) return FALSE;
    while (a[i] && b[i] && a[i] == b[i]) i++;
    return a[i] == 0 && b[i] == 0;
}
static BOOL cx_skey(const char *s, const JT *t, int object, const char *key,
                    int *value) {
    int v = jkey(s, t, object, key);
    if (value) *value = v;
    return v >= 0;
}
static BOOL cx_json_bool(const char *s, const JT *t, int value, BOOL *out) {
    if (value < 0 || !out || t[value].type != 'p') return FALSE;
    if (jeq(s, t, value, "true")) { *out = TRUE; return TRUE; }
    if (jeq(s, t, value, "false")) { *out = FALSE; return TRUE; }
    return FALSE;
}
static BOOL cx_json_int(const char *s, const JT *t, int value, int *out) {
    int p, i, sign = 1, result = 0, digit;
    if (value < 0 || !out || t[value].type != 'p') return FALSE;
    p = t[value].start;
    if (p >= t[value].end) return FALSE;
    if (s[p] == '-') { sign = -1; p++; }
    if (p >= t[value].end) return FALSE;
    for (i = p; i < t[value].end; i++) {
        digit = s[i] - '0';
        if (digit < 0 || digit > 9) return FALSE;
        if (result > 214748364 || (result == 214748364 && digit > 7)) return FALSE;
        result = result * 10 + digit;
    }
    *out = sign < 0 ? -result : result;
    return TRUE;
}
static BOOL cx_json_wstr(const char *s, const JT *t, int value,
                         WCHAR *out, int cap) {
    return value >= 0 && jwstr(s, t, value, out, cap);
}
static BOOL cx_valid_inject_mode(const WCHAR *value) {
    return cx_streq(value, L"auto") || cx_streq(value, L"cdp-port") || cx_streq(value, L"cdp-pipe") ||
           cx_streq(value, L"dll-proxy") || cx_streq(value, L"input");
}
static BOOL cx_valid_mode(const WCHAR *value) {
    return cx_streq(value, L"normal") || cx_streq(value, L"memory");
}
static BOOL cx_valid_scan_mode(const WCHAR *value) {
    return cx_streq(value, L"common") || cx_streq(value, L"fallback-all") ||
           cx_streq(value, L"all");
}
static BOOL cx_valid_ui(const WCHAR *value) {
    return cx_streq(value, L"auto") || cx_streq(value, L"gui") ||
           cx_streq(value, L"cli");
}
static BOOL cx_valid_inject_strategy(const WCHAR *value) {
    return cx_streq(value, L"hybrid") || cx_streq(value, L"runtime") ||
           cx_streq(value, L"script");
}
static WCHAR cx_upper(WCHAR c) {
    if (c >= L'a' && c <= L'z') return (WCHAR)(c - L'a' + L'A');
    return c;
}
static BOOL cx_token_eq(const WCHAR *start, int length, const WCHAR *value) {
    int i = 0;
    while (value[i] && i < length && cx_upper(start[i]) == cx_upper(value[i])) i++;
    return i == length && value[i] == 0;
}
static BOOL cx_shortcut(const WCHAR *value) {
    int i = 0, begin = 0, parts = 0, modifiers = 0, bases = 0, modifierMask = 0;
    if (!value || !value[0]) return FALSE;
    for (;;) {
        int end = i;
        while (value[end] && value[end] != L'+') end++;
        if (end == begin) return FALSE;
        parts++;
        if (cx_token_eq(value + begin, end - begin, L"Ctrl") ||
            cx_token_eq(value + begin, end - begin, L"Alt") ||
            cx_token_eq(value + begin, end - begin, L"Shift") ||
            cx_token_eq(value + begin, end - begin, L"Win")) {
            int bit = cx_token_eq(value + begin, end - begin, L"Ctrl") ? 1 :
                      cx_token_eq(value + begin, end - begin, L"Alt") ? 2 :
                      cx_token_eq(value + begin, end - begin, L"Shift") ? 4 : 8;
            if (modifierMask & bit) return FALSE;
            modifierMask |= bit;
            modifiers++;
        } else {
            int k, fnum = 0, base = 0;
            if (end - begin == 1 &&
                ((value[begin] >= L'A' && value[begin] <= L'Z') ||
                 (value[begin] >= L'a' && value[begin] <= L'z') ||
                 (value[begin] >= L'0' && value[begin] <= L'9'))) base = 1;
            if (cx_token_eq(value + begin, end - begin, L"Space") ||
                cx_token_eq(value + begin, end - begin, L"Enter") ||
                cx_token_eq(value + begin, end - begin, L"Escape") ||
                cx_token_eq(value + begin, end - begin, L"Tab") ||
                cx_token_eq(value + begin, end - begin, L"Insert") ||
                cx_token_eq(value + begin, end - begin, L"Delete") ||
                cx_token_eq(value + begin, end - begin, L"Home") ||
                cx_token_eq(value + begin, end - begin, L"End") ||
                cx_token_eq(value + begin, end - begin, L"PageUp") ||
                cx_token_eq(value + begin, end - begin, L"PageDown") ||
                cx_token_eq(value + begin, end - begin, L"ArrowUp") ||
                cx_token_eq(value + begin, end - begin, L"ArrowDown") ||
                cx_token_eq(value + begin, end - begin, L"ArrowLeft") ||
                cx_token_eq(value + begin, end - begin, L"ArrowRight") ||
                cx_token_eq(value + begin, end - begin, L"Up") ||
                cx_token_eq(value + begin, end - begin, L"Down") ||
                cx_token_eq(value + begin, end - begin, L"Left") ||
                cx_token_eq(value + begin, end - begin, L"Right")) base = 1;
            if (end - begin >= 2 && end - begin <= 3 && cx_upper(value[begin]) == L'F' && value[begin + 1] >= L'1' && value[begin + 1] <= L'9') {
                for (k = begin + 1; k < end; k++) {
                    if (value[k] < L'0' || value[k] > L'9') break;
                    fnum = fnum * 10 + (value[k] - L'0');
                }
                if (k == end && fnum >= 1 && fnum <= 24) base = 1;
            }
            if (!base) return FALSE;
            bases++;
        }
        if (!value[end]) break;
        i = end + 1; begin = i;
    }
    return parts >= 1 && bases == 1 && modifiers <= 4;
}

void cx_options_init(CX_OPTIONS *o) {
    int i;
    if (!o) return;
    for (i = 0; i < (int)sizeof(*o); i++) ((BYTE *)o)[i] = 0;
    cx_wcopy(o->dataDir, CX_OPTIONS_PATH_CAP, L".data");
    cx_wcopy(o->expectedBrowser, CX_OPTIONS_SHORT_CAP, L"Chrome/");
    cx_wcopy(o->injectStrategy, CX_OPTIONS_SHORT_CAP, L"hybrid");
    cx_wcopy(o->injectMode, CX_OPTIONS_SHORT_CAP, L"auto");
    cx_wcopy(o->scanMode, CX_OPTIONS_SHORT_CAP, L"fallback-all");
    cx_wcopy(o->ui, CX_OPTIONS_SHORT_CAP, L"auto");
    cx_wcopy(o->answerKey, CX_OPTIONS_SHORT_CAP, L"F8");
    cx_wcopy(o->panelTheme, CX_OPTIONS_SHORT_CAP, L"pink");
    o->injectBlankFrames = TRUE; o->captureConsole = TRUE;
    o->injectRetries = 2; o->debugTimeoutMs = 30000;
    o->targetPollIntervalMs = 1000; o->bundleTimeoutMs = 120000;
    o->retainData = TRUE; o->logFileEnabled = TRUE;
    o->panelEnabled = TRUE; o->panelCollapsed = TRUE;
    o->panelTop = 16; o->panelRight = 16; o->panelWidth = 460;
    o->answerModeAuto = TRUE; o->showAnswerDialog = TRUE;
    o->answerThreads = 4; o->answerCountdown = 5; o->answerRetry = 3;
    o->proxyPort = 9222;
    o->autoSubmit = TRUE; o->executionModeNormal = TRUE; o->executionModeMemory = FALSE;
    o->silentScenario = FALSE; o->silentDeleteSimulate = FALSE; o->silentClientPathSet = FALSE;
    o->extensionEnabled = TRUE;
}

static BOOL cx_copy_arg(CX_OPTIONS *o, WCHAR *dst, int cap, const WCHAR *arg,
                        WCHAR *error, DWORD errorCap) {
    if (!arg || !arg[0] || !cx_wcopy(dst, cap, arg)) {
        cx_error(error, errorCap, L"argument value is too long or empty"); return FALSE;
    }
    (void)o; return TRUE;
}
static BOOL cx_next_arg(int argc, WCHAR **argv, int *index, const WCHAR **value,
                        WCHAR *error, DWORD errorCap) {
    if (*index + 1 >= argc || !argv[*index + 1] || !argv[*index + 1][0]) {
        cx_error(error, errorCap, L"missing argument value"); return FALSE;
    }
    *value = argv[*index + 1]; *index += 1; return TRUE;
}
static BOOL cx_parse_int(const WCHAR *value, int minimum, int maximum, int *out) {
    int i = 0, sign = 1, n = 0, d;
    if (!value || !value[0] || !out) return FALSE;
    if (value[0] == L'-') { sign = -1; i++; }
    if (!value[i]) return FALSE;
    for (; value[i]; i++) {
        d = value[i] - L'0'; if (d < 0 || d > 9) return FALSE;
        if (n > 214748364 || (n == 214748364 && d > 7)) return FALSE;
        n = n * 10 + d;
    }
    n *= sign; if (n < minimum || n > maximum) return FALSE;
    *out = n; return TRUE;
}
static BOOL cx_int_arg(const WCHAR *arg, int min, int max, int *dst,
                       WCHAR *error, DWORD errorCap) {
    if (!cx_parse_int(arg, min, max, dst)) {
        cx_error(error, errorCap, L"numeric argument is outside its allowed range"); return FALSE;
    }
    return TRUE;
}

BOOL cx_options_parse_cli(CX_OPTIONS *o, int argc, WCHAR **argv,
                          WCHAR *error, DWORD errorCap) {
    int i; const WCHAR *raw;
    if (!o || argc < 0 || !argv) { cx_error(error, errorCap, L"invalid command line"); return FALSE; }
    o->commandLineLayer = TRUE;
    for (i = 0; i < argc; i++) {
        const WCHAR *a = argv[i];
        if (!a) continue;
        if (cx_streq(a, L"--help")) { o->help = TRUE; continue; }
        if (cx_streq(a, L"--capabilities")) { o->capabilities = TRUE; continue; }
    if (cx_streq(a, L"--version") || cx_streq(a, L"-v")) { o->version = TRUE; continue; }
        if (cx_streq(a, L"--print-effective-config")) { o->printEffectiveConfig = TRUE; continue; }
        if (cx_streq(a, L"--self-check")) { o->selfCheck = TRUE; continue; }
        if (cx_streq(a, L"--config")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->configPath, CX_OPTIONS_PATH_CAP, raw, error, errorCap)) return FALSE; o->configPathSet = TRUE; continue; }
        if (cx_streq(a, L"--options-json")) {
            if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap)) return FALSE;
            o->optionsJsonSet = TRUE;
            if (raw[0] == L'@') { if (!cx_copy_arg(o, o->optionsJsonPath, CX_OPTIONS_PATH_CAP, raw + 1, error, errorCap)) return FALSE; o->optionsJsonFile = TRUE; }
            else {
                int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, raw, -1, o->optionsJson, CX_OPTIONS_JSON_CAP, 0, 0);
                if (n <= 0 || n > CX_OPTIONS_JSON_CAP) { cx_error(error, errorCap, L"--options-json is not valid UTF-8 or is too long"); return FALSE; }
                o->optionsJsonLength = (DWORD)(n - 1); o->optionsJsonFile = FALSE;
            }
            continue;
        }
        if (cx_streq(a, L"--client")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->clientPath, CX_OPTIONS_PATH_CAP, raw, error, errorCap)) return FALSE; o->clientPathSet = TRUE; continue; }
        if (cx_streq(a, L"--client-index")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_int_arg(raw, 1, 2147483647, &o->clientIndex, error, errorCap)) return FALSE; o->clientIndexSet = TRUE; continue; }
        if (cx_streq(a, L"--client-first")) { o->clientFirst = TRUE; o->clientFirstSet = TRUE; o->scanClients = TRUE; o->scanClientsSet = TRUE; continue; }
        if (cx_streq(a, L"--scan-clients")) { o->scanClients = TRUE; o->scanClientsSet = TRUE; continue; }
        if (cx_streq(a, L"--list-clients")) { o->listClients = TRUE; o->listClientsSet = TRUE; o->scanClients = TRUE; o->scanClientsSet = TRUE; continue; }
        if (cx_streq(a, L"--select-client")) { o->selectClient = TRUE; o->selectClientSet = TRUE; o->scanClients = TRUE; o->scanClientsSet = TRUE; continue; }
        if (cx_streq(a, L"--scan-mode")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->scanMode, CX_OPTIONS_SHORT_CAP, raw, error, errorCap) || !cx_valid_scan_mode(o->scanMode)) { cx_error(error, errorCap, L"invalid --scan-mode"); return FALSE; } o->scanModeSet = TRUE; o->scanAll = cx_streq(o->scanMode, L"all"); o->scanAllSet = TRUE; o->scanClients = TRUE; o->scanClientsSet = TRUE; continue; }
        if (cx_streq(a, L"--scan-all")) { o->scanAll = TRUE; o->scanAllSet = TRUE; o->scanModeSet = TRUE; cx_wcopy(o->scanMode, CX_OPTIONS_SHORT_CAP, L"fallback-all"); o->scanClients = TRUE; o->scanClientsSet = TRUE; continue; }
        if (cx_streq(a, L"--no-scan-all")) { o->scanAll = FALSE; o->scanAllSet = TRUE; o->scanModeSet = TRUE; cx_wcopy(o->scanMode, CX_OPTIONS_SHORT_CAP, L"common"); o->scanClients = TRUE; o->scanClientsSet = TRUE; continue; }
        if (cx_streq(a, L"--rescan")) { o->rescan = TRUE; o->rescanSet = TRUE; o->scanClients = TRUE; o->scanClientsSet = TRUE; continue; }
        if (cx_streq(a, L"--no-scan-cache")) { o->noScanCache = TRUE; o->noScanCacheSet = TRUE; o->scanClients = TRUE; o->scanClientsSet = TRUE; continue; }
        if (cx_streq(a, L"--ui")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->ui, CX_OPTIONS_SHORT_CAP, raw, error, errorCap) || !cx_valid_ui(o->ui)) { cx_error(error, errorCap, L"invalid --ui"); return FALSE; } o->uiSet = TRUE; continue; }
        if (cx_streq(a, L"--data-dir")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->dataDir, CX_OPTIONS_PATH_CAP, raw, error, errorCap)) return FALSE; o->dataDirSet = TRUE; continue; }
        if (cx_streq(a, L"--expected-browser")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->expectedBrowser, CX_OPTIONS_SHORT_CAP, raw, error, errorCap)) return FALSE; o->expectedBrowserSet = TRUE; continue; }
        if (cx_streq(a, L"--assets")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->assetsDir, CX_OPTIONS_PATH_CAP, raw, error, errorCap)) return FALSE; o->assetsDirSet = TRUE; continue; }
        if (cx_streq(a, L"--inject-blank-frames")) { o->injectBlankFrames = TRUE; o->injectBlankFramesSet = TRUE; continue; }
        if (cx_streq(a, L"--no-inject-blank-frames")) { o->injectBlankFrames = FALSE; o->injectBlankFramesSet = TRUE; continue; }
        if (cx_streq(a, L"--capture-console")) { o->captureConsole = TRUE; o->captureConsoleSet = TRUE; continue; }
        if (cx_streq(a, L"--no-capture-console")) { o->captureConsole = FALSE; o->captureConsoleSet = TRUE; continue; }
        if (cx_streq(a, L"--inject-strategy")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->injectStrategy, CX_OPTIONS_SHORT_CAP, raw, error, errorCap) || !cx_valid_inject_strategy(o->injectStrategy)) { cx_error(error, errorCap, L"invalid --inject-strategy"); return FALSE; } o->injectStrategySet = TRUE; continue; }
        if (cx_streq(a, L"--inject-retries")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_int_arg(raw, 0, 5, &o->injectRetries, error, errorCap)) return FALSE; o->injectRetriesSet = TRUE; continue; }
        if (cx_streq(a, L"--debug-timeout")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_int_arg(raw, 1000, 120000, &o->debugTimeoutMs, error, errorCap)) return FALSE; o->debugTimeoutSet = TRUE; continue; }
        if (cx_streq(a, L"--target-poll-interval")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_int_arg(raw, 250, 10000, &o->targetPollIntervalMs, error, errorCap)) return FALSE; o->targetPollIntervalSet = TRUE; continue; }
        if (cx_streq(a, L"--bundle-timeout")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_int_arg(raw, 1000, 300000, &o->bundleTimeoutMs, error, errorCap)) return FALSE; o->bundleTimeoutSet = TRUE; continue; }
        if (cx_streq(a, L"--port")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_int_arg(raw, 0, 65535, &o->port, error, errorCap)) return FALSE; o->portSet = TRUE; continue; }
        if (cx_streq(a, L"--attach")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_int_arg(raw, 1, 65535, &o->attachPort, error, errorCap)) return FALSE; o->attachPortSet = TRUE; continue; }
        if (cx_streq(a, L"--duration")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_int_arg(raw, 0, 2147483647, &o->durationMs, error, errorCap)) return FALSE; o->durationSet = TRUE; continue; }
        if (cx_streq(a, L"--no-disk-write")) { o->noDiskWrite = TRUE; o->noDiskWriteSet = TRUE; continue; }
        if (cx_streq(a, L"--retain-data")) { o->retainData = TRUE; o->retainDataSet = TRUE; continue; }
        if (cx_streq(a, L"--no-retain-data")) { o->retainData = FALSE; o->retainDataSet = TRUE; continue; }
        if (cx_streq(a, L"--delete-config")) { o->deleteConfig = TRUE; o->deleteConfigSet = TRUE; continue; }
        if (cx_streq(a, L"--report")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->reportPath, CX_OPTIONS_PATH_CAP, raw, error, errorCap)) return FALSE; o->reportPathSet = TRUE; continue; }
        if (cx_streq(a, L"--diagnose")) { o->diagnose = TRUE; o->noDiagnose = FALSE; o->diagnoseSet = TRUE; o->noDiagnoseSet = TRUE; continue; }
        if (cx_streq(a, L"--no-diagnose")) { o->diagnose = FALSE; o->noDiagnose = TRUE; o->diagnoseSet = TRUE; o->noDiagnoseSet = TRUE; continue; }
        if (cx_streq(a, L"--diagnostics-dir")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->diagnosticsDir, CX_OPTIONS_PATH_CAP, raw, error, errorCap)) return FALSE; o->diagnosticsDirSet = TRUE; continue; }
        if (cx_streq(a, L"--quiet")) { o->quiet = TRUE; o->quietSet = TRUE; continue; }
        if (cx_streq(a, L"--log")) { o->logFileEnabled = TRUE; o->logFileEnabledSet = TRUE; continue; }
        if (cx_streq(a, L"--no-log")) { o->logFileEnabled = FALSE; o->logFileEnabledSet = TRUE; continue; }
        if (cx_streq(a, L"--panel")) { o->panelEnabled = TRUE; o->panelEnabledSet = TRUE; continue; }
        if (cx_streq(a, L"--no-panel")) { o->panelEnabled = FALSE; o->panelEnabledSet = TRUE; continue; }
        if (cx_streq(a, L"--panel-collapsed")) { o->panelCollapsed = TRUE; o->panelCollapsedSet = TRUE; continue; }
        if (cx_streq(a, L"--panel-expanded")) { o->panelCollapsed = FALSE; o->panelCollapsedSet = TRUE; continue; }
        if (cx_streq(a, L"--panel-top")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_int_arg(raw, 0, 10000, &o->panelTop, error, errorCap)) return FALSE; o->panelTopSet = TRUE; continue; }
        if (cx_streq(a, L"--panel-right")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_int_arg(raw, 0, 10000, &o->panelRight, error, errorCap)) return FALSE; o->panelRightSet = TRUE; continue; }
        if (cx_streq(a, L"--panel-width")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_int_arg(raw, 320, 800, &o->panelWidth, error, errorCap)) return FALSE; o->panelWidthSet = TRUE; continue; }
        if (cx_streq(a, L"--panel-theme")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->panelTheme, CX_OPTIONS_SHORT_CAP, raw, error, errorCap)) return FALSE; o->panelThemeSet = TRUE; continue; }
        if (cx_streq(a, L"--answer-mode")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap)) return FALSE; if (cx_streq(raw, L"auto")) o->answerModeAuto = TRUE; else if (cx_streq(raw, L"manual")) o->answerModeAuto = FALSE; else { cx_error(error, errorCap, L"invalid --answer-mode"); return FALSE; } o->answerModeSet = TRUE; continue; }
        if (cx_streq(a, L"--answer-key")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->answerKey, CX_OPTIONS_SHORT_CAP, raw, error, errorCap)) return FALSE; o->answerKeySet = TRUE; continue; }
        if (cx_streq(a, L"--show-answer-dialog")) { o->showAnswerDialog = TRUE; o->showAnswerDialogSet = TRUE; continue; }
        if (cx_streq(a, L"--hide-answer-dialog")) { o->showAnswerDialog = FALSE; o->showAnswerDialogSet = TRUE; continue; }
        if (cx_streq(a, L"--answer-threads")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_int_arg(raw, 1, 4, &o->answerThreads, error, errorCap)) return FALSE; o->answerThreadsSet = TRUE; continue; }
        if (cx_streq(a, L"--answer-countdown")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_int_arg(raw, 0, 3600, &o->answerCountdown, error, errorCap)) return FALSE; o->answerCountdownSet = TRUE; continue; }
        if (cx_streq(a, L"--answer-retry")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_int_arg(raw, 0, 20, &o->answerRetry, error, errorCap)) return FALSE; o->answerRetrySet = TRUE; continue; }
        if (cx_streq(a, L"--no-auto-submit")) { o->autoSubmit = FALSE; o->autoSubmitSet = TRUE; continue; }
        if (cx_streq(a, L"--stop-client-on-exit")) { o->stopClientOnExit = TRUE; o->stopClientOnExitSet = TRUE; continue; }
        if (cx_streq(a, L"--dpi-aware")) { o->dpiAware = TRUE; o->dpiAwareSet = TRUE; continue; }
        if (cx_streq(a, L"--execution-mode")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap)) return FALSE; if (cx_streq(raw, L"normal")) { o->executionModeNormal = TRUE; o->executionModeMemory = FALSE; } else if (cx_streq(raw, L"memory")) { o->executionModeNormal = FALSE; o->executionModeMemory = TRUE; } else { cx_error(error, errorCap, L"execution mode must be normal or memory (delete-suspend is not supported)"); return FALSE; } o->executionModeSet = TRUE; continue; }
        if (cx_streq(a, L"--memory-exec") || cx_streq(a, L"--execution-mode-memory")) { o->executionModeNormal = FALSE; o->executionModeMemory = TRUE; o->executionModeSet = TRUE; continue; }
        if (cx_streq(a, L"--inject-proxy-dir")) {
        if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) ||
            !cx_copy_arg(o, o->injectProxyDir, CX_OPTIONS_PATH_CAP, raw, error, errorCap)) return FALSE;
        o->injectProxyDirSet = TRUE;
        continue;
    }
    if (cx_streq(a, L"--panel-all-pages")) { o->panelAllPages = TRUE; continue; }
    if (cx_streq(a, L"--pipe-test")) { o->pipeTest = TRUE; continue; }
    if (cx_streq(a, L"--probe-all")) { o->probeAll = TRUE; continue; }
    if (cx_streq(a, L"--probe-client")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->probeClientPath, CX_OPTIONS_PATH_CAP, raw, error, errorCap)) return FALSE; o->probeClientPathSet = TRUE; continue; }
    if (cx_streq(a, L"--proxy-port")) { int value = 0; if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_parse_int(raw, 1024, 65534, &value)) { cx_error(error, errorCap, L"invalid --proxy-port (1024-65534)"); return FALSE; } o->proxyPort = value; o->proxyPortSet = TRUE; continue; }
    if (cx_streq(a, L"--install-proxy")) { o->installProxy = TRUE; continue; }
    if (cx_streq(a, L"--uninstall-proxy")) { o->uninstallProxy = TRUE; continue; }
    if (cx_streq(a, L"--proxy-target")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->proxyTarget, 16, raw, error, errorCap)) return FALSE; o->proxyTargetSet = TRUE; continue; }
    if (cx_streq(a, L"--proxy-source")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->proxySource, CX_OPTIONS_PATH_CAP, raw, error, errorCap)) return FALSE; o->proxySourceSet = TRUE; continue; }
    if (cx_streq(a, L"--pipe-args")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->pipeExtraArgs, CX_OPTIONS_PATH_CAP, raw, error, errorCap)) return FALSE; continue; }
    if (cx_streq(a, L"--pipe-expr")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->pipeExpr, CX_OPTIONS_PATH_CAP, raw, error, errorCap)) return FALSE; continue; }
    if (cx_streq(a, L"--pipe-call")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->pipeCallPath, CX_OPTIONS_PATH_CAP, raw, error, errorCap)) return FALSE; o->pipeCallPathSet = TRUE; continue; }
    if (cx_streq(a, L"--pipe-client")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) || !cx_copy_arg(o, o->pipeClientPath, CX_OPTIONS_PATH_CAP, raw, error, errorCap)) return FALSE; o->pipeClientPathSet = TRUE; continue; }
    if (cx_streq(a, L"--inject-mode")) {
        if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap) ||
            !cx_copy_arg(o, o->injectMode, CX_OPTIONS_SHORT_CAP, raw, error, errorCap)) return FALSE;
        if (!cx_streq(o->injectMode, L"auto") && !cx_streq(o->injectMode, L"cdp-port") &&
            !cx_streq(o->injectMode, L"cdp-pipe") && !cx_streq(o->injectMode, L"dll-proxy") &&
            !cx_streq(o->injectMode, L"input")) {
            cx_error(error, errorCap, L"invalid --inject-mode (auto|cdp-port|cdp-pipe|dll-proxy|input)");
            return FALSE;
        }
        o->injectModeSet = TRUE;
        continue;
    }
    if (cx_streq(a, L"--silent-scenario")) { o->silentScenario = TRUE; continue; }
    if (cx_streq(a, L"--console")) { o->consoleWindow = TRUE; continue; }
    if (cx_streq(a, L"--stage-boot")) { o->stageRequest = TRUE; o->silentScenario = TRUE; continue; }
    if (cx_streq(a, L"--staged-boot")) { o->stagedBoot = TRUE; o->silentScenario = TRUE; continue; }
        if (cx_streq(a, L"--silent-delete-simulate")) { o->silentDeleteSimulate = TRUE; o->silentScenario = TRUE; continue; }
        if (cx_streq(a, L"--silent-client")) { if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap)) return FALSE; if (!cx_copy_arg(o, o->clientPath, CX_OPTIONS_PATH_CAP, raw, error, errorCap)) return FALSE; o->clientPathSet = TRUE; o->silentClientPathSet = TRUE; o->silentScenario = TRUE; continue; }
        if (cx_streq(a, L"--delete-suspend") ||
            cx_streq(a, L"--wipe-owned-files-on-start") || cx_streq(a, L"--wipe-failure-policy") ||
            cx_streq(a, L"--wipe-retries") || cx_streq(a, L"--wipe-retry-delay") ||
            cx_streq(a, L"--wipe-runtime-retry") || cx_streq(a, L"--no-wipe-runtime-retry") ||
            cx_streq(a, L"--wipe-runtime-interval") || cx_streq(a, L"--self-destruct-key") ||
            cx_streq(a, L"--self-destruct-on-fullscreen-exit") || cx_streq(a, L"--self-destruct-delay") ||
            cx_streq(a, L"--no-self-destruct-confirm") || cx_streq(a, L"--execution-mode-delete-suspend")) {
            cx_error(error, errorCap, L"delete-suspend/wipe/self-destruct flags are not supported by the native host; use --silent-scenario (the Node host is deprecated and frozen)");
            o->unsupportedRequested = TRUE; return FALSE;
        }
        if (cx_streq(a, L"--no-elevate")) { o->noElevate = TRUE; continue; }
        if (cx_streq(a, L"--elevate-on-start")) { o->elevateOnStart = TRUE; o->elevateOnStartSet = TRUE; continue; }
        if (cx_streq(a, L"--elevated")) { o->elevated = TRUE; continue; }
        if (cx_streq(a, L"--elevated-client")) {
            if (!cx_next_arg(argc, argv, &i, &raw, error, errorCap)
                || !cx_copy_arg(o, o->elevatedClientPath, 32768, raw, error, errorCap)) return FALSE;
            o->elevatedClientSet = TRUE; continue;
        }
        if (a[0] == L'-') { cx_error(error, errorCap, L"unknown command line option"); return FALSE; }
        cx_error(error, errorCap, L"unexpected positional argument"); return FALSE;
    }
    o->sourceLayerCount++;
    if (o->clientPathSet) o->clientPathSource = o->sourceLayerCount;
    if (o->uiSet) o->uiSource = o->sourceLayerCount;
    return TRUE;
}

static BOOL cx_json_bool_field(const char *s, const JT *t, int object,
                               const char *key, BOOL *field, BOOL *set,
                               WCHAR *error, DWORD errorCap) {
    int v; BOOL b;
    if (!cx_skey(s, t, object, key, &v)) return TRUE;
    if (!cx_json_bool(s, t, v, &b)) { cx_error(error, errorCap, L"JSON boolean field is invalid"); return FALSE; }
    *field = b; *set = TRUE; return TRUE;
}
static BOOL cx_json_int_field(const char *s, const JT *t, int object,
                              const char *key, int *field, BOOL *set,
                              WCHAR *error, DWORD errorCap) {
    int v, n;
    if (!cx_skey(s, t, object, key, &v)) return TRUE;
    if (!cx_json_int(s, t, v, &n)) { cx_error(error, errorCap, L"JSON integer field is invalid"); return FALSE; }
    *field = n; *set = TRUE; return TRUE;
}
static BOOL cx_json_wstr_field(const char *s, const JT *t, int object,
                               const char *key, WCHAR *field, int cap, BOOL *set,
                               WCHAR *error, DWORD errorCap) {
    int v;
    if (!cx_skey(s, t, object, key, &v)) return TRUE;
    if (!cx_json_wstr(s, t, v, field, cap)) { cx_error(error, errorCap, L"JSON string field is invalid"); return FALSE; }
    *set = TRUE; return TRUE;
}
static BOOL cx_json_mode(const char *s, const JT *t, int object,
                         BOOL *autoMode, BOOL *set,
                         WCHAR *error, DWORD errorCap) {
    int v; WCHAR mode[CX_OPTIONS_SHORT_CAP];
    if (!cx_skey(s, t, object, "answerMode", &v)) return TRUE;
    if (!cx_json_wstr(s, t, v, mode, CX_OPTIONS_SHORT_CAP) ||
        !(cx_streq(mode, L"auto") || cx_streq(mode, L"manual"))) {
        cx_error(error, errorCap, L"JSON answerMode is invalid"); return FALSE;
    }
    *autoMode = cx_streq(mode, L"auto");
    *set = TRUE; return TRUE;
}
static BOOL cx_json_execution_mode(CX_OPTIONS *o, const char *s, const JT *t, int object,
                                   WCHAR *error, DWORD errorCap) {
    int v, boolValue; WCHAR mode[CX_OPTIONS_SHORT_CAP];
    if (cx_skey(s, t, object, "executionMode", &v)) {
        if (!cx_json_wstr(s, t, v, mode, CX_OPTIONS_SHORT_CAP) || !cx_valid_mode(mode)) {
            cx_error(error, errorCap, L"JSON executionMode must be normal or memory"); return FALSE;
        }
        o->executionModeNormal = cx_streq(mode, L"normal"); o->executionModeMemory = cx_streq(mode, L"memory"); o->executionModeSet = TRUE;
    }
    if (cx_skey(s, t, object, "injectMode", &v)) {
        if (!cx_json_wstr(s, t, v, mode, CX_OPTIONS_SHORT_CAP) || !cx_valid_inject_mode(mode)) {
            cx_error(error, errorCap, L"JSON injectMode must be auto, cdp-port, cdp-pipe, dll-proxy or input");
            return FALSE;
        }
        cx_wcopy(o->injectMode, CX_OPTIONS_SHORT_CAP, mode);
        o->injectModeSet = TRUE;
    }
    if (cx_skey(s, t, object, "panelAllPages", &v)) {
        if (!cx_json_bool(s, t, v, &boolValue)) { cx_error(error, errorCap, L"JSON panelAllPages must be a boolean"); return FALSE; }
        o->panelAllPages = boolValue;
    }    if (cx_skey(s, t, object, "memoryExec", &v)) {
        if (!cx_json_bool(s, t, v, &boolValue)) { cx_error(error, errorCap, L"JSON memoryExec must be a boolean"); return FALSE; }
        o->executionModeNormal = !boolValue; o->executionModeMemory = boolValue; o->executionModeSet = TRUE;
    }
    return TRUE;
}
static BOOL cx_json_dpi_mode(CX_OPTIONS *o, const char *s, const JT *t, int object,
                             WCHAR *error, DWORD errorCap) {
    int v; WCHAR mode[CX_OPTIONS_SHORT_CAP];
    if (!cx_skey(s, t, object, "dpiAwareness", &v)) return TRUE;
    if (!cx_json_wstr(s, t, v, mode, CX_OPTIONS_SHORT_CAP)
        || !(cx_streq(mode, L"") || cx_streq(mode, L"system"))) {
        cx_error(error, errorCap, L"JSON dpiAwareness must be an empty string or system"); return FALSE;
    }
    o->dpiAware = cx_streq(mode, L"system"); o->dpiAwareSet = TRUE; return TRUE;
}
static BOOL cx_merge_shared_settings(CX_OPTIONS *o, const char *patch, DWORD patchLength,
                                     WCHAR *error, DWORD errorCap) {
    char *base, *merged; DWORD length = 0, previous = o->sharedSettingsLength; BOOL ok;
    if (previous > CX_OPTIONS_JSON_CAP - 3) {
        cx_error(error, errorCap, L"shared settings are too large"); return FALSE;
    }
    base = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)previous + 3);
    merged = (char *)HeapAlloc(GetProcessHeap(), 0, CX_OPTIONS_JSON_CAP);
    if (!base || !merged) {
        if (base) HeapFree(GetProcessHeap(), 0, base);
        if (merged) HeapFree(GetProcessHeap(), 0, merged);
        cx_error(error, errorCap, L"out of memory while merging shared settings"); return FALSE;
    }
    base[0] = '{'; CopyMemory(base + 1, o->sharedSettingsJson, previous);
    base[previous + 1] = '}'; base[previous + 2] = 0;
    ok = cx_config_merge_settings(base, previous + 2, patch, patchLength,
        merged, CX_OPTIONS_JSON_CAP, &length, error, errorCap);
    if (ok) {
        length -= 2;
        CopyMemory(o->sharedSettingsJson, merged + 1, length);
        o->sharedSettingsJson[length] = 0; o->sharedSettingsLength = length;
        if (length) o->sharedSettingsSet = TRUE;
    }
    HeapFree(GetProcessHeap(), 0, base); HeapFree(GetProcessHeap(), 0, merged);
    return ok;
}
/* Host-managed settings are parsed into typed CX_OPTIONS fields and are always
   re-emitted by cx_options_effective_settings_json_utf8(). Keeping their raw
   copies in the shared-settings snapshot would serialize duplicate JSON keys
   (and let stale lower-layer values linger), so only unmanaged page settings
   are retained verbatim. */
static BOOL cx_managed_shared_setting(const WCHAR *name) {
    static const WCHAR *const managed[] = {
        L"common.settings.extension-enabled",
        L"common.settings.windows-panel-enabled",
        L"common.settings.windows-panel-collapsed",
        L"common.settings.windows-panel-top",
        L"common.settings.windows-panel-right",
        L"common.settings.windows-panel-width",
        L"common.settings.windows-panel-theme",
        L"common.settings.windows-answer-mode",
        L"common.settings.windows-answer-key",
        L"common.settings.windows-answer-threads",
        L"common.settings.windows-show-answer-dialog",
        L"common.settings.windows-answer-countdown",
        L"common.settings.windows-answer-retry",
        L"common.settings.windows-auto-submit",
        L"common.settings.windows-log-enabled",
        L"common.settings.windows-no-disk-write"
    };
    DWORD i;
    for (i = 0; i < sizeof(managed) / sizeof(managed[0]); ++i) {
        if (cx_streq(name, managed[i])) return TRUE;
    }
    return FALSE;
}
static BOOL cx_append_shared_settings(CX_OPTIONS *o, const char *s,
                                      const JT *t, int object,
                                      WCHAR *error, DWORD errorCap) {
    char *filtered;
    WCHAR name[512];
    DWORD capacity, length = 0;
    BOOL first = TRUE, ok;
    int i, value, rawLength;
    if (!o || object < 0 || t[object].type != '{') return TRUE;
    rawLength = t[object].end - t[object].start;
    if (rawLength < 0) return TRUE;
    capacity = (DWORD)rawLength * 2U + 4U;
    filtered = (char *)HeapAlloc(GetProcessHeap(), 0, capacity);
    if (!filtered) { cx_error(error, errorCap, L"out of memory while filtering shared settings"); return FALSE; }
    filtered[length++] = '{';
    for (i = object + 1; i < t[object].next; i = t[value].next) {
        value = i + 1;
        /* jwstr failure cannot match a managed key, so copy the raw pair. */
        if (jwstr(s, t, i, name, 512) && cx_managed_shared_setting(name)) continue;
        if (!first) filtered[length++] = ',';
        first = FALSE;
        filtered[length++] = '"';
        CopyMemory(filtered + length, s + t[i].start, (SIZE_T)(t[i].end - t[i].start));
        length += (DWORD)(t[i].end - t[i].start);
        filtered[length++] = '"';
        filtered[length++] = ':';
        if (t[value].type == 's') {
            filtered[length++] = '"';
            CopyMemory(filtered + length, s + t[value].start, (SIZE_T)(t[value].end - t[value].start));
            length += (DWORD)(t[value].end - t[value].start);
            filtered[length++] = '"';
        } else {
            CopyMemory(filtered + length, s + t[value].start, (SIZE_T)(t[value].end - t[value].start));
            length += (DWORD)(t[value].end - t[value].start);
        }
    }
    filtered[length++] = '}';
    ok = cx_merge_shared_settings(o, filtered, length, error, errorCap);
    HeapFree(GetProcessHeap(), 0, filtered);
    return ok;
}
static BOOL cx_known_top_key(const char *s, const JT *t, int key) {
    static const char *known[] = {
        "clientPath", "port", "expectedBrowser", "stopClientOnExit",
        "injectBlankFrames", "captureConsole", "injectStrategy", "injectRetries",
        "debugEndpointTimeoutMs", "targetPollIntervalMs", "bundleTimeoutMs",
        "dpiAwareness", "dpiAware", "dataDir", "diagnosticsDir", "reportPath",
        "assetsDir", "noDiskWrite", "retainData", "deleteConfig", "diagnose",
        "noDiagnose", "quiet", "log", "logFileEnabled", "panel", "panelEnabled",
        "panelCollapsed", "panelTop", "panelRight", "panelWidth", "panelTheme",
        "answerMode", "answerKey", "showAnswerDialog", "answerThreads",
        "answerCountdown", "answerRetry", "autoSubmit", "clientIndex", "clientFirst",
        "scanClients", "listClients", "selectClient", "scanMode", "scanAll", "rescan",
        "noScanCache", "ui", "settings", "executionMode", "memoryExec", "elevateOnStart", "injectMode", "panelAllPages"
    };
    char name[CX_OPTIONS_SHORT_CAP * 4]; int i;
    if (key < 0 || t[key].type != 's' || !jstr(s, t, key, name, sizeof(name))) return FALSE;
    for (i = 0; i < (int)(sizeof(known) / sizeof(known[0])); i++) if (lstrcmpA(name, known[i]) == 0) return TRUE;
    return FALSE;
}
static BOOL cx_reject_unknown_top(const char *s, const JT *t, int object,
                                  WCHAR *error, DWORD errorCap) {
    int i, value;
    for (i = object + 1; i < t[object].next;) {
        value = i + 1;
        if (!cx_known_top_key(s, t, i)) { cx_error(error, errorCap, L"unknown JSON option"); return FALSE; }
        i = t[value].next;
    }
    return TRUE;
}
static BOOL cx_key_prefix(const WCHAR *name, const WCHAR *prefix) {
    int i = 0;
    while (prefix[i]) { if (name[i] != prefix[i]) return FALSE; ++i; }
    return TRUE;
}
static BOOL cx_json_reject_unsupported(const char *s, const JT *t, int count,
                                       int length, WCHAR *error, DWORD errorCap) {
    WCHAR *name;
    int object, key, value, read, written;
    BOOL ok = FALSE;
    name = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, ((SIZE_T)length + 1) * sizeof(WCHAR));
    if (!name) { cx_error(error, errorCap, L"out of memory while validating JSON capabilities"); return FALSE; }
    /* Walk every object token, including objects in arrays, without recursive stack use. */
    for (object = 0; object < count; ++object) {
        if (t[object].type != '{') continue;
        for (key = object + 1; key < t[object].next; key = t[value].next) {
            BOOL wipe, restricted, disabled, prefixed;
            WCHAR mode[7];
            value = key + 1;
            if (!jwstr(s, t, key, name, length + 1)) {
                cx_error(error, errorCap, L"JSON option key cannot be decoded"); goto done;
            }
            prefixed = cx_token_eq(name, 24, L"common.settings.windows-");
            read = prefixed ? 24 : 0;
            written = 0;
            while (name[read]) {
                WCHAR ch = name[read++];
                if (ch != L'-' && ch != L'_') name[written++] = cx_upper(ch);
            }
            name[written] = 0;
            wipe = cx_key_prefix(name, L"WIPE");
            restricted = wipe || cx_streq(name, L"EXECUTIONMODE")
                || cx_streq(name, L"MEMORYEXEC") || cx_streq(name, L"DELETESUSPEND")
                || cx_key_prefix(name, L"SELFDESTRUCT") || cx_streq(name, L"NOSELFDESTRUCTCONFIRM");
            if (!restricted) continue;
            disabled = t[value].type == 'p' && jeq(s, t, value, "false");
            if (!wipe) {
                if (cx_streq(name, L"EXECUTIONMODE")) {
                    if (jwstr(s, t, value, mode, 7)
                        && ((!prefixed && (cx_streq(mode, L"normal") || cx_streq(mode, L"memory")))
                            || (prefixed && cx_streq(mode, L"normal")))) continue;
                } else if (cx_streq(name, L"MEMORYEXEC")) {
                    if (disabled || (!prefixed && (disabled || t[value].type == 'p'))) continue;
                } else if (disabled) {
                    continue;
                }
            }
            cx_error(error, errorCap, L"delete-suspend/wipe/self-destruct flags are not supported by the native host; use --silent-scenario (the Node host is deprecated and frozen)");
            goto done;
        }
    }
    ok = TRUE;
done:
    HeapFree(GetProcessHeap(), 0, name); return ok;
}

static BOOL cx_options_apply_object(CX_OPTIONS *o, const char *json,
                                    const JT *tokens, int object,
                                    WCHAR *error, DWORD errorCap) {
    int v, settings;
    if (object < 0 || tokens[object].type != '{') { cx_error(error, errorCap, L"JSON root must be an object"); return FALSE; }
    if (!cx_reject_unknown_top(json, tokens, object, error, errorCap) ||
        !cx_json_execution_mode(o, json, tokens, object, error, errorCap)
        || !cx_json_dpi_mode(o, json, tokens, object, error, errorCap)) return FALSE;
    if (!cx_json_wstr_field(json, tokens, object, "clientPath", o->clientPath, CX_OPTIONS_PATH_CAP, &o->clientPathSet, error, errorCap) ||
        !cx_json_wstr_field(json, tokens, object, "dataDir", o->dataDir, CX_OPTIONS_PATH_CAP, &o->dataDirSet, error, errorCap) ||
        !cx_json_wstr_field(json, tokens, object, "expectedBrowser", o->expectedBrowser, CX_OPTIONS_SHORT_CAP, &o->expectedBrowserSet, error, errorCap) ||
        !cx_json_wstr_field(json, tokens, object, "diagnosticsDir", o->diagnosticsDir, CX_OPTIONS_PATH_CAP, &o->diagnosticsDirSet, error, errorCap) ||
        !cx_json_wstr_field(json, tokens, object, "reportPath", o->reportPath, CX_OPTIONS_PATH_CAP, &o->reportPathSet, error, errorCap) ||
        !cx_json_wstr_field(json, tokens, object, "assetsDir", o->assetsDir, CX_OPTIONS_PATH_CAP, &o->assetsDirSet, error, errorCap) ||
        !cx_json_wstr_field(json, tokens, object, "injectStrategy", o->injectStrategy, CX_OPTIONS_SHORT_CAP, &o->injectStrategySet, error, errorCap) ||
        !cx_json_wstr_field(json, tokens, object, "scanMode", o->scanMode, CX_OPTIONS_SHORT_CAP, &o->scanModeSet, error, errorCap) ||
        !cx_json_wstr_field(json, tokens, object, "ui", o->ui, CX_OPTIONS_SHORT_CAP, &o->uiSet, error, errorCap) ||
        !cx_json_wstr_field(json, tokens, object, "panelTheme", o->panelTheme, CX_OPTIONS_SHORT_CAP, &o->panelThemeSet, error, errorCap) ||
        !cx_json_wstr_field(json, tokens, object, "answerKey", o->answerKey, CX_OPTIONS_SHORT_CAP, &o->answerKeySet, error, errorCap) ||
        !cx_json_mode(json, tokens, object, &o->answerModeAuto, &o->answerModeSet, error, errorCap)) return FALSE;
    if (!cx_json_bool_field(json, tokens, object, "elevateOnStart", &o->elevateOnStart, &o->elevateOnStartSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "clientFirst", &o->clientFirst, &o->clientFirstSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "scanClients", &o->scanClients, &o->scanClientsSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "listClients", &o->listClients, &o->listClientsSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "selectClient", &o->selectClient, &o->selectClientSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "scanAll", &o->scanAll, &o->scanAllSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "rescan", &o->rescan, &o->rescanSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "noScanCache", &o->noScanCache, &o->noScanCacheSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "injectBlankFrames", &o->injectBlankFrames, &o->injectBlankFramesSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "captureConsole", &o->captureConsole, &o->captureConsoleSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "noDiskWrite", &o->noDiskWrite, &o->noDiskWriteSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "retainData", &o->retainData, &o->retainDataSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "deleteConfig", &o->deleteConfig, &o->deleteConfigSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "diagnose", &o->diagnose, &o->diagnoseSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "noDiagnose", &o->noDiagnose, &o->noDiagnoseSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "quiet", &o->quiet, &o->quietSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "logFileEnabled", &o->logFileEnabled, &o->logFileEnabledSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "log", &o->logFileEnabled, &o->logFileEnabledSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "panel", &o->panelEnabled, &o->panelEnabledSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "panelEnabled", &o->panelEnabled, &o->panelEnabledSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "panelCollapsed", &o->panelCollapsed, &o->panelCollapsedSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "showAnswerDialog", &o->showAnswerDialog, &o->showAnswerDialogSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "autoSubmit", &o->autoSubmit, &o->autoSubmitSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "stopClientOnExit", &o->stopClientOnExit, &o->stopClientOnExitSet, error, errorCap) ||
        !cx_json_bool_field(json, tokens, object, "dpiAware", &o->dpiAware, &o->dpiAwareSet, error, errorCap)) return FALSE;
    if (!cx_json_int_field(json, tokens, object, "clientIndex", &o->clientIndex, &o->clientIndexSet, error, errorCap) ||
        !cx_json_int_field(json, tokens, object, "panelTop", &o->panelTop, &o->panelTopSet, error, errorCap) ||
        !cx_json_int_field(json, tokens, object, "panelRight", &o->panelRight, &o->panelRightSet, error, errorCap) ||
        !cx_json_int_field(json, tokens, object, "panelWidth", &o->panelWidth, &o->panelWidthSet, error, errorCap) ||
        !cx_json_int_field(json, tokens, object, "answerThreads", &o->answerThreads, &o->answerThreadsSet, error, errorCap) ||
        !cx_json_int_field(json, tokens, object, "answerCountdown", &o->answerCountdown, &o->answerCountdownSet, error, errorCap) ||
        !cx_json_int_field(json, tokens, object, "answerRetry", &o->answerRetry, &o->answerRetrySet, error, errorCap) ||
        !cx_json_int_field(json, tokens, object, "injectRetries", &o->injectRetries, &o->injectRetriesSet, error, errorCap) ||
        !cx_json_int_field(json, tokens, object, "debugEndpointTimeoutMs", &o->debugTimeoutMs, &o->debugTimeoutSet, error, errorCap) ||
        !cx_json_int_field(json, tokens, object, "targetPollIntervalMs", &o->targetPollIntervalMs, &o->targetPollIntervalSet, error, errorCap) ||
        !cx_json_int_field(json, tokens, object, "bundleTimeoutMs", &o->bundleTimeoutMs, &o->bundleTimeoutSet, error, errorCap) ||
        !cx_json_int_field(json, tokens, object, "port", &o->port, &o->portSet, error, errorCap)) return FALSE;
    if (cx_skey(json, tokens, object, "settings", &settings)) {
        if (tokens[settings].type != '{') { cx_error(error, errorCap, L"JSON settings must be an object"); return FALSE; }
        if (!cx_json_bool_field(json, tokens, settings, "common.settings.windows-panel-enabled", &o->panelEnabled, &o->panelEnabledSet, error, errorCap) ||
            !cx_json_bool_field(json, tokens, settings, "common.settings.windows-panel-collapsed", &o->panelCollapsed, &o->panelCollapsedSet, error, errorCap) ||
            !cx_json_int_field(json, tokens, settings, "common.settings.windows-panel-top", &o->panelTop, &o->panelTopSet, error, errorCap) ||
            !cx_json_int_field(json, tokens, settings, "common.settings.windows-panel-right", &o->panelRight, &o->panelRightSet, error, errorCap) ||
            !cx_json_int_field(json, tokens, settings, "common.settings.windows-panel-width", &o->panelWidth, &o->panelWidthSet, error, errorCap) ||
            !cx_json_wstr_field(json, tokens, settings, "common.settings.windows-panel-theme", o->panelTheme, CX_OPTIONS_SHORT_CAP, &o->panelThemeSet, error, errorCap) ||
            !cx_json_bool_field(json, tokens, settings, "common.settings.windows-show-answer-dialog", &o->showAnswerDialog, &o->showAnswerDialogSet, error, errorCap) ||
            !cx_json_wstr_field(json, tokens, settings, "common.settings.windows-answer-key", o->answerKey, CX_OPTIONS_SHORT_CAP, &o->answerKeySet, error, errorCap) ||
            !cx_json_int_field(json, tokens, settings, "common.settings.windows-answer-threads", &o->answerThreads, &o->answerThreadsSet, error, errorCap) ||
            !cx_json_int_field(json, tokens, settings, "common.settings.windows-answer-countdown", &o->answerCountdown, &o->answerCountdownSet, error, errorCap) ||
            !cx_json_int_field(json, tokens, settings, "common.settings.windows-answer-retry", &o->answerRetry, &o->answerRetrySet, error, errorCap) ||
            !cx_json_bool_field(json, tokens, settings, "common.settings.windows-auto-submit", &o->autoSubmit, &o->autoSubmitSet, error, errorCap) ||
            !cx_json_bool_field(json, tokens, settings, "common.settings.windows-log-enabled", &o->logFileEnabled, &o->logFileEnabledSet, error, errorCap) ||
            !cx_json_bool_field(json, tokens, settings, "common.settings.windows-no-disk-write", &o->noDiskWrite, &o->noDiskWriteSet, error, errorCap)) return FALSE;
        if (!cx_json_bool_field(json, tokens, settings, "common.settings.extension-enabled", &o->extensionEnabled, &o->extensionEnabledSet, error, errorCap) ||
            !cx_append_shared_settings(o, json, tokens, settings, error, errorCap)) return FALSE;
        if (cx_skey(json, tokens, settings, "common.settings.windows-answer-mode", &v)) {
            WCHAR mode[CX_OPTIONS_SHORT_CAP];
            if (!cx_json_wstr(json, tokens, v, mode, CX_OPTIONS_SHORT_CAP) ||
                !(cx_streq(mode, L"auto") || cx_streq(mode, L"manual"))) { cx_error(error, errorCap, L"JSON answer mode is invalid"); return FALSE; }
            o->answerModeAuto = cx_streq(mode, L"auto"); o->answerModeSet = TRUE;
        }
    }
    return TRUE;
}

BOOL cx_options_apply_json_utf8(CX_OPTIONS *o, const char *json, int length,
                                WCHAR *error, DWORD errorCap) {
    JT *tokens; CX_OPTIONS *layer; int count; BOOL ok;
    if (!o || !json || length < 0 || length > CX_OPTIONS_JSON_CAP - 1) { cx_error(error, errorCap, L"JSON is missing or too large"); return FALSE; }
    tokens = (JT *)HeapAlloc(GetProcessHeap(), 0, sizeof(JT) * 1024);
    if (!tokens) { cx_error(error, errorCap, L"out of memory while parsing JSON"); return FALSE; }
    count = jparse(json, length, tokens, 1024);
    if (count < 1) { cx_error(error, errorCap, L"invalid JSON"); HeapFree(GetProcessHeap(), 0, tokens); return FALSE; }
    if (!cx_json_reject_unsupported(json, tokens, count, length, error, errorCap)
        || !cx_reject_unknown_top(json, tokens, 0, error, errorCap)) { HeapFree(GetProcessHeap(), 0, tokens); return FALSE; }
    layer = (CX_OPTIONS *)HeapAlloc(GetProcessHeap(), 0, sizeof(*layer));
    if (!layer) { HeapFree(GetProcessHeap(), 0, tokens); cx_error(error, errorCap, L"out of memory while applying JSON"); return FALSE; }
    cx_options_init(layer);
    ok = cx_options_apply_object(layer, json, tokens, 0, error, errorCap);
    if (ok) {
        if (layer->diagnoseSet || layer->noDiagnoseSet) {
            if (layer->noDiagnoseSet) layer->diagnose = !layer->noDiagnose;
            else layer->noDiagnose = !layer->diagnose;
            layer->diagnoseSet = TRUE; layer->noDiagnoseSet = TRUE;
        }
        layer->sourceLayerCount = 1;
        if (layer->clientPathSet) layer->clientPathSource = 1;
        if (layer->uiSet) layer->uiSource = 1;
        if (layer->scanModeSet || layer->scanAllSet) {
            if (layer->scanModeSet) layer->scanAll = cx_streq(layer->scanMode, L"all");
            else cx_wcopy(layer->scanMode, CX_OPTIONS_SHORT_CAP, layer->scanAll ? L"fallback-all" : L"common");
            layer->scanModeSet = TRUE; layer->scanAllSet = TRUE;
            layer->scanClients = TRUE; layer->scanClientsSet = TRUE;
        }
        if (layer->clientFirst || layer->selectClient || layer->listClients || layer->rescan || layer->noScanCache) {
            layer->scanClients = TRUE; layer->scanClientsSet = TRUE;
        }
        ok = cx_options_merge(o, layer, error, errorCap);
    }
    HeapFree(GetProcessHeap(), 0, layer); HeapFree(GetProcessHeap(), 0, tokens); return ok;
}

BOOL cx_options_load_file(CX_OPTIONS *o, const WCHAR *path,
                          WCHAR *error, DWORD errorCap) {
    HANDLE file; DWORD size, read; char *data; BOOL ok;
    if (!path || !path[0]) { cx_error(error, errorCap, L"configuration path is empty"); return FALSE; }
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                       0, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, 0);
    if (file == INVALID_HANDLE_VALUE) { cx_error(error, errorCap, L"cannot open configuration file"); return FALSE; }
    size = GetFileSize(file, 0);
    if (size == INVALID_FILE_SIZE || size >= CX_OPTIONS_JSON_CAP) { CloseHandle(file); cx_error(error, errorCap, L"configuration file is too large"); return FALSE; }
    data = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)size + 1);
    if (!data) { CloseHandle(file); cx_error(error, errorCap, L"out of memory while reading configuration"); return FALSE; }
    read = 0; ok = ReadFile(file, data, size, &read, 0) && read == size; CloseHandle(file);
    if (ok) { data[size] = 0; ok = cx_options_apply_json_utf8(o, data, (int)size, error, errorCap); }
    else cx_error(error, errorCap, L"cannot read configuration file");
    HeapFree(GetProcessHeap(), 0, data); return ok;
}

BOOL cx_options_apply_pending_json(CX_OPTIONS *o, const CX_OPTIONS *cli,
                                   WCHAR *error, DWORD errorCap) {
    if (!o || !cli || !cli->optionsJsonSet) return TRUE;
    if (cli->optionsJsonFile) return cx_options_load_file(o, cli->optionsJsonPath, error, errorCap);
    return cx_options_apply_json_utf8(o, cli->optionsJson, (int)cli->optionsJsonLength, error, errorCap);
}

BOOL cx_options_load_default(CX_OPTIONS *o, const WCHAR *exePath,
                             WCHAR *error, DWORD errorCap) {
    WCHAR path[CX_OPTIONS_PATH_CAP]; DWORD n, i;
    if (!o || !exePath || !exePath[0]) return TRUE;
    n = (DWORD)cx_wlen(exePath);
    if (n >= CX_OPTIONS_PATH_CAP) return TRUE;
    for (i = 0; i <= n; ++i) path[i] = exePath[i];
    while (n > 0 && path[n - 1] != L'\\' && path[n - 1] != L'/') --n;
    if (n + 19 >= CX_OPTIONS_PATH_CAP) return TRUE;
    path[n++] = L'c'; path[n++] = L'h'; path[n++] = L'a'; path[n++] = L'o';
    path[n++] = L'x'; path[n++] = L'i'; path[n++] = L'n'; path[n++] = L'g';
    path[n++] = L'-'; path[n++] = L'p'; path[n++] = L'l'; path[n++] = L'u';
    path[n++] = L's'; path[n++] = L'.'; path[n++] = L'j'; path[n++] = L's';
    path[n++] = L'o'; path[n++] = L'n'; path[n] = 0;
    if (GetFileAttributesW(path) == INVALID_FILE_ATTRIBUTES) return TRUE;
    return cx_options_load_file(o, path, error, errorCap);
}

static void cx_copy_field(WCHAR *dst, int cap, const WCHAR *src) { (void)cx_wcopy(dst, cap, src); }
#define CX_COPY_IF(set, field, cap) if (layer->set) { cx_copy_field(destination->field, cap, layer->field); destination->set = TRUE; }
#define CX_BOOL_IF(set, field) if (layer->set) { destination->field = layer->field; destination->set = TRUE; }

BOOL cx_options_merge(CX_OPTIONS *destination, const CX_OPTIONS *layer,
                      WCHAR *error, DWORD errorCap) {
    DWORD offset;
    BOOL cliSelection, cliScan;
    if (!destination || !layer) { cx_error(error, errorCap, L"invalid options merge"); return FALSE; }
    /* Perform the only fallible merge before changing any options fields. */
    if (layer->sharedSettingsSet) {
        char *patch; DWORD length = layer->sharedSettingsLength; BOOL ok;
        if (length > CX_OPTIONS_JSON_CAP - 3) { cx_error(error, errorCap, L"shared settings are too large"); return FALSE; }
        patch = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)length + 3);
        if (!patch) { cx_error(error, errorCap, L"out of memory while merging shared settings"); return FALSE; }
        patch[0] = '{'; CopyMemory(patch + 1, layer->sharedSettingsJson, length);
        patch[length + 1] = '}'; patch[length + 2] = 0;
        ok = cx_merge_shared_settings(destination, patch, length + 2, error, errorCap);
        HeapFree(GetProcessHeap(), 0, patch);
        if (!ok) return FALSE;
    }
    offset = destination->sourceLayerCount;
    cliSelection = layer->commandLineLayer && (layer->clientPathSet || layer->clientIndexSet || layer->clientFirstSet || layer->listClientsSet || layer->selectClientSet);
    cliScan = layer->commandLineLayer && (layer->scanClientsSet || layer->scanModeSet || layer->rescanSet || layer->noScanCacheSet || (layer->uiSet && !cx_streq(layer->ui, L"auto")));
    if (cliSelection) {
        destination->clientPathSet = FALSE; destination->clientPath[0] = 0;
        destination->clientPathSuppressedByUi = FALSE; destination->clientPathSource = 0;
        destination->clientIndexSet = FALSE; destination->clientIndex = 0;
        destination->clientFirstSet = FALSE; destination->clientFirst = FALSE;
        destination->listClientsSet = FALSE; destination->listClients = FALSE;
        destination->selectClientSet = FALSE; destination->selectClient = FALSE;
        if (layer->clientPathSet) {
            destination->scanClientsSet = FALSE; destination->scanClients = FALSE;
            destination->scanModeSet = FALSE; destination->scanAllSet = FALSE; destination->scanAll = FALSE;
            cx_wcopy(destination->scanMode, CX_OPTIONS_SHORT_CAP, L"fallback-all");
            destination->rescan = FALSE; destination->rescanSet = FALSE;
            destination->noScanCache = FALSE; destination->noScanCacheSet = FALSE;
        }
    }
    if (cliScan && !layer->clientPathSet) {
        destination->clientPathSet = FALSE; destination->clientPath[0] = 0;
        destination->clientPathSuppressedByUi = FALSE; destination->clientPathSource = 0;
    }
    CX_COPY_IF(configPathSet, configPath, CX_OPTIONS_PATH_CAP);
    CX_COPY_IF(dataDirSet, dataDir, CX_OPTIONS_PATH_CAP);
    CX_COPY_IF(clientPathSet, clientPath, CX_OPTIONS_PATH_CAP);
    CX_COPY_IF(expectedBrowserSet, expectedBrowser, CX_OPTIONS_SHORT_CAP);
    CX_COPY_IF(diagnosticsDirSet, diagnosticsDir, CX_OPTIONS_PATH_CAP);
    CX_COPY_IF(reportPathSet, reportPath, CX_OPTIONS_PATH_CAP);
    CX_COPY_IF(assetsDirSet, assetsDir, CX_OPTIONS_PATH_CAP);
    CX_COPY_IF(answerKeySet, answerKey, CX_OPTIONS_SHORT_CAP);
    CX_COPY_IF(panelThemeSet, panelTheme, CX_OPTIONS_SHORT_CAP);
    CX_COPY_IF(injectStrategySet, injectStrategy, CX_OPTIONS_SHORT_CAP);
    CX_COPY_IF(scanModeSet, scanMode, CX_OPTIONS_SHORT_CAP);
    CX_COPY_IF(uiSet, ui, CX_OPTIONS_SHORT_CAP);
    if (layer->clientPathSet) { destination->clientPathSource = offset + (layer->clientPathSource ? layer->clientPathSource : 1); destination->clientPathSuppressedByUi = FALSE; }
    if (layer->uiSet) destination->uiSource = offset + (layer->uiSource ? layer->uiSource : 1);
    destination->sourceLayerCount = offset + (layer->sourceLayerCount ? layer->sourceLayerCount : 1);
    CX_BOOL_IF(clientFirstSet, clientFirst); CX_BOOL_IF(scanClientsSet, scanClients);
    CX_BOOL_IF(listClientsSet, listClients); CX_BOOL_IF(selectClientSet, selectClient);
    CX_BOOL_IF(scanAllSet, scanAll); CX_BOOL_IF(rescanSet, rescan); CX_BOOL_IF(noScanCacheSet, noScanCache);
    CX_BOOL_IF(injectBlankFramesSet, injectBlankFrames); CX_BOOL_IF(captureConsoleSet, captureConsole);
    CX_BOOL_IF(noDiskWriteSet, noDiskWrite); CX_BOOL_IF(retainDataSet, retainData);
    CX_BOOL_IF(deleteConfigSet, deleteConfig); CX_BOOL_IF(diagnoseSet, diagnose); CX_BOOL_IF(noDiagnoseSet, noDiagnose);
    CX_BOOL_IF(quietSet, quiet); CX_BOOL_IF(logFileEnabledSet, logFileEnabled);
    CX_BOOL_IF(elevateOnStartSet, elevateOnStart);
    CX_BOOL_IF(panelEnabledSet, panelEnabled); CX_BOOL_IF(panelCollapsedSet, panelCollapsed);
    CX_BOOL_IF(answerModeSet, answerModeAuto); CX_BOOL_IF(showAnswerDialogSet, showAnswerDialog);
    CX_BOOL_IF(autoSubmitSet, autoSubmit); CX_BOOL_IF(stopClientOnExitSet, stopClientOnExit); CX_BOOL_IF(dpiAwareSet, dpiAware);
    CX_BOOL_IF(clientIndexSet, clientIndex); CX_BOOL_IF(panelTopSet, panelTop); CX_BOOL_IF(panelRightSet, panelRight);
    CX_BOOL_IF(panelWidthSet, panelWidth); CX_BOOL_IF(answerThreadsSet, answerThreads); CX_BOOL_IF(answerCountdownSet, answerCountdown);
    CX_BOOL_IF(answerRetrySet, answerRetry); CX_BOOL_IF(injectRetriesSet, injectRetries); CX_BOOL_IF(debugTimeoutSet, debugTimeoutMs);
    CX_BOOL_IF(targetPollIntervalSet, targetPollIntervalMs); CX_BOOL_IF(bundleTimeoutSet, bundleTimeoutMs);
    CX_BOOL_IF(portSet, port); CX_BOOL_IF(attachPortSet, attachPort); CX_BOOL_IF(durationSet, durationMs);
    if (layer->executionModeSet) { destination->executionModeNormal = layer->executionModeNormal; destination->executionModeMemory = layer->executionModeMemory; destination->executionModeSet = TRUE; }
    if (layer->extensionEnabledSet) { destination->extensionEnabled = layer->extensionEnabled; destination->extensionEnabledSet = TRUE; }
    /* 静默场景只来自命令行：合并层必须显式搬运，否则 finalize 看到的永远是 FALSE。 */
    if (layer->silentScenario) destination->silentScenario = TRUE;
    if (layer->injectProxyDirSet) { cx_wcopy(destination->injectProxyDir, CX_OPTIONS_PATH_CAP, layer->injectProxyDir); destination->injectProxyDirSet = TRUE; }
    if (layer->injectModeSet) { cx_wcopy(destination->injectMode, CX_OPTIONS_SHORT_CAP, layer->injectMode); destination->injectModeSet = TRUE; }
    if (layer->panelAllPages) destination->panelAllPages = TRUE;
    if (layer->pipeTest) destination->pipeTest = TRUE;
    if (layer->installProxy) destination->installProxy = TRUE;
    if (layer->proxyPortSet) { destination->proxyPort = layer->proxyPort; destination->proxyPortSet = TRUE; }
    if (layer->probeClientPathSet) { cx_wcopy(destination->probeClientPath, CX_OPTIONS_PATH_CAP, layer->probeClientPath); destination->probeClientPathSet = TRUE; }
    if (layer->probeAll) destination->probeAll = TRUE;
    if (layer->uninstallProxy) destination->uninstallProxy = TRUE;
    if (layer->proxySourceSet) { cx_wcopy(destination->proxySource, CX_OPTIONS_PATH_CAP, layer->proxySource); destination->proxySourceSet = TRUE; }
    if (layer->proxyTarget[0]) { cx_wcopy(destination->proxyTarget, 16, layer->proxyTarget); destination->proxyTargetSet = TRUE; }
    if (layer->pipeClientPathSet) { cx_wcopy(destination->pipeClientPath, CX_OPTIONS_PATH_CAP, layer->pipeClientPath); destination->pipeClientPathSet = TRUE; }
    if (layer->pipeCallPathSet) { cx_wcopy(destination->pipeCallPath, CX_OPTIONS_PATH_CAP, layer->pipeCallPath); destination->pipeCallPathSet = TRUE; }
    if (layer->pipeExpr[0]) cx_wcopy(destination->pipeExpr, CX_OPTIONS_PATH_CAP, layer->pipeExpr);
    if (layer->pipeExtraArgs[0]) cx_wcopy(destination->pipeExtraArgs, CX_OPTIONS_PATH_CAP, layer->pipeExtraArgs);
    if (layer->consoleWindow) destination->consoleWindow = TRUE;
    if (layer->stagedBoot) destination->stagedBoot = TRUE;
    if (layer->stageRequest) destination->stageRequest = TRUE;
    if (layer->silentDeleteSimulate) destination->silentDeleteSimulate = TRUE;
    if (layer->silentClientPathSet) destination->silentClientPathSet = TRUE;
    destination->help = layer->help; destination->capabilities = layer->capabilities; destination->version = layer->version;
    destination->printEffectiveConfig = layer->printEffectiveConfig; destination->selfCheck = layer->selfCheck;
    if (layer->commandLineLayer) {
        destination->noElevate = layer->noElevate; destination->elevated = layer->elevated;
        destination->elevatedClientSet = layer->elevatedClientSet;
        cx_copy_field(destination->elevatedClientPath, 32768, layer->elevatedClientPath);
    }
    if (layer->optionsJsonSet) { destination->optionsJsonSet = TRUE; destination->optionsJsonFile = layer->optionsJsonFile; destination->optionsJsonLength = layer->optionsJsonLength; cx_scopy(destination->optionsJson, CX_OPTIONS_JSON_CAP, layer->optionsJson, (int)layer->optionsJsonLength); cx_copy_field(destination->optionsJsonPath, CX_OPTIONS_PATH_CAP, layer->optionsJsonPath); }
    return TRUE;
}
#undef CX_COPY_IF
#undef CX_BOOL_IF

/* 静默场景固定调参：与 Node 静默入口同语义，但不依赖 Node。
   显式 --scan-mode 仍然优先（调试入口用它跳过全盘回退）。 */
static void cx_apply_silent_scenario(CX_OPTIONS *o) {
    if (!o->silentScenario) return;
    if (o->silentClientPathSet) {
        /* 测试/诊断入口：显式客户端路径优先，不再扫描/选择。 */
        o->clientIndexSet = FALSE;
        o->listClients = FALSE;
        o->selectClient = FALSE;
        o->scanClients = FALSE;
        o->clientFirst = FALSE;
    } else {
        o->clientPathSet = FALSE;
        o->clientIndexSet = FALSE;
        o->listClients = FALSE;
        o->selectClient = FALSE;
        o->scanClients = TRUE;
    }
    if (!o->scanModeSet) { cx_wcopy(o->scanMode, CX_OPTIONS_SHORT_CAP, L"fallback-all"); o->scanModeSet = TRUE; }
    if (!o->silentClientPathSet) o->clientFirst = TRUE;
    o->executionModeNormal = FALSE;
    o->executionModeMemory = TRUE;
    o->noDiskWrite = TRUE;
    o->logFileEnabled = FALSE;
    o->quiet = o->silentDeleteSimulate ? FALSE : TRUE;
    o->panelEnabled = FALSE;
    o->diagnose = FALSE;
    o->noDiagnose = TRUE;
    o->reportPath[0] = 0;
    o->noScanCache = TRUE;
    o->answerModeAuto = FALSE;
    o->showAnswerDialog = FALSE;
    cx_wcopy(o->answerKey, CX_OPTIONS_SHORT_CAP, L"Ctrl+Alt+Shift+S");
    o->answerThreads = 1;
}
BOOL cx_options_finalize(CX_OPTIONS *o, WCHAR *error, DWORD errorCap) {
    if (!o) { cx_error(error, errorCap, L"options are missing"); return FALSE; }
    if (o->elevateOnStart && o->noElevate) {
        cx_error(error, errorCap, L"elevate-on-start conflicts with no-elevate"); return FALSE;
    }
    if (o->dpiAware && (o->noDiskWrite || o->attachPortSet)) {
        cx_error(error, errorCap, L"dpi-aware requires an owned launch and conflicts with no-disk-write or attach"); return FALSE;
    }
    if (o->elevatedClientSet && (!o->elevated || !o->elevatedClientPath[0]
        || o->attachPortSet || o->help || o->capabilities || o->selfCheck
        || o->printEffectiveConfig || o->listClients)) {
        cx_error(error, errorCap, L"internal elevated client requires a marked ordinary launch"); return FALSE;
    }
    if (o->clientPathSuppressedByUi) { o->clientPathSet = TRUE; o->clientPathSuppressedByUi = FALSE; }
    if (o->clientPathSet && !o->clientPath[0]) o->clientPathSet = FALSE;
    /* Defer UI suppression until the final layer, preserving the path if a later auto overrides it. */
    if (o->clientPathSet && !cx_streq(o->ui, L"auto") && o->uiSource > o->clientPathSource) { o->clientPathSet = FALSE; o->clientPathSuppressedByUi = TRUE; }
    if (o->deleteConfig && !o->configPathSet) {
        cx_error(error, errorCap, L"--delete-config requires an explicit --config file");
        return FALSE;
    }
    if (o->silentScenario) cx_apply_silent_scenario(o);
    if (o->silentScenario && o->attachPortSet) { cx_error(error, errorCap, L"silent scenario cannot be combined with --attach"); return FALSE; }
    if (o->deleteConfig && o->noDiskWrite) {
        cx_error(error, errorCap, L"--no-disk-write cannot be combined with --delete-config");
        return FALSE;
    }
    if (!cx_valid_mode(o->executionModeNormal ? L"normal" : (o->executionModeMemory ? L"memory" : L"unsupported")) || !cx_valid_scan_mode(o->scanMode) || !cx_valid_ui(o->ui) || !cx_valid_inject_strategy(o->injectStrategy)) { cx_error(error, errorCap, L"invalid execution, scan, UI or injection mode"); return FALSE; }
    if (o->clientIndexSet && o->clientIndex < 1) { cx_error(error, errorCap, L"client-index must be a positive integer"); return FALSE; }
    if (o->clientPathSet && (o->scanClients || o->clientIndexSet || o->clientFirst || o->selectClient || o->listClients)) { cx_error(error, errorCap, L"client path conflicts with scanning or client selection flags"); return FALSE; }
    if (o->clientIndexSet && (o->clientFirst || o->selectClient || o->listClients)) { cx_error(error, errorCap, L"client index conflicts with other selection flags"); return FALSE; }
    if ((o->clientFirst && (o->selectClient || o->listClients)) || (o->selectClient && o->listClients)) { cx_error(error, errorCap, L"client selection flags conflict"); return FALSE; }
    if (o->panelTop < 0 || o->panelTop > 10000 || o->panelRight < 0 || o->panelRight > 10000 || o->panelWidth < 320 || o->panelWidth > 800) { cx_error(error, errorCap, L"panel dimensions are outside their allowed range"); return FALSE; }
    if (o->answerThreads < 1 || o->answerThreads > 4 || o->answerCountdown < 0 || o->answerCountdown > 3600 || o->answerRetry < 0 || o->answerRetry > 20) { cx_error(error, errorCap, L"answer settings are outside their allowed range"); return FALSE; }
    if (o->injectRetries < 0 || o->injectRetries > 5 || o->debugTimeoutMs < 1000 || o->debugTimeoutMs > 120000 || o->targetPollIntervalMs < 250 || o->targetPollIntervalMs > 10000 || o->bundleTimeoutMs < 1000 || o->bundleTimeoutMs > 300000 || o->port < 0 || o->port > 65535) { cx_error(error, errorCap, L"host settings are outside their allowed range"); return FALSE; }
    if (o->port != 0 && (o->port < 1024 || o->port > 65534)) { cx_error(error, errorCap, L"CEF75 launch port must be 0 (automatic) or 1024 to 65534"); return FALSE; }
    if (o->answerKey[0] && !cx_shortcut(o->answerKey)) { cx_error(error, errorCap, L"answer-key must contain one base key"); return FALSE; }
    if (o->executionModeMemory) o->noDiskWrite = TRUE;
    if (o->noDiskWrite) { o->logFileEnabled = FALSE; o->diagnose = FALSE; o->noDiagnose = TRUE; o->reportPath[0] = 0; o->noScanCache = TRUE; }
    return TRUE;
}

typedef struct { char *out; DWORD cap; DWORD n; BOOL ok; } CX_JSON_OUT;
static void cx_putc(CX_JSON_OUT *o, char c) { if (!o->ok || o->n + 1 >= o->cap) { o->ok = FALSE; return; } o->out[o->n++] = c; }
static void cx_puts(CX_JSON_OUT *o, const char *s) { int i = 0; if (!s) return; while (s[i]) { cx_putc(o, s[i]); i++; } }
static void cx_put_uint(CX_JSON_OUT *o, int value) {
    char text[16]; int n = 0, i; unsigned int u;
    if (value < 0) { cx_putc(o, '-'); u = (unsigned int)(-(value + 1)) + 1U; }
    else u = (unsigned int)value;
    do { text[n++] = (char)('0' + (u % 10U)); u /= 10U; } while (u && n < 16);
    for (i = n - 1; i >= 0; i--) cx_putc(o, text[i]);
}
static void cx_put_bool(CX_JSON_OUT *o, BOOL value) { cx_puts(o, value ? "true" : "false"); }
static void cx_put_wstr(CX_JSON_OUT *o, const WCHAR *value) {
    char utf8[CX_OPTIONS_SHORT_CAP * 4]; int n, i; unsigned char c;
    cx_putc(o, '"');
    if (!value) value = L"";
    n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, utf8, sizeof(utf8), 0, 0);
    if (n <= 0) { cx_putc(o, '"'); return; }
    for (i = 0; i < n - 1; i++) {
        c = (unsigned char)utf8[i];
        if (c == '"' || c == '\\') { cx_putc(o, '\\'); cx_putc(o, (char)c); }
        else if (c == '\r') cx_puts(o, "\\r");
        else if (c == '\n') cx_puts(o, "\\n");
        else if (c == '\t') cx_puts(o, "\\t");
        else if (c < 32) { cx_puts(o, "\\u001f"); }
        else cx_putc(o, (char)c);
    }
    cx_putc(o, '"');
}
static void cx_field_sep(CX_JSON_OUT *o, BOOL *first, const char *name) {
    if (!*first) cx_putc(o, ','); *first = FALSE; cx_putc(o, '"'); cx_puts(o, name); cx_puts(o, "\":");
}
static void cx_setting_bool(CX_JSON_OUT *o, BOOL *first, const char *name, BOOL value) { cx_field_sep(o, first, name); cx_put_bool(o, value); }
static void cx_setting_int(CX_JSON_OUT *o, BOOL *first, const char *name, int value) { cx_field_sep(o, first, name); cx_put_uint(o, value); }
static void cx_setting_str(CX_JSON_OUT *o, BOOL *first, const char *name, const WCHAR *value) { cx_field_sep(o, first, name); cx_put_wstr(o, value); }

BOOL cx_options_effective_settings_json_utf8(const CX_OPTIONS *o, char *out,
                                             DWORD capacity, DWORD *length) {
    CX_JSON_OUT result; BOOL first = TRUE;
    if (!o || !out || capacity < 2) return FALSE;
    result.out = out; result.cap = capacity; result.n = 0; result.ok = TRUE;
    cx_putc(&result, '{');
    if (o->sharedSettingsSet && o->sharedSettingsLength) {
        cx_puts(&result, o->sharedSettingsJson);
        first = FALSE;
    }
    cx_setting_bool(&result, &first, "common.settings.extension-enabled", o->extensionEnabled);
    cx_setting_bool(&result, &first, "common.settings.windows-panel-enabled", o->panelEnabled);
    cx_setting_bool(&result, &first, "common.settings.windows-panel-collapsed", o->panelCollapsed);
    cx_setting_int(&result, &first, "common.settings.windows-panel-top", o->panelTop);
    cx_setting_int(&result, &first, "common.settings.windows-panel-right", o->panelRight);
    cx_setting_int(&result, &first, "common.settings.windows-panel-width", o->panelWidth);
    cx_setting_str(&result, &first, "common.settings.windows-panel-theme", o->panelTheme);
    cx_setting_str(&result, &first, "common.settings.windows-answer-mode", o->answerModeAuto ? L"auto" : L"manual");
    cx_setting_str(&result, &first, "common.settings.windows-answer-key", o->answerKey);
    cx_setting_int(&result, &first, "common.settings.windows-answer-threads", o->answerThreads);
    cx_setting_bool(&result, &first, "common.settings.windows-show-answer-dialog", o->showAnswerDialog);
    cx_setting_int(&result, &first, "common.settings.windows-answer-countdown", o->answerCountdown);
    cx_setting_int(&result, &first, "common.settings.windows-answer-retry", o->answerRetry);
    cx_setting_bool(&result, &first, "common.settings.windows-auto-submit", o->autoSubmit);
    cx_setting_bool(&result, &first, "common.settings.windows-log-enabled", o->noDiskWrite ? FALSE : o->logFileEnabled);
    cx_setting_bool(&result, &first, "common.settings.windows-no-disk-write", o->noDiskWrite);
    cx_putc(&result, '}');
    if (!result.ok) { if (length) *length = 0; return FALSE; }
    result.out[result.n] = 0; if (length) *length = result.n; return TRUE;
}



























