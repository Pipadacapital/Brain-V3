#!/usr/bin/env bash
# dev-bronze-streaming.sh — run the UNIFIED Bronze streaming sink (db/iceberg/spark/bronze_landing.py).
#
# ONE Spark driver, ONE streaming query, ONE table: bronze_landing subscribes to ALL Bronze topics (the
# collector + backfill lanes AND the 9 connector *.raw.v1 lanes) and appends every record RAW into
# brain_bronze.events (a `connector` discriminator + verbatim payload), with per-lane dedup + one
# checkpoint. It replaces the old two-sink combined_bronze_sinks.py (collector_events + 9 *_raw tables).
# PURE RAW — no R2/R3 pixel gate here (that moved to Silver/silver_collector_event), so no Postgres.
#
# Prereqs: the compose `core` profile must be up (iceberg-rest + minio + the Kafka KRaft broker). No
# Postgres needed by the sink anymore (the gate + its install_token JDBC lookup live in Silver now).
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
#
# OOM ORDERING (AUD-LOCAL-003): `docker run` defaults to oom_score_adj 0, so under VM pressure the
# kernel killed this SOLE Bronze landing path BEFORE the protected compose tier (redis -300, the SoRs
# -500..-900). Pin -600 (SINK_OOM_SCORE_ADJ) — ingest-critical, protected alongside apicurio (-600);
# the durable checkpoint mitigates data loss but not ingest freezes. The ephemeral transform jobs
# (db/iceberg/spark run-*.sh) deliberately run at +100 instead: they're retried by the refresh loop,
# so they die FIRST — the ordering is explicit rather than accidental.
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

# Jar dependencies: Iceberg runtime + AWS bundle (S3FileIO→MinIO) + Spark-Kafka. NO Postgres JDBC — the
# unified bronze_landing is PURE RAW (no R2 install_token→brand gate; that moved to Silver), so it never
# touches PG. (PG_JDBC_VERSION is kept above only for backward-compat env parity.)
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.spark:spark-sql-kafka-0-10_${SCALA}:${SPARK_KAFKA}"

echo "[combined-bronze] image=${SPARK_IMAGE} netns=container:${KAFKA_CONTAINER} packages=${PACKAGES}"
echo "[combined-bronze] heap: driver=${SPARK_DRIVER_MEMORY:-4g} (local[*] → the only heap that matters) offHeap=${SPARK_OFFHEAP_SIZE:-512m} — tune UP via SPARK_DRIVER_MEMORY if a very large backlog lags/OOMs"

# An ivy cache volume so re-runs don't re-download the jars (shared with the per-lane run scripts).
docker volume create brain-spark-ivy >/dev/null
# DURABLE checkpoint volume (AUD-INFRA-004): the checkpoint used to live in the container's /tmp
# under `docker run --rm`, so EVERY crash/OOM restart destroyed it and re-drained ALL 11 topic lanes
# from STARTING_OFFSETS=earliest (full 7/30-day retention) — the exact large-backlog profile that
# historically OOMed the sink, i.e. an OOM→restart→re-drain amplification loop. Persist it on a
# named volume so restarts resume from the committed offsets; earliest stays the cold-start fallback.
# NOTE: a persisted checkpoint must be WIPED when the subscribed topic set / streaming query plan
# changes (Spark refuses or misbehaves on an incompatible checkpoint):
#   docker volume rm brain-bronze-checkpoint   (with the sink stopped)
docker volume create brain-bronze-checkpoint >/dev/null

# ── Supervisor loop — auto-restart the sink on ANY exit (crash OR OOM) ───────────────────────────────
# `docker run --rm` has no restart policy, so a transient Spark fault (executor RPC-endpoint loss /
# iceberg-catalog SQLite-lock contention during a concurrent medallion refresh) OR a heap OOM left Bronze
# FROZEN until someone noticed and restarted by hand — Kafka kept filling while nothing landed. Wrap the
# run in a bounded auto-restart loop: on exit, recreate from the DURABLE checkpoint (the idempotent MERGE
# on (brand_id,event_id) makes replay a no-op → zero data loss, no double-write). Kept FOREGROUND (not
# `docker run -d --restart`) so `pgrep -f bronze_landing.py` and the /tmp/bronze-sink.log capture
# both keep working for dev-up's liveness poll. Ctrl-C stops the loop AND the container.
trap 'echo "[combined-bronze] stopping…"; docker rm -f "${SINK_CONTAINER_NAME:-brain-bronze-sink}" >/dev/null 2>&1 || true; exit 0' INT TERM
while :; do
  docker rm -f "${SINK_CONTAINER_NAME:-brain-bronze-sink}" >/dev/null 2>&1 || true
  docker run --rm \
  --memory "${SPARK_CONTAINER_MEMORY:-7g}" \
  --oom-score-adj "${SINK_OOM_SCORE_ADJ:--600}" \
  --name "${SINK_CONTAINER_NAME:-brain-bronze-sink}" \
  --network "container:${KAFKA_CONTAINER}" \
  --user root \
  -v "${SPARK_SRC_DIR}":/opt/spike:ro \
  -v brain-spark-ivy:/root/.ivy2 \
  -v brain-bronze-checkpoint:/checkpoint \
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
  -e TRIGGER_MODE="${TRIGGER_MODE:-continuous}" \
  -e SPARK_OFFHEAP_SIZE="${SPARK_OFFHEAP_SIZE:-512m}" \
  -e CHECKPOINT_LOCATION="${CHECKPOINT_LOCATION:-file:///checkpoint/bronze-landing}" \
  "${SPARK_IMAGE}" \
  /opt/spark/bin/spark-submit \
    --master "${SPARK_MASTER:-local[*]}" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
    --executor-memory "${SPARK_EXECUTOR_MEMORY:-4g}" \
    --packages "${PACKAGES}" \
    --conf spark.jars.ivy=/root/.ivy2 \
    --conf "spark.sql.streaming.minBatchesToRetain=${SPARK_MIN_BATCHES_TO_RETAIN:-10}" \
    /opt/spike/bronze_landing.py && code=0 || code=$?
  echo "[combined-bronze] sink exited (code ${code}) — auto-restarting from checkpoint in ${SINK_RESTART_DELAY:-5}s…"
  sleep "${SINK_RESTART_DELAY:-5}"
done
