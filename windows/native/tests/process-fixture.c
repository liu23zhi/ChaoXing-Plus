#define WIN32_LEAN_AND_MEAN
#include <windows.h>

/* Used only as a short-lived, test-owned existing client. */
void __stdcall ProcessFixtureMain(void) {
    Sleep(30000);
    ExitProcess(0);
}
