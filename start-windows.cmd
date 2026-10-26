@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [windows] Node.js not found. Node.js 22 or newer is required.
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
