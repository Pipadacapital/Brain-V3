"""
_gold_base.py — the shared READ-Silver / WRITE-Gold MERGE helpers for the Brain V4 Phase-2 NET-NEW
gap Gold Spark jobs (GROUP "NEW gap Gold products": contribution_margin / logistics_performance /
cod_rto / settlement_summary / funnel / abandoned_cart / engagement / behavior / conversion_feedback /
campaign_performance).

These ten Gold marts have NO dbt predecessor (parity status=NEW — the matrix §3/4 GAP products). Each job
READS Iceberg brain_silver.<entity> (built in Phase 1/1b) and idempotently MERGEs into Iceberg
brain_gold.<mart> on the mart PK — the SAME append-only-on-no-match MERGE discipline as
bronze_materialize.py / _silver_base.py (write.upsert.enabled=false) plus an explicit WHEN MATCHED UPDATE
so a re-run over a growing Silver carries the latest rollup. ADDITIVE / dual-run / non-breaking: it
repoints NO reader, changes NO dbt model or app code, and writes ONLY into brain_gold.<these marts>.

WHY a thin shared module (non-breaking): the Silver→Gold READ wiring + the "recompute-the-rollup then
MERGE on the mart PK" shape is identical across all ten jobs. Factoring it here means each Gold job is
just (a) its Silver read SQL, (b) its money/credit math, (c) its mart PK + column contract. It imports
ONLY from iceberg_base (the Phase-0 seam) so it can never perturb Bronze, Silver or the dbt path.

HARD RULES honored by every caller (V4 rule 5):
  - brand_id is the tenant key, FIRST column on every row.
  - money is bigint MINOR units + a sibling currency_code (never a float / bare number); per-currency,
    NEVER blended across currencies.
  - largest-remainder rounding where the TS apportions (attribution credit must sum EXACTLY to the
    parent — no rounding drift; see largest_remainder_split below).
  - replay-safe: a Gold rollup is a FULL recompute from Silver each run, MERGE-UPDATE'd onto the PK →
    re-running over the same Silver is a no-op on identity and refreshes the latest rollup (never
    double-counts — the rollup is authoritative, not an incremental add).
"""
from __future__ import annotations  # Spark image is Python 3.8 — defer `str | None` annotation eval.

import os
import sys

# The shared Phase-0 base lives one directory up; add it to the path so a spark-submit of a file in
# gold/ (cwd=/opt/gold) can import iceberg_base from the mounted spark/ root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import DataFrame, SparkSession  # noqa: E402
from pyspark.sql.functions import abs as abs_, col, hash as hash_, lit  # noqa: E402

from iceberg_base import (  # noqa: E402
    CATALOG,
    GOLD_NAMESPACE,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
    read_job_watermark,
    write_job_watermark,
)
from job_log import JobMetrics, emit_job_log  # noqa: E402

# The metrics bag for the Gold job currently running through run_job(). merge_on_pk writes the
# brand-AGNOSTIC merge_upserted count into it without changing any caller's build(spark) signature.
# Module-level (one job per spark-submit process) — never shared across jobs.
_ACTIVE_METRICS: JobMetrics | None = None

# The Silver namespace these Gold jobs READ from (Iceberg-sole SoR, built Phase 1/1b).
SILVER_NS = os.environ.get("SILVER_NAMESPACE", SILVER_NAMESPACE)

# Re-export the catalog + Gold namespace so a Gold job that needs to address a sibling Gold table
# (e.g. gold_campaign_performance reading the optional gold_attribution_credit) imports them from here.
__all__ = [
    "CATALOG", "GOLD_NAMESPACE", "SILVER_NAMESPACE", "SILVER_NS",
    "silver", "silver_exists", "ensure_gold_table", "merge_on_pk", "run_job",
    "emit_cache_event", "gold_partition_filter",
]


# PARTITION-INCREMENTAL state (set by run_job's entity_incremental loop). When active, silver() returns a
# brand-FILTERED temp view of the requested Silver table (restricted to the current bucket's affected
# brands) instead of the raw FQTN — so EVERY Silver read in a mart's SQL is brand-scoped with no SQL
# change. None (default) → silver() returns the raw FQTN, byte-for-byte the legacy path.
_SPARK: "SparkSession | None" = None
_BRAND_BUCKET_VIEW: "str | None" = None


