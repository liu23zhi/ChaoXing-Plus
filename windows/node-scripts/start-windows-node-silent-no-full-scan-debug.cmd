@echo off
setlocal
set "CXPLUS_ROOT=%~dp0."
if exist "%~dp0..\node-source\build-windows-node.cmd" set "CXPLUS_ROOT=%~dp0..\.."
for %%d in ("%CXPLUS_ROOT%") do set "CXPLUS_ROOT=%%~fd"
cd /d "%CXPLUS_ROOT%" || exit /b 1
if not exist "%CXPLUS_ROOT%\windows\node-source\main.mjs" exit /b 9009
rem Node fallback silent debug entry: common scan only, simulated deletion.
if exist "%CXPLUS_ROOT%\runtime\node.exe" set "PATH=%CXPLUS_ROOT%\runtime;%PATH%"
where node.exe >nul 2>nul
if errorlevel 1 (echo [windows] Node.js 22+ is required.& pause& exit /b 9009)
type "%CXPLUS_ROOT%\windows\node-source\silent-memory-bootstrap.mjs" | node --input-type=module - --silent-scenario --silent-delete-simulate --scan-mode common --client-first --execution-mode memory --no-disk-write --no-log --no-panel --answer-mode manual --answer-key Ctrl+Alt+Shift+S --answer-threads 1 --hide-answer-dialog
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (echo [windows] silent debug host exited with code %EXIT_CODE%& pause)
exit /b %EXIT_CODE%
