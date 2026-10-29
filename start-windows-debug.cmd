@echo off
setlocal
cd /d "%~dp0" || exit /b 1
rem Native debug entry: keeps this console visible and waits for the host.
rem Node fallback: start-windows-node-debug.cmd
if not exist "%~dp0chaoxing_plus.exe" (echo [windows] chaoxing_plus.exe is missing next to this launcher.& echo [windows] Build it with: bash build-windows.sh& exit /b 9009)
start "" /wait "%~dp0chaoxing_plus.exe" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
