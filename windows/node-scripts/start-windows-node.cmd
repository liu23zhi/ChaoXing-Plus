@echo off
setlocal
set "CXPLUS_ROOT=%~dp0."
if exist "%~dp0..\node-source\build-windows-node.cmd" set "CXPLUS_ROOT=%~dp0..\.."
for %%d in ("%CXPLUS_ROOT%") do set "CXPLUS_ROOT=%%~fd"
cd /d "%CXPLUS_ROOT%" || exit /b 1
if not exist "%CXPLUS_ROOT%\windows\node-source\main.mjs" exit /b 9009
rem Node fallback (deprecated, files kept for reference): hidden console via wscript.
rem Primary entry is start-windows.cmd (native EXE). Prefer the bundled runtime.
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
wscript.exe //nologo "%CXPLUS_ROOT%\windows\node-scripts\silent-launch.vbs" "%CXPLUS_ROOT%\." "%CXPLUS_ROOT%\windows\node-source\main.mjs" %*
exit /b %ERRORLEVEL%
