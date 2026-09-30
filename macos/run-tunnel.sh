#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# -eq 5 ]] || exit 64
KEY_FILE="$1"
export TUNNEL_CLIENT_PROFILE_DIR="$2"
TUNNEL_CLIENT="$3"
PROFILE="$4"
ORIGIN_ACCOUNT="$5"
[[ -r "$KEY_FILE" ]] || exit 66
export CONTROL_PLANE_API_KEY="$(head -n 1 "$KEY_FILE" | tr -d '\r\n')"
[[ -n "$CONTROL_PLANE_API_KEY" ]] || exit 66
if [[ "$ORIGIN_ACCOUNT" =~ ^[0-9a-f]{64}$ ]]; then
  exec "$TUNNEL_CLIENT" run --profile "$PROFILE" --mcp.extra-headers "X-Chat-Bridge-Origin-Account: $ORIGIN_ACCOUNT"
fi
exec "$TUNNEL_CLIENT" run --profile "$PROFILE" --mcp.extra-headers "X-Chat-Bridge-Origin-Space: $ORIGIN_ACCOUNT"
