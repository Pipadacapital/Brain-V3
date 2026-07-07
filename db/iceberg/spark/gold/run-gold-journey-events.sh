#!/usr/bin/env bash
# run-gold-journey-events.sh — Brain V4 spec gap G4 (re-ratified): build the ADDITIVE versioned
# event-sourced journey ledger brain_gold.journey_events from Iceberg brain_silver.silver_touchpoint
# (+ silver_identity_map confidence, + silver_order_state revenue truth on composite rows).
# Additive / non-breaking — repoints NO reader, changes NO existing mart (gold_journey_paths /
# gold_journey are different grains and stay untouched), writes ONLY brain_gold.journey_events.
# Mirrors run-gold-journey-paths.sh (same netns + Iceberg-runtime spark-submit shape).
#
# Builds:
#   journey_events   (1 row per brand_id × touchpoint_id × data_version — every touchpoint re-keyed
#                     onto the resolved brain_id, versioned so identity merges never rewrite history;
#                     served WHERE is_current via mv_journey_events_current)
#
# The job is an idempotent MERGE on (brand_id, touchpoint_id, data_version), incremental via the
# gold_partition_filter brand watermark on silver_touchpoint.updated_at. The merge re-versioning
# companion (gold_journey_events_reversion.py) runs via run-gold-journey-reversion.sh, which the
# v4-refresh-loop glob sequences AFTER this script.
#
# Usage:  db/iceberg/spark/gold/run-gold-journey-events.sh
# Env:    SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER, FULL_REFRESH overridable.
set -euo pipefail

# AUD-INFRA-006: host-global batch-Spark admission lock — overlapping refresh loops / manual runs QUEUE
# behind the one running batch container instead of stacking 7g-cap JVMs. Streaming sinks excluded.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/_spark_lock.sh"

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
# Join Redpanda's network namespace so service-name DNS (iceberg-rest, minio) resolves — the same netns
# trick the other Spark run scripts use.
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
GOLD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${GOLD_DIR}/.." && pwd)"   # holds iceberg_base.py (shared --py-files)

# Bounded retry around the (idempotent MERGE) spark-submit — a transient blip is safe to re-run.
source "${SPARK_DIR}/_retry.sh"

# Iceberg runtime + AWS bundle (Silver→Gold only; no external JDBC source).
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

MODEL="gold_journey_events"

echo "[gold-journey-events] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} model='${MODEL}'"

docker volume create brain-spark-ivy >/dev/null

echo ""
echo "================ BUILD gold mart: ${MODEL} (table journey_events) ================"
spark_retry "gold-journey-events/${MODEL}" \
docker run --rm \
  --memory "${SPARK_CONTAINER_MEMORY:-7g}" \
  --oom-score-adj "${SPARK_CONTAINER_OOM_SCORE_ADJ:-100}" \
  --network "container:${REDPANDA_CONTAINER}" \
  --user root \
  -v "${SPARK_DIR}":/opt/spark-src:ro \
  -v brain-spark-ivy:/root/.ivy2 \
  -e ICEBERG_CATALOG="${ICEBERG_CATALOG:-rest}" \
  -e ICEBERG_REST_URI="${ICEBERG_REST_URI:-http://iceberg-rest:8181}" \
  -e ICEBERG_WAREHOUSE="${ICEBERG_WAREHOUSE:-s3://brain-bronze/}" \
  -e SILVER_NAMESPACE="${SILVER_NAMESPACE:-brain_silver}" \
  -e GOLD_NAMESPACE="${GOLD_NAMESPACE:-brain_gold}" \
  -e S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}" \
  -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-brain}" \
  -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-brainbrain}" \
  -e AWS_REGION="${AWS_REGION:-us-east-1}" \
  -e V4_CORRELATION_ID="${V4_CORRELATION_ID:-}" \
  -e REDIS_URL="${REDIS_URL:-redis://redis:6379}" \
  -e SPARK_DRIVER_MEMORY="${SPARK_DRIVER_MEMORY:-4g}" \
  -e FULL_REFRESH="${FULL_REFRESH:-}" \
  -e SILVER_INCREMENTAL_OVERLAP_HOURS="${SILVER_INCREMENTAL_OVERLAP_HOURS:-2}" \
  -e SILVER_BATCH_TARGET_ROWS="${SILVER_BATCH_TARGET_ROWS:-500000}" \
  -e SILVER_MAX_CHUNKS="${SILVER_MAX_CHUNKS:-48}" \
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "local[2]" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    --py-files /opt/spark-src/iceberg_base.py,/opt/spark-src/silver/_silver_technical.py,/opt/spark-src/_identity_views.py,/opt/spark-src/_platform_flags.py \
    "/opt/spark-src/gold/${MODEL}.py"

echo ""
echo "[gold-journey-events] DONE — versioned journey_events ledger materialized in Iceberg brain_gold ✓"
