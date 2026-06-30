"""
gold_delivery_time.py — NET-NEW gap Gold `delivery_time` mart (Brain V4 Phase 3, GROUP "NEW gap
Gold products"). Delivery-time DISTRIBUTION per courier.

NO dbt predecessor (parity status=NEW). The materialized "how fast does each courier deliver" surface:
per (brand, courier), the DISTRIBUTION of INTEGER DELIVERY DAYS — the whole-day gap between when a
shipment first appeared (dispatched) and when it reached its DELIVERED terminal state — bucketed into
five fixed ranges (0-1 / 2-3 / 4-5 / 6-7 / 8+ days). It complements gold_logistics_performance (which
answers "what FRACTION of a courier's shipments are delivered vs RTO"); this mart answers "for the
delivered ones, HOW LONG did they take".

GRAIN (one focused mart, two logical grains co-located on the finest key so the slice reads ONE view):
  - HISTOGRAM grain = (brand_id, courier, bucket): 1 row per (brand, courier, delivery-day bucket).
    Exactly FIVE bucket rows are emitted per (brand, courier) that has >=1 delivered shipment (0-1 /
    2-3 / 4-5 / 6-7 / 8+ days), INCLUDING zero-count buckets, so the histogram panel is stable / never
    has holes.
  - SCALAR grain = (brand_id, courier): the per-courier scalars (avg_delivery_days,
    courier_shipment_count) are DENORMALIZED — repeated identically on all five bucket rows. Read the
    average from ANY one row (MAX/ANY), read the histogram from all five (ORDER BY bucket_order). This
    keeps the mart a single Iceberg table + single Trino view.

SOURCE : Iceberg brain_silver.silver_shipment — the per-(brand_id, order_id) LATEST shipment-state
  spine. For a DELIVERED shipment (is_delivered = TRUE), first_event_at = min(occurred_at) = when the
  shipment first appeared (the dispatched/created anchor) and last_status_at = the status_changed_at of
  the terminal DELIVERED transition (the delivered anchor; carried as a string in Silver — CAST to a
  timestamp here). The whole-day gap between them is the delivery latency. This is the "fold from the
  silver_shipment dispatched->delivered terminal timestamps" the spec asks for — no PG, no
  feature-precompute.

THE TRANSFORM (deterministic, INTEGER DAY MATH — no money):
  1. delivered = silver_shipment rows that are is_delivered = TRUE with a brand_id + a parseable
                 first_event_at (dispatched) AND last_status_at (delivered) timestamp.
  2. delivery_days = GREATEST(datediff(delivered_at, dispatched_at), 0) — Spark datediff returns an
                 INTEGER day count; GREATEST(...,0) guards against any clock-skew negative. NO float.
  3. bucketed = each delivered shipment's delivery_days mapped to one of the five fixed ranges.
  4. scalars = per (brand, courier): avg_delivery_days = AVG over the integer day series (a behavioral
                 average, NOT money — stored as a double; the no-float rule governs MONEY only) and
                 courier_shipment_count = COUNT of delivered shipments.
  5. buckets = each courier's delivered shipments bucketed, LEFT-joined onto the full five-bucket
                 dimension × (brand, courier) grid so every courier emits all five rows.

BUCKET BOUNDARIES (inclusive, non-overlapping — day 1 lands in 0-1; day 8 lands in 8+):
  0-1:[0,1]  2-3:[2,3]  4-5:[4,5]  6-7:[6,7]  8+:[8,∞)
  Σ shipment_count across the five buckets == courier_shipment_count (the average's denominator).

NO MONEY: a delivery-time mart is purely behavioral integer day-counts — registered money_columns=[].
  No currency_code is carried (it would be a meaningless descriptor here; this mart never sums money).

REPLAY-SAFE: full recompute from Silver each run, MERGE-UPDATE'd on the (brand_id, courier, bucket)
  PK — a re-run over the same Silver is a no-op on row identity and refreshes the latest distribution.
"""
from __future__ import annotations  # Spark image is Python 3.8 — defer annotation eval.

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_delivery_time"

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


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(4, brand_id)")

    staged = spark.sql(
        f"""
        WITH delivered AS (
            -- DELIVERED terminal shipments with a parseable dispatched (first_event_at) + delivered
            -- (last_status_at, a Silver string) anchor. last_status_at = the DELIVERED transition's
            -- status_changed_at when is_delivered = TRUE.
            SELECT
                brand_id,
                COALESCE(NULLIF(courier, ''), 'unknown')                              AS courier,
                CAST(GREATEST(
                    datediff(CAST(last_status_at AS TIMESTAMP), first_event_at), 0
                ) AS bigint)                                                          AS delivery_days
            FROM {silver('silver_shipment')}
            WHERE brand_id IS NOT NULL
              AND is_delivered = TRUE
              AND first_event_at IS NOT NULL
              AND last_status_at IS NOT NULL
              AND CAST(last_status_at AS TIMESTAMP) IS NOT NULL
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
            SELECT brand_id, courier, bucket, CAST(COUNT(*) AS bigint) AS shipment_count
            FROM bucketed
            GROUP BY brand_id, courier, bucket
        ),
        courier_scalar AS (
            -- avg_delivery_days is a behavioral average (NOT money) — a double; courier_shipment_count
            -- is the delivered-shipment denominator the buckets sum back to.
            SELECT
                brand_id,
                courier,
                CAST(AVG(CAST(delivery_days AS double)) AS double) AS avg_delivery_days,
                CAST(COUNT(*) AS bigint)                           AS courier_shipment_count
            FROM delivered
            GROUP BY brand_id, courier
        ),
        bucket_dim AS (
            SELECT '0-1' AS bucket, CAST(1 AS int) AS bucket_order, CAST(0 AS int) AS bucket_lo_days, CAST(1    AS int) AS bucket_hi_days UNION ALL
            SELECT '2-3', CAST(2 AS int), CAST(2 AS int), CAST(3    AS int) UNION ALL
            SELECT '4-5', CAST(3 AS int), CAST(4 AS int), CAST(5    AS int) UNION ALL
            SELECT '6-7', CAST(4 AS int), CAST(6 AS int), CAST(7    AS int) UNION ALL
            SELECT '8+',  CAST(5 AS int), CAST(8 AS int), CAST(NULL AS int)
        )
        SELECT
            cs.brand_id,
            cs.courier,
            d.bucket,
            d.bucket_order,
            d.bucket_lo_days,
            d.bucket_hi_days,
            CAST(COALESCE(cnt.shipment_count, 0) AS bigint)   AS shipment_count,
            cs.avg_delivery_days,
            cs.courier_shipment_count,
            current_timestamp()                               AS updated_at
        FROM courier_scalar cs
        CROSS JOIN bucket_dim d                                -- every courier emits all five buckets
        LEFT JOIN bucket_counts cnt
               ON cnt.brand_id = cs.brand_id
              AND cnt.courier  = cs.courier
              AND cnt.bucket   = d.bucket
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "courier", "bucket"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-delivery-time", build, entity_incremental={
        "table_name": "gold_delivery_time", "source_tables": ["silver_shipment"],
    })
