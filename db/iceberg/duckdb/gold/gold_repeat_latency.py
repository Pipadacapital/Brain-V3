"""
gold_repeat_latency.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_repeat_latency.py.

Time-to-2nd-purchase RETENTION LATENCY (Brain V4 Phase 2, "NEW gap Gold products", NO dbt predecessor).
Per brand, the DISTRIBUTION of INTEGER DAYS between each customer's FIRST and SECOND order: the
median days-to-2nd-order scalar (denormalized on every bucket row) + a fixed six-bucket histogram.

SOURCE : {CATALOG}.brain_silver.silver_order_state read DIRECTLY (not the gated keystone) — the
  per-(brand_id, order_id) canonical order spine, brain_id-keyed to the resolved customer, with
  first_event_at = when the order first appeared. Ranking orders per (brand_id, brain_id) by
  (first_event_at, order_id) yields each customer's 1st and 2nd order; the day-gap between them is the
  latency. Reuses the framework's ensure_table / merge_on_pk / run_job.

GRAIN : exactly SIX rows per brand that has >=1 ordering customer (0-7 / 8-14 / 15-30 / 31-60 / 61-90 /
  90+ days), INCLUDING zero-count buckets. PK = (brand_id, bucket_key). The brand-level scalars
  (median_days_to_second_purchase, second/single/total_customers) are DENORMALIZED identically onto all
  six bucket rows so the Wire slice is a single Iceberg table + single Trino view.

THE TRANSFORM (deterministic INTEGER DAY MATH — NO money, NO float, NO currency_code):
  1. orders    = silver_order_state rows with a brand_id + brain_id + first_event_at (one row/order).
  2. ranked    = ROW_NUMBER() OVER (PARTITION BY brand_id, brain_id ORDER BY order_at, order_id).
  3. first_two = per customer, the 1st (rn=1) and 2nd (rn=2) order timestamp.
  4. latency   = day-gap(first, second) for returners (second_at IS NOT NULL), GREATEST(...,0)-guarded.
  5. scalars   = per brand: median = CAST(quantile_cont(days_to_second, 0.5) AS bigint) [the EXACT
                 linear-interpolated median of an integer day series, stored as a bigint — DuckDB's
                 quantile_cont is the analogue of Spark/Hive percentile(x,0.5)]; second/single/total are
                 pure COUNTs.
  6. buckets   = each returner bucketed into the six fixed ranges, LEFT-joined onto the full
                 six-bucket × brand grid so every brand emits all six rows (zero-count buckets included).

DAY-GAP PARITY: Spark `datediff(second_at, first_at)` returns the whole-DAY-BOUNDARY difference (a
  calendar-day crossing count, not a 24h-quotient). DuckDB's `date_diff('day', first_at, second_at)` is
  the same calendar-day-boundary difference → identical integer day counts. Both endpoints are pinned to
  UTC (AT TIME ZONE 'UTC') to match Spark's UTC-instant convention before the day-boundary math.

MEDIAN PARITY: `quantile_cont(x, 0.5)` == Hive/Spark `percentile(x, 0.5)` (both linear-interpolated over
  the integer day series); CAST(... AS BIGINT) truncates toward zero on both engines.

BUCKET BOUNDARIES (inclusive, non-overlapping): 0-7:[0,7] 8-14:[8,14] 15-30:[15,30] 31-60:[31,60]
  61-90:[61,90] 90+:[91,∞). Σ bucket_customers == second_order_customers.

REPLAY-SAFE: full recompute from Silver each run, idempotent MERGE-UPDATE on the (brand_id, bucket_key)
  PK — a re-run over the same Silver is a no-op on row identity and refreshes the latest distribution.

QUARANTINE: the Spark job has NO quarantine side-write (this is a pure Silver→Gold rollup); nothing to
  skip. NO watermark table is read here (source is a Silver mart, not the gated keystone) — run_job's
  best-effort watermark advance over the gated keystone is a harmless non-fatal no-op for this job.

Parity target: brain_gold.gold_repeat_latency (Spark).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GOLD_INCREMENTAL, ensure_table, incremental_window, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_repeat_latency_duckdb_test
# instead of the live Spark-owned table. Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_repeat_latency{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"

# Mirrors the Spark _COLUMNS order/types (NO money column, NO currency_code — pure behavioral day-counts).
COLUMNS_SQL = """
  brand_id                          string    NOT NULL,
  bucket_key                        string    NOT NULL,
  bucket_order                      int       NOT NULL,
  bucket_lo_days                    int       NOT NULL,
  bucket_hi_days                    int,
  bucket_customers                  bigint    NOT NULL,
  median_days_to_second_purchase    bigint,
  second_order_customers            bigint    NOT NULL,
  single_order_customers            bigint    NOT NULL,
  total_customers                   bigint    NOT NULL,
  updated_at                        timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "bucket_key", "bucket_order", "bucket_lo_days", "bucket_hi_days",
    "bucket_customers", "median_days_to_second_purchase", "second_order_customers",
    "single_order_customers", "total_customers", "updated_at",
]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL)

    # ── INCREMENTAL WINDOW (opt-in; GOLD_INCREMENTAL=1) — CHANGED-ENTITY REFOLD ─────────────────────────
    #   GRAIN = entity_fold: MANY silver_order_state rows aggregate into the SIX bucket rows of ONE brand,
    #   whose latency distribution / median / customer counts depend on the brand's FULL order history —
    #   including a customer's 1st/2nd order that may sit BELOW the watermark. Windowing the fold input
    #   directly would silently drop history → wrong day-gaps / counts. So we window ONLY to DISCOVER which
    #   BRANDS changed (a new order landed since the last run), then re-fold each changed brand over its
    #   FULL, UNWINDOWED order history. The MERGE on the PK (brand_id, bucket_key) upserts exactly those
    #   restated brand distributions.
    #
    #   CLOCK: the fold-driving source silver_order_state has NO plain `ingested_at` column; its persisted
    #   arrival/WRITE clock is `updated_at` (timestamptz NOT NULL, now()-stamped on every MERGE — exactly
    #   "which order rows changed since last run"). We window on that, NOT on the business time
    #   first_event_at (a late-arriving backfilled order below the watermark would otherwise be dropped →
    #   wrong latency). Tier gate is GOLD_INCREMENTAL (Gold flips independently of Silver).
    #
    #   Default OFF / first run / FULL_REFRESH → lo=None → NO changed-set, NO semi-join → the SQL below is
    #   byte-identical to the pre-incremental full recompute.
    lo, hi = incremental_window(con, "gold-repeat-latency", SOURCE, ts_col="updated_at",
                                enabled=GOLD_INCREMENTAL)

    # Window predicate as an EMPTY string when lo is None (byte-identical full scan); a [lo, hi] range over
    # the order spine's write clock otherwise. Each bound carries its own leading " AND " so the lo=None
    # case is the empty string and the surrounding SQL is byte-for-byte unchanged.
    win = []
    if lo is not None:
        win.append(f"updated_at >= '{lo}'")
    if hi is not None:
        win.append(f"updated_at <= '{hi}'")
    order_window = f" AND {' AND '.join(win)}" if win else ""

    # CHANGED-BRAND set: brands whose order spine changed within [lo, hi], using the SAME entity key
    # (brand_id) + the SAME row guards the fold's `orders` CTE uses. Built ONLY when incremental.
    changed = f"""
            SELECT DISTINCT brand_id
            FROM {SOURCE}
            WHERE brand_id IS NOT NULL
              AND brain_id IS NOT NULL
              AND first_event_at IS NOT NULL{order_window}
    """

    # Semi-join clause: when incremental, restrict the FULL-history fold to only the changed brands so each
    # re-folds over its ENTIRE order history. EMPTY when lo is None → unwindowed full recompute.
    refold_filter = (
        f"\n              AND brand_id IN (SELECT brand_id FROM ({changed}))"
        if lo is not None else ""
    )

    staged = f"""
        WITH orders AS (
            SELECT brand_id, brain_id, order_id,
                   first_event_at AT TIME ZONE 'UTC' AS order_at
            FROM {SOURCE}
            WHERE brand_id IS NOT NULL
              AND brain_id IS NOT NULL
              AND first_event_at IS NOT NULL{refold_filter}
        ),
        ranked AS (
            SELECT
                brand_id, brain_id, order_at,
                ROW_NUMBER() OVER (
                    PARTITION BY brand_id, brain_id
                    ORDER BY order_at ASC, order_id ASC      -- order_id = deterministic tiebreaker
                ) AS rn
            FROM orders
        ),
        first_two AS (
            SELECT
                brand_id, brain_id,
                MAX(CASE WHEN rn = 1 THEN order_at END) AS first_at,
                MAX(CASE WHEN rn = 2 THEN order_at END) AS second_at
            FROM ranked
            GROUP BY brand_id, brain_id
        ),
        latency AS (
            -- INTEGER day-boundary gap between 1st and 2nd order; GREATEST guards the ascending-rank invariant.
            SELECT
                brand_id, brain_id,
                CAST(GREATEST(date_diff('day', first_at, second_at), 0) AS BIGINT) AS days_to_second
            FROM first_two
            WHERE second_at IS NOT NULL                      -- returners only (>=2 orders)
        ),
        brand_counts AS (
            SELECT
                brand_id,
                CAST(COUNT(*) AS BIGINT)                                               AS total_customers,
                CAST(SUM(CASE WHEN second_at IS NULL     THEN 1 ELSE 0 END) AS BIGINT) AS single_order_customers,
                CAST(SUM(CASE WHEN second_at IS NOT NULL THEN 1 ELSE 0 END) AS BIGINT) AS second_order_customers
            FROM first_two
            GROUP BY brand_id
        ),
        brand_scalar AS (
            -- EXACT median of the integer day series, stored as a bigint (no-float rule: days are counts).
            SELECT
                brand_id,
                CAST(quantile_cont(days_to_second, 0.5) AS BIGINT) AS median_days_to_second_purchase
            FROM latency
            GROUP BY brand_id
        ),
        bucketed AS (
            SELECT
                brand_id,
                CASE
                    WHEN days_to_second <= 7  THEN '0-7'
                    WHEN days_to_second <= 14 THEN '8-14'
                    WHEN days_to_second <= 30 THEN '15-30'
                    WHEN days_to_second <= 60 THEN '31-60'
                    WHEN days_to_second <= 90 THEN '61-90'
                    ELSE '90+'
                END AS bucket_key
            FROM latency
        ),
        bucket_counts AS (
            SELECT brand_id, bucket_key, CAST(COUNT(*) AS BIGINT) AS bucket_customers
            FROM bucketed
            GROUP BY brand_id, bucket_key
        ),
        bucket_dim AS (
            SELECT '0-7'   AS bucket_key, CAST(1 AS INT) AS bucket_order, CAST(0  AS INT) AS bucket_lo_days, CAST(7    AS INT) AS bucket_hi_days UNION ALL
            SELECT '8-14',  CAST(2 AS INT), CAST(8  AS INT), CAST(14   AS INT) UNION ALL
            SELECT '15-30', CAST(3 AS INT), CAST(15 AS INT), CAST(30   AS INT) UNION ALL
            SELECT '31-60', CAST(4 AS INT), CAST(31 AS INT), CAST(60   AS INT) UNION ALL
            SELECT '61-90', CAST(5 AS INT), CAST(61 AS INT), CAST(90   AS INT) UNION ALL
            SELECT '90+',   CAST(6 AS INT), CAST(91 AS INT), CAST(NULL AS INT)
        )
        SELECT
            bc.brand_id,
            d.bucket_key,
            d.bucket_order,
            d.bucket_lo_days,
            d.bucket_hi_days,
            CAST(COALESCE(cnt.bucket_customers, 0) AS BIGINT)   AS bucket_customers,
            bs.median_days_to_second_purchase,                  -- NULL when brand has no returners
            bc.second_order_customers,
            bc.single_order_customers,
            bc.total_customers,
            now() AT TIME ZONE 'UTC'                            AS updated_at
        FROM brand_counts bc
        CROSS JOIN bucket_dim d                                 -- every brand emits all six buckets
        LEFT JOIN bucket_counts cnt
               ON cnt.brand_id = bc.brand_id AND cnt.bucket_key = d.bucket_key
        LEFT JOIN brand_scalar bs
               ON bs.brand_id = bc.brand_id
    """

    # Idempotent MERGE on the (brand_id, bucket_key) PK. staged is already 1 row per PK (a GROUP BY
    # upstream), so order_by_desc = bucket_order is a stable, deterministic no-op tie-break.
    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "bucket_key"],
                       order_by_desc=["bucket_order"])


if __name__ == "__main__":
    # The watermark tracks the order spine's WRITE clock (silver_order_state.updated_at) — this Gold job
    # reads a sibling Silver mart directly (not the gated keystone), and updated_at is the only monotonic
    # arrival clock the source persists.
    run_job("gold-repeat-latency", build, target_table="gold_repeat_latency",
            source_table=SOURCE, ts_col="updated_at")
