#!/usr/bin/env bash
#
# pixel-ngrok-tunnel.sh — STABLE pixel ingest via ngrok's FREE static domain (no domain ownership, $0).
#
# Unlike `dev:pixel-tunnel` (cloudflared quick tunnel — random URL that rotates every restart and forces
# a pixel reinstall), ngrok's free tier gives ONE static domain (e.g. brain-pixel.ngrok-free.app) that is
# the SAME forever → install the pixel ONCE. This points that fixed hostname at the local collector (:8787).
#
# ── ONE-TIME (free, no payment) ──────────────────────────────────────────────────────────────────────
#   1. Create a free ngrok account:            https://dashboard.ngrok.com/signup
#   2. Copy your authtoken (Getting Started → Your Authtoken) and register it on this machine:
#          ngrok config add-authtoken <YOUR_TOKEN>
#   3. Claim your free static domain (Domains → "+ New Domain" gives one free *.ngrok-free.app):
#          e.g. brain-pixel.ngrok-free.app
#
# ── THEN (this script — idempotent) ──────────────────────────────────────────────────────────────────
#       PIXEL_NGROK_DOMAIN=brain-pixel.ngrok-free.app pnpm dev:pixel-ngrok-tunnel
#   Sets PIXEL_INGEST_BASE_URL=https://<domain> in .env.local-prod, then runs the tunnel. Keep it running.
#   Reinstall the pixel ONCE (Brain → Settings → Pixel → Reinstall) — the hostname never changes again.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env.local-prod"
COLLECTOR_PORT="${COLLECTOR_PORT:-8787}"
DOMAIN="${PIXEL_NGROK_DOMAIN:-}"

command -v ngrok >/dev/null 2>&1 || { echo "✗ ngrok not found (brew install ngrok)"; exit 1; }
[ -n "$DOMAIN" ] || { echo "✗ PIXEL_NGROK_DOMAIN is required — e.g. PIXEL_NGROK_DOMAIN=brain-pixel.ngrok-free.app pnpm dev:pixel-ngrok-tunnel"; exit 1; }
# Authtoken check — ngrok stores it in its config; a missing one fails the tunnel with a clear ngrok error,
# but we pre-flight for a friendlier message.
if ! ngrok config check >/dev/null 2>&1 && [ -z "${NGROK_AUTHTOKEN:-}" ]; then
  echo "✗ ngrok not authenticated — run:  ngrok config add-authtoken <YOUR_TOKEN>  (free, from dashboard.ngrok.com), then retry."
  exit 1
fi

URL="https://${DOMAIN}"
if [ -f "$ENV_FILE" ]; then
  if grep -qE '^PIXEL_INGEST_BASE_URL=' "$ENV_FILE"; then
    tmp="$(mktemp)"; awk -v u="$URL" '/^PIXEL_INGEST_BASE_URL=/{print "PIXEL_INGEST_BASE_URL=" u; next} {print}' "$ENV_FILE" >"$tmp" && mv "$tmp" "$ENV_FILE"
  else
    printf '\nPIXEL_INGEST_BASE_URL=%s\n' "$URL" >>"$ENV_FILE"
  fi
  echo "✓ set PIXEL_INGEST_BASE_URL=${URL} in .env.local-prod"
fi

echo
echo "✓ stable ngrok hostname: ${URL}  →  localhost:${COLLECTOR_PORT}  (FREE, survives restarts)"
echo "NEXT (once):  1) restart core (load new PIXEL_INGEST_BASE_URL)  2) Brain → Settings → Pixel → Reinstall  3) browse the storefront"
echo
echo "▶ running ngrok (Ctrl-C to stop; keep it up while testing)…"
exec ngrok http "$COLLECTOR_PORT" --domain="$DOMAIN" --log=stdout
