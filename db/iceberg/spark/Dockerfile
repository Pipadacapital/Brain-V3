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
COPY bronze_materialize.py bronze_parity_check.py validate_bronze.py /opt/brain/

# Resolve + cache the runtime jars at build time, then place them on the default Spark classpath.
RUN set -eux; \
    /opt/spark/bin/spark-submit \
      --packages "org.apache.iceberg:iceberg-spark-runtime-3.5_${SCALA}:${ICEBERG_VERSION},org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION},org.apache.spark:spark-sql-kafka-0-10_${SCALA}:${SPARK_KAFKA_VERSION},org.postgresql:postgresql:${PG_JDBC_VERSION}" \
      --conf spark.jars.ivy=/tmp/ivy \
      --version; \
    find /tmp/ivy/jars -name '*.jar' -exec cp {} /opt/spark/jars/ \; ; \
    rm -rf /tmp/ivy

USER spark

# Default: stream collector.event.v1 → Iceberg Bronze. Override TRIGGER_MODE=availableNow for the
# periodic CronWorkflow shape, or the entrypoint script for the parity oracle.
ENV TRIGGER_MODE=continuous
ENTRYPOINT ["/opt/spark/bin/spark-submit", "--master", "local[*]", "/opt/brain/bronze_materialize.py"]
