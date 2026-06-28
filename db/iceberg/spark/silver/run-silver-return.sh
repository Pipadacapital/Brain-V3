#!/usr/bin/env bash
# run-silver-return.sh — Brain V4 / SR-4: build the canonical RETURN mart (brain_silver.silver_return)
# in Iceberg from the gated collector lane. Folds shiprocket.return_status.v1 events to the latest
# return state per (brand,order_id) — a SEPARATE lifecycle from forward shipment delivery / RTO, so a
# return is NEVER mis-classified as a forward DELIVERED (the false-delivery revenue-truth bug SR-4 fixes).
#
# Depends ONLY on silver_collector_event (the gated lane); run it in the "rest of silver" pass AFTER
# run-silver-collector-event.sh. Idempotent MERGE on (brand_id, order_id) — replay-safe.
#
# Usage:  db/iceberg/spark/silver/run-silver-return.sh
# Env:    SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER overridable. Mirrors run-silver-checkout-shipment.sh.
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
# Join Redpanda's network namespace so service-name DNS (iceberg-rest, minio) resolves.
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-redpanda-1}"
SILVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${SILVER_DIR}/.." && pwd)"   # holds iceberg_base.py (shared --py-files)

# Pure Iceberg catalog job (reads silver_collector_event, no Kafka). The silver/_silver_technical.py
# helper is shipped via --py-files so the Stage-1 DQ gate + quarantine writer resolve on the workers.
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
# JDBC for the quarantine writer's PG sink (write_quarantine), mirroring the other silver runners.
PACKAGES="${PACKAGES},org.postgresql:postgresql:42.7.4"

echo "[silver] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} model='silver_return'"

docker volume create brain-spark-ivy >/dev/null

echo ""
echo "================ BUILD silver mart: silver_return ================"
docker run --rm \
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
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "local[2]" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    --py-files /opt/spark-src/iceberg_base.py,/opt/spark-src/silver/_silver_technical.py \
    "/opt/spark-src/silver/silver_return.py"

echo ""
echo "[silver] DONE — silver_return mart materialized in Iceberg brain_silver ✓"