def silver(table: str) -> str:
    """Iceberg Silver source for a mart's SQL. Normally the FQTN rest.brain_silver.<table>. Under
    partition-incremental it returns a brand-filtered temp view (this bucket's affected brands only),
    registered on demand — so `FROM {silver('silver_x')}` becomes a bounded read with no mart change."""
    fqtn = f"{CATALOG}.{SILVER_NS}.{table}"
    if _BRAND_BUCKET_VIEW is None or _SPARK is None:
        return fqtn
    view = f"_inc_{table}"
    _SPARK.sql(
        f"CREATE OR REPLACE TEMPORARY VIEW {view} AS "
        f"SELECT * FROM {fqtn} WHERE brand_id IN (SELECT brand_id FROM {_BRAND_BUCKET_VIEW})"
    )
    return view


def silver_exists(spark: SparkSession, table: str) -> bool:
    """True iff the Silver source table exists (a job over an absent/empty Silver still writes an empty
    Gold mart — but a TOTALLY absent upstream table would raise; we probe so the job degrades gracefully).
    Probes the RAW table (not the filtered view) so it works before any bucket view is registered."""
    try:
        spark.table(f"{CATALOG}.{SILVER_NS}.{table}").schema
        return True
    except Exception:  # noqa: BLE001 — absent table → False (job writes an empty Gold mart, parity SKIPs)
        return False


def ensure_gold_table(spark: SparkSession, table: str, columns_sql: str, *, partitioned_by: str) -> str:
    """Create the brain_gold.<table> Iceberg table (brand_id-first, Bronze-parity props) if absent."""
    return create_iceberg_table(
        spark, GOLD_NAMESPACE, table, columns_sql, partitioned_by=partitioned_by
    )


def merge_on_pk(spark: SparkSession, fqtn: str, staged: DataFrame, pk: list[str]) -> None:
    """Idempotent MERGE of a fully-recomputed Gold rollup `staged` into `fqtn` on the mart PK.

    The rollup is already 1 row per PK (a GROUP BY upstream), so there is no in-batch dedup to do —
    MERGE: WHEN MATCHED UPDATE * (refresh the latest authoritative rollup), WHEN NOT MATCHED INSERT *.
    Replay-safe: a re-run over the same Silver yields identical rows.
    """
    staged.createOrReplaceTempView("_gold_stage")
    on_clause = " AND ".join(f"t.{c} = s.{c}" for c in pk)
    # Best-effort, brand-AGNOSTIC merge-upserted + rows_in signal for the structured job line. The Gold
    # staged rollup is already 1 row per PK, so its count IS the set of PKs the MERGE inserts-or-updates
    # AND the source-row signal for this recompute. No money/PII — counts only.
    if _ACTIVE_METRICS is not None:
        try:
            staged_n = spark.sql("SELECT COUNT(*) AS n FROM _gold_stage").collect()[0]["n"]
            _ACTIVE_METRICS.add_upserted(staged_n)
            _ACTIVE_METRICS.add_rows_in(staged_n)
        except Exception:  # noqa: BLE001 — observability must never break the merge
            pass
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING _gold_stage s
        ON {on_clause}
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )


def emit_cache_event(
    app_name: str,
    brand_ids: list[str] | None,
    reason: str,
    *,
    fqtn: str | None = None,
    rows_written: int | None = None,
) -> None:
    """Emit a structured gold.rewritten fact as a JSON log line (NO-OP-safe, opt-in).

    MECHANISM: prints ONE JSON line per brand_id to stdout — the SAME channel as
    emit_job_log (job_log.py). NO Kafka producer is introduced into the Spark job;
    no new dependency is added. The v4-refresh-loop (or any log shipper watching
    stdout) can pick this up and forward it to the BFF/Redis cache layer as a
    cache.invalidate.v1 event.

    The emitted line mirrors the gold.rewritten.v1 event contract:
      packages/contracts/src/events/cache.invalidate.v1.ts GoldRewrittenPayloadSchema.

    TENANT ISOLATION: one log line per brand_id. When brand_ids is None/empty (the
    brand-agnostic Spark job mode), a single line with brand_id=null is emitted — the
    downstream consumer MUST scope evictions to its own brand_id before touching Redis.
    A null brand_id in the log line is NOT a cross-tenant invalidation: it is an
    advisory log that the gateway interprets as "bust the whole product for any brand
    you hold a lock on" — never a global Redis FLUSHDB.

    NO-OP-safe: any exception inside this function is silenced — observability must
    NEVER break a job. Default off: existing run_job callers are NOT changed (default
    behavior is unchanged). Callers opt in by calling this after build_fn returns.

    CORRELATION: reuses V4_CORRELATION_ID from the environment (the same env var
    emit_job_log reads) so the cache event shares the refresh cycle's correlation id.

    Example (opt-in after build):
        def build(spark):
            fqtn, n = _my_build(spark)
            emit_cache_event("gold-funnel", brand_ids=None, reason="gold_rewritten", fqtn=fqtn)
            return fqtn, n
    """
    import json  # local import — json is stdlib, lightweight; keeps module-level imports minimal
    from datetime import datetime, timezone

    try:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        correlation_id = os.environ.get("V4_CORRELATION_ID") or None

        # Derive gold_product from the FQTN (strip catalog + namespace prefix), fall back to
        # app_name. Mirrors the job_log._split_fqtn pattern (avoids importing job_log here).
        gold_product: str = app_name
        if fqtn and isinstance(fqtn, str) and "." in fqtn:
            gold_product = fqtn.rsplit(".", 1)[-1]

        _rows = int(rows_written) if rows_written is not None else None

        def _make_line(bid: str | None) -> str:
            return json.dumps(
                {
                    "evt": "gold.rewritten",
                    "job": app_name,
                    "gold_product": gold_product,
                    "brand_id": bid,
                    "layer": "gold",
                    "rows_written": _rows,
                    # affected_scope: all=true is the safe default for a full Gold rewrite.
                    "affected_scope": {"all": True, "keys": [], "key_prefixes": []},
                    "reason": reason,
                    "correlation_id": correlation_id,
                    "ts": ts,
                },
                default=str,
            )

        if brand_ids:
            for bid in brand_ids:
                print(_make_line(bid), flush=True)
        else:
            # brand-agnostic advisory: brand_id=null. The downstream cache consumer MUST
            # scope any Redis eviction to brand-owned keys before acting on this line.
            print(_make_line(None), flush=True)

    except Exception:  # noqa: BLE001 — observability must never break the job
        pass


