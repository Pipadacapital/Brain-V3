"""
bronze_materialize.py — Spark Structured Streaming: collector.event.v1 → Iceberg Bronze.

ADR-0002 Slice 2 (write spike). Proves the target Bronze write path end-to-end against the
local lakehouse (Iceberg REST catalog + MinIO): read the live Redpanda topic, parse the
CollectorEventV1 envelope, and idempotently MERGE into the Iceberg Bronze table with the
canonical partition spec (bucket(16, brand_id) + days(occurred_at)).

This is the dev validation of the Slice 3 production writer. It does NOT touch the live
Postgres bronze_events path — it is a parallel, additive consumer (its own group/checkpoint).

Idempotency: MERGE INTO ... ON (brand_id, event_id) WHEN NOT MATCHED THEN INSERT. Re-running
over the same offsets (with a fresh checkpoint) never double-writes — the replay invariant
(I-E02). Trigger = availableNow: drain the current backlog once, then exit (CI/spike friendly).

Run via spark-submit inside a Spark+Iceberg+Kafka image on the compose network — see
db/iceberg/spark/run-bronze-spike.sh and RB-4. All wiring is env-overridable; dev defaults
target the compose service names (iceberg-rest:8181, minio:9000, redpanda:9092).
"""
import os

from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    coalesce, col, concat, current_timestamp, from_json, lit, to_timestamp,
)
from pyspark.sql.types import StringType, StructField, StructType

CATALOG = os.environ.get("ICEBERG_CATALOG", "rest")
NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
TABLE = f"{CATALOG}.{NAMESPACE}.collector_events"
KAFKA_BROKERS = os.environ.get("KAFKA_BROKERS", "redpanda:9092")
TOPIC = os.environ.get("COLLECTOR_TOPIC", "dev.collector.event.v1")
STARTING_OFFSETS = os.environ.get("STARTING_OFFSETS", "earliest")
# Local checkpoint by default — keeps the spike free of the Hadoop S3A connector (Iceberg data
# still lands in MinIO via S3FileIO). Clear it to re-process the backlog for an idempotency re-run.
CHECKPOINT = os.environ.get("CHECKPOINT_LOCATION", "file:///tmp/bronze-spike-checkpoint")

# The CollectorEventV1 envelope — ONLY the scalar fields we map to Bronze columns. The nested
# objects (properties / consent_flags) are deliberately NOT in this schema: typing an object as
# a string makes from_json null the whole record. The full envelope is preserved verbatim in
# `payload` (the raw Kafka value), which is lossless; Slice 3 aligns payload to BronzeRow exactly.
ENVELOPE = StructType([
    StructField("event_id", StringType()),
    StructField("brand_id", StringType()),
    StructField("correlation_id", StringType()),
    StructField("event_name", StringType()),
    StructField("occurred_at", StringType()),
    StructField("ingested_at", StringType()),
])


def build_spark() -> SparkSession:
    return (
        SparkSession.builder.appName("bronze-materialize-spike")
        # Use consumer-based offset fetching (not the AdminClient describeTopics path, which times
        # out against Redpanda's single advertised listener) — the same consumer path the
        # stream-worker uses successfully.
        .config("spark.sql.streaming.kafka.useDeprecatedOffsetFetching", "true")
        .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions")
        .config(f"spark.sql.catalog.{CATALOG}", "org.apache.iceberg.spark.SparkCatalog")
        .config(f"spark.sql.catalog.{CATALOG}.type", "rest")
        .config(f"spark.sql.catalog.{CATALOG}.uri", os.environ.get("ICEBERG_REST_URI", "http://iceberg-rest:8181"))
        .config(f"spark.sql.catalog.{CATALOG}.warehouse", os.environ.get("BRONZE_WAREHOUSE", "s3://brain-bronze/"))
        .config(f"spark.sql.catalog.{CATALOG}.io-impl", "org.apache.iceberg.aws.s3.S3FileIO")
        .config(f"spark.sql.catalog.{CATALOG}.s3.endpoint", os.environ.get("S3_ENDPOINT", "http://minio:9000"))
        .config(f"spark.sql.catalog.{CATALOG}.s3.path-style-access", "true")
        .config(f"spark.sql.catalog.{CATALOG}.s3.access-key-id", os.environ.get("AWS_ACCESS_KEY_ID", "brain"))
        .config(f"spark.sql.catalog.{CATALOG}.s3.secret-access-key", os.environ.get("AWS_SECRET_ACCESS_KEY", "brainbrain"))
        .getOrCreate()
    )


