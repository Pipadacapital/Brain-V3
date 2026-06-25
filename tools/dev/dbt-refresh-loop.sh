#!/usr/bin/env bash
#
# dbt-refresh-loop.sh — keep the local-prod analytics layer (Silver/Gold) live.
#
# THE PROBLEM this solves: dashboards read GOLD (StarRocks), and Silver/Gold are dbt-BATCH tables
# that only rebuild when `dbt run` executes. In dev nothing auto-runs dbt, so after a connector sync
# lands new orders in Bronze, Gold stays stale and the dashboard shows "connected but no data" until
# someone runs dbt by hand. This loop refreshes the StarRocks Iceberg-Bronze cache + rebuilds the dbt
# marts on an interval so Gold tracks Bronze automatically.
#
# INTERIM: under Brain V4 the transform moves to Spark streaming/batch and dbt is removed — this loop
# is the dev stopgap until that cutover lands.
#
# Usage:  pnpm dev:dbt-refresh            # every 300s (default)
#         REFRESH_INTERVAL_SECONDS=120 pnpm dev:dbt-refresh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INTERVAL="${REFRESH_INTERVAL_SECONDS:-300}"
DBT_VENV="$ROOT/.dbt-venv/bin/dbt"
SR_CONTAINER="${STARROCKS_CONTAINER:-brainv3-starrocks-1}"
BRONZE_TABLE="brain_bronze_local.brain_bronze.collector_events"

[ -x "$DBT_VENV" ] || { echo "✗ dbt venv not found at $DBT_VENV (run the analytics setup first)"; exit 1; }

echo "▶ dbt refresh loop — every ${INTERVAL}s (Ctrl-C to stop)"
while true; do
  ts="$(printf '%(%H:%M:%S)T' -1 2>/dev/null || date +%H:%M:%S)"
  # 1) Refresh StarRocks' Iceberg external-table metadata cache so dbt's staging sees fresh Bronze.
  docker exec "$SR_CONTAINER" mysql -h127.0.0.1 -P9030 -uroot -N \
    -e "REFRESH EXTERNAL TABLE ${BRONZE_TABLE};" >/dev/null 2>&1 \
    || echo "[$ts] ⚠ StarRocks refresh failed (is the lakehouse up?)"
  # 2) Rebuild the dbt marts (Bronze → Silver → Gold). --threads 1 keeps StarRocks happy in dev.
  if (cd "$ROOT/db/dbt" && DBT_PROFILES_DIR=profiles "$DBT_VENV" run --threads 1 >/tmp/dbt-refresh-loop.log 2>&1); then
    pass="$(grep -oE 'PASS=[0-9]+' /tmp/dbt-refresh-loop.log | tail -1)"
    echo "[$ts] ✓ dbt run OK (${pass:-done}); next in ${INTERVAL}s"
  else
    echo "[$ts] ✗ dbt run failed — see /tmp/dbt-refresh-loop.log; retrying in ${INTERVAL}s"
  fi
  sleep "$INTERVAL"
done
