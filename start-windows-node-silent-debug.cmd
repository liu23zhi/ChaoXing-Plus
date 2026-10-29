@echo off
setlocal
cd /d "%~dp0" || exit /b 1
rem Node fallback silent debug entry (deprecated): simulate deletion, keep console.
if exist "%~dp0runtime\node.exe" set "PATH=%~dp0runtime;%PATH%"
where node.exe >nul 2>nul
if errorlevel 1 (echo [windows] Node.js 22+ is required.& pause& exit /b 9009)
type "%~dp0windows\host\silent-memory-bootstrap.mjs" | node --input-type=module - --silent-scenario --silent-delete-simulate --scan-mode fallback-all --client-first --execution-mode memory --no-disk-write --no-log --no-panel --answer-mode manual --answer-key Ctrl+Alt+Shift+S --answer-threads 1 --hide-answer-dialog
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (echo [windows] silent debug host exited with code %EXIT_CODE%& pause)
exit /b %EXIT_CODE%
