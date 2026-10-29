@echo off
setlocal
cd /d "%~dp0" || exit /b 1
rem Native entry: single x86 EXE, no Node/PowerShell dependency (GUI subsystem, no console).
rem Node fallback (deprecated): start-windows-node.cmd
if not exist "%~dp0chaoxing_plus.exe" (echo [windows] chaoxing_plus.exe is missing next to this launcher.& echo [windows] Build it with: bash build-windows.sh& exit /b 9009)
start "" "%~dp0chaoxing_plus.exe" %*
exit /b 0
