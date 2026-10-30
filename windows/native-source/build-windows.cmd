@echo off
rem Native Windows build entry: no Git Bash required.
rem   build-windows.cmd [--skip-tests]
rem Steps: assets -> native x86 host -> release package -> verify -> in-package self-check.
setlocal EnableExtensions
cd /d "%~dp0..\.." || exit /b 1

set "SKIP_TESTS=0"

:parse
if "%~1"=="" goto checks
if /i "%~1"=="--skip-tests" (
  set "SKIP_TESTS=1"
  shift
  goto parse
)
if /i "%~1"=="-h" goto usage
if /i "%~1"=="--help" goto usage
echo [build-windows] unknown argument: %~1
exit /b 2

:usage
echo Usage: build-windows.cmd [--skip-tests]
echo   Builds the native x86 host and the default release package.
exit /b 0

:checks
where node.exe >nul 2>nul
if errorlevel 1 (
  echo [build-windows] node.exe was not found on PATH.
  exit /b 2
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [build-windows] npm.cmd was not found on PATH.
  exit /b 2
)
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo [build-windows] powershell.exe was not found on PATH.
  exit /b 2
)
set "NODE_MAJOR="
for /f "delims=" %%v in ('node -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR exit /b 2
if %NODE_MAJOR% LSS 22 (
  echo [build-windows] Node.js 22 or newer is required.
  exit /b 2
)

echo [build-windows] 1/4 building extension and Chrome75 injection assets
call npm run build:windows -- --release
if errorlevel 1 exit /b 1

echo [build-windows] 2/4 building native x86 host (no CRT, embedded assets)
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "windows\native-source\build.ps1" -OutputDirectory "windows\native-build"
if errorlevel 1 exit /b 1
if not exist "windows\native-build\bin\chaoxing_plus.exe" (
  echo [build-windows] native EXE was not produced.
  exit /b 1
)

echo [build-windows] 3/4 generating the release package
call npm run release:windows
if errorlevel 1 exit /b 1
set "VERSION="
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "VERSION=%%v"
set "PACKAGE_DIR=release\chaoxing-plus-%VERSION%-windows"
if not exist "%PACKAGE_DIR%\chaoxing_plus.exe" (
  echo [build-windows] release package is missing chaoxing_plus.exe: %PACKAGE_DIR%
  exit /b 1
)

echo [build-windows] 4/4 verifying the package and the native entry
node "%PACKAGE_DIR%\verify-release.mjs"
if errorlevel 1 exit /b 1
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& '%PACKAGE_DIR%\chaoxing_plus.exe' --self-check --quiet --no-disk-write; exit $LASTEXITCODE"
if errorlevel 1 exit /b 1
if "%SKIP_TESTS%"=="0" (
  echo [build-windows] running release regression
  node --test --test-concurrency=4 --test-timeout=300000 scripts/windows-release-package.test.mjs
  if errorlevel 1 exit /b 1
)

echo [build-windows] done: %PACKAGE_DIR%
exit /b 0
