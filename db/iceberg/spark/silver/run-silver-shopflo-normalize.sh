#!/usr/bin/env bash
# run-silver-shopflo-normalize.sh — ADR-0006 P4: normalize RAW Shopflo checkout_abandoned in Spark Silver.
# Reads brain_bronze.shopflo_checkout_raw (the verbatim HMAC-verified webhook body + server-trusted brand_id
# envelope) and produces the canonical shopflo.checkout_abandoned.v1 collector rows via the GOLDEN-VECTOR-
# VERIFIED ports in _raw_normalize.py + the connector-local Shopflo ports. Writes a SHADOW table by default
# (dual-run parity); set TARGET_TABLE=silver_collector_event at the checkout-lane cutover.
# Requires the lakehouse profile + Postgres (per-brand salt for PII hashing).
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
PG_JDBC_VERSION="${PG_JDBC_VERSION:-42.7.4}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-redpanda-1}"
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
  -e SILVER_NAMESPACE="${SILVER_NAMESPACE:-brain_silver}" \
  -e RAW_TABLE="${RAW_TABLE:-shopflo_checkout_raw}" \
  -e TARGET_TABLE="${TARGET_TABLE:-silver_collector_event_shopflo_shadow}" \
  -e RAW_BRAND_COL="${RAW_BRAND_COL:-brand_id}" \
  -e RAW_INGESTED_COL="${RAW_INGESTED_COL:-fetched_at}" \
  -e RAW_PAYLOAD_COL="${RAW_PAYLOAD_COL:-payload}" \
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
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "local[2]" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    --py-files /opt/spark-src/iceberg_base.py,/opt/spark-src/job_log.py,/opt/spark-src/silver/_raw_normalize.py \
    "/opt/spark-src/silver/silver_shopflo_normalize.py"

echo ""
echo "[silver] DONE — silver_shopflo_normalize (raw Shopflo checkout_abandoned → canonical Silver) ✓"
