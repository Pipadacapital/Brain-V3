# Spark Bronze materializer image (ADR-0002 Slice 3).
#
# The Bronze writer for the Iceberg flip: a Spark Structured Streaming job that reads
# collector.event.v1 and MERGEs into the Iceberg Bronze table. Also carries the parity oracle
# (bronze_parity_check.py) and the inspector (validate_bronze.py).
#
# Jars are pre-fetched at BUILD time into /opt/spark/jars so the runtime image needs NO Maven
# access (B3: reproducible, network-isolated runtime). Pin the image by digest in the deploy
# manifest (never :latest).
FROM apache/spark:3.5.3

USER root

ARG ICEBERG_VERSION=1.9.2
ARG SPARK_KAFKA_VERSION=3.5.3
ARG PG_JDBC_VERSION=42.7.4
ARG SCALA=2.12

WORKDIR /opt/brain
# Bronze writer/oracle/maintenance/inspector + the shared Iceberg base and the Silver/Gold
# provisioner + medallion maintenance (V4 Phase 0, additive — the Silver/Gold seam jobs reuse).
COPY bronze_materialize.py bronze_parity_check.py bronze_maintenance.py validate_bronze.py \
     iceberg_base.py provision_silver_gold.py medallion_maintenance.py /opt/brain/

# Resolve + cache the runtime jars at build time, then place them on the default Spark classpath.
# NOTE: `spark-submit --packages ... --version` prints the banner and exits BEFORE Ivy resolution —
# it never downloads the jars (a latent bug: the image never built). Run a no-op application instead,
# which forces Ivy to resolve+download the --packages at submit time, then harvest the jars (Spark
# lands them under the ivy home — copy every *.jar from anywhere beneath it).
RUN set -eux; \
    printf 'import sys\nsys.exit(0)\n' > /tmp/noop.py; \
    /opt/spark/bin/spark-submit \
      --packages "org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION},org.apache.spark:spark-sql-kafka-0-10_${SCALA}:${SPARK_KAFKA_VERSION},org.postgresql:postgresql:${PG_JDBC_VERSION}" \
      --conf spark.jars.ivy=/tmp/ivy \
      /tmp/noop.py; \
    find /tmp/ivy -name '*.jar' -exec cp -n {} /opt/spark/jars/ \; ; \
    rm -rf /tmp/ivy /tmp/noop.py

USER spark

# Default: stream collector.event.v1 → Iceberg Bronze. Override TRIGGER_MODE=availableNow for the
# periodic CronWorkflow shape, or the entrypoint script for the parity oracle.
ENV TRIGGER_MODE=continuous
ENTRYPOINT ["/opt/spark/bin/spark-submit", "--master", "local[*]", "/opt/brain/bronze_materialize.py"]
