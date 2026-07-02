#!/usr/bin/env bash
# run-bronze-raw-retention.sh — ADR-0006 D4 (AUD-PERF-003): short-retention sweep over the RAW Bronze
# tables — the legacy per-connector *_raw tables + the unified brain_bronze.events raw connector lanes.
#   Periodic:  db/iceberg/spark/run-bronze-raw-retention.sh        (row TTL DELETE + snapshot expiry, 168h)
#   Expiry-only: RAW_ROW_TTL=0 db/iceberg/spark/run-bronze-raw-retention.sh
#
# The D4 mitigation that gates the prod flip (docs/runbooks/adr-0006-cutover-and-prod.md): raw un-hashed
# PII / PCI payloads must not outlive the RAW_RETENTION_HOURS landing-buffer window. Locally this is
# invoked on the daily guard-file cadence by tools/dev/v4-refresh-loop.sh; in prod it runs as an Argo
# CronWorkflow next to bronze-maintenance.
# Requires the lakehouse profile up (iceberg-rest + minio). Joins the broker's netns only for service DNS.
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

echo "[bronze-raw-retention] RAW_RETENTION_HOURS=${RAW_RETENTION_HOURS:-168} RAW_ROW_TTL=${RAW_ROW_TTL:-1} image=${SPARK_IMAGE}"
docker volume create brain-spark-ivy >/dev/null

docker run --rm \
  --memory "${SPARK_CONTAINER_MEMORY:-7g}" \
  --network "container:${REDPANDA_CONTAINER}" \
  --user root \
  -v "${SCRIPT_DIR}":/opt/spike:ro \
  -v brain-spark-ivy:/root/.ivy2 \
  -e ICEBERG_CATALOG="${ICEBERG_CATALOG:-rest}" \
  -e ICEBERG_REST_URI="${ICEBERG_REST_URI:-http://iceberg-rest:8181}" \
  -e ICEBERG_WAREHOUSE="${ICEBERG_WAREHOUSE:-s3://brain-bronze/}" \
  -e BRONZE_NAMESPACE="${BRONZE_NAMESPACE:-brain_bronze}" \
  -e RAW_RETENTION_HOURS="${RAW_RETENTION_HOURS:-168}" \
  -e RAW_ROW_TTL="${RAW_ROW_TTL:-1}" \
  -e BRONZE_EVENTS_TABLE="${BRONZE_EVENTS_TABLE:-events}" \
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
    /opt/spike/bronze_raw_retention.py
