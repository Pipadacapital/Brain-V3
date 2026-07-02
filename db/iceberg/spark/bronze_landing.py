"""
bronze_landing.py — Spark Structured Streaming: ONE unified raw Bronze landing.

Replaces the two split sinks (bronze_materialize.py → collector_events, bronze_raw_landing.py →
nine *_raw tables) with a SINGLE streaming job that subscribes to ALL Bronze topics (the collector
+ backfill lanes AND the nine connector `*.raw.v1` lanes) and appends every record into ONE Iceberg
table `brain_bronze.events`.

PURE RAW LANDING — no business logic (ADR: "Bronze is just an immutable raw landing zone"):
  - The full Kafka value is stored VERBATIM in `payload`. No normalization, clean, dedup-of-business-
    state, identity/stitch/sessionize, or attribution before Bronze.
  - CRUCIALLY, unlike the old bronze_materialize, this job DOES NOT apply the R2/R3 pixel admission gate
    (install_token→brand resolution + consent) or the SERVER_TRUSTED/LEDGER_ONLY split. That gate MOVED
    to Silver (silver_collector_event) so Bronze lands EVERYTHING raw and ungated. `brand_id` on a pixel
    row is the CLAIMED envelope brand (the derived-brand resolution now happens in Silver's gate).
  - The only columns lifted from the envelope are receipt/lineage + tenant partitioning keys; the body
    is untouched.

ONE table, TWO lane shapes co-located (a `connector` discriminator + nullable per-lane columns):
  - collector lane (topics *.collector.event.v1 / *.collector.order.backfill.v1): connector='collector';
    the CollectorEventV1 envelope scalars (event_id/brand_id/occurred_at/ingested_at/event_type/…) are
    lifted into columns so silver_collector_event reads them unchanged. `payload` is the raw ENVELOPE
    (post-pipeline canonical), not a provider API body.
  - raw lanes (the nine `*.raw.v1` topics): connector=<provider>; only the thin server-trusted envelope
    (brand_id/source/resource/trace) is lifted; `payload` is the verbatim provider API record.

PER-LANE DEDUP (one MERGE key, two disjoint key-spaces — prefixed so they never collide):
  - collector rows: dedup_key = 'evt:{brand_id}:{event_id}' (business idempotency — a re-pull emitting
    the same event_id dedups; a REPLAY on a new Kafka offset does NOT create a duplicate).
  - raw rows (and any malformed collector row missing event_id/brand_id): dedup_key =
    'raw:{topic}:{partition}:{offset}' (physical Kafka coordinate — globally unique).
  MERGE INTO events ON t.dedup_key = s.dedup_key WHEN NOT MATCHED THEN INSERT — append-only, idempotent.

NO DATA LOSS (offset-after-Iceberg-commit): identical contract to the two predecessors — Structured
Streaming commits a micro-batch's Kafka offsets to the checkpoint ONLY AFTER foreachBatch returns, i.e.
after the durable Iceberg MERGE. A crash re-reads the same offsets; the idempotent MERGE makes the
replay a no-op. `repair_incomplete_checkpoint` clears an empty trailing offsets/<id> from an unclean kill.

Two-phase startup (cold-start fix, mirrors both predecessors): TRIGGER_MODE=continuous drains the backlog
with Trigger.AvailableNow (bounded, BEST-EFFORT — connector lanes are routinely empty on cold start) then
resumes the SAME checkpoint as a long-lived processingTime stream. TRIGGER_MODE=availableNow (default)
drains once and exits (CI / Argo cron shape).

Bronze-path isolation: like the two predecessors this module imports NOTHING from iceberg_base — it
carries its own build_spark + perf config so a change there can never break the proven Bronze sink.
pyspark is imported LAZILY inside Spark-touching functions so the pure lane/topic/connector helpers below
stay unit-testable with plain python3 (no Spark install) — see bronze_landing_test.py.

Verify the module compiles: python3 -m py_compile db/iceberg/spark/bronze_landing.py
"""
from __future__ import annotations  # Spark image is Python 3.8.

import os

CATALOG = os.environ.get("ICEBERG_CATALOG", "rest")
NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
TABLE = f"{CATALOG}.{NAMESPACE}.events"

