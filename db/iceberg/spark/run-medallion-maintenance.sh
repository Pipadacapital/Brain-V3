#!/usr/bin/env bash
# run-medallion-maintenance.sh — Brain V4 Phase 0 (Area B / PR-0.2): Iceberg Silver + Gold maintenance.
#   Periodic:  db/iceberg/spark/run-medallion-maintenance.sh    (MODE=maintain — compact + 7d snapshot TTL + orphan sweep)
#   Erasure:   MODE=erase ERASE_BRAND_ID=<uuid> db/iceberg/spark/run-medallion-maintenance.sh
#
# The Silver/Gold companion to run-bronze-maintenance.sh — same image, same operations, extended to
# the brain_silver + brain_gold namespaces. ADDITIVE + non-breaking (touches no Bronze path).
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
# hadoop-aws (S3A): remove_orphan_files lists table locations via the Hadoop FileSystem, not S3FileIO.
# 3.3.4 matches the Hadoop client libs bundled with Spark 3.5.x.
PACKAGES="${PACKAGES},org.apache.hadoop:hadoop-aws:${HADOOP_AWS_VERSION:-3.3.4}"

echo "[medallion-maintenance] MODE=${MODE:-maintain} image=${SPARK_IMAGE}"
docker volume create brain-spark-ivy >/dev/null

exec docker run --rm \
  --memory "${SPARK_CONTAINER_MEMORY:-7g}" \
  --network "container:${REDPANDA_CONTAINER}" \
  --user root \
  -v "${SCRIPT_DIR}":/opt/spike:ro \
  -v brain-spark-ivy:/root/.ivy2 \
  -e ICEBERG_CATALOG="${ICEBERG_CATALOG:-rest}" \
  -e ICEBERG_REST_URI="${ICEBERG_REST_URI:-http://iceberg-rest:8181}" \
  -e ICEBERG_WAREHOUSE="${ICEBERG_WAREHOUSE:-s3://brain-bronze/}" \
  -e SILVER_NAMESPACE="${SILVER_NAMESPACE:-brain_silver}" \
  -e GOLD_NAMESPACE="${GOLD_NAMESPACE:-brain_gold}" \
  -e MAINT_NAMESPACES="${MAINT_NAMESPACES:-}" \
  -e S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}" \
  -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-brain}" \
  -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-brainbrain}" \
  -e AWS_REGION="${AWS_REGION:-us-east-1}" \
  -e MODE="${MODE:-maintain}" \
  -e ERASE_BRAND_ID="${ERASE_BRAND_ID:-}" \
  -e SNAPSHOT_TTL_MS="${SNAPSHOT_TTL_MS:-604800000}" \
  -e ORPHAN_FILES="${ORPHAN_FILES:-1}" \
  -e ORPHAN_OLDER_THAN_DAYS="${ORPHAN_OLDER_THAN_DAYS:-3}" \
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "local[2]" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    /opt/spike/medallion_maintenance.py
