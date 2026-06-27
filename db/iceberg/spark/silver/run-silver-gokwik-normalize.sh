#!/usr/bin/env bash
# run-silver-gokwik-normalize.sh — ADR-0006 P4: normalize RAW GoKwik records in Spark Silver.
# Reads brain_bronze.gokwik_events_raw (Kafka Connect Iceberg sink output — verbatim GoKwik AWB +
# RTO-Predict records) and produces the canonical gokwik.awb_status.v1 + gokwik.rto_predict.v1 rows via
# the GOLDEN-VECTOR-VERIFIED shared ports in _raw_normalize.py (+ the GoKwik-local logistics-status /
# risk-flag ports in the job). Writes a SHADOW table by default (dual-run parity); set
# TARGET_TABLE=silver_collector_event at the gokwik-lane cutover.
# Requires the lakehouse profile + Postgres (per-brand salt for AWB hashing).
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
PG_JDBC_VERSION="${PG_JDBC_VERSION:-42.7.4}"
SCALA="2.12"
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-redpanda-1}"
SILVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARK_DIR="$(cd "${SILVER_DIR}/.." && pwd)"

PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.postgresql:postgresql:${PG_JDBC_VERSION}"

docker volume create brain-spark-ivy >/dev/null

docker run --rm \
  --network "container:${REDPANDA_CONTAINER}" \
  --user root \
  -v "${SPARK_DIR}":/opt/spark-src:ro \
  -v brain-spark-ivy:/root/.ivy2 \
  -e ICEBERG_CATALOG="${ICEBERG_CATALOG:-rest}" \
  -e ICEBERG_REST_URI="${ICEBERG_REST_URI:-http://iceberg-rest:8181}" \
  -e ICEBERG_WAREHOUSE="${ICEBERG_WAREHOUSE:-s3://brain-bronze/}" \
  -e BRONZE_NAMESPACE="${BRONZE_NAMESPACE:-brain_bronze}" \
  -e SILVER_NAMESPACE="${SILVER_NAMESPACE:-brain_silver}" \
  -e RAW_TABLE="${RAW_TABLE:-gokwik_events_raw}" \
  -e TARGET_TABLE="${TARGET_TABLE:-silver_collector_event_gokwik_shadow}" \
  -e BRAIN_REGION_CODE="${BRAIN_REGION_CODE:-IN}" \
  -e BRONZE_PG_JDBC_URL="${BRONZE_PG_JDBC_URL:-jdbc:postgresql://postgres:5432/brain}" \
  -e BRONZE_PG_USER="${BRONZE_PG_USER:-brain}" \
  -e BRONZE_PG_PASSWORD="${BRONZE_PG_PASSWORD:-brain}" \
  -e SALT_QUERY="${SALT_QUERY:-}" \
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
    --py-files /opt/spark-src/iceberg_base.py,/opt/spark-src/job_log.py,/opt/spark-src/silver/_raw_normalize.py \
    "/opt/spark-src/silver/silver_gokwik_normalize.py"

echo ""
echo "[silver] DONE — silver_gokwik_normalize (raw GoKwik AWB + RTO-Predict → canonical Silver) ✓"
