#!/usr/bin/env bash
#
# v4-refresh-loop.sh — keep the local-prod V4 analytics layer (Iceberg Silver/Gold + StarRocks serving)
# live, IN THE CORRECT DEPENDENCY ORDER so the derived (customer + attribution) marts actually POPULATE.
# This is the V4 REPLACEMENT for the retired dbt-refresh-loop.sh (Phase 6b).
#
# THE PROBLEM this solves: under Brain V4 the transform is Spark-on-Iceberg, NOT dbt. Dashboards read the
# brain_serving mv_* materialized views (Phase 4). Those MVs sit on top of the EXTERNAL Iceberg catalogs
# (brain_silver_local / brain_gold_local), materialized FROM raw Iceberg Bronze by the Spark Silver + Gold
# jobs. In dev nothing auto-runs those jobs, so after a connector sync lands new orders in Bronze the
# Silver/Gold (and the mv_* serving views) stay stale → "connected but no data".
#
# But running "all silver, then all gold, then refresh" (the previous shape of this loop) is NOT enough:
# the CUSTOMER and ATTRIBUTION marts came out 0 because their inputs are produced by jobs that LIVE OUTSIDE
# the Spark Silver/Gold globs and MUST be sequenced AROUND them. The real V4 dependency chain is:
#
#   0. identity-export            Neo4j identity graph → brain_ops.silver_identity_link (+ silver_customer_
#                                 identity). Spark silver_order_state / silver_customer resolve order
#                                 brain_id FROM this table — so it MUST run FIRST. Without it every order's
#                                 brain_id is NULL → customer marts aggregate 0 customers.
#   1. silver_order_state         resolves brain_id (reads silver_identity_link) — the spine the rest of
#                                 Silver + all of Gold depend on. Runs before the rest of Silver.
#   2. the rest of Silver         every other silver_* mart (incl. an initial silver_touchpoint pass).
#   3a. gold_revenue_ledger       + SYNC-refresh mv_gold_revenue_ledger and mv_silver_touchpoint, because…
#   3b. journey-stitch            journey-stitch-from-identity reads mv_silver_touchpoint (journey anons) ∩
#                                 silver_identity_link (anon→brain_id) ∩ mv_gold_revenue_ledger (order→
#                                 brain_id) → writes the deterministic, UNAMBIGUOUS-ONLY stitch to PG
#                                 connector_journey_stitch_map; journey-stitch-export then projects that to
#                                 brain_ops.silver_journey_stitch. Without this, silver_touchpoint.stitched_*
#                                 is NULL → gold_attribution_credit has NO journeys to credit → 0 credit.
#   4. silver_touchpoint (rebuild) now that the stitch exists, rebuild silver_touchpoint so its stitched_*
#                                 columns are populated for the attribution read.
#   5. the rest of Gold           gold_revenue_* then gold_attribution_* (reads the stitched silver_touchpoint
#                                 + gold_revenue_ledger basis) then customer + gap + executive marts.
#   6. mv_* SYNC refresh          deterministic REFRESH MATERIALIZED VIEW … WITH SYNC MODE for every
#                                 brain_serving mv_* so the serving tier tracks the freshly-materialized
#                                 Iceberg immediately (rather than each MV's async EVERY-15-MINUTE refresh).
#
# It touches NO Spark job and NO Iceberg catalog destructively — it only INVOKES the existing run scripts +
# the existing stream-worker jobs (identity-export / journey-stitch) and issues additive SYNC refreshes
# against the brain_serving MVs. Tenant isolation + money discipline live inside the jobs/MV definitions;
# this loop is pure orchestration. Every Spark MERGE + every job is idempotent → a retried/missed run is
# safe, so the loop wraps each step in a BOUNDED retry and surfaces a clear per-step failure.
#
# Usage:  pnpm dev:v4-refresh                 # every 300s (default)
#         REFRESH_INTERVAL_SECONDS=120 pnpm dev:v4-refresh
#         ONESHOT=1 pnpm dev:v4-refresh        # run the pipeline once and exit (CI / manual reproduce)
#         SKIP_IDENTITY=1 / SKIP_STITCH=1      # skip the Neo4j/stitch sub-steps (e.g. Neo4j down)
#         MAX_RETRIES=2                        # bounded per-step retries (default 1 retry = 2 attempts)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INTERVAL="${REFRESH_INTERVAL_SECONDS:-300}"
SPARK_ROOT="$ROOT/db/iceberg/spark"
SILVER_DIR="$SPARK_ROOT/silver"
GOLD_DIR="$SPARK_ROOT/gold"
SR_CONTAINER="${STARROCKS_CONTAINER:-brainv3-starrocks-1}"
SERVING_DB="${SERVING_DB:-brain_serving}"
APP_ENV="${APP_ENV:-local-prod}"
ENV_FILE="$ROOT/.env.${APP_ENV}"
# Bounded retry: total attempts = MAX_RETRIES + 1 (so MAX_RETRIES=1 ⇒ one retry ⇒ 2 attempts).
MAX_RETRIES="${MAX_RETRIES:-1}"
RETRY_SLEEP_SECONDS="${RETRY_SLEEP_SECONDS:-10}"

