"""
iceberg_base.py — the shared Spark + Iceberg-REST + MinIO foundation (Brain V4 Phase 0, Area B).

This is the base that lets ANY Spark job talk to the SAME local lakehouse (Iceberg REST catalog
over MinIO S3) with one identical catalog config. It is the seam every Silver/Gold job — plus the
Bronze maintenance/retention/erasure jobs — reuses, so the Iceberg-REST/MinIO wiring lives in
exactly ONE place.

History: this module was factored out (ADDITIVE, non-breaking) from the Spark-SS Bronze landing
job's session factory, which encoded this exact catalog config. Under ADR-0010 the Bronze writer is
the Kafka Connect Iceberg sink and the Spark-SS landing modules are DELETED — so `iceberg_base.
build_spark(...)` is now the ONE canonical Spark session factory for the whole fleet.

Config carried over from the retired Bronze landing factory (intentional — same catalog, same
warehouse, so the sweep to this factory changed nothing at the catalog level):
  - REST catalog (org.apache.iceberg.spark.SparkCatalog, type=rest) at ICEBERG_REST_URI
  - S3FileIO over MinIO (path-style, brain/brainbrain creds, us-east-1)
  - the deprecated-offset-fetching flag (harmless for batch; kept so a job that ALSO reads Kafka —
    e.g. a future streaming Silver — behaves exactly like the proven retired sink did)

Local substrate note: the single local Iceberg REST catalog (`rest`) has one physical warehouse
(s3://brain-bronze/ in compose), but Iceberg NAMESPACES are logical — brain_silver and brain_gold
are created as additional namespaces in that same catalog, so Spark can CREATE + MERGE Silver/Gold
tables in local-prod with no new bucket. In production the Terraform-provisioned Glue catalog gives
each medallion layer its own S3 bucket; the catalog/namespace names stay identical, so job code that
uses {CATALOG}.{namespace}.{table} is environment-portable.
"""
from __future__ import annotations  # PEP 563: the Spark image ships Python 3.8 — defer annotation
# evaluation so `str | None`, `list[str]`, `dict[str, str]` parse on 3.8 (they'd otherwise TypeError
# at import time). Pure type-hint sugar; no runtime behaviour change.

import math
import os
from datetime import timedelta

from pyspark.sql import SparkSession
from pyspark.sql.functions import abs as abs_, col, hash as hash_, lit

# The single REST catalog the local lakehouse exposes (compose `iceberg-rest`). Same catalog handle
# Bronze uses — namespaces (brain_bronze / brain_silver / brain_gold) live side-by-side inside it.
CATALOG = os.environ.get("ICEBERG_CATALOG", "rest")

# Medallion namespaces. Bronze already exists; Phase 0 provisions Silver + Gold (provision_silver_gold.py).
SILVER_NAMESPACE = os.environ.get("SILVER_NAMESPACE", "brain_silver")
GOLD_NAMESPACE = os.environ.get("GOLD_NAMESPACE", "brain_gold")


