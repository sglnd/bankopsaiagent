#!/usr/bin/env bash
set -euo pipefail
archive="${1:-exports/bankops-mcp-images.tar}"
if [[ ! -f "$archive" ]]; then
  echo "Image archive not found: $archive" >&2
  exit 1
fi
docker load --input "$archive"
