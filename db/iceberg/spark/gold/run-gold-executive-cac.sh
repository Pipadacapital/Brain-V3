#!/usr/bin/env bash
# run-gold-executive-cac.sh — Brain V4 Phase 2 (Spark Gold, dual-run). GROUP=executive+cac.
#
# Builds this group's Spark Gold marts into Iceberg, reading the Phase-1 Spark→Iceberg Silver siblings
# (brain_silver.silver_order_state / silver_marketing_spend / silver_customer) and writing:
#   gold_executive_metrics  → brain_gold.gold_executive_metrics   (brand×currency executive KPI rollup)
#   gold_cac                → brain_gold.gold_cac                 (CAC components: new customers + spend)
#   snap_order_state        → brain_silver.snap_order_state       (daily order-state SCD snapshot)
#   snap_identity_link      → brain_silver.snap_identity_link     (daily AS-OF identity-link SCD snapshot)
#
# RETIRED (V4 forbids permanent feature tables): feature_customer_daily is INTENTIONALLY NOT built here.
#   V4 makes features RUNTIME, so this group does NOT port the dbt feature_customer_daily into a Spark
#   Iceberg job and does NOT register it in the parity mart_registry. The dbt brain_feature table is left
#   untouched on the legacy side (we change no dbt); it simply has no Phase-2 Spark successor → it is
#   dropped from the V4 Gold build. See db/iceberg/spark/gold/RETIRED_feature_customer_daily.md.
#
# ADDITIVE + idempotent + re-runnable; touches NO existing read path, dbt model, or app code (Phase 2 is
# dual-run / non-breaking). Mirrors run-silver-orders.sh / run-silver-marketing-spend.sh.
#
# Requires the lakehouse profile up (iceberg-rest + minio). Pure Iceberg read+write — no Kafka, no PG/SR
# JDBC (the Silver sources are already materialized in Iceberg). Joins Redpanda's netns so the
# iceberg-rest / minio service DNS resolves (same network posture as the Silver jobs).
#
# Usage:  db/iceberg/spark/gold/run-gold-executive-cac.sh [executive|cac|snap|snap-identity|all]   (default: all)
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-redpanda-1}"
GOLD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${GOLD_DIR}/.." && pwd)"   # holds iceberg_base.py (the shared py-file dependency)
WHICH="${1:-all}"

# Only the Iceberg runtime + AWS bundle are needed (pure Iceberg read+write; no Kafka / no JDBC).
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

echo "[gold-executive-cac] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} which=${WHICH}"

docker volume create brain-spark-ivy >/dev/null

run_job() {
  local script="$1"
  echo "[gold-executive-cac] >>> spark-submit ${script}"
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
      --py-files /opt/spark-src/iceberg_base.py \
      "/opt/spark-src/gold/${script}"
}

case "${WHICH}" in
  executive)     run_job gold_executive_metrics.py ;;
  cac)           run_job gold_cac.py ;;
  snap)          run_job snap_order_state.py ;;
  snap-identity) run_job snap_identity_link.py ;;
  all)
    run_job gold_executive_metrics.py
    run_job gold_cac.py
    run_job snap_order_state.py
    run_job snap_identity_link.py
    ;;
  *) echo "usage: $0 [executive|cac|snap|snap-identity|all]"; exit 2 ;;
esac

echo "[gold-executive-cac] DONE (${WHICH}) ✓"
