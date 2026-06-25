#!/usr/bin/env bash
# run-silver-orders.sh — Brain V4 Phase 1 (Spark Silver, dual-run). GROUP=orders.
#
# Builds the three orders-group Spark Silver marts into Iceberg brain_silver, reading Iceberg Bronze
# (rest.brain_bronze.collector_events) and the small PG/StarRocks dimension reads (brand horizons,
# identity link). ADDITIVE + idempotent + re-runnable; touches NO existing read path, dbt model, or
# app code (Phase 1 is dual-run / non-breaking). Mirrors run-bronze-parity.sh / run-provision-silver-gold.sh.
#
# Dependency order: silver_order_state + silver_order_line are independent (both fold Bronze);
# silver_product aggregates the Iceberg silver_order_line, so it runs LAST.
#
# Requires the lakehouse profile up (iceberg-rest + minio) AND postgres + starrocks + redpanda.
# Joins Redpanda's netns so iceberg-rest / minio / postgres / starrocks service DNS resolves.
#
# Usage:  db/iceberg/spark/run-silver-orders.sh [order_state|order_line|product|all]   (default: all)
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
PG_JDBC_VERSION="${PG_JDBC_VERSION:-42.7.4}"
MYSQL_JDBC_VERSION="${MYSQL_JDBC_VERSION:-8.0.33}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-redpanda-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WHICH="${1:-all}"

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.postgresql:postgresql:${PG_JDBC_VERSION}"
PACKAGES="${PACKAGES},com.mysql:mysql-connector-j:${MYSQL_JDBC_VERSION}"

docker volume create brain-spark-ivy >/dev/null

run_job() {
  local script="$1"
  echo "[silver-orders] >>> ${script}"
  docker run --rm \
    --network "container:${REDPANDA_CONTAINER}" \
    --user root \
    -v "${SCRIPT_DIR}":/opt/spike:ro \
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
    -e SILVER_PG_JDBC_URL="${SILVER_PG_JDBC_URL:-jdbc:postgresql://postgres:5432/brain}" \
    -e SILVER_PG_USER="${SILVER_PG_USER:-brain}" \
    -e SILVER_PG_PASSWORD="${SILVER_PG_PASSWORD:-brain}" \
    -e SILVER_SR_JDBC_URL="${SILVER_SR_JDBC_URL:-jdbc:mysql://starrocks:9030}" \
    -e SILVER_SR_USER="${SILVER_SR_USER:-root}" \
    -e SILVER_SR_PASSWORD="${SILVER_SR_PASSWORD:-}" \
    "${SPARK_IMAGE}" \
    /opt/spark/bin/spark-submit \
      --master "local[2]" \
      --packages "${PACKAGES}" \
      --conf spark.jars.ivy=/root/.ivy2 \
      "/opt/spike/silver/${script}"
}

case "${WHICH}" in
  order_state) run_job silver_order_state.py ;;
  order_line)  run_job silver_order_line.py ;;
  product)     run_job silver_product.py ;;
  all)
    run_job silver_order_state.py
    run_job silver_order_line.py
    run_job silver_product.py      # depends on the Iceberg silver_order_line above
    ;;
  *) echo "usage: $0 [order_state|order_line|product|all]"; exit 2 ;;
esac

echo "[silver-orders] DONE (${WHICH})"
