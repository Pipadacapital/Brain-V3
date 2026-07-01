#!/usr/bin/env bash
# run-silver-collector-event.sh — ADR-0006 P2: build brain_silver.silver_collector_event, the ADMISSION
# GATE moved into Spark Silver. Reads the RAW Iceberg Bronze (brain_bronze.collector_events_raw, written
# by the Kafka Connect Iceberg sink), applies the R2 tenant + R3 consent gate + lane split + dedup, and
# MERGEs the gated, Bronze-column-contract rows into brain_silver.silver_collector_event — which every
# downstream Silver job reads in place of the old (Spark-sink-written) brain_bronze.collector_events.
#
# MUST run FIRST in the Silver tier (all other silver_* jobs read its output). Idempotent MERGE.
# Requires the compose `lakehouse` profile (iceberg-rest + minio) + Postgres (pixel.pixel_installation
# for the install_token→brand R2 lookup) up.
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
PG_JDBC_VERSION="${PG_JDBC_VERSION:-42.7.4}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SILVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${SILVER_DIR}/.." && pwd)"   # holds iceberg_base.py + job_log.py (shared --py-files)

# Iceberg runtime + AWS bundle + Postgres JDBC (the R2 pixel_installation read).
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.postgresql:postgresql:${PG_JDBC_VERSION}"

echo "[silver] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} model=silver_collector_event"

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
  -e BRONZE_PG_JDBC_URL="${BRONZE_PG_JDBC_URL:-jdbc:postgresql://postgres:5432/brain}" \
  -e BRONZE_PG_USER="${BRONZE_PG_USER:-brain}" \
  -e BRONZE_PG_PASSWORD="${BRONZE_PG_PASSWORD:-brain}" \
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
    --py-files /opt/spark-src/iceberg_base.py,/opt/spark-src/job_log.py \
    "/opt/spark-src/silver/silver_collector_event.py"

echo ""
echo "[silver] DONE — silver_collector_event (the Silver admission gate over raw Bronze) materialized ✓"
