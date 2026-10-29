@echo off
setlocal
cd /d "%~dp0" || exit /b 1
rem Node fallback (deprecated, files kept for reference): hidden console via wscript.
rem Primary entry is start-windows.cmd (native EXE). Prefer the bundled runtime.
if exist "%~dp0runtime\node.exe" set "PATH=%~dp0runtime;%PATH%"
where node.exe >nul 2>nul
if errorlevel 1 exit /b 9009
set "NODE_VERSION="
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VERSION=%%v"
if not defined NODE_VERSION exit /b 9009
set "NODE_VERSION=%NODE_VERSION:v=%"
for /f "tokens=1 delims=." %%a in ("%NODE_VERSION%") do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR exit /b 9040
if %NODE_MAJOR% LSS 22 exit /b 9041
wscript.exe //nologo "%~dp0windows\host\silent-launch.vbs" "%~dp0." "%~dp0windows\host\main.mjs" %*
exit /b %ERRORLEVEL%
