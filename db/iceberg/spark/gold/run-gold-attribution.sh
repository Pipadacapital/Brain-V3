#!/usr/bin/env bash
# run-gold-attribution.sh — Brain V4 Phase 2 (Spark Gold, dual-run): build the ATTRIBUTION gold marts in
# Iceberg from Iceberg brain_silver (+ the StarRocks gold_revenue_ledger recognized basis), BESIDE the live
# TS-writer/dbt→StarRocks brain_gold attribution marts (additive, non-breaking — no reader/app/dbt change).
#
# Builds, in DEPENDENCY ORDER (each downstream reads the upstream Iceberg mart):
#   1. gold_attribution_credit     (the credit ledger — reproduces the attribution-writer apportionment;
#                                   reads Iceberg silver_touchpoint + StarRocks gold_revenue_ledger basis)
#   2. gold_marketing_attribution  (thin projection/VIEW over gold_attribution_credit)
#   3. gold_attribution_paths      (journey-path mart — reads Iceberg silver_touchpoint; NO money)
#   4. snap_attribution_credit     (daily snapshot — reads gold_marketing_attribution → brain_SILVER)
#
# Each job is an idempotent MERGE on its model PK (replay-safe). Requires the compose `lakehouse` profile
# (iceberg-rest + minio) up + Iceberg brain_silver.silver_touchpoint populated (the Phase-1 Spark Silver job).
# The credit job reads its recognized-revenue BASIS from the ICEBERG rest.brain_gold.gold_revenue_ledger
# (materialized by gold_revenue_ledger.py / run-gold-revenue.sh from Iceberg Bronze) — NOT from StarRocks.
# So this script materializes the Iceberg revenue ledger FIRST (a no-op idempotent MERGE if already current)
# so the BASIS is present before gold_attribution_credit reads it. _attribution_math.py is shipped as a
# --py-files dep (the exact minor-unit port of the metric-engine apportionment).
#
# Usage:  db/iceberg/spark/gold/run-gold-attribution.sh
#         MODEL=gold_attribution_credit db/iceberg/spark/gold/run-gold-attribution.sh   # one model
# Env:    SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER, MODEL overridable.
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
# StarRocks speaks the MySQL wire protocol — the MySQL Connector/J driver reads the gold_revenue_ledger basis.
MYSQL_JDBC_VERSION="${MYSQL_JDBC_VERSION:-8.4.0}"
SCALA="2.12"
# Join Redpanda's network namespace so service-name DNS (iceberg-rest, minio, starrocks) resolves — the
# same netns trick the other Spark run scripts use.
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
GOLD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${GOLD_DIR}/.." && pwd)"   # holds iceberg_base.py (shared --py-files)

# Bounded retry around each (idempotent MERGE) spark-submit — a transient blip is safe to re-run.
source "${SPARK_DIR}/_retry.sh"

# Iceberg runtime + AWS bundle + MySQL JDBC (the cross-catalog recognized-basis read).
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},com.mysql:mysql-connector-j:${MYSQL_JDBC_VERSION}"

# Default: all four in dependency order. Override with MODEL=<one> to run a single job.
MODELS="${MODEL:-gold_attribution_credit gold_marketing_attribution gold_attribution_paths snap_attribution_credit}"

echo "[gold-attribution] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} models='${MODELS}'"

docker volume create brain-spark-ivy >/dev/null

# ── DEPENDENCY ORDER: materialize the Iceberg gold_revenue_ledger BEFORE gold_attribution_credit reads its
# recognized basis from it. gold_revenue_ledger.py lives one dir up (run-gold-revenue.sh) and folds the
# recognition chain from Iceberg Bronze; its MERGE is idempotent so this is a no-op if already current.
# Skip when the caller asked for a single non-credit MODEL (those marts don't read the revenue ledger).
if [ -z "${SKIP_REVENUE_LEDGER:-}" ] && printf '%s' " ${MODELS} " | grep -q ' gold_attribution_credit '; then
  echo "[gold-attribution] ensuring Iceberg gold_revenue_ledger (recognized basis) is materialized first"
  # Invoke via `bash` (not as an executable) — the run-*.sh scripts are tracked non-executable (mode 644),
  # so a direct exec fails "Permission denied". This mirrors how v4-refresh-loop.sh invokes every run script.
  bash "${SPARK_DIR}/run-gold-revenue.sh" ledger
fi

for model in ${MODELS}; do
  echo ""
  echo "================ BUILD gold mart: ${model} ================"
  spark_retry "gold-attribution/${model}" \
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
    -e GOLD_SR_JDBC_URL="${GOLD_SR_JDBC_URL:-jdbc:mysql://starrocks:9030}" \
    -e GOLD_SR_USER="${GOLD_SR_USER:-root}" \
    -e GOLD_SR_PASSWORD="${GOLD_SR_PASSWORD:-}" \
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
      --py-files /opt/spark-src/iceberg_base.py,/opt/spark-src/gold/_attribution_math.py \
      "/opt/spark-src/gold/${model}.py"
done

echo ""
echo "[gold-attribution] DONE — attribution gold marts materialized in Iceberg (dual-run) ✓"