KAFKA_BROKERS = os.environ.get("KAFKA_BROKERS", "kafka:9092")
# Env-prefixed topic names (prod.* under local-prod / prod; dev.* in dev). MUST match the app.
TOPIC_ENV_PREFIX = os.environ.get("TOPIC_ENV_PREFIX", "prod")
# Collector + backfill lanes keep their explicit env overrides (parity with bronze_materialize).
COLLECTOR_TOPIC = os.environ.get("COLLECTOR_TOPIC", f"{TOPIC_ENV_PREFIX}.collector.event.v1")
BACKFILL_TOPIC = os.environ.get("BACKFILL_TOPIC", f"{TOPIC_ENV_PREFIX}.collector.order.backfill.v1")

# ── The nine connector raw lanes — (topic suffix) lifted VERBATIM from bronze_raw_landing.LANES. The
# connector discriminator is the provider = the FIRST segment of the suffix (shopify.orders.raw.v1 →
# 'shopify'). The collector lane's connector is the literal 'collector'. ──
RAW_LANE_SUFFIXES = [
    "shopify.orders.raw.v1",
    "woocommerce.orders.raw.v1",
    "meta.spend.raw.v1",
    "google.spend.raw.v1",
    "ga4.rows.raw.v1",
    "shiprocket.shipments.raw.v1",
    "gokwik.events.raw.v1",
    "shopflo.checkout.raw.v1",
    "razorpay.settlement.raw.v1",
]

STARTING_OFFSETS = os.environ.get("STARTING_OFFSETS", "earliest")
CHECKPOINT = os.environ.get("CHECKPOINT_LOCATION", "file:///tmp/bronze-landing-checkpoint")
TRIGGER_MODE = os.environ.get("TRIGGER_MODE", "availableNow")
PROCESSING_TIME = os.environ.get("PROCESSING_TIME", "15 seconds")
MAX_OFFSETS_PER_TRIGGER = os.environ.get("MAX_OFFSETS_PER_TRIGGER", "5000")
BRAND_BUCKETS = int(os.environ.get("EVENTS_BRAND_BUCKETS", "256"))

CONNECTOR_COLLECTOR = "collector"

# dedup_key prefixes — keep the business-key and physical-coordinate key-spaces DISJOINT in one MERGE.
DEDUP_PREFIX_EVT = "evt"  # evt:{brand_id}:{event_id}   — collector business idempotency
DEDUP_PREFIX_RAW = "raw"  # raw:{topic}:{partition}:{offset} — physical coordinate


# ──────────────────────────────────────────────────────────────────────────────────────────────────
# Pure helpers (Spark-free → unit-testable with plain python3). See bronze_landing_test.py.
# ──────────────────────────────────────────────────────────────────────────────────────────────────
def collector_topics() -> "list[str]":
    """The collector-lane topics (event + backfill)."""
    return [COLLECTOR_TOPIC, BACKFILL_TOPIC]


def raw_topics() -> "list[str]":
    """The nine env-prefixed connector raw-lane topics."""
    return [f"{TOPIC_ENV_PREFIX}.{suffix}" for suffix in RAW_LANE_SUFFIXES]


def all_topics() -> "list[str]":
    """Every topic the unified job subscribes to. `TOPICS` env (comma-separated) overrides."""
    override = os.environ.get("TOPICS", "").strip()
    if override:
        return [t.strip() for t in override.split(",") if t.strip()]
    return collector_topics() + raw_topics()


def connector_for(topic: str) -> str:
    """The `connector` discriminator for a topic. Collector lanes → 'collector'; a raw lane →
    the provider (first segment AFTER the env prefix), e.g. prod.shopify.orders.raw.v1 → 'shopify'.
    Pure/testable."""
    if topic in collector_topics():
        return CONNECTOR_COLLECTOR
    parts = topic.split(".")
    # env-prefixed: <prefix>.<provider>.<...>.raw.v1 → provider is index 1; be defensive.
    return parts[1] if len(parts) >= 2 else topic


def topic_to_connector() -> "dict[str, str]":
    """{topic: connector} for every subscribed topic. Pure/testable."""
    return {t: connector_for(t) for t in all_topics()}


