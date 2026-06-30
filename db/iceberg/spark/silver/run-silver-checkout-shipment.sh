#!/usr/bin/env bash
# run-silver-checkout-shipment.sh — Brain V4 Phase 1 (Spark Silver, dual-run): build the checkout+shipment
# Silver marts in Iceberg brain_silver from raw Iceberg Bronze, BESIDE the live dbt→StarRocks brain_silver
# (additive, non-breaking — no reader/app/dbt change). Mirrors ../run-provision-silver-gold.sh.
#
# Builds, in dependency order (silver_shipment reads silver_shipment_event):
#   1. silver_checkout_signal   (folds stg_checkout_signal_events)   — Bronze → brain_silver
#   2. silver_shipment_event    (folds stg_shipment_events)          — Bronze → brain_silver
#   3. silver_shipment          (latest-state per order)             — Silver(event) → brain_silver
#
# Each job is an idempotent MERGE on its model PK (replay-safe). Requires the compose `lakehouse` profile
# (iceberg-rest + minio) up; Bronze (rest.brain_bronze.collector_events) populated by the Bronze sink.
#
# Usage:  db/iceberg/spark/silver/run-silver-checkout-shipment.sh
#         MODEL=silver_checkout_signal db/iceberg/spark/silver/run-silver-checkout-shipment.sh   # one model
# Env:    SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER, MODEL overridable.
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
# Join Redpanda's network namespace so service-name DNS (iceberg-rest, minio) resolves — the same
# netns trick the other Spark run scripts use.
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SILVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${SILVER_DIR}/.." && pwd)"   # holds iceberg_base.py (shared --py-files)

# Pure Iceberg catalog job (no Kafka / no JDBC) — only the Iceberg runtime + AWS bundle.
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

# Default: all three in dependency order. Override with MODEL=<one> to run a single job.
MODELS="${MODEL:-silver_checkout_signal silver_shipment_event silver_shipment}"

echo "[silver] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} models='${MODELS}'"

docker volume create brain-spark-ivy >/dev/null

for model in ${MODELS}; do
  echo ""
  echo "================ BUILD silver mart: ${model} ================"
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
echo "[silver] DONE — checkout+shipment Silver marts materialized in Iceberg brain_silver (dual-run) ✓"
