#!/usr/bin/env bash
# ============================================================
# Brain V4 — StarRocks OPERATIONAL DB (brain_ops) DDL runner
# Applies every db/starrocks/ops/*.sql (app-owned operational StarRocks tables that are
# NOT dbt-derived Gold marts — e.g. the ML inference log relocated off the retiring brain_gold).
#
# ADDITIVE / idempotent: every DDL uses CREATE DATABASE/TABLE IF NOT EXISTS, so re-running
# is safe. Does NOT touch dbt brain_gold/brain_silver, the brain_serving MVs, or readers.
#
# Connection: StarRocks mysql protocol. Local dev runs StarRocks inside the
# `brainv3-starrocks-1` container; a host `mysql` client also works if present.
#
# Usage:
#   db/starrocks/ops/run_ops.sh                         # apply every ops DDL
#   OPS_GLOB='ops_ml_prediction_log.sql' db/starrocks/ops/run_ops.sh   # a subset
# ============================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SR_CONTAINER="${SR_CONTAINER:-brainv3-starrocks-1}"
SR_HOST="${SR_HOST:-127.0.0.1}"
SR_PORT="${SR_PORT:-9030}"
SR_USER="${SR_USER:-root}"
OPS_GLOB="${OPS_GLOB:-*.sql}"

# Resolve a way to talk to StarRocks: host mysql client, else exec into container.
if command -v mysql >/dev/null 2>&1; then
  sr_stdin() { mysql -h"$SR_HOST" -P"$SR_PORT" -u"$SR_USER"; }
else
  sr_stdin() { docker exec -i "$SR_CONTAINER" mysql -h"$SR_HOST" -P"$SR_PORT" -u"$SR_USER"; }
fi

shopt -s nullglob
for f in "$DIR"/$OPS_GLOB; do
  base="$(basename "$f")"
  [ "$base" = "run_ops.sh" ] && continue
  echo "==> Applying $base"
  sr_stdin < "$f"
done

echo "==> Done. Tables in brain_ops:"
if command -v mysql >/dev/null 2>&1; then
  mysql -h"$SR_HOST" -P"$SR_PORT" -u"$SR_USER" -N -e "SHOW TABLES FROM brain_ops;" | awk '{print "    "$0}'
else
  docker exec -i "$SR_CONTAINER" mysql -h"$SR_HOST" -P"$SR_PORT" -u"$SR_USER" -N -e "SHOW TABLES FROM brain_ops;" | awk '{print "    "$0}'
fi
