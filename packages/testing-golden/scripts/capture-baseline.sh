#!/usr/bin/env bash
# SPEC: WA.1.10 — golden snapshot harness (§1.10)
#
# Captures TODAY'S pipeline outputs over the golden dataset — the flags-OFF regression
# baseline every wave gate byte-compares against (§0.5 / §1.9 item 8).
#
# Pipeline (mirrors production topology exactly):
#   (0) seed the 3 golden brands (idempotent)                         [scripts/seed-golden-brands.sh]
#   (a) generate + produce golden events into Kafka                   [kafka-console-producer, keyed by brand_id]
#   (b) wait for the Kafka-Connect Iceberg Bronze landing (ADR-0010)  [poll brain_bronze.collector_events_connect]
#       + wait for the stream-worker identity consumer to settle      [poll Neo4j golden Customer count]
#   (c) run the refresh loop ONCE                                     [ONESHOT=1 pnpm dev:v4-refresh]
#   (d) export snapshot CSVs of the key outputs per brand via Trino
#   (e) write sha256 checksums to snapshots/baseline/
#
# Determinism notes:
#   - volatile columns (ingested_at / updated_at / silver_version / customer_watermark /
#     metric_snapshot_id) are EXCLUDED from exports;
#   - brain_id is a random mint → every export substitutes a STABLE surrogate
#     (min current identifier_hash from silver_identity_map) so baselines survive
#     stack rebuilds; anonymous_<anon> ids are already deterministic.
#
# Usage:
#   packages/testing-golden/scripts/capture-baseline.sh                 # capture baseline
#   packages/testing-golden/scripts/capture-baseline.sh --compare       # export candidate + diff vs baseline
#   packages/testing-golden/scripts/capture-baseline.sh --skip-produce  # refresh + export only (events already in)
#   ... --include-raw-lanes                                             # also produce shopify raw lane
#   ... --events-dir <dir>                                              # reuse pre-generated JSONL
#
# Env: GOLDEN_TOPIC_PREFIX (default prod) · KAFKA_CONTAINER · TRINO_CONTAINER ·
#      PG_CONTAINER · NEO4J_CONTAINER · LANDING_TIMEOUT_S (900) · SKIP_IDENTITY_WAIT=1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"

TOPIC_PREFIX="${GOLDEN_TOPIC_PREFIX:-prod}"
KAFKA_CONTAINER="${KAFKA_CONTAINER:-brainv3-kafka-1}"
TRINO_CONTAINER="${TRINO_CONTAINER:-brainv3-trino-1}"
NEO4J_CONTAINER="${NEO4J_CONTAINER:-brainv3-neo4j-1}"
LANDING_TIMEOUT_S="${LANDING_TIMEOUT_S:-900}"

# FIXED brand ids — MUST match src/fixtures.ts
AURORA_ID='a0a0a0a0-0001-4000-8000-000000000a01'
BAZAAR_ID='b0b0b0b0-0002-4000-8000-000000000b02'
CEDAR_ID='c0c0c0c0-0003-4000-8000-000000000c03'
BRANDS_SQL="'${AURORA_ID}','${BAZAAR_ID}','${CEDAR_ID}'"
BRANDS_CYPHER="['${AURORA_ID}','${BAZAAR_ID}','${CEDAR_ID}']"

COMPARE=0; SKIP_PRODUCE=0; INCLUDE_RAW=0; EVENTS_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --compare) COMPARE=1 ;;
    --skip-produce) SKIP_PRODUCE=1 ;;
    --include-raw-lanes) INCLUDE_RAW=1 ;;
    --events-dir) EVENTS_DIR="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

if [ "$COMPARE" = "1" ]; then
  OUT_DIR="$PKG_DIR/snapshots/candidate"
else
  OUT_DIR="$PKG_DIR/snapshots/baseline"
fi
mkdir -p "$OUT_DIR"