# ──────────────────────────────────────────────────────────────────────────────────────────────────
# Spark
# ──────────────────────────────────────────────────────────────────────────────────────────────────
def _bronze_perf_configs() -> "dict[str, str]":
    """Production-grade local-mode perf tuning, DUPLICATED from iceberg_base.spark_perf_configs()
    (Bronze-path isolation — this module imports nothing from iceberg_base). Keep IN SYNC."""
    cfg = {
        "spark.serializer": "org.apache.spark.serializer.KryoSerializer",
        "spark.kryoserializer.buffer.max": os.environ.get("SPARK_KRYO_BUFFER_MAX", "256m"),
        "spark.sql.adaptive.enabled": os.environ.get("SPARK_AQE_ENABLED", "true"),
        "spark.sql.adaptive.coalescePartitions.enabled": "true",
        "spark.sql.adaptive.skewJoin.enabled": "true",
        "spark.sql.adaptive.advisoryPartitionSizeInBytes": os.environ.get("SPARK_AQE_ADVISORY_BYTES", str(64 * 1024 * 1024)),
        "spark.sql.shuffle.partitions": os.environ.get("SPARK_SHUFFLE_PARTITIONS", "64"),
        "spark.shuffle.compress": "true",
        "spark.shuffle.spill.compress": "true",
        "spark.shuffle.file.buffer": os.environ.get("SPARK_SHUFFLE_FILE_BUFFER", "1m"),
        "spark.network.timeout": os.environ.get("SPARK_NETWORK_TIMEOUT", "300s"),
        "spark.executor.heartbeatInterval": os.environ.get("SPARK_HEARTBEAT_INTERVAL", "30s"),
        "spark.hadoop.fs.s3a.connection.maximum": os.environ.get("SPARK_S3A_CONN_MAX", "64"),
        "spark.hadoop.fs.s3a.fast.upload": "true",
    }
    _off = os.environ.get("SPARK_OFFHEAP_SIZE", "").strip()
    if _off:
        cfg["spark.memory.offHeap.enabled"] = "true"
        cfg["spark.memory.offHeap.size"] = _off
    return cfg


def build_spark():
    from pyspark.sql import SparkSession  # noqa: E402 — lazy (keeps pure helpers Spark-free)

    builder = (
        SparkSession.builder.appName("bronze-landing")
        .config("spark.sql.streaming.kafka.useDeprecatedOffsetFetching", "true")
        .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions")
        .config(f"spark.sql.catalog.{CATALOG}", "org.apache.iceberg.spark.SparkCatalog")
        .config(f"spark.sql.catalog.{CATALOG}.type", "rest")
        .config(f"spark.sql.catalog.{CATALOG}.uri", os.environ.get("ICEBERG_REST_URI", "http://iceberg-rest:8181"))
        .config(f"spark.sql.catalog.{CATALOG}.warehouse", os.environ.get("BRONZE_WAREHOUSE", "s3://brain-bronze/"))
        .config(f"spark.sql.catalog.{CATALOG}.io-impl", "org.apache.iceberg.aws.s3.S3FileIO")
    )
    # AUD-COST-022: S3FileIO endpoint/creds CONDITIONAL on S3_ENDPOINT (same as medallion_maintenance
    # f0c8c3a8; duplicated in iceberg_base.build_spark — Bronze-path isolation, keep IN SYNC).
    # Set + non-empty (local MinIO) → old behavior verbatim; unset/empty (prod) → no endpoint, no
    # static keys, so S3FileIO uses the default AWS credential chain (WebIdentity/IRSA).
    _s3_endpoint = (os.environ.get("S3_ENDPOINT") or "").strip()
    if _s3_endpoint:
        builder = (
            builder.config(f"spark.sql.catalog.{CATALOG}.s3.endpoint", _s3_endpoint)
            .config(f"spark.sql.catalog.{CATALOG}.s3.path-style-access", "true")
            .config(f"spark.sql.catalog.{CATALOG}.s3.access-key-id", os.environ.get("AWS_ACCESS_KEY_ID", "brain"))
            .config(f"spark.sql.catalog.{CATALOG}.s3.secret-access-key", os.environ.get("AWS_SECRET_ACCESS_KEY", "brainbrain"))
        )
    for _k, _v in _bronze_perf_configs().items():
        builder = builder.config(_k, _v)
    return builder.getOrCreate()


# The unified column order — the SINGLE source of truth for the DDL, both projections, and the MERGE
# INSERT list. Nullable everywhere except the always-present receipt/dedup/lineage columns.
_COLUMNS = [
    "dedup_key", "connector",
    "brand_id", "event_id", "event_type", "occurred_at", "ingested_at", "correlation_id",
    "schema_name", "schema_version", "partition_key", "processing_flags", "collector_version",
    "source", "resource",
    "payload", "kafka_topic", "kafka_partition", "kafka_offset", "kafka_key", "kafka_timestamp",
    "received_at", "written_at", "trace_id",
]


