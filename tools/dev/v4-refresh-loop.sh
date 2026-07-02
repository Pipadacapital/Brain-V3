#!/usr/bin/env bash
#
# v4-refresh-loop.sh — keep the local-prod V4 analytics layer (Iceberg Silver/Gold + Trino serving)
# live, IN THE CORRECT DEPENDENCY ORDER so the derived (customer + attribution) marts actually POPULATE.
# This is the V4 REPLACEMENT for the retired dbt-refresh-loop.sh (Phase 6b).
#
# THE PROBLEM this solves: under Brain V4 the transform is Spark-on-Iceberg, NOT dbt. Dashboards read the
# brain_serving mv_* VIEWS served by Trino-over-Iceberg (StarRocks is REMOVED). Those views are thin
# projections over the EXTERNAL Iceberg catalogs (brain_silver_local / brain_gold_local), materialized
# FROM raw Iceberg Bronze by the Spark Silver + Gold jobs. In dev nothing auto-runs those jobs, so after a
# connector sync lands new orders in Bronze the Silver/Gold (and thus the mv_* views) stay stale →
# "connected but no data". Trino views are always-fresh (no async refresh) — they reflect the latest
# Iceberg snapshot the instant Spark commits it; we only (idempotently) ensure the views EXIST.
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
#   3a. gold_revenue_ledger       + ensure the mv_gold_revenue_ledger and mv_silver_touchpoint Trino views
#                                 exist, because…
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
#   6. mv_* views (ensure)        idempotent CREATE OR REPLACE of every brain_serving mv_* Trino view via
#                                 db/trino/views/run-trino-views.sh. Trino views need NO refresh — they
#                                 read the latest Iceberg snapshot directly — so this only guarantees a
#                                 from-zero stack has all serving views present.
#
# It touches NO Spark job and NO Iceberg catalog destructively — it only INVOKES the existing run scripts +
# the existing stream-worker jobs (identity-export / journey-stitch) and (idempotently) applies the Trino
# serving views. Tenant isolation + money discipline live inside the jobs/view definitions; this loop is
# pure orchestration. Every Spark MERGE + every job is idempotent → a retried/missed run is safe, so the
# loop wraps each step in a BOUNDED retry and surfaces a clear per-step failure.
#
# ── TWO-PHASE PIPELINE (F2) ──────────────────────────────────────────────────────────────────────────
# The Silver→Gold refresh is an explicit TWO-PHASE pipeline with a single handoff contract: CUSTOMER360.
#   PHASE 1 — IDENTITY: identity-export (Neo4j → brain_ops.silver_identity_link + silver_customer_identity)
#             → the brain_id-resolved Silver spine → gold_revenue_ledger + stitch-input views → journey-
#             stitch → the customer-360 GOLD build (run-gold-customer.sh: gold_customer_360 + segments/
#             cohorts/scores). OUTPUT = the Customer360 contract (the resolved spine + gold_customer_360).
#   PHASE 2 — BUSINESS INTELLIGENCE: CONSUMES Customer360 — revenue analytics, attribution/marketing-
#             attribution, executive/cac, and the gap marts (funnel/engagement/health/retention/
#             recommendation/…), then the full brain_serving Trino view tier. Runs strictly AFTER Phase 1.
# Customer360 is the HANDOFF: Phase 2 must never read a stale, un-resolved customer grain, so Phase 1
# (identity + Customer360) always completes before any Phase-2 BI mart runs. `--phase=both` (the default)
# is a pure regrouping of the pre-F2 sequence — no step was moved, added, or reordered.
#
# Usage:  pnpm dev:v4-refresh                 # every 300s (default; --phase=both)
#         REFRESH_INTERVAL_SECONDS=120 pnpm dev:v4-refresh
#         ONESHOT=1 pnpm dev:v4-refresh        # run the pipeline once and exit (CI / manual reproduce)
#         pnpm dev:v4-refresh -- --phase=1     # run ONLY Phase 1 (identity → Customer360 contract)
#         pnpm dev:v4-refresh -- --phase=2     # run ONLY Phase 2 (BI gold; assumes Customer360 is fresh)
#         PHASE=2 pnpm dev:v4-refresh          # same as --phase=2 (env form; the flag overrides the env)
#         SKIP_IDENTITY=1 / SKIP_STITCH=1      # skip the Neo4j/stitch sub-steps (e.g. Neo4j down)
#         MAX_RETRIES=2                        # bounded per-step retries (default 1 retry = 2 attempts)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INTERVAL="${REFRESH_INTERVAL_SECONDS:-300}"
SPARK_ROOT="$ROOT/db/iceberg/spark"
SILVER_DIR="$SPARK_ROOT/silver"
GOLD_DIR="$SPARK_ROOT/gold"
# Trino serving views (db/trino/views) — the V4 replacement for the StarRocks brain_serving MVs.
TRINO_VIEWS_RUNNER="$ROOT/db/trino/views/run-trino-views.sh"
APP_ENV="${APP_ENV:-local-prod}"
ENV_FILE="$ROOT/.env.${APP_ENV}"
# UNIFIED-BRONZE cutover (bronze_landing.py): export the Bronze-source switch so every silver run script
# this loop invokes reads the unified brain_bronze.events (default) instead of the split legacy tables.
# The dev sink (dev-bronze-streaming.sh) writes brain_bronze.events. Rollback = BRONZE_SOURCE=legacy.
export BRONZE_SOURCE="${BRONZE_SOURCE:-events}"
# Bounded retry: total attempts = MAX_RETRIES + 1 (so MAX_RETRIES=1 ⇒ one retry ⇒ 2 attempts).
MAX_RETRIES="${MAX_RETRIES:-1}"
RETRY_SLEEP_SECONDS="${RETRY_SLEEP_SECONDS:-10}"

