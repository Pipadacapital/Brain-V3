#!/usr/bin/env bash
# SPEC: A.3 (WA-20) — run the QUARANTINED Splink probabilistic session→customer stitch (local dev).
#
# Builds brain_silver.silver_probabilistic_stitch from the Silver spine (silver_collector_event +
# silver_touchpoint) using Splink (Python, Spark backend). QUARANTINED per §1.4 / AMD-12: this table is
# NEVER read by attribution/revenue (guarded by probabilistic_quarantine_guard_test.py). Output is
# gated per-brand by the `identity.probabilistic` flag (default OFF) — so on golden / a fresh stack the
# table is created EMPTY (byte-identical golden, §0.5). The 0.98 ship bar (splink_v1_golden_eval.py →
# knowledge-base/models/splink-v1.md) gates turning the flag ON for a real brand.
#
# Local profile (A.2.5): --master local[2], --driver-memory 4g (fits the 4GB executor budget on golden).
#
# Splink is the ONE sanctioned added dependency (§1.1). The apache/spark:3.5.3 image ships Python 3.8,
# so Splink is PINNED to <4 (Splink 4 requires 3.9+). The built brain Spark image (db/iceberg/spark/
# Dockerfile) pip-installs it at BUILD time; this local run script installs it at container start (the
# same vanilla-image pattern the other run-silver-*.sh scripts use, plus one pip install).
#
# Usage:  db/iceberg/spark/silver/run-silver-probabilistic-stitch.sh
# Env:    SPARK_IMAGE, SPLINK_SPEC (pip spec), REDIS_URL, SPLINK_OUTPUT_FLOOR, SPLINK_MODEL_VERSION.
set -euo pipefail

# Host-global batch-Spark admission lock (mirrors run-silver-touchpoint-sessions.sh).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/_spark_lock.sh"

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
# Splink 4 needs Python 3.9+; the image is 3.8 → pin <4 (verified: splink 3.9.15 trains+predicts on
# apache/spark:3.5.3 with the array_length alias + checkpoint dir the job sets).
SPLINK_SPEC="${SPLINK_SPEC:-splink>=3.9.10,<4}"
# Join the Kafka container's netns so service DNS (iceberg-rest, minio, redis) resolves.
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SILVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${SILVER_DIR}/.." && pwd)"   # holds iceberg_base.py + _platform_flags.py (shared --py-files)

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

echo "[splink] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} splink='${SPLINK_SPEC}'"
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
  -e SILVER_NAMESPACE="${SILVER_NAMESPACE:-brain_silver}" \
  -e REDIS_URL="${REDIS_URL:-redis://redis:6379}" \
  -e SPLINK_MODEL_VERSION="${SPLINK_MODEL_VERSION:-splink-v1}" \
  -e SPLINK_OUTPUT_FLOOR="${SPLINK_OUTPUT_FLOOR:-0.95}" \
  -e SPLINK_U_MAX_PAIRS="${SPLINK_U_MAX_PAIRS:-2e6}" \
  -e SPLINK_CHECKPOINT_DIR="${SPLINK_CHECKPOINT_DIR:-/tmp/splink_checkpoints}" \
  -e S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}" \
  -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-brain}" \
  -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-brainbrain}" \
  -e AWS_REGION="${AWS_REGION:-us-east-1}" \
  -e SPARK_DRIVER_MEMORY="${SPARK_DRIVER_MEMORY:-4g}" \
  --entrypoint bash \
  "${SPARK_IMAGE}" -lc "
    pip install --quiet --disable-pip-version-check '${SPLINK_SPEC}' 2>&1 | tail -1
    /opt/spark/bin/spark-submit \
      --master 'local[2]' \
      --driver-memory '${SPARK_DRIVER_MEMORY:-4g}' \
      --packages '${PACKAGES}' \
      --conf spark.jars.ivy=/root/.ivy2 \
      --py-files /opt/spark-src/iceberg_base.py,/opt/spark-src/_platform_flags.py \
      /opt/spark-src/silver/silver_probabilistic_stitch.py
  "

echo ""
echo "[splink] DONE — silver_probabilistic_stitch materialized (QUARANTINED; flag-gated writes) ✓"
