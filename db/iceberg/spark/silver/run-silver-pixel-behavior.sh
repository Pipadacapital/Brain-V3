#!/usr/bin/env bash
# run-silver-pixel-behavior.sh — Brain V4 Phase 1b (GROUP pixel-behavior): build the NET-NEW pixel-behavior
# Silver marts in Iceberg brain_silver from raw Iceberg Bronze (collector_events) via Spark, BESIDE the live
# dbt→StarRocks brain_silver (ADDITIVE, non-breaking — repoints no reader, changes no dbt/app code).
#
# Builds (each an idempotent MERGE on (brand_id, event_id) — replay-safe; these are NEW, no dbt baseline):
#   silver_page_view   (page.viewed / product.viewed / collection.viewed) → behavior, funnel
#   silver_cart_event  (cart.item_added/removed/updated/viewed + coupon.applied) → abandoned-cart, funnel
#   silver_search      (search.submitted) → behavior, merchandising
#
# Mirrors run-silver-entities.sh: a one-shot Spark container in Redpanda's network namespace so the
# iceberg-rest / minio service DNS resolves. The whole spark/ root is mounted so each job's sibling
# `_silver_base.py` (and `iceberg_base.py` one dir up) imports without --py-files. Requires the compose
# `lakehouse` profile (iceberg-rest + minio) up + Bronze populated by the Spark sink.
#
# Usage:
#   db/iceberg/spark/silver/run-silver-pixel-behavior.sh                # all three
#   db/iceberg/spark/silver/run-silver-pixel-behavior.sh page_view      # one mart
#   db/iceberg/spark/silver/run-silver-pixel-behavior.sh cart_event
#   db/iceberg/spark/silver/run-silver-pixel-behavior.sh search
# Env: SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER overridable.
set -euo pipefail

# AUD-INFRA-006: host-global batch-Spark admission lock — overlapping refresh loops / manual runs QUEUE
# behind the one running batch container instead of stacking 7g-cap JVMs. Streaming sinks excluded.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/_spark_lock.sh"

TARGET="${1:-all}"

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SILVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_ROOT="$(cd "${SILVER_DIR}/.." && pwd)"   # holds iceberg_base.py; silver/ holds _silver_base.py

# Pure Iceberg read+write — only the Iceberg runtime + AWS bundle (no Kafka / no JDBC).
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

case "${TARGET}" in
  page_view)  JOBS=("silver_page_view.py") ;;
  cart_event) JOBS=("silver_cart_event.py") ;;
  search)     JOBS=("silver_search.py") ;;
  all)        JOBS=("silver_page_view.py" "silver_cart_event.py" "silver_search.py") ;;
  *) echo "[silver-pixel-behavior] unknown target '${TARGET}'. Use: page_view|cart_event|search|all" >&2; exit 2 ;;
esac

echo "[silver-pixel-behavior] target=${TARGET} image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER}"

docker volume create brain-spark-ivy >/dev/null

for job in "${JOBS[@]}"; do
  echo "[silver-pixel-behavior] ── running ${job} ──────────────────────────────────────────"
  docker run --rm \
    --memory "${SPARK_CONTAINER_MEMORY:-7g}" \
    --network "container:${REDPANDA_CONTAINER}" \
    --user root \
    -v "${SPARK_ROOT}":/opt/spark-src:ro \
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
      /opt/spark-src/silver/"${job}"
done

echo "[silver-pixel-behavior] DONE target=${TARGET} — pixel-behavior Silver marts materialized in Iceberg brain_silver (dual-run) ✓"
