#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "用法：scripts/ocr-pdf.sh 输入.pdf [输出.txt]" >&2
  exit 2
fi

input=$1
output=${2:-${input%.*}.ocr.txt}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runtime_root=${CYBER_DM_RUNTIME_ROOT:-/Users/caotc/.cache/codex-runtimes/codex-primary-runtime/dependencies}
pdftoppm=${CYBER_DM_PDFTOPPM:-$runtime_root/bin/override/pdftoppm}

if ! command -v swift >/dev/null 2>&1; then
  echo "当前系统没有 Swift；请在支持 Vision 的 macOS 上运行。" >&2
  exit 1
fi
if [ ! -x "$pdftoppm" ]; then
  pdftoppm=$(command -v pdftoppm || true)
fi
if [ -z "$pdftoppm" ] || [ ! -x "$pdftoppm" ]; then
  echo "找不到 pdftoppm；请安装 Poppler，或设置 CYBER_DM_PDFTOPPM。" >&2
  exit 1
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/cyber-dm-ocr.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM
binary="$work/vision-ocr"
swiftc "$script_dir/vision-ocr.swift" -o "$binary"
"$pdftoppm" -jpeg -r "${CYBER_DM_OCR_DPI:-160}" "$input" "$work/page" >/dev/null

{
  printf '# OCR 草稿\n\n文件：%s\n\n' "$input"
  page=0
  for image in "$work"/page-*.jpg; do
    page=$((page + 1))
    printf '\n===== 第 %s 页 =====\n' "$page"
    "$binary" "$image"
  done
} > "$output"
echo "已写入 $output；这是待人工核对的 OCR 材料，不会自动发布。"
