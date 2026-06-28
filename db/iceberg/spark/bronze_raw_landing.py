"""
bronze_raw_landing.py — Spark Structured Streaming: GENERIC raw landing for the CONNECTOR lanes.

ADR-0006 was originally landed by the Apache Iceberg **Kafka Connect** sink (one connector per
`*.raw.v1` lane → `brain_bronze.<lane>_raw`). The user is REVERTING to Spark-SS landing so there is
ONE compute (Spark) and no extra Connect infra. This job is the Spark-SS replacement: it consumes the
nine connector raw lanes and appends each provider record VERBATIM into its `*_raw` Bronze table with
ingestion metadata — exactly what the Connect sink did, minus the Connect worker.

What this job is — and is NOT:
  - It is a TRULY-RAW landing buffer. The provider payload is stored byte-for-byte (the Kafka value as a
    string) with ZERO business logic before Bronze: NO normalization, NO clean/dedup of business keys,
    NO identity/stitch/sessionize/consent gate/attribution. All of that stays in Spark Silver (ADR-0006
    D2/D3). Bronze stays raw, append-only, immutable, replayable — the system of truth.
  - The only "logic" applied is (a) lifting the server-trusted `brand_id` (+ source/resource/trace) out
    of the thin envelope into typed columns for tenant-first partitioning + isolation, and (b) attaching
    Kafka coordinates (topic/partition/offset/timestamp/key) + ingest clocks (received_at/written_at).
    The envelope `brand_id` is SERVER-TRUSTED on these connector lanes (MT-1: the connector authored it
    from the DB row, never from the provider body) — we trust it as-is, we do NOT resolve install_token.

No data loss (offset-after-Iceberg-commit): Structured Streaming commits a micro-batch's Kafka offsets to
the checkpoint ONLY AFTER `foreachBatch` returns — i.e. AFTER the Iceberg append/MERGE has durably
committed. A failed append throws, the batch is retried, the offset is NOT advanced. So an offset is
never committed ahead of its durable Iceberg write.

Idempotency (replay-safe, still raw): the append is a `MERGE ... WHEN NOT MATCHED` on the Kafka coordinate
`(topic, kafka_partition, kafka_offset)` — a globally-unique physical key, NOT a business key. Re-reading
the same offsets (replay / checkpoint reset) never double-writes. This keeps Bronze append-only + raw
while being safe to replay (the documented replay invariant).

Topology: ONE streaming query subscribes to ALL nine lanes' topics and, inside `foreachBatch`, routes each
record to its target `*_raw` table by Kafka `topic` (single checkpoint, single consumer group). Set
`LANE=<key>` to run a single lane instead (parameterized by topic + target table per the brief).

Two-phase startup mirrors bronze_materialize.py: TRIGGER_MODE=continuous drains the backlog with
Trigger.AvailableNow (bounded, no cold-start deadlock) then resumes the SAME checkpoint as a long-lived
processingTime stream. TRIGGER_MODE=availableNow (default) drains once and exits (CI / Argo cron shape).

Run via db/iceberg/spark/run-bronze-raw-landing.sh or the `spark-bronze-raw-sink` compose service.
Verify the module compiles: python3 -m py_compile db/iceberg/spark/bronze_raw_landing.py
"""
from __future__ import annotations  # Spark image is Python 3.8.

import os

# pyspark is imported LAZILY inside each Spark-touching function (mirrors _silver_technical.py /
# _raw_normalize.py) so the pure lane-config/routing helpers below stay unit-testable with plain
# python3 (no Spark install). Nothing at module load touches pyspark.

# ── The lane config table — the SOLE source of the lane → (topic suffix, *_raw table) mapping. ──
# Topic suffixes + target tables are LIFTED VERBATIM from the retired Kafka Connect sink configs
# (infra/kafka-connect/iceberg-bronze-*.json: `topics` and `iceberg.tables`). The collector/pixel lane
# is deliberately NOT here — it keeps its own gated Spark sink (bronze_materialize.py / collector_events),
# which is unchanged. The full topic is f"{TOPIC_ENV_PREFIX}.{suffix}" (prefix from NODE_ENV; prod.* in
# local-prod, matching spark-bronze-sink). Each value is (topic_suffix, target_table_name).
LANES = {
    "shopify_orders":       ("shopify.orders.raw.v1",       "shopify_orders_raw"),
    "woocommerce_orders":   ("woocommerce.orders.raw.v1",   "woocommerce_orders_raw"),
    "meta_spend":           ("meta.spend.raw.v1",           "meta_spend_raw"),
    "google_spend":         ("google.spend.raw.v1",         "google_spend_raw"),
    "ga4_rows":             ("ga4.rows.raw.v1",             "ga4_rows_raw"),
    "shiprocket_shipments": ("shiprocket.shipments.raw.v1", "shiprocket_shipments_raw"),
    "gokwik_events":        ("gokwik.events.raw.v1",        "gokwik_events_raw"),
    "shopflo_checkout":     ("shopflo.checkout.raw.v1",     "shopflo_checkout_raw"),
    "razorpay_settlement":  ("razorpay.settlement.raw.v1",  "razorpay_settlement_raw"),
}

