"""
gold_utm_source.py — NET-NEW Gold `utm_source` mart (Brain V4, P3): the UTM / acquisition-SOURCE matrix.

WHY: there is no materialized "which traffic source brings visitors, conversions, revenue and the most
valuable (LTV / repeat) customers" surface. This mart is that matrix — ONE row per
(brand_id, source, medium), folding the journey grain (silver_touchpoint first-touch utm), the order
spine (silver_order_state revenue) and the customer 360 (gold_customer_360 lifetime value / repeat) onto
the first-touch source/medium of each visitor. First-touch attribution: a visitor (and the orders +
customer they become) is credited to the utm source/medium of their EARLIEST touch.

GRAIN: exactly 1 row per (brand_id, source, medium). brand_id is the tenant key, FIRST column + pk[0]
  (V4 rule 5). source = first-touch utm_source, medium = first-touch utm_medium — honest-empty dims
  ('' / NULL) collapse to 'unknown' so the matrix never has blank axes.

COLUMNS:
  visitors        — distinct brain_anon_id whose FIRST touch carries this (source, medium).
  conversions     — distinct orders attributed to a visitor of this (source, medium) (any touch in that
                    visitor's journey carrying a stitched_order_id, credited to their first-touch source).
  revenue_minor   — Σ silver_order_state.order_value_minor of those attributed orders, bigint MINOR units
                    paired with currency_code (V4 rule 5 — per-currency, NEVER blended across currencies:
                    summed WITHIN the group's dominant currency only).
  avg_ltv_minor   — AVG lifetime_value_minor of the gold_customer_360 customers acquired via this
                    (source, medium) (resolved through the visitor's first-touch stitched_brain_id), bigint
                    MINOR units in the SAME currency_code (averaged within that currency; never blended).
  repeat_rate_pct — % of those acquired customers with >=2 lifetime orders (integer 0-100).
  currency_code   — the group's dominant currency (a brand transacts in one currency, so revenue_minor and
                    avg_ltv_minor share it — no cross-currency blend).

MONEY (V4 rule 5): revenue_minor + avg_ltv_minor are bigint MINOR units + a sibling currency_code, summed/
  averaged strictly within a single currency. No float, no blend.

SOURCES:
  silver_touchpoint   — journey grain: first-touch utm_source / utm_medium per visitor + the
                        stitched_order_id (order attribution) and stitched_brain_id (customer bridge).
  silver_order_state  — order spine: order_value_minor + currency_code per attributed order.
  gold_customer_360   — OPTIONAL sibling Gold mart: lifetime_value_minor / lifetime_orders / currency_code
                        per (brand_id, brain_id). Absent (cold first cycle) → avg_ltv_minor / repeat_rate_pct
                        are 0 (the visitors / conversions / revenue matrix still builds, honest).

REPLAY-SAFE: full recompute from Silver(+sibling Gold) each run, MERGE-UPDATE'd on the
  (brand_id, source, medium) PK — a re-run over the same inputs yields identical rows. ADDITIVE: repoints
  NO reader, writes ONLY brain_gold.gold_utm_source.
"""
from __future__ import annotations  # Spark image is Python 3.8 — defer annotation eval.

from _gold_base import CATALOG, GOLD_NAMESPACE, ensure_gold_table, merge_on_pk, run_job, silver
from pyspark.sql import SparkSession

TABLE = "gold_utm_source"

# The customer-360 Iceberg Gold mart (sibling, owned by the customer group). OPTIONAL source — if absent
# (cold first cycle) avg_ltv_minor / repeat_rate_pct fall to 0; the rest of the matrix still builds.
CUSTOMER_360_TABLE = f"{CATALOG}.{GOLD_NAMESPACE}.gold_customer_360"

COLUMNS_SQL = """
          brand_id        string    NOT NULL,
          source          string    NOT NULL,
          medium          string    NOT NULL,
          visitors        bigint    NOT NULL,
          conversions     bigint    NOT NULL,
          revenue_minor   bigint    NOT NULL,
          avg_ltv_minor   bigint    NOT NULL,
          repeat_rate_pct int       NOT NULL,
          currency_code   string,
          updated_at      timestamp NOT NULL
""".strip("\n")


