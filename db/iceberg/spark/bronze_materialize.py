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
(I-E02). Triggers: availableNow drains the current backlog once then exits (CI/spike). The live
"continuous" sink runs a two-phase startup — availableNow drain (bounded catch-up, no cold-start
deadlock) then a processingTime stream resuming the SAME checkpoint (steady-state only).

Run via spark-submit inside a Spark+Iceberg+Kafka image on the compose network — see
db/iceberg/spark/run-bronze-spike.sh and RB-4. All wiring is env-overridable; dev defaults
target the compose service names (iceberg-rest:8181, minio:9000, redpanda:9092).
"""
import os

from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    broadcast, coalesce, col, concat, current_timestamp, from_json, get_json_object, lit, to_timestamp,
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
# PROD: set CHECKPOINT_LOCATION to a durable s3a:// path (needs hadoop-aws on the classpath) so the
# streaming job resumes exactly-once across restarts.
CHECKPOINT = os.environ.get("CHECKPOINT_LOCATION", "file:///tmp/bronze-spike-checkpoint")
# TRIGGER_MODE: "availableNow" (default) drains the current backlog once and exits — the dev spike
# and the periodic Argo CronWorkflow shape. "continuous" runs a long-lived micro-batch stream every
# PROCESSING_TIME — the real-time Spark-on-K8s shape. Both use the same idempotent MERGE.
TRIGGER_MODE = os.environ.get("TRIGGER_MODE", "availableNow")
PROCESSING_TIME = os.environ.get("PROCESSING_TIME", "30 seconds")

# ── Bronze admission policy (ADR-0002 Slice 6) — mirrors the stream-worker's bronze consumers ──
# Spark MUST apply the SAME gating the PG writer (ProcessEventUseCase) does, else Iceberg Bronze
# would include events PG quarantines/never-writes (a compliance + parity regression):
#   - SERVER_TRUSTED_BRONZE: written with brand_id as-is (the enforce=false bronze bridges).
#   - LEDGER_ONLY: consumed by the ledger bridges, NEVER written to PG bronze → EXCLUDE from Iceberg.
#   - everything else = the PIXEL lane → R2 (install_token→brand) + R3 (consent_flags present).
# gokwik.awb_status.v1 + shiprocket.shipment_status.v1 are server-trusted AND ledger-fed (the
# order.live.v1 precedent): the ShipmentLedgerConsumer consumes them for cod_rto_clawback/
# cod_delivery_confirmed AND they are landed in Bronze so the rich shipment detail (status,
# terminal_class, pincode, courier) is preserved for silver_shipment (Slice 2, multi-source).
SERVER_TRUSTED_BRONZE = {"order.live.v1", "shopflo.checkout_abandoned.v1", "gokwik.rto_predict.v1", "gokwik.awb_status.v1", "shiprocket.shipment_status.v1"}
LEDGER_ONLY = {"settlement.live.v1", "spend.live.v1"}

# Postgres (for R2 install_token→brand resolution via pixel_installation). Read as the superuser
# (cross-brand, RLS-bypass — the same ETL-writer posture as the JDBC catalog) so all brands' tokens
# resolve. Mirrors resolve_brand_by_install_token (migration 0028) used by the stream-worker.
PG_JDBC_URL = os.environ.get("BRONZE_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain")
PG_USER = os.environ.get("BRONZE_PG_USER", "brain")
PG_PASSWORD = os.environ.get("BRONZE_PG_PASSWORD", "brain")

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


def load_pixel_installations(spark: SparkSession):
    """install_token → brand_id lookup for R2 (read once; a static side of the stream-static join).
    NOTE: read at job start — a new pixel_installation added later won't resolve until restart; a
    long-running prod job should refresh this periodically (or re-read per micro-batch)."""
    return (
        spark.read.format("jdbc")
        .option("url", PG_JDBC_URL)
        .option("user", PG_USER)
        .option("password", PG_PASSWORD)
        .option("driver", "org.postgresql.Driver")
        .option("query", "SELECT install_token::text AS install_token, brand_id::text AS derived_brand_id FROM pixel_installation")
        .load()
    )


def _project_bronze(df):
    """Final Bronze column projection (mirrors BronzeRow / 0016 / bronze_table.sql). Uses the
    already-resolved `brand_id` (claimed for server-trusted, derived for pixel)."""
    return df.select(
        col("event_id"),
        col("brand_id"),
        col("occurred_at"),
        col("ingested_at"),
        lit("brain.collector.event.v1").alias("schema_name"),
        lit(1).alias("schema_version"),
        col("event_type"),
        col("correlation_id"),
        concat(col("brand_id"), lit(":"), col("event_id")).alias("partition_key"),
        # payload: the full envelope JSON verbatim — downstream-EQUIVALENT to BronzeRow.payload
        # (both expose payload.event_name + payload.properties.*); parity is (brand_id, event_id)-based.
        col("payload"),
        lit(None).cast("string").alias("processing_flags"),
        lit(None).cast("string").alias("collector_version"),
    )


def gate_and_map(parsed, install_df):
    """Apply the Bronze admission policy (R2/R3 + lane split) then map to Bronze columns.
    Faithfully replicates the stream-worker's gating so Iceberg Bronze == the PG Bronze admission set."""
    e = col("e")
    base = (
        parsed.select(
            e["event_id"].alias("event_id"),
            e["brand_id"].alias("claimed_brand_id"),
            e["event_name"].alias("event_type"),
            to_timestamp(e["occurred_at"]).alias("occurred_at"),
            coalesce(to_timestamp(e["ingested_at"]), current_timestamp()).alias("ingested_at"),
            e["correlation_id"].alias("correlation_id"),
            get_json_object(col("raw"), "$.properties.install_token").alias("install_token"),
            # R3 signal: consent_flags PRESENT (object), not necessarily true — mirrors PG (absent → quarantine).
            get_json_object(col("raw"), "$.consent_flags").alias("consent_flags_raw"),
            col("raw").alias("payload"),
        )
        # Malformed (no idempotency key / no time) → never written, like PG.
        .where(col("event_id").isNotNull() & col("claimed_brand_id").isNotNull() & col("occurred_at").isNotNull())
        # Ledger-only events are not part of the PG Bronze set → exclude.
        .where(~col("event_type").isin(*LEDGER_ONLY))
    )

    # Server-trusted lane (enforce=false bridges): brand_id is already server-derived → trust it.
    server = base.where(col("event_type").isin(*SERVER_TRUSTED_BRONZE)).withColumn(
        "brand_id", col("claimed_brand_id")
    )

    # Pixel lane: R3 consent gate, then R2 — resolve brand from install_token; an INNER join drops
    # unresolved tokens (PG 'tenant_unresolved' quarantine), and the equality filter drops a claimed
    # brand_id that doesn't match the derived one (PG 'brand_mismatch' quarantine). brand_id = DERIVED.
    pixel = (
        base.where(~col("event_type").isin(*SERVER_TRUSTED_BRONZE))
        .where(col("consent_flags_raw").isNotNull())  # R3
        .join(broadcast(install_df), "install_token", "inner")  # R2: resolve (drop unresolved)
        .where(col("claimed_brand_id") == col("derived_brand_id"))  # R2: drop brand_mismatch
        .withColumn("brand_id", col("derived_brand_id"))
    )

    return _project_bronze(server).unionByName(_project_bronze(pixel))


