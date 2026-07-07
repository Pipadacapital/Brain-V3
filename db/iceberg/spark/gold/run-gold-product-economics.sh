#!/usr/bin/env bash
# run-gold-product-economics.sh — Brain V4 Wave C (SPEC:C.3): build the NEW product×day economics rollup
# gold_product_economics (order economics apportioned onto product lines by line-revenue share, ZERO
# money leak; rolled up per brand×product×day×currency) FROM gold_order_economics + silver_order_line.
# ADDITIVE + idempotent (MERGE on brand_id,product_key,econ_date,currency_code) + re-runnable.
#
#   gold_product_economics.py  (gold_order_economics ⋈ silver_order_line → largest-remainder apportion →
#                            per (brand, product_key, econ_date, currency) CM1/CM2/CM3 rollup)
#
# Dedicated single-mart runner so it is picked up automatically by tools/dev/v4-refresh-loop.sh, which
# globs gold/run-*.sh into the GOLD_BI phase AFTER run-gold-order-economics.sh (alphabetical: order<product).
# One-shot Spark container in Kafka's network namespace so iceberg-rest / minio service DNS resolves.
# Requires the lakehouse profile up + gold_order_economics + silver_order_line built.
#
# Usage:   db/iceberg/spark/gold/run-gold-product-economics.sh
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

echo "[gold-product-economics] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER}"
echo "[gold-product-economics] packages=${PACKAGES}"

docker volume create brain-spark-ivy >/dev/null

echo "[gold-product-economics] >>> spark-submit gold_product_economics.py"
docker run --rm \
  --memory "${SPARK_CONTAINER_MEMORY:-7g}" \
  --oom-score-adj "${SPARK_CONTAINER_OOM_SCORE_ADJ:-100}" \
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
    "/opt/spark-src/gold/gold_product_economics.py"

echo "[gold-product-economics] DONE ✓"
