#!/usr/bin/env bash
# run-provision-silver-gold.sh — Brain V4 Phase 0 (Area B): provision the Iceberg brain_silver +
# brain_gold namespaces against the local lakehouse (compose `lakehouse` profile must be up:
# iceberg-rest + minio). Mirrors run-bronze-spike.sh.
#
# Spins a one-shot Spark container on the compose network, pulls the Iceberg jars, and spark-submits
# provision_silver_gold.py — which CREATEs the Silver/Gold namespaces + one canonical empty table in
# each, then proves the idempotent MERGE path against them. ADDITIVE + idempotent + re-runnable; it
# does NOT touch Bronze or any existing read path (Phase 0 is non-breaking).
#
# This is the local-prod equivalent of the Terraform-provisioned Glue Silver/Gold catalogs (Terraform
# can be written but not applied here) — so Spark can actually CREATE + MERGE Silver/Gold tables and
# it is verifiable this session.
#
# Usage:  db/iceberg/spark/run-provision-silver-gold.sh
# Env:    SPARK_IMAGE, ICEBERG_VERSION, REDPANDA_CONTAINER overridable.
set -euo pipefail

SPARK_IMAGE="${SPARK_IMAGE:-apache/spark:3.5.3}"
ICEBERG_VERSION="${ICEBERG_VERSION:-1.9.2}"
SCALA="2.12"
# Join Redpanda's network namespace so service-name DNS (iceberg-rest, minio) resolves — the same
# netns trick run-bronze-spike.sh uses (no broker traffic is needed here, but it puts us on the
# compose network with the right DNS without a dedicated --network flag).
REDPANDA_CONTAINER="${REDPANDA_CONTAINER:-brainv3-redpanda-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Only the Iceberg runtime + AWS bundle are needed (no Kafka / no PG JDBC — this is a pure catalog job).
PACKAGES="org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION}"
PACKAGES="${PACKAGES},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}"

echo "[provision] image=${SPARK_IMAGE} netns=container:${REDPANDA_CONTAINER} packages=${PACKAGES}"

# Reuse the Bronze ivy cache volume so the Iceberg jars are already present after a Bronze run.
docker volume create brain-spark-ivy >/dev/null

exec docker run --rm \
  --network "container:${REDPANDA_CONTAINER}" \
  --user root \
  -v "${SCRIPT_DIR}":/opt/spike:ro \
  -v brain-spark-ivy:/root/.ivy2 \
  -e ICEBERG_CATALOG="${ICEBERG_CATALOG:-rest}" \
  -e ICEBERG_REST_URI="${ICEBERG_REST_URI:-http://iceberg-rest:8181}" \
  -e ICEBERG_WAREHOUSE="${ICEBERG_WAREHOUSE:-s3://brain-bronze/}" \
  -e SILVER_NAMESPACE="${SILVER_NAMESPACE:-brain_silver}" \
  -e GOLD_NAMESPACE="${GOLD_NAMESPACE:-brain_gold}" \
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
    /opt/spike/provision_silver_gold.py