# ── Spark tier scripts ───────────────────────────────────────────────────────────────────────────────
# NOTE: the PREVIOUS loop globbed only "$SILVER_DIR"/run-*.sh and "$GOLD_DIR"/run-*.sh — which SILENTLY
# MISSED the spine scripts that live one level up in $SPARK_ROOT (run-silver-orders.sh, run-silver-
# customer.sh, run-gold-revenue.sh, run-gold-customer.sh). Glob BOTH dirs.
#
# silver_order_state runs FIRST, explicitly (the spine that resolves brain_id), so it is excluded from the
# bulk silver tier below and invoked as its own ordered step.
SILVER_REST=()
for s in "$SPARK_ROOT"/run-silver-*.sh "$SILVER_DIR"/run-*.sh; do
  [ -e "$s" ] || continue
  SILVER_REST+=("$s")
done

# silver_touchpoint is rebuilt AFTER the stitch (step 4) — but it is ALSO part of the initial silver pass
# (step 2) so the stitch job has a touchpoint corpus to read. Both passes hit the same idempotent MERGE.
TOUCHPOINT_SCRIPT="$SILVER_DIR/run-silver-touchpoint-sessions.sh"

GOLD_SCRIPTS=()
for g in "$SPARK_ROOT"/run-gold-*.sh "$GOLD_DIR"/run-*.sh; do
  [ -e "$g" ] || continue
  GOLD_SCRIPTS+=("$g")
done

ts() { printf '%(%H:%M:%S)T' -1 2>/dev/null || date +%H:%M:%S; }
iso() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }

# Portable epoch-millis. GNU date supports %N (nanos); BSD/macOS date does NOT — it emits a literal "N",
# producing a non-numeric token that breaks arithmetic. Detect GNU once; else fall back to second precision
# (×1000). NEVER returns a non-integer (a duration_ms field must always be valid arithmetic).
if date +%s%3N 2>/dev/null | grep -qE '^[0-9]+$'; then
  now_ms() { date +%s%3N; }
else
  now_ms() { echo "$(( $(date +%s) * 1000 ))"; }
fi

# ── structured observability (additive) ────────────────────────────────────────────────────────────────
# One correlation_id per refresh CYCLE, exported into every Spark job's env (job_log.py echoes it on each
# spark_job line) and every node job's env — so an entire cycle's structured lines share one id, the
# orchestration half of the repo's correlation_id/brand_id child-logger discipline. The Spark jobs are
# brand-AGNOSTIC pipeline-health jobs (cross-brand ETL), so no brand_id is bound here; per-brand reads
# happen downstream in the app, which binds brand_id on its own child loggers.
new_correlation_id() {
  if command -v uuidgen >/dev/null 2>&1; then uuidgen | tr 'A-Z' 'a-z';
  else printf 'v4-%s-%s' "$(date +%s)" "$RANDOM"; fi
}

# jlog: emit ONE structured JSON line to stdout (machine-parseable, alongside the human ✓/✗ lines). Pure
# echo — never alters control flow. Fields: evt, plus the key=value pairs passed as args.
jlog() {  # jlog <evt> <k=v> ...
  local evt="$1"; shift
  local fields="" kv k v
  for kv in "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    # numeric values stay bare; everything else is JSON-quoted.
    if [[ "$v" =~ ^-?[0-9]+$ ]]; then fields="${fields},\"${k}\":${v}";
    else fields="${fields},\"${k}\":\"${v//\"/\\\"}\""; fi
  done
  printf '{"evt":"%s","correlation_id":"%s","ts":"%s"%s}\n' "$evt" "${V4_CORRELATION_ID:-}" "$(iso)" "$fields"
}

