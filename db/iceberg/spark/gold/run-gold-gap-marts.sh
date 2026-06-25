#!/usr/bin/env bash
# run-gold-gap-marts.sh — Brain V4 Phase 2 (Spark Gold, dual-run): build the NET-NEW gap Gold marts
# (matrix §3/4, no dbt predecessor → parity status=NEW) FROM Iceberg Silver via Spark, BESIDE the live
# dbt→StarRocks brain_gold + the TS metric-engine. ADDITIVE + idempotent + re-runnable; repoints NO
# reader and changes NO dbt model or app code (Phase 2 is non-breaking dual-run).
#
#   gold_funnel.py                 (silver_page_view/cart_event/checkout_signal → checkout/browse funnel)
#   gold_abandoned_cart.py         (silver_cart_event/checkout_signal → cart recovery + at-risk value)
#   gold_engagement.py             (silver_engagement_signal → UX-quality engagement rollup)
#   gold_behavior.py               (silver_page_view → page-type browse behavior)
#   gold_conversion_feedback.py    (silver_form_submission/payment → lead→payment feedback)
#   gold_cod_rto.py                (silver_cod_rto → COD/RTO outcomes + at-risk cash, money minor)
#   gold_logistics_performance.py  (silver_shipment → delivery/RTO rates per courier)
#   gold_settlement_summary.py     (silver_settlement → net-of-fees settlement, money minor)
#   gold_campaign_performance.py   (silver_marketing_spend/campaign[+gold_attribution_credit] → ROAS/CTR/CPC)
#   gold_contribution_margin.py    (silver_order_state/marketing_spend + PG cost config → CM1/CM2, money minor)
#
# Mirrors run-silver-payments-logistics.sh: one-shot Spark containers in Redpanda's network namespace so
# the iceberg-rest / minio / postgres service DNS resolves. Requires the lakehouse profile (iceberg-rest +
# minio) up + Silver built (Phase 1/1b). The PG JDBC driver is included (contribution-margin/campaign read
# the operational config tier over JDBC, exactly as the TS).
#
# Usage:
#   db/iceberg/spark/gold/run-gold-gap-marts.sh                 # all ten marts
#   STAGE=funnel              db/iceberg/spark/gold/run-gold-gap-marts.sh
#   STAGE=contribution_margin db/iceberg/spark/gold/run-gold-gap-marts.sh
# Env: SPARK_IMAGE, ICEBERG_VERSION, PG_JDBC_VERSION, REDPANDA_CONTAINER overridable.
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
PG_JDBC_VERSION="${PG_JDBC_VERSION:-42.7.4}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-redpanda-1}"
GOLD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${GOLD_DIR}/.." && pwd)"   # holds iceberg_base.py (the shared py-file dependency)
STAGE="${STAGE:-all}"

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.postgresql:postgresql:${PG_JDBC_VERSION}"

echo "[gold-gap-marts] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} stage=${STAGE}"
echo "[gold-gap-marts] packages=${PACKAGES}"

docker volume create brain-spark-ivy >/dev/null

run_job() {
  local script="$1"
  echo "[gold-gap-marts] >>> spark-submit ${script}"
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
    -e GOLD_PG_JDBC_URL="${GOLD_PG_JDBC_URL:-jdbc:postgresql://postgres:5432/brain}" \
    -e GOLD_PG_USER="${GOLD_PG_USER:-brain}" \
    -e GOLD_PG_PASSWORD="${GOLD_PG_PASSWORD:-brain}" \
    "${SPARK_IMAGE}" \
    /opt/spark/bin/spark-submit \
      --master "local[2]" \
      --packages "${PACKAGES}" \
      --conf spark.jars.ivy=/root/.ivy2 \
      --py-files /opt/spark-src/gold/_gold_base.py \
      "/opt/spark-src/gold/${script}"
}

case "${STAGE}" in
  funnel)               run_job "gold_funnel.py" ;;
  abandoned_cart)       run_job "gold_abandoned_cart.py" ;;
  engagement)           run_job "gold_engagement.py" ;;
  behavior)             run_job "gold_behavior.py" ;;
  conversion_feedback)  run_job "gold_conversion_feedback.py" ;;
  cod_rto)              run_job "gold_cod_rto.py" ;;
  logistics)            run_job "gold_logistics_performance.py" ;;
  settlement)           run_job "gold_settlement_summary.py" ;;
  campaign)             run_job "gold_campaign_performance.py" ;;
  contribution_margin)  run_job "gold_contribution_margin.py" ;;
  all)
    run_job "gold_funnel.py"
    run_job "gold_abandoned_cart.py"
    run_job "gold_engagement.py"
    run_job "gold_behavior.py"
    run_job "gold_conversion_feedback.py"
    run_job "gold_cod_rto.py"
    run_job "gold_logistics_performance.py"
    run_job "gold_settlement_summary.py"
    run_job "gold_campaign_performance.py"
    run_job "gold_contribution_margin.py"
    ;;
  *) echo "unknown STAGE=${STAGE}"; exit 2 ;;
esac

echo "[gold-gap-marts] DONE (stage=${STAGE}) ✓"
