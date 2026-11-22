@echo off
rem Native Windows build entry: no Git Bash required.
rem   build-windows.cmd [--skip-tests]
rem Steps: assets -> native x86 hosts -> runtime-only release directory -> verify.
rem Native release excludes documentation and ZIP archives.
setlocal EnableExtensions
cd /d "%~dp0..\.." || exit /b 1

set "SKIP_TESTS=0"
set "SINGLE_EXE=windows\native-build\release\single-file\chaoxing_plus.exe"
set "MULTI_EXE=windows\native-build\release\multi-file\chaoxing_plus.exe"
set "MULTI_CLI=windows\native-build\release\multi-file\chaoxing_plus.com"
set "PACKED_EXE=windows\native-build\release\multi-file\package-to-single\chaoxing_plus.exe"
set "PACKAGE_DIR=windows\native-build\release"

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
echo   Builds native x86 variants and the runtime-only release directory.
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

echo [build-windows] 2/4 building single GUI + multi GUI, Console helper and extraction package
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "windows\native-source\build-windows.ps1" -OutputDirectory "windows\native-build" -BuildConsole
if errorlevel 1 exit /b 1
if not exist "windows\native-build\bin\chaoxing_plus.exe" (
  echo [build-windows] native EXE was not produced.
  exit /b 1
)
if not exist "windows\native-build\bin\multi-file\chaoxing_plus.com" (
  echo [build-windows] Console helper was not produced.
  exit /b 1
)
if not exist "%SINGLE_EXE%" (
  echo [build-windows] standalone native EXE was not produced: %SINGLE_EXE%
  exit /b 1
)
if not exist "%MULTI_EXE%" (
  echo [build-windows] multi-file native EXE was not produced: %MULTI_EXE%
  exit /b 1
)

echo [build-windows] 3/4 generating the release directory (no docs or ZIP)
call npm run release:windows
if errorlevel 1 exit /b 1
if not exist "%PACKAGE_DIR%\single-file\chaoxing_plus.exe" (
  echo [build-windows] release package is missing single-file\chaoxing_plus.exe: %PACKAGE_DIR%
  exit /b 1
)
if not exist "%MULTI_CLI%" (
  echo [build-windows] release package is missing Console helper: %MULTI_CLI%
  exit /b 1
)
if not exist "%PACKED_EXE%" (
  echo [build-windows] release package is missing extraction launcher: %PACKED_EXE%
  exit /b 1
)

echo [build-windows] 4/4 verifying the package and both native entries
node "%PACKAGE_DIR%\verify-release.mjs"
if errorlevel 1 exit /b 1
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath '%SINGLE_EXE%' -ArgumentList '--self-check','--quiet','--no-disk-write' -Wait -PassThru; exit $p.ExitCode"
if errorlevel 1 exit /b 1
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& '%MULTI_CLI%' --self-check --quiet --no-disk-write; exit $LASTEXITCODE"
if errorlevel 1 exit /b 1
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath '%PACKED_EXE%' -ArgumentList '--self-check','--quiet','--no-disk-write' -Wait -PassThru; exit $p.ExitCode"
if errorlevel 1 exit /b 1
node "%PACKAGE_DIR%\multi-file\verify-release.mjs"
if errorlevel 1 exit /b 1
if "%SKIP_TESTS%"=="0" (
  echo [build-windows] running release regression
  node --test --test-concurrency=4 --test-timeout=300000 scripts/windows-release-package.test.mjs
  if errorlevel 1 exit /b 1
)

echo [build-windows] single-file GUI EXE: %SINGLE_EXE%
echo [build-windows] multi-file GUI EXE: %MULTI_EXE%
echo [build-windows] multi-file command entry: %MULTI_CLI%
echo [build-windows] extraction package: %PACKED_EXE%
echo [build-windows] full package: %PACKAGE_DIR%
exit /b 0