def ensure_table(spark) -> None:
    """Create brain_bronze.events if absent — the unified superset schema. identity(connector) leads the
    partition spec (per-lane pruning/retention/erasure) then bucket(brand_id)+days(kafka_timestamp)."""
    spark.sql(f"CREATE NAMESPACE IF NOT EXISTS {CATALOG}.{NAMESPACE}")
    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
          dedup_key         string    NOT NULL,
          connector         string    NOT NULL,
          brand_id          string,
          event_id          string,
          event_type        string,
          occurred_at       timestamp,
          ingested_at       timestamp,
          correlation_id    string,
          schema_name       string,
          schema_version    int,
          partition_key     string,
          processing_flags  string,
          collector_version string,
          source            string,
          resource          string,
          payload           string    NOT NULL,
          kafka_topic       string    NOT NULL,
          kafka_partition   int       NOT NULL,
          kafka_offset      bigint    NOT NULL,
          kafka_key         string,
          kafka_timestamp   timestamp,
          received_at       timestamp NOT NULL,
          written_at        timestamp NOT NULL,
          trace_id          string
        )
        USING iceberg
        PARTITIONED BY (identity(connector), bucket({BRAND_BUCKETS}, brand_id), days(kafka_timestamp))
        TBLPROPERTIES (
          'format-version'                  = '2',
          'write.format.default'            = 'parquet',
          'write.parquet.compression-codec' = 'zstd',
          'write.upsert.enabled'            = 'false'
        )
        """
    )


def _trace_id_col(value_col):
    """trace_id = the traceparent/trace_id Kafka header, else the payload's trace/correlation ids."""
    from pyspark.sql.functions import coalesce, expr, get_json_object  # noqa: E402
    return coalesce(
        expr("try_cast(filter(headers, h -> h.key = 'traceparent')[0].value as string)"),
        expr("try_cast(filter(headers, h -> h.key = 'trace_id')[0].value as string)"),
        get_json_object(value_col, "$.trace_id"),
        get_json_object(value_col, "$.traceparent"),
        get_json_object(value_col, "$.correlation_id"),
    ).alias("trace_id")


def project_collector(batch_df):
    """Collector-lane rows → the unified schema. The CollectorEventV1 envelope scalars are lifted (so
    silver_collector_event reads them as columns), `payload` is the raw envelope. NO gate — brand_id is
    the CLAIMED envelope brand (Silver's gate resolves the derived brand). dedup_key = business key when
    present, else the physical coordinate (so a malformed/keyless row still lands uniquely, no loss)."""
    from pyspark.sql.functions import (  # noqa: E402
        coalesce, col, concat, current_timestamp, from_json, lit, to_timestamp, when,
    )
    from pyspark.sql.types import StringType, StructField, StructType

    envelope = StructType([
        StructField("event_id", StringType()),
        StructField("brand_id", StringType()),
        StructField("correlation_id", StringType()),
        StructField("event_name", StringType()),
        StructField("occurred_at", StringType()),
        StructField("ingested_at", StringType()),
    ])
    value = col("value").cast("string")
    e = col("e")
    parsed = batch_df.select(
        from_json(value, envelope).alias("e"),
        value.alias("payload"),
        col("topic").alias("kafka_topic"),
        col("partition").cast("int").alias("kafka_partition"),
        col("offset").cast("bigint").alias("kafka_offset"),
        col("key").cast("string").alias("kafka_key"),
        col("timestamp").alias("kafka_timestamp"),
        _trace_id_col(value),
    )
    brand = e["brand_id"]
    evid = e["event_id"]
    return parsed.select(
        when(
            evid.isNotNull() & brand.isNotNull(),
            concat(lit(DEDUP_PREFIX_EVT + ":"), brand, lit(":"), evid),
        ).otherwise(
            concat(lit(DEDUP_PREFIX_RAW + ":"), col("kafka_topic"), lit(":"), col("kafka_partition"), lit(":"), col("kafka_offset")),
        ).alias("dedup_key"),
        lit(CONNECTOR_COLLECTOR).alias("connector"),
        brand.alias("brand_id"),
        evid.alias("event_id"),
        e["event_name"].alias("event_type"),
        to_timestamp(e["occurred_at"]).alias("occurred_at"),
        coalesce(to_timestamp(e["ingested_at"]), current_timestamp()).alias("ingested_at"),
        e["correlation_id"].alias("correlation_id"),
        lit("brain.collector.event.v1").alias("schema_name"),
        lit(1).alias("schema_version"),
        concat(coalesce(brand, lit("")), lit(":"), coalesce(evid, lit(""))).alias("partition_key"),
        lit(None).cast("string").alias("processing_flags"),
        lit(None).cast("string").alias("collector_version"),
        lit(None).cast("string").alias("source"),
        lit(None).cast("string").alias("resource"),
        col("payload"),
        col("kafka_topic"),
        col("kafka_partition"),
        col("kafka_offset"),
        col("kafka_key"),
        col("kafka_timestamp"),
        current_timestamp().alias("received_at"),
        current_timestamp().alias("written_at"),
        col("trace_id"),
    )


