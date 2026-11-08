/* 载体夹具：真的导入 winmm.dll，用于验证 dll-proxy 的"载体是否会被加载"判定。
   build-windows.ps1 用 winmm.lib 链接它，导入表里就会出现 winmm.dll。 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>

void __stdcall CarrierFixtureMain(void) {
    /* 触碰一个 winmm 导出，确保链接器保留导入表项。 */
    timeBeginPeriod(1);
    timeEndPeriod(1);
    ExitProcess(0);
}
