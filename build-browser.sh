#!/usr/bin/env bash
# 浏览器/扩展构建入口：安装依赖 -> 类型检查 -> 构建 dist -> 校验产物。
# Windows 原生宿主与发布包请用 windows/native-source/build-windows.cmd 或 build-windows.sh。
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
  echo "请在当前环境安装 Node.js 20.19+ 或 22.12+ 后重新运行此脚本。" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "错误：未安装 npm，或 npm 不在 PATH 中。" >&2
  echo "请随 Node.js 一起安装 npm 后重新运行此脚本。" >&2
  exit 1
fi

NODE_PLATFORM="$(node -p 'process.platform')"
NODE_VERSION="$(node -p 'process.versions.node')"
if ! node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19);
  process.exit(supported ? 0 : 1);
'; then
  echo "错误：当前 Node.js 为 ${NODE_VERSION}。Vite 8 需要 Node.js 20.19+ 或 22.12+。" >&2
  echo "请在 WSL 中执行以下命令升级，并确保 node/npm 都来自 WSL：" >&2
  echo "  # 也可以使用 apt（Ubuntu/Debian）：" >&2
  echo "  sudo apt update && sudo apt install -y curl ca-certificates" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -" >&2
  echo "  sudo apt install -y nodejs" >&2
  echo "  hash -r && node --version && npm --version && command -v node && command -v npm" >&2
  echo "  # 或使用 nvm：" >&2
  echo "  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash" >&2
  echo "  source \"\$HOME/.nvm/nvm.sh\"" >&2
  echo "  nvm install 22 && nvm alias default 22 && nvm use 22" >&2
  echo "  hash -r && node --version && npm --version && command -v npm" >&2
  echo "确认 command -v npm 不再输出 /mnt/c/.../nodejs/npm 后，重新执行：" >&2
  echo "  ./build-browser.sh" >&2
  exit 1
fi

NPM_PATH="$(command -v npm)"
if [[ "$NODE_PLATFORM" == "linux" && "$NPM_PATH" == /mnt/* ]]; then
  echo "错误：当前使用的是 WSL/Linux Node.js ${NODE_VERSION}，但 npm 来自 Windows：${NPM_PATH}" >&2
  echo "请先执行：" >&2
  echo "  sudo apt update && sudo apt install -y curl ca-certificates" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -" >&2
  echo "  sudo apt install -y nodejs" >&2
  echo "  hash -r && command -v node && command -v npm" >&2
  echo "也可以使用 nvm：" >&2
  echo "  source \"\$HOME/.nvm/nvm.sh\" && nvm install 22 && nvm use 22" >&2
  echo "  hash -r && command -v node && command -v npm" >&2
  echo "确认 node/npm 都来自 \$HOME/.nvm 后，重新执行：" >&2
  echo "  ./build-browser.sh" >&2
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

if [[ "$DIST_DIR" == /mnt/[A-Za-z]/* ]] && command -v wslpath >/dev/null 2>&1; then
  WINDOWS_DIST_DIR="$(wslpath -w "$DIST_DIR" 2>/dev/null || true)"
  if [[ "$WINDOWS_DIST_DIR" == [A-Za-z]:\\* ]]; then
    echo "    Windows 路径： $WINDOWS_DIST_DIR"
  fi
fi

echo ">>> 请在浏览器中加载该目录作为“已解压的扩展程序”："
echo "    Chrome：打开 chrome://extensions -> 开启“开发者模式” -> 点击“加载已解压的扩展程序” -> 选择输出目录"
echo "    Edge：  打开 edge://extensions   -> 开启“开发者模式” -> 点击“加载已解压的扩展程序” -> 选择输出目录"

