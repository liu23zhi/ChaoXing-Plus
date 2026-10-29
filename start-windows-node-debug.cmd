@echo off
setlocal
cd /d "%~dp0" || exit /b 1
rem Node fallback debug entry (deprecated): visible console.
if exist "%~dp0runtime\node.exe" set "PATH=%~dp0runtime;%PATH%"
where node.exe >nul 2>nul
if errorlevel 1 (echo [windows] Node.js not found. Node.js 22 or newer is required.& pause& exit /b 9009)
set "NODE_VERSION="
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VERSION=%%v"
if not defined NODE_VERSION exit /b 9009
set "NODE_VERSION=%NODE_VERSION:v=%"
for /f "tokens=1 delims=." %%a in ("%NODE_VERSION%") do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR exit /b 9040
if %NODE_MAJOR% LSS 22 exit /b 9041
node windows\host\main.mjs %*
exit /b %ERRORLEVEL%
