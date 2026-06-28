#!/usr/bin/env bash
# run-gold-repeat-latency.sh — Brain V4 Phase 2 (Spark Gold): build the NET-NEW gap Gold mart
# gold_repeat_latency (time-to-2nd-purchase RETENTION LATENCY; no dbt predecessor → parity status=NEW)
# FROM Iceberg Silver via Spark. ADDITIVE + idempotent + re-runnable; repoints NO reader.
#
#   gold_repeat_latency.py  (silver_order_state → per-customer 1st→2nd order day-gap →
#                            median days-to-2nd scalar + 0-7/8-14/15-30/31-60/61-90/90+ histogram)
#
# Dedicated single-mart runner (mirrors run-gold-gap-marts.sh's spark-submit shape) so it is picked up
# automatically by tools/dev/v4-refresh-loop.sh, which globs gold/run-*.sh into the GOLD_BI phase.
# One-shot Spark container in Redpanda's network namespace so iceberg-rest / minio service DNS resolves.
# Requires the lakehouse profile (iceberg-rest + minio) up + Silver built (silver_order_state).
#
# Usage:   db/iceberg/spark/gold/run-gold-repeat-latency.sh
# Env:     SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER overridable.
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-redpanda-1}"
GOLD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${GOLD_DIR}/.." && pwd)"   # holds iceberg_base.py (the shared py-file dependency)

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

echo "[gold-repeat-latency] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER}"
echo "[gold-repeat-latency] packages=${PACKAGES}"

docker volume create brain-spark-ivy >/dev/null

echo "[gold-repeat-latency] >>> spark-submit gold_repeat_latency.py"
docker run --rm \
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
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "local[2]" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    --py-files /opt/spark-src/gold/_gold_base.py \
    "/opt/spark-src/gold/gold_repeat_latency.py"

echo "[gold-repeat-latency] DONE ✓"