# ── two-phase selector (F2) ────────────────────────────────────────────────────────────────────────────
# PHASE = 1 (identity → Customer360) | 2 (BI gold, consumes Customer360) | both (default). The env form
# (PHASE=…) sets the default; the --phase=… CLI flag overrides it. Default `both` keeps the pre-F2 path.
PHASE="${PHASE:-both}"
for _arg in "$@"; do
  case "$_arg" in
    --phase=1|--phase=2|--phase=both) PHASE="${_arg#--phase=}" ;;
    --phase=*) echo "✗ invalid --phase '${_arg#--phase=}' (expected 1|2|both)" >&2; exit 2 ;;
    *) : ;;  # ignore unknown args (forward-compatible)
  esac
done
case "$PHASE" in
  1|2|both) : ;;
  *) echo "✗ invalid PHASE '$PHASE' (expected 1|2|both)" >&2; exit 2 ;;
esac

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

# Gold is partitioned across the two phases by the Customer360 handoff:
#   GOLD_IDENTITY (Phase 1) — the customer-360 build (run-gold-customer.sh → gold_customer_360 + segments/
#                             cohorts/scores). It is the LAST Phase-1 step and materializes the Customer360
#                             contract Phase 2 consumes. It was already the FIRST script in the pre-F2 gold
#                             glob, so `--phase=both` runs the gold scripts in the identical order.
#   GOLD_BI (Phase 2)       — every other gold mart (revenue analytics / attribution / executive-cac / gap).
GOLD_IDENTITY=()
GOLD_BI=()
for g in "$SPARK_ROOT"/run-gold-*.sh "$GOLD_DIR"/run-*.sh; do
  [ -e "$g" ] || continue
  case "$(basename "$g")" in
    run-gold-customer.sh) GOLD_IDENTITY+=("$g") ;;
    *)                    GOLD_BI+=("$g") ;;
  esac
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
  # A genuinely MISSING script is a hard FAILURE (return 1), never a silent skip — a skip counted as
  # "ok" once masked a whole no-op FULL_REFRESH cycle as success (fail-safely, no false success).
  if [ ! -f "$s" ]; then
    echo "[$(ts)] ✗ ${label}: $(basename "$s") missing — FAILING"
    jlog v4_job job="$label" script="$(basename "$s")" status=fail duration_ms=0
    return 1
  fi
  # The run-*.sh entrypoints are tracked non-executable (mode 644) in several checkouts; invoke via
  # `bash` when the +x bit is absent rather than skipping. (Their shebang makes `bash <script>` exact.)
  local -a cmd=("$s")
  [ -x "$s" ] || cmd=(bash "$s")
  local start end rc
  start=$(now_ms)
  retry "${label}: $(basename "$s")" "/tmp/v4-refresh-${label}.log" -- "${cmd[@]}"; rc=$?
  end=$(now_ms)
  jlog v4_job job="$label" script="$(basename "$s")" \
    status="$([ "$rc" -eq 0 ] && echo ok || echo fail)" duration_ms=$(( end - start ))
  return "$rc"
}

