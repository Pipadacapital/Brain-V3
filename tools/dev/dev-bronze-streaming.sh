#!/usr/bin/env bash
# dev-bronze-streaming.sh — run BOTH local Bronze streaming sinks in ONE Spark driver.
#
# Fuses the two previously-separate compose sinks (spark-bronze-sink = the gated collector/pixel lane,
# and spark-bronze-raw-sink = the 9-lane connector raw landing) into a SINGLE spark-submit of
# db/iceberg/spark/combined_bronze_sinks.py. That module builds ONE SparkSession, constructs BOTH
# streaming queries by REUSING the proven modules' build_writer functions, and runs them together via
# spark.streams.awaitAnyTermination() — separate checkpoints, idempotent MERGE, offset-after-commit.
#
# Prereqs: the compose `lakehouse` profile must be up (iceberg-rest + minio + the Kafka KRaft broker)
# AND Postgres up (the collector lane's R2 install_token→brand JDBC lookup reads pixel.pixel_installation).
#
# K1: the broker is Apache Kafka in KRaft mode; the compose service / container name is DELIBERATELY
# preserved as `redpanda`, so this script joins that container's netns and bootstraps localhost:9092.
#
# ────────────────────────────────────────────────────────────────────────────────────────────────────
# ⚠️  MEMORY IS UNVERIFIED — the 2g combined target has NOT been live-validated.  ⚠️
# docs/ops/local-memory-budget.md sizes the two SEPARATE sinks at ~7g + ~6g mem_limit (4g driver heap
# each), tuned for cold-start backlog drain. The STARTING-POINT flags below — driver 1g + executor 1g +
# offHeap 256m (≈ a ~2g combined target) — are an ASPIRATION, not a proven number. Fusing two JVMs into
# one does NOT halve the heap each lane needs; the collector lane alone OOMed at the default 1g during
# the 9,916-order Shopify backlog drain. LIVE-RUN THIS and tune the heap UP via SPARK_DRIVER_MEMORY /
# SPARK_EXECUTOR_MEMORY (and raise SPARK_OFFHEAP_SIZE) if it OOMs (`Java heap space`) or lags. Do not
# assume 2g works.
# ────────────────────────────────────────────────────────────────────────────────────────────────────
#
# Usage:  tools/dev/dev-bronze-streaming.sh
# Env:    SPARK_IMAGE, ICEBERG_VERSION, PG_JDBC_VERSION, REDPANDA_CONTAINER, TRIGGER_MODE,
#         SPARK_DRIVER_MEMORY, SPARK_EXECUTOR_MEMORY, SPARK_OFFHEAP_SIZE, TOPIC_ENV_PREFIX, LANE overridable.
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
PG_JDBC_VERSION="${PG_JDBC_VERSION:-42.7.4}"
SCALA="2.12"
SPARK_KAFKA="3.5.3"
# Join the broker's network namespace so its PLAINTEXT advertised listener (localhost:9092, for
# host/same-netns clients) is reachable; service-name DNS (iceberg-rest, minio, postgres) still resolves
# because the broker is on the compose network. The compose service / container name is preserved as
# `redpanda` (now an apache/kafka KRaft broker — K1), so this default container name still matches.
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-redpanda-1}"
# This launcher lives in tools/dev; the Spark modules live in db/iceberg/spark. Mount THAT dir so
# combined_bronze_sinks.py can import its sibling modules (bronze_materialize, bronze_raw_landing).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_SRC_DIR="$(cd "${SCRIPT_DIR}/../../db/iceberg/spark" && pwd)"

# Union of BOTH sinks' jar dependencies: Iceberg runtime + AWS bundle (S3FileIO→MinIO), Spark-Kafka
# (both lanes read Kafka), and the Postgres JDBC driver (collector lane's R2 install_token→brand lookup).
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.spark:spark-sql-kafka-0-10_${SCALA}:${SPARK_KAFKA}"
PACKAGES="${PACKAGES},org.postgresql:postgresql:${PG_JDBC_VERSION}"

echo "[combined-bronze] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} packages=${PACKAGES}"
echo "[combined-bronze] heap STARTING POINT (UNVERIFIED): driver=${SPARK_DRIVER_MEMORY:-1g} executor=${SPARK_EXECUTOR_MEMORY:-1g} offHeap=${SPARK_OFFHEAP_SIZE:-256m} — tune UP if it OOMs/lags"

# An ivy cache volume so re-runs don't re-download the jars (shared with the per-lane run scripts).
docker volume create brain-spark-ivy >/dev/null

exec docker run --rm \
  --network "container:${REDPANDA_CONTAINER}" \
  --user root \
  -v "${SPARK_SRC_DIR}":/opt/spike:ro \
  -v brain-spark-ivy:/root/.ivy2 \
  -e KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:9092}" \
  -e COLLECTOR_TOPIC="${COLLECTOR_TOPIC:-dev.collector.event.v1}" \
  -e BACKFILL_TOPIC="${BACKFILL_TOPIC:-dev.collector.order.backfill.v1}" \
  -e TOPIC_ENV_PREFIX="${TOPIC_ENV_PREFIX:-prod}" \
  -e LANE="${LANE:-}" \
  -e ICEBERG_REST_URI="${ICEBERG_REST_URI:-http://iceberg-rest:8181}" \
  -e BRONZE_NAMESPACE="${BRONZE_NAMESPACE:-brain_bronze}" \
  -e BRONZE_WAREHOUSE="${BRONZE_WAREHOUSE:-s3://brain-bronze/}" \
  -e S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}" \
  -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-brain}" \
  -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-brainbrain}" \
  -e AWS_REGION="${AWS_REGION:-us-east-1}" \
  -e BRONZE_PG_JDBC_URL="${BRONZE_PG_JDBC_URL:-jdbc:postgresql://postgres:5432/brain}" \
  -e BRONZE_PG_USER="${BRONZE_PG_USER:-brain}" \
  -e BRONZE_PG_PASSWORD="${BRONZE_PG_PASSWORD:-brain}" \
  -e TRIGGER_MODE="${TRIGGER_MODE:-continuous}" \
  -e SPARK_OFFHEAP_SIZE="${SPARK_OFFHEAP_SIZE:-256m}" \
  -e COLLECTOR_CHECKPOINT_LOCATION="${COLLECTOR_CHECKPOINT_LOCATION:-file:///tmp/bronze-spike-checkpoint}" \
  -e RAW_CHECKPOINT_LOCATION="${RAW_CHECKPOINT_LOCATION:-file:///tmp/bronze-raw-landing-checkpoint}" \
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "local[2]" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-1g}" \
    --executor-memory "${SPARK_EXECUTOR_MEMORY:-1g}" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    /opt/spike/combined_bronze_sinks.py
