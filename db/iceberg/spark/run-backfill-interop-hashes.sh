#!/usr/bin/env bash
# SPEC: A.1.4
# run-backfill-interop-hashes.sh — WA-10: one-off historical interop-hash backfill (bronze → silver).
#
# Runs db/iceberg/spark/backfill_interop_hashes.py: re-derives the AMD-01 INTEROP-space
# email_sha256/phone_sha256 for historical orders FROM the raw Bronze lanes that still carry
# unhashed identifiers (shopify_orders_raw_connect, woocommerce_orders_raw_connect), MERGEs them
# additively into brain_silver.silver_order_interop_identifier, per-brand flag-gated on
# `connector.identity_fields` (DEFAULT OFF, fail-closed) and EXPLICITLY skipping crypto-shredded
# subjects (identity.pii_erasure_log × ops.silver_identity_link anti-join).
#
# ONE-OFF: not wired into tools/dev/v4-refresh-loop.sh. Idempotent — safe to re-run.
# Scope a single brand with BRAND_ID=<uuid>. Mirrors run-silver-orders.sh (lock, image, packages).
#
# Requires the lakehouse profile up (iceberg-rest + minio) AND postgres + redpanda + redis
# (the flag gate reads Redis via REDIS_URL; unreachable Redis = every flag OFF = no rows).
#
# Usage:  [BRAND_ID=<uuid>] db/iceberg/spark/run-backfill-interop-hashes.sh
set -euo pipefail

# AUD-INFRA-006: host-global batch-Spark admission lock — overlapping refresh loops / manual runs QUEUE
# behind the one running batch container instead of stacking 7g-cap JVMs. Streaming sinks excluded.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_spark_lock.sh"

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
PG_JDBC_VERSION="${PG_JDBC_VERSION:-42.7.4}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.postgresql:postgresql:${PG_JDBC_VERSION}"

docker volume create brain-spark-ivy >/dev/null

echo "[backfill-interop] >>> backfill_interop_hashes.py (BRAND_ID=${BRAND_ID:-<all flag-enabled>})"
docker run --rm \
  --memory "${SPARK_CONTAINER_MEMORY:-7g}" \
  --oom-score-adj "${SPARK_CONTAINER_OOM_SCORE_ADJ:-100}" \
  --network "container:${REDPANDA_CONTAINER}" \
  --user root \
  -v "${SCRIPT_DIR}":/opt/spike:ro \
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
  -e BRAIN_REGION_CODE="${BRAIN_REGION_CODE:-IN}" \
  -e BRAND_ID="${BRAND_ID:-}" \
  -e SALT_QUERY="${SALT_QUERY:-}" \
  -e REDIS_URL="${REDIS_URL:-redis://redis:6379}" \
  -e SILVER_PG_JDBC_URL="${SILVER_PG_JDBC_URL:-jdbc:postgresql://postgres:5432/brain}" \
  -e SILVER_PG_USER="${SILVER_PG_USER:-brain}" \
  -e SILVER_PG_PASSWORD="${SILVER_PG_PASSWORD:-brain}" \
  "${SPARK_IMAGE}" \
  bash -c "pip3 install --quiet --no-cache-dir phonenumbers==9.0.34 && /opt/spark/bin/spark-submit --master 'local[2]' --driver-memory '${SPARK_DRIVER_MEMORY:-4g}' --packages '${PACKAGES}' --conf spark.jars.ivy=/root/.ivy2 /opt/spike/backfill_interop_hashes.py"
# ^ phonenumbers: _identity_normalization.normalize_phone needs it (pinned to the SAME version as
#   db/iceberg/spark/Dockerfile:40); the vanilla apache/spark dev image does not ship it.

echo "[backfill-interop] DONE"