# ── daily data-plane maintenance cadence (guard file; AUD-PERF-003) ────────────────────────────────────
# Retention/compaction must not run per-cycle: they contend with the SQLite-backed REST catalog and are
# pointless at 5-min granularity. A guard-file mtime gives them a daily cadence INSIDE the loop, at the
# end of a cycle (quiet window — the cycle's Spark jobs have all finished). The stamp is touched only on
# SUCCESS, so a failed maintenance run retries next cycle. stat -f = BSD/macOS, stat -c = GNU.
MAINT_INTERVAL_HOURS="${MAINT_INTERVAL_HOURS:-24}"
maintenance_due() {  # $1 = guard file → rc 0 when the job should run this cycle
  [ "${SKIP_MAINTENANCE:-0}" = "1" ] && return 1
  [ -f "$1" ] || return 0
  local mtime
  mtime="$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0)"
  [ $(( $(date +%s) - mtime )) -ge $(( MAINT_INTERVAL_HOURS * 3600 )) ]
}

run_maintenance_job() {  # $1=label  $2=script — daily-guarded run_spark_script; stamps guard on success
  local stamp="/tmp/brain-v4-${1}.stamp"
  maintenance_due "$stamp" || return 0
  if run_spark_script "$1" "$2"; then
    touch "$stamp"
    return 0
  fi
  return 1
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
# they pick up TRINO_*/NEO4J_*/BRAIN_APP_DATABASE_URL exactly like the deployed `node dist/...` cron.
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

# Trino serving views (db/trino/views/mv_*.sql) — applied idempotently (CREATE OR REPLACE VIEW) so a
# from-zero stack's first cycle creates the whole serving tier. Trino views are thin projections over the
# Iceberg Gold/Silver marts: there is NO async refresh and NO metadata-cache to invalidate — a view always
# reflects the latest Iceberg snapshot. So the StarRocks "REFRESH MATERIALIZED VIEW … WITH SYNC MODE" step
# collapses into "make sure the views EXIST". Delegates to db/trino/views/run-trino-views.sh.
#
# refresh_serving_mvs <optional space-separated mv list> :
#   - with an explicit list  → apply just those view files (VIEW_GLOB per name) — used on cold start when a
#                              downstream node job (journey-stitch) needs a specific view present NOW.
#   - with no args           → apply ALL mv_*.sql (the default VIEW_GLOB).
# Non-fatal: if a view's source Iceberg table isn't built yet the CREATE fails and is logged; the NEXT
# cycle (after the Spark job builds it) creates it. The runner is idempotent every cycle after.
refresh_serving_mvs() {  # $1 (optional) = explicit space-separated mv list; default = ALL mv_*
  local explicit="${1:-}" rc=0
  if [ ! -x "$TRINO_VIEWS_RUNNER" ]; then
    echo "[$(ts)] ⚠ Trino views runner not executable: $TRINO_VIEWS_RUNNER — skipping serving views"
    jlog v4_mv_refresh refreshed=0 failed=0 status=skipped
    return 1
  fi
  if [ -n "$explicit" ]; then
    local applied=0 failed=0 mv
    for mv in $explicit; do
      if VIEW_GLOB="${mv}.sql" "$TRINO_VIEWS_RUNNER" >/dev/null 2>&1; then
        applied=$((applied+1))
      else
        failed=$((failed+1)); echo "[$(ts)] ⚠ apply Trino view ${mv} failed"
      fi
    done
    echo "[$(ts)] ✓ applied ${applied} serving view(s) (scoped)"
    jlog v4_mv_refresh refreshed="$applied" failed="$failed"
    [ "$failed" -eq 0 ]; return $?
  fi
  # Default: apply every mv_*.sql view (CREATE OR REPLACE — cold-start self-bootstrap + idempotent).
  if "$TRINO_VIEWS_RUNNER" >/dev/null 2>&1; then
    echo "[$(ts)] ✓ applied all serving Trino views (db/trino/views)"
    jlog v4_mv_refresh refreshed=all failed=0
  else
    rc=$?
    echo "[$(ts)] ⚠ applying serving Trino views failed (rc=${rc}) — see Trino logs"
    jlog v4_mv_refresh refreshed=0 failed=1
  fi
  return "$rc"
}

# ── run_phase: one phase of the two-phase pipeline (F2) ────────────────────────────────────────────────
# run_phase <1|2> — runs exactly one phase and returns its number of failed steps. PHASE 1 builds the
# Customer360 contract (identity → resolved Silver spine → stitch → customer-360 Gold); PHASE 2 consumes
# Customer360 to build the BI Gold + serving views. The two-phase split is a pure REGROUPING of the pre-F2
# `run_once` body — every step keeps its original order, retry, jlog, and SKIP_* gate. Phase 2 MUST run
# after Phase 1 (run_once enforces this); never invoke run_phase 2 against a stale/empty Customer360.
run_phase() {
  local phase="$1" failures=0
  case "$phase" in
    1)
      jlog v4_phase phase=1 name=identity status=start
      # ── PHASE 1 — IDENTITY → CUSTOMER360 ──────────────────────────────────────────────────────────────
      # 0. IDENTITY EXPORT — Neo4j → brain_ops.silver_identity_link (resolves order brain_id downstream).
      if [ "${SKIP_IDENTITY:-0}" != "1" ]; then
        run_node_job identity-export @brain/stream-worker src/jobs/identity-export/run.ts || failures=$((failures+1))
      fi

      # 0b. SILVER COLLECTOR EVENT (ADR-0006 P2) — the R2/R3 admission gate over the RAW Kafka-Connect Bronze
      #     (brain_bronze.collector_events_raw), materializing brain_silver.silver_collector_event. ALL the
      #     downstream silver_* jobs that used to read brain_bronze.collector_events now read THIS gated table,
      #     so it MUST build before them. Idempotent MERGE; no-op when the raw table is empty.
      if [ "${SKIP_COLLECTOR_GATE:-0}" != "1" ]; then
        run_spark_script silver-collector-event "$SILVER_DIR/run-silver-collector-event.sh" || failures=$((failures+1))
      fi

      # 1. SILVER ORDER STATE — the spine; resolves brain_id from silver_identity_link.
      run_spark_script silver-order-state "$SPARK_ROOT/run-silver-orders.sh" || failures=$((failures+1))

      # 2. THE REST OF SILVER — every other silver_* mart (incl. an initial silver_touchpoint pass so the
      #    stitch job has a journey corpus to read in step 3b). run-silver-orders.sh is re-run here as part of
      #    the bulk glob, which is a harmless idempotent no-op (already current from step 1).
      #
      #    NEO4J wiring (silver_identity_alias.py): this tier includes run-silver-entities.sh, whose
      #    identity_alias job reads the Neo4j identity SoR via the Spark connector and projects the
      #    IDENTIFIES edges into brain_silver.silver_identity_alias (the Iceberg-native sibling of the node
      #    identity-export's brain_ops.silver_identity_link). These Spark jobs run in CONTAINERS on the
      #    compose network, so Neo4j is `neo4j:7687` — NOT the host `localhost:7687` that the HOST node
      #    identity-export (run_node_job, step 0) needs. So we SCOPE the container-correct NEO4J_* to just
      #    this subshell → it never leaks to the node jobs (journey-stitch-export runs after, on the host).
      #    SKIP_IDENTITY=1 (Neo4j down / CI) leaves NEO4J_URI unset → silver_identity_alias takes its
      #    documented data-thin skip (empty table, no read). SPARK_NEO4J_URI overrides the default if needed.
      (
        if [ "${SKIP_IDENTITY:-0}" != "1" ]; then
          export NEO4J_URI="${SPARK_NEO4J_URI:-bolt://neo4j:7687}"
          export NEO4J_USER="${NEO4J_USER:-neo4j}"
          export NEO4J_PASSWORD="${NEO4J_PASSWORD:-brain_neo4j}"
        fi
        run_spark_tier silver "${SILVER_REST[@]}"
      ); failures=$((failures+$?))

      # 3a. GOLD REVENUE LEDGER + ensure the two Trino views the stitch job reads EXIST (mv_silver_touchpoint
      #     journey anons, mv_gold_revenue_ledger order→brain_id). As Trino views they are always-fresh over
      #     Iceberg — we just guarantee they're created BEFORE journey-stitch reads them on a cold stack.
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

      # 4b. CUSTOMER-360 GOLD — the HANDOFF. run-gold-customer.sh materializes gold_customer_360 (+ segments/
      #     cohorts/scores) from the now identity-resolved Silver spine. This is the LAST Phase-1 step and the
      #     Customer360 contract Phase 2's BI marts consume. It was already the FIRST script in the pre-F2
      #     gold glob, so `--phase=both` runs the gold scripts in the identical order.
      run_spark_tier gold-customer "${GOLD_IDENTITY[@]}"; failures=$((failures+$?))
      jlog v4_phase phase=1 name=identity status=end failures="$failures"
      ;;
    2)
      jlog v4_phase phase=2 name=business_intelligence status=start
      # ── PHASE 2 — BUSINESS INTELLIGENCE (consumes Customer360) ─────────────────────────────────────────
      # 5. THE BI GOLD — revenue analytics (idempotent gold_revenue_ledger no-op + analytics), attribution
      #    (reads stitched touchpoints + ledger basis), executive/cac, and the gap marts (funnel/engagement/
      #    health/retention/recommendation/…). Every mart reads the fresh Phase-1 Customer360 + Silver spine.
      run_spark_tier gold "${GOLD_BI[@]}"; failures=$((failures+$?))

      # 5b. SCOPED RECOMPUTE — REMOVED with StarRocks. Its sole job was a TARGETED "REFRESH MATERIALIZED VIEW
      #     … WITH SYNC MODE" for the customer-grained brain_serving MVs after an identity merge/suppress, to
      #     avoid waiting for the full async refresh. Under V4-final the serving tier is Trino VIEWS over
      #     Iceberg — always-fresh, no refresh to schedule — so per-brand targeted refresh is moot. Draining
      #     the scoped_recompute_request queue (now the PG ops schema, migration 0116) is owned by the app/
      #     consumer side, not this Spark-orchestration loop.

      # 6. mv_* views (ensure) — idempotent CREATE OR REPLACE of every brain_serving Trino view so the serving
      #    tier exposes the fresh Iceberg Gold. Views always reflect the latest snapshot; no refresh needed.
      refresh_serving_mvs

      # 7. GOLD.REWRITTEN cache-bust — publish gold.rewritten.v1 per active brand so the
      #    AnalyticsCacheInvalidateConsumer evicts the brand's stale serving-cache Redis keys NOW
      #    instead of waiting out the per-metric TTL. BEST-EFFORT (fail-open): cache busting is an
      #    optimization — a Kafka/PG blip here must never mark the refresh cycle degraded; the
      #    per-metric TTL remains the correctness safety net. (Same rationale as the secrets snapshot.)
      run_node_job gold-rewritten-publish @brain/stream-worker src/jobs/gold-rewritten-publish/run.ts \
        || echo "[$(ts)] ⚠ gold.rewritten publish failed (best-effort — serving cache expires via TTL)"
      jlog v4_phase phase=2 name=business_intelligence status=end failures="$failures"
      ;;
    *)
      echo "[$(ts)] ✗ run_phase: unknown phase '$phase' (expected 1|2)"; return 1 ;;
  esac
  return "$failures"
}

