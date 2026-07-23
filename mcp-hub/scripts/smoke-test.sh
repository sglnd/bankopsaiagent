#!/usr/bin/env bash
# Validate all enabled endpoints with an MCP initialize request.
set -euo pipefail

cd "$(dirname "$0")/.."

timeout_seconds="${SMOKE_TEST_TIMEOUT_SECONDS:-90}"
protocol_version="${MCP_PROTOCOL_VERSION:-2025-03-26}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for the MCP smoke test." >&2
  exit 1
fi

declare -a endpoints=(
  "playwright:${PLAYWRIGHT_PORT:-8931}"
  "filesystem:${FILESYSTEM_PORT:-8932}"
  "git:${GIT_PORT:-8933}"
)

initialize() {
  local name="$1"
  local port="$2"
  local deadline=$((SECONDS + timeout_seconds))
  local body

  while (( SECONDS < deadline )); do
    body="$(curl --silent --show-error --max-time 10 \
      --request POST "http://127.0.0.1:${port}/mcp" \
      --header 'Accept: application/json, text/event-stream' \
      --header 'Content-Type: application/json' \
      --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"${protocol_version}\",\"capabilities\":{},\"clientInfo\":{\"name\":\"bankops-smoke-test\",\"version\":\"1.0.0\"}}}" \
      --write-out '\n%{http_code}' 2>/dev/null || true)"

    if [[ "$body" == *$'\n200' ]] && [[ "$body" == *'"result"'* ]]; then
      echo "${name}: MCP initialization succeeded"
      return 0
    fi
    sleep 2
  done

  echo "${name}: MCP initialization did not succeed within ${timeout_seconds}s." >&2
  printf '%s\n' "$body" >&2
  return 1
}

for endpoint in "${endpoints[@]}"; do
  IFS=: read -r name port <<<"$endpoint"
  initialize "$name" "$port"
done
