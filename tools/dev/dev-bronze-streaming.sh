#!/usr/bin/env bash
# dev-bronze-streaming.sh — run BOTH local Bronze streaming sinks in ONE Spark driver.
#
# Fuses the two previously-separate compose sinks (spark-bronze-sink = the gated collector/pixel lane,
# and spark-bronze-raw-sink = the 9-lane connector raw landing) into a SINGLE spark-submit of
# db/iceberg/spark/combined_bronze_sinks.py. That module builds ONE SparkSession, constructs BOTH
# streaming queries by REUSING the proven modules' build_writer functions, and runs them together via
# spark.streams.awaitAnyTermination() — separate checkpoints, idempotent MERGE, offset-after-commit.
#
# Prereqs: the compose `core` profile must be up (iceberg-rest + minio + the Kafka KRaft broker + Postgres
# — the collector lane's R2 install_token→brand JDBC lookup reads pixel.pixel_installation).
#
# K1: the broker is Apache Kafka in KRaft mode; the compose service was renamed redpanda→kafka, so this
# script joins the `brainv3-kafka-1` container's netns and bootstraps localhost:9092 (its advertised PLAINTEXT).
#
# ────────────────────────────────────────────────────────────────────────────────────────────────────
# MEMORY — driver 4g default (raised from the earlier UNVERIFIED 1g, which OOMed).
# In `local[*]` the driver JVM IS the executor, so `--driver-memory` is the ONLY heap that matters
# (`--executor-memory` is ignored). The 1g starting point died with `java.lang.OutOfMemoryError: Java
# heap space` mid-drain of a large backlog (a shuffle-write OOM after ~73k tasks): 1g cannot hold the
# per-batch shuffle + the growing Iceberg MERGE target scan + accumulated streaming metadata across a
# long catch-up. docs/ops/local-memory-budget.md sized each SEPARATE lane at a 4g driver heap; the
# batches are already bounded (maxOffsetsPerTrigger 2000/5000) + AQE-coalesced, and the two lanes' peaks
# are staggered, so ONE 4g heap comfortably covers the fused sink. Defensively we also cap retained
# streaming batch metadata (spark.sql.streaming.minBatchesToRetain=10) so a long drain doesn't creep up.
# Tune further via SPARK_DRIVER_MEMORY / SPARK_OFFHEAP_SIZE if a very large backlog still lags/OOMs.
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
# because the broker is on the compose network. The compose service was renamed redpanda→kafka, so the
# broker container is now `brainv3-kafka-1`; REDPANDA_CONTAINER is still honored as a legacy override.
KAFKA_CONTAINER="${KAFKA_CONTAINER:-${REDPANDA_CONTAINER:-brainv3-kafka-1}}"
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

echo "[combined-bronze] image=${SPARK_IMAGE} netns=container:${KAFKA_CONTAINER} packages=${PACKAGES}"
echo "[combined-bronze] heap: driver=${SPARK_DRIVER_MEMORY:-4g} (local[*] → the only heap that matters) offHeap=${SPARK_OFFHEAP_SIZE:-512m} — tune UP via SPARK_DRIVER_MEMORY if a very large backlog lags/OOMs"

# An ivy cache volume so re-runs don't re-download the jars (shared with the per-lane run scripts).
docker volume create brain-spark-ivy >/dev/null

# ── Supervisor loop — auto-restart the sink on ANY exit (crash OR OOM) ───────────────────────────────
# `docker run --rm` has no restart policy, so a transient Spark fault (executor RPC-endpoint loss /
# iceberg-catalog SQLite-lock contention during a concurrent medallion refresh) OR a heap OOM left Bronze
# FROZEN until someone noticed and restarted by hand — Kafka kept filling while nothing landed. Wrap the
# run in a bounded auto-restart loop: on exit, recreate from the DURABLE checkpoint (the idempotent MERGE
# on (brand_id,event_id) makes replay a no-op → zero data loss, no double-write). Kept FOREGROUND (not
# `docker run -d --restart`) so `pgrep -f combined_bronze_sinks.py` and the /tmp/bronze-sink.log capture
# both keep working for dev-up's liveness poll. Ctrl-C stops the loop AND the container.
trap 'echo "[combined-bronze] stopping…"; docker rm -f "${SINK_CONTAINER_NAME:-brain-bronze-sink}" >/dev/null 2>&1 || true; exit 0' INT TERM
while :; do
  docker rm -f "${SINK_CONTAINER_NAME:-brain-bronze-sink}" >/dev/null 2>&1 || true
  docker run --rm \
  --name "${SINK_CONTAINER_NAME:-brain-bronze-sink}" \
  --network "container:${KAFKA_CONTAINER}" \
  --user root \
  -v "${SPARK_SRC_DIR}":/opt/spike:ro \
  -v brain-spark-ivy:/root/.ivy2 \
  -e KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:9092}" \
  -e COLLECTOR_TOPIC="${COLLECTOR_TOPIC:-prod.collector.event.v1}" \
  -e BACKFILL_TOPIC="${BACKFILL_TOPIC:-prod.collector.order.backfill.v1}" \
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
  -e SPARK_OFFHEAP_SIZE="${SPARK_OFFHEAP_SIZE:-512m}" \
  -e COLLECTOR_CHECKPOINT_LOCATION="${COLLECTOR_CHECKPOINT_LOCATION:-file:///tmp/bronze-spike-checkpoint}" \
  -e RAW_CHECKPOINT_LOCATION="${RAW_CHECKPOINT_LOCATION:-file:///tmp/bronze-raw-landing-checkpoint}" \
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "${SPARK_MASTER:-local[*]}" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
    --executor-memory "${SPARK_EXECUTOR_MEMORY:-4g}" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    --conf "spark.sql.streaming.minBatchesToRetain=${SPARK_MIN_BATCHES_TO_RETAIN:-10}" \
    /opt/spike/combined_bronze_sinks.py && code=0 || code=$?
  echo "[combined-bronze] sink exited (code ${code}) — auto-restarting from checkpoint in ${SINK_RESTART_DELAY:-5}s…"
  sleep "${SINK_RESTART_DELAY:-5}"
done
