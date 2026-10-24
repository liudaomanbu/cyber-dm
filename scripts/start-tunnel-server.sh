#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
if [ ! -f .data/deployment.env ]; then
  echo "缺少 .data/deployment.env；请按 docs/deployment.md 配置公网来源和访问口令。" >&2
  exit 1
fi
if [ ! -f dist/index.html ]; then
  echo "请先运行 npm run build。" >&2
  exit 1
fi
exec node --env-file=.data/deployment.env --import tsx src/server/index.ts
