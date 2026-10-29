#!/usr/bin/env bash
# 备用入口（legacy）：只构建 Node 宿主发布包，不构建原生 EXE。
#
# Node 宿主已弃用（2026-10-29）：文件保留用于兼容/对照与排障，不再开发新能力；
# 新功能、静默场景与自毁一律只做原生 EXE。原生构建入口见 ../native-source/build-windows.sh。
#
# 输出：
#   release/chaoxing-plus-<version>-windows/start-windows-node.cmd / start-windows-node-silent.cmd
#   release/chaoxing-plus-<version>-windows/runtime/node.exe（自带运行时）
#   release/chaoxing-plus-<version>-windows/SHA256SUMS.txt / verify-release.mjs
#
# 用法：
#   bash windows/node-source/build-windows-node.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *)
    echo "[build-windows-node] 该脚本需在 Windows 的 Git Bash / MSYS2 / Cygwin 中运行。" >&2
    exit 2
    ;;
esac

for command in node npm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "[build-windows-node] 缺少命令：$command" >&2
    exit 2
  fi
done

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "[build-windows-node] 需要 Node.js 22 或更高版本，当前：$(node --version)" >&2
  exit 2
fi

VERSION="$(node -p "require('./package.json').version")"
PACKAGE_DIR="release/chaoxing-plus-${VERSION}-windows"

echo "[build-windows-node] 1/3 构建 Chrome75 注入资源（release）"
npm run build:windows -- --release

echo "[build-windows-node] 2/3 生成备用 Node 发布包（不含原生 EXE）"
npm run release:windows -- --skip-native

if [ ! -f "${PACKAGE_DIR}/start-windows-node-silent.cmd" ]; then
  echo "[build-windows-node] 备用包缺少 Node 静默入口：${PACKAGE_DIR}" >&2
  exit 1
fi

echo "[build-windows-node] 3/3 校验备用包完整性"
node "${PACKAGE_DIR}/verify-release.mjs"
node "${PACKAGE_DIR}/windows/node-source/main.mjs" --self-check --no-disk-write --quiet

echo "[build-windows-node] 备用包完成：${PACKAGE_DIR}"
echo "  该入口已弃用，仅作兼容/对照；原生入口为 windows/native-source/build-windows.sh。"
