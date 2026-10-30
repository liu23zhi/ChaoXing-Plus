@echo off
setlocal
set "CXPLUS_ROOT=%~dp0."
set "CXPLUS_EXE=%~dp0chaoxing_plus.exe"
if exist "%~dp0build.ps1" (
  set "CXPLUS_ROOT=%~dp0..\.."
  set "CXPLUS_EXE=%~dp0..\native-build\bin\chaoxing_plus.exe"
)
for %%d in ("%CXPLUS_ROOT%") do set "CXPLUS_ROOT=%%~fd"
cd /d "%CXPLUS_ROOT%" || exit /b 1
rem Native debug entry: keeps this console visible and waits for the host.
rem Node fallback: start-windows-node-debug.cmd
if not exist "%CXPLUS_EXE%" (echo [windows] chaoxing_plus.exe is missing next to this launcher.& echo [windows] Build it with: windows\native-source\build-windows.cmd& exit /b 9009)
"%CXPLUS_EXE%" --console --ui gui --show-inject-reasons %*
set "EXIT_CODE=%ERRORLEVEL%"
rem Keep this window open after the launcher finishes (set CXPLUS_NO_PAUSE=1 to skip).
if /i not "%CXPLUS_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%