# ── secrets durability auto-snapshot (prod-local) ───────────────────────────────────────────────────────
# In prod-local mode connector OAuth tokens live in LocalStack Secrets Manager, which does NOT persist
# across Docker restarts; `pnpm bootstrap` restores them from PG dev_secret on startup, but ONLY if they
# were snapshotted there first. Mirror SM → dev_secret once per cycle so any connector you (re)connect is
# captured within one cycle — ZERO manual `pnpm dev:secrets-snapshot`. Best-effort: a snapshot failure
# (e.g. LocalStack momentarily unreachable) NEVER breaks the refresh loop and is not counted as a failure.
snapshot_secrets_best_effort() {
  [ "$APP_ENV" = "local-prod" ] || return 0
  [ -f "$ROOT/tools/dev/secrets-snapshot.sh" ] || return 0
  local out n
  if out="$(bash "$ROOT/tools/dev/secrets-snapshot.sh" 2>&1)"; then
    n="$(printf '%s\n' "$out" | grep -c '✓ ')"
    echo "[$(ts)] ✓ secrets auto-snapshot: ${n} secret(s) mirrored → dev_secret (durable across restarts)"
  else
    echo "[$(ts)] ⚠ secrets auto-snapshot skipped (best-effort): $(printf '%s' "$out" | tail -1 | cut -c1-100)"
  fi
  return 0
}

