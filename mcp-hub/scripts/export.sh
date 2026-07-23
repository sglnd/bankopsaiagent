#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p exports
docker compose build
images=(bankops/playwright-mcp:local bankops/filesystem-mcp:local bankops/git-mcp:local)
if [[ "${INCLUDE_SSH_TEMPLATE:-false}" == "true" ]]; then
  docker compose --profile ssh build ssh-mcp
  images+=(bankops/ssh-mcp-template:local)
fi
docker save --output exports/bankops-mcp-images.tar "${images[@]}"
echo "Exported exports/bankops-mcp-images.tar"
