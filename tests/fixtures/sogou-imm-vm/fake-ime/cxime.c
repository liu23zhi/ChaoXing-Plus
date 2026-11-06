/*
 * cxime.ime - minimal IMM32 (IME32) stub used as a stand-in input method.
 *
 * Purpose: the chaoxing exam client (CXExam.exe) decides "input method present"
 * by calling ImmGetDescriptionW() on every HKL returned by GetKeyboardLayoutList().
 * Windows only answers that call for an IME-marked HKL (high nibble 0xE, i.e. a
 * layout whose KLID starts with "E0"), and it loads the module named by the
 * layout's "IME file" value before it answers. A registry-only entry is not
 * enough: imm32 takes its ImmLoadLayout path and needs a module that answers
 * ImeInquire.
 *
 * This DLL therefore exports the complete IME32 surface with inert bodies.
 * It never composes text; it only has to load cleanly so imm32 reports the
 * layout's description.
 *
 * Build with build-cxime.ps1 (MSVC, x86 + x64).
 */

#include <windows.h>

#ifndef IME_PROP_UNICODE
#define IME_PROP_UNICODE 0x00080000
#endif
#ifndef IME_PROP_AT_CARET
#define IME_PROP_AT_CARET 0x00010000
#endif
#ifndef IME_PROP_CANDLIST_START_FROM_1
#define IME_PROP_CANDLIST_START_FROM_1 0x00040000
#endif

/* Same layout as the documented IMEINFO; declared locally so the build does not
 * depend on immdev.h being installed. */
typedef struct tagCX_IMEINFO {
    DWORD dwPrivateDataSize;
    DWORD fdwProperty;
    DWORD fdwConversionCaps;
    DWORD fdwSentenceCaps;
    DWORD fdwUICaps;
    DWORD fdwSCSCaps;
    DWORD fdwSelectCaps;
} CX_IMEINFO;

static const WCHAR kUiClass[] = L"CxStubImeUI";

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved)
{
    (void)instance;
    (void)reason;
    (void)reserved;
    return TRUE;
}

BOOL WINAPI ImeInquire(CX_IMEINFO *info, WCHAR *uiClass, DWORD systemInfoFlags)
{
    (void)systemInfoFlags;
    if (info == NULL) {
        return FALSE;
    }
    info->dwPrivateDataSize = 0;
    info->fdwProperty = IME_PROP_UNICODE | IME_PROP_AT_CARET | IME_PROP_CANDLIST_START_FROM_1;
    info->fdwConversionCaps = 0;
    info->fdwSentenceCaps = 0;
    info->fdwUICaps = 0;
    info->fdwSCSCaps = 0;
    info->fdwSelectCaps = 0;
    if (uiClass != NULL) {
        lstrcpynW(uiClass, kUiClass, 16);
    }
    return TRUE;
}

BOOL WINAPI ImeConfigure(HKL hkl, HWND hwnd, DWORD mode, LPVOID data)
{
    (void)hkl; (void)hwnd; (void)mode; (void)data;
    return FALSE;
}

BOOL WINAPI ImeDestroy(UINT force)
{
    (void)force;
    return TRUE;
}

LRESULT WINAPI ImeEscape(HIMC himc, UINT subFunc, LPVOID data)
{
    (void)himc; (void)subFunc; (void)data;
    return 0;
}

BOOL WINAPI ImeSelect(HIMC himc, BOOL select)
{
    (void)himc; (void)select;
    return TRUE;
}

BOOL WINAPI ImeSetActiveContext(HIMC himc, BOOL flag)
{
    (void)himc; (void)flag;
    return TRUE;
}

UINT WINAPI ImeProcessKey(HIMC himc, UINT vkey, LPARAM lparam, const BYTE *keyState)
{
    (void)himc; (void)vkey; (void)lparam; (void)keyState;
    return 0;
}

UINT WINAPI ImeToAsciiEx(UINT vkey, UINT scanCode, const BYTE *keyState,
                         void *transMsg, UINT flags, HIMC himc)
{
    (void)vkey; (void)scanCode; (void)keyState; (void)transMsg; (void)flags; (void)himc;
    return 0;
}

BOOL WINAPI NotifyIME(HIMC himc, DWORD action, DWORD index, DWORD value)
{
    (void)himc; (void)action; (void)index; (void)value;
    return TRUE;
}

BOOL WINAPI ImeRegisterWord(const WCHAR *reading, DWORD style, const WCHAR *value)
{
    (void)reading; (void)style; (void)value;
    return TRUE;
}

BOOL WINAPI ImeUnregisterWord(const WCHAR *reading, DWORD style, const WCHAR *value)
{
    (void)reading; (void)style; (void)value;
    return TRUE;
}

UINT WINAPI ImeEnumRegisterWord(void *enumProc, const WCHAR *reading, DWORD style,
                                const WCHAR *value, void *data)
{
    (void)enumProc; (void)reading; (void)style; (void)value; (void)data;
    return 0;
}

BOOL WINAPI ImeSetCompositionString(HIMC himc, DWORD index, const void *comp,
                                    DWORD compLen, const void *read, DWORD readLen)
{
    (void)himc; (void)index; (void)comp; (void)compLen; (void)read; (void)readLen;
    return FALSE;
}

DWORD WINAPI ImeConversionList(HIMC himc, const WCHAR *source, void *candidateList,
                               DWORD bufferLen, UINT flags)
{
    (void)himc; (void)source; (void)candidateList; (void)bufferLen; (void)flags;
    return 0;
}

UINT WINAPI ImeGetRegisterWordStyle(UINT itemCount, void *styleBuffer)
{
    (void)itemCount; (void)styleBuffer;
    return 0;
}

DWORD WINAPI ImeGetImeMenuItems(HIMC himc, DWORD flags, DWORD type,
                                void *parent, void *menu, DWORD size)
{
    (void)himc; (void)flags; (void)type; (void)parent; (void)menu; (void)size;
    return 0;
}
