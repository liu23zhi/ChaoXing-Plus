#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DIST_DIR="$SCRIPT_DIR/dist"
ENTRY_FILE="$DIST_DIR/chaoxing-plus.js"
MANIFEST_FILE="$DIST_DIR/manifest.json"

on_error() {
  local exit_code=$?
  echo ">>> 构建已中断，退出码为 ${exit_code}，请检查上方错误信息。" >&2
  exit "$exit_code"
}
trap on_error ERR

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未安装 Node.js，或 Node.js 不在 PATH 中。" >&2
  echo "请安装 Node.js 12 或更高版本后重新运行此脚本。" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "错误：未安装 npm，或 npm 不在 PATH 中。" >&2
  echo "请随 Node.js 一起安装 npm 后重新运行此脚本。" >&2
  exit 1
fi

echo ">>> 项目目录：  $SCRIPT_DIR"
echo ">>> Node 版本： $(node --version)"
echo ">>> npm 版本：  $(npm --version)"
echo ">>> 输出目录：  $DIST_DIR"

if [[ -f package-lock.json ]]; then
  echo ">>> 正在使用 npm ci 安装依赖"
  npm ci
else
  echo ">>> 正在使用 npm install 安装依赖"
  npm install
fi

echo ">>> 正在执行 TypeScript 类型检查"
npm run typecheck

echo ">>> 正在构建项目"
npm run build

if [[ ! -f "$ENTRY_FILE" ]]; then
  echo "错误：构建已结束，但未生成主文件：$ENTRY_FILE" >&2
  exit 1
fi

if [[ ! -f "$MANIFEST_FILE" ]]; then
  echo "错误：构建已结束，但未生成扩展清单：$MANIFEST_FILE" >&2
  exit 1
fi

FILE_COUNT="$(find "$DIST_DIR" -type f | wc -l | tr -d '[:space:]')"
TOTAL_SIZE="$(du -sh "$DIST_DIR" | cut -f1)"
BUNDLE_SIZE="$(du -h "$ENTRY_FILE" | cut -f1)"

echo
echo ">>> 构建完成"
echo "    主文件：       $ENTRY_FILE"
echo "    主文件大小：   $BUNDLE_SIZE"
echo "    扩展清单：     $MANIFEST_FILE"
echo "    输出目录：     $DIST_DIR"
echo "    产物统计：     $FILE_COUNT 个文件，共 $TOTAL_SIZE"

if command -v wslpath >/dev/null 2>&1; then
  echo "    Windows 路径： $(wslpath -w "$DIST_DIR")"
fi

echo ">>> 请在浏览器中加载该目录作为“已解压的扩展程序”："
echo "    Chrome：打开 chrome://extensions -> 开启“开发者模式” -> 点击“加载已解压的扩展程序” -> 选择输出目录"
echo "    Edge：  打开 edge://extensions   -> 开启“开发者模式” -> 点击“加载已解压的扩展程序” -> 选择输出目录"
