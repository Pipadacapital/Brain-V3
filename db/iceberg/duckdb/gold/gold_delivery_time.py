"""
gold_delivery_time.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_delivery_time.py.

NET-NEW gap Gold `delivery_time` mart (Brain V4 Phase 3, "NEW gap Gold products"). NO dbt predecessor
(parity status=NEW). Delivery-time DISTRIBUTION per courier: per (brand_id, courier), the histogram of
INTEGER DELIVERY DAYS — the whole-day gap between when a DELIVERED shipment first appeared (dispatched)
and when it reached its DELIVERED terminal state — bucketed into five fixed ranges (0-1 / 2-3 / 4-5 /
6-7 / 8+ days), plus the per-courier scalars (avg_delivery_days, courier_shipment_count) DENORMALIZED
identically onto all five bucket rows.

SOURCE : {CATALOG}.brain_silver.silver_shipment read DIRECTLY (not the gated keystone) — the
  per-(brand_id, order_id) LATEST shipment-state spine. For a DELIVERED shipment (is_delivered = TRUE),
  first_event_at (timestamptz) = when the shipment first appeared (the dispatched anchor) and
  last_status_at (a Silver VARCHAR — CAST to a timestamp here) = the status_changed_at of the terminal
  DELIVERED transition. The whole-day gap between them is the delivery latency. Reuses the framework's
  ensure_table / merge_on_pk / run_job.

THE TRANSFORM (deterministic INTEGER DAY MATH — NO money, NO float, NO currency_code):
  1. delivered = silver_shipment rows that are is_delivered = TRUE with a brand_id + a parseable
                 first_event_at (dispatched) AND last_status_at (delivered) timestamp.
  2. delivery_days = GREATEST(day-gap(dispatched, delivered), 0) — the calendar-day-boundary count;
                 GREATEST(...,0) guards against any clock-skew negative. NO float.
  3. bucketed = each delivered shipment mapped to one of five fixed ranges.
  4. scalars = per (brand, courier): avg_delivery_days = AVG over the integer day series (a behavioral
                 average, NOT money — a double; the no-float rule governs MONEY only) and
                 courier_shipment_count = COUNT of delivered shipments.
  5. buckets = each courier's delivered shipments bucketed, LEFT-joined onto the full five-bucket
                 dimension × (brand, courier) grid so every courier emits all five rows.

DAY-GAP PARITY: Spark `datediff(CAST(last_status_at AS TIMESTAMP), first_event_at)` returns the whole
  calendar-DAY-BOUNDARY difference (a day-crossing count, not a 24h quotient). DuckDB's
  `date_diff('day', dispatched, delivered)` is the same calendar-day-boundary difference → identical
  integer day counts. Both endpoints are pinned to UTC wall-clock before the day-boundary math to match
  Spark's UTC-instant convention: first_event_at (timestamptz) via AT TIME ZONE 'UTC', last_status_at
  (a naive UTC-wall-clock ISO string) via CAST(... AS TIMESTAMP).

AVG PARITY: DuckDB AVG(CAST(delivery_days AS DOUBLE)) == Spark AVG over the same integer day series (an
  IEEE-754 double on both engines; the no-float rule governs money only). The checksum normalizes it as a
  plain VARCHAR — data-equivalent, not byte-identical, so ordinary FP rendering is fine.

BUCKET BOUNDARIES (inclusive, non-overlapping — day 1 lands in 0-1; day 8 lands in 8+):
  0-1:[0,1] 2-3:[2,3] 4-5:[4,5] 6-7:[6,7] 8+:[8,∞). Σ shipment_count == courier_shipment_count.

REPLAY-SAFE: full recompute from Silver each run, idempotent MERGE-UPDATE on the (brand_id, courier,
  bucket) PK — a re-run over the same Silver is a no-op on row identity and refreshes the distribution.

FULL RECOMPUTE vs Spark's entity-incremental wrapper: the Spark job wraps the identical rollup in
  run_entity_incremental (a SCALING optimization — recompute only brands with new shipment events, then
  the SAME MERGE). A full-scan recompute here is parity-equivalent: the MERGE on the mart PK is
  idempotent and restates every (brand, courier, bucket) to the current Silver aggregate.

QUARANTINE: the Spark job has NO Stage-1/quarantine side-write (this is a pure Silver→Gold rollup over
  already-gated Silver); nothing to skip. NO watermark table is read here (source is a Silver mart, not
  the gated keystone) — run_job's best-effort watermark advance over the gated keystone is a harmless
  non-fatal no-op for this job.

Honors MIGRATION_TABLE_SUFFIX (→ gold_delivery_time_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_delivery_time (Spark oracle: 10 rows).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_delivery_time_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_delivery_time{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_shipment"

# Mirrors the Spark COLUMNS_SQL order/types exactly. No money column, no currency_code (pure day-counts).
COLUMNS_SQL = """
  brand_id                string    NOT NULL,
  courier                 string    NOT NULL,
  bucket                  string    NOT NULL,
  bucket_order            int       NOT NULL,
  bucket_lo_days          int       NOT NULL,
  bucket_hi_days          int,
  shipment_count          bigint    NOT NULL,
  avg_delivery_days       double,
  courier_shipment_count  bigint    NOT NULL,
  updated_at              timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "courier", "bucket", "bucket_order", "bucket_lo_days", "bucket_hi_days",
    "shipment_count", "avg_delivery_days", "courier_shipment_count", "updated_at",
]