def spark_perf_configs() -> "dict[str, str]":
    """Production-grade, LOCAL-MODE Spark tuning shared by EVERY Brain session — all jobs build their
    session via build_spark below. (The retired Spark-SS Bronze streaming sinks used to duplicate this
    dict; they are gone under ADR-0010, so this is the single copy.)

    These all take effect in-session via SparkSession.builder.config(). Driver-JVM GC is deliberately
    NOT set here: in local mode the driver JVM is already running by the time Python builds the session,
    and Spark 3.5.3 ships JDK 17 whose default collector is already G1GC — so forcing -XX:+UseG1GC would
    be a no-op needing spark-submit-launch wiring for zero gain.

    Deliberately OMITS cluster-only knobs (spark.executor.*, dynamicAllocation, external shuffle service,
    YARN/K8s queues): Brain runs `--master local[*]`, so the driver IS the executor and those are no-ops
    — adding them would be dead config. Everything here is env-overridable; defaults stay within the
    documented container memory budget (docs/ops/local-memory-budget.md). Off-heap is env-GATED (default
    off) so the tuned budget is preserved; set SPARK_OFFHEAP_SIZE under a larger prod mem_limit to move
    shuffle/Iceberg buffers off the GC heap.
    """
    cfg: "dict[str, str]" = {
        # Kryo — faster + far less GC garbage than Java serialization (closures/broadcast/shuffle).
        # registrationRequired defaults false, so unregistered classes still serialize (correct, slightly
        # slower) — safe to enable fleet-wide.
        "spark.serializer": "org.apache.spark.serializer.KryoSerializer",
        "spark.kryoserializer.buffer.max": os.environ.get("SPARK_KRYO_BUFFER_MAX", "256m"),
        # AQE sizing: aim coalesced shuffle partitions at ~64MB (avoids both tiny-task overhead AND the
        # few-giant-partition write OOM); coalesce + skewJoin are enabled in build_spark. Cap the pre-AQE
        # shuffle count — 200 is wasteful for local single-JVM data; AQE coalesces anyway, this trims
        # scheduler overhead. Env-overridable for a real (clustered) prod with big shuffles.
        "spark.sql.adaptive.advisoryPartitionSizeInBytes": os.environ.get("SPARK_AQE_ADVISORY_BYTES", str(64 * 1024 * 1024)),
        "spark.sql.shuffle.partitions": os.environ.get("SPARK_SHUFFLE_PARTITIONS", "64"),
        # Shuffle I/O — compress spills + a larger write buffer cut syscalls on the spill path.
        "spark.shuffle.compress": "true",
        "spark.shuffle.spill.compress": "true",
        "spark.shuffle.file.buffer": os.environ.get("SPARK_SHUFFLE_FILE_BUFFER", "1m"),
        # Stability — bump the 120s default so a long GC pause or a slow Iceberg commit doesn't drop the
        # (local) executor or the Kafka consumer ("consumer poll timeout has expired" warnings on the sinks).
        # heartbeatInterval MUST stay < network.timeout.
        "spark.network.timeout": os.environ.get("SPARK_NETWORK_TIMEOUT", "300s"),
        "spark.executor.heartbeatInterval": os.environ.get("SPARK_HEARTBEAT_INTERVAL", "30s"),
        # S3A throughput to MinIO/S3 — Iceberg uses S3FileIO, but S3A still backs some Hadoop readers.
        "spark.hadoop.fs.s3a.connection.maximum": os.environ.get("SPARK_S3A_CONN_MAX", "64"),
        "spark.hadoop.fs.s3a.fast.upload": "true",
    }
    _off = os.environ.get("SPARK_OFFHEAP_SIZE", "").strip()
    if _off:
        cfg["spark.memory.offHeap.enabled"] = "true"
        cfg["spark.memory.offHeap.size"] = _off
    return cfg