CATALOG = os.environ.get("ICEBERG_CATALOG", "rest")
NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
KAFKA_BROKERS = os.environ.get("KAFKA_BROKERS", "localhost:9092")
# Topic prefix MUST match the app's NODE_ENV-derived prefix (prod.* under local-prod / prod). Kept
# overridable so dev (dev.*) and CI can point at their own lanes.
TOPIC_ENV_PREFIX = os.environ.get("TOPIC_ENV_PREFIX", "prod")
# LANE: empty/"all" → one stream over every lane, routed by topic in foreachBatch (the compose default).
# Set to a single LANES key to run just that lane (topic + target table parameterization, per the brief).
LANE = os.environ.get("LANE", "").strip()
STARTING_OFFSETS = os.environ.get("STARTING_OFFSETS", "earliest")
CHECKPOINT = os.environ.get("CHECKPOINT_LOCATION", "file:///tmp/bronze-raw-landing-checkpoint")
TRIGGER_MODE = os.environ.get("TRIGGER_MODE", "availableNow")
PROCESSING_TIME = os.environ.get("PROCESSING_TIME", "10 seconds")
MAX_OFFSETS_PER_TRIGGER = os.environ.get("MAX_OFFSETS_PER_TRIGGER", "5000")
# Partition: tenant-first bucket(brand_id) + days(kafka_timestamp), the ADR-0006 Bronze raw contract.
BRAND_BUCKETS = int(os.environ.get("RAW_BRAND_BUCKETS", "16"))


def active_lanes() -> dict:
    """The lanes this job will land — all of LANES, or the single LANE if set. Pure (testable)."""
    if LANE and LANE.lower() != "all":
        if LANE not in LANES:
            raise SystemExit(f"[bronze-raw] unknown LANE={LANE!r}; known: {sorted(LANES)}")
        return {LANE: LANES[LANE]}
    return dict(LANES)


def topic_for(suffix: str) -> str:
    """Full env-prefixed topic name for a lane suffix. Pure (testable)."""
    return f"{TOPIC_ENV_PREFIX}.{suffix}"


def fqtn(table: str) -> str:
    """Fully-qualified Iceberg table name for a lane's *_raw table. Pure (testable)."""
    return f"{CATALOG}.{NAMESPACE}.{table}"


def topic_to_table(lanes: dict) -> dict:
    """{full_topic: fqtn} routing map for foreachBatch. Pure (testable)."""
    return {topic_for(suffix): fqtn(table) for suffix, table in lanes.values()}


