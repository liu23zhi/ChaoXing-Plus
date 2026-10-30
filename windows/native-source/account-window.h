#ifndef CX_ACCOUNT_WINDOW_H
#define CX_ACCOUNT_WINDOW_H
#include "home.h"

/* Applies the selected account access token or verified API key only on success. */
BOOL cx_account_window(HWND parent, CX_HOME_CONFIG *config);
#endif
