#!/usr/bin/env bash
# run-silver-marketing-spend.sh — Brain V4 Phase 1 (Spark Silver, dual-run): build the Iceberg
# brain_silver.silver_marketing_spend mart FROM Iceberg Bronze (collector_events, spend.live.v1) via
# Spark, BESIDE the live dbt→StarRocks brain_silver.silver_marketing_spend. ADDITIVE + idempotent +
# re-runnable; it repoints no reader and changes no dbt model (Phase 1 is non-breaking).
#
# Mirrors run-provision-silver-gold.sh: a one-shot Spark container in Redpanda's network namespace so
# the iceberg-rest / minio service DNS resolves. Requires the lakehouse profile (iceberg-rest + minio)
# up (it reads Bronze that the Spark sink fills). The Iceberg jars are reused from the Bronze ivy cache.
#
# Usage:  db/iceberg/spark/silver/run-silver-marketing-spend.sh
# Env:    SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER overridable.
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SILVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${SILVER_DIR}/.." && pwd)"   # holds iceberg_base.py (the shared py-file dependency)

# Only the Iceberg runtime + AWS bundle are needed (pure Iceberg read+write; no Kafka / no PG JDBC).
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

echo "[silver-marketing-spend] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} packages=${PACKAGES}"

docker volume create brain-spark-ivy >/dev/null

exec docker run --rm \
  --network "container:${REDPANDA_CONTAINER}" \
  --user root \
  -v "${SPARK_DIR}":/opt/spark-src:ro \
  -v brain-spark-ivy:/root/.ivy2 \
  -e ICEBERG_CATALOG="${ICEBERG_CATALOG:-rest}" \
  -e ICEBERG_REST_URI="${ICEBERG_REST_URI:-http://iceberg-rest:8181}" \
  -e ICEBERG_WAREHOUSE="${ICEBERG_WAREHOUSE:-s3://brain-bronze/}" \
  -e BRONZE_NAMESPACE="${BRONZE_NAMESPACE:-brain_bronze}" \
  -e SILVER_NAMESPACE="${SILVER_NAMESPACE:-brain_silver}" \
  -e SPEND_EVENT_TYPE="${SPEND_EVENT_TYPE:-spend.live.v1}" \
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
    --py-files /opt/spark-src/iceberg_base.py,/opt/spark-src/silver/_silver_technical.py \
    /opt/spark-src/silver/silver_marketing_spend.py