def build_spark(app_name: str = "brain-iceberg") -> SparkSession:
    """A SparkSession wired to the local Iceberg REST catalog over MinIO — the fleet's ONE canonical
    session factory (ADR-0010: the retired Spark-SS Bronze landing factory it was factored from is gone).

    All wiring is env-overridable; dev defaults target the compose service names (iceberg-rest:8181,
    minio:9000). Pass a job-specific app_name for log/UI attribution.

    NOTE on helper-module distribution: jobs do `sys.path.insert(...)` so the shared helpers import on
    the DRIVER, but that does NOT reach Spark's Python WORKERS (separate executor processes). A job that
    uses a helper INSIDE a UDF — e.g. silver_order_state's `dq_violations_udf` from `_silver_technical`
    (the Stage-1 DQ gate) — then dies on the executor with `ModuleNotFoundError: No module named
    '_silver_technical'`. So after the session exists we `addPyFile` every shared helper, which ships it
    to the workers AND puts it on their PYTHONPATH. Idempotent + harmless for jobs that don't use them.
    """
    spark = (
        SparkSession.builder.appName(app_name)
        # Match the Bronze session: consumer-based offset fetching (harmless for pure-batch jobs;
        # keeps a future Kafka-reading Silver job behaving exactly like the proven Bronze sink).
        .config("spark.sql.streaming.kafka.useDeprecatedOffsetFetching", "true")
        # ── AQE everywhere (correctness-neutral; only changes the RUNTIME execution plan) ──────────────
        # Every Spark job in Brain (Silver/Gold transforms + the Bronze sinks) builds its session here, so
        # enabling Adaptive Query Execution at the source gives the WHOLE fleet runtime adaptivity for free:
        # coalesce small shuffle partitions, split skewed ones, and right-size joins based on ACTUAL data —
        # so a job handles a 10x data spike without a code change or a bigger heap. maxPartitionBytes caps
        # input split size so even a full scan streams in small tasks rather than a few giant ones (the
        # write-buffer OOM we hit). All env-overridable; results are identical with or without AQE.
        .config("spark.sql.adaptive.enabled", os.environ.get("SPARK_AQE_ENABLED", "true"))
        .config("spark.sql.adaptive.coalescePartitions.enabled", "true")
        .config("spark.sql.adaptive.skewJoin.enabled", "true")
        .config("spark.sql.files.maxPartitionBytes", os.environ.get("SPARK_MAX_PARTITION_BYTES", str(128 * 1024 * 1024)))
        .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions")
        .config(f"spark.sql.catalog.{CATALOG}", "org.apache.iceberg.spark.SparkCatalog")
        .config(f"spark.sql.catalog.{CATALOG}.type", "rest")
        .config(f"spark.sql.catalog.{CATALOG}.uri", os.environ.get("ICEBERG_REST_URI", "http://iceberg-rest:8181"))
        # One physical warehouse backs the local REST catalog; Silver/Gold are namespaces within it.
        # Overridable so a Glue-backed prod catalog (per-layer buckets) can point elsewhere.
        .config(f"spark.sql.catalog.{CATALOG}.warehouse", os.environ.get("ICEBERG_WAREHOUSE", os.environ.get("BRONZE_WAREHOUSE", "s3://brain-bronze/")))
        .config(f"spark.sql.catalog.{CATALOG}.io-impl", "org.apache.iceberg.aws.s3.S3FileIO")
    )
    # AUD-COST-022: the catalog's S3FileIO endpoint/credential wiring is CONDITIONAL on S3_ENDPOINT —
    # the same treatment as medallion_maintenance.py's S3A block (commit f0c8c3a8). Previously the
    # MinIO endpoint + the 'brain'/'brainbrain' static keys were unconditional DEFAULTS, and an
    # EMPTY-string S3_ENDPOINT passed straight through as a broken endpoint — under prod IRSA (EKS
    # CronWorkflows, no static keys) every job would fail, or send the dev MinIO creds to real S3.
    #   - S3_ENDPOINT set + non-empty (local compose / MinIO): custom endpoint + path-style + the
    #     static keys with their dev defaults — byte-identical to the old behavior (every local run
    #     script / compose sink exports S3_ENDPOINT=http://minio:9000).
    #   - S3_ENDPOINT unset/empty (prod): NO endpoint override and NO static keys, so S3FileIO falls
    #     back to the default AWS credential chain (WebIdentity/IRSA) against real S3.
    _s3_endpoint = (os.environ.get("S3_ENDPOINT") or "").strip()
    if _s3_endpoint:
        spark = (
            spark.config(f"spark.sql.catalog.{CATALOG}.s3.endpoint", _s3_endpoint)
            .config(f"spark.sql.catalog.{CATALOG}.s3.path-style-access", "true")
            .config(f"spark.sql.catalog.{CATALOG}.s3.access-key-id", os.environ.get("AWS_ACCESS_KEY_ID", "brain"))
            .config(f"spark.sql.catalog.{CATALOG}.s3.secret-access-key", os.environ.get("AWS_SECRET_ACCESS_KEY", "brainbrain"))
        )
    # Apply the shared production-grade perf tuning (Kryo / AQE sizing / shuffle / stability / S3A).
    for _k, _v in spark_perf_configs().items():
        spark = spark.config(_k, _v)
    spark = spark.getOrCreate()
    # Ship the shared Python helpers to executors so UDF closures can import them on the workers
    # (see the docstring). _base = db/iceberg/spark. We ship iceberg_base itself plus EVERY underscore-
    # prefixed shared module under silver/ and gold/ (e.g. _silver_technical, _raw_normalize,
    # _customer_360_enrich) — generic so a new helper used inside a UDF never re-triggers
    # ModuleNotFoundError on the workers. Per-file add is idempotent + best-effort.
    _base = os.path.dirname(os.path.abspath(__file__))
    _helpers = [os.path.join(_base, "iceberg_base.py")]
    for _sub in ("silver", "gold"):
        _dir = os.path.join(_base, _sub)
        if os.path.isdir(_dir):
            for _f in sorted(os.listdir(_dir)):
                # `_*.py` = shared helper modules (not the `silver_*`/`gold_*` job entrypoints, which are
                # spark-submitted directly and never imported by a UDF).
                if _f.startswith("_") and _f.endswith(".py") and not _f.endswith("_test.py"):
                    _helpers.append(os.path.join(_dir, _f))
    for _h in _helpers:
        if os.path.exists(_h):
            try:
                spark.sparkContext.addPyFile(_h)
            except Exception:  # noqa: BLE001 — re-adding the same file across getOrCreate reuse is non-fatal
                pass
    return spark