def _gold_entity_incremental(spark: SparkSession, app_name: str, build_fn, cfg: dict):
    """PARTITION-INCREMENTAL driver for Gold marts (partition = brand_id). cfg = {table_name,
    source_tables:[silver tables whose change makes a brand 'affected']}. Recompute only brands changed
    in ANY source since the watermark → adaptively hash-bucket brands → per bucket register `_brand_bucket`
    + activate silver() filtering → build_fn (its UNCHANGED rollup + merge_on_pk, now brand-scoped via
    silver()). Watermark (side-table) advanced after all buckets. Same MERGE as the full job → parity."""
    global _SPARK, _BRAND_BUCKET_VIEW
    import math
    from datetime import timedelta
    from functools import reduce

    table_name, sources = cfg["table_name"], cfg["source_tables"]
    target_fqtn = f"{CATALOG}.{GOLD_NAMESPACE}.{table_name}"
    full_refresh = os.environ.get("FULL_REFRESH", "").lower() in ("1", "true", "yes")
    overlap_hours = int(os.environ.get("SILVER_INCREMENTAL_OVERLAP_HOURS", "2"))
    wm = None if full_refresh else read_job_watermark(spark, table_name)

    # affected brands = union over every source of brand_id changed since (wm − overlap); watermark = max
    # source updated_at across all sources (advance only after success).
    brand_dfs, max_wms = [], []
    for st in sources:
        if not silver_exists(spark, st):
            continue
        s = spark.table(f"{CATALOG}.{SILVER_NS}.{st}")
        try:
            max_wms.append(s.selectExpr("max(updated_at) AS m").collect()[0]["m"])
        except Exception:  # noqa: BLE001 — source without updated_at can't watermark → treat as full
            max_wms.append(None)
        a = s if (wm is None or max_wms[-1] is None) else s.where(col("updated_at") >= lit(wm - timedelta(hours=overlap_hours)))
        brand_dfs.append(a.select("brand_id"))
    new_wm = max([w for w in max_wms if w is not None], default=None)

    if not brand_dfs:
        return target_fqtn, 0
    brands = reduce(lambda a, b: a.unionByName(b), brand_dfs).where(col("brand_id").isNotNull()).distinct()
    brands.persist()
    n_brands = brands.count()
    if n_brands == 0:
        brands.unpersist()
        write_job_watermark(spark, table_name, new_wm)
        try:
            n = spark.sql(f"SELECT COUNT(*) AS n FROM {target_fqtn}").collect()[0]["n"]
        except Exception:  # noqa: BLE001
            n = 0
        print(f"[{app_name}] PARTITION-INCREMENTAL: no brands changed — 0 buckets", flush=True)
        return target_fqtn, n

    target_per = max(1, int(os.environ.get("SILVER_BATCH_TARGET_ROWS", "500000")))
    max_chunks = max(1, int(os.environ.get("SILVER_MAX_CHUNKS", "48")))
    n_buckets = max(1, min(max_chunks, math.ceil(n_brands / target_per)))
    print(
        f"[{app_name}] PARTITION-INCREMENTAL ({'FULL' if (full_refresh or wm is None) else 'delta'}): "
        f"{n_brands} brand(s) -> {n_buckets} adaptive bucket(s)",
        flush=True,
    )
    _SPARK = spark
    fqtn, n = target_fqtn, 0
    try:
        for b in range(n_buckets):
            bucket = brands if n_buckets == 1 else brands.where((abs_(hash_(col("brand_id"))) % lit(n_buckets)) == lit(b))
            bucket.createOrReplaceTempView("_brand_bucket")
            _BRAND_BUCKET_VIEW = "_brand_bucket"
            fqtn, n = build_fn(spark)
    finally:
        _BRAND_BUCKET_VIEW = None
        _SPARK = None
    brands.unpersist()
    write_job_watermark(spark, table_name, new_wm)
    return fqtn, n


