#!/usr/bin/env bash
# run-silver-payments-logistics.sh — Brain V4 Phase 1b (Spark Silver, dual-run): build the GAP
# payments/logistics canonical Silver marts FROM Iceberg Bronze via Spark, BESIDE the live
# dbt→StarRocks brain_silver. ADDITIVE + idempotent + re-runnable; repoints NO reader and changes
# NO dbt model (Phase 1b is non-breaking dual-run).
#
#   1. silver_dispute.py    (settlement.live.v1 entity_type='dispute' + standalone dispute.* → chargebacks)
#   2. silver_cod_rto.py    (cod order.live.v1 ⨝ gokwik.rto_predict.v1 ⨝ gokwik.awb_status.v1 → COD/RTO)
#   3. silver_ad_account.py (spend.live.v1 → ad-account dimension, lifetime rollup per account)
#
# Mirrors run-silver-marketing-spend.sh: one-shot Spark containers in Redpanda's network namespace so
# the iceberg-rest / minio service DNS resolves. Requires the lakehouse profile (iceberg-rest + minio)
# up (it reads the Bronze the Spark sink fills). Iceberg jars are reused from the Bronze ivy cache.
#
# Usage:
#   db/iceberg/spark/silver/run-silver-payments-logistics.sh                 # all three jobs
#   STAGE=dispute    db/iceberg/spark/silver/run-silver-payments-logistics.sh
#   STAGE=cod_rto    db/iceberg/spark/silver/run-silver-payments-logistics.sh
#   STAGE=ad_account db/iceberg/spark/silver/run-silver-payments-logistics.sh
# Env: SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER overridable.
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-redpanda-1}"
SILVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${SILVER_DIR}/.." && pwd)"   # holds iceberg_base.py (the shared py-file dependency)
STAGE="${STAGE:-all}"

# Only the Iceberg runtime + AWS bundle are needed (pure Iceberg read+write; no Kafka / no PG JDBC).
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

echo "[silver-payments-logistics] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} stage=${STAGE}"
echo "[silver-payments-logistics] packages=${PACKAGES}"

docker volume create brain-spark-ivy >/dev/null

run_job() {
  local script="$1"
  echo "[silver-payments-logistics] >>> spark-submit ${script}"
  docker run --rm \
    --network "container:${REDPANDA_CONTAINER}" \
    --user root \
    -v "${SPARK_DIR}":/opt/spark-src:ro \
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
    "${SPARK_IMAGE}" \
    /opt/spark/bin/spark-submit \
      --master "local[2]" \
      --packages "${PACKAGES}" \
      --conf spark.jars.ivy=/root/.ivy2 \
      "/opt/spark-src/silver/${script}"
}

case "${STAGE}" in
  dispute)    run_job "silver_dispute.py" ;;
  cod_rto)    run_job "silver_cod_rto.py" ;;
  ad_account) run_job "silver_ad_account.py" ;;
  all)
    run_job "silver_dispute.py"
    run_job "silver_cod_rto.py"
    run_job "silver_ad_account.py"
    ;;
  *) echo "unknown STAGE=${STAGE} (use dispute|cod_rto|ad_account|all)"; exit 2 ;;
esac

echo "[silver-payments-logistics] DONE (stage=${STAGE}) ✓"
