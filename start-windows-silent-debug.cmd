@echo off
setlocal
cd /d "%~dp0" || exit /b 1
rem Native silent debug entry: same scenario with --silent-delete-simulate (report only).
rem Node fallback: start-windows-node-silent-debug.cmd
if not exist "%~dp0chaoxing_plus.exe" (echo [windows] chaoxing_plus.exe is missing next to this launcher.& echo [windows] Build it with: bash build-windows.sh& exit /b 9009)
start "" /wait "%~dp0chaoxing_plus.exe" --silent-scenario --silent-delete-simulate --scan-mode fallback-all --client-first --execution-mode memory --no-disk-write --no-log --no-panel
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
