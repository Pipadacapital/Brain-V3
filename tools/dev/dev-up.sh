#!/usr/bin/env bash
# ============================================================================
# dev-up.sh — ONE-COMMAND local bring-up (pnpm dev:up).
#
# A fresh clone → fully usable system in a single command. Each step is ordered,
# idempotent, and waits for what it depends on, so nothing races infra startup:
#
#   1. preflight   — ensure .env.local-prod exists (else copy the template)
#   2. db          — bring up Postgres alone (--wait) so migrations can run first
#   3. migrate     — apply DB migrations (APP_ENV=local-prod) before anything reads PG
#   4. infra       — docker compose up the rest (core+ai profiles) and poll until healthy
#   5. bootstrap   — seed LocalStack Secrets Manager + KMS (per-brand keyring/secrets)
#   6. refresh     — one-shot medallion refresh: builds Silver→Gold so dashboards render
#                    (honest empty state on a cold DB, not 500s); the serving views live in
#                    the duckdb-serving container, which applies them at startup (ADR-0014)
#   7. apps        — start core + web + collector + stream-worker (APP_ENV=local-prod)
#
# Bronze landing is the compose kafka-connect service (ADR-0010) — it comes up with the infra
# step; there is no host-run Spark sink to launch anymore.
#
# Re-runnable: every step is safe to repeat. Ctrl-C after the last step stops only the apps;
# `pnpm down` tears down the infra.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/.env.local-prod"
# core now folds in the old ingest + lakehouse infra (kafka/apicurio/minio/iceberg/duckdb-serving)
# plus the kafka-connect Bronze landing writer (ADR-0010); `ai` adds litellm.
COMPOSE_PROFILES=(--profile core --profile ai)

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

# compose_up_healthy — bring the stack up and block until it is genuinely healthy.
# Shared implementation (also used by .github/workflows/integration.yml, which hit the
# same `--wait` one-shot-exit gotcha this helper exists for): tools/dev/compose-up-healthy.sh.
compose_up_healthy() {
  bash tools/dev/compose-up-healthy.sh "${COMPOSE_PROFILES[@]}"
}

# ── 1. preflight ────────────────────────────────────────────────────────────
step "1/7 preflight — environment file"
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

# ── 2. db first (wait for HEALTHY) ──────────────────────────────────────────
# Bring up ONLY Postgres (+ its deps) so step 3 can migrate before the rest of the
# stack (apps, refresh jobs) reads PG — a cold, un-migrated DB stays deterministic.
step "2/7 db — Postgres up (so migrations run before anything reads PG)"
docker compose "${COMPOSE_PROFILES[@]}" up -d --wait postgres

# ── 3. migrate ──────────────────────────────────────────────────────────────
# node-pg-migrate needs DATABASE_URL, which lives in .env.local-prod (it does NOT
# auto-load that filename). Source it in a SUBSHELL so the env — notably
# NODE_ENV=production — does NOT leak into the apps step: `next dev` (web) must run
# with NODE_ENV!=production or its edge middleware crash-loops ("Code generation from
# strings disallowed"). The backend apps self-load .env.local-prod via tsx --env-file,
# so they still get NODE_ENV=production (→ prod.* topics) regardless of this subshell.
step "3/7 migrate — apply database migrations"
( set -a; . "$ENV_FILE"; set +a; APP_ENV=local-prod pnpm migrate )

# ── 4. infra — the rest of the stack (poll until HEALTHY) ───────────────────
step "4/7 infra — bring up remaining services (core+ai) and poll health"
compose_up_healthy

# Bronze landing is the compose kafka-connect service (ADR-0010) — nothing to launch on the host.

# ── 5. bootstrap (LocalStack SM + KMS) ──────────────────────────────────────
step "5/7 bootstrap — seed LocalStack Secrets Manager + KMS"
pnpm bootstrap

# ── 6. one-shot medallion refresh (Silver→Gold; serving views apply in duckdb-serving) ──
# Spark→DuckDB cutover: the refresh is now tools/dev/duckdb-refresh.sh (via `pnpm dev:v4-refresh`),
# which runs the DuckDB transform jobs (db/iceberg/duckdb/**) with the host python venv. The DuckDB
# jobs read the env the caller exports (S3_ENDPOINT / ICEBERG_* / AWS_* / NEO4J_URI) — see the
# duckdb-refresh.sh header for the exact contract. ONESHOT is a no-op here (the DuckDB refresh always
# runs a single pass); it is kept for call-site compatibility with the old loop.
step "6/7 refresh — one-shot Silver→Gold (duckdb-serving picks up new snapshots on its next epoch)"
# The DuckDB jobs run on the HOST, so the compose-network endpoints/creds must be the
# host-side ones: MinIO on localhost:9000 (brain/brainbrain — NOT LocalStack's test/test
# from .env.local-prod) and the REST catalog on localhost:8181. Source $ENV_FILE first
# (NEO4J_* etc.), then pin the lakehouse contract on top, all in a subshell so nothing
# leaks into step 7's app env.
( set -a; . "$ENV_FILE"; set +a; \
  export S3_ENDPOINT="http://localhost:9000" \
         ICEBERG_REST_URI="http://localhost:8181" \
         ICEBERG_WAREHOUSE="s3://brain-bronze/" \
         AWS_ACCESS_KEY_ID="brain" AWS_SECRET_ACCESS_KEY="brainbrain"; \
  ONESHOT=1 APP_ENV=local-prod pnpm dev:v4-refresh ) || \
  echo "  ⚠ refresh reported issues (often just an empty cold DB) — continuing; re-run 'pnpm dev:v4-refresh' anytime."

# ── 7. apps ─────────────────────────────────────────────────────────────────
step "7/7 apps — core + web + collector + stream-worker"
APP_ENV=local-prod turbo run dev \
  --filter=@brain/core --filter=@brain/web --filter=@brain/collector --filter=@brain/stream-worker