ts() { date +%H:%M:%S; }
log() { echo "[$(ts)] [capture-baseline] $*"; }

trino_exec() { # $1 = sql → stdout rows
  docker exec "$TRINO_CONTAINER" trino --server localhost:8080 --user brain \
    --execute "$1" --output-format TSV 2>/dev/null
}
trino_csv() { # $1 = sql, $2 = out file
  docker exec "$TRINO_CONTAINER" trino --server localhost:8080 --user brain \
    --execute "$1" --output-format CSV_HEADER 2>/dev/null > "$2"
}

# ── (0) seed golden brands ─────────────────────────────────────────────────────
bash "$SCRIPT_DIR/seed-golden-brands.sh"

# ── (a) generate + produce ─────────────────────────────────────────────────────
if [ -z "$EVENTS_DIR" ]; then
  EVENTS_DIR="$PKG_DIR/.golden-events"
  log "generating golden dataset → $EVENTS_DIR"
  (cd "$REPO_ROOT" && pnpm --filter @brain/testing-golden generate --out "$EVENTS_DIR")
fi
COLLECTOR_FILE="$EVENTS_DIR/collector.event.v1.jsonl"
MANIFEST_FILE="$EVENTS_DIR/manifest.json"
[ -f "$COLLECTOR_FILE" ] || { echo "missing $COLLECTOR_FILE" >&2; exit 1; }
EXPECTED_COLLECTOR="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST_FILE','utf8')).files.find(f=>f.file==='collector.event.v1.jsonl').count)")"

