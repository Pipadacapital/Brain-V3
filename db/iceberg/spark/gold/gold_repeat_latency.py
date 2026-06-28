"""
gold_repeat_latency.py — NET-NEW gap Gold `repeat_latency` mart (Brain V4 Phase 2, GROUP "NEW gap
Gold products"). Time-to-2nd-purchase RETENTION LATENCY.

NO dbt predecessor (parity status=NEW). The materialized "how long until a customer comes back"
surface: per brand, the DISTRIBUTION of INTEGER DAYS between each customer's FIRST and SECOND order.
It complements gold_retention (which answers "how MANY come back, per acquisition cohort"); this mart
answers "how FAST do the returners return" — the median days-to-2nd-order scalar + a fixed-bucket
histogram of the latency.

GRAIN (one focused mart, two logical grains co-located on the finest key so the Wire slice reads ONE
view):
  - HISTOGRAM grain = (brand_id, bucket_key): 1 row per (brand, latency bucket). Exactly SIX bucket rows
    are emitted per brand that has >=1 ordering customer (0-7 / 8-14 / 15-30 / 31-60 / 61-90 / 90+
    days), INCLUDING zero-count buckets, so the histogram panel is stable / never has holes.
  - SCALAR grain = (brand_id): the brand-level scalars (median_days_to_second_purchase,
    second_order_customers, single_order_customers, total_customers) are DENORMALIZED — repeated
    identically on all six bucket rows. The Wire slice reads the median from ANY one row (MAX/ANY) and
    the histogram from all six. This keeps the mart a single Iceberg table + single Trino view (a
    focused, registry-friendly product) instead of two tables that must be joined at serve time.

SOURCE : Iceberg brain_silver.silver_order_state — the per-(brand_id, order_id) canonical order spine
  (brain_id-keyed to the resolved customer, first_event_at = when the order first appeared). Ranking
  orders per (brand_id, brain_id) by (first_event_at, order_id) gives each customer's 1st and 2nd
  order; the day-gap between them is the latency. This IS the "fold from silver_order_state order
  timestamps + the identity brain_id" the spec asks for — no PG, no feature-precompute.

THE TRANSFORM (deterministic, INTEGER DAY MATH — no float, no money):
  1. orders   = silver_order_state rows with a brand_id + brain_id + first_event_at (one row/order).
  2. ranked   = ROW_NUMBER() OVER (PARTITION BY brand_id, brain_id ORDER BY first_event_at, order_id)
                — order_id is the deterministic tiebreaker for same-instant orders.
  3. first_two = per customer, the 1st (rn=1) and 2nd (rn=2) order timestamp. second_at IS NOT NULL
                ⇔ the customer has >=2 orders (a "returner"); second_at IS NULL ⇔ single-order
                (EXCLUDED from the median, counted as single_order_customers).
  4. latency  = datediff(second_at, first_at) for returners → INTEGER days (Spark datediff returns an
                int day count; GREATEST(...,0) guards the ascending-rank invariant). NO float.
  5. scalars  = per brand: median = CAST(percentile(days_to_second, 0.5) AS bigint) — the EXACT median
                of an integer day series, stored as a bigint (the no-float rule: days are counts, the
                stored median is an integer; the intermediate percentile is a standard SQL aggregate
                over integers, never a money value). second_order_customers / single_order_customers /
                total_customers are pure COUNTs.
  6. buckets  = each returner's days_to_second bucketed into the six fixed ranges, LEFT-joined onto the
                full six-bucket dimension × brand grid so every brand emits all six rows.

BUCKET BOUNDARIES (inclusive, non-overlapping — day 90 lands in 61-90; 91+ lands in 90+):
  0-7:[0,7]  8-14:[8,14]  15-30:[15,30]  31-60:[31,60]  61-90:[61,90]  90+:[91,∞)
  Σ bucket_customers across the six buckets == second_order_customers (the median denominator).

NO MONEY: a latency mart is purely behavioral integer day-counts — registered money_columns=[]. No
  currency_code is carried (it would be a meaningless descriptor here; this mart never sums money).

REPLAY-SAFE: full recompute from Silver each run, MERGE-UPDATE'd on the (brand_id, bucket_key) PK — a
  re-run over the same Silver is a no-op on row identity and refreshes the latest distribution.
"""
from __future__ import annotations  # Spark image is Python 3.8 — defer annotation eval.

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_repeat_latency"

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


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(4, brand_id)")

    staged = spark.sql(
        f"""
        WITH orders AS (
            SELECT brand_id, brain_id, order_id, first_event_at AS order_at
            FROM {silver('silver_order_state')}
            WHERE brand_id IS NOT NULL
              AND brain_id IS NOT NULL
              AND first_event_at IS NOT NULL
        ),
        ranked AS (
            SELECT
                brand_id,
                brain_id,
                order_at,
                ROW_NUMBER() OVER (
                    PARTITION BY brand_id, brain_id
                    ORDER BY order_at ASC, order_id ASC      -- order_id = deterministic tiebreaker
                ) AS rn
            FROM orders
        ),
        first_two AS (
            SELECT
                brand_id,
                brain_id,
                MAX(CASE WHEN rn = 1 THEN order_at END) AS first_at,
                MAX(CASE WHEN rn = 2 THEN order_at END) AS second_at
            FROM ranked
            GROUP BY brand_id, brain_id
        ),
        latency AS (
            -- INTEGER day gap between 1st and 2nd order; GREATEST guards the ascending-rank invariant.
            SELECT
                brand_id,
                brain_id,
                CAST(GREATEST(datediff(second_at, first_at), 0) AS bigint) AS days_to_second
            FROM first_two
            WHERE second_at IS NOT NULL                       -- returners only (>=2 orders)
        ),
        brand_counts AS (
            SELECT
                brand_id,
                CAST(COUNT(*) AS bigint)                                            AS total_customers,
                CAST(SUM(CASE WHEN second_at IS NULL     THEN 1 ELSE 0 END) AS bigint) AS single_order_customers,
                CAST(SUM(CASE WHEN second_at IS NOT NULL THEN 1 ELSE 0 END) AS bigint) AS second_order_customers
            FROM first_two
            GROUP BY brand_id
        ),
        brand_scalar AS (
            -- EXACT median of the integer day series, stored as a bigint (no-float rule: days are counts).
            SELECT
                brand_id,
                CAST(percentile(days_to_second, 0.5) AS bigint) AS median_days_to_second_purchase
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
            SELECT brand_id, bucket_key, CAST(COUNT(*) AS bigint) AS bucket_customers
            FROM bucketed
            GROUP BY brand_id, bucket_key
        ),
        bucket_dim AS (
            SELECT '0-7'   AS bucket_key, CAST(1 AS int) AS bucket_order, CAST(0  AS int) AS bucket_lo_days, CAST(7    AS int) AS bucket_hi_days UNION ALL
            SELECT '8-14',  CAST(2 AS int), CAST(8  AS int), CAST(14   AS int) UNION ALL
            SELECT '15-30', CAST(3 AS int), CAST(15 AS int), CAST(30   AS int) UNION ALL
            SELECT '31-60', CAST(4 AS int), CAST(31 AS int), CAST(60   AS int) UNION ALL
            SELECT '61-90', CAST(5 AS int), CAST(61 AS int), CAST(90   AS int) UNION ALL
            SELECT '90+',   CAST(6 AS int), CAST(91 AS int), CAST(NULL AS int)
        )
        SELECT
            bc.brand_id,
            d.bucket_key,
            d.bucket_order,
            d.bucket_lo_days,
            d.bucket_hi_days,
            CAST(COALESCE(cnt.bucket_customers, 0) AS bigint)   AS bucket_customers,
            bs.median_days_to_second_purchase,                   -- NULL when brand has no returners
            bc.second_order_customers,
            bc.single_order_customers,
            bc.total_customers,
            current_timestamp()                                  AS updated_at
        FROM brand_counts bc
        CROSS JOIN bucket_dim d                                  -- every brand emits all six buckets
        LEFT JOIN bucket_counts cnt
               ON cnt.brand_id = bc.brand_id AND cnt.bucket_key = d.bucket_key
        LEFT JOIN brand_scalar bs
               ON bs.brand_id = bc.brand_id
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "bucket_key"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-repeat-latency", build)
