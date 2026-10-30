@echo off
rem Legacy Node-only release entry: native EXE is not built.
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
echo   Builds the legacy Node-only release package (no native EXE).
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

echo [build-windows-node] 1/3 building extension and Chrome75 injection assets
call npm run build:windows -- --release
if errorlevel 1 exit /b 1

echo [build-windows-node] 2/3 packaging the Node-only release
call npm run release:windows -- --skip-native --out "%NODE_BUILD_DIR%"
if errorlevel 1 exit /b 1
set "VERSION="
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "VERSION=%%v"
set "PACKAGE_DIR=%NODE_BUILD_DIR%\chaoxing-plus-%VERSION%-windows"
if not exist "%PACKAGE_DIR%\start-windows-node.cmd" (
  echo [build-windows-node] release package is missing start-windows-node.cmd: %PACKAGE_DIR%
  exit /b 1
)

echo [build-windows-node] 3/3 verifying the package
node "%PACKAGE_DIR%\verify-release.mjs"
if errorlevel 1 exit /b 1
if "%SKIP_TESTS%"=="0" (
  echo [build-windows-node] running Node launcher regression
  node --test --test-concurrency=4 --test-timeout=300000 scripts/windows-silent-launcher.test.mjs
  if errorlevel 1 exit /b 1
)

echo [build-windows-node] done: %PACKAGE_DIR%
exit /b 0
