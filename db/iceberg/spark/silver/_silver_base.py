"""
_silver_base.py — the shared read/MERGE helpers for the Brain V4 Phase-1 NET-NEW canonical-entity
Spark Silver jobs (GROUP: payment, settlement, campaign, journey-entity, identity_alias).

These five entities have NO dbt predecessor (parity status=NEW). Each job reads raw Iceberg Bronze
(rest.brain_bronze.collector_events) for the relevant event_name(s), folds the would-be staging
transform inline, and idempotently MERGEs into rest.brain_silver.<entity> on the entity PK — the SAME
append-only-on-no-match MERGE discipline as bronze_materialize.py (write.upsert.enabled=false) plus an
explicit WHEN MATCHED UPDATE so a re-pull of the same key carries the latest-ingested version.

WHY a thin shared module (non-breaking): the Bronze→Silver READ wiring + the canonical
"dedup-in-batch then MERGE on PK" shape is identical across all five jobs. Factoring it here means each
entity job is just (a) its Bronze event filter, (b) its payload→column projection, (c) its PK. It imports
ONLY from iceberg_base (the Phase-0 seam) so it can never perturb Bronze or the dbt path. ADDITIVE/dual-run.

HARD RULES honored by every caller:
  - brand_id is the tenant key, FIRST column on every row.
  - money is bigint MINOR units + a sibling currency_code (never a float / bare number).
  - hashed-PII only — these jobs read payloads where the mapper already dropped raw PII (e.g. razorpay
    payment_id_hash / utr_hash); they NEVER re-derive or store a raw identifier.
  - replay-safe: MERGE on the entity PK with latest-ingested-wins → re-running over the same Bronze is a
    no-op (idempotent, I-E02 parity with Bronze).
"""
from __future__ import annotations  # Spark image is Python 3.8 — defer `str | None` annotation eval.

import math
import os
import sys
from datetime import timedelta

# The shared Phase-0 base lives one directory up; add it to the path so a spark-submit of a file in
# silver/ (cwd=/opt/silver) can import iceberg_base from the mounted spark/ root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import DataFrame, SparkSession  # noqa: E402
from pyspark.sql.functions import col, get_json_object, lit  # noqa: E402

from iceberg_base import CATALOG, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402
from job_log import JobMetrics, emit_job_log  # noqa: E402

# The metrics bag for the job currently running through run_job(). merge_on_pk + read_bronze_events
# write into it WITHOUT changing any caller's signature — so the structured per-job line carries the
# brand-AGNOSTIC rows_in + merge_upserted counts even though every build(spark) signature is unchanged.
# Module-level (one job per spark-submit process) — never shared across jobs.
_ACTIVE_METRICS: JobMetrics | None = None

# Set by run_job's incremental/adaptive loop to the current batch's [lo, hi) ingested_at window;
# read_bronze_events filters its read to it. None (default) → full read (legacy behavior, unchanged).
_CURRENT_WINDOW: "tuple | None" = None

# Bronze source (NEW-side read) — the raw Iceberg Bronze the operational reads use (Iceberg-sole SoR).
BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
BRONZE_TABLE = f"{CATALOG}.{os.environ.get('SILVER_NAMESPACE', 'brain_silver')}.silver_collector_event"  # ADR-0006 P3: gated source (R2/R3 now in Silver)


def read_bronze_events(spark: SparkSession, event_types: list[str]) -> DataFrame:
    """Read the raw Bronze rows for the given event_name(s).

    Returns the canonical Bronze columns plus `pj` (the payload string) for get_json_object extraction —
    the same `payload`-is-the-full-envelope contract the dbt staging models read (`parse_json(payload)`).
    brand_id/event_id/occurred_at/ingested_at are the Bronze idempotency + tenant keys.
    """
    in_list = ", ".join(f"'{e}'" for e in event_types)
    df = spark.sql(
        f"""
        SELECT brand_id, event_id, event_type, occurred_at, ingested_at, payload AS pj
        FROM {BRONZE_TABLE}
        WHERE event_type IN ({in_list})
        """
    )
    # INCREMENTAL + ADAPTIVE (opt-in): when run_job is driving a watermark/adaptive loop it sets
    # _CURRENT_WINDOW to the [lo, hi) ingested_at slice for THIS batch; we filter the read to it so the
    # job processes only that bounded slice. Unset (the default / legacy path) → no filter → full read,
    # byte-for-byte the prior behavior. The downstream MERGE is idempotent (latest-ingested-wins), so a
    # window overlap never double-counts.
    if _CURRENT_WINDOW is not None:
        _lo, _hi = _CURRENT_WINDOW
        if _lo is not None:
            df = df.where(col("ingested_at") >= lit(_lo))
        if _hi is not None:
            df = df.where(col("ingested_at") < lit(_hi))
    # Best-effort, brand-AGNOSTIC source-row signal for the structured job line. Cached so the count
    # does not re-scan Bronze when the build then consumes the same DataFrame.
    if _ACTIVE_METRICS is not None:
        try:
            _ACTIVE_METRICS.add_rows_in(df.cache().count())
        except Exception:  # noqa: BLE001 — observability must never break the read path
            pass
    return df


