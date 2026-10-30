#ifndef CX_NATIVE_SELECTION_H
#define CX_NATIVE_SELECTION_H

#include "discovery.h"

typedef enum CX_SELECTION_STATUS {
    CX_SELECTION_ERROR = -1,
    CX_SELECTION_CANCELLED = 0,
    CX_SELECTION_SELECTED = 1,
    CX_SELECTION_SCAN_ALL = 2
} CX_SELECTION_STATUS;

/* 注入方式不可用的原因位：选择窗口用它显示灰化理由，测试也据此断言。 */
#define CX_SELECTION_REASON_PORT_PACKED 0x1u
#define CX_SELECTION_REASON_PROXY_ARCH 0x2u
#define CX_SELECTION_REASON_PROXY_WRITABLE 0x4u
#define CX_SELECTION_REASON_PROXY_NO_IMPORT 0x8u
#define CX_SELECTION_REASON_PROXY_NO_DLL 0x10u

typedef struct CX_SELECTION_PROBE {
    DWORD itemCount;
    LONG selectedIndex;
    BOOL browseAvailable;
    BOOL scanAllAvailable;
    BOOL unicodeWindow;
    BOOL titleMatches;
    BOOL classIconsMatch;
    BOOL windowIconsMatch;
    BOOL noticeShown;
    BOOL statusControlPresent;
    DWORD statusReasons;
    DWORD layoutScale;
    DWORD injectOptionCount;
    LONG injectSelectedIndex;
    LONG injectComboWidth;
    LONG injectComboHeight;
    DWORD carrierOptionCount;
    LONG carrierSelectedIndex;
    BOOL carrierAutoPresent;
} CX_SELECTION_PROBE;

/* `notice` is an optional first-line message (for example "全盘扫描已取消");
   NULL shows the default heading. */
CX_SELECTION_STATUS cx_select_client(const CX_DISCOVERY_RESULT *candidates,
                                     BOOL hostIs32Bit,
                                     const WCHAR *notice,
                                     WCHAR *out, DWORD outCap,
                                     WCHAR *error, DWORD errorCap);

/* 选择窗口里用户挑的注入方式：auto / cdp-port / dll-proxy。 */
const WCHAR *cx_selection_inject_mode(void);
const WCHAR *cx_selection_proxy_carrier(void);

/* 按客户端 PE 判定注入方式可用性：injectDisabledMask 位 1=cdp-port、位 2=dll-proxy，
   carrierDisabledMask 位 0 保留给"自动"，位 i+1 对应第 i 个代理载体。
   reasons 返回 CX_SELECTION_REASON_* 组合。默认由选择窗口调用，测试也直接调用。 */
BOOL cx_selection_client_caps(const WCHAR *clientPath, DWORD *injectDisabledMask,
                              DWORD *carrierDisabledMask, DWORD *reasons);

/* Creates the same controls without showing a window or opening a file dialog. */
BOOL cx_selection_probe(const CX_DISCOVERY_RESULT *candidates,
                         BOOL hostIs32Bit,
                         const WCHAR *notice,
                         CX_SELECTION_PROBE *probe,
                         WCHAR *error, DWORD errorCap);

/* Full-scan progress window. It runs on its own thread so the host can keep
   recursing on the scan thread while the window shows directory/candidate
   counters and reports a user cancellation through the discovery hooks.
   The window class name is stable for automation probes. */
#define CX_SCAN_PROGRESS_CLASS L"CXPlusNativeScanProgress"
#define CX_SCAN_PROGRESS_CANCEL_ID 1201
typedef struct CX_SCAN_PROGRESS CX_SCAN_PROGRESS;

BOOL cx_scan_progress_begin(CX_SCAN_PROGRESS **progress, WCHAR *error, DWORD errorCap);
void cx_scan_progress_bind(CX_DISCOVERY_OPTIONS *scan, CX_SCAN_PROGRESS *progress);
/* Closes the progress window and joins its thread. TRUE means the user
   cancelled the scan (button, window close or test auto-cancel timer). */
BOOL cx_scan_progress_end(CX_SCAN_PROGRESS *progress, WCHAR *error, DWORD errorCap);

#endif





