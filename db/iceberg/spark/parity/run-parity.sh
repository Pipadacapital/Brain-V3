#!/usr/bin/env bash
# run-parity.sh — Brain V4: run the Spark-Iceberg ⇄ StarRocks parity oracle (repurposed in Phase 6b).
#
# The reusable cut-over / serving gate. Reads the NEW Spark→Iceberg Silver/Gold mart and a BASELINE and
# proves row-identity + per-currency minor-unit Σ parity, or honestly SKIPs when either side is absent.
# Exits non-zero on a real parity FAIL (CI/gate friendly); SKIP is exit 0.
#
# BASELINE (PARITY_BASELINE):
#   serving (DEFAULT, Phase 6b+) — compare against the StarRocks SERVING MV brain_serving.mv_<mart>:
#                                  proves the mv_* the app reads EQUALS its Iceberg source. dbt is gone.
#   dbt (RETIRED)                — the legacy dbt brain_gold/brain_silver base table (DROPPED in 6b →
#                                  StarRocks-sourced marts SKIP). PG-sourced marts still read PG.
#
# Mirrors ../run-bronze-parity.sh: a one-shot Spark container in Redpanda's network namespace so the
# iceberg-rest / starrocks / postgres / minio service DNS resolves. Requires the lakehouse profile
# (iceberg-rest + minio) AND core (starrocks) + ingest (redpanda) up.
#
# Usage:
#   db/iceberg/spark/parity/run-parity.sh                 # serving parity, ALL marts (skips absent ones)
#   PARITY_MART=gold_attribution_credit db/iceberg/spark/parity/run-parity.sh
#   PARITY_BRAND_ID=<uuid> PARITY_MART=gold_revenue_ledger db/iceberg/spark/parity/run-parity.sh
#   PARITY_BASELINE=dbt db/iceberg/spark/parity/run-parity.sh   # (RETIRED) legacy dbt baseline
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
PG_JDBC_VERSION="${PG_JDBC_VERSION:-42.7.4}"
# StarRocks speaks the MySQL wire protocol — the MySQL Connector/J driver reads its base tables over JDBC.
MYSQL_JDBC_VERSION="${MYSQL_JDBC_VERSION:-8.4.0}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
PARITY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.postgresql:postgresql:${PG_JDBC_VERSION}"
PACKAGES="${PACKAGES},com.mysql:mysql-connector-j:${MYSQL_JDBC_VERSION}"

echo "[parity-oracle] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} mart=${PARITY_MART:-all} baseline=${PARITY_BASELINE:-serving}"

docker volume create brain-spark-ivy >/dev/null

exec docker run --rm \
  --network "container:${REDPANDA_CONTAINER}" \
  --user root \
  -v "${PARITY_DIR}":/opt/parity:ro \
  -v brain-spark-ivy:/root/.ivy2 \
  -e ICEBERG_CATALOG="${ICEBERG_CATALOG:-rest}" \
  -e ICEBERG_REST_URI="${ICEBERG_REST_URI:-http://iceberg-rest:8181}" \
  -e SILVER_NAMESPACE="${SILVER_NAMESPACE:-brain_silver}" \
  -e GOLD_NAMESPACE="${GOLD_NAMESPACE:-brain_gold}" \
  -e SILVER_WAREHOUSE="${SILVER_WAREHOUSE:-s3://brain-silver/}" \
  -e GOLD_WAREHOUSE="${GOLD_WAREHOUSE:-s3://brain-gold/}" \
  -e PARITY_WAREHOUSE="${PARITY_WAREHOUSE:-s3://brain-gold/}" \
  -e S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}" \
  -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-brain}" \
  -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-brainbrain}" \
  -e AWS_REGION="${AWS_REGION:-us-east-1}" \
  -e PARITY_BASELINE="${PARITY_BASELINE:-serving}" \
  -e PARITY_SERVING_SCHEMA="${PARITY_SERVING_SCHEMA:-brain_serving}" \
  -e PARITY_SR_JDBC_URL="${PARITY_SR_JDBC_URL:-jdbc:mysql://starrocks:9030}" \
  -e PARITY_SR_USER="${PARITY_SR_USER:-root}" \
  -e PARITY_SR_PASSWORD="${PARITY_SR_PASSWORD:-}" \
  -e PARITY_PG_JDBC_URL="${PARITY_PG_JDBC_URL:-jdbc:postgresql://postgres:5432/brain}" \
  -e PARITY_PG_USER="${PARITY_PG_USER:-brain}" \
  -e PARITY_PG_PASSWORD="${PARITY_PG_PASSWORD:-brain}" \
  -e PARITY_MART="${PARITY_MART:-all}" \
  -e PARITY_BRAND_ID="${PARITY_BRAND_ID:-}" \
  -e PARITY_ROW_TOLERANCE="${PARITY_ROW_TOLERANCE:-0}" \
  -e PARITY_MONEY_TOLERANCE="${PARITY_MONEY_TOLERANCE:-0}" \
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "local[2]" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    --py-files /opt/parity/mart_registry.py \
    /opt/parity/parity_oracle.py
