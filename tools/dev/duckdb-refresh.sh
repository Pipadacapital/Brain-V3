#!/usr/bin/env bash
#
# duckdb-refresh.sh — THIN DEV SHIM over db/iceberg/duckdb/run_all.py (ADR-0016 P2 cleanup).
#
# WAS the 90-spawn bash orchestrator (45 silver jobs × 2 passes + gold, each a fresh `python …` process
# paying ~85s of fixed Python+DuckDB+catalog-attach overhead → a full run took ~130 min). That loop is
# RETIRED: run_all.py is the single-process runner — it attaches the Iceberg catalog ONCE and runs every
# job's existing `__main__` against ONE shared warm connection (and, in `resident` mode, is the warm
# micro-batch worker the CronWorkflow/Deployment run). This shim just chains run_all.py for LOCAL DEV
# (`pnpm dev:v4-refresh`) so there is ONE transform runner, not two.
#
# THE CHAIN (identical ordering to the v4-medallion CronWorkflow):
#   run_all.py silver   → keystone silver_collector_event + spine silver_order_state (required), then the
#                         rest of Silver ×2 (a job that read a not-yet-produced sibling converges on pass 2)
#   node silver-identity → the Node identity batch job (ADR-0015 WS3: identity resolves in Silver) —
#                         resolves via IdentityResolver → Neo4j (the identity SoR, ADR-0004); continue-on-error
#   silver_identity_map → re-project the graph → the Iceberg bi-temporal map so gold reads THIS run's resolutions
#   run_all.py gold      → gold_revenue_ledger (required) + the ordered attribution chain, then the rest (1 pass)
#   serving-cache-bust   → direct Redis eviction of the brand-scoped serving cache (fail-open; TTL is the net)
#
# The identity + map + cache-bust cross LANGUAGES/IMAGES exactly as the CronWorkflow does — the Python
# silver/gold tiers run via run_all.py; the node identity + cache-bust steps shell out. (run_all.py's
# `resident` mode folds the same chain into one warm loop; this shim is the SINGLE-SHOT dev equivalent.)
#
# Identity jobs read Neo4j; if Neo4j is empty they no-op — that is fine, not a fail. FULL_REFRESH=1 (env)
# still forces a full rebuild of the incremental jobs (read straight through to run_all.py's job env).
#
# Usage:
#   tools/dev/duckdb-refresh.sh                 # full run: silver (keystone + ×2) → identity → gold → cache-bust
#   STAGE=keystone  tools/dev/duckdb-refresh.sh # just the keystone (silver_collector_event) — golden-baseline seed
#   STAGE=silver    tools/dev/duckdb-refresh.sh # silver only (run_all.py silver)
#   STAGE=identity  tools/dev/duckdb-refresh.sh # identity stage only (node job + map re-project)
#   STAGE=gold      tools/dev/duckdb-refresh.sh # gold only (run_all.py gold)
#
# The env (S3_ENDPOINT / ICEBERG_* / AWS_* / NEO4J_URI) must be exported by the caller, exactly like the
# DuckDB job invocation contract. NOTE: MIGRATION_TABLE_SUFFIX must NOT be set — this writes the LIVE
# tables. ONESHOT is accepted + ignored (call-site compatibility with the retired v4-refresh-loop.sh).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DUCK_DIR="$ROOT/db/iceberg/duckdb"

# The DuckDB interpreter. The migration venv (/tmp/duckvenv) carries duckdb 1.5.4 + splink + neo4j +
# pyiceberg; a caller can override with PYTHON=… (e.g. a container python).
PYTHON="${PYTHON:-/tmp/duckvenv/bin/python}"
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON="python3"

STAGE="${STAGE:-all}"

# The Node silver-identity batch job (Neo4j writes via the preserved resolver). Same default idiom
# run_all.py's resident mode uses; a container overrides with a built dist path.
SILVER_IDENTITY_CMD="${SILVER_IDENTITY_CMD:-pnpm --filter @brain/stream-worker run job:silver-identity}"

ts() { printf '%(%H:%M:%S)T' -1 2>/dev/null || date +%H:%M:%S; }

run_silver()   { echo "[$(ts)] ── silver (run_all.py, single-process) ──"; "$PYTHON" "$DUCK_DIR/run_all.py" silver; }
run_gold()     { echo "[$(ts)] ── gold (run_all.py, single-process) ──";   "$PYTHON" "$DUCK_DIR/run_all.py" gold; }
run_keystone() {
  echo "[$(ts)] ── keystone: silver_collector_event (the admission gate every silver job reads) ──"
  "$PYTHON" "$DUCK_DIR/silver/silver_collector_event.py"
}

# Identity stage (ADR-0015 WS3): the Node resolver job, then re-project the Neo4j graph → Iceberg map so
# gold reads THIS run's resolutions. Both continue-on-error (the map job re-projects even if the node job
# advanced the graph; a failure holds a watermark and converges next run).
run_identity() {
  local fail=0
  echo "[$(ts)] ── identity stage (ADR-0015 WS3: resolve in Silver → refresh the Iceberg identity map) ──"
  ( cd "$ROOT" && eval "$SILVER_IDENTITY_CMD" ) \
    && echo "[$(ts)] ✓ identity/silver-identity" \
    || { fail=$((fail+1)); echo "[$(ts)] ✗ identity/silver-identity FAILED — converge next run"; }
  if [ -e "$DUCK_DIR/silver/silver_identity_map.py" ]; then
    "$PYTHON" "$DUCK_DIR/silver/silver_identity_map.py" \
      && echo "[$(ts)] ✓ silver/silver_identity_map" \
      || { fail=$((fail+1)); echo "[$(ts)] ✗ silver/silver_identity_map FAILED — converge next run"; }
  fi
  return "$fail"
}

# Post-gold serving-cache bust (direct Redis eviction — the gold.rewritten.v1 lane is retired, ADR-0015
# WS3). FAIL-OPEN: cache busting is an optimization; a failure never fails the refresh (TTL is the net).
run_cache_bust() {
  [ "${SKIP_GOLD_CACHE_BUST:-0}" = "1" ] && return 0
  ( cd "$ROOT" && eval "${GOLD_CACHE_BUST_CMD:-pnpm --filter @brain/stream-worker exec tsx src/jobs/gold-rewritten-publish/run.ts}" ) \
    > /tmp/duckdb-refresh-gold-cache-bust.log 2>&1 \
    && echo "[$(ts)] ✓ gold/serving-cache-bust" \
    || echo "[$(ts)] ⚠ gold/serving-cache-bust failed (fail-open — TTL is the safety net) [see /tmp/duckdb-refresh-gold-cache-bust.log]"
}

echo "▶ DuckDB refresh (LIVE catalog cutover, thin shim over run_all.py) — python=${PYTHON}, stage=${STAGE}"

RC=0
case "$STAGE" in
  keystone) run_keystone || RC=$? ;;
  silver)   run_silver   || RC=$? ;;
  identity) run_identity || RC=$? ;;
  gold)     run_gold     || RC=$? ;;
  all)
    run_silver   || RC=$?
    run_identity || RC=$?
    run_gold     || RC=$?
    run_cache_bust
    ;;
  *) echo "✗ unknown STAGE '$STAGE' (keystone|silver|identity|gold|all)" >&2; exit 2 ;;
esac

if [ "$RC" -eq 0 ]; then
  echo "[$(ts)] ✓ DuckDB refresh complete"
else
  echo "[$(ts)] ⚠ DuckDB refresh completed with failures (rc=${RC}) — see run_all.py stdout above"
fi
exit "$RC"
