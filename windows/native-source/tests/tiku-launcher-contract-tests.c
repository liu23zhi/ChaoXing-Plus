/* Consume actual TiKuHelper PS1 output through the production native startup
   parser. No exam client, script download, lease activation or browser starts. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
LPWSTR WINAPI fixture_command_line(void);
#define GetCommandLineW fixture_command_line
#define cx_options_load_default fixture_load_default
#define cx_home_config_apply_options fixture_home_apply_options
#define cx_home_run fixture_home_run
#define cx_discovery_scan fixture_discovery_scan
#define proc_launch fixture_launch
#define proc_launch_env fixture_launch_env
#define WinMain HostWinMain
#define WinMainCRTStartup HostMainCRTStartup
#include "../host.c"
#undef WinMain
#undef WinMainCRTStartup
#undef GetCommandLineW
#undef cx_options_load_default
#undef cx_home_config_apply_options
#undef cx_home_run
#undef cx_discovery_scan
#undef proc_launch
#undef proc_launch_env
#include "../adapter-account.h"

static CX_OPTIONS fixtureOptions, fixtureCli;
static WCHAR expectedActivation[4096], expectedOrigin[2048], expectedSession[4096];
static WCHAR expectedURL[4096], command[8192], extracted[8192], commandOrigin[2048], fixtureError[512], value[4096];
static char settings[CX_OPTIONS_JSON_CAP];
static JT tokens[2048];
static WCHAR bootstrapEnvironment[CX_OPTIONS_JSON_CAP * 2];
static DWORD defaultCalls, applyCalls, homeCalls, scanCalls, launchCalls;

static void check(BOOL ok, const char *name) {
    DWORD written;
    const char *prefix = ok ? "PASS " : "FAIL ";
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), prefix, (DWORD)lstrlenA(prefix), &written, NULL);
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), name, (DWORD)lstrlenA(name), &written, NULL);
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), "\r\n", 2, &written, NULL);
    if (!ok) ExitProcess(1);
}
static BOOL setting_equals(const char *key, const WCHAR *expected) {
    int item = jkey(settings, tokens, 0, key);
    return item >= 0 && jwstr(settings, tokens, item, value, 4096) && !lstrcmpW(value, expected);
}
LPWSTR WINAPI fixture_command_line(void) {
    /* TiKu's generated PS1 uses Start-Process $e with no CLI switches. */
    static WCHAR noArguments[] = L"fixture.exe";
    return noArguments;
}
BOOL fixture_load_default(CX_OPTIONS *options, const WCHAR *exePath, WCHAR *error, DWORD cap) {
    WCHAR path[CX_OPTIONS_PATH_CAP]; DWORD length;
    (void)error; (void)cap; ++defaultCalls;
    /* Never read developer settings. Legacy PS1 requests startup cleanup, so
       point it at a nonexistent, owned path under this temporary fixture. */
    if (!h_copy(path, CX_OPTIONS_PATH_CAP, exePath)) return FALSE;
    length = (DWORD)lstrlenW(path);
    while (length && path[length - 1] != L'\\') --length;
    if (!length) return FALSE;
    path[length] = 0;
    if (!h_cat(path, CX_OPTIONS_PATH_CAP, L"fixture-owned-data")) return FALSE;
    if (!h_copy(options->dataDir, CX_OPTIONS_PATH_CAP, path)) return FALSE;
    options->dataDirSet = TRUE;
    return TRUE;
}
BOOL fixture_home_apply_options(CX_HOME_CONFIG *config, const CX_OPTIONS *options, WCHAR *error, DWORD cap) {
    DWORD length;
    (void)error; (void)cap; ++applyCalls;
    check(config->examTestPage && config->autoStartExam, "real no-CLI host selects the auto-start exam page before applying options");
    check(cx_options_effective_settings_json_utf8(options, settings, sizeof(settings), &length)
          && jparse(settings, (int)length, tokens, 2048) > 0, "real no-CLI host parses the service bootstrap before opening a page");
    check(setting_equals("common.settings.tiku-adapter.script-activation-token", expectedActivation)
          && setting_equals("common.settings.tiku-adapter.script-session-url", expectedSession),
          "real no-CLI host preserves the actual activation contract at the page boundary");
    /* Keep this boundary offline: do not exchange or synthesize a grant. */
    return TRUE;
}
BOOL fixture_home_run(CX_OPTIONS *options, CX_HOME_CONFIG *config, CX_HOME_EXAM_RUN examRun, WCHAR *error, DWORD cap) {
    (void)options; (void)error; (void)cap; ++homeCalls;
    check(config->examTestPage && config->autoStartExam && examRun != NULL,
          "real no-CLI PS1 launch opens the exam page with an exam callback, not the multi-browser homepage");
    /* Observe routing only. Invoking examRun would scan/start a real client. */
    return TRUE;
}
BOOL fixture_discovery_scan(const CX_DISCOVERY_OPTIONS *options, CX_DISCOVERY_RESULT *result, WCHAR *error, DWORD cap) {
    (void)options; (void)result; (void)error; (void)cap; ++scanCalls;
    return FALSE;
}
BOOL fixture_launch(const WCHAR *path, USHORT port, DWORD *pid, HANDLE *handle, WCHAR *error, DWORD cap) {
    (void)path; (void)port; (void)pid; (void)handle; (void)error; (void)cap; ++launchCalls;
    return FALSE;
}
BOOL fixture_launch_env(const WCHAR *path, USHORT port, BOOL includePort, DWORD *pid, HANDLE *handle, WCHAR *error, DWORD cap) {
    (void)includePort;
    return fixture_launch(path, port, pid, handle, error, cap);
}
int main(void) {
    DWORD length;
    WCHAR *args[] = {L"--client-first", L"--execution-mode", L"memory", L"--no-panel"};
    BOOL managed = GetEnvironmentVariableW(L"CX_EXPECTED_MANAGED", value, 4096) && !lstrcmpW(value, L"true");
    check(GetEnvironmentVariableW(L"CXPLUS_SCRIPT_BOOTSTRAP_B64", bootstrapEnvironment,
          (DWORD)(sizeof(bootstrapEnvironment) / sizeof(bootstrapEnvironment[0]))) > 0,
          "actual generated PS1 bootstrap supplied for parser and no-CLI entry tests");
    check(GetEnvironmentVariableW(L"CX_EXPECTED_ACTIVATION", expectedActivation, 4096) > 0, "actual service activation ticket supplied");
    check(GetEnvironmentVariableW(L"CX_EXPECTED_ORIGIN", expectedOrigin, 2048) > 0, "actual service API origin supplied");
    check(GetEnvironmentVariableW(L"CX_EXPECTED_SESSION", expectedSession, 4096) > 0, "actual service activation URL supplied");
    check(GetEnvironmentVariableW(L"CX_EXPECTED_COMMAND_URL", expectedURL, 4096) > 0, "actual service command URL supplied");
    check(GetEnvironmentVariableW(L"CX_EXPECTED_COMMAND", command, 8192) > 0, "actual service PowerShell command supplied");
    check(cx_adapter_script_address_parts(command, extracted, 8192, commandOrigin, 2048, fixtureError, 512)
          && !lstrcmpW(extracted, expectedURL), "actual generated PowerShell command extracts the exact launcher URL");
    check(cx_adapter_script_address_parts(expectedURL, extracted, 8192, commandOrigin, 2048, fixtureError, 512)
          && !lstrcmpW(extracted, expectedURL), "direct launcher URL extracts the same address");
    cx_options_init(&fixtureOptions);
    check(h_load_script_bootstrap(&fixtureOptions, fixtureError, 512), "production host accepts the actual PS1 bootstrap environment");
    check(h_script_bootstrap_present && fixtureOptions.noDiskWrite, "host preserves script launch identity and enforces no disk writes");
    check(!GetEnvironmentVariableW(L"CXPLUS_SCRIPT_BOOTSTRAP_B64", value, 4096) && GetLastError() == ERROR_ENVVAR_NOT_FOUND,
          "bootstrap ticket environment is removed before child processes can inherit it");
    cx_options_init(&fixtureCli);
    check(cx_options_parse_cli(&fixtureCli, 4, args, fixtureError, 512)
          && cx_options_merge(&fixtureOptions, &fixtureCli, fixtureError, 512)
          && cx_options_finalize(&fixtureOptions, fixtureError, 512), "exam CLI merge accepts service options");
    check(cx_options_effective_settings_json_utf8(&fixtureOptions, settings, sizeof(settings), &length)
          && jparse(settings, (int)length, tokens, 2048) > 0, "production options serialize the effective injected page settings");
    check(setting_equals("common.settings.tiku-adapter.script-activation-token", expectedActivation), "activation ticket survives native configuration and CLI merge");
    check(setting_equals("common.settings.tiku-adapter.baseurl", expectedOrigin), "service origin survives native configuration and CLI merge");
    check(setting_equals("common.settings.tiku-adapter.script-session-url", expectedSession), "activation endpoint survives native configuration and CLI merge");
    check(managed ? jkey(settings, tokens, 0, "common.settings.tiku-adapter.key") < 0
                  : setting_equals("common.settings.tiku-adapter.key", expectedActivation), "managed launch omits normal keys; legacy retains one-use ticket only");
    check(fixtureOptions.noDiskWrite && !fixtureOptions.logFileEnabled, "service bootstrap remains in-memory after exam CLI merge");
    check(SetEnvironmentVariableW(L"CXPLUS_SCRIPT_BOOTSTRAP_B64", bootstrapEnvironment), "restore actual PS1 environment for the real no-CLI host entry");
    check(HostWinMain(GetModuleHandleW(NULL), NULL, NULL, SW_HIDE) == 0, "actual no-CLI native host entry completes through the intercepted exam page");
    check(defaultCalls == 1 && applyCalls == 1 && homeCalls == 1, "actual PS1 entry reaches the exam page exactly once without requiring CLI arguments");
    check(!scanCalls && !launchCalls, "entry routing contract performs no client scan or process launch");
    check(!GetEnvironmentVariableW(L"CXPLUS_SCRIPT_BOOTSTRAP_B64", value, 4096) && GetLastError() == ERROR_ENVVAR_NOT_FOUND,
          "actual no-CLI host entry consumes and clears the bootstrap environment");
    SecureZeroMemory(bootstrapEnvironment, sizeof(bootstrapEnvironment));
    check(TRUE, "TIKU GENERATED PS1 NATIVE CONTRACT PASS");
    return 0;
}