run_once() {
  local failures=0 cycle_start cycle_end
  # New correlation_id per cycle, EXPORTED so every Spark job (job_log.py) + node job echoes it.
  export V4_CORRELATION_ID="$(new_correlation_id)"
  cycle_start=$(now_ms)
  echo "[$(ts)] ── V4 refresh (phase=${PHASE}): [1] identity→Customer360  →  [2] BI gold→mv views ──"
  jlog v4_cycle phase=start pipeline_phase="$PHASE"

  # Auto-capture any (re)connected connector tokens into durable storage (best-effort; never fails the cycle).
  snapshot_secrets_best_effort

  # Two-phase pipeline (F2). Phase 2 runs strictly AFTER Phase 1 so the BI marts always consume a fresh,
  # identity-resolved Customer360. Default --phase=both runs both in order (the pre-F2 sequence).
  if [ "$PHASE" = "1" ] || [ "$PHASE" = "both" ]; then
    run_phase 1; failures=$((failures+$?))
  fi
  if [ "$PHASE" = "2" ] || [ "$PHASE" = "both" ]; then
    run_phase 2; failures=$((failures+$?))
  fi

  # ── DAILY MAINTENANCE (guard-file cadence; end of cycle = quiet window) ────────────────────────────
  # ADR-0006 D4 raw-PII short retention (AUD-PERF-003): row-TTL DELETE + snapshot expiry over the raw
  # Bronze tables, incl. the unified brain_bronze.events connector lanes. Compliance job — a failure
  # marks the cycle degraded (and retries next cycle: the guard stamp is only touched on success).
  run_maintenance_job bronze-raw-retention "$SPARK_ROOT/run-bronze-raw-retention.sh" || failures=$((failures+1))
  # Iceberg Silver+Gold compaction + snapshot expiry + guarded orphan-file sweep (AUD-PERF-004): the
  # per-cycle MERGEs/overwrites shard the marts into thousands of ~16KB files that nothing ever
  # coalesced. Runs at the end of the cycle so it never contends with this cycle's mart writes.
  run_maintenance_job medallion-maintenance "$SPARK_ROOT/run-medallion-maintenance.sh" || failures=$((failures+1))

  cycle_end=$(now_ms)
  if [ "$failures" -eq 0 ]; then
    echo "[$(ts)] ✓ V4 refresh cycle complete (0 failures)"
  else
    echo "[$(ts)] ⚠ V4 refresh cycle complete with ${failures} failed step(s) — see /tmp/v4-refresh-*.log"
  fi
  jlog v4_cycle phase=end pipeline_phase="$PHASE" \
    status="$([ "$failures" -eq 0 ] && echo ok || echo degraded)" \
    failures="$failures" duration_ms=$(( cycle_end - cycle_start ))
  return "$failures"
}

