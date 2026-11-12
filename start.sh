#!/usr/bin/env bash
# 知识拓扑 · 本机网关启动脚本（macOS / Linux）
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  没找到 Node.js。先装 Node.js 18 或更新版本：https://nodejs.org"
  echo ""
  exit 1
fi

exec node gateway.js --open "$@"
