#!/usr/bin/env bash
# run-gold-journey-paths.sh — Brain V4 Phase-2 Gold (NET-NEW): build the Journeys **Sankey** path-aggregate
# Gold mart in Iceberg from Iceberg brain_silver.silver_touchpoint. This is the real path-aggregate that
# replaces the Journeys tab's interim storefront-stage funnel. Additive / non-breaking — repoints NO reader,
# changes NO existing mart, writes ONLY brain_gold.gold_journey_paths. Mirrors run-gold-gap-marts.sh /
# run-silver-touchpoint-sessions.sh (same netns + Iceberg-runtime spark-submit shape).
#
# Builds:
#   gold_journey_paths   (top-N most-common ordered CHANNEL paths per brand, with per-path journey COUNT,
#                         consecutive channel edges[], and conversion count — reads Iceberg silver_touchpoint)
#
# The job is an idempotent per-brand RECOMPUTE (DELETE recomputed brands → INSERT fresh top-N), replay-safe.
# Requires the compose `lakehouse` profile (iceberg-rest + minio) up + Iceberg brain_silver.silver_touchpoint
# populated (the Phase-1 Spark Silver job, run-silver-touchpoint-sessions.sh). NO money, NO JDBC source —
# pure Iceberg Silver → Iceberg Gold, so the classpath is just the Iceberg runtime + AWS bundle.
#
# Usage:  db/iceberg/spark/gold/run-gold-journey-paths.sh
# Env:    SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER, JOURNEY_PATHS_TOP_N, JOURNEY_PATHS_MAX_LEN overridable.
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
# Join Redpanda's network namespace so service-name DNS (iceberg-rest, minio) resolves — the same netns
# trick the other Spark run scripts use.
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-redpanda-1}"
GOLD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${GOLD_DIR}/.." && pwd)"   # holds iceberg_base.py (shared --py-files)

# Bounded retry around the (idempotent recompute) spark-submit — a transient blip is safe to re-run.
source "${SPARK_DIR}/_retry.sh"

# Iceberg runtime + AWS bundle (Silver→Gold only; no external JDBC source).
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

MODEL="gold_journey_paths"

echo "[gold-journey-paths] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} model='${MODEL}'"

docker volume create brain-spark-ivy >/dev/null

echo ""
echo "================ BUILD gold mart: ${MODEL} ================"
spark_retry "gold-journey-paths/${MODEL}" \
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
  -e JOURNEY_PATHS_TOP_N="${JOURNEY_PATHS_TOP_N:-50}" \
  -e JOURNEY_PATHS_MAX_LEN="${JOURNEY_PATHS_MAX_LEN:-12}" \
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
    --py-files /opt/spark-src/iceberg_base.py \
    "/opt/spark-src/gold/${MODEL}.py"

echo ""
echo "[gold-journey-paths] DONE — journey-path Sankey gold mart materialized in Iceberg brain_gold ✓"
