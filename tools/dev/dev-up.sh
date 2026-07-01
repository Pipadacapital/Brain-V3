#!/usr/bin/env bash
# ============================================================================
# dev-up.sh — ONE-COMMAND local bring-up (pnpm dev:up).
#
# A fresh clone → fully usable system in a single command. Each step is ordered,
# idempotent, and waits for what it depends on, so nothing races infra startup:
#
#   1. preflight   — ensure .env.local-prod exists (else copy the template)
#   2. db          — bring up Postgres alone (--wait) so migrations can run first
#   3. migrate     — apply DB migrations (APP_ENV=local-prod) BEFORE the Bronze sink reads PG
#   4. infra       — docker compose up the rest (core+ai profiles) and poll until healthy
#   5. bronze      — start the host combined Bronze streaming sink (replaces the 2 removed
#                    spark-bronze-sink containers); backgrounded, logs to /tmp/bronze-sink.log
#   6. bootstrap   — seed LocalStack Secrets Manager + KMS (per-brand keyring/secrets)
#   7. refresh     — one-shot medallion refresh: builds Silver→Gold + the Trino serving
#                    views so dashboards render (honest empty state on a cold DB, not 500s)
#   8. apps        — start core + web + collector + stream-worker (APP_ENV=local-prod)
#
# WHY db-then-migrate-then-bronze (not bronze-then-migrate): the combined Bronze sink's collector
# lane reads PG tables (e.g. pixel.pixel_installation) over JDBC for the R2 install_token→brand
# lookup. On a cold, un-migrated DB those relations don't exist yet, so the sink errors. Migrating
# before the sink starts makes the cold start deterministic.
#
# Re-runnable: every step is safe to repeat. Ctrl-C after the last step stops only the apps;
# `pnpm down` tears down the infra.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/.env.local-prod"
# core now folds in the old ingest + lakehouse infra (kafka/apicurio/minio/iceberg/trino); `ai` adds
# litellm. The Bronze Spark sinks are NO LONGER compose containers — they run as one host process
# (tools/dev/dev-bronze-streaming.sh), started in step 5 below.
COMPOSE_PROFILES=(--profile core --profile ai)

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

# compose_up_healthy — bring the stack up and block until it is genuinely healthy.
#
# We deliberately do NOT use `docker compose up --wait`: it aborts with a non-zero exit
# when a one-shot init container (minio-init, iceberg-catalog-init, jmx-exporter-init,
# kafka-init) exits 0 *during* the wait window — which is exactly what happens on a
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
step "1/8 preflight — environment file"
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
# Bring up ONLY Postgres (+ its deps) so step 3 can migrate before the Bronze sink
# starts reading PG (step 5). Without this, the sink's collector lane errors on the
# un-migrated DB (missing pixel.pixel_installation for the R2 install_token lookup).
step "2/8 db — Postgres up (so migrations run before the Bronze sink reads PG)"
docker compose "${COMPOSE_PROFILES[@]}" up -d --wait postgres

# ── 3. migrate ──────────────────────────────────────────────────────────────
# node-pg-migrate needs DATABASE_URL, which lives in .env.local-prod (it does NOT
# auto-load that filename). Source it in a SUBSHELL so the env — notably
# NODE_ENV=production — does NOT leak into the apps step: `next dev` (web) must run
# with NODE_ENV!=production or its edge middleware crash-loops ("Code generation from
# strings disallowed"). The backend apps self-load .env.local-prod via tsx --env-file,
# so they still get NODE_ENV=production (→ prod.* topics) regardless of this subshell.
step "3/8 migrate — apply database migrations (before the Bronze sink reads PG)"
( set -a; . "$ENV_FILE"; set +a; APP_ENV=local-prod pnpm migrate )

# ── 4. infra — the rest of the stack (poll until HEALTHY) ───────────────────
step "4/8 infra — bring up remaining services (core+ai) and poll health"
compose_up_healthy

# ── 5. bronze — host combined Bronze streaming sink ─────────────────────────
# The two spark-bronze-sink containers were removed; the equivalent now runs as ONE host process
# (docker-run apache/spark, sharing the kafka container's netns). Start it backgrounded so ingestion
# lands collector + connector events into Iceberg Bronze while the rest of bring-up continues.
step "5/8 bronze — start host combined Bronze streaming sink (backgrounded)"
if pgrep -f "bronze_landing.py" >/dev/null 2>&1; then
  echo "  combined Bronze sink already running — leaving it."
else
  nohup bash "$ROOT/tools/dev/dev-bronze-streaming.sh" > /tmp/bronze-sink.log 2>&1 &
  echo "  started (pid $!); logs → /tmp/bronze-sink.log"
fi

# ── 6. bootstrap (LocalStack SM + KMS) ──────────────────────────────────────
step "6/8 bootstrap — seed LocalStack Secrets Manager + KMS"
pnpm bootstrap

# ── 6. one-shot medallion refresh (creates the Trino serving views) ─────────
# Do NOT source .env.local-prod here: the refresh's Node steps (identity-export, journey-stitch)
# already self-load it via `tsx --env-file` (see run_node_job in v4-refresh-loop.sh), and the
# Spark steps run in CONTAINERS on the compose network. Sourcing would export the host-oriented
# S3_ENDPOINT=http://localhost:9000 into those containers, where MinIO is reachable only as
# `minio:9000` — breaking every Iceberg write with "Connect to localhost:9000: refused" and
# leaving Silver/Gold empty. Unset, the run-*.sh scripts fall back to their correct minio:9000.
step "7/8 refresh — one-shot Silver→Gold→Trino serving views"
ONESHOT=1 APP_ENV=local-prod pnpm dev:v4-refresh || \
  echo "  ⚠ refresh reported issues (often just an empty cold DB) — continuing; re-run 'pnpm dev:v4-refresh' anytime."

# ── 7. apps ─────────────────────────────────────────────────────────────────
step "8/8 apps — core + web + collector + stream-worker"
APP_ENV=local-prod turbo run dev \
  --filter=@brain/core --filter=@brain/web --filter=@brain/collector --filter=@brain/stream-worker
