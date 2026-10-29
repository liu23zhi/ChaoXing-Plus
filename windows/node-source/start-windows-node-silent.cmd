@echo off
setlocal EnableDelayedExpansion
set "CXPLUS_ROOT=%~dp0."
if exist "%~dp0build-windows-node.cmd" set "CXPLUS_ROOT=%~dp0..\.."
for %%d in ("%CXPLUS_ROOT%") do set "CXPLUS_ROOT=%%~fd"
cd /d "%CXPLUS_ROOT%" || exit /b 1
if not exist "%CXPLUS_ROOT%\windows\node-source\main.mjs" exit /b 9009
rem Node fallback silent entry (deprecated, files kept for reference).
rem Prefer the bundled runtime so no installed Node.js is required.
if exist "%CXPLUS_ROOT%\runtime\node.exe" set "PATH=%CXPLUS_ROOT%\runtime;%PATH%"
where node.exe >nul 2>nul
if errorlevel 1 exit /b 9009
set "NODE_VERSION="
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VERSION=%%v"
if not defined NODE_VERSION exit /b 9009
set "NODE_VERSION=%NODE_VERSION:v=%"
for /f "tokens=1 delims=." %%a in ("%NODE_VERSION%") do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR exit /b 9040
if %NODE_MAJOR% LSS 22 exit /b 9041
call :check_build_output
if not defined MISSING goto :launch
echo [windows] required build output is missing:!MISSING!
where npm.cmd >nul 2>nul
if errorlevel 1 (echo [windows] npm.cmd was not found on PATH.& exit /b 9042)
choice /c YN /n /m "Build now with npm run build:windows -- --release? [Y/N] "
if errorlevel 2 exit /b 9043
call npm run build:windows -- --release
if errorlevel 1 exit /b 9044
call :check_build_output
if defined MISSING (echo [windows] build finished but these files are still missing:!MISSING!& exit /b 9045)
:launch
wscript.exe //nologo "%CXPLUS_ROOT%\windows\node-source\silent-memory-launch.vbs" "%CXPLUS_ROOT%\." "%CXPLUS_ROOT%\windows\node-source\silent-memory-bootstrap.mjs" --hide-console --silent-scenario --scan-mode fallback-all --client-first --execution-mode memory --no-disk-write --no-log --quiet --no-panel --answer-mode manual --answer-key Ctrl+Alt+Shift+S --answer-threads 1 --hide-answer-dialog
exit /b %ERRORLEVEL%
:check_build_output
set "MISSING="
for %%f in (
  "windows\node-source\main.mjs"
  "windows\node-source\silent-memory-bootstrap.mjs"
  "windows\node-source\silent-memory-launch.vbs"
  "windows\node-source\launch-client.ps1"
  "dist-windows\windows-bootstrap.js"
  "dist-windows\chaoxing-plus.windows.js"
  "dist-windows\trampoline.js"
) do if not exist "%%~f" set "MISSING=!MISSING! %%~f"
exit /b 0
