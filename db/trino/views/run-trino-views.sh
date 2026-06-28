#!/usr/bin/env bash
# ============================================================
# Brain V4 — Trino serving-layer VIEW runner
#
# Applies every db/trino/views/mv_*.sql (Trino VIEWS over the Iceberg Gold/Silver
# marts) into the iceberg.brain_serving schema. These views are the V4 replacement
# for the StarRocks ASYNC MVs (db/starrocks/mv/*.sql): StarRocks is removed; Trino
# is the SOLE serving engine. The app/BFF/metric-engine read brain_serving.mv_*,
# which — with the Trino default catalog = iceberg — resolves to
# iceberg.brain_serving.mv_*.
#
# WHY VIEWS (not MVs): Spark pre-materializes Gold/Silver into Iceberg, so serving
# is just a thin column projection. There is no async refresh to schedule — a view
# always reflects the latest Iceberg snapshot. Redis fronts hot reads (phase 2).
#
# ADDITIVE / idempotent: every DDL is CREATE OR REPLACE VIEW, so re-running is safe.
# Creates `iceberg.brain_serving` first (CREATE SCHEMA IF NOT EXISTS).
#
# Connection: Trino HTTP REST API (/v1/statement). Local dev runs Trino in the
# docker-compose `lakehouse` profile (host port 8090). A `trino` CLI is used if
# present; otherwise the script POSTs statements via curl.
#
# Usage:
#   db/trino/views/run-trino-views.sh                      # create schema + all views
#   VIEW_GLOB='mv_gold_revenue_ledger.sql' db/trino/views/run-trino-views.sh   # a subset
# Env:
#   TRINO_URL   (default http://127.0.0.1:8090)   — Trino coordinator base URL
#   TRINO_USER  (default brain)                   — X-Trino-User (no auth in dev)
#   VIEW_GLOB   (default mv_*.sql)                — which view files to apply
# ============================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRINO_URL="${TRINO_URL:-http://127.0.0.1:8090}"
TRINO_USER="${TRINO_USER:-brain}"
VIEW_GLOB="${VIEW_GLOB:-mv_*.sql}"

# Run a single SQL statement against Trino. Prefer the trino CLI; fall back to the
# REST API via curl (POST /v1/statement, follow nextUri until the query settles).
if command -v trino >/dev/null 2>&1; then
  trino_exec() { trino --server "$TRINO_URL" --user "$TRINO_USER" --catalog iceberg --execute "$1" >/dev/null; }
else
  trino_exec() {
    local sql="$1"
    local resp next state err
    resp="$(curl -fsS -X POST "$TRINO_URL/v1/statement" \
      -H "X-Trino-User: $TRINO_USER" -H "X-Trino-Catalog: iceberg" \
      -H 'Content-Type: text/plain' --data-binary "$sql")"
    # Drive the statement to completion: follow nextUri, surface any error.
    while :; do
      err="$(printf '%s' "$resp" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p' | head -1)"
      state="$(printf '%s' "$resp" | sed -n 's/.*"state":"\([^"]*\)".*/\1/p' | head -1)"
      if printf '%s' "$resp" | grep -q '"error"'; then
        echo "    !! Trino error: ${err:-unknown}" >&2
        return 1
      fi
      next="$(printf '%s' "$resp" | sed -n 's/.*"nextUri":"\([^"]*\)".*/\1/p' | head -1)"
      [ -z "$next" ] && break
      [ "$state" = "FINISHED" ] && break
      resp="$(curl -fsS -H "X-Trino-User: $TRINO_USER" "$next")"
    done
  }
fi

echo "==> Ensuring serving schema iceberg.brain_serving exists"
trino_exec "CREATE SCHEMA IF NOT EXISTS iceberg.brain_serving"

shopt -s nullglob
count=0
skipped=0
skipped_list=""
for f in "$DIR"/$VIEW_GLOB; do
  base="$(basename "$f" .sql)"
  echo "==> Applying view $base"
  # Strip leading comments/blank lines and the trailing ';' (the REST API takes one
  # bare statement), then apply.
  sql="$(sed -e 's/^[[:space:]]*--.*$//' "$f" | grep -v '^[[:space:]]*$' | sed 's/;[[:space:]]*$//')"
  # CONTINUE-ON-ERROR: a view over a Gold mart that has not been built yet (e.g. a fresh
  # boot where the refresh has not reached that mart) must NOT abort the whole serving layer —
  # every view whose dependencies DO exist should still be created. We tolerate a per-view
  # failure (commonly "Table … does not exist"), tally it, and surface the list at the end so
  # a re-run after the next refresh cycle completes the set. `set -e` would otherwise kill the
  # loop on the first missing mart, which is exactly the bug that left only the first view applied.
  if trino_exec "$sql"; then
    count=$((count + 1))
  else
    skipped=$((skipped + 1))
    skipped_list="${skipped_list} ${base}"
    echo "    -- skipped $base (dependency not ready); will apply on a later run" >&2
  fi
done

echo "==> Done. Applied $count Trino view(s); skipped $skipped.${skipped_list:+ Skipped:${skipped_list}}"
echo "==> Listing iceberg.brain_serving:"
trino_exec "SHOW TABLES FROM iceberg.brain_serving" || true