def ensure_namespace(spark: SparkSession, namespace: str, catalog: str = CATALOG) -> str:
    """Idempotently create an Iceberg namespace in the REST catalog and return its qualified name.

    Mirrors the Bronze `CREATE NAMESPACE IF NOT EXISTS` discipline — safe to re-run. Returns
    `{catalog}.{namespace}` so callers can compose table identifiers.
    """
    qualified = f"{catalog}.{namespace}"
    spark.sql(f"CREATE NAMESPACE IF NOT EXISTS {qualified}")
    return qualified


def create_iceberg_table(
    spark: SparkSession,
    namespace: str,
    table: str,
    columns_sql: str,
    *,
    partitioned_by: str | None = None,
    catalog: str = CATALOG,
    tblproperties: dict[str, str] | None = None,
) -> str:
    """Idempotently create a format-v2 Iceberg table — the shared DDL helper Silver/Gold jobs reuse.

    Mirrors the Bronze ensure_table contract (CREATE TABLE IF NOT EXISTS ... USING iceberg, format-v2,
    zstd parquet, upsert disabled so the MERGE path is append-only-on-no-match like Bronze). The
    caller supplies the column list and (optionally) a hidden-partitioning spec; brand_id-first
    tenant partitioning is the convention (e.g. "bucket(256, brand_id), days(occurred_at)").

    Returns the fully-qualified table name `{catalog}.{namespace}.{table}` for MERGE/INSERT callers.
    """
    ensure_namespace(spark, namespace, catalog)
    fqtn = f"{catalog}.{namespace}.{table}"

    props = {
        "format-version": "2",
        "write.format.default": "parquet",
        "write.parquet.compression-codec": "zstd",
        # Append-only-on-no-match, exactly like Bronze: idempotent MERGE WHEN NOT MATCHED, never an
        # in-place row rewrite via the upsert fast-path. Silver/Gold jobs that need updates issue an
        # explicit MERGE ... WHEN MATCHED THEN UPDATE.
        "write.upsert.enabled": "false",
    }
    if tblproperties:
        props.update(tblproperties)
    props_sql = ",\n          ".join(f"'{k}' = '{v}'" for k, v in props.items())

    partition_clause = f"\n        PARTITIONED BY ({partitioned_by})" if partitioned_by else ""

    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {fqtn} (
          {columns_sql}
        )
        USING iceberg{partition_clause}
        TBLPROPERTIES (
          {props_sql}
        )
        """
    )

    # Additive schema reconciliation. CREATE TABLE IF NOT EXISTS is a NO-OP against a pre-existing table,
    # so when a mart's column contract grows in a new release (e.g. PR #288 added aov_minor + the
    # Customer360 enrichment columns to gold_customer_360), the old table keeps its old shape and the
    # job's MERGE then dies with `UNRESOLVED_COLUMN: t.<new_col>`. Iceberg supports schema evolution, so
    # we diff the desired columns against the live table and ALTER TABLE ADD COLUMN the missing ones
    # (always nullable — you cannot add a NOT NULL column to a populated table without a default). This
    # makes EVERY Silver/Gold mart resilient to additive evolution instead of failing on drift. Existing
    # rows get NULL for the new column until the next refresh repopulates them — correct for a rebuildable
    # derived mart. Non-additive changes (type change, drop, rename) are intentionally NOT auto-applied.
    _reconcile_additive_columns(spark, fqtn, columns_sql)
    return fqtn


def _parse_column_defs(columns_sql: str) -> list[tuple[str, str]]:
    """Parse a CREATE-TABLE column list into [(name, type), …]. One column per line; the first token is
    the name, the rest (minus a trailing comma and any NOT NULL) is the Iceberg type. Types may contain
    commas (decimal(38,9)) so we split on NEWLINES, never commas. Pure/testable."""
    out: list[tuple[str, str]] = []
    for raw in columns_sql.splitlines():
        line = raw.strip().rstrip(",").strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        name, rest = parts[0], parts[1]
        col_type = rest.upper().replace("NOT NULL", "").strip().rstrip(",").strip()
        if name and col_type:
            out.append((name, col_type))
    return out


def _reconcile_additive_columns(spark: SparkSession, fqtn: str, columns_sql: str) -> None:
    """ALTER TABLE ADD COLUMN for every desired column absent from the live table (additive-only)."""
    desired = _parse_column_defs(columns_sql)
    if not desired:
        return
    try:
        existing = {f.name.lower() for f in spark.table(fqtn).schema.fields}
    except Exception:  # noqa: BLE001 — table just created/empty; nothing to reconcile
        return
    for name, col_type in desired:
        if name.lower() in existing:
            continue
        try:
            spark.sql(f"ALTER TABLE {fqtn} ADD COLUMN {name} {col_type}")
            print(f"[iceberg] reconciled {fqtn}: ADD COLUMN {name} {col_type}", flush=True)
        except Exception as exc:  # noqa: BLE001 — one bad column must not block the others / the job
            print(f"[iceberg] WARN could not add {name} {col_type} to {fqtn}: {exc}", flush=True)


# ── Entity-incremental watermark side-table ──────────────────────────────────────────────────────────
# A tiny shared table so entity-incremental jobs whose TARGET carries no ingested_at column (e.g.
# silver_touchpoint) can still watermark: it records the max SOURCE ingested_at each job has processed.
# One row per job_name. Generic + reusable across every fold/sessionization job.
_WATERMARK_TABLE = f"{CATALOG}.{os.environ.get('SILVER_NAMESPACE', 'brain_silver')}.silver_job_watermark"


def read_job_watermark(spark: "SparkSession", job_name: str):
    """The last SOURCE ingested_at this job processed, or None (first run / table absent → full pass)."""
    try:
        rows = spark.sql(
            f"SELECT last_ingested_at FROM {_WATERMARK_TABLE} WHERE job_name = '{job_name}'"
        ).collect()
        return rows[0]["last_ingested_at"] if rows else None
    except Exception:  # noqa: BLE001 — table not created yet → first run
        return None


def write_job_watermark(spark: "SparkSession", job_name: str, ts) -> None:
    """Upsert the job's watermark (max source ingested_at it processed). No-op when ts is None.
    Written AFTER a successful run so a crash mid-run never advances the watermark past unprocessed data."""
    if ts is None:
        return
    create_iceberg_table(
        spark, os.environ.get("SILVER_NAMESPACE", "brain_silver"), "silver_job_watermark",
        "job_name string NOT NULL, last_ingested_at timestamp, updated_at timestamp",
        partitioned_by=None,
    )
    ts_str = ts.strftime("%Y-%m-%d %H:%M:%S.%f")
    spark.sql(
        f"""
        MERGE INTO {_WATERMARK_TABLE} t
        USING (SELECT '{job_name}' AS job_name, TIMESTAMP '{ts_str}' AS last_ingested_at,
                      current_timestamp() AS updated_at) s
        ON t.job_name = s.job_name
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )


