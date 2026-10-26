#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
if [ ! -f .data/cloudflared.yml ]; then
  echo "缺少 .data/cloudflared.yml；请先完成 Cloudflare 域名授权和命名隧道配置。" >&2
  exit 1
fi
if [ -x .data/bin/cloudflared ]; then
  tunnel_binary=.data/bin/cloudflared
else
  tunnel_binary=$(command -v cloudflared || true)
fi
if [ -z "$tunnel_binary" ]; then
  echo "请先安装 Cloudflare 官方 cloudflared 客户端。" >&2
  exit 1
fi
exec "$tunnel_binary" tunnel --config .data/cloudflared.yml run cyber-dm