def project_raw(batch_df, conn_map: "dict[str, str]"):
    """Raw connector-lane rows → the unified schema. Only the thin server-trusted envelope
    (brand_id/source/resource/trace) is lifted; `payload` is the verbatim provider record; the
    collector-only columns are NULL. dedup_key = physical Kafka coordinate. `connector` from the topic."""
    from pyspark.sql.functions import (  # noqa: E402
        col, concat, create_map, current_timestamp, element_at, get_json_object, lit,
    )

    value = col("value").cast("string")
    # topic → connector as a Spark map literal (built from the pure conn_map).
    map_args = []
    for _topic, _conn in conn_map.items():
        map_args += [lit(_topic), lit(_conn)]
    connector_col = element_at(create_map(*map_args), col("topic")) if map_args else lit(None).cast("string")
    return batch_df.select(
        concat(lit(DEDUP_PREFIX_RAW + ":"), col("topic"), lit(":"), col("partition").cast("int"), lit(":"), col("offset").cast("bigint")).alias("dedup_key"),
        connector_col.alias("connector"),
        get_json_object(value, "$.brand_id").alias("brand_id"),
        lit(None).cast("string").alias("event_id"),
        lit(None).cast("string").alias("event_type"),
        lit(None).cast("timestamp").alias("occurred_at"),
        lit(None).cast("timestamp").alias("ingested_at"),
        lit(None).cast("string").alias("correlation_id"),
        lit(None).cast("string").alias("schema_name"),
        lit(None).cast("int").alias("schema_version"),
        lit(None).cast("string").alias("partition_key"),
        lit(None).cast("string").alias("processing_flags"),
        lit(None).cast("string").alias("collector_version"),
        get_json_object(value, "$.source").alias("source"),
        get_json_object(value, "$.resource").alias("resource"),
        value.alias("payload"),
        col("topic").alias("kafka_topic"),
        col("partition").cast("int").alias("kafka_partition"),
        col("offset").cast("bigint").alias("kafka_offset"),
        col("key").cast("string").alias("kafka_key"),
        col("timestamp").alias("kafka_timestamp"),
        current_timestamp().alias("received_at"),
        current_timestamp().alias("written_at"),
        _trace_id_col(value),
    )


def land_factory(collector_topic_set: "set[str]", conn_map: "dict[str, str]"):
    """Build the foreachBatch sink: split the batch into collector vs raw topics, project each to the
    unified schema, union, dedup within-batch on dedup_key, then ONE idempotent MERGE into events."""
    from pyspark.sql.functions import col  # noqa: E402

    insert_cols = ", ".join(_COLUMNS)
    insert_vals = ", ".join(f"s.{c}" for c in _COLUMNS)

    def land(batch_df, _batch_id: int) -> None:
        batch_spark = batch_df.sparkSession
        is_collector = col("topic").isin(*collector_topic_set)
        collector_df = project_collector(batch_df.where(is_collector))
        raw_df = project_raw(batch_df.where(~is_collector), conn_map)
        unified = collector_df.unionByName(raw_df)
        unified.createOrReplaceTempView("bronze_landing_batch")
        # Within-batch dedup on dedup_key (a re-pull can emit the same business key twice; a topic can
        # theoretically re-deliver the same coordinate), then MERGE WHEN NOT MATCHED — append-only,
        # idempotent on replay. The two key-spaces are prefixed ('evt:'/'raw:') so they never collide.
        batch_spark.sql(
            f"""
            MERGE INTO {TABLE} t
            USING (
              SELECT * FROM (
                SELECT *, row_number() OVER (
                  PARTITION BY dedup_key ORDER BY coalesce(ingested_at, written_at) DESC
                ) AS rn FROM bronze_landing_batch
              ) WHERE rn = 1
            ) s
            ON t.dedup_key = s.dedup_key
            WHEN NOT MATCHED THEN INSERT ({insert_cols}) VALUES ({insert_vals})
            """
        )

    return land


