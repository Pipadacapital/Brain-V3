#!/usr/bin/env bash
# run-silver-pixel-engagement.sh — Brain V4 Phase 1b (GROUP pixel-engagement): build the two NET-NEW
# first-party-pixel engagement Silver marts in Iceberg brain_silver from raw Iceberg Bronze
# (collector_events), BESIDE the live dbt→StarRocks brain_silver (ADDITIVE, non-breaking — no reader/app/
# dbt change). Mirrors ./run-silver-entities.sh (one-shot Spark container in Redpanda's netns so the
# iceberg-rest / minio service DNS resolves). Each job is an idempotent MERGE on (brand_id, event_id).
#
# Builds (both pure Bronze→Iceberg — no MySQL/Neo4j cross-catalog read needed):
#   silver_engagement_signal  — rage.click/dead.click/scroll.depth/element.clicked → one engagement grain
#   silver_form_submission    — form.submitted → lead/conversion-feedback grain (structural only, NO PII)
#
# Usage:
#   db/iceberg/spark/silver/run-silver-pixel-engagement.sh                 # both jobs
#   db/iceberg/spark/silver/run-silver-pixel-engagement.sh engagement_signal   # one job
#   db/iceberg/spark/silver/run-silver-pixel-engagement.sh form_submission
# Env: SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER overridable.
set -euo pipefail

# AUD-INFRA-006: host-global batch-Spark admission lock — overlapping refresh loops / manual runs QUEUE
# behind the one running batch container instead of stacking 7g-cap JVMs. Streaming sinks excluded.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/_spark_lock.sh"

WHICH="${1:-all}"

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SILVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_ROOT="$(cd "${SILVER_DIR}/.." && pwd)"   # holds iceberg_base.py + _silver_base.py (mounted src)

# Iceberg runtime + AWS bundle (Bronze read + Silver write). No cross-catalog JDBC/Neo4j needed here.
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

case "${WHICH}" in
  engagement_signal) JOBS=("silver_engagement_signal.py") ;;
  form_submission)   JOBS=("silver_form_submission.py") ;;
  all)               JOBS=("silver_engagement_signal.py" "silver_form_submission.py") ;;
  *) echo "[silver-pixel-engagement] unknown '${WHICH}'. Use: engagement_signal|form_submission|all" >&2; exit 2 ;;
esac

echo "[silver-pixel-engagement] which=${WHICH} image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER}"

docker volume create brain-spark-ivy >/dev/null

for job in "${JOBS[@]}"; do
  echo ""
  echo "================ BUILD silver mart: ${job} ================"
  docker run --rm \
    --memory "${SPARK_CONTAINER_MEMORY:-7g}" \
    --oom-score-adj "${SPARK_CONTAINER_OOM_SCORE_ADJ:-100}" \
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
      "/opt/spark-src/silver/${job}"
done

echo ""
echo "[silver-pixel-engagement] DONE — engagement+form Silver marts materialized in Iceberg brain_silver (dual-run) ✓"
