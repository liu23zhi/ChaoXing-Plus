@echo off
rem Windows 原生构建入口：无需 Git Bash。
rem   build-windows.cmd [--skip-tests] [--no-deps]
rem 步骤：依赖检测 -> 资源构建 -> 原生 x86 程序 -> 仅含运行时的发布目录 -> 校验。
rem 原生发布包不含文档和 ZIP 压缩包。
setlocal EnableExtensions
cd /d "%~dp0..\.." || exit /b 1

set "SKIP_TESTS=0"
set "NO_DEPS=0"
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
if /i "%~1"=="--no-deps" (
  set "NO_DEPS=1"
  shift
  goto parse
)
if /i "%~1"=="-h" goto usage
if /i "%~1"=="--help" goto usage
echo [build-windows] 未知参数：%~1
exit /b 2

:usage
echo 用法：build-windows.cmd [--skip-tests] [--no-deps]
echo   构建原生 x86 变体以及仅含运行时的发布目录。
echo   --no-deps  跳过自动依赖检测与补全（不执行 npm ci）。
exit /b 0

:checks
echo [build-windows] 正在检查依赖...
call :ensure_tool node.exe node
if errorlevel 1 exit /b 2
call :ensure_tool npm.cmd npm
if errorlevel 1 exit /b 2
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo [build-windows] 未在 PATH 中找到 powershell.exe。
  exit /b 2
)
set "NODE_MAJOR="
for /f "delims=" %%v in ('node -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR (
  echo [build-windows] 无法确定 Node.js 版本。
  exit /b 2
)
if %NODE_MAJOR% LSS 22 (
  echo [build-windows] 需要 Node.js 22 或更高版本，当前为 %NODE_MAJOR%。
  echo [build-windows] 升级命令：winget install OpenJS.NodeJS.LTS
  exit /b 2
)
if "%NO_DEPS%"=="0" (
  if not exist "node_modules\.package-lock.json" (
    echo [build-windows] node_modules 缺失或不完整，正在执行 npm ci...
    call npm ci
    if errorlevel 1 (
      echo [build-windows] npm ci 失败。
      exit /b 1
    )
  )
) else (
  echo [build-windows] 已跳过自动安装依赖（设置了 --no-deps）。
)
echo [build-windows] 依赖就绪。

echo [build-windows] 1/4 构建扩展和 Chrome75 注入资源
call npm run build:windows -- --release
if errorlevel 1 exit /b 1

echo [build-windows] 2/4 构建单文件 GUI、多文件 GUI、控制台助手和解压包
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "windows\native-source\build-windows.ps1" -OutputDirectory "windows\native-build" -BuildConsole
if errorlevel 1 exit /b 1
if not exist "windows\native-build\bin\chaoxing_plus.exe" (
  echo [build-windows] 未生成原生 EXE。
  exit /b 1
)
if not exist "windows\native-build\bin\multi-file\chaoxing_plus.com" (
  echo [build-windows] 未生成控制台助手。
  exit /b 1
)
if not exist "%SINGLE_EXE%" (
  echo [build-windows] 未生成独立原生 EXE：%SINGLE_EXE%
  exit /b 1
)
if not exist "%MULTI_EXE%" (
  echo [build-windows] 未生成多文件原生 EXE：%MULTI_EXE%
  exit /b 1
)

echo [build-windows] 3/4 生成发布目录（不含文档和 ZIP）
call npm run release:windows
if errorlevel 1 exit /b 1
if not exist "%PACKAGE_DIR%\single-file\chaoxing_plus.exe" (
  echo [build-windows] 发布包缺少 single-file\chaoxing_plus.exe：%PACKAGE_DIR%
  exit /b 1
)
if not exist "%MULTI_CLI%" (
  echo [build-windows] 发布包缺少控制台助手：%MULTI_CLI%
  exit /b 1
)
if not exist "%PACKED_EXE%" (
  echo [build-windows] 发布包缺少解压启动器：%PACKED_EXE%
  exit /b 1
)

echo [build-windows] 4/4 校验发布包及两个原生入口
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
  echo [build-windows] 运行发布包回归测试
  node --test --test-concurrency=4 --test-timeout=300000 scripts/windows-release-package.test.mjs
  if errorlevel 1 exit /b 1
)

echo [build-windows] 单文件 GUI EXE：%SINGLE_EXE%
echo [build-windows] 多文件 GUI EXE：%MULTI_EXE%
echo [build-windows] 多文件命令入口：%MULTI_CLI%
echo [build-windows] 解压包：%PACKED_EXE%
echo [build-windows] 完整发布包：%PACKAGE_DIR%
exit /b 0

rem 先从 PATH 查找必需工具，再从 Node.js 常见安装位置查找。
rem 用法：call :ensure_tool exe-name display-label；返回 0=找到，1=未找到。
:ensure_tool
where "%~1" >nul 2>nul
if not errorlevel 1 exit /b 0
for %%P in (
  "%ProgramFiles%\nodejs"
  "%ProgramFiles(x86)%\nodejs"
  "%LOCALAPPDATA%\Programs\nodejs"
) do (
  if exist "%%~P\%~1" (
    set "PATH=%%~P;%PATH%"
    echo [build-windows] 已加入 PATH：%%~P
    exit /b 0
  )
)
echo [build-windows] 未在 PATH 或 Node.js 常见安装位置找到 %~2。
echo [build-windows] 安装 Node.js 22+：winget install OpenJS.NodeJS.LTS
exit /b 1
