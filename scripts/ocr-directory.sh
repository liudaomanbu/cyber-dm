#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "用法：scripts/ocr-directory.sh PDF目录 [输出.md]" >&2
  exit 2
fi

input_dir=$1
output=${2:-${input_dir%/}.ocr-bundle.md}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ ! -d "$input_dir" ]; then
  echo "找不到 PDF 目录：$input_dir" >&2
  exit 1
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/cyber-dm-ocr-dir.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM
first=$(find "$input_dir" -type f -iname '*.pdf' -print -quit)
if [ -z "$first" ]; then
  echo "目录中没有 PDF 文件。" >&2
  exit 1
fi

{
  printf '# OCR 合并草稿\n\n目录：%s\n\n' "$input_dir"
  index=0
  find "$input_dir" -type f -iname '*.pdf' | sort | while IFS= read -r file; do
    index=$((index + 1))
    part="$work/$index.md"
    "$script_dir/ocr-pdf.sh" "$file" "$part" >/dev/null
    printf '\n\n## 文件：%s\n\n' "$file"
    cat "$part"
  done
} > "$output"

echo "已写入 $output；这是待人工核对的 OCR 材料，不会自动发布。"