def prop(pj_col: str, path: str):
    """Extract payload.properties.<path> as a string — mirrors dbt get_json_string(pj,'$.properties.…')."""
    return get_json_object(col(pj_col), f"$.properties.{path}")


def merge_on_pk(
    spark: SparkSession,
    fqtn: str,
    staged: DataFrame,
    pk: list[str],
    *,
    order_by_desc: list[str],
) -> None:
    """Idempotent MERGE of `staged` into `fqtn` on the entity PK.

    Dedups within the batch first (a re-pull can emit the same PK twice) keeping the latest by
    `order_by_desc` (e.g. ingested_at DESC), then MERGE: WHEN MATCHED UPDATE * (carry the latest version),
    WHEN NOT MATCHED INSERT * — replay-safe, the Bronze MERGE discipline lifted to an entity grain.
    """
    staged.createOrReplaceTempView("_silver_stage")
    # Explicit column list (NOT *): the dedup window adds a transient _rn we must NOT carry into the
    # INSERT/UPDATE (the target table has no _rn column). Project the table's own columns back out.
    cols = ", ".join(staged.columns)
    on_clause = " AND ".join(f"t.{c} = s.{c}" for c in pk)
    part = ", ".join(pk)
    order = ", ".join(f"{c} DESC" for c in order_by_desc)
    deduped_sql = f"""
          SELECT {cols} FROM (
            SELECT *, row_number() OVER (PARTITION BY {part} ORDER BY {order}) AS _rn
            FROM _silver_stage
          ) WHERE _rn = 1
    """
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING (
        {deduped_sql}
        ) s
        ON {on_clause}
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    # Best-effort merge-upserted signal (rows the MERGE acted on this run = the deduped staged count).
    # Iceberg MERGE does not return an affected-row count; the post-dedup staged count is the exact set
    # of PKs the MERGE inserted-or-updated. Brand-AGNOSTIC, no money/PII.
    if _ACTIVE_METRICS is not None:
        try:
            _ACTIVE_METRICS.add_upserted(spark.sql(f"SELECT COUNT(*) AS n FROM ({deduped_sql})").collect()[0]["n"])
        except Exception:  # noqa: BLE001
            pass


def ensure_silver_table(spark: SparkSession, table: str, columns_sql: str, *, partitioned_by: str) -> str:
    """Create the brain_silver.<table> Iceberg table (brand_id-first, Bronze-parity props) if absent."""
    return create_iceberg_table(
        spark, SILVER_NAMESPACE, table, columns_sql, partitioned_by=partitioned_by
    )


def _incremental_windows(spark: SparkSession, target_fqtn: str):
    """Compute the list of [lo, hi) ingested_at windows build_fn should be run over.

    INCREMENTAL: lo starts at the target's max(ingested_at) minus a small overlap (the MERGE dedups the
    overlap), so only NEW source rows are processed — peak memory becomes O(new data), not O(history).
    FULL_REFRESH=1 (or a target with no ingested_at / empty target) → lo=None = process everything.
    ADAPTIVE: the [lo, source-max] range is split into N time-windows sized to ~SILVER_BATCH_TARGET_ROWS
    each (N adapts to the actual backlog: steady state → 1 small batch; a big backlog → many bounded
    batches), so a spike never builds one giant memory-heavy job. Returns [(None, None)] to mean
    "one full pass, unwindowed" (the legacy behavior) when there's nothing to bound.
    """
    full_refresh = os.environ.get("FULL_REFRESH", "").lower() in ("1", "true", "yes")
    overlap_hours = int(os.environ.get("SILVER_INCREMENTAL_OVERLAP_HOURS", "2"))
    target_rows = max(1, int(os.environ.get("SILVER_BATCH_TARGET_ROWS", "500000")))
    max_chunks = max(1, int(os.environ.get("SILVER_MAX_CHUNKS", "48")))

    wm = None
    if not full_refresh:
        try:
            wm = spark.sql(f"SELECT max(ingested_at) AS wm FROM {target_fqtn}").collect()[0]["wm"]
        except Exception:  # noqa: BLE001 — no ingested_at / table absent → full pass (safe)
            wm = None

    src = spark.table(BRONZE_TABLE)
    if wm is not None:
        src = src.where(col("ingested_at") >= lit(wm - timedelta(hours=overlap_hours)))
    rng = src.selectExpr("min(ingested_at) AS lo", "max(ingested_at) AS hi").collect()[0]
    lo_ts, hi_ts = rng["lo"], rng["hi"]
    if lo_ts is None:        # nothing new since the watermark → no work
        return []
    if hi_ts == lo_ts:       # single instant → one batch
        return [(lo_ts, None)]

    total = src.count()
    n_chunks = max(1, min(max_chunks, math.ceil(total / target_rows)))
    if n_chunks == 1:
        return [(lo_ts, None)]
    span = (hi_ts - lo_ts) / n_chunks
    windows = []
    for i in range(n_chunks):
        start = lo_ts + span * i
        end = None if i == n_chunks - 1 else lo_ts + span * (i + 1)  # last window unbounded → catches hi
        windows.append((start, end))
    return windows


