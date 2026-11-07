#ifndef CX_NATIVE_HOME_H
#define CX_NATIVE_HOME_H

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "options.h"

#define CX_HOME_EXTENSION_PATH_CAP CX_OPTIONS_PATH_CAP
#define CX_HOME_ADAPTER_URL_CAP CX_OPTIONS_PATH_CAP
#define CX_HOME_API_KEY_CAP 4096
#define CX_HOME_SETTINGS_CAP 8192
#define CX_HOME_SCRIPT_IDENTITY_CAP 128

typedef struct CX_HOME_CONFIG {
    WCHAR adapterBaseUrl[CX_HOME_ADAPTER_URL_CAP];
    WCHAR apiKey[CX_HOME_API_KEY_CAP];
    WCHAR scriptIdentity[CX_HOME_SCRIPT_IDENTITY_CAP];
    WCHAR settingsJson[CX_HOME_SETTINGS_CAP];
} CX_HOME_CONFIG;

typedef BOOL (*CX_HOME_EXAM_RUN)(CX_OPTIONS *options, WCHAR *error, DWORD errorCap);

void cx_home_config_init(CX_HOME_CONFIG *config);
BOOL cx_home_config_apply_options(CX_HOME_CONFIG *config, const CX_OPTIONS *options,
    WCHAR *error, DWORD errorCap);
void cx_home_config_clear(CX_HOME_CONFIG *config);

/* Runs the first-level native page. The existing examination client flow is
   invoked only after the user selects the second-level page. */
BOOL cx_home_run(CX_OPTIONS *options, CX_HOME_CONFIG *config,
                 CX_HOME_EXAM_RUN examRun, WCHAR *error, DWORD errorCap);

#endif
