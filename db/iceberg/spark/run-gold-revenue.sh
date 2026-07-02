#!/usr/bin/env bash
# run-gold-revenue.sh — Brain V4 Phase 2 (Spark Gold, dual-run). GROUP=revenue (HIGH-RISK money math).
#
# Builds the two revenue-group Spark Gold marts into Iceberg brain_gold, BESIDE the live dbt→StarRocks
# brain_gold (dual-run / NON-BREAKING — touches no reader, no dbt model, no app code):
#   gold_revenue_ledger    — the realized-revenue RECOGNITION ledger. Folds the silver_order_recognition
#                            chain from Iceberg Bronze (the view has no Iceberg table) + the same small
#                            PG dimension reads (brand horizons, identity link — brain_ops now in PG `ops`).
#   gold_revenue_analytics — per-month × lifecycle × currency rollup over Iceberg brain_silver.silver_order_state.
#
# Dependency order: gold_revenue_analytics reads the Phase-1 Iceberg silver_order_state (must already be
# built by run-silver-orders.sh); gold_revenue_ledger is independent (folds Bronze). Order here is
# ledger then analytics for readability; either order is fine.
#
# Requires the lakehouse profile up (iceberg-rest + minio) AND postgres + redpanda.
# Joins Redpanda's netns so iceberg-rest / minio / postgres service DNS resolves.
# Mirrors run-silver-orders.sh exactly (Iceberg + PG JDBC package, shared ivy volume).
#
# Usage:  db/iceberg/spark/run-gold-revenue.sh [ledger|analytics|all]   (default: all)
set -euo pipefail

# AUD-INFRA-006: host-global batch-Spark admission lock — overlapping refresh loops / manual runs QUEUE
# behind the one running batch container instead of stacking 7g-cap JVMs. Streaming sinks excluded.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_spark_lock.sh"

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
PG_JDBC_VERSION="${PG_JDBC_VERSION:-42.7.4}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WHICH="${1:-all}"

# Bounded retry around the (idempotent MERGE) spark-submit — a transient blip is safe to re-run.
source "${SCRIPT_DIR}/_retry.sh"

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.postgresql:postgresql:${PG_JDBC_VERSION}"

docker volume create brain-spark-ivy >/dev/null

run_job() {
  local script="$1"
  echo "[gold-revenue] >>> ${script}"
  spark_retry "gold-revenue/${script}" \
  docker run --rm \
    --memory "${SPARK_CONTAINER_MEMORY:-7g}" \
    --network "container:${REDPANDA_CONTAINER}" \
    --user root \
    -v "${SCRIPT_DIR}":/opt/spike:ro \
    -v brain-spark-ivy:/root/.ivy2 \
    -e ICEBERG_CATALOG="${ICEBERG_CATALOG:-rest}" \
    -e ICEBERG_REST_URI="${ICEBERG_REST_URI:-http://iceberg-rest:8181}" \
    -e ICEBERG_WAREHOUSE="${ICEBERG_WAREHOUSE:-s3://brain-bronze/}" \
    -e BRONZE_NAMESPACE="${BRONZE_NAMESPACE:-brain_bronze}" \
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
    -e GOLD_PG_JDBC_URL="${GOLD_PG_JDBC_URL:-jdbc:postgresql://postgres:5432/brain}" \
    -e GOLD_PG_USER="${GOLD_PG_USER:-brain}" \
    -e GOLD_PG_PASSWORD="${GOLD_PG_PASSWORD:-brain}" \
    "${SPARK_IMAGE}" \
    /opt/spark/bin/spark-submit \
      --master "local[2]" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
      --packages "${PACKAGES}" \
      --conf spark.jars.ivy=/root/.ivy2 \
      "/opt/spike/gold/${script}"
}

case "${WHICH}" in
  ledger)    run_job gold_revenue_ledger.py ;;
  analytics) run_job gold_revenue_analytics.py ;;
  all)
    run_job gold_revenue_ledger.py
    run_job gold_revenue_analytics.py   # reads the Phase-1 Iceberg silver_order_state
    ;;
  *) echo "usage: $0 [ledger|analytics|all]"; exit 2 ;;
esac

echo "[gold-revenue] DONE (${WHICH})"