# ── bounded-retry runner ───────────────────────────────────────────────────────────────────────────────
# retry <label> <logfile> -- <command...>
# Runs the command, retrying up to MAX_RETRIES times on failure (every step here is idempotent). Returns
# the command's last exit code; logs a clear per-step pass/fail line. NEVER masks a persistent failure.
retry() {
  local label="$1" logf="$2"; shift 2
  [ "$1" = "--" ] && shift
  local attempt=0 rc=0
  while :; do
    attempt=$((attempt+1))
    # Run the command and capture its rc IMMEDIATELY (a separate statement — NOT via `if cmd; then`,
    # whose `$?` can be clobbered before we read it). rc is the SINGLE source of truth for pass/fail.
    "$@" >>"$logf" 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then
      [ "$attempt" -gt 1 ] && echo "[$(ts)] ✓ ${label} (attempt ${attempt}/$((MAX_RETRIES+1)))"
      return 0
    fi
    if [ "$attempt" -gt "$MAX_RETRIES" ]; then
      echo "[$(ts)] ✗ ${label} FAILED after ${attempt} attempt(s) (rc=${rc}) — see ${logf}"
      return "$rc"
    fi
    echo "[$(ts)] ⚠ ${label} failed (rc=${rc}, attempt ${attempt}/$((MAX_RETRIES+1))) — retrying in ${RETRY_SLEEP_SECONDS}s"
    sleep "$RETRY_SLEEP_SECONDS"
  done
}

run_spark_script() {  # $1=tier-label  $2=script-path
  local label="$1" s="$2"
  [ -x "$s" ] || {
    echo "[$(ts)] ⚠ ${label}: $(basename "$s") not executable — skipping"
    jlog v4_job job="$label" script="$(basename "$s")" status=skipped duration_ms=0
    return 0
  }
  local start end rc
  start=$(now_ms)
  retry "${label}: $(basename "$s")" "/tmp/v4-refresh-${label}.log" -- "$s"; rc=$?
  end=$(now_ms)
  jlog v4_job job="$label" script="$(basename "$s")" \
    status="$([ "$rc" -eq 0 ] && echo ok || echo fail)" duration_ms=$(( end - start ))
  return "$rc"
}

run_spark_tier() {  # $1=tier-label  $2..=scripts ; returns # of failed scripts
  local label="$1"; shift
  local ok=0 fail=0 s
  for s in "$@"; do
    if run_spark_script "$label" "$s"; then ok=$((ok+1)); else fail=$((fail+1)); fi
  done
  echo "[$(ts)] ${label}: ${ok} ok, ${fail} failed"
  return "$fail"
}

# ── stream-worker / core job runner (tsx with the env file, mirroring the dlq:redrive script) ──────────
# Jobs (identity-export, journey-stitch-*) are TS entrypoints; in dev we run them with tsx + --env-file so
# they pick up STARROCKS_*/NEO4J_*/BRAIN_APP_DATABASE_URL exactly like the deployed `node dist/...` cron.
run_node_job() {  # $1=label  $2=package-filter  $3=tsx-relative-path
  local label="$1" pkg="$2" rel="$3" logf="/tmp/v4-refresh-${1}.log"
  if [ ! -f "$ENV_FILE" ]; then
    echo "[$(ts)] ⚠ ${label}: env file ${ENV_FILE} missing — skipping (set APP_ENV)"
    jlog v4_job job="$label" status=skipped duration_ms=0
    return 0
  fi
  local start end rc
  start=$(now_ms)
  # V4_CORRELATION_ID is exported by run_once → the node job inherits it and (per the structured-logging
  # standard) binds it onto its child logger, so the worker's lines join this cycle's correlation chain.
  retry "$label" "$logf" -- \
    pnpm --filter "$pkg" exec tsx --env-file="$ENV_FILE" "$rel"; rc=$?
  end=$(now_ms)
  jlog v4_job job="$label" status="$([ "$rc" -eq 0 ] && echo ok || echo fail)" duration_ms=$(( end - start ))
  return "$rc"
}

# MV definitions (db/starrocks/mv/mv_*.sql) — applied idempotently so a from-zero cluster's first cycle
# MATERIALIZES the serving tier. Each file is CREATE MATERIALIZED VIEW IF NOT EXISTS … AS SELECT FROM the
# Iceberg Gold/Silver table, so this is the create-half of run_mvs.sh; the loop keeps its own refresh
# (which also REFRESH EXTERNAL TABLE-invalidates the Iceberg metadata cache — run_mvs.sh does not).
MV_DIR="$ROOT/db/starrocks/mv"

