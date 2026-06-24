#!/usr/bin/env bash
#
# dbt-runner entrypoint — run a parameterized dbt build inside the dbt-runner image.
#
# The image bundles the dbt project (db/dbt) + the StarRocks catalog bootstrap SQL (db/starrocks).
# It is the runtime for scheduled mart rebuilds (Argo CronWorkflows) — primarily the attribution gold
# refresh (chain step 4) and Silver intraday rebuilds — that the Node job images cannot run (they have
# no dbt/StarRocks-catalog runtime).
#
# Config (all via env):
#   DBT_SELECT              REQUIRED — dbt node selector, e.g. "gold_marketing_attribution gold_attribution_paths".
#   DBT_FULL_REFRESH        "true" → --full-refresh (default false).
#   DBT_VARS               optional dbt --vars payload, e.g. '{ledger_source: pg}'.
#   DBT_THREADS            dbt threads (default 4; set 1 on constrained runners — macOS dev spawn cap).
#   DBT_BOOTSTRAP_CATALOG  "true" → (idempotent) create the PG read-shims + StarRocks JDBC catalog
#                          BEFORE the run (mirrors `make silver-catalog`). Default false (assume the
#                          catalog is already provisioned in the target env).
#   STARROCKS_HOST/PORT/USER/PASSWORD   StarRocks connection (the dbt profile reads these).
#   BOOTSTRAP_DATABASE_URL  Postgres DSN for the read-shim DDL (only when DBT_BOOTSTRAP_CATALOG=true).
#
# Idempotent: dbt marts are full-refreshable + the catalog DDL is CREATE-OR-REPLACE, so a missed or
# retried Argo run never double-applies (Forbid + startingDeadline upstream).
set -euo pipefail

: "${DBT_SELECT:?DBT_SELECT is required (the dbt node selector to build)}"

if [ "${DBT_BOOTSTRAP_CATALOG:-false}" = "true" ]; then
  echo ">> [bootstrap] PG read-shims (oltp_pg_read_shim.sql) ..."
  psql "${BOOTSTRAP_DATABASE_URL:?BOOTSTRAP_DATABASE_URL required when DBT_BOOTSTRAP_CATALOG=true}" \
    -v ON_ERROR_STOP=1 -f /opt/brain/starrocks/oltp_pg_read_shim.sql
  echo ">> [bootstrap] StarRocks JDBC catalog (oltp_jdbc_catalog.sql) ..."
  mysql -h"${STARROCKS_HOST:?}" -P"${STARROCKS_PORT:-9030}" -u"${STARROCKS_USER:-root}" \
    ${STARROCKS_PASSWORD:+-p"${STARROCKS_PASSWORD}"} < /opt/brain/starrocks/oltp_jdbc_catalog.sql
fi

cd /opt/brain/dbt

ARGS=(run --select ${DBT_SELECT} --threads "${DBT_THREADS:-4}" --profiles-dir /opt/brain/dbt/profiles)
if [ "${DBT_FULL_REFRESH:-false}" = "true" ]; then ARGS+=(--full-refresh); fi
if [ -n "${DBT_VARS:-}" ]; then ARGS+=(--vars "${DBT_VARS}"); fi

echo ">> dbt ${ARGS[*]}"
exec dbt "${ARGS[@]}"
