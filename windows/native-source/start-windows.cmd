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
exit /b 0
