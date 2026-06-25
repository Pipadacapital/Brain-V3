#!/usr/bin/env bash
# ============================================================
# Brain V4 Phase 3 — StarRocks serving-layer MV runner
# Applies every db/starrocks/mv/mv_*.sql (ASYNC materialized views over Iceberg Gold)
# into the brain_serving DB, then synchronously refreshes each one.
#
# ADDITIVE / idempotent: every DDL uses CREATE MATERIALIZED VIEW IF NOT EXISTS, so
# re-running is safe. Does NOT touch dbt brain_gold, app code, readers, or the
# external-catalog SQL.
#
# Connection: StarRocks mysql protocol. Local dev runs StarRocks inside the
# `brainv3-starrocks-1` container; a host `mysql` client also works if present.
#
# Usage:
#   db/starrocks/mv/run_mvs.sh                # create + sync-refresh all MVs
#   MV_GLOB='mv_gold_cac.sql' db/starrocks/mv/run_mvs.sh   # a subset
# ============================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SR_CONTAINER="${SR_CONTAINER:-brainv3-starrocks-1}"
SR_HOST="${SR_HOST:-127.0.0.1}"
SR_PORT="${SR_PORT:-9030}"
SR_USER="${SR_USER:-root}"
MV_GLOB="${MV_GLOB:-mv_*.sql}"

# Resolve a way to talk to StarRocks: host mysql client, else exec into container.
if command -v mysql >/dev/null 2>&1; then
  sr() { mysql -h"$SR_HOST" -P"$SR_PORT" -u"$SR_USER" -N "$@"; }
  sr_stdin() { mysql -h"$SR_HOST" -P"$SR_PORT" -u"$SR_USER"; }
else
  sr() { docker exec -i "$SR_CONTAINER" mysql -h"$SR_HOST" -P"$SR_PORT" -u"$SR_USER" -N "$@"; }
  sr_stdin() { docker exec -i "$SR_CONTAINER" mysql -h"$SR_HOST" -P"$SR_PORT" -u"$SR_USER"; }
fi

echo "==> Ensuring serving DB brain_serving exists"
sr -e "CREATE DATABASE IF NOT EXISTS brain_serving;"

shopt -s nullglob
for f in "$DIR"/$MV_GLOB; do
  base="$(basename "$f" .sql)"
  echo "==> Applying $base"
  sr_stdin < "$f"
done

echo "==> Refreshing MVs WITH SYNC MODE"
for f in "$DIR"/$MV_GLOB; do
  mv="$(basename "$f" .sql)"
  echo "    REFRESH $mv"
  sr -e "REFRESH MATERIALIZED VIEW brain_serving.$mv WITH SYNC MODE;"
done

echo "==> Done. MVs in brain_serving:"
sr -e "SHOW MATERIALIZED VIEWS FROM brain_serving;" | awk '{print "    "$0}'
