#!/usr/bin/env bash
#
# pixel-named-tunnel.sh — bring up a STABLE NAMED cloudflared tunnel for the collector (:8787) so the
# pixel ScriptTag points at a FIXED hostname that never changes (ends the quick-tunnel churn where
# every restart rotates the trycloudflare URL and forces a pixel reinstall).
#
# Quick tunnel (pnpm dev:pixel-tunnel)  vs  NAMED tunnel (this):
#   - quick: zero setup, random *.trycloudflare.com URL, dies/rotates on restart → reinstall every time.
#   - named: one-time setup (you own the hostname), SAME hostname forever, survives restarts → install once.
#
# ── ONE-TIME PREREQUISITES (you must do these — they need YOUR Cloudflare account + a browser) ───────
#   1. A Cloudflare account with a DOMAIN added as a zone (e.g. brain.example.com). Free plan is fine.
#   2. Authorize this machine + pick the zone (opens a browser):
#          cloudflared tunnel login
#      → writes ~/.cloudflared/cert.pem. (In this Claude session you can run it via:  ! cloudflared tunnel login)
#
# ── THEN (this script — idempotent, safe to re-run) ──────────────────────────────────────────────────
#       PIXEL_HOSTNAME=events.yourdomain.com pnpm dev:pixel-named-tunnel
#   It will: create the tunnel (once), write ~/.cloudflared/config.yml (hostname → localhost:8787),
#   route the DNS CNAME, set PIXEL_INGEST_BASE_URL=https://<hostname> in .env.local-prod, then RUN it.
#   Keep it running (or install it as a service: `cloudflared service install`). Reinstall the pixel ONCE.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env.local-prod"
TUNNEL_NAME="${TUNNEL_NAME:-brain-pixel}"
COLLECTOR_PORT="${COLLECTOR_PORT:-8787}"
HOSTNAME="${PIXEL_HOSTNAME:-}"
CF_DIR="${HOME}/.cloudflared"
CONFIG="${CF_DIR}/config.yml"

command -v cloudflared >/dev/null 2>&1 || { echo "✗ cloudflared not found (brew install cloudflared)"; exit 1; }
[ -n "$HOSTNAME" ] || { echo "✗ PIXEL_HOSTNAME is required — e.g. PIXEL_HOSTNAME=events.yourdomain.com pnpm dev:pixel-named-tunnel"; exit 1; }
[ -f "${CF_DIR}/cert.pem" ] || { echo "✗ Not logged in — run:  cloudflared tunnel login  (authorizes your Cloudflare zone, writes cert.pem), then retry."; exit 1; }

echo "▶ ensuring named tunnel '${TUNNEL_NAME}' exists…"
if ! cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
  cloudflared tunnel create "$TUNNEL_NAME"
else
  echo "  tunnel '${TUNNEL_NAME}' already exists (reusing)."
fi

# Resolve the tunnel UUID + its credentials file (created by `tunnel create`).
TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n {print $1}' | head -1)"
[ -n "$TUNNEL_ID" ] || { echo "✗ could not resolve tunnel id for '${TUNNEL_NAME}'"; exit 1; }
CRED_FILE="${CF_DIR}/${TUNNEL_ID}.json"
[ -f "$CRED_FILE" ] || { echo "✗ credentials file ${CRED_FILE} not found (re-run after a clean 'tunnel create')"; exit 1; }

echo "▶ writing ${CONFIG} (ingress: ${HOSTNAME} → http://localhost:${COLLECTOR_PORT})…"
cat > "$CONFIG" <<YAML
# Brain pixel named tunnel — stable hostname → local collector. Managed by tools/dev/pixel-named-tunnel.sh.
tunnel: ${TUNNEL_ID}
credentials-file: ${CRED_FILE}
ingress:
  - hostname: ${HOSTNAME}
    service: http://localhost:${COLLECTOR_PORT}
  - service: http_status:404
YAML

echo "▶ routing DNS ${HOSTNAME} → tunnel ${TUNNEL_NAME} (idempotent)…"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" 2>&1 | sed 's/^/  /' || true   # already-routed is non-fatal

# Wire PIXEL_INGEST_BASE_URL idempotently (same convention as pixel-tunnel.sh).
URL="https://${HOSTNAME}"
if [ -f "$ENV_FILE" ]; then
  if grep -qE '^PIXEL_INGEST_BASE_URL=' "$ENV_FILE"; then
    tmp="$(mktemp)"; awk -v u="$URL" '/^PIXEL_INGEST_BASE_URL=/{print "PIXEL_INGEST_BASE_URL=" u; next} {print}' "$ENV_FILE" >"$tmp" && mv "$tmp" "$ENV_FILE"
  else
    printf '\nPIXEL_INGEST_BASE_URL=%s\n' "$URL" >>"$ENV_FILE"
  fi
  echo "✓ set PIXEL_INGEST_BASE_URL=${URL} in .env.local-prod"
fi

echo
echo "✓ named tunnel ready: ${URL}  →  localhost:${COLLECTOR_PORT}  (STABLE — survives restarts)"
echo "NEXT:  1) restart core (loads the new PIXEL_INGEST_BASE_URL)   2) Brain → Settings → Pixel → Reinstall (ONCE)"
echo "       3) browse the storefront. For 24/7 uptime instead of this foreground process: cloudflared service install"
echo
echo "▶ running tunnel (Ctrl-C to stop)…"
exec cloudflared tunnel run "$TUNNEL_NAME"
