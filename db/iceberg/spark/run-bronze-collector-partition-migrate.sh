#!/usr/bin/env bash
# run-bronze-collector-partition-migrate.sh — AUD-IMPL-025: one-time metadata migration adding a
# days(kafka_timestamp) partition spec to brain_bronze.collector_events_connect (+ parity check).
#
#   Dry run (default):  db/iceberg/spark/run-bronze-collector-partition-migrate.sh
#   Apply:              PARTITION_MIGRATE_EXECUTE=1 db/iceberg/spark/run-bronze-collector-partition-migrate.sh
#
# NOT a cron — a one-time, runbook-driven migration (idempotent; re-running after success is a loud
# no-op). Requires the lakehouse profile up (iceberg-rest + minio). Joins the Kafka container's netns
# only for service DNS, exactly like the other maintenance run scripts.
set -euo pipefail

# AUD-INFRA-006: host-global batch-Spark admission lock — queue behind any running batch container.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_spark_lock.sh"

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

echo "[partition-migrate] EXECUTE=${PARTITION_MIGRATE_EXECUTE:-0 (dry run)} image=${SPARK_IMAGE}"
docker volume create brain-spark-ivy >/dev/null

exec docker run --rm \
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
  -e COLLECTOR_CONNECT_TABLE="${COLLECTOR_CONNECT_TABLE:-collector_events_connect}" \
  -e PARTITION_MIGRATE_EXECUTE="${PARTITION_MIGRATE_EXECUTE:-}" \
  -e S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}" \
  -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-brain}" \
  -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-brainbrain}" \
  -e AWS_REGION="${AWS_REGION:-us-east-1}" \
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "local[2]" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    --py-files /opt/spike/iceberg_base.py,/opt/spike/job_log.py \
    /opt/spike/bronze_collector_partition_migrate.py