def ensure_table(spark: SparkSession) -> None:
    """Create the Bronze namespace + table if absent — canonical DDL (db/iceberg/bronze_table.sql)."""
    spark.sql(f"CREATE NAMESPACE IF NOT EXISTS {CATALOG}.{NAMESPACE}")
    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
          event_id          string  NOT NULL,
          brand_id          string  NOT NULL,
          occurred_at       timestamp NOT NULL,
          ingested_at       timestamp NOT NULL,
          schema_name       string  NOT NULL,
          schema_version    int     NOT NULL,
          event_type        string  NOT NULL,
          correlation_id    string  NOT NULL,
          partition_key     string  NOT NULL,
          payload           string  NOT NULL,
          processing_flags  string,
          collector_version string
        )
        USING iceberg
        PARTITIONED BY (bucket(16, brand_id), days(occurred_at))
        TBLPROPERTIES (
          'format-version'                  = '2',
          'write.format.default'            = 'parquet',
          'write.parquet.compression-codec' = 'zstd',
          'write.upsert.enabled'            = 'false'
        )
        """
    )


def to_bronze(parsed):
    """Map a parsed envelope row to the Bronze table columns (mirrors BronzeRow / 0016 / bronze_table.sql)."""
    e = col("e")
    return (
        parsed.select(
            e["event_id"].alias("event_id"),
            e["brand_id"].alias("brand_id"),
            to_timestamp(e["occurred_at"]).alias("occurred_at"),
            coalesce(to_timestamp(e["ingested_at"]), current_timestamp()).alias("ingested_at"),
            lit("brain.collector.event.v1").alias("schema_name"),
            lit(1).alias("schema_version"),
            e["event_name"].alias("event_type"),
            e["correlation_id"].alias("correlation_id"),
            concat(e["brand_id"], lit(":"), e["event_id"]).alias("partition_key"),
            # payload: the full envelope JSON verbatim (lossless, no raw PII — the collector already
            # hashed identifiers). Slice 3 aligns this to the stream-worker BronzeRow.payload shape.
            col("raw").alias("payload"),
            lit(None).cast("string").alias("processing_flags"),
            lit(None).cast("string").alias("collector_version"),
        )
        # Drop envelopes missing the idempotency key or required time (malformed → never written).
        .where(col("event_id").isNotNull() & col("brand_id").isNotNull() & col("occurred_at").isNotNull())
    )


def upsert_factory(_spark: SparkSession):
    def upsert(batch_df, _batch_id: int) -> None:
        # In foreachBatch the batch DataFrame belongs to a cloned session — register the view and run
        # the MERGE on THAT session, not the captured outer one (else UnresolvedRelation).
        batch_spark = batch_df.sparkSession
        batch_df.createOrReplaceTempView("bronze_batch")
        # Dedup within the micro-batch first (a re-pull can emit the same (brand_id,event_id) twice),
        # then MERGE WHEN NOT MATCHED — append-only, idempotent (I-E02 / I-ST04).
        batch_spark.sql(
            f"""
            MERGE INTO {TABLE} t
            USING (
              SELECT * FROM (
                SELECT *, row_number() OVER (
                  PARTITION BY brand_id, event_id ORDER BY ingested_at DESC
                ) AS rn FROM bronze_batch
              ) WHERE rn = 1
            ) s
            ON t.brand_id = s.brand_id AND t.event_id = s.event_id
            WHEN NOT MATCHED THEN INSERT (
              event_id, brand_id, occurred_at, ingested_at, schema_name, schema_version,
              event_type, correlation_id, partition_key, payload, processing_flags, collector_version
            ) VALUES (
              s.event_id, s.brand_id, s.occurred_at, s.ingested_at, s.schema_name, s.schema_version,
              s.event_type, s.correlation_id, s.partition_key, s.payload, s.processing_flags, s.collector_version
            )
            """
        )
    return upsert


def main() -> None:
    spark = build_spark()
    spark.sparkContext.setLogLevel("WARN")
    ensure_table(spark)

    raw = (
        spark.readStream.format("kafka")
        .option("kafka.bootstrap.servers", KAFKA_BROKERS)
        .option("subscribe", TOPIC)
        .option("startingOffsets", STARTING_OFFSETS)
        .option("failOnDataLoss", "false")
        .load()
    )
    parsed = raw.select(
        from_json(col("value").cast("string"), ENVELOPE).alias("e"),
        col("value").cast("string").alias("raw"),
    )
    bronze = to_bronze(parsed)

    query = (
        bronze.writeStream
        .foreachBatch(upsert_factory(spark))
        .option("checkpointLocation", CHECKPOINT)
        .trigger(availableNow=True)
        .start()
    )
    query.awaitTermination()

    total = spark.table(TABLE).count()
    print(f"[bronze-spike] DONE — {TABLE} now has {total} rows", flush=True)


if __name__ == "__main__":
    main()
