#!/usr/bin/env bash
# run-silver-entities.sh — Brain V4 Phase 1 (GROUP new-entities): run a NET-NEW canonical-entity Spark
# Silver job that reads raw Iceberg Bronze and MERGEs into rest.brain_silver.<entity>. Mirrors
# ../run-provision-silver-gold.sh (one-shot Spark container in Redpanda's netns so iceberg-rest / minio /
# postgres / neo4j service DNS resolves). ADDITIVE + idempotent + dual-run — touches NO dbt model / reader.
#
# Usage:
#   db/iceberg/spark/silver/run-silver-entities.sh settlement     # → rest.brain_silver.silver_settlement
#   db/iceberg/spark/silver/run-silver-entities.sh payment
#   db/iceberg/spark/silver/run-silver-entities.sh campaign
#   db/iceberg/spark/silver/run-silver-entities.sh journey
#   db/iceberg/spark/silver/run-silver-entities.sh identity_alias # set NEO4J_URI/USER/PASSWORD to populate
#   db/iceberg/spark/silver/run-silver-entities.sh all            # run every entity in this group
#
# Env: SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER overridable. NEO4J_* forwarded for identity_alias.
set -euo pipefail

ENTITY="${1:-all}"

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-kafka-1}"
SILVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_ROOT="$(cd "${SILVER_DIR}/.." && pwd)"

# Iceberg runtime + AWS bundle (Bronze read + Silver write). The Neo4j Spark connector is added ONLY for
# identity_alias (the other four are pure Bronze→Iceberg jobs and don't need it).
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

case "${ENTITY}" in
  settlement)     JOBS=("silver_settlement.py") ;;
  payment)        JOBS=("silver_payment.py") ;;
  campaign)       JOBS=("silver_campaign.py") ;;
  journey)        JOBS=("silver_journey.py") ;;
  identity_alias) JOBS=("silver_identity_alias.py")
                  PACKAGES="${PACKAGES},org.neo4j:neo4j-connector-apache-spark_${SCALA}:5.3.1_for_spark_3" ;;
  identity_map)   JOBS=("silver_identity_map.py")
                  PACKAGES="${PACKAGES},org.neo4j:neo4j-connector-apache-spark_${SCALA}:5.3.1_for_spark_3" ;;
  all)            JOBS=("silver_settlement.py" "silver_payment.py" "silver_campaign.py" "silver_journey.py" "silver_identity_alias.py" "silver_identity_map.py")
                  PACKAGES="${PACKAGES},org.neo4j:neo4j-connector-apache-spark_${SCALA}:5.3.1_for_spark_3" ;;
  *) echo "[silver-entities] unknown entity '${ENTITY}'. Use: settlement|payment|campaign|journey|identity_alias|identity_map|all" >&2; exit 2 ;;
esac

echo "[silver-entities] entity=${ENTITY} image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER}"

docker volume create brain-spark-ivy >/dev/null

for job in "${JOBS[@]}"; do
  echo "[silver-entities] ── running ${job} ──────────────────────────────────────────"
  docker run --rm \
    --network "container:${REDPANDA_CONTAINER}" \
    --user root \
    -v "${SPARK_ROOT}":/opt/spark-src:ro \
    -v brain-spark-ivy:/root/.ivy2 \
    -e ICEBERG_CATALOG="${ICEBERG_CATALOG:-rest}" \
    -e ICEBERG_REST_URI="${ICEBERG_REST_URI:-http://iceberg-rest:8181}" \
    -e ICEBERG_WAREHOUSE="${ICEBERG_WAREHOUSE:-s3://brain-bronze/}" \
    -e BRONZE_NAMESPACE="${BRONZE_NAMESPACE:-brain_bronze}" \
    -e SILVER_NAMESPACE="${SILVER_NAMESPACE:-brain_silver}" \
    -e S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}" \
    -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-brain}" \
    -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-brainbrain}" \
    -e AWS_REGION="${AWS_REGION:-us-east-1}" \
    -e V4_CORRELATION_ID="${V4_CORRELATION_ID:-}" \
  -e SPARK_DRIVER_MEMORY="${SPARK_DRIVER_MEMORY:-4g}" \
  -e FULL_REFRESH="${FULL_REFRESH:-}" \
  -e SILVER_INCREMENTAL_OVERLAP_HOURS="${SILVER_INCREMENTAL_OVERLAP_HOURS:-2}" \
  -e SILVER_BATCH_TARGET_ROWS="${SILVER_BATCH_TARGET_ROWS:-500000}" \
  -e SILVER_MAX_CHUNKS="${SILVER_MAX_CHUNKS:-48}" \
    -e NEO4J_URI="${NEO4J_URI:-}" \
    -e NEO4J_USER="${NEO4J_USER:-neo4j}" \
    -e NEO4J_PASSWORD="${NEO4J_PASSWORD:-}" \
    "${SPARK_IMAGE}" \
    /opt/spark/bin/spark-submit \
      --master "local[2]" \
    --driver-memory "${SPARK_DRIVER_MEMORY:-4g}" \
      --packages "${PACKAGES}" \
      --conf spark.jars.ivy=/root/.ivy2 \
      /opt/spark-src/silver/"${job}"
done

echo "[silver-entities] DONE entity=${ENTITY}"