def build_spark():
    from pyspark.sql import SparkSession  # noqa: E402 — lazy (keeps pure helpers Spark-free)

    return (
        SparkSession.builder.appName("bronze-raw-landing")
        # Consumer-based offset fetching (not AdminClient describeTopics, which times out against a
        # single advertised listener) — the same path the app's kafkajs clients + the Spark sink use.
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


def ensure_table(spark, table_fqtn: str) -> None:
    """Create a raw landing table if absent. Schema is the THIN envelope columns + Kafka metadata +
    ingest clocks + the VERBATIM `payload` (the full provider record as a JSON string). No business
    columns — Silver derives those. brand_id is tenant-first; partition = bucket(brand_id)+days(ts)."""
    spark.sql(f"CREATE NAMESPACE IF NOT EXISTS {CATALOG}.{NAMESPACE}")
    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {table_fqtn} (
          brand_id        string,
          source          string,
          resource        string,
          topic           string    NOT NULL,
          kafka_partition int       NOT NULL,
          kafka_offset    bigint    NOT NULL,
          kafka_key       string,
          kafka_timestamp timestamp,
          received_at     timestamp NOT NULL,
          written_at      timestamp NOT NULL,
          trace_id        string,
          payload         string    NOT NULL
        )
        USING iceberg
        PARTITIONED BY (bucket({BRAND_BUCKETS}, brand_id), days(kafka_timestamp))
        TBLPROPERTIES (
          'format-version'                  = '2',
          'write.format.default'            = 'parquet',
          'write.parquet.compression-codec' = 'zstd',
          'write.upsert.enabled'            = 'false'
        )
        """
    )
    # Schema-drift guard. CREATE IF NOT EXISTS is a NO-OP against a pre-existing table, so a table left
    # over from an older landing implementation (e.g. the retired Kafka-Connect Iceberg sink, whose raw
    # schema was [connector_instance_id, fetched_at, order, …] with NO Kafka-coordinate columns) keeps
    # its legacy shape — and the foreachBatch MERGE then dies MID-STREAM with a cryptic
    # `UNRESOLVED_COLUMN: topic`. Detect that drift HERE, at startup, and fail loudly with the table name
    # and the remedy. Non-destructive by design: a streaming job must never silently drop a table that may
    # hold data — migration/drop is an explicit operator action.
    required = {"topic", "kafka_partition", "kafka_offset", "payload"}
    existing = {f.name for f in spark.table(table_fqtn).schema.fields}
    missing = required - existing
    if missing:
        raise RuntimeError(
            f"[bronze-raw] {table_fqtn} has a legacy/incompatible schema "
            f"(missing {sorted(missing)}; present {sorted(existing)}). It predates the canonical "
            f"Spark-SS raw envelope. Drop it (`DROP TABLE {table_fqtn}`) so it is recreated with the "
            f"correct schema, or migrate it, then restart the landing job."
        )


def project_raw(batch_df):
    """Map a raw Kafka micro-batch to the *_raw columns — VERBATIM payload + ingestion metadata.

    `brand_id`/`source`/`resource`/`trace_id` are lifted out of the thin server-trusted envelope so the
    table is tenant-partitionable + isolatable; `payload` is the full Kafka value untouched. trace_id
    prefers the Kafka `traceparent` header (injectKafkaTraceContext), falling back to envelope fields.
    NO normalization of the business body — that is Silver's job (ADR-0006)."""
    from pyspark.sql.functions import coalesce, col, current_timestamp, expr, get_json_object  # noqa: E402

    value = col("value").cast("string")
    return batch_df.select(
        # Server-trusted envelope fields (MT-1) — present on every connector lane record.
        get_json_object(value, "$.brand_id").alias("brand_id"),
        get_json_object(value, "$.source").alias("source"),
        get_json_object(value, "$.resource").alias("resource"),
        col("topic"),
        col("partition").cast("int").alias("kafka_partition"),
        col("offset").cast("bigint").alias("kafka_offset"),
        col("key").cast("string").alias("kafka_key"),
        col("timestamp").alias("kafka_timestamp"),
        # received_at = when this micro-batch consumed the record; written_at = when it lands in Iceberg.
        current_timestamp().alias("received_at"),
        current_timestamp().alias("written_at"),
        coalesce(
            # traceparent rides a Kafka header (binary) — decode the first matching header value.
            expr("try_cast(filter(headers, h -> h.key = 'traceparent')[0].value as string)"),
            get_json_object(value, "$.trace_id"),
            get_json_object(value, "$.traceparent"),
            get_json_object(value, "$.correlation_id"),
        ).alias("trace_id"),
        value.alias("payload"),
    )


def land_factory(routing: dict):
    """Build the foreachBatch sink. `routing` maps full_topic → target fqtn. Each micro-batch is split
    by topic and appended (idempotent MERGE on the Kafka coordinate) into the matching raw table."""

    from pyspark.sql.functions import col, lit  # noqa: E402 — lazy

    def land(batch_df, _batch_id: int) -> None:
        batch_spark = batch_df.sparkSession
        projected = project_raw(batch_df)
        # Route by topic so every record lands in ITS lane's table (single stream, many tables).
        for full_topic, target in routing.items():
            lane_df = projected.where(col("topic") == lit(full_topic))
            lane_df.createOrReplaceTempView("raw_batch")
            # Dedup within the batch on the Kafka coordinate, then MERGE WHEN NOT MATCHED — append-only,
            # idempotent on replay. The key is PHYSICAL (topic,partition,offset), never a business key,
            # so Bronze stays raw. The offset is committed by Spark only after this returns (no loss).
            batch_spark.sql(
                f"""
                MERGE INTO {target} t
                USING (
                  SELECT * FROM (
                    SELECT *, row_number() OVER (
                      PARTITION BY topic, kafka_partition, kafka_offset ORDER BY written_at DESC
                    ) AS rn FROM raw_batch
                  ) WHERE rn = 1
                ) s
                ON t.topic = s.topic AND t.kafka_partition = s.kafka_partition AND t.kafka_offset = s.kafka_offset
                WHEN NOT MATCHED THEN INSERT (
                  brand_id, source, resource, topic, kafka_partition, kafka_offset, kafka_key,
                  kafka_timestamp, received_at, written_at, trace_id, payload
                ) VALUES (
                  s.brand_id, s.source, s.resource, s.topic, s.kafka_partition, s.kafka_offset, s.kafka_key,
                  s.kafka_timestamp, s.received_at, s.written_at, s.trace_id, s.payload
                )
                """
            )

    return land


def build_writer(spark, topics: list, routing: dict):
    """A FRESH Kafka→raw-Bronze DataStreamWriter (read all lane topics + foreachBatch + checkpoint).
    Returned un-started so the caller picks the trigger (the two-phase startup starts it twice on the
    SAME checkpoint, so offsets carry over and nothing re-processes)."""
    raw = (
        spark.readStream.format("kafka")
        .option("kafka.bootstrap.servers", KAFKA_BROKERS)
        .option("subscribe", ",".join(topics))
        .option("startingOffsets", STARTING_OFFSETS)
        .option("failOnDataLoss", "false")
        .option("includeHeaders", "true")  # carry the traceparent header into Bronze
        .option("maxOffsetsPerTrigger", MAX_OFFSETS_PER_TRIGGER)
        .load()
    )
    return (
        raw.writeStream
        .foreachBatch(land_factory(routing))
        .option("checkpointLocation", CHECKPOINT)
    )


def main() -> None:
    spark = build_spark()
    spark.sparkContext.setLogLevel("WARN")
    lanes = active_lanes()
    routing = topic_to_table(lanes)
    topics = list(routing.keys())
    for target in routing.values():
        ensure_table(spark, target)
    print(f"[bronze-raw] landing {len(topics)} lane(s): {topics} → {list(routing.values())}", flush=True)

    if TRIGGER_MODE == "continuous":
        # Two-phase startup (the cold-start fix) — see bronze_materialize.py. Phase 1 drains the backlog
        # in bounded chunks (Trigger.AvailableNow) then terminates; phase 2 resumes the SAME checkpoint
        # as a live processingTime stream that only ever sees small steady-state batches.
        #
        # Phase 1 is BEST-EFFORT. Unlike the collector lane (always has a backlog), the connector raw
        # lanes are routinely EMPTY on a cold start (a brand that hasn't synced any connector yet) or
        # have data on only some of the nine topics. Trigger.AvailableNow over a mix of empty + freshly
        # created Kafka topics trips a known Spark bug — the prefetch enumerates all partitions but
        # latestOffset returns only the partitions that have data, so the sets disagree and the query
        # dies with "should provide the same topic partitions in pre-fetched offset to end offset". That
        # would crash-loop this sink in prod for any not-yet-synced brand. So: try the drain, and on ANY
        # failure fall through to phase 2. It is SAFE — phase 2 shares the SAME checkpoint and offsets
        # commit only after the durable Iceberg append, so a failed/partial phase 1 loses nothing; the
        # continuous stream re-evaluates partitions each micro-batch and processes the backlog in bounded
        # (maxOffsetsPerTrigger) steady-state batches.
        print("[bronze-raw] phase 1/2 — draining backlog (availableNow, chunked)…", flush=True)
        try:
            drain = build_writer(spark, topics, routing).trigger(availableNow=True).start()
            drain.awaitTermination()
            print("[bronze-raw] phase 1/2 done — starting continuous stream", flush=True)
        except Exception as e:  # noqa: BLE001 — degrade to continuous; phase 2 drains via shared checkpoint
            print(
                f"[bronze-raw] phase 1/2 drain skipped ({type(e).__name__}: {e}); "
                "continuous stream will drain the backlog in bounded batches",
                flush=True,
            )

        print(f"[bronze-raw] phase 2/2 — continuous stream (every {PROCESSING_TIME})…", flush=True)
        live = build_writer(spark, topics, routing).trigger(processingTime=PROCESSING_TIME).start()
        live.awaitTermination()  # long-lived — never returns
    else:
        query = build_writer(spark, topics, routing).trigger(availableNow=True).start()
        query.awaitTermination()
        for target in routing.values():
            print(f"[bronze-raw] DONE — {target} now has {spark.table(target).count()} rows", flush=True)


if __name__ == "__main__":
    main()
