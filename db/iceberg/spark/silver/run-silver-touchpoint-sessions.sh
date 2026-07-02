#!/usr/bin/env bash
# run-silver-touchpoint-sessions.sh — Brain V4 Phase 1 (Spark Silver, dual-run): build the journey
# touchpoint + session Silver marts in Iceberg brain_silver from raw Iceberg Bronze (collector_events),
# BESIDE the live dbt→StarRocks brain_silver (additive, non-breaking — no reader/app/dbt change).
# Mirrors ../run-provision-silver-gold.sh + run-silver-checkout-shipment.sh.
#
# Builds, in dependency order (silver_sessions reads the Iceberg silver_touchpoint):
#   1. silver_touchpoint   (folds stg_touchpoint_events + int_touchpoint_sessionized) — Bronze → brain_silver
#   2. silver_sessions     (rolls the touch grain up to the session grain)            — Silver → brain_silver
#
# Each job is an idempotent MERGE on its model PK (replay-safe). Requires the compose `lakehouse` profile
# (iceberg-rest + minio) up; Bronze (rest.brain_bronze.collector_events) populated by the Bronze sink.
# silver_touchpoint also reads the PG ops.silver_journey_stitch export over PG JDBC (brain_ops now lives
# in PG schema `ops`, PG operational-only store) → the PostgreSQL JDBC driver is on the classpath.
#
# Usage:  db/iceberg/spark/silver/run-silver-touchpoint-sessions.sh
#         MODEL=silver_touchpoint db/iceberg/spark/silver/run-silver-touchpoint-sessions.sh   # one model
# Env:    SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER, MODEL overridable.
set -euo pipefail

# AUD-INFRA-006: host-global batch-Spark admission lock — overlapping refresh loops / manual runs QUEUE
# behind the one running batch container instead of stacking 7g-cap JVMs. Streaming sinks excluded.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/_spark_lock.sh"

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
# The PostgreSQL JDBC driver reads ops.silver_journey_stitch (brain_ops moved to PG schema `ops`).
PG_JDBC_VERSION="${PG_JDBC_VERSION:-42.7.4}"
SCALA="2.12"
# Join Redpanda's network namespace so service-name DNS (iceberg-rest, minio, postgres) resolves — the
# same netns trick the other Spark run scripts use.
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SILVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${SILVER_DIR}/.." && pwd)"   # holds iceberg_base.py (shared --py-files)

# Iceberg runtime + AWS bundle + PostgreSQL JDBC (the PG ops.silver_journey_stitch stitch read).
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.postgresql:postgresql:${PG_JDBC_VERSION}"

# Default: both in dependency order. Override with MODEL=<one> to run a single job.
MODELS="${MODEL:-silver_touchpoint silver_sessions}"

echo "[silver] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} models='${MODELS}'"

docker volume create brain-spark-ivy >/dev/null

for model in ${MODELS}; do
  echo ""
  echo "================ BUILD silver mart: ${model} ================"
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
    -e BRONZE_NAMESPACE="${BRONZE_NAMESPACE:-brain_bronze}" \
    -e SILVER_NAMESPACE="${SILVER_NAMESPACE:-brain_silver}" \
    -e SILVER_PG_JDBC_URL="${SILVER_PG_JDBC_URL:-jdbc:postgresql://postgres:5432/brain}" \
    -e SILVER_PG_USER="${SILVER_PG_USER:-brain}" \
    -e SILVER_PG_PASSWORD="${SILVER_PG_PASSWORD:-brain}" \
    -e MURMUR_HASH3_SEED="${MURMUR_HASH3_SEED:-104729}" \
    -e S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}" \
    -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-brain}" \
    -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-brainbrain}" \
    -e AWS_REGION="${AWS_REGION:-us-east-1}" \
    -e V4_CORRELATION_ID="${V4_CORRELATION_ID:-}" \
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
      --py-files /opt/spark-src/iceberg_base.py \
      "/opt/spark-src/silver/${model}.py"
done

echo ""
echo "[silver] DONE — touchpoint+sessions Silver marts materialized in Iceberg brain_silver (dual-run) ✓"