def gold_partition_filter(spark: SparkSession, df: DataFrame, *, table_name: str, source_tables: list,
                          brand_col: str = "brand_id"):
    """PARTITION-INCREMENTAL for DataFrame-API Gold marts (that can't use the silver()-view path).
    Restricts `df` to the brands changed in ANY source_table since the watermark (union; side-table
    watermark on updated_at; FULL_REFRESH/first-run → df unchanged). Returns (filtered_df, commit_fn) —
    call commit_fn() AFTER the MERGE succeeds so a mid-run crash never advances past unprocessed data.
    source_tables may be silver_* or gold_* (resolved to the right namespace)."""
    from datetime import timedelta
    from functools import reduce

    full_refresh = os.environ.get("FULL_REFRESH", "").lower() in ("1", "true", "yes")
    overlap_hours = int(os.environ.get("SILVER_INCREMENTAL_OVERLAP_HOURS", "2"))
    wm = None if full_refresh else read_job_watermark(spark, table_name)

    brand_dfs, max_wms = [], []
    for st in source_tables:
        ns = GOLD_NAMESPACE if st.startswith("gold_") else SILVER_NS
        try:
            s = spark.table(f"{CATALOG}.{ns}.{st}")
        except Exception:  # noqa: BLE001 — absent source contributes nothing
            continue
        try:
            max_wms.append(s.selectExpr("max(updated_at) AS m").collect()[0]["m"])
        except Exception:  # noqa: BLE001 — no updated_at → treat as full (all brands)
            max_wms.append(None)
        a = s if (wm is None or max_wms[-1] is None) else s.where(col("updated_at") >= lit(wm - timedelta(hours=overlap_hours)))
        brand_dfs.append(a.select(col("brand_id").alias("_pb")))
    new_wm = max([w for w in max_wms if w is not None], default=None)

    def commit() -> None:
        write_job_watermark(spark, table_name, new_wm)

    if wm is None or not brand_dfs:
        print(f"[{table_name}] PARTITION-INCREMENTAL: FULL (all brands)", flush=True)
        return df, commit
    brands = reduce(lambda a, b: a.unionByName(b), brand_dfs).where(col("_pb").isNotNull()).distinct()
    print(f"[{table_name}] PARTITION-INCREMENTAL: {brands.count()} changed brand(s)", flush=True)
    filtered = df.join(brands, df[brand_col] == brands["_pb"], "left_semi")
    return filtered, commit


def run_job(app_name: str, build_fn, *, entity_incremental: "dict | None" = None) -> None:
    """Standard entrypoint: build a Spark session, run build_fn(spark), emit ONE structured job line.

    build_fn keeps its existing `(fqtn, rows_out) = build(spark)` contract — merge_upserted/rows_in are
    captured transparently by merge_on_pk writing into the module-level _ACTIVE_METRICS bag set here.
    ADDITIVE: the legacy "[job] DONE — N rows" line is still printed.

    PARTITION-INCREMENTAL (opt-in): pass entity_incremental={table_name, source_tables:[...]} to recompute
    only the brands whose source Silver changed (build()/SQL unchanged — silver() brand-filters every read).
    Omit it (or FULL_REFRESH=1) → full recompute, the legacy path.
    """
    global _ACTIVE_METRICS
    import time

    spark = build_spark(app_name)
    spark.sparkContext.setLogLevel("WARN")
    _ACTIVE_METRICS = JobMetrics()
    started = time.monotonic()
    try:
        if entity_incremental is not None:
            fqtn, n = _gold_entity_incremental(spark, app_name, build_fn, entity_incremental)
        else:
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