# ensure_mv <mv_name>: apply MV_DIR/<mv_name>.sql (CREATE … IF NOT EXISTS). Idempotent + non-fatal — if the
# MV's source Iceberg table isn't built yet the CREATE fails and is swallowed; the NEXT cycle (after the
# Spark job builds it) creates it. The serving catalogs (brain_{gold,silver}_local) are registered at
# starrocks-init, so they always exist here.
ensure_mv() {
  local f="$MV_DIR/${1}.sql"
  [ -f "$f" ] || return 0
  docker exec -i "$SR_CONTAINER" mysql -h127.0.0.1 -P9030 -uroot < "$f" >/dev/null 2>&1 || true
}

refresh_serving_mvs() {  # $1 (optional) = explicit space-separated mv list; default = ALL mv_*
  local explicit="${1:-}" mvs f
  if [ -n "$explicit" ]; then
    # CREATE-IF-MISSING the named MVs before refreshing (cold start: they don't exist yet).
    for m in $explicit; do ensure_mv "$m"; done
    mvs="$(printf '%s\n' $explicit)"
  else
    # COLD-START SELF-BOOTSTRAP: apply EVERY mv_*.sql (CREATE … IF NOT EXISTS) so a from-zero cluster
    # materializes all serving MVs on the first cycle — the loop previously only REFRESHed pre-existing
    # MVs, so a fresh stack served 0 rows until run_mvs.sh was run by hand. Idempotent every cycle after.
    for f in "$MV_DIR"/mv_*.sql; do
      [ -e "$f" ] || continue
      docker exec -i "$SR_CONTAINER" mysql -h127.0.0.1 -P9030 -uroot < "$f" >/dev/null 2>&1 || true
    done
    mvs="$(docker exec "$SR_CONTAINER" mysql -h127.0.0.1 -P9030 -uroot -N \
      -e "SELECT TABLE_NAME FROM information_schema.materialized_views WHERE TABLE_SCHEMA='${SERVING_DB}' AND TABLE_NAME LIKE 'mv\_%' ORDER BY TABLE_NAME;" 2>/dev/null)" \
      || { echo "[$(ts)] ⚠ could not list ${SERVING_DB} MVs (is StarRocks up?)"; return 1; }
  fi
  [ -n "$mvs" ] || { echo "[$(ts)] ⚠ no mv_* to refresh"; return 1; }
  local n=0 failed=0
  while IFS= read -r mv; do
    [ -n "$mv" ] || continue
    # ICEBERG METADATA-CACHE INVALIDATION (the fix for "mart populated in Iceberg but mv=0"): StarRocks
    # caches external-Iceberg snapshot metadata, so an mv refresh issued right after the Spark write reads
    # the STALE pre-write snapshot → the mv lands 0 rows until the ~60s background refresh. Mirror the
    # established run-mv.sh pattern: REFRESH EXTERNAL TABLE on the mv's Iceberg source FIRST. The mv name is
    # mv_<X>; its source is brain_gold_local.brain_gold.<X> OR brain_silver_local.brain_silver.<X> — refresh
    # BOTH candidates (the wrong one silently no-ops). Additive + metadata-only (never alters the catalog).
    local src="${mv#mv_}"
    docker exec "$SR_CONTAINER" mysql -h127.0.0.1 -P9030 -uroot -N \
      -e "REFRESH EXTERNAL TABLE brain_gold_local.brain_gold.${src};" >/dev/null 2>&1 || true
    docker exec "$SR_CONTAINER" mysql -h127.0.0.1 -P9030 -uroot -N \
      -e "REFRESH EXTERNAL TABLE brain_silver_local.brain_silver.${src};" >/dev/null 2>&1 || true
    # WITH SYNC MODE blocks until the refresh completes → deterministic Gold for the next dashboard read.
    if docker exec "$SR_CONTAINER" mysql -h127.0.0.1 -P9030 -uroot -N \
      -e "REFRESH MATERIALIZED VIEW ${SERVING_DB}.${mv} WITH SYNC MODE;" >/dev/null 2>&1; then
      n=$((n+1))
    else
      failed=$((failed+1)); echo "[$(ts)] ⚠ refresh ${SERVING_DB}.${mv} failed"
    fi
  done <<< "$mvs"
  echo "[$(ts)] ✓ refreshed ${n} serving MV(s) WITH SYNC MODE"
  jlog v4_mv_refresh refreshed="$n" failed="$failed"
}

