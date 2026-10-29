#ifndef CX_NATIVE_OPTIONS_H
#define CX_NATIVE_OPTIONS_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#define CX_OPTIONS_PATH_CAP 1024
#define CX_OPTIONS_SHORT_CAP 128
#define CX_OPTIONS_JSON_CAP 65536

/* This structure deliberately contains fixed-size buffers.  The native host
   is built without the C runtime, so callers must not rely on malloc/realloc
   or on null-terminated argv storage surviving a parse call. */
typedef struct CX_OPTIONS {
    WCHAR configPath[CX_OPTIONS_PATH_CAP];
    WCHAR dataDir[CX_OPTIONS_PATH_CAP];
    WCHAR clientPath[CX_OPTIONS_PATH_CAP];
    WCHAR expectedBrowser[CX_OPTIONS_SHORT_CAP];
    WCHAR diagnosticsDir[CX_OPTIONS_PATH_CAP];
    WCHAR reportPath[CX_OPTIONS_PATH_CAP];
    WCHAR assetsDir[CX_OPTIONS_PATH_CAP];
    WCHAR optionsJsonPath[CX_OPTIONS_PATH_CAP];
    WCHAR answerKey[CX_OPTIONS_SHORT_CAP];
    WCHAR panelTheme[CX_OPTIONS_SHORT_CAP];
    WCHAR injectStrategy[CX_OPTIONS_SHORT_CAP];
    WCHAR scanMode[CX_OPTIONS_SHORT_CAP];
    WCHAR ui[CX_OPTIONS_SHORT_CAP];
    /* CLI-only handoff state; never accepted as a configuration setting. */
    WCHAR elevatedClientPath[32768];
    BOOL elevatedClientSet;
    BOOL elevated;
    BOOL noElevate;
    BOOL elevateOnStart;
    BOOL elevateOnStartSet;
    char optionsJson[CX_OPTIONS_JSON_CAP];
    DWORD optionsJsonLength;
    char sharedSettingsJson[CX_OPTIONS_JSON_CAP];
    DWORD sharedSettingsLength;
    BOOL sharedSettingsSet;
    BOOL extensionEnabled;
    BOOL extensionEnabledSet;

    int clientIndex;
    int panelTop;
    int panelRight;
    int panelWidth;
    int answerThreads;
    int answerCountdown;
    int answerRetry;
    int injectRetries;
    int debugTimeoutMs;
    int targetPollIntervalMs;
    int bundleTimeoutMs;
    int port;
    int attachPort;
    int durationMs;

    BOOL configPathSet;
    BOOL optionsJsonSet;
    BOOL optionsJsonFile;
    BOOL dataDirSet;
    BOOL clientPathSet;
    BOOL clientIndexSet;
    BOOL clientFirstSet;
    BOOL scanClientsSet;
    BOOL listClientsSet;
    BOOL selectClientSet;
    BOOL scanModeSet;
    BOOL scanAllSet;
    BOOL rescanSet;
    BOOL noScanCacheSet;
    BOOL uiSet;
    BOOL expectedBrowserSet;
    BOOL assetsDirSet;
    BOOL injectBlankFramesSet;
    BOOL captureConsoleSet;
    BOOL injectStrategySet;
    BOOL injectRetriesSet;
    BOOL debugTimeoutSet;
    BOOL targetPollIntervalSet;
    BOOL bundleTimeoutSet;
    BOOL portSet;
    BOOL attachPortSet;
    BOOL durationSet;
    BOOL noDiskWriteSet;
    BOOL retainDataSet;
    BOOL deleteConfigSet;
    BOOL reportPathSet;
    BOOL diagnoseSet;
    BOOL noDiagnoseSet;
    BOOL diagnosticsDirSet;
    BOOL quietSet;
    BOOL logFileEnabledSet;
    BOOL panelEnabledSet;
    BOOL panelCollapsedSet;
    BOOL panelTopSet;
    BOOL panelRightSet;
    BOOL panelWidthSet;
    BOOL panelThemeSet;
    BOOL answerModeSet;
    BOOL answerKeySet;
    BOOL showAnswerDialogSet;
    BOOL answerThreadsSet;
    BOOL answerCountdownSet;
    BOOL answerRetrySet;
    BOOL autoSubmitSet;
    BOOL stopClientOnExitSet;
    BOOL dpiAwareSet;
    BOOL executionModeSet;

    BOOL clientFirst;
    BOOL scanClients;
    BOOL listClients;
    BOOL selectClient;
    BOOL scanAll;
    BOOL rescan;
    BOOL noScanCache;
    BOOL injectBlankFrames;
    BOOL captureConsole;
    BOOL noDiskWrite;
    BOOL retainData;
    BOOL deleteConfig;
    BOOL diagnose;
    BOOL noDiagnose;
    BOOL quiet;
    BOOL logFileEnabled;
    BOOL panelEnabled;
    BOOL panelCollapsed;
    BOOL answerModeAuto;
    BOOL showAnswerDialog;
    BOOL autoSubmit;
    BOOL stopClientOnExit;
    BOOL dpiAware;
    BOOL executionModeNormal;
    BOOL executionModeMemory;
    BOOL silentScenario;
    BOOL silentDeleteSimulate;
    BOOL silentClientPathSet;
    BOOL consoleWindow;
    BOOL stagedBoot;
    BOOL stageRequest;
    BOOL unsupportedRequested;
    BOOL help;
    BOOL version;
    BOOL capabilities;
    BOOL printEffectiveConfig;
    BOOL selfCheck;
    /* Resolve path/UI precedence only after the complete configuration is merged. */
    BOOL commandLineLayer;
    BOOL clientPathSuppressedByUi;
    DWORD sourceLayerCount;
    DWORD clientPathSource;
    DWORD uiSource;
} CX_OPTIONS;

void cx_options_init(CX_OPTIONS *options);
BOOL cx_options_load_default(CX_OPTIONS *options, const WCHAR *exePath,
                             WCHAR *error, DWORD errorCap);
BOOL cx_options_parse_cli(CX_OPTIONS *options, int argc, WCHAR **argv,
                          WCHAR *error, DWORD errorCap);
BOOL cx_options_load_file(CX_OPTIONS *options, const WCHAR *path,
                          WCHAR *error, DWORD errorCap);
BOOL cx_options_apply_json_utf8(CX_OPTIONS *options, const char *json,
                                int length, WCHAR *error, DWORD errorCap);
BOOL cx_options_apply_pending_json(CX_OPTIONS *options,
                                   const CX_OPTIONS *cli,
                                   WCHAR *error, DWORD errorCap);
BOOL cx_options_merge(CX_OPTIONS *destination, const CX_OPTIONS *layer,
                      WCHAR *error, DWORD errorCap);
BOOL cx_options_finalize(CX_OPTIONS *options, WCHAR *error, DWORD errorCap);
BOOL cx_options_effective_settings_json_utf8(const CX_OPTIONS *options,
                                             char *out, DWORD capacity,
                                             DWORD *length);

#endif