def _table_exists(spark: SparkSession, fqtn: str) -> bool:
    try:
        spark.table(fqtn).schema
        return True
    except Exception:  # noqa: BLE001 — absent → caller degrades gracefully (empty ltv).
        return False


def _ltv_cte(spark: SparkSession) -> str:
    """LTV / repeat CTE folded onto each visitor's first-touch (source, medium) via the stitched_brain_id
    bridge into gold_customer_360. If that sibling Gold mart is absent, return an EMPTY ltv CTE (avg_ltv /
    repeat_rate stay 0) so this job never hard-depends on Gold→Gold refresh ordering. References the
    `first_touch` CTE defined ahead of it in the WITH list."""
    if _table_exists(spark, CUSTOMER_360_TABLE):
        return f"""
        cust AS (
            -- per-customer LTV, credited to the visitor's FIRST-touch source/medium (stitched_brain_id bridge)
            SELECT
                ft.brand_id, ft.source, ft.medium,
                c.lifetime_value_minor,
                c.lifetime_orders,
                COALESCE(NULLIF(c.currency_code, ''), 'unknown') AS currency_code
            FROM first_touch ft
            JOIN {CUSTOMER_360_TABLE} c
              ON c.brand_id = ft.brand_id AND c.brain_id = ft.stitched_brain_id
            WHERE ft.stitched_brain_id IS NOT NULL AND ft.stitched_brain_id <> ''
              AND c.lifetime_value_minor IS NOT NULL
        ),
        ltv_by_cur AS (
            SELECT
                brand_id, source, medium, currency_code,
                CAST(ROUND(AVG(lifetime_value_minor)) AS bigint)                         AS avg_ltv_minor,
                CAST(COUNT(*) AS bigint)                                                 AS cust_n,
                CAST(SUM(CASE WHEN COALESCE(lifetime_orders, 0) >= 2 THEN 1 ELSE 0 END) AS bigint) AS repeat_n
            FROM cust
            GROUP BY brand_id, source, medium, currency_code
        ),
        ltv AS (
            -- dominant currency per group (a brand transacts in one currency → no cross-currency blend)
            SELECT brand_id, source, medium, ltv_currency_code, avg_ltv_minor, repeat_rate_pct
            FROM (
                SELECT
                    brand_id, source, medium,
                    currency_code AS ltv_currency_code,
                    avg_ltv_minor,
                    CASE WHEN cust_n > 0 THEN CAST(ROUND(repeat_n * 100.0 / cust_n) AS int) ELSE 0 END AS repeat_rate_pct,
                    ROW_NUMBER() OVER (PARTITION BY brand_id, source, medium ORDER BY cust_n DESC, currency_code ASC) AS lrn
                FROM ltv_by_cur
            ) WHERE lrn = 1
        )
        """
    # No customer-360 yet → empty ltv (correct schema); avg_ltv_minor / repeat_rate_pct fall to 0.
    return """
        ltv AS (
            SELECT CAST(NULL AS string) AS brand_id, CAST(NULL AS string) AS source,
                   CAST(NULL AS string) AS medium, CAST(NULL AS string) AS ltv_currency_code,
                   CAST(0 AS bigint) AS avg_ltv_minor, CAST(0 AS int) AS repeat_rate_pct
            WHERE 1 = 0
        )
        """


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(16, brand_id)")

    tp = silver("silver_touchpoint")     # brand-filtered temp view under partition-incremental
    osd = silver("silver_order_state")

    staged = spark.sql(
        f"""
        WITH ft AS (
            -- rank each visitor's touches; rn=1 = the FIRST touch (its utm source/medium + resolved ids)
            SELECT
                brand_id,
                brain_anon_id,
                COALESCE(NULLIF(utm_source, ''), 'unknown') AS source,
                COALESCE(NULLIF(utm_medium, ''), 'unknown') AS medium,
                stitched_brain_id,
                ROW_NUMBER() OVER (
                    PARTITION BY brand_id, brain_anon_id
                    ORDER BY CASE WHEN is_first_touch THEN 0 ELSE 1 END, occurred_at ASC, touch_seq ASC
                ) AS rn
            FROM {tp}
            WHERE brand_id IS NOT NULL AND brain_anon_id IS NOT NULL
        ),
        first_touch AS (
            SELECT brand_id, brain_anon_id, source, medium, stitched_brain_id FROM ft WHERE rn = 1
        ),
        visitors AS (
            SELECT brand_id, source, medium, CAST(COUNT(DISTINCT brain_anon_id) AS bigint) AS visitors
            FROM first_touch
            GROUP BY brand_id, source, medium
        ),
        visitor_orders AS (
            -- any touch carrying a stitched order = an order in that visitor's journey
            SELECT DISTINCT brand_id, brain_anon_id, stitched_order_id AS order_id
            FROM {tp}
            WHERE brand_id IS NOT NULL AND brain_anon_id IS NOT NULL
              AND stitched_order_id IS NOT NULL AND stitched_order_id <> ''
        ),
        attributed_orders AS (
            -- credit each order to its visitor's FIRST-touch source/medium
            SELECT ft.brand_id, ft.source, ft.medium, vo.order_id
            FROM first_touch ft
            JOIN visitor_orders vo
              ON vo.brand_id = ft.brand_id AND vo.brain_anon_id = ft.brain_anon_id
        ),
        conv AS (
            SELECT brand_id, source, medium, CAST(COUNT(DISTINCT order_id) AS bigint) AS conversions
            FROM attributed_orders
            GROUP BY brand_id, source, medium
        ),
        order_rev AS (
            SELECT
                ao.brand_id, ao.source, ao.medium,
                COALESCE(NULLIF(os.currency_code, ''), 'unknown') AS currency_code,
                os.order_value_minor,
                ao.order_id
            FROM attributed_orders ao
            JOIN {osd} os
              ON os.brand_id = ao.brand_id AND os.order_id = ao.order_id
            WHERE os.order_value_minor IS NOT NULL
        ),
        rev_by_cur AS (
            SELECT brand_id, source, medium, currency_code,
                   CAST(SUM(order_value_minor) AS bigint) AS revenue_minor
            FROM order_rev
            GROUP BY brand_id, source, medium, currency_code
        ),
        rev AS (
            -- dominant currency per group (revenue summed WITHIN a single currency — never blended)
            SELECT brand_id, source, medium, currency_code, revenue_minor
            FROM (
                SELECT brand_id, source, medium, currency_code, revenue_minor,
                       ROW_NUMBER() OVER (PARTITION BY brand_id, source, medium ORDER BY revenue_minor DESC, currency_code ASC) AS crn
                FROM rev_by_cur
            ) WHERE crn = 1
        ),
        {_ltv_cte(spark)}
        SELECT
            v.brand_id,
            v.source,
            v.medium,
            v.visitors,
            COALESCE(c.conversions, 0)                              AS conversions,
            COALESCE(r.revenue_minor, 0)                           AS revenue_minor,
            COALESCE(l.avg_ltv_minor, 0)                           AS avg_ltv_minor,
            COALESCE(l.repeat_rate_pct, 0)                         AS repeat_rate_pct,
            COALESCE(r.currency_code, l.ltv_currency_code)         AS currency_code,
            current_timestamp()                                   AS updated_at
        FROM visitors v
        LEFT JOIN conv c ON c.brand_id = v.brand_id AND c.source = v.source AND c.medium = v.medium
        LEFT JOIN rev  r ON r.brand_id = v.brand_id AND r.source = v.source AND r.medium = v.medium
        LEFT JOIN ltv  l ON l.brand_id = v.brand_id AND l.source = v.source AND l.medium = v.medium
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "source", "medium"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    # PARTITION-INCREMENTAL (partition = brand_id): recompute brands changed in any source. The
    # silver_* reads are brand-filtered via silver(); gold_customer_360 is read full (skipped by the
    # silver-namespace change-detector) but the staged rows are brand-scoped by silver_touchpoint, so the
    # MERGE only touches changed brands — parity preserved. build() unchanged.
    run_job("gold-utm-source", build, entity_incremental={
        "table_name": "gold_utm_source",
        "source_tables": ["silver_touchpoint", "silver_order_state", "gold_customer_360"],
    })
