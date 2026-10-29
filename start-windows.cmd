@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [windows] Node.js not found. Node.js 22 or newer is required.
  pause
  exit /b 1
)

rem The Node host runtime requires Node.js 22+; fail fast before starting it.
set "NODE_VERSION="
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VERSION=%%v"
if not defined NODE_VERSION (
  echo [windows] Unable to read the Node.js version. Node.js 22 or newer is required.
  pause
  exit /b 1
)
set "NODE_VERSION=%NODE_VERSION:v=%"
for /f "tokens=1 delims=." %%a in ("%NODE_VERSION%") do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR (
  echo [windows] Unable to parse the Node.js version: %NODE_VERSION%
  pause
  exit /b 1
)
if %NODE_MAJOR% LSS 22 (
  echo [windows] Node.js %NODE_VERSION% is too old. Node.js 22 or newer is required.
  pause
  exit /b 1
)

node windows\host\main.mjs %*
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" (
  echo [windows] host exited with code %EXIT_CODE%
  pause
)
exit /b %EXIT_CODE%
