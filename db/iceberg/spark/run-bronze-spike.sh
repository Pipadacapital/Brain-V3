#!/usr/bin/env bash
# run-bronze-spike.sh — ADR-0002 Slice 2: run the Spark Bronze materializer against the
# local lakehouse (compose `lakehouse` profile must be up: iceberg-rest + minio + the Kafka broker).
#
# Spins a one-shot Spark container on the compose network, pulls the Iceberg + Kafka jars,
# and spark-submits bronze_materialize.py with trigger=availableNow (drain the backlog, exit).
# Dev-only; reads the live topic and writes the Iceberg Bronze table on MinIO. Re-runnable.
#
# K1: the broker is now Apache Kafka in KRaft mode (Redpanda removed). The compose service / DNS
# name is DELIBERATELY preserved as `redpanda` so this script's netns-join + localhost:9092
# bootstrap keep working unchanged — see the KAFKA_BROKERS comment in bronze_materialize.py.
#
# Usage:  db/iceberg/spark/run-bronze-spike.sh
# Env:    SPARK_IMAGE, ICEBERG_VERSION, NETWORK overridable.
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
PG_JDBC_VERSION="${PG_JDBC_VERSION:-42.7.4}"
SCALA="2.12"
SPARK_KAFKA="3.5.3"
# Join the Kafka broker's network namespace so its PLAINTEXT advertised listener (localhost:9092,
# set for host/same-netns clients) is reachable; service-name DNS (iceberg-rest, minio) still resolves
# because the broker is on the compose network. K1: broker is Apache Kafka KRaft, but the compose
# service / container name is preserved as `redpanda` so this default container name still matches.
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.spark:spark-sql-kafka-0-10_${SCALA}:${SPARK_KAFKA}"
PACKAGES="${PACKAGES},org.postgresql:postgresql:${PG_JDBC_VERSION}"   # R2 install_token→brand JDBC lookup

echo "[bronze-spike] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} packages=${PACKAGES}"

# An ivy cache volume so re-runs don't re-download the jars.
docker volume create brain-spark-ivy >/dev/null

exec docker run --rm \
  --memory "${SPARK_CONTAINER_MEMORY:-7g}" \
  --network "container:${REDPANDA_CONTAINER}" \
  --user root \
  -v "${SCRIPT_DIR}":/opt/spike:ro \
  -v brain-spark-ivy:/root/.ivy2 \
  -e KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:9092}" \
  -e COLLECTOR_TOPIC="${COLLECTOR_TOPIC:-dev.collector.event.v1}" \
  -e ICEBERG_REST_URI="${ICEBERG_REST_URI:-http://iceberg-rest:8181}" \
  -e BRONZE_WAREHOUSE="${BRONZE_WAREHOUSE:-s3://brain-bronze/}" \
  -e S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}" \
  -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-brain}" \
  -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-brainbrain}" \
  -e AWS_REGION="${AWS_REGION:-us-east-1}" \
  -e BRONZE_PG_JDBC_URL="${BRONZE_PG_JDBC_URL:-jdbc:postgresql://postgres:5432/brain}" \
  -e BRONZE_PG_USER="${BRONZE_PG_USER:-brain}" \
  -e BRONZE_PG_PASSWORD="${BRONZE_PG_PASSWORD:-brain}" \
  -e TRIGGER_MODE="${TRIGGER_MODE:-availableNow}" \
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "local[2]" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    /opt/spike/bronze_materialize.py
