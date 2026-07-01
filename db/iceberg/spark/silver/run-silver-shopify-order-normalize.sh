#!/usr/bin/env bash
# run-silver-shopify-order-normalize.sh — ADR-0006 P4 exemplar: normalize RAW Shopify orders in Spark Silver.
# Reads brain_bronze.shopify_orders_raw (Kafka Connect Iceberg sink output) and produces the canonical
# order.live.v1 rows via the GOLDEN-VECTOR-VERIFIED ports in _raw_normalize.py. Writes a SHADOW table by
# default (dual-run parity); set TARGET_TABLE=silver_collector_event at the order-lane cutover.
# Requires the lakehouse profile + Postgres (per-brand salt for PII hashing).
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
PG_JDBC_VERSION="${PG_JDBC_VERSION:-42.7.4}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SILVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${SILVER_DIR}/.." && pwd)"

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.postgresql:postgresql:${PG_JDBC_VERSION}"

docker volume create brain-spark-ivy >/dev/null

docker run --rm \
  --network "container:${REDPANDA_CONTAINER}" \
  --user root \
  -v "${SPARK_DIR}":/opt/spark-src:ro \
  -v brain-spark-ivy:/root/.ivy2 \
  -e ICEBERG_CATALOG="${ICEBERG_CATALOG:-rest}" \
  -e ICEBERG_REST_URI="${ICEBERG_REST_URI:-http://iceberg-rest:8181}" \
  -e ICEBERG_WAREHOUSE="${ICEBERG_WAREHOUSE:-s3://brain-bronze/}" \
  -e BRONZE_NAMESPACE="${BRONZE_NAMESPACE:-brain_bronze}" \
  -e BRONZE_SOURCE="${BRONZE_SOURCE:-legacy}" \
  -e SILVER_NAMESPACE="${SILVER_NAMESPACE:-brain_silver}" \
  -e TARGET_TABLE="${TARGET_TABLE:-silver_collector_event_shopify_shadow}" \
  -e BRAIN_REGION_CODE="${BRAIN_REGION_CODE:-IN}" \
  -e BRONZE_PG_JDBC_URL="${BRONZE_PG_JDBC_URL:-jdbc:postgresql://postgres:5432/brain}" \
  -e BRONZE_PG_USER="${BRONZE_PG_USER:-brain}" \
  -e BRONZE_PG_PASSWORD="${BRONZE_PG_PASSWORD:-brain}" \
  -e SALT_QUERY="${SALT_QUERY:-}" \
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
    --py-files /opt/spark-src/iceberg_base.py,/opt/spark-src/job_log.py,/opt/spark-src/silver/_raw_normalize.py \
    "/opt/spark-src/silver/silver_shopify_order_normalize.py"

echo ""
echo "[silver] DONE — silver_shopify_order_normalize (raw Shopify orders → canonical Silver) ✓"
