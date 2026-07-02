#!/usr/bin/env bash
# run-silver-customer.sh — Brain V4 Phase 1 (customer+identity group): build the Iceberg
# brain_silver.silver_customer_identity + brain_silver.silver_customer marts on the Spark→Iceberg
# dual-run path, BESIDE the live dbt→StarRocks ones. Mirrors run-provision-silver-gold.sh.
#
# It spins one-shot Spark containers on the compose network (Redpanda's netns, so service DNS like
# neo4j / iceberg-rest / minio / starrocks resolves), pulls the Iceberg + Neo4j-connector + MySQL-JDBC
# jars, and spark-submits the two Silver jobs IN DEPENDENCY ORDER:
#   1. silver_customer_identity.py  (reads Neo4j → Iceberg brain_silver.silver_customer_identity)
#   2. silver_customer.py           (rolls up silver_order_state ⨝ silver_customer_identity → Iceberg)
#
# ADDITIVE + idempotent + re-runnable — does NOT touch Bronze, the dbt models, or any reader (Phase 1
# is non-breaking dual-run). Runs over CURRENT Bronze/Neo4j/order-state.
#
# Usage:
#   db/iceberg/spark/run-silver-customer.sh                 # both jobs (identity then customer)
#   STAGE=identity db/iceberg/spark/run-silver-customer.sh  # only silver_customer_identity
#   STAGE=customer db/iceberg/spark/run-silver-customer.sh  # only silver_customer
# silver_customer now reads the Iceberg brain_silver.silver_order_state ONLY (Spark Phase 1 always
# writes it) — the old StarRocks-JDBC order-state fallback is gone, so no brain_silver. dbt-DB read.
# Env: SPARK_IMAGE, ICEBERG_VERSION, NEO4J_CONNECTOR_VERSION, MYSQL_JDBC_VERSION, REDPANDA_CONTAINER,
#      NEO4J_URI/USER/PASSWORD overridable.
set -euo pipefail

# AUD-INFRA-006: host-global batch-Spark admission lock — overlapping refresh loops / manual runs QUEUE
# behind the one running batch container instead of stacking 7g-cap JVMs. Streaming sinks excluded.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_spark_lock.sh"

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
# Neo4j Spark connector for Spark 3.5 / Scala 2.12 (reads Customer nodes via a Cypher query).
NEO4J_CONNECTOR_VERSION="${NEO4J_CONNECTOR_VERSION:-5.3.1_for_spark_3}"
# MySQL Connector/J — StarRocks speaks the MySQL wire protocol (silver_customer order-state fallback).
MYSQL_JDBC_VERSION="${MYSQL_JDBC_VERSION:-8.0.33}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="${STAGE:-both}"

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.neo4j:neo4j-connector-apache-spark_${SCALA}:${NEO4J_CONNECTOR_VERSION}"
PACKAGES="${PACKAGES},com.mysql:mysql-connector-j:${MYSQL_JDBC_VERSION}"

echo "[silver-customer] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} stage=${STAGE}"
echo "[silver-customer] packages=${PACKAGES}"

# Reuse the Bronze ivy cache volume so the Iceberg jars are already present after a Bronze run.
docker volume create brain-spark-ivy >/dev/null

run_job() {
  local script="$1"
  echo "[silver-customer] >>> spark-submit ${script}"
  docker run --rm \
    --memory "${SPARK_CONTAINER_MEMORY:-7g}" \
    --network "container:${REDPANDA_CONTAINER}" \
    --user root \
    -v "${SCRIPT_DIR}":/opt/spike:ro \
    -v brain-spark-ivy:/root/.ivy2 \
    -e ICEBERG_CATALOG="${ICEBERG_CATALOG:-rest}" \
    -e ICEBERG_REST_URI="${ICEBERG_REST_URI:-http://iceberg-rest:8181}" \
    -e ICEBERG_WAREHOUSE="${ICEBERG_WAREHOUSE:-s3://brain-bronze/}" \
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
    -e NEO4J_URI="${NEO4J_URI:-bolt://neo4j:7687}" \
    -e NEO4J_USER="${NEO4J_USER:-neo4j}" \
    -e NEO4J_PASSWORD="${NEO4J_PASSWORD:-brain_neo4j}" \
    -e ORDER_STATE_SOURCE="${ORDER_STATE_SOURCE:-auto}" \
    -e SILVER_SR_JDBC_URL="${SILVER_SR_JDBC_URL:-jdbc:mysql://starrocks:9030}" \
    -e SILVER_SR_USER="${SILVER_SR_USER:-root}" \
    -e SILVER_SR_PASSWORD="${SILVER_SR_PASSWORD:-}" \
    "${SPARK_IMAGE}" \
    /opt/spark/bin/spark-submit \
      --master "local[2]" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
      --packages "${PACKAGES}" \
      --conf spark.jars.ivy=/root/.ivy2 \
      "/opt/spike/silver/${script}"
}

case "${STAGE}" in
  identity) run_job "silver_customer_identity.py" ;;
  customer) run_job "silver_customer.py" ;;
  both)
    run_job "silver_customer_identity.py"
    run_job "silver_customer.py"
    ;;
  *) echo "unknown STAGE=${STAGE} (use identity|customer|both)"; exit 2 ;;
esac

echo "[silver-customer] DONE (stage=${STAGE}) ✓"
