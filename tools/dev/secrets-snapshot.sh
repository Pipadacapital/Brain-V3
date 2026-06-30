#!/usr/bin/env bash
#
# secrets-snapshot.sh — make connector OAuth tokens DURABLE across Docker restarts in prod-local dev.
#
# WHY: in prod-local mode (NODE_ENV=production, .env.local-prod) the app stores connector access
# tokens (Shopify/Meta/GoKwik/Shiprocket) + app secrets in LocalStack Secrets Manager. LocalStack
# *community* does NOT persist Secrets Manager across container restarts (PERSISTENCE is Pro-only and
# silently ignored — verified), so every Docker restart wipes them → core crashes on the missing
# brain/cookie-secret AND pixel-install / connector repulls 500 on the missing tokens, forcing a
# reconnect of every connector.
#
# FIX: mirror the live Secrets Manager state into PG `dev_secret` (which lives on a persistent volume).
# `pnpm bootstrap` ALREADY restores `dev_secret → Secrets Manager` on every run (the "reconnect" step),
# so once snapshotted, a Docker restart is recovered by re-running bootstrap — NO reconnect needed.
#
# USAGE:
#   1. Connect your connectors in the UI (OAuth) ONCE — tokens land in LocalStack.
#   2. pnpm dev:secrets-snapshot        # captures them into PG dev_secret
#   After any later Docker restart: pnpm bootstrap  (restores dev_secret → Secrets Manager). Done.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LS_ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:4566}"
PG_CONTAINER="${PG_CONTAINER:-brainv3-postgres-1}"
PG_USER="${PG_USER:-brain}"
PG_DB="${PG_DB:-brain}"

awsl() { AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 aws --endpoint-url="$LS_ENDPOINT" "$@"; }

command -v aws >/dev/null 2>&1 || { echo "✗ aws CLI not found"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$LS_ENDPOINT/_localstack/health")" = "200" ] \
  || { echo "✗ LocalStack not reachable at $LS_ENDPOINT"; exit 1; }
docker inspect "$PG_CONTAINER" >/dev/null 2>&1 || { echo "✗ postgres container '$PG_CONTAINER' not found"; exit 1; }

names="$(awsl secretsmanager list-secrets --query 'SecretList[].Name' --output text 2>/dev/null | tr '\t' '\n' | grep -vE '^$' || true)"
[ -n "$names" ] || { echo "ℹ no secrets in LocalStack to snapshot (connect a connector first)."; exit 0; }

count=0
while IFS= read -r name; do
  [ -n "$name" ] || continue
  val="$(awsl secretsmanager get-secret-value --secret-id "$name" --query SecretString --output text 2>/dev/null || true)"
  [ -n "$val" ] && [ "$val" != "None" ] || { echo "  · skip $name (no SecretString)"; continue; }
  # Upsert by PK(name). base64-encode name+value so arbitrary token contents (quotes, slashes,
  # newlines) can't break quoting/injection; decode back in SQL. psql interpolates :'var' from
  # stdin (NOT from -c, in this build), so feed the script via heredoc and set vars with \set.
  nb64="$(printf '%s' "$name" | base64 | tr -d '\n')"
  vb64="$(printf '%s' "$val"  | base64 | tr -d '\n')"
  docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -q -v ON_ERROR_STOP=1 <<SQL || { echo "✗ failed upsert for $name"; exit 1; }
\set n '$nb64'
\set v '$vb64'
INSERT INTO dev_secret (name, secret_value, created_at, updated_at)
VALUES (convert_from(decode(:'n','base64'),'UTF8'), convert_from(decode(:'v','base64'),'UTF8'), now(), now())
ON CONFLICT (name) DO UPDATE SET secret_value = EXCLUDED.secret_value, updated_at = now();
SQL
  echo "  ✓ $name"
  count=$((count + 1))
done <<< "$names"

echo "✓ snapshotted $count secret(s) → PG dev_secret. They now survive Docker restarts (restore via: pnpm bootstrap)."
