#!/usr/bin/env bash
# run-gold-measurement.sh — SPEC:C.2 Wave C MEASUREMENT fact tables (Brain V4 Spark Gold, additive).
#
# Builds the gold_measurement_* fact tables into Iceberg brain_gold, reading the Phase-1 Iceberg Silver
# siblings (silver_refund / silver_settlement / silver_order_line / silver_inventory_level /
# silver_collector_event) and PG billing.cost_input (the governed cost seam). Each fact is APPEND-ONLY with
# a derived current-state Trino view (db/trino/views/mv_gold_measurement_*.sql). ADDITIVE / dual-run:
# touches NO existing reader, dbt model, or app code; leaves the live gold_settlement_summary +
# gold_contribution_margin untouched (AMD-16 / AMD-17).
#
#   gold_product_costs          → brain_gold.gold_product_costs          (per-SKU COGS dimension, PG source)
#   gold_measurement_costs      → brain_gold.gold_measurement_costs      (per-order COGS/shipping fwd+rev/pkg)
#   gold_measurement_refunds    → brain_gold.gold_measurement_refunds    (refunds + RTO returns)
#   gold_measurement_settlements→ brain_gold.gold_measurement_settlements(gross/fees/net per settlement item)
#   gold_measurement_fees       → brain_gold.gold_measurement_fees       (per-order payment/tax fees)
#   gold_measurement_inventory  → brain_gold.gold_measurement_inventory  (flag-gated movement fact)
#
# Requires the lakehouse profile up (iceberg-rest + minio) AND postgres + redis + kafka. Joins the kafka
# container's netns so iceberg-rest / minio / postgres / redis service DNS resolves.
#
# Usage:  db/iceberg/spark/gold/run-gold-measurement.sh [product-costs|costs|refunds|settlements|fees|inventory|all]
set -euo pipefail

# AUD-INFRA-006: host-global batch-Spark admission lock.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/_spark_lock.sh"

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
PG_JDBC_VERSION="${PG_JDBC_VERSION:-42.7.4}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
GOLD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${GOLD_DIR}/.." && pwd)"   # holds iceberg_base.py + _platform_flags.py (py-file deps)
WHICH="${1:-all}"

source "${SPARK_DIR}/_retry.sh"

# Iceberg runtime + AWS bundle + PG JDBC (gold_product_costs / gold_measurement_costs read billing.cost_input).
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.postgresql:postgresql:${PG_JDBC_VERSION}"

echo "[gold-measurement] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} which=${WHICH}"
docker volume create brain-spark-ivy >/dev/null

run_job() {
  local script="$1"
  echo "[gold-measurement] >>> spark-submit ${script}"
  spark_retry "gold-measurement/${script}" \
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
    -e REDIS_URL="${REDIS_URL:-redis://redis:6379}" \
    "${SPARK_IMAGE}" \
    /opt/spark/bin/spark-submit \
      --master "local[2]" \
      --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
      --packages "${PACKAGES}" \
      --conf spark.jars.ivy=/root/.ivy2 \
      --py-files /opt/spark-src/iceberg_base.py,/opt/spark-src/_platform_flags.py \
      "/opt/spark-src/gold/${script}"
}

case "${WHICH}" in
  product-costs) run_job gold_product_costs.py ;;
  costs)         run_job gold_measurement_costs.py ;;
  refunds)       run_job gold_measurement_refunds.py ;;
  settlements)   run_job gold_measurement_settlements.py ;;
  fees)          run_job gold_measurement_fees.py ;;
  inventory)     run_job gold_measurement_inventory.py ;;
  all)
    run_job gold_product_costs.py           # per-SKU COGS dimension (costs depends on it)
    run_job gold_measurement_costs.py
    run_job gold_measurement_refunds.py
    run_job gold_measurement_settlements.py
    run_job gold_measurement_fees.py
    run_job gold_measurement_inventory.py
    ;;
  *) echo "usage: $0 [product-costs|costs|refunds|settlements|fees|inventory|all]"; exit 2 ;;
esac

echo "[gold-measurement] DONE (${WHICH})"
