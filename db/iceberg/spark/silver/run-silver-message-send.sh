#!/usr/bin/env bash
# run-silver-message-send.sh — Brain V4 Phase 1b (Spark Silver, dual-run): build the Iceberg
# brain_silver.silver_message_send mart FROM Iceberg Bronze (collector_events, message.send/delivery/
# read.v1) via Spark, BESIDE the live dbt→StarRocks brain_silver. This closes the MESSAGING-category
# coverage gap (registry.ts category='messaging' / WhatsApp+outbound). ADDITIVE + idempotent +
# re-runnable; it repoints no reader and changes no dbt model (Phase 1b is non-breaking).
#
# DATA-THIN: current Bronze has ZERO message.* rows (WhatsApp connector is coming_soon), so this run
# creates the correct EMPTY canonical table (0 rows is expected). A re-run populates it the moment an
# outbound-messaging connector lands message.*.v1 in Bronze — no code change.
#
# Mirrors run-silver-marketing-spend.sh: a one-shot Spark container in Redpanda's network namespace so
# the iceberg-rest / minio service DNS resolves. Requires the lakehouse profile (iceberg-rest + minio)
# up. The Iceberg jars are reused from the Bronze ivy cache.
#
# Usage:  db/iceberg/spark/silver/run-silver-message-send.sh
# Env:    SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER overridable.
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-redpanda-1}"
SILVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${SILVER_DIR}/.." && pwd)"   # holds iceberg_base.py (the shared py-file dependency)

# Only the Iceberg runtime + AWS bundle are needed (pure Iceberg read+write; no Kafka / no PG JDBC).
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

echo "[silver-message-send] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} packages=${PACKAGES}"

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
  -e S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}" \
  -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-brain}" \
  -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-brainbrain}" \
  -e AWS_REGION="${AWS_REGION:-us-east-1}" \
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "local[2]" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    --py-files /opt/spark-src/iceberg_base.py \
    /opt/spark-src/silver/silver_message_send.py
