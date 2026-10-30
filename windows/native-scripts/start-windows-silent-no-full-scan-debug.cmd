@echo off
setlocal
set "CXPLUS_ROOT=%~dp0."
set "CXPLUS_EXE=%~dp0chaoxing_plus.exe"
if exist "%~dp0..\native-source\build.ps1" (
  set "CXPLUS_ROOT=%~dp0..\.."
  set "CXPLUS_EXE=%~dp0..\native-build\bin\chaoxing_plus.exe"
)
for %%d in ("%CXPLUS_ROOT%") do set "CXPLUS_ROOT=%%~fd"
cd /d "%CXPLUS_ROOT%" || exit /b 1
rem Native silent debug entry: common-directory scan only (--scan-mode common), simulated deletion.
rem Node fallback: start-windows-node-silent-no-full-scan-debug.cmd
if not exist "%CXPLUS_EXE%" (echo [windows] chaoxing_plus.exe is missing next to this launcher.& echo [windows] Build it with: windows\native-source\build-windows.cmd& exit /b 9009)
start "" /wait "%CXPLUS_EXE%" --console --silent-scenario --stage-boot --silent-delete-simulate --scan-mode common --client-first --execution-mode memory --no-disk-write --no-log --no-panel %*
set "EXIT_CODE=%ERRORLEVEL%"
rem Keep this window open after the launcher finishes (set CXPLUS_NO_PAUSE=1 to skip).
if /i not "%CXPLUS_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%

