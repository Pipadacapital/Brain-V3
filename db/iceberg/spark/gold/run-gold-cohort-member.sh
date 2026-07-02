#!/usr/bin/env bash
# run-gold-cohort-member.sh — Brain V4 (Spark Gold): build the NET-NEW gap Gold mart
# gold_cohort_member (USER-GRAIN cohort membership — per-customer active periods; no dbt predecessor →
# parity status=NEW) FROM Iceberg Silver via Spark. ADDITIVE + idempotent + re-runnable; repoints NO reader.
#
#   gold_cohort_member.py  (silver_order_state recognized orders ⋈ gold_customer_360 customer set →
#                           per (brand_id, customer_key, period_index) active period + order_count_in_period;
#                           the user-grain companion to the aggregate gold_cohorts)
#
# Dedicated single-mart runner (mirrors run-gold-repeat-latency.sh's spark-submit shape) so it is picked up
# automatically by tools/dev/v4-refresh-loop.sh, which globs gold/run-*.sh into the GOLD_BI phase.
# One-shot Spark container in Redpanda's network namespace so iceberg-rest / minio service DNS resolves.
# Requires the lakehouse profile (iceberg-rest + minio) up + Silver built (silver_order_state).
#
# Usage:   db/iceberg/spark/gold/run-gold-cohort-member.sh
# Env:     SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER overridable.
set -euo pipefail

# AUD-INFRA-006: host-global batch-Spark admission lock — overlapping refresh loops / manual runs QUEUE
# behind the one running batch container instead of stacking 7g-cap JVMs. Streaming sinks excluded.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/_spark_lock.sh"

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
GOLD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${GOLD_DIR}/.." && pwd)"   # holds iceberg_base.py (the shared py-file dependency)

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

echo "[gold-cohort-member] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER}"
echo "[gold-cohort-member] packages=${PACKAGES}"

docker volume create brain-spark-ivy >/dev/null

echo "[gold-cohort-member] >>> spark-submit gold_cohort_member.py"
docker run --rm \
  --memory "${SPARK_CONTAINER_MEMORY:-7g}" \
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
    --py-files /opt/spark-src/gold/_gold_base.py \
    "/opt/spark-src/gold/gold_cohort_member.py"

echo "[gold-cohort-member] DONE ✓"
