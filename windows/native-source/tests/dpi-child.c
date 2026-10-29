#define WIN32_LEAN_AND_MEAN
#include <windows.h>

/* No windows, files, runtime dependency or exam-client code. */
void __stdcall DpiChildMain(void) {
    ExitProcess(IsProcessDPIAware() ? 7 : 5);
}