def run_entity_incremental(spark, *, table_name, source_fqtn, event_filter, entity_expr, fold_fn,
                           after_buckets_fn=None, view_name="bronze_events", time_col="ingested_at"):
    """Generic ENTITY-INCREMENTAL driver (the proven pattern from silver_order_state / silver_touchpoint).

    For jobs that FOLD/AGGREGATE many source events per entity (order_id, visitor, …) — where a time-window
    slice would regress the aggregate. It:
      1. reads the watermark (silver_job_watermark side-table) — the max SOURCE ingested_at last processed;
      2. finds the entities with NEW events since (watermark − overlap), or ALL for FULL_REFRESH/first run;
      3. adaptively HASH-BUCKETS them by entity (every event of an entity lands in ONE bucket — no driver
         collect), N adapting to the affected count;
      4. for each bucket: registers `bronze_events` = that bucket's entities' FULL event history, then calls
         fold_fn() (the job's unchanged fold + idempotent MERGE);
      5. advances the watermark ONLY after every bucket merged (a crash never skips data).

    Args (Columns are pyspark.sql Columns over the source):
      event_filter — bool Column selecting this job's source events (e.g. col('event_type').like('order.%')).
      entity_expr  — Column giving the entity id from the event (e.g. get_json_object(col('payload'), '$.properties.order_id')).
      fold_fn      — () -> None: the job's fold over the registered `bronze_events` view + its MERGE.
      after_buckets_fn — optional () -> None run once after all buckets (e.g. a dependent rebuild).
    Knobs (env): FULL_REFRESH, SILVER_INCREMENTAL_OVERLAP_HOURS (2), SILVER_BATCH_TARGET_ROWS (500000),
    SILVER_MAX_CHUNKS (48)."""
    full_refresh = os.environ.get("FULL_REFRESH", "").lower() in ("1", "true", "yes")
    overlap_hours = int(os.environ.get("SILVER_INCREMENTAL_OVERLAP_HOURS", "2"))
    wm = None if full_refresh else read_job_watermark(spark, table_name)

    bronze_all = spark.table(source_fqtn)
    src = bronze_all.where(event_filter)
    new_wm = src.selectExpr(f"max({time_col}) AS m").collect()[0]["m"]  # advance to here after success
    affected = src if wm is None else src.where(col(time_col) >= lit(wm - timedelta(hours=overlap_hours)))
    ents = affected.select(entity_expr.alias("_e")).where(col("_e").isNotNull() & (col("_e") != "")).distinct()
    ents.persist()
    n = ents.count()
    if n == 0:
        ents.unpersist()
        write_job_watermark(spark, table_name, new_wm)
        print(f"[{table_name}] ENTITY-INCREMENTAL: no entities with new events — 0 buckets", flush=True)
        if after_buckets_fn:
            after_buckets_fn()
        return

    target_per_bucket = max(1, int(os.environ.get("SILVER_BATCH_TARGET_ROWS", "500000")))
    max_chunks = max(1, int(os.environ.get("SILVER_MAX_CHUNKS", "48")))
    n_buckets = max(1, min(max_chunks, math.ceil(n / target_per_bucket)))
    print(
        f"[{table_name}] ENTITY-INCREMENTAL ({'FULL' if (full_refresh or wm is None) else 'delta'}): "
        f"{n} affected entit(y/ies) -> {n_buckets} adaptive bucket(s)",
        flush=True,
    )
    be = bronze_all.withColumn("_e", entity_expr)
    bucketed = be.join(ents.withColumnRenamed("_e", "_ae"), be["_e"] == col("_ae"), "left_semi")
    for b in range(n_buckets):
        one = bucketed if n_buckets == 1 else bucketed.where((abs_(hash_(col("_e"))) % lit(n_buckets)) == lit(b))
        one.drop("_e").createOrReplaceTempView(view_name)
        fold_fn()
    ents.unpersist()
    write_job_watermark(spark, table_name, new_wm)
    if after_buckets_fn:
        after_buckets_fn()
