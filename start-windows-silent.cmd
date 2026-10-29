@echo off
setlocal
cd /d "%~dp0" || exit /b 1

rem Silent normal launch: the Node host runs without a visible console window.
rem  - wscript.exe (GUI subsystem) starts node.exe with window style 0, see
rem    windows\host\silent-launch.vbs. The launcher returns immediately; normal
rem    host UI (client selection / panel) is still shown when applicable.
rem  - --hide-console also keeps the UAC-elevated Node instance hidden.
rem  - normal execution only: this script does not force a client, disable the
rem    panel, write no data, or change scan/UAC/injection semantics.
rem  - Node.js 22+ is required by the host runtime; fail fast before delaying.
where node.exe >nul 2>nul
if errorlevel 1 exit /b 9009

set "NODE_VERSION="
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VERSION=%%v"
if not defined NODE_VERSION exit /b 9009
set "NODE_VERSION=%NODE_VERSION:v=%"
for /f "tokens=1 delims=." %%a in ("%NODE_VERSION%") do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR exit /b 9040
if %NODE_MAJOR% LSS 22 exit /b 9041

rem Pass "%~dp0." instead of "%~dp0": a trailing backslash directly before the
rem closing quote would escape that quote in Windows command-line parsing.
wscript.exe //nologo "%~dp0windows\host\silent-launch.vbs" "%~dp0." "%~dp0windows\host\main.mjs" --hide-console

exit /b %ERRORLEVEL%
