@echo off
setlocal
cd /d "%~dp0" || exit /b 1

rem Normal launch: the Node host runs without a visible console window, but all
rem normal GUI (client selection) and behavior is unchanged. wscript.exe starts
rem node.exe hidden; see windows\host\silent-launch.vbs.
rem Use start-windows-debug.cmd when console output is needed.
where node.exe >nul 2>nul
if errorlevel 1 exit /b 9009

set "NODE_VERSION="
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VERSION=%%v"
if not defined NODE_VERSION exit /b 9009
set "NODE_VERSION=%NODE_VERSION:v=%"
for /f "tokens=1 delims=." %%a in ("%NODE_VERSION%") do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR exit /b 9040
if %NODE_MAJOR% LSS 22 exit /b 9041

rem Pass "%~dp0." instead of "%~dp0": a trailing backslash before the closing
rem quote would escape that quote in Windows command-line parsing.
wscript.exe //nologo "%~dp0windows\host\silent-launch.vbs" "%~dp0." "%~dp0windows\host\main.mjs" %*

exit /b %ERRORLEVEL%