PK = ["brand_id", "courier", "bucket"]


def build(con):
    # brand-first tenant partitioning (mirrors Spark bucket(4, brand_id)).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(4, brand_id)")

    staged = f"""
        WITH delivered AS (
            -- DELIVERED terminal shipments with a parseable dispatched (first_event_at) + delivered
            -- (last_status_at, a Silver VARCHAR) anchor. Both endpoints pinned to UTC wall-clock so the
            -- calendar-day-boundary math matches Spark's datediff over UTC instants.
            SELECT
                brand_id,
                COALESCE(NULLIF(courier, ''), 'unknown')                                    AS courier,
                CAST(GREATEST(
                    date_diff('day',
                              first_event_at AT TIME ZONE 'UTC',
                              CAST(last_status_at AS TIMESTAMP)), 0
                ) AS BIGINT)                                                                AS delivery_days
            FROM {SOURCE}
            WHERE brand_id IS NOT NULL
              AND is_delivered = TRUE
              AND first_event_at IS NOT NULL
              AND last_status_at IS NOT NULL
              AND TRY_CAST(last_status_at AS TIMESTAMP) IS NOT NULL
        ),
        bucketed AS (
            SELECT
                brand_id,
                courier,
                CASE
                    WHEN delivery_days <= 1 THEN '0-1'
                    WHEN delivery_days <= 3 THEN '2-3'
                    WHEN delivery_days <= 5 THEN '4-5'
                    WHEN delivery_days <= 7 THEN '6-7'
                    ELSE '8+'
                END AS bucket
            FROM delivered
        ),
        bucket_counts AS (
            SELECT brand_id, courier, bucket, CAST(COUNT(*) AS BIGINT) AS shipment_count
            FROM bucketed
            GROUP BY brand_id, courier, bucket
        ),
        courier_scalar AS (
            -- avg_delivery_days is a behavioral average (NOT money) — a double; courier_shipment_count
            -- is the delivered-shipment denominator the buckets sum back to.
            SELECT
                brand_id,
                courier,
                CAST(AVG(CAST(delivery_days AS DOUBLE)) AS DOUBLE) AS avg_delivery_days,
                CAST(COUNT(*) AS BIGINT)                           AS courier_shipment_count
            FROM delivered
            GROUP BY brand_id, courier
        ),
        bucket_dim AS (
            SELECT '0-1' AS bucket, CAST(1 AS INT) AS bucket_order, CAST(0 AS INT) AS bucket_lo_days, CAST(1    AS INT) AS bucket_hi_days UNION ALL
            SELECT '2-3', CAST(2 AS INT), CAST(2 AS INT), CAST(3    AS INT) UNION ALL
            SELECT '4-5', CAST(3 AS INT), CAST(4 AS INT), CAST(5    AS INT) UNION ALL
            SELECT '6-7', CAST(4 AS INT), CAST(6 AS INT), CAST(7    AS INT) UNION ALL
            SELECT '8+',  CAST(5 AS INT), CAST(8 AS INT), CAST(NULL AS INT)
        )
        SELECT
            cs.brand_id,
            cs.courier,
            d.bucket,
            d.bucket_order,
            d.bucket_lo_days,
            d.bucket_hi_days,
            CAST(COALESCE(cnt.shipment_count, 0) AS BIGINT)   AS shipment_count,
            cs.avg_delivery_days,
            cs.courier_shipment_count,
            now() AT TIME ZONE 'UTC'                          AS updated_at
        FROM courier_scalar cs
        CROSS JOIN bucket_dim d                                -- every courier emits all five buckets
        LEFT JOIN bucket_counts cnt
               ON cnt.brand_id = cs.brand_id
              AND cnt.courier  = cs.courier
              AND cnt.bucket   = d.bucket
    """

    # Idempotent MERGE on the (brand_id, courier, bucket) PK. staged is already 1 row per PK (GROUP BY
    # upstream), so order_by_desc = bucket_order is a stable, deterministic no-op tie-break.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["bucket_order"])


if __name__ == "__main__":
    run_job("gold-delivery-time", build, target_table="gold_delivery_time")
