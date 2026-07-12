#!/usr/bin/env bash
# run-bronze-maintenance.sh — ADR-0002 Slice 7: Iceberg Bronze maintenance.
#   Periodic:  db/iceberg/spark/run-bronze-maintenance.sh                  (MODE=maintain — compact + 7d snapshot TTL)
#   Erasure:   MODE=erase ERASE_BRAND_ID=<uuid> db/iceberg/spark/run-bronze-maintenance.sh
#
# Requires the lakehouse profile up (iceberg-rest + minio). Joins Redpanda's netns only for service DNS.
set -euo pipefail

# AUD-INFRA-006: host-global batch-Spark admission lock — overlapping refresh loops / manual runs QUEUE
# behind the one running batch container instead of stacking 7g-cap JVMs. Streaming sinks excluded.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_spark_lock.sh"

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

echo "[bronze-maintenance] MODE=${MODE:-maintain} image=${SPARK_IMAGE}"
docker volume create brain-spark-ivy >/dev/null

exec docker run --rm \
  --memory "${SPARK_CONTAINER_MEMORY:-7g}" \
  --oom-score-adj "${SPARK_CONTAINER_OOM_SCORE_ADJ:-100}" \
  --network "container:${REDPANDA_CONTAINER}" \
  --user root \
  -v "${SCRIPT_DIR}":/opt/spike:ro \
  -v brain-spark-ivy:/root/.ivy2 \
  -e ICEBERG_REST_URI="${ICEBERG_REST_URI:-http://iceberg-rest:8181}" \
  -e BRONZE_WAREHOUSE="${BRONZE_WAREHOUSE:-s3://brain-bronze/}" \
  -e S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}" \
  -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-brain}" \
  -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-brainbrain}" \
  -e AWS_REGION="${AWS_REGION:-us-east-1}" \
  -e MODE="${MODE:-maintain}" \
  -e ERASE_BRAND_ID="${ERASE_BRAND_ID:-}" \
  -e SNAPSHOT_TTL_MS="${SNAPSHOT_TTL_MS:-604800000}" \
  -e DURABLE_SNAPSHOT_TTL_MS="${DURABLE_SNAPSHOT_TTL_MS:-1209600000}" \
  -e DURABLE_TABLES="${DURABLE_TABLES:-collector_events_connect}" \
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "local[2]" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    /opt/spike/bronze_maintenance.py
