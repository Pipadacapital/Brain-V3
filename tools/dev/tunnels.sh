#!/usr/bin/env bash
#
# tunnels.sh — start cloudflared quick tunnels for ALL local Brain endpoints and print their
# public HTTPS URLs:
#
#     web        :3000   (Next.js app/UI)
#     core       :3001   (BFF / connector webhooks)
#     collector  :8787   (pixel asset + /collect ingest)
#
# Quick tunnels are EPHEMERAL — each trycloudflare URL changes on every start, and holds only
# while this process is running. Keep it running; Ctrl-C tears all three down.
#
# Usage:  pnpm dev:tunnels            (Ctrl-C to stop)
#         PORTS="3000 3001" pnpm dev:tunnels   (subset)
set -euo pipefail

# label:port pairs to expose (override with PORTS="3000 3001" for a subset).
declare -a TARGETS=("web:3000" "core:3001" "collector:8787")
if [ -n "${PORTS:-}" ]; then
  TARGETS=()
  for p in $PORTS; do
    case "$p" in
      3000) TARGETS+=("web:3000") ;;
      3001) TARGETS+=("core:3001") ;;
      8787) TARGETS+=("collector:8787") ;;
      *)    TARGETS+=("port-$p:$p") ;;
    esac
  done
fi

command -v cloudflared >/dev/null 2>&1 || { echo "✗ cloudflared not found on PATH (brew install cloudflared)"; exit 1; }

SUMMARY="${SUMMARY:-/tmp/brain-tunnels.txt}"
: > "$SUMMARY"
declare -a PIDS=()
cleanup() { for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

printf '\n\033[1;36m▶ starting %d cloudflared quick tunnel(s)…\033[0m\n' "${#TARGETS[@]}"

for t in "${TARGETS[@]}"; do
  label="${t%%:*}"; port="${t##*:}"
  log="$(mktemp -t "brain-tunnel-$label")"
  cloudflared tunnel --url "http://localhost:$port" >"$log" 2>&1 &
  PIDS+=("$!")

  url=""
  for _ in $(seq 1 30); do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)"
    [ -n "$url" ] && break
    sleep 1
  done
  if [ -n "$url" ]; then
    printf '  \033[1;32m✓\033[0m %-10s %s  →  localhost:%s\n' "$label" "$url" "$port"
    printf '%s\t%s\tlocalhost:%s\n' "$label" "$url" "$port" >> "$SUMMARY"
  else
    printf '  \033[1;31m✗\033[0m %-10s tunnel URL not assigned within 30s — see %s\n' "$label" "$log"
  fi
done

echo
echo "Summary written to $SUMMARY. Keep this process running; Ctrl-C stops all tunnels."
wait