def build_writer(spark, topics: "list[str]", collector_topic_set: "set[str]", conn_map: "dict[str, str]"):
    """A FRESH Kafka→events DataStreamWriter (subscribe ALL topics + foreachBatch + checkpoint). Returned
    un-started so the two-phase startup can start it twice on the SAME checkpoint (offsets carry over)."""
    raw = (
        spark.readStream.format("kafka")
        .option("kafka.bootstrap.servers", KAFKA_BROKERS)
        .option("subscribe", ",".join(topics))
        .option("startingOffsets", STARTING_OFFSETS)
        .option("failOnDataLoss", "false")
        .option("includeHeaders", "true")
        .option("maxOffsetsPerTrigger", MAX_OFFSETS_PER_TRIGGER)
        .load()
    )
    return (
        raw.writeStream
        .foreachBatch(land_factory(collector_topic_set, conn_map))
        .option("checkpointLocation", CHECKPOINT)
    )


def repair_incomplete_checkpoint(spark) -> None:
    """Self-heal a checkpoint left half-written by an unclean kill (the 'Incomplete log file' crash) —
    remove EMPTY trailing files from offsets/ and commits/ so Spark resumes from the last fully-committed
    batch. Safe (an empty metadata file carries no committed offset; re-reading is idempotent via the
    MERGE). Path-agnostic (file:// dev + s3a:// prod). Best-effort — never blocks startup. Verbatim from
    bronze_materialize.repair_incomplete_checkpoint."""
    try:
        jvm = spark._jvm
        hconf = spark._jsc.hadoopConfiguration()
        Path = jvm.org.apache.hadoop.fs.Path
        for sub in ("offsets", "commits"):
            d = Path(CHECKPOINT + "/" + sub)
            fs = d.getFileSystem(hconf)
            if not fs.exists(d):
                continue
            batches = []
            for st in fs.listStatus(d):
                name = st.getPath().getName()
                if name.isdigit():
                    batches.append((int(name), st))
            batches.sort(key=lambda b: b[0])
            for batch, st in reversed(batches):
                if st.getLen() == 0:
                    fs.delete(st.getPath(), False)
                    print(f"[bronze-landing] checkpoint repair: removed empty {sub}/{batch}", flush=True)
                else:
                    break
    except Exception as exc:  # noqa: BLE001 — never let a repair attempt block startup
        print(f"[bronze-landing] checkpoint repair skipped (non-fatal): {exc}", flush=True)


def main() -> None:
    spark = build_spark()
    spark.sparkContext.setLogLevel("WARN")
    repair_incomplete_checkpoint(spark)
    ensure_table(spark)

    topics = all_topics()
    collector_topic_set = set(collector_topics())
    conn_map = topic_to_connector()
    print(f"[bronze-landing] subscribing {len(topics)} topics → {TABLE}: {topics}", flush=True)

    if TRIGGER_MODE == "continuous":
        # Phase 1: BEST-EFFORT bounded drain (Trigger.AvailableNow). Some raw lanes are routinely empty on
        # a cold start; AvailableNow over a mix of empty + freshly-created topics trips a known Spark bug,
        # so on ANY failure fall through to phase 2 (SAME checkpoint → nothing lost, drains in bounded
        # steady-state batches). Mirrors bronze_raw_landing's guarded drain.
        print("[bronze-landing] phase 1/2 — draining backlog (availableNow, chunked)…", flush=True)
        try:
            drain = build_writer(spark, topics, collector_topic_set, conn_map).trigger(availableNow=True).start()
            drain.awaitTermination()
            print(f"[bronze-landing] phase 1/2 done — {TABLE} now has {spark.table(TABLE).count()} rows", flush=True)
        except Exception as e:  # noqa: BLE001 — degrade to continuous via the shared checkpoint
            print(
                f"[bronze-landing] phase 1/2 drain skipped ({type(e).__name__}: {e}); "
                "continuous stream will drain the backlog in bounded batches",
                flush=True,
            )
        print(f"[bronze-landing] phase 2/2 — continuous stream (every {PROCESSING_TIME})…", flush=True)
        live = build_writer(spark, topics, collector_topic_set, conn_map).trigger(processingTime=PROCESSING_TIME).start()
        live.awaitTermination()  # long-lived — never returns
    else:
        query = build_writer(spark, topics, collector_topic_set, conn_map).trigger(availableNow=True).start()
        query.awaitTermination()
        print(f"[bronze-landing] DONE — {TABLE} now has {spark.table(TABLE).count()} rows", flush=True)


if __name__ == "__main__":
    main()
