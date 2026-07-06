#!/usr/bin/env bash
# SPEC: A.2.1/A.2.3/A.2.5 (WA-16) — run Stitch v2: silver_session_identity + silver_stitch_conflicts.
#
# Builds the deterministic multi-key SESSION stitch (db/iceberg/spark/silver/silver_session_identity.py):
# reads brain_silver.silver_touchpoint (session universe) + brain_silver.silver_collector_event
# (identifiers), resolves each session's identifier set through the SANCTIONED identity_current view, and
# writes brain_silver.silver_session_identity (|B|=1) / brain_silver.silver_stitch_conflicts (|B|>1). It is
# GATED by the per-brand `stitch.v2` flag (default OFF → clean no-op) so the v4-refresh-loop glob
# ($SILVER_DIR/run-*.sh) can pick it up harmlessly: with no brand flagged, it reads a little and writes
# nothing. Legacy dual-write (ops.silver_journey_stitch) + the conflict→merge-review bridge
# (ops.stitch_conflict_review) run over PG JDBC → the PostgreSQL driver is on the classpath.
#
# Local A.2.5 profile: local[2] + --driver-memory 4g (the 4GB executor budget).
#
# Usage:  db/iceberg/spark/silver/run-silver-session-identity.sh
# Env:    SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER, FULL_REFRESH, SHARED_DEVICE_RECENCY_DAYS,
#         RESTITCH_LOOKBACK_DAYS (A.2.3.5 event-driven re-stitch drain window, default 90),
#         SPARK_DRIVER_MEMORY (default 4g), SALT_QUERY overridable.
set -euo pipefail

# Host-global batch-Spark admission lock (same as the other silver run scripts).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/_spark_lock.sh"

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
PG_JDBC_VERSION="${PG_JDBC_VERSION:-42.7.4}"   # salt read + legacy dual-write + review bridge
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SILVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${SILVER_DIR}/.." && pwd)"   # holds iceberg_base.py + the shared --py-files modules

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.postgresql:postgresql:${PG_JDBC_VERSION}"

# The Stitch v2 job imports iceberg_base, job_log, _identity_views (sanctioned map accessor, A.2.2) and
# _platform_flags (the Spark flag twin) — ship them all as --py-files so a silver/ spark-submit resolves.
PYFILES="/opt/spark-src/iceberg_base.py,/opt/spark-src/job_log.py"
PYFILES="${PYFILES},/opt/spark-src/_identity_views.py,/opt/spark-src/_platform_flags.py"

echo "[stitch-v2] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} recency_days=${SHARED_DEVICE_RECENCY_DAYS:-90}"

docker volume create brain-spark-ivy >/dev/null

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
  -e BRONZE_NAMESPACE="${BRONZE_NAMESPACE:-brain_bronze}" \
  -e SILVER_NAMESPACE="${SILVER_NAMESPACE:-brain_silver}" \
  -e BRONZE_PG_JDBC_URL="${BRONZE_PG_JDBC_URL:-jdbc:postgresql://postgres:5432/brain}" \
  -e BRONZE_PG_USER="${BRONZE_PG_USER:-brain}" \
  -e BRONZE_PG_PASSWORD="${BRONZE_PG_PASSWORD:-brain}" \
  -e SALT_QUERY="${SALT_QUERY:-}" \
  -e REDIS_URL="${REDIS_URL:-redis://redis:6379}" \
  -e SHARED_DEVICE_RECENCY_DAYS="${SHARED_DEVICE_RECENCY_DAYS:-90}" \
  -e S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}" \
  -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-brain}" \
  -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-brainbrain}" \
  -e AWS_REGION="${AWS_REGION:-us-east-1}" \
  -e V4_CORRELATION_ID="${V4_CORRELATION_ID:-}" \
  -e SPARK_DRIVER_MEMORY="${SPARK_DRIVER_MEMORY:-4g}" \
  -e FULL_REFRESH="${FULL_REFRESH:-}" \
  -e SILVER_INCREMENTAL_OVERLAP_HOURS="${SILVER_INCREMENTAL_OVERLAP_HOURS:-2}" \
  -e RESTITCH_LOOKBACK_DAYS="${RESTITCH_LOOKBACK_DAYS:-90}" \
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "local[2]" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    --py-files "${PYFILES}" \
    "/opt/spark-src/silver/silver_session_identity.py"

echo ""
echo "[stitch-v2] DONE — silver_session_identity + silver_stitch_conflicts materialized (flag-gated) ✓"
