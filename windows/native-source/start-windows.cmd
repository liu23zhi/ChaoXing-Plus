@echo off
setlocal
set "CXPLUS_ROOT=%~dp0."
set "CXPLUS_EXE=%~dp0chaoxing_plus.exe"
if exist "%~dp0build.ps1" (
  set "CXPLUS_ROOT=%~dp0..\.."
  set "CXPLUS_EXE=%~dp0..\..\build-windows\bin\chaoxing_plus.exe"
)
for %%d in ("%CXPLUS_ROOT%") do set "CXPLUS_ROOT=%%~fd"
cd /d "%CXPLUS_ROOT%" || exit /b 1
rem Native entry: single x86 EXE, no Node/PowerShell dependency (GUI subsystem, no console).
rem Node fallback (deprecated): start-windows-node.cmd
if not exist "%CXPLUS_EXE%" (echo [windows] chaoxing_plus.exe is missing next to this launcher.& echo [windows] Build it with: windows\native-source\build-windows.cmd& exit /b 9009)
start "" "%CXPLUS_EXE%" %*
rem Keep this window open after the launcher finishes (set CXPLUS_NO_PAUSE=1 to skip).
if /i not "%CXPLUS_NO_PAUSE%"=="1" pause
exit /b 0
