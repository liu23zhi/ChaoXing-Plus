#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is not installed or not in PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is not installed or not in PATH." >&2
  exit 1
fi

echo ">>> Using Node: $(node --version)"
echo ">>> Using npm:  $(npm --version)"

if [[ -f package-lock.json ]]; then
  echo ">>> Installing dependencies with npm ci"
  npm ci
else
  echo ">>> Installing dependencies with npm install"
  npm install
fi

echo ">>> Running typecheck"
npm run typecheck

echo ">>> Building project"
npm run build

echo ">>> Build complete: dist/chaoxing-plus.js"
