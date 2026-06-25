#!/usr/bin/env bash
# run-silver-storefront-gaps.sh — Brain V4 Phase 1b (GROUP storefront gap-fill): run the GAP canonical
# Silver jobs that read raw Iceberg Bronze and MERGE into rest.brain_silver.<table>, dual-run BESIDE the
# dbt brain_silver. Mirrors ./run-silver-entities.sh (one-shot Spark container in Redpanda's netns so
# iceberg-rest / minio service DNS resolves). ADDITIVE + idempotent + dual-run — touches NO dbt model / reader.
#
# Tables: silver_refund, silver_fulfillment, silver_product_variant, silver_inventory_level.
#
# Usage:
#   db/iceberg/spark/silver/run-silver-storefront-gaps.sh refund            # → rest.brain_silver.silver_refund
#   db/iceberg/spark/silver/run-silver-storefront-gaps.sh fulfillment
#   db/iceberg/spark/silver/run-silver-storefront-gaps.sh product_variant
#   db/iceberg/spark/silver/run-silver-storefront-gaps.sh inventory_level
#   db/iceberg/spark/silver/run-silver-storefront-gaps.sh all               # run every table in this group
#
# Env: SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER overridable.
set -euo pipefail

TARGET="${1:-all}"

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-redpanda-1}"
SILVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_ROOT="$(cd "${SILVER_DIR}/.." && pwd)"

# Pure Bronze→Iceberg jobs: only the Iceberg runtime + AWS bundle are needed (no Kafka / no PG JDBC).
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

case "${TARGET}" in
  refund)           JOBS=("silver_refund.py") ;;
  fulfillment)      JOBS=("silver_fulfillment.py") ;;
  product_variant)  JOBS=("silver_product_variant.py") ;;
  inventory_level)  JOBS=("silver_inventory_level.py") ;;
  all)              JOBS=("silver_refund.py" "silver_fulfillment.py" "silver_product_variant.py" "silver_inventory_level.py") ;;
  *) echo "[silver-storefront-gaps] unknown target '${TARGET}'. Use: refund|fulfillment|product_variant|inventory_level|all" >&2; exit 2 ;;
esac

echo "[silver-storefront-gaps] target=${TARGET} image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER}"

docker volume create brain-spark-ivy >/dev/null

for job in "${JOBS[@]}"; do
  echo "[silver-storefront-gaps] ── running ${job} ──────────────────────────────────────────"
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
    "${SPARK_IMAGE}" \
    /opt/spark/bin/spark-submit \
      --master "local[2]" \
      --packages "${PACKAGES}" \
      --conf spark.jars.ivy=/root/.ivy2 \
      /opt/spark-src/silver/"${job}"
done

echo "[silver-storefront-gaps] DONE target=${TARGET}"