def upsert_factory(_spark: SparkSession):
    def upsert(batch_df, _batch_id: int) -> None:
        # PARSE + GATE happen HERE, in the per-batch BATCH context — NOT in the streaming plan. A
        # stream-static join + union does not emit reliably under availableNow; inside foreachBatch the
        # batch DF has plain batch semantics, where the R2/R3 gate (proven in batch) works. We also
        # re-read pixel_installation per batch (fresh installs resolve; small broadcast table).
        batch_spark = batch_df.sparkSession
        install_df = load_pixel_installations(batch_spark)
        parsed = batch_df.select(
            from_json(col("value").cast("string"), ENVELOPE).alias("e"),
            col("value").cast("string").alias("raw"),
        )
        gated = gate_and_map(parsed, install_df)
        gated.createOrReplaceTempView("bronze_batch")
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


def build_writer(spark: SparkSession):
    """Build a FRESH Kafka→Bronze DataStreamWriter (read + foreachBatch + checkpoint).

    Returned un-started so the caller picks the trigger. A streaming query can only be started
    once, so the two-phase startup (drain → continuous) calls this twice — each phase gets its
    own query object reading the SAME checkpoint, so offsets carry over and nothing re-processes.
    """
    raw = (
        spark.readStream.format("kafka")
        .option("kafka.bootstrap.servers", KAFKA_BROKERS)
        .option("subscribe", TOPIC)
        .option("startingOffsets", STARTING_OFFSETS)
        .option("failOnDataLoss", "false")
        # Bound every micro-batch — the catch-up drain (Trigger.AvailableNow) honors this to split the
        # backlog into committed chunks, and steady-state is naturally small. Caps the cold-start batch.
        .option("maxOffsetsPerTrigger", os.environ.get("MAX_OFFSETS_PER_TRIGGER", "2000"))
        .load()
    )
    # Parse + R2/R3 gate + MERGE all happen inside foreachBatch (batch context) — see upsert_factory.
    return (
        raw.writeStream
        .foreachBatch(upsert_factory(spark))
        .option("checkpointLocation", CHECKPOINT)
    )


def main() -> None:
    spark = build_spark()
    spark.sparkContext.setLogLevel("WARN")
    ensure_table(spark)

    if TRIGGER_MODE == "continuous":
        # ── Two-phase startup — the cold-start fix (no native adaptive maxOffsetsPerTrigger). ──
        # A fresh long-lived processingTime query against an `earliest` backlog deadlocks on its
        # giant first micro-batch (the cold-start class of bug). Instead:
        #   Phase 1: Trigger.AvailableNow drains the CURRENT backlog in bounded chunks
        #            (honors maxOffsetsPerTrigger), commits each to Iceberg, then terminates.
        #   Phase 2: the live processingTime query resumes from the SAME checkpoint, so it only
        #            ever sees small steady-state batches — it NEVER faces a cold start.
        print("[bronze-sink] phase 1/2 — draining backlog (availableNow, chunked)…", flush=True)
        drain = build_writer(spark).trigger(availableNow=True).start()
        drain.awaitTermination()
        print(f"[bronze-sink] phase 1/2 done — {TABLE} now has {spark.table(TABLE).count()} rows", flush=True)

        print(f"[bronze-sink] phase 2/2 — starting continuous stream (every {PROCESSING_TIME})…", flush=True)
        live = build_writer(spark).trigger(processingTime=PROCESSING_TIME).start()
        live.awaitTermination()  # long-lived — never returns
    else:
        query = build_writer(spark).trigger(availableNow=True).start()
        query.awaitTermination()
        print(f"[bronze-spike] DONE — {TABLE} now has {spark.table(TABLE).count()} rows", flush=True)


if __name__ == "__main__":
    main()
