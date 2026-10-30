#!/usr/bin/env bash
# Windows x86 打包入口（Git Bash / MSYS2 / Cygwin）。
#
# 设计决策（2026-12-06）：
#   - Windows 发布包默认使用单份 x86 无 CRT、无第三方/外部 DLL 依赖（仅链接 Windows 系统 DLL）的原生 EXE；
#   - 注入通过客户端官方 remote debugging + CDP 页面注入完成，x86 宿主可以
#     正常启动/连接 x64 CXExam，因此不需要内置 x64 可执行注入器；
#   - 不从 x86 进程内存执行 x64 PE，也不引入进程空洞/远程线程注入；
#   - 注入资源（bootstrap/bundle/trampoline/CSS）在原生构建时以 RCDATA 内嵌。
#
# 输出：
#   windows/native-build/release/single-file/chaoxing_plus.exe （GUI 单文件变体）
#   windows/native-build/release/multi-file/chaoxing_plus_console.exe （Console 多文件变体）
#   windows/native-build/bin/                    （保留宿主与调试/测试 EXE）
#   windows/native-build/release/multi-file/start-windows*.cmd（原生启动器）
#   windows/native-build/release/SHA256SUMS.txt / verify-release.mjs
#   windows/native-build/chaoxing-plus-<version>-windows.zip
#
# 用法：
#   bash windows/native-source/build-windows.sh
#   bash windows/native-source/build-windows.sh --skip-tests
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
ROOT="$(cd "$(dirname "$SCRIPT_PATH")/../.." && pwd)"
cd "$ROOT"

SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    -h|--help)
      sed -n '1,40p' "$SCRIPT_PATH"
      exit 0
      ;;
    *)
      echo "[build-windows] 未知参数：$arg" >&2
      exit 2
      ;;
  esac
done

case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *)
    # 在 WSL / Linux bash 下：若能看到 Windows 命令解释器，直接委托给 .cmd 入口。
    if command -v cmd.exe >/dev/null 2>&1; then
      echo "[build-windows] 当前不是 Git Bash/MSYS2，转交 windows/native-source/build-windows.cmd 执行。" >&2
      exec cmd.exe /c "windows\\native-source\\build-windows.cmd" "$@"
    fi
    echo "[build-windows] 该脚本需在 Windows 的 Git Bash / MSYS2 / Cygwin 中运行（检测到 $(uname -s 2>/dev/null || echo unknown)）。" >&2
    echo "[build-windows] 也可以直接运行：windows\\native-source\\build-windows.cmd" >&2
    exit 2
    ;;
esac

for command in node npm powershell.exe; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "[build-windows] 缺少命令：$command" >&2
    exit 2
  fi
done

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "[build-windows] 需要 Node.js 22 或更高版本，当前：$(node --version)" >&2
  exit 2
fi

PACKAGE_DIR="windows/native-build/release"
SINGLE_EXE="windows/native-build/release/single-file/chaoxing_plus.exe"
MULTI_EXE="windows/native-build/release/multi-file/chaoxing_plus_console.exe"

echo "[build-windows] 1/5 构建 Chrome75 注入资源（release）"
npm run build:windows -- --release

echo "[build-windows] 2/5 构建 Windows x86 原生宿主（GUI + Console、无 CRT、资源内嵌、无外部 DLL 依赖）"
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -File "windows/native-source/build-windows.ps1" -OutputDirectory "windows/native-build" -BuildConsole

if [ ! -f "windows/native-build/bin/chaoxing_plus.exe" ]; then
  echo "[build-windows] 原生 x86 EXE 没有生成。" >&2
  exit 1
fi
if [ ! -f "windows/native-build/bin/chaoxing_plus_console.exe" ]; then
  echo "[build-windows] Console 子系统原生 EXE 没有生成。" >&2
  exit 1
fi
if [ ! -f "$SINGLE_EXE" ]; then
  echo "[build-windows] 独立发布的原生 EXE 没有生成：${SINGLE_EXE}" >&2
  exit 1
fi
if [ ! -f "$MULTI_EXE" ]; then
  echo "[build-windows] multi-file 原生 EXE 没有生成：${MULTI_EXE}" >&2
  exit 1
fi

echo "[build-windows] 3/5 生成发布包（原生 x86 EXE + 原生启动器 + 校验清单）"
npm run release:windows

if [ ! -f "${PACKAGE_DIR}/single-file/chaoxing_plus.exe" ]; then
  echo "[build-windows] 发布包缺少 single-file/chaoxing_plus.exe：${PACKAGE_DIR}" >&2
  exit 1
fi
if [ ! -f "${PACKAGE_DIR}/multi-file/chaoxing_plus_console.exe" ]; then
  echo "[build-windows] 发布包缺少 multi-file/chaoxing_plus_console.exe：${PACKAGE_DIR}" >&2
  exit 1
fi

echo "[build-windows] 4/5 校验发布包完整性及独立 EXE/包内入口"
node "${PACKAGE_DIR}/verify-release.mjs"

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -Command "& '${SINGLE_EXE}' --self-check --quiet --no-disk-write; if (\$LASTEXITCODE -ne 0) { exit \$LASTEXITCODE }"

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -Command "& '${MULTI_EXE}' --self-check --quiet --no-disk-write; if (\$LASTEXITCODE -ne 0) { exit \$LASTEXITCODE }"

node "${PACKAGE_DIR}/multi-file/verify-release.mjs"

if [ "$SKIP_TESTS" -eq 0 ]; then
  echo "[build-windows] 5/5 运行发布相关回归"
  node --test --test-concurrency=4 --test-timeout=300000 scripts/windows-release-package.test.mjs
else
  echo "[build-windows] 5/5 已按 --skip-tests 跳过发布相关回归"
fi

echo "[build-windows] 完成："
echo "  single-file GUI EXE：${SINGLE_EXE}（无外部 DLL/运行库依赖）"
echo "  multi-file Console EXE：${MULTI_EXE}（无外部 DLL/运行库依赖）"
echo "  调试/测试 EXE： windows/native-build/bin/（全部保留）"
echo "  完整发布包：    ${PACKAGE_DIR}"
echo "  多文件启动入口： ${PACKAGE_DIR}/multi-file/start-windows.cmd"
echo "  完整性校验：      node ${PACKAGE_DIR}/verify-release.mjs"

