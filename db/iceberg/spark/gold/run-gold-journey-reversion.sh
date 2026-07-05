#!/usr/bin/env bash
# run-gold-journey-reversion.sh — Brain V4 spec gap G4: MERGE RE-VERSIONING for the event-sourced
# journey ledger brain_gold.journey_events (gold_journey_events_reversion.py). Folds identity MERGE
# events (silver_identity_map rows closed with replaced_by_brain_id) into the ledger: flips the
# superseded owner's rows to is_current=false and INSERTS canonical-owner copies with
# data_version + 1 — history is never rewritten. Checkpointed on the silver_job_watermark
# side-table (job gold_journey_events_reversion) over silver_identity_map.updated_at.
#
# NAMING (load-bearing): the v4-refresh-loop discovers gold jobs via the glob $GOLD_DIR/run-*.sh in
# collation order. This script is named run-gold-journey-REVERSION.sh (not
# run-gold-journey-events-reversion.sh) so it sorts AFTER run-gold-journey-events.sh — in C
# collation '-' (0x2D) sorts BEFORE '.' (0x2E), so the hyphenated -events-reversion name would have
# run FIRST, before the construction job it depends on. 'e' < 'r' orders these two correctly in any
# locale.
#
# Additive / non-breaking — writes ONLY brain_gold.journey_events; mirrors run-gold-journey-events.sh.
#
# Usage:  db/iceberg/spark/gold/run-gold-journey-reversion.sh
# Env:    SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER, FULL_REFRESH overridable.
set -euo pipefail

# AUD-INFRA-006: host-global batch-Spark admission lock — overlapping refresh loops / manual runs QUEUE
# behind the one running batch container instead of stacking 7g-cap JVMs. Streaming sinks excluded.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/_spark_lock.sh"

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
# Join Redpanda's network namespace so service-name DNS (iceberg-rest, minio) resolves — the same netns
# trick the other Spark run scripts use.
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
GOLD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${GOLD_DIR}/.." && pwd)"   # holds iceberg_base.py (shared --py-files)

# Bounded retry around the (crash-safe, checkpointed) spark-submit — a transient blip is safe to re-run.
source "${SPARK_DIR}/_retry.sh"

# Iceberg runtime + AWS bundle (Gold→Gold + Silver identity map; no external JDBC source).
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

MODEL="gold_journey_events_reversion"

echo "[gold-journey-reversion] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} model='${MODEL}'"

docker volume create brain-spark-ivy >/dev/null

echo ""
echo "================ RE-VERSION gold ledger: journey_events (${MODEL}) ================"
spark_retry "gold-journey-reversion/${MODEL}" \
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
  -e SILVER_NAMESPACE="${SILVER_NAMESPACE:-brain_silver}" \
  -e GOLD_NAMESPACE="${GOLD_NAMESPACE:-brain_gold}" \
  -e S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}" \
  -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-brain}" \
  -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-brainbrain}" \
  -e AWS_REGION="${AWS_REGION:-us-east-1}" \
  -e V4_CORRELATION_ID="${V4_CORRELATION_ID:-}" \
  -e SPARK_DRIVER_MEMORY="${SPARK_DRIVER_MEMORY:-4g}" \
  -e FULL_REFRESH="${FULL_REFRESH:-}" \
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "local[2]" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    --py-files /opt/spark-src/iceberg_base.py \
    "/opt/spark-src/gold/${MODEL}.py"

echo ""
echo "[gold-journey-reversion] DONE — identity-merge re-versioning folded into journey_events ✓"