run_once() {
  local failures=0 cycle_start cycle_end
  # New correlation_id per cycle, EXPORTED so every Spark job (job_log.py) + node job echoes it.
  export V4_CORRELATION_ID="$(new_correlation_id)"
  cycle_start=$(now_ms)
  echo "[$(ts)] ── V4 refresh: identity → silver_order_state → silver → stitch → gold → mv SYNC ──"
  jlog v4_cycle phase=start

  # 0. IDENTITY EXPORT — Neo4j → brain_ops.silver_identity_link (resolves order brain_id downstream).
  if [ "${SKIP_IDENTITY:-0}" != "1" ]; then
    run_node_job identity-export @brain/stream-worker src/jobs/identity-export/run.ts || failures=$((failures+1))
  fi

  # 1. SILVER ORDER STATE — the spine; resolves brain_id from silver_identity_link.
  run_spark_script silver-order-state "$SPARK_ROOT/run-silver-orders.sh" || failures=$((failures+1))

  # 2. THE REST OF SILVER — every other silver_* mart (incl. an initial silver_touchpoint pass so the
  #    stitch job has a journey corpus to read in step 3b). run-silver-orders.sh is re-run here as part of
  #    the bulk glob, which is a harmless idempotent no-op (already current from step 1).
  run_spark_tier silver "${SILVER_REST[@]}"; failures=$((failures+$?))

  # 3a. GOLD REVENUE LEDGER + refresh the two MVs the stitch job reads (mv_silver_touchpoint journey anons,
  #     mv_gold_revenue_ledger order→brain_id). These must be fresh BEFORE journey-stitch runs.
  run_spark_script gold-revenue-ledger "$SPARK_ROOT/run-gold-revenue.sh" || failures=$((failures+1))
  refresh_serving_mvs "mv_silver_touchpoint mv_gold_revenue_ledger"

  # 3b. JOURNEY STITCH — deterministic, unambiguous-only anon→customer→order stitch (GAP-1), then export
  #     PG connector_journey_stitch_map → brain_ops.silver_journey_stitch. Populates the stitch silver_
  #     touchpoint reads in step 4.
  if [ "${SKIP_STITCH:-0}" != "1" ]; then
    run_node_job journey-stitch-from-identity @brain/stream-worker src/jobs/journey-stitch-from-identity.ts || failures=$((failures+1))
    run_node_job journey-stitch-export        @brain/stream-worker src/jobs/journey-stitch-export/run.ts    || failures=$((failures+1))
  fi

  # 4. REBUILD silver_touchpoint — now that brain_ops.silver_journey_stitch is populated, rebuild so the
  #    stitched_anon_id / stitched_brain_id columns the attribution job reads are no longer NULL.
  run_spark_script silver-touchpoint-restitch "$TOUCHPOINT_SCRIPT" || failures=$((failures+1))

  # 5. THE REST OF GOLD — revenue (idempotent no-op), attribution (reads stitched touchpoints + ledger
  #    basis), customer, gap, executive marts. gold_revenue is re-run here via the glob (idempotent).
  run_spark_tier gold "${GOLD_SCRIPTS[@]}"; failures=$((failures+$?))

  # 6. mv_* SYNC refresh — every brain_serving mv_* so the serving tier reflects the fresh Iceberg Gold.
  refresh_serving_mvs

  cycle_end=$(now_ms)
  if [ "$failures" -eq 0 ]; then
    echo "[$(ts)] ✓ V4 refresh cycle complete (0 failures)"
  else
    echo "[$(ts)] ⚠ V4 refresh cycle complete with ${failures} failed step(s) — see /tmp/v4-refresh-*.log"
  fi
  jlog v4_cycle phase=end status="$([ "$failures" -eq 0 ] && echo ok || echo degraded)" \
    failures="$failures" duration_ms=$(( cycle_end - cycle_start ))
  return "$failures"
}

if [ "${ONESHOT:-0}" = "1" ]; then
  run_once
  exit $?
fi

echo "▶ V4 refresh loop — every ${INTERVAL}s (Ctrl-C to stop)"
while true; do
  run_once || true   # a failed cycle is logged; the loop keeps the analytics layer converging next pass
  echo "[$(ts)] next cycle in ${INTERVAL}s"
  sleep "$INTERVAL"
done
