#!/usr/bin/env bash
# run-gold-customer.sh — Brain V4 Phase 2 (GROUP customer): build the Iceberg brain_gold customer marts
# on the Spark→Iceberg dual-run path, BESIDE the live dbt→StarRocks ones. Mirrors run-silver-customer.sh.
#
# Builds (in dependency order — all read the Phase-1 Iceberg brain_silver spine):
#   1. gold_customer_360.py       (silver_customer ⨝ silver_order_state lifecycle → brain_gold.gold_customer_360)
#   2. gold_customer_segments.py  (silver_customer value tiers           → brain_gold.gold_customer_segments)
#   3. gold_cohorts.py            (silver_customer acquisition cohorts    → brain_gold.gold_cohorts)
#   4. gold_customer_scores.py    (latest customer feature → RFM/churn    → brain_gold.gold_customer_scores)
#
# ADDITIVE + idempotent + re-runnable — does NOT touch Bronze, the dbt models, or any reader (Phase 2
# is non-breaking dual-run). Runs over the CURRENT Iceberg Silver.
#
# Usage:
#   db/iceberg/spark/run-gold-customer.sh                 # all four jobs
#   STAGE=c360     db/iceberg/spark/run-gold-customer.sh  # only gold_customer_360
#   STAGE=segments db/iceberg/spark/run-gold-customer.sh  # only gold_customer_segments
#   STAGE=cohorts  db/iceberg/spark/run-gold-customer.sh  # only gold_cohorts
#   STAGE=scores   db/iceberg/spark/run-gold-customer.sh  # only gold_customer_scores
# Env: SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER, GOLD_NAMESPACE overridable.
# (Brain V4: gold_customer_scores folds features at RUNTIME from Iceberg silver_customer — the retired
#  FEATURE_SOURCE=starrocks brain_feature JDBC read is GONE, so no StarRocks JDBC env is passed here.)
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-redpanda-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="${STAGE:-all}"

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

echo "[gold-customer] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} stage=${STAGE}"
echo "[gold-customer] packages=${PACKAGES}"

# Reuse the Bronze ivy cache volume so the Iceberg jars are already present after a Bronze/Silver run.
docker volume create brain-spark-ivy >/dev/null

run_job() {
  local script="$1"
  echo "[gold-customer] >>> spark-submit ${script}"
  docker run --rm \
    --network "container:${REDPANDA_CONTAINER}" \
    --user root \
    -v "${SCRIPT_DIR}":/opt/spike:ro \
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
    "${SPARK_IMAGE}" \
    /opt/spark/bin/spark-submit \
      --master "local[2]" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
      --packages "${PACKAGES}" \
      --conf spark.jars.ivy=/root/.ivy2 \
      "/opt/spike/gold/${script}"
}

case "${STAGE}" in
  c360)     run_job "gold_customer_360.py" ;;
  segments) run_job "gold_customer_segments.py" ;;
  cohorts)  run_job "gold_cohorts.py" ;;
  scores)   run_job "gold_customer_scores.py" ;;
  all)
    run_job "gold_customer_360.py"
    run_job "gold_customer_segments.py"
    run_job "gold_cohorts.py"
    run_job "gold_customer_scores.py"
    ;;
  *) echo "unknown STAGE=${STAGE} (use c360|segments|cohorts|scores|all)"; exit 2 ;;
esac

echo "[gold-customer] DONE (stage=${STAGE}) ✓"
