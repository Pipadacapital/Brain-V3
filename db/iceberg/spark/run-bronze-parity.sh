#!/usr/bin/env bash
# run-bronze-parity.sh — ADR-0002 Slice 3: run the PG ⇄ Iceberg Bronze parity oracle.
# The migration cut-over gate. Exits non-zero on drift (CI/gate friendly).
#
# Requires the lakehouse profile up (iceberg-rest + minio) AND postgres + redpanda (core/ingest).
# Joins Redpanda's network namespace so postgres/iceberg-rest/minio service DNS resolves.
#
# Usage:  db/iceberg/spark/run-bronze-parity.sh
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
PG_JDBC_VERSION="${PG_JDBC_VERSION:-42.7.4}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.postgresql:postgresql:${PG_JDBC_VERSION}"

echo "[bronze-parity] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER}"

docker volume create brain-spark-ivy >/dev/null

exec docker run --rm \
  --memory "${SPARK_CONTAINER_MEMORY:-7g}" \
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
  -e PARITY_PG_JDBC_URL="${PARITY_PG_JDBC_URL:-jdbc:postgresql://postgres:5432/brain}" \
  -e PARITY_PG_USER="${PARITY_PG_USER:-brain}" \
  -e PARITY_PG_PASSWORD="${PARITY_PG_PASSWORD:-brain}" \
  -e PARITY_TOLERANCE="${PARITY_TOLERANCE:-0}" \
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "local[2]" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    /opt/spike/bronze_parity_check.py
