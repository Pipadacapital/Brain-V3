#!/usr/bin/env bash
# ============================================================================
# dev-up.sh — ONE-COMMAND local bring-up (pnpm dev:up).
#
# A fresh clone → fully usable system in a single command. Each step is ordered,
# idempotent, and waits for what it depends on, so nothing races infra startup:
#
#   1. preflight   — ensure .env.local-prod exists (else copy the template)
#   2. infra       — docker compose up --wait (services report HEALTHY, not just created)
#   3. migrate     — apply DB migrations (APP_ENV=local-prod)
#   4. bootstrap   — seed LocalStack Secrets Manager + KMS (per-brand keyring/secrets)
#   5. refresh     — one-shot medallion refresh: builds Silver→Gold + the Trino serving
#                    views so dashboards render (honest empty state on a cold DB, not 500s)
#   6. apps        — start core + web + collector + stream-worker (APP_ENV=local-prod)
#
# Re-runnable: every step is safe to repeat. Ctrl-C after step 6 stops only the apps;
# `pnpm down` tears down the infra.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/.env.local-prod"
COMPOSE_PROFILES=(--profile core --profile ingest --profile lakehouse)

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

# ── 1. preflight ────────────────────────────────────────────────────────────
step "1/6 preflight — environment file"
if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$ROOT/.env.local-prod.example" ]; then
    cp "$ROOT/.env.local-prod.example" "$ENV_FILE"
    echo "  created .env.local-prod from the template — review it (OAuth app IDs/secrets are placeholders)."
  else
    echo "  ✗ .env.local-prod and its .example are both missing." >&2
    exit 1
  fi
else
  echo "  .env.local-prod present."
fi

# ── 2. infra (wait for HEALTHY) ─────────────────────────────────────────────
step "2/6 infra — docker compose up --wait"
docker compose "${COMPOSE_PROFILES[@]}" up -d --wait

# ── 3. migrate ──────────────────────────────────────────────────────────────
step "3/6 migrate — apply database migrations"
APP_ENV=local-prod pnpm migrate

# ── 4. bootstrap (LocalStack SM + KMS) ──────────────────────────────────────
step "4/6 bootstrap — seed LocalStack Secrets Manager + KMS"
pnpm bootstrap

# ── 5. one-shot medallion refresh (creates the Trino serving views) ─────────
step "5/6 refresh — one-shot Silver→Gold→Trino serving views"
ONESHOT=1 APP_ENV=local-prod pnpm dev:v4-refresh || \
  echo "  ⚠ refresh reported issues (often just an empty cold DB) — continuing; re-run 'pnpm dev:v4-refresh' anytime."

# ── 6. apps ─────────────────────────────────────────────────────────────────
step "6/6 apps — core + web + collector + stream-worker"
APP_ENV=local-prod turbo run dev \
  --filter=@brain/core --filter=@brain/web --filter=@brain/collector --filter=@brain/stream-worker
