@echo off
rem Frozen Node SEA EXE and debug-package build entry; no native EXE is built.
rem   build-windows-node.cmd [--skip-tests]
rem The Node host is deprecated (2026-10-29); use build-windows.cmd for releases.
setlocal EnableExtensions
cd /d "%~dp0..\.." || exit /b 1

set "SKIP_TESTS=0"
set "NODE_BUILD_DIR=windows\node-build"

:parse
if "%~1"=="" goto checks
if /i "%~1"=="--skip-tests" (
  set "SKIP_TESTS=1"
  shift
  goto parse
)
if /i "%~1"=="-h" goto usage
if /i "%~1"=="--help" goto usage
echo [build-windows-node] unknown argument: %~1
exit /b 2

:usage
echo Usage: build-windows-node.cmd [--skip-tests]
echo   Builds the standalone Node EXE and the legacy debug package.
exit /b 0

:checks
where node.exe >nul 2>nul
if errorlevel 1 (
  echo [build-windows-node] node.exe was not found on PATH.
  exit /b 2
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [build-windows-node] npm.cmd was not found on PATH.
  exit /b 2
)
set "NODE_MAJOR="
for /f "delims=" %%v in ('node -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR exit /b 2
if %NODE_MAJOR% LSS 22 (
  echo [build-windows-node] Node.js 22 or newer is required.
  exit /b 2
)

echo [build-windows-node] 1/4 building extension and Chrome75 injection assets
call npm run build:windows -- --release
if errorlevel 1 exit /b 1

echo [build-windows-node] 2/4 packaging the Node-only debug directory
call npm run release:windows -- --skip-native --out "%NODE_BUILD_DIR%"
if errorlevel 1 exit /b 1
set "VERSION="
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "VERSION=%%v"
set "PACKAGE_DIR=%NODE_BUILD_DIR%\chaoxing-plus-%VERSION%-windows"
if not exist "%PACKAGE_DIR%\start-windows-node.cmd" (
  echo [build-windows-node] release package is missing start-windows-node.cmd: %PACKAGE_DIR%
  exit /b 1
)

echo [build-windows-node] 3/4 building the standalone Node EXE
call npm run build:node:exe
if errorlevel 1 exit /b 1
set "NODE_EXE=%NODE_BUILD_DIR%\release\chaoxing_plus_node.exe"
if not exist "%NODE_EXE%" exit /b 1

echo [build-windows-node] 4/4 verifying the package and standalone EXE
node "%PACKAGE_DIR%\verify-release.mjs"
if errorlevel 1 exit /b 1
"%NODE_EXE%" --self-check --no-disk-write --quiet
if errorlevel 1 exit /b 1
if "%SKIP_TESTS%"=="0" (
  echo [build-windows-node] running Node launcher regression
  node --test --test-concurrency=4 --test-timeout=300000 scripts/windows-silent-launcher.test.mjs scripts/windows-node-exe.test.mjs
  if errorlevel 1 exit /b 1
)

echo [build-windows-node] standalone EXE: %NODE_EXE%
echo [build-windows-node] debug package: %PACKAGE_DIR%
exit /b 0