produce_file() { # $1=file $2=topic [$3=const key]
  local extra=()
  [ $# -ge 3 ] && extra=(--key "$3")
  log "producing $(basename "$1") → $2"
  # KAFKA_OPTS carries the broker's JMX javaagent; a second JVM in the same
  # container can't bind the port and the agent System.exit()s the CLI → clear it.
  # ${extra[@]+…} guard: bash 3.2 (macOS) + set -u errors on empty-array expansion.
  node "$SCRIPT_DIR/produce-jsonl.mjs" "$1" ${extra[@]+"${extra[@]}"} | docker exec -i \
    -e KAFKA_OPTS= -e KAFKA_JMX_OPTS= "$KAFKA_CONTAINER" \
    /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server localhost:9092 \
    --topic "$2" --property parse.key=true --property "key.separator=	" >/dev/null
}

if [ "$SKIP_PRODUCE" = "0" ]; then
  produce_file "$COLLECTOR_FILE" "${TOPIC_PREFIX}.collector.event.v1"
  if [ "$INCLUDE_RAW" = "1" ] && [ -f "$EVENTS_DIR/shopify.orders.raw.v1.jsonl" ]; then
    produce_file "$EVENTS_DIR/shopify.orders.raw.v1.jsonl" "${TOPIC_PREFIX}.shopify.orders.raw.v1" "$AURORA_ID"
  fi
else
  log "--skip-produce: assuming golden events already landed"
fi

# ── (b) wait for Connect Bronze landing ────────────────────────────────────────
if [ "$SKIP_PRODUCE" = "0" ]; then
  log "waiting for Bronze landing: >= $EXPECTED_COLLECTOR golden rows in brain_bronze.collector_events_connect (timeout ${LANDING_TIMEOUT_S}s)"
  DEADLINE=$(( $(date +%s) + LANDING_TIMEOUT_S ))
  while :; do
    LANDED="$(trino_exec "SELECT count(*) FROM iceberg.brain_bronze.collector_events_connect WHERE json_extract_scalar(payload, '\$.brand_id') IN (${BRANDS_SQL})" | tail -1 | tr -d '\"' || echo 0)"
    log "  landed=${LANDED:-0}/${EXPECTED_COLLECTOR}"
    if [ "${LANDED:-0}" -ge "$EXPECTED_COLLECTOR" ]; then break; fi
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      echo "[capture-baseline] TIMEOUT waiting for Connect landing (is kafka-connect up + iceberg-bronze-collector registered?)" >&2
      exit 1
    fi
    sleep 15
  done

  # stream-worker identity consumer settle: golden Customer count in Neo4j stops growing
  if [ "${SKIP_IDENTITY_WAIT:-0}" != "1" ]; then
    log "waiting for identity consumer to settle (Neo4j golden Customer count stable)"
    PREV=-1; STABLE=0
    DEADLINE=$(( $(date +%s) + LANDING_TIMEOUT_S ))
    while :; do
      CNT="$(docker exec "$NEO4J_CONTAINER" cypher-shell -u neo4j -p brain_neo4j --format plain \
        "MATCH (c:Customer) WHERE c.brand_id IN ${BRANDS_CYPHER} RETURN count(c);" 2>/dev/null | tail -1 || echo 0)"
      log "  golden Customer nodes=${CNT:-0}"
      if [ "${CNT:-0}" -gt 0 ] && [ "$CNT" = "$PREV" ]; then
        STABLE=$((STABLE + 1))
        [ "$STABLE" -ge 2 ] && break
      else
        STABLE=0
      fi
      PREV="$CNT"
      if [ "$(date +%s)" -ge "$DEADLINE" ]; then
        echo "[capture-baseline] TIMEOUT: identity consumer not settling — is the stream-worker running? (SKIP_IDENTITY_WAIT=1 to bypass)" >&2
        exit 1
      fi
      sleep 20
    done
  fi
fi

# ── (c) refresh loop ONESHOT ───────────────────────────────────────────────────
log "running refresh loop ONESHOT (identity-export → Silver → stitch → Gold → views)"
(cd "$REPO_ROOT" && ONESHOT=1 pnpm dev:v4-refresh)

# HONEST GUARD: the golden envelopes deliberately carry NO ingested_at (determinism — they are
# produced straight to Kafka, bypassing the collector's ingest stamp). silver_collector_event's
# incremental watermark filters on the payload-lifted ingested_at, and a NULL never satisfies
# `ingested_at >= wm` — so on a stack whose Silver target is already NON-empty (live brands), an
# incremental run SKIPS every golden row and the exports below would snapshot an empty baseline.
# Fail loudly with the remediation instead of writing a hollow snapshot.
SILVER_GOLDEN="$(trino_exec "SELECT count(*) FROM iceberg.brain_silver.silver_collector_event WHERE brand_id IN (${BRANDS_SQL})" | tail -1 | tr -d '\"' || echo 0)"
if [ "${SILVER_GOLDEN:-0}" -eq 0 ]; then
  cat >&2 <<'EOF'
[capture-baseline] FATAL: refresh completed but silver_collector_event holds ZERO golden-brand rows.
  Cause: golden envelopes have no ingested_at → the Silver incremental watermark filter drops them
  when the target is already non-empty (live-brand stacks). Remediate with a ONE-TIME full refresh of
  the admission gate (keystone), then re-run this script:
    FULL_REFRESH=1 STAGE=keystone bash tools/dev/duckdb-refresh.sh
  (Spark→DuckDB cutover: the transform tier is DuckDB now — the old Spark run script + its
  SILVER_BATCH_TARGET_ROWS/SILVER_MAX_CHUNKS adaptive-batch env no longer apply; FULL_REFRESH re-admits
  the NULL-ingested_at golden rows.)
EOF
  exit 1
fi
log "golden rows admitted to Silver: ${SILVER_GOLDEN}"

# ── (d) export snapshot CSVs ───────────────────────────────────────────────────
# Stable-ref CTE: brain_id → min current identifier_hash (deterministic surrogate).
REF_CTE="WITH ref AS (SELECT brain_id, min(identifier_hash) AS stable_ref FROM iceberg.brain_silver.silver_identity_map WHERE is_current AND brand_id IN (${BRANDS_SQL}) GROUP BY brain_id)"

declare -a EXPORT_NAMES=()

export_table() { # $1=name $2=sql
  local out="$OUT_DIR/$1.csv"
  log "exporting $1"
  if trino_csv "$2" "$out"; then
    EXPORT_NAMES+=("$1")
  else
    echo "[capture-baseline] WARN: export $1 FAILED (table missing or query error)" >&2
    rm -f "$out"
  fi
}

export_table silver_collector_event "
SELECT event_id, brand_id, to_iso8601(occurred_at) AS occurred_at, schema_name, schema_version,
       event_type, correlation_id, partition_key, event_category, anonymous_id, device_id, payload
FROM iceberg.brain_silver.silver_collector_event
WHERE brand_id IN (${BRANDS_SQL})
ORDER BY brand_id, occurred_at, event_id"

export_table silver_touchpoint "
${REF_CTE}
SELECT t.brand_id, t.brain_anon_id, t.touch_seq, t.session_key, t.session_seq, t.is_first_touch,
       t.is_last_touch, to_iso8601(t.occurred_at) AS occurred_at, t.event_type, t.channel,
       t.utm_source, t.utm_medium, t.utm_campaign, t.utm_term, t.utm_content,
       t.fbclid, t.gclid, t.ttclid, t.msclkid, t.gbraid, t.wbraid, t.dclid,
       t.referrer_host, t.landing_path, t.page_type, t.product_handle, t.collection_handle,
       t.search_query, t.stitched_order_id,
       coalesce(r.stable_ref, t.stitched_brain_id) AS stitched_brain_ref,
       t.is_synthetic, t.session_id_raw, t.is_composite, t.composite_order_key
FROM iceberg.brain_silver.silver_touchpoint t
LEFT JOIN ref r ON r.brain_id = t.stitched_brain_id
WHERE t.brand_id IN (${BRANDS_SQL})
ORDER BY t.brand_id, t.brain_anon_id, t.touch_seq"

export_table gold_revenue_ledger "
${REF_CTE}
SELECT l.brand_id, l.ledger_event_id, l.order_id, coalesce(r.stable_ref, l.brain_id) AS brain_ref,
       l.event_type, l.amount_minor, l.currency_code, l.fee_minor,
       to_iso8601(l.occurred_at) AS occurred_at,
       to_iso8601(l.economic_effective_at) AS economic_effective_at,
       l.recognition_label, l.billing_posted_period, l.data_source
FROM iceberg.brain_gold.gold_revenue_ledger l
LEFT JOIN ref r ON r.brain_id = l.brain_id
WHERE l.brand_id IN (${BRANDS_SQL})
ORDER BY l.brand_id, l.order_id, l.event_type, l.ledger_event_id"

export_table gold_attribution_credit "
SELECT brand_id, credit_id, order_id, brain_anon_id, touch_seq, channel, campaign_id, model_id,
       row_kind, weight_fraction, credited_revenue_minor, currency_code, reversed_of_credit_id,
       reversal_reason, realized_revenue_minor, confidence_grade, attribution_confidence,
       model_version, to_iso8601(occurred_at) AS occurred_at,
       to_iso8601(economic_effective_at) AS economic_effective_at, billing_posted_period
FROM iceberg.brain_gold.gold_attribution_credit
WHERE brand_id IN (${BRANDS_SQL})
ORDER BY brand_id, order_id, model_id, touch_seq, credit_id"

export_table journey_events "
${REF_CTE}
SELECT j.brand_id, coalesce(r.stable_ref, j.brain_id) AS brain_ref, j.touchpoint_id,
       j.source_event_ref, j.data_version, j.is_current, j.sequence_number,
       to_iso8601(j.occurred_at) AS occurred_at, j.session_key, j.event_category, j.event_type,
       j.channel, j.campaign, j.revenue_minor, j.currency_code,
       json_format(cast(j.product_handles AS json)) AS product_handles,
       json_format(cast(j.attribution_signals AS json)) AS attribution_signals,
       j.identity_confidence, j.is_composite, j.composite_order_key,
       coalesce(r2.stable_ref, j.brain_id_asof) AS brain_ref_asof, j.identity_confidence_asof
FROM iceberg.brain_gold.journey_events j
LEFT JOIN ref r  ON r.brain_id  = j.brain_id
LEFT JOIN ref r2 ON r2.brain_id = j.brain_id_asof
WHERE j.brand_id IN (${BRANDS_SQL})
ORDER BY j.brand_id, j.touchpoint_id, j.data_version"

export_table gold_customer_360 "
${REF_CTE}
SELECT c.brand_id, coalesce(r.stable_ref, c.brain_id) AS brain_ref, c.lifetime_orders,
       c.lifetime_value_minor, c.aov_minor, c.currency_code,
       to_iso8601(c.first_seen_at) AS first_seen_at,
       to_iso8601(c.first_identified_at) AS first_identified_at,
       to_iso8601(c.last_seen_at) AS last_seen_at,
       to_iso8601(c.last_activity_at) AS last_activity_at,
       c.delivered_orders, c.rto_orders, c.cancelled_orders, c.refunded_orders,
       c.preferred_channel, c.preferred_device, c.top_category, c.acquisition_source,
       c.health_band, c.churn_score, c.lifecycle_stage, c.journey_summary
FROM iceberg.brain_gold.gold_customer_360 c
LEFT JOIN ref r ON r.brain_id = c.brain_id
WHERE c.brand_id IN (${BRANDS_SQL})
ORDER BY c.brand_id, brain_ref"

# Honest-rejection ledgers (consent-off + quarantine coverage evidence) — counts only.
export_table _counts "
SELECT 'silver_consent_rejected' AS table_name, brand_id, count(*) AS rows
FROM iceberg.brain_silver.silver_consent_rejected WHERE brand_id IN (${BRANDS_SQL}) GROUP BY 2
UNION ALL
SELECT 'silver_quarantine', brand_id, count(*)
FROM iceberg.brain_silver.silver_quarantine WHERE brand_id IN (${BRANDS_SQL}) GROUP BY 2
UNION ALL
SELECT 'silver_identity_map_current', brand_id, count(*)
FROM iceberg.brain_silver.silver_identity_map WHERE is_current AND brand_id IN (${BRANDS_SQL}) GROUP BY 2
ORDER BY 1, 2"

# ── (e) checksums + manifest ───────────────────────────────────────────────────
log "writing checksums"
( cd "$OUT_DIR" && rm -f checksums.sha256 && for n in "${EXPORT_NAMES[@]}"; do
    shasum -a 256 "$n.csv" >> checksums.sha256
  done )

DATASET_CHECKSUM="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST_FILE','utf8')).datasetChecksum)" 2>/dev/null || echo unknown)"
node -e "
const fs = require('fs');
fs.writeFileSync('$OUT_DIR/baseline-manifest.json', JSON.stringify({
  spec: 'WA.1.10',
  capturedAt: new Date().toISOString(),
  topicPrefix: '$TOPIC_PREFIX',
  datasetChecksum: '$DATASET_CHECKSUM',
  exports: '${EXPORT_NAMES[*]}'.split(' ').filter(Boolean),
}, null, 2) + '\n');
"

if [ "$COMPARE" = "1" ]; then
  BASE="$PKG_DIR/snapshots/baseline/checksums.sha256"
  [ -f "$BASE" ] || { echo "[capture-baseline] no baseline to compare against ($BASE)" >&2; exit 1; }
  log "comparing candidate vs baseline"
  if diff "$BASE" "$OUT_DIR/checksums.sha256"; then
    log "PASS — flags-OFF outputs are byte-identical to the baseline"
  else
    echo "[capture-baseline] FAIL — snapshot drift detected (see diff above)" >&2
    exit 1
  fi
else
  log "baseline captured → $OUT_DIR"
fi