def run_job(app_name: str, build_fn, *, target_table: "str | None" = None) -> None:
    """Standard entrypoint: build a Spark session, run build_fn(spark), emit ONE structured job line.

    build_fn keeps its existing `(fqtn, rows_out) = build(spark)` contract — the rows_in + merge_upserted
    signals are captured transparently by read_bronze_events + merge_on_pk writing into the module-level
    _ACTIVE_METRICS bag set here. ADDITIVE: the legacy "[job] DONE — N rows" line is still printed.

    INCREMENTAL + ADAPTIVE (opt-in, production-safe): pass target_table=<the job's Silver table name,
    the SAME string given to ensure_silver_table> to run build_fn once PER adaptive watermark window
    (read_bronze_events filters each batch to that window). Omit it (or set FULL_REFRESH=1) and build_fn
    runs exactly once over the full source — byte-for-byte the legacy path. Idempotent MERGE
    (latest-ingested-wins) makes the windowed runs replay-safe.
    """
    global _ACTIVE_METRICS, _CURRENT_WINDOW
    import time

    spark = build_spark(app_name)
    spark.sparkContext.setLogLevel("WARN")
    _ACTIVE_METRICS = JobMetrics()
    started = time.monotonic()
    target_fqtn = f"{CATALOG}.{SILVER_NAMESPACE}.{target_table}" if target_table else None
    try:
        windows = _incremental_windows(spark, target_fqtn) if target_fqtn else None

        if not windows and target_fqtn:
            # Incremental mode found nothing new — still emit a clean ok line (no-op run).
            fqtn = target_fqtn
            try:
                n = spark.sql(f"SELECT COUNT(*) AS n FROM {fqtn}").collect()[0]["n"]
            except Exception:  # noqa: BLE001
                n = 0
            print(f"[{app_name}] INCREMENTAL: no new source rows since watermark — 0 batches", flush=True)
        elif windows:
            print(
                f"[{app_name}] INCREMENTAL: {len(windows)} adaptive batch(es) "
                f"(~{os.environ.get('SILVER_BATCH_TARGET_ROWS', '500000')} rows/batch, "
                f"FULL_REFRESH={os.environ.get('FULL_REFRESH', '') or '0'})",
                flush=True,
            )
            fqtn, n = target_fqtn, 0
            for _w in windows:
                _CURRENT_WINDOW = _w
                fqtn, n = build_fn(spark)
            _CURRENT_WINDOW = None
        else:
            # Legacy path (no target_fqtn): single full run, unwindowed.
            fqtn, n = build_fn(spark)

        duration_ms = int((time.monotonic() - started) * 1000)
        emit_job_log(app_name, status="ok", rows_out=n, metrics=_ACTIVE_METRICS, fqtn=fqtn, duration_ms=duration_ms)
        print(f"[{app_name}] DONE — {fqtn} now has {n} rows", flush=True)
    except Exception as exc:  # noqa: BLE001 — emit a fail line, then re-raise (must still fail loudly)
        duration_ms = int((time.monotonic() - started) * 1000)
        emit_job_log(app_name, status="fail", metrics=_ACTIVE_METRICS, duration_ms=duration_ms, error=str(exc))
        raise
    finally:
        _ACTIVE_METRICS = None
        _CURRENT_WINDOW = None
