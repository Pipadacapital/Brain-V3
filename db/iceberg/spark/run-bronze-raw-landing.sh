#!/usr/bin/env bash
# run-bronze-raw-landing.sh — ADR-0006 (Spark-SS landing revert): run the GENERIC raw-landing job
# for the connector *.raw.v1 lanes against the local lakehouse (compose `lakehouse` profile up:
# iceberg-rest + minio + the Kafka KRaft broker). Replaces the retired Kafka Connect Iceberg sinks.
#
# Spins a one-shot Spark container in the broker's network namespace, pulls the Iceberg + Kafka jars,
# and spark-submits bronze_raw_landing.py. Default TRIGGER_MODE=availableNow drains the current backlog
# of every lane into its brain_bronze.<lane>_raw table once, then exits. Re-runnable (idempotent MERGE
# on the Kafka coordinate). Set LANE=<key> to land a single lane; TRIGGER_MODE=continuous for a sink.
#
# Usage:  db/iceberg/spark/run-bronze-raw-landing.sh
# Env:    SPARK_IMAGE, ICEBERG_VERSION, KAFKA_CONTAINER, LANE, TRIGGER_MODE, TOPIC_ENV_PREFIX overridable.
set -euo pipefail

# AUD-INFRA-006: batch-Spark admission lock — but ONLY for the bounded availableNow drain. A continuous
# sink never exits, so holding the batch lock would starve every batch job (same reason
# tools/dev/dev-bronze-streaming.sh does not take it).
if [ "${TRIGGER_MODE:-availableNow}" != "continuous" ]; then
  . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_spark_lock.sh"
fi

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
SPARK_KAFKA="3.5.3"
# Join the broker's network namespace so its advertised listener (localhost:9092, for host clients) is
# reachable; service-name DNS (iceberg-rest, minio) still resolves because the broker is on the compose
# network. The compose service is still named `redpanda` (now an apache/kafka KRaft broker — K1).
KAFKA_CONTAINER="${KAFKA_CONTAINER:-brainv3-kafka-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.spark:spark-sql-kafka-0-10_${SCALA}:${SPARK_KAFKA}"

echo "[bronze-raw] image=${SPARK_IMAGE} netns=container:${KAFKA_CONTAINER} packages=${PACKAGES}"

# An ivy cache volume so re-runs don't re-download the jars.
docker volume create brain-spark-ivy >/dev/null

exec docker run --rm \
  --memory "${SPARK_CONTAINER_MEMORY:-7g}" \
  --oom-score-adj "${SPARK_CONTAINER_OOM_SCORE_ADJ:-100}" \
  --network "container:${KAFKA_CONTAINER}" \
  --user root \
  -v "${SCRIPT_DIR}":/opt/spike:ro \
  -v brain-spark-ivy:/root/.ivy2 \
  -e KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:9092}" \
  -e TOPIC_ENV_PREFIX="${TOPIC_ENV_PREFIX:-prod}" \
  -e LANE="${LANE:-}" \
  -e ICEBERG_REST_URI="${ICEBERG_REST_URI:-http://iceberg-rest:8181}" \
  -e BRONZE_NAMESPACE="${BRONZE_NAMESPACE:-brain_bronze}" \
  -e BRONZE_WAREHOUSE="${BRONZE_WAREHOUSE:-s3://brain-bronze/}" \
  -e S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}" \
  -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-brain}" \
  -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-brainbrain}" \
  -e AWS_REGION="${AWS_REGION:-us-east-1}" \
  -e TRIGGER_MODE="${TRIGGER_MODE:-availableNow}" \
  -e CHECKPOINT_LOCATION="${CHECKPOINT_LOCATION:-file:///tmp/bronze-raw-landing-checkpoint}" \
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "local[2]" \
    --driver-memory "${DRIVER_MEMORY:-4g}" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    /opt/spike/bronze_raw_landing.py
