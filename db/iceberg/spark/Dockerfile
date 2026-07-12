# Spark medallion jobs image (ADR-0002 Slice 3; ADR-0010 Connect-era scope).
#
# build-trigger: first prod build of brain-spark-bronze-prod — the image was
# never built (no db/iceberg/spark change had landed), so the cronworkflows
# chart fail-closed on an empty sparkV4.image.digest. Safe to remove later.
#
# ADR-0010: Bronze LANDING is the Kafka Connect Iceberg sink — the Spark-SS landing jobs (and the
# PG⇄Iceberg parity oracle/inspector that read them) are REMOVED. This image carries the Bronze
# MAINTENANCE jobs (compaction/snapshot-expiry, raw retention, erasure) plus the V4 Silver/Gold
# transform marts the Argo CronWorkflows spark-submit.
#
# Jars are pre-fetched at BUILD time into /opt/spark/jars so the runtime image needs NO Maven
# access (B3: reproducible, network-isolated runtime). Pin the image by digest in the deploy
# manifest (never :latest).
FROM apache/spark:3.5.3

USER root

ARG ICEBERG_VERSION=1.9.2
ARG SPARK_KAFKA_VERSION=3.5.3
ARG PG_JDBC_VERSION=42.7.4
# hadoop-aws (S3A) — medallion_maintenance remove_orphan_files lists table locations via the
# Hadoop FileSystem, not S3FileIO (AUD-COST-020). 3.3.4 matches Spark 3.5.x's bundled Hadoop
# client libs and transitively pins the matching aws-java-sdk-bundle (v1 SDK — provides
# DefaultAWSCredentialsProviderChain/WebIdentity for IRSA). Mirrors run-medallion-maintenance.sh.
ARG HADOOP_AWS_VERSION=3.3.4
ARG SCALA=2.12
# Neo4j Spark connector — silver_customer_identity / silver_identity_alias project the
# identity graph from Neo4j (SoR, ADR-0004). Absent, the first prod fill failed with
# ClassNotFoundException: org.neo4j.spark.DataSource (2026-07-11). Version mirrors
# run-silver-customer.sh (compose lane) — bump BOTH together.
ARG NEO4J_CONNECTOR_VERSION=5.3.1_for_spark_3

WORKDIR /opt/brain
# Bronze maintenance/retention/erasure + the shared Iceberg base and the Silver/Gold provisioner +
# medallion maintenance. (ADR-0010: the Spark-SS landing/oracle/inspector modules are removed —
# Bronze landing is the Kafka Connect Iceberg sink, deployed outside this image.)
COPY bronze_maintenance.py bronze_raw_retention.py erasure_raw_delete.py \
     iceberg_base.py provision_silver_gold.py medallion_maintenance.py job_log.py \
     _identity_normalization.py bronze_collector_partition_migrate.py /opt/brain/

# SPEC: A.1.3 (WA-06) — python dep for the shared identity-normalization twin
# (_identity_normalization.py: phone E.164 via Google libphonenumber). PINNED to the exact
# version the A.5.2 cross-language property test proved byte-identical against the TS twin
# (packages/identity-normalization, libphonenumber-js) — bump BOTH sides together and re-run
# packages/identity-normalization/scripts/run-a52-property-test.sh (0 mismatches required).
# NOTE: the local docker-run dev path (run-silver-*.sh) uses the vanilla apache/spark image;
# the module lazy-guards the import so email-only consumers work without it there.
RUN pip3 install --no-cache-dir phonenumbers==9.0.34

# SPEC: A.3 / §1.1 (WA-20) — Splink is the ONE sanctioned added dependency (probabilistic stitch,
# silver/silver_probabilistic_stitch.py). PINNED <4: this base is apache/spark:3.5.3 (Python 3.8) and
# Splink 4 requires Python ≥3.9. Splink 3.9.15 trains (estimate_m_from_label_column) and predicts on
# Spark 3.5.3 — VERIFIED in-image — GIVEN the two shims the job sets at runtime:
#   (a) spark.sparkContext.setCheckpointDir(...) — SparkLinker checkpoints to break query lineage; and
#   (b) an `array_length` session UDF aliasing size() — Splink's Spark array_intersect_at_sizes SQL
#       emits ARRAY_LENGTH, which is NOT a Spark 3.5.3 builtin.
# The probabilistic layer is QUARANTINED (§1.4) + flag-gated (identity.probabilistic, default OFF), so
# this dependency ships DORMANT. Bump this pin and run-silver-probabilistic-stitch.sh's SPLINK_SPEC
# together (only past 3.x once the base image's Python is ≥3.9). Also carried in the model-eval harness
# via a dev venv — NOT this image (splink_v1_golden_eval.py uses Splink 4 + DuckDB on the dev's 3.9+).
RUN pip3 install --no-cache-dir 'splink>=3.9.10,<4'

# V4 Spark Silver/Gold MART jobs + run scripts + the shared bounded-retry helper. Additive: the image
# now CARRIES the transform marts so the V4 CronWorkflows (infra/helm/cronworkflows → spark-v4.yaml) can
# spark-submit them in prod, mirroring the Bronze crons. The run-*.sh scripts source _retry.sh, so it is
# copied alongside. (The compose dev path mounts the repo instead; this COPY is for the built image.)
COPY _retry.sh /opt/brain/
COPY silver/ /opt/brain/silver/
COPY gold/   /opt/brain/gold/

# Resolve + cache the runtime jars at build time, then place them on the default Spark classpath.
# NOTE: `spark-submit --packages ... --version` prints the banner and exits BEFORE Ivy resolution —
# it never downloads the jars (a latent bug: the image never built). Run a no-op application instead,
# which forces Ivy to resolve+download the --packages at submit time, then harvest the jars (Spark
# lands them under the ivy home — copy every *.jar from anywhere beneath it).
RUN set -eux; \
    printf 'import sys\nsys.exit(0)\n' > /tmp/noop.py; \
    /opt/spark/bin/spark-submit \
      --packages "org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION},org.apache.spark:spark-sql-kafka-0-10_${SCALA}:${SPARK_KAFKA_VERSION},org.postgresql:postgresql:${PG_JDBC_VERSION},org.apache.hadoop:hadoop-aws:${HADOOP_AWS_VERSION},org.neo4j:neo4j-connector-apache-spark_${SCALA}:${NEO4J_CONNECTOR_VERSION}" \
      --conf spark.jars.ivy=/tmp/ivy \
      /tmp/noop.py; \
    find /tmp/ivy -name '*.jar' -exec cp -n {} /opt/spark/jars/ \; ; \
    rm -rf /tmp/ivy /tmp/noop.py

USER spark

# Default: Bronze maintenance (compaction + snapshot expiry). Landing is the Kafka Connect Iceberg
# sink now (ADR-0010) — there is no streaming default. The Argo CronWorkflows always pass an explicit
# script path, so this default only serves a bare `docker run`.
ENTRYPOINT ["/opt/spark/bin/spark-submit", "--master", "local[*]", "/opt/brain/bronze_maintenance.py"]
