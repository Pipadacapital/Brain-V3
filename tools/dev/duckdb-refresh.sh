#!/usr/bin/env bash
#
# duckdb-refresh.sh — the DuckDB analogue of tools/dev/v4-refresh-loop.sh.
#
# Runs the full DuckDB transform tier (db/iceberg/duckdb/{silver,gold}/*.py) against the LIVE
# dev Iceberg catalog IN DEPENDENCY ORDER, so the derived customer/attribution/journey marts
# actually populate. This is the Spark→DuckDB cutover orchestrator: unlike the parity harness it
# writes the LIVE tables (NO MIGRATION_TABLE_SUFFIX).
#
# WHY an explicit order (same rationale as v4-refresh-loop.sh):
#   (a) silver_collector_event  — THE KEYSTONE / admission gate. Every other silver_* job reads
#       brain_silver.silver_collector_event, so it must build FIRST.
#   (b) the rest of silver/*.py — entity jobs + the sibling-reading jobs (order_line / sessions /
#       touchpoint / customer / journey / session_identity). Because every job is an idempotent
#       MERGE, a SECOND full pass over all of silver guarantees convergence: a job that read a
#       not-yet-produced sibling on pass 1 folds it in on pass 2.
#   (c) all gold/*.py — read the resolved silver spine (+ sibling gold). Idempotent MERGE.
#
# Identity jobs (silver_identity_* / silver_customer_identity / snap_identity_link) read Neo4j.
# We RUN them; if Neo4j is empty they no-op / take their data-thin skip — that is fine, not a fail.
#
# Files starting with `_` are shared framework modules (_base/_catalog/_platform_flags/…), NOT
# jobs — they are excluded. parity_check.py / phase0_capability_probe.py live in the duckdb root
# (not silver/ or gold/) so they are never globbed here.
#
# CONTINUE-ON-ERROR: a failing job is logged and COUNTED but never aborts the run (idempotent →
# a transient/ordering failure is expected to clear on the next pass). Every job's result line is
# printed. Exit code = total distinct failures on the FINAL silver pass + gold pass.
#
# Usage:
#   tools/dev/duckdb-refresh.sh                 # full run: keystone → silver ×2 → gold
#   STAGE=keystone  tools/dev/duckdb-refresh.sh # just the keystone (silver_collector_event)
#   STAGE=silver1   tools/dev/duckdb-refresh.sh # silver pass 1 only
#   STAGE=silver2   tools/dev/duckdb-refresh.sh # silver pass 2 only
#   STAGE=gold      tools/dev/duckdb-refresh.sh # gold only
#   SILVER_PASSES=1 tools/dev/duckdb-refresh.sh # single silver pass (default 2)
#
# The env (S3_ENDPOINT / ICEBERG_* / AWS_* / NEO4J_URI) must be exported by the caller, exactly
# like the DuckDB job invocation contract. NOTE: MIGRATION_TABLE_SUFFIX must NOT be set — this
# writes the LIVE tables.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DUCK_DIR="$ROOT/db/iceberg/duckdb"
SILVER_DIR="$DUCK_DIR/silver"
GOLD_DIR="$DUCK_DIR/gold"

# The DuckDB interpreter. The migration venv (/tmp/duckvenv) carries duckdb 1.5.4 + splink + neo4j
# + trino; a caller can override with PYTHON=… (e.g. a container python).
PYTHON="${PYTHON:-/tmp/duckvenv/bin/python}"
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON="python3"

SILVER_PASSES="${SILVER_PASSES:-2}"
STAGE="${STAGE:-all}"

KEYSTONE="silver_collector_event.py"

ts() { printf '%(%H:%M:%S)T' -1 2>/dev/null || date +%H:%M:%S; }

