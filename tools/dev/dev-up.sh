#!/usr/bin/env bash
# ============================================================================
# dev-up.sh — ONE-COMMAND local bring-up (pnpm dev:up).
#
# A fresh clone → fully usable system in a single command. Each step is ordered,
# idempotent, and waits for what it depends on, so nothing races infra startup:
#
#   1. preflight   — ensure .env.local-prod exists (else copy the template)
#   2. db          — bring up Postgres alone (--wait) so migrations can run first
#   3. migrate     — apply DB migrations (APP_ENV=local-prod) BEFORE any Spark sink starts
#   4. infra       — docker compose up --wait the rest (incl. lakehouse Spark sinks)
#   5. bootstrap   — seed LocalStack Secrets Manager + KMS (per-brand keyring/secrets)
#   6. refresh     — one-shot medallion refresh: builds Silver→Gold + the Trino serving
#                    views so dashboards render (honest empty state on a cold DB, not 500s)
#   7. apps        — start core + web + collector + stream-worker (APP_ENV=local-prod)
#
# WHY db-then-migrate-then-infra (not infra-then-migrate): the Spark Bronze materializer
# (spark-bronze-sink) reads PG tables (e.g. pixel.pixel_installation) over JDBC at startup.
# On a cold, un-migrated DB those relations don't exist yet, so the sink crash-loops and a
# single `docker compose up --wait` over the whole stack NEVER converges (the sink never
# reports healthy). Migrating before the sink is created makes the cold start deterministic.
#
# Re-runnable: every step is safe to repeat. Ctrl-C after the last step stops only the apps;
# `pnpm down` tears down the infra.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/.env.local-prod"
COMPOSE_PROFILES=(--profile core --profile ingest --profile lakehouse)

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

# compose_up_healthy — bring the stack up and block until it is genuinely healthy.
#
# We deliberately do NOT use `docker compose up --wait`: it aborts with a non-zero exit
# when a one-shot init container (minio-init, iceberg-catalog-init, jmx-exporter-init,
# redpanda-init) exits 0 *during* the wait window — which is exactly what happens on a
# cold start. Instead we `up -d` and poll health ourselves, which is deterministic and
# independent of the compose implementation's --wait semantics. A service is "good" when
# it is running-and-(healthy | has-no-healthcheck) or has exited 0 (a completed one-shot).
compose_up_healthy() {
  docker compose "${COMPOSE_PROFILES[@]}" up -d
  local deadline=$((SECONDS + 360)) bad
  while :; do
    bad=$(docker compose "${COMPOSE_PROFILES[@]}" ps -a \
            --format '{{.Service}}\t{{.State}}\t{{.Health}}\t{{.ExitCode}}' \
          | awk -F'\t' '
              $2=="running" && ($3=="" || $3=="healthy") { next }
              $2=="exited"  && $4=="0"                    { next }
              { print $1" ("$2" "$3" exit="$4")" }')
    [ -z "$bad" ] && { echo "  all services healthy."; return 0; }
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "  ✗ services not healthy after 360s:" >&2
      printf '    %s\n' "$bad" >&2
      return 1
    fi
    sleep 3
  done
}

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

# ── 2. db first (wait for HEALTHY) ──────────────────────────────────────────
# Bring up ONLY Postgres (+ its deps) so step 3 can migrate before any Spark sink
# starts reading PG. Without this, spark-bronze-sink crash-loops on the un-migrated
# DB and the full `--wait` in step 4 never converges.
step "2/7 db — Postgres up (so migrations run before Spark sinks)"
docker compose "${COMPOSE_PROFILES[@]}" up -d --wait postgres

# ── 3. migrate ──────────────────────────────────────────────────────────────
# node-pg-migrate needs DATABASE_URL, which lives in .env.local-prod (it does NOT
# auto-load that filename). Source it in a SUBSHELL so the env — notably
# NODE_ENV=production — does NOT leak into the apps step: `next dev` (web) must run
# with NODE_ENV!=production or its edge middleware crash-loops ("Code generation from
# strings disallowed"). The backend apps self-load .env.local-prod via tsx --env-file,
# so they still get NODE_ENV=production (→ prod.* topics) regardless of this subshell.
step "3/7 migrate — apply database migrations (before Spark sinks read PG)"
( set -a; . "$ENV_FILE"; set +a; APP_ENV=local-prod pnpm migrate )

# ── 4. infra — the rest of the stack (poll until HEALTHY) ───────────────────
step "4/7 infra — bring up remaining services (incl. Spark sinks) and poll health"
compose_up_healthy

# ── 5. bootstrap (LocalStack SM + KMS) ──────────────────────────────────────
step "5/7 bootstrap — seed LocalStack Secrets Manager + KMS"
pnpm bootstrap

# ── 6. one-shot medallion refresh (creates the Trino serving views) ─────────
# Same subshell-scoping as migrate: the identity-export step is a Node process that reads
# BRAIN_APP_DATABASE_URL / TRINO_* / NEO4J_* from the env, so source .env.local-prod — but
# keep NODE_ENV=production out of the apps step's shell (see step 3).
step "6/7 refresh — one-shot Silver→Gold→Trino serving views"
( set -a; . "$ENV_FILE"; set +a; ONESHOT=1 APP_ENV=local-prod pnpm dev:v4-refresh ) || \
  echo "  ⚠ refresh reported issues (often just an empty cold DB) — continuing; re-run 'pnpm dev:v4-refresh' anytime."

# ── 7. apps ─────────────────────────────────────────────────────────────────
step "7/7 apps — core + web + collector + stream-worker"
APP_ENV=local-prod turbo run dev \
  --filter=@brain/core --filter=@brain/web --filter=@brain/collector --filter=@brain/stream-worker
