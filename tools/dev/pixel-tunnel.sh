#!/usr/bin/env bash
#
# pixel-tunnel.sh — start a cloudflared quick tunnel to the local COLLECTOR (:8787) and wire its
# public URL into PIXEL_INGEST_BASE_URL in .env.local-prod, so the storefront pixel on a real site
# can reach your local Brain.
#
# WHY :8787 (not :3001)?  The pixel asset (/pixel.js) + the ingest endpoint (/collect) are on the
# COLLECTOR. The repo's `dev:tunnel` (→ :3001/core) is for connector WEBHOOKS, a different surface.
#
# Quick tunnels are EPHEMERAL — the trycloudflare URL changes on every start. After running this:
#   1. restart core + collector so they pick up the new PIXEL_INGEST_BASE_URL, then
#   2. RE-INSTALL the pixel from Brain (Settings → Pixel → Reinstall) so the Shopify ScriptTag's
#      src is re-pointed to the new URL (the install command deletes the stale tag + creates a fresh
#      one). Until re-installed, the storefront keeps loading the OLD (dead) pixel URL.
# Keep this process RUNNING — the URL holds only while cloudflared is up.
#
# Usage:  pnpm dev:pixel-tunnel        (Ctrl-C to stop)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env.local-prod"
COLLECTOR_PORT="${COLLECTOR_PORT:-8787}"
LOG="$(mktemp -t brain-pixel-tunnel)"

command -v cloudflared >/dev/null 2>&1 || { echo "✗ cloudflared not found on PATH (brew install cloudflared)"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "✗ $ENV_FILE not found"; exit 1; }

echo "▶ starting cloudflared quick tunnel → http://localhost:$COLLECTOR_PORT …"
cloudflared tunnel --url "http://localhost:$COLLECTOR_PORT" >"$LOG" 2>&1 &
CF_PID=$!
trap 'kill "$CF_PID" 2>/dev/null || true' EXIT INT TERM

# Wait (up to ~30s) for the assigned trycloudflare URL to appear in the log.
URL=""
for _ in $(seq 1 30); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "✗ tunnel URL not assigned within 30s — see $LOG"; exit 1; }

# Update (or append) PIXEL_INGEST_BASE_URL in .env.local-prod, idempotently.
if grep -qE '^PIXEL_INGEST_BASE_URL=' "$ENV_FILE"; then
  tmp="$(mktemp)"; awk -v u="$URL" '/^PIXEL_INGEST_BASE_URL=/{print "PIXEL_INGEST_BASE_URL=" u; next} {print}' "$ENV_FILE" >"$tmp" && mv "$tmp" "$ENV_FILE"
else
  printf '\nPIXEL_INGEST_BASE_URL=%s\n' "$URL" >>"$ENV_FILE"
fi

echo "✓ tunnel up: $URL  →  localhost:$COLLECTOR_PORT"
echo "✓ wrote PIXEL_INGEST_BASE_URL=$URL to .env.local-prod"
echo
echo "NEXT:  1) restart core + collector to load the new URL"
echo "       2) Brain → Settings → Pixel → Reinstall (re-points the Shopify ScriptTag)"
echo "Keep this running. Ctrl-C stops the tunnel."
wait "$CF_PID"