if [ "${ONESHOT:-0}" = "1" ]; then
  run_once
  exit $?
fi

# ── single-loop guard (AUD-INFRA-006): a second CONTINUOUS loop exits with a clear message instead of
# doubling every Spark step. ONESHOT=1 runs (dev-up) stay allowed — they QUEUE behind the running loop's
# current job via the per-script batch-Spark admission lock (db/iceberg/spark/_spark_lock.sh).
LOOP_PIDFILE="${LOOP_PIDFILE:-${TMPDIR:-/tmp}/brain-v4-refresh-loop.pid}"
if [ -f "$LOOP_PIDFILE" ] && kill -0 "$(cat "$LOOP_PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "✗ another V4 refresh loop is already running (pid $(cat "$LOOP_PIDFILE")) — not starting a second one." >&2
  echo "  (ONESHOT=1 single cycles remain allowed; they queue via the Spark batch lock.)" >&2
  exit 1
fi
echo "$$" > "$LOOP_PIDFILE"
trap 'rm -f "$LOOP_PIDFILE"' EXIT

echo "▶ V4 refresh loop — phase=${PHASE}, every ${INTERVAL}s (Ctrl-C to stop)"
while true; do
  run_once || true   # a failed cycle is logged; the loop keeps the analytics layer converging next pass
  echo "[$(ts)] next cycle in ${INTERVAL}s"
  sleep "$INTERVAL"
done
