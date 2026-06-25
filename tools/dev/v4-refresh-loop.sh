#!/usr/bin/env bash
#
# v4-refresh-loop.sh — keep the local-prod V4 analytics layer (Iceberg Silver/Gold + StarRocks serving)
# live. This is the V4 REPLACEMENT for the retired dbt-refresh-loop.sh (Phase 6b).
#
# THE PROBLEM this solves: under Brain V4 the transform is Spark-on-Iceberg, NOT dbt. Dashboards read the
# brain_serving mv_* materialized views (Phase 4). Those MVs sit on top of the EXTERNAL Iceberg catalogs
# (brain_silver_local / brain_gold_local), which are materialized FROM raw Iceberg Bronze by the Spark
# Silver + Spark Gold jobs. In dev nothing auto-runs those jobs, so after a connector sync lands new
# orders in Bronze, Silver/Gold (and therefore the mv_* serving views) stay stale and the dashboard shows
# "connected but no data" until someone runs the pipeline by hand. This loop, on an interval:
#
#   1. runs every Spark SILVER job  (db/iceberg/spark/silver/run-*.sh)  Bronze  → Iceberg brain_silver
#   2. runs every Spark GOLD   job  (db/iceberg/spark/gold/run-*.sh)    Silver  → Iceberg brain_gold
#   3. drives a deterministic REFRESH MATERIALIZED VIEW <mv> WITH SYNC MODE for the brain_serving mv_*
#      so the serving tier tracks the freshly-materialized Iceberg (rather than waiting on each MV's
#      EVERY 15 MINUTE async refresh) — dev gets immediate, deterministic Gold.
#
# It touches NO Spark job and NO Iceberg catalog — it only INVOKES the existing run scripts and issues
# SYNC refreshes against the brain_serving MVs. Tenant isolation + money discipline live inside the Spark
# jobs / MV definitions; this loop is pure orchestration.
#
# Usage:  pnpm dev:v4-refresh                 # every 300s (default)
#         REFRESH_INTERVAL_SECONDS=120 pnpm dev:v4-refresh
#         ONESHOT=1 pnpm dev:v4-refresh        # run the pipeline once and exit (CI / manual reproduce)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INTERVAL="${REFRESH_INTERVAL_SECONDS:-300}"
SILVER_DIR="$ROOT/db/iceberg/spark/silver"
GOLD_DIR="$ROOT/db/iceberg/spark/gold"
SR_CONTAINER="${STARROCKS_CONTAINER:-brainv3-starrocks-1}"
SERVING_DB="${SERVING_DB:-brain_serving}"

# Spark Silver jobs run FIRST (Bronze → Iceberg brain_silver); Gold reads Silver, so it runs SECOND.
# Order within each tier doesn't matter — every job is an idempotent MERGE on its model PK (replay-safe).
SILVER_SCRIPTS=("$SILVER_DIR"/run-*.sh)
GOLD_SCRIPTS=("$GOLD_DIR"/run-*.sh)

ts() { printf '%(%H:%M:%S)T' -1 2>/dev/null || date +%H:%M:%S; }

run_spark_tier() {  # $1=tier-label  $2..=scripts
  local label="$1"; shift
  local ok=0 fail=0 s
  for s in "$@"; do
    [ -x "$s" ] || { echo "[$(ts)] ⚠ ${label}: $(basename "$s") not executable — skipping"; continue; }
    if "$s" >>"/tmp/v4-refresh-${label}.log" 2>&1; then ok=$((ok+1)); else
      fail=$((fail+1)); echo "[$(ts)] ✗ ${label}: $(basename "$s") failed — see /tmp/v4-refresh-${label}.log"
    fi
  done
  echo "[$(ts)] ${label}: ${ok} ok, ${fail} failed"
  return "$fail"
}

refresh_serving_mvs() {
  # Pull the live mv_* list from StarRocks (so a new MV is picked up automatically) and SYNC-refresh each.
  local mvs
  mvs="$(docker exec "$SR_CONTAINER" mysql -h127.0.0.1 -P9030 -uroot -N \
    -e "SELECT TABLE_NAME FROM information_schema.materialized_views WHERE TABLE_SCHEMA='${SERVING_DB}' AND TABLE_NAME LIKE 'mv\_%' ORDER BY TABLE_NAME;" 2>/dev/null)" \
    || { echo "[$(ts)] ⚠ could not list ${SERVING_DB} MVs (is StarRocks up?)"; return 1; }
  [ -n "$mvs" ] || { echo "[$(ts)] ⚠ no mv_* found in ${SERVING_DB}"; return 1; }
  local n=0
  while IFS= read -r mv; do
    [ -n "$mv" ] || continue
    # WITH SYNC MODE blocks until the refresh completes → deterministic Gold for the next dashboard read.
    docker exec "$SR_CONTAINER" mysql -h127.0.0.1 -P9030 -uroot -N \
      -e "REFRESH MATERIALIZED VIEW ${SERVING_DB}.${mv} WITH SYNC MODE;" >/dev/null 2>&1 \
      && n=$((n+1)) \
      || echo "[$(ts)] ⚠ refresh ${SERVING_DB}.${mv} failed"
  done <<< "$mvs"
  echo "[$(ts)] ✓ refreshed ${n} serving MV(s) WITH SYNC MODE"
}

run_once() {
  echo "[$(ts)] ── V4 refresh: Spark Silver → Spark Gold → ${SERVING_DB} mv_* SYNC ──"
  run_spark_tier silver "${SILVER_SCRIPTS[@]}"
  run_spark_tier gold   "${GOLD_SCRIPTS[@]}"
  refresh_serving_mvs
  echo "[$(ts)] ✓ V4 refresh cycle complete"
}

if [ "${ONESHOT:-0}" = "1" ]; then
  run_once
  exit 0
fi

echo "▶ V4 refresh loop — every ${INTERVAL}s (Ctrl-C to stop)"
while true; do
  run_once
  echo "[$(ts)] next cycle in ${INTERVAL}s"
  sleep "$INTERVAL"
done
