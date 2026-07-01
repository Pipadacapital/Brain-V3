#!/usr/bin/env bash
# run-silver-coupon.sh — Brain V4 / WOO-3: build the canonical COUPON mart (brain_silver.silver_coupon)
# in Iceberg from the gated collector lane. Folds coupon.upsert.v1 events to the latest coupon state per
# (brand,coupon_code) — the discount-catalogue surface that was structurally starved end-to-end before
# WOO-3 (no mapper, no admit-list entry, no mart). FIXED coupons carry bigint minor units + currency;
# PERCENT coupons carry a verbatim amount_percent (a percentage is NOT money and is never scaled).
#
# Depends ONLY on silver_collector_event (the gated lane); run it in the "rest of silver" pass AFTER
# run-silver-collector-event.sh. Idempotent MERGE on (brand_id, coupon_code) — replay-safe.
#
# Usage:  db/iceberg/spark/silver/run-silver-coupon.sh
# Env:    SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER overridable. Mirrors run-silver-return.sh.
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
# Join Redpanda's network namespace so service-name DNS (iceberg-rest, minio) resolves.
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SILVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${SILVER_DIR}/.." && pwd)"   # holds iceberg_base.py (shared --py-files)

# Pure Iceberg catalog job (reads silver_collector_event, no Kafka). The silver/_silver_technical.py
# helper is shipped via --py-files so the Stage-1 DQ gate + quarantine writer resolve on the workers.
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
# JDBC for the quarantine writer's PG sink (write_quarantine), mirroring the other silver runners.
PACKAGES="${PACKAGES},org.postgresql:postgresql:42.7.4"

echo "[silver] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} model='silver_coupon'"

docker volume create brain-spark-ivy >/dev/null

echo ""
echo "================ BUILD silver mart: silver_coupon ================"
docker run --rm \
  --memory "${SPARK_CONTAINER_MEMORY:-7g}" \
  --network "container:${REDPANDA_CONTAINER}" \
  --user root \
  -v "${SPARK_DIR}":/opt/spark-src:ro \
  -v brain-spark-ivy:/root/.ivy2 \
  -e ICEBERG_CATALOG="${ICEBERG_CATALOG:-rest}" \
  -e ICEBERG_REST_URI="${ICEBERG_REST_URI:-http://iceberg-rest:8181}" \
  -e ICEBERG_WAREHOUSE="${ICEBERG_WAREHOUSE:-s3://brain-bronze/}" \
  -e BRONZE_NAMESPACE="${BRONZE_NAMESPACE:-brain_bronze}" \
  -e SILVER_NAMESPACE="${SILVER_NAMESPACE:-brain_silver}" \
  -e S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}" \
  -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-brain}" \
  -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-brainbrain}" \
  -e AWS_REGION="${AWS_REGION:-us-east-1}" \
  -e BRONZE_PG_JDBC_URL="${BRONZE_PG_JDBC_URL:-jdbc:postgresql://postgres:5432/brain}" \
  -e BRONZE_PG_USER="${BRONZE_PG_USER:-brain}" \
  -e BRONZE_PG_PASSWORD="${BRONZE_PG_PASSWORD:-brain}" \
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
    "/opt/spark-src/silver/silver_coupon.py"

echo ""
echo "[silver] DONE — silver_coupon mart materialized in Iceberg brain_silver ✓"