# List the runnable jobs in a tier dir (basename), excluding `_`-prefixed framework modules.
# For silver we also peel off the keystone (run as its own ordered step).
list_jobs() {  # $1 = dir  $2 = (optional) basename to exclude
  local dir="$1" excl="${2:-}"
  local f b
  for f in "$dir"/*.py; do
    [ -e "$f" ] || continue
    b="$(basename "$f")"
    case "$b" in
      _*) continue ;;                       # shared framework module, not a job
      "$excl") continue ;;                  # explicitly-excluded (keystone)
    esac
    echo "$b"
  done
}

# Run one job. Streams its JSON result line to stdout, mirrors full output to a per-job log, and
# returns the job's exit code (never aborts the caller).
run_job() {  # $1 = tier(silver|gold)  $2 = basename
  local tier="$1" job="$2"
  local path="$DUCK_DIR/$tier/$job"
  local logf="/tmp/duckdb-refresh-${tier}-${job%.py}.log"
  local out rc
  out="$("$PYTHON" "$path" 2>&1)"; rc=$?
  printf '%s\n' "$out" > "$logf"
  if [ "$rc" -eq 0 ]; then
    # Surface the job's own {"job":…,"upserted":…} result line (last JSON line), else a terse ok.
    local rline
    rline="$(printf '%s\n' "$out" | grep -E '^\{"job"' | tail -1)"
    echo "[$(ts)] ✓ ${tier}/${job}  ${rline:-ok}"
  else
    echo "[$(ts)] ✗ ${tier}/${job} FAILED (rc=${rc}) — $(printf '%s' "$out" | tail -1 | cut -c1-160)  [see ${logf}]"
  fi
  return "$rc"
}

# Run every job in a list; echo a tier summary; return the failure count.
run_tier() {  # $1 = tier  $2 = label  $3.. = job basenames
  local tier="$1" label="$2"; shift 2
  local ok=0 fail=0 j
  echo "[$(ts)] ── ${label} (${#} jobs) ──"
  for j in "$@"; do
    if run_job "$tier" "$j"; then ok=$((ok+1)); else fail=$((fail+1)); fi
  done
  echo "[$(ts)] ${label}: ${ok} ok, ${fail} failed"
  return "$fail"
}

# Collect the job lists once (bash 3.2-compatible — macOS ships bash 3.2, no `mapfile`).
SILVER_JOBS=()
while IFS= read -r _j; do [ -n "$_j" ] && SILVER_JOBS+=("$_j"); done < <(list_jobs "$SILVER_DIR" "$KEYSTONE")
GOLD_JOBS=()
while IFS= read -r _j; do [ -n "$_j" ] && GOLD_JOBS+=("$_j"); done < <(list_jobs "$GOLD_DIR")

TOTAL_FAIL=0

run_keystone() {
  echo "[$(ts)] ── keystone: silver_collector_event (the admission gate every silver job reads) ──"
  run_job silver "$KEYSTONE" || return 1
  return 0
}

run_silver_passes() {
  local p=1 rc=0
  while [ "$p" -le "$SILVER_PASSES" ]; do
    run_tier silver "silver pass ${p}/${SILVER_PASSES}" "${SILVER_JOBS[@]}"; rc=$?
    # Only the FINAL pass's failures count toward the exit code (earlier-pass ordering misses are
    # expected to clear on the converging re-run).
    if [ "$p" -eq "$SILVER_PASSES" ]; then TOTAL_FAIL=$((TOTAL_FAIL+rc)); fi
    p=$((p+1))
  done
}

run_gold_tier() {
  run_tier gold "gold" "${GOLD_JOBS[@]}"; TOTAL_FAIL=$((TOTAL_FAIL+$?))
}

echo "▶ DuckDB refresh (LIVE catalog cutover) — python=${PYTHON}, stage=${STAGE}, silver_passes=${SILVER_PASSES}"
echo "  silver jobs: ${#SILVER_JOBS[@]} (+ keystone)   gold jobs: ${#GOLD_JOBS[@]}"

case "$STAGE" in
  keystone) run_keystone || TOTAL_FAIL=$((TOTAL_FAIL+1)) ;;
  silver1)  run_tier silver "silver pass 1" "${SILVER_JOBS[@]}"; TOTAL_FAIL=$((TOTAL_FAIL+$?)) ;;
  silver2)  run_tier silver "silver pass 2" "${SILVER_JOBS[@]}"; TOTAL_FAIL=$((TOTAL_FAIL+$?)) ;;
  silver)   run_silver_passes ;;
  gold)     run_gold_tier ;;
  all)
    run_keystone || TOTAL_FAIL=$((TOTAL_FAIL+1))
    run_silver_passes
    run_gold_tier
    ;;
  *) echo "✗ unknown STAGE '$STAGE' (keystone|silver1|silver2|silver|gold|all)" >&2; exit 2 ;;
esac

if [ "$TOTAL_FAIL" -eq 0 ]; then
  echo "[$(ts)] ✓ DuckDB refresh complete (0 failures)"
else
  echo "[$(ts)] ⚠ DuckDB refresh complete with ${TOTAL_FAIL} failed job(s) — see /tmp/duckdb-refresh-*.log"
fi
exit "$TOTAL_FAIL"
