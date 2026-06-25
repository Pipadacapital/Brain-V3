"""
gold_engagement.py — NET-NEW gap Gold `engagement` mart (Brain V4 Phase 2, GROUP "NEW gap Gold products").

NO dbt predecessor (parity status=NEW; matrix §3/4). The materialized UX-engagement-quality surface — one
row per (brand_id, engagement_date, signal_type) holding the daily count + page/session reach of each
first-party-pixel engagement signal (rage_click / dead_click / scroll_depth / element_clicked), read from
Iceberg brain_silver.silver_engagement_signal. This is the Gold rollup of the friction/interaction grain
the engagement dashboard reads (sibling of the TS computeStorefrontEngagement, but over the dedicated
engagement-signal Silver mart rather than silver_touchpoint).

GRAIN   : 1 row per (brand_id, engagement_date, signal_type). engagement_date = occurred_at::date (UTC).
          No money (a UX-quality marker — registered money_columns=[]). brand_id first + partition anchor.
COLUMNS :
  signal_count   — number of signals of this type in the day.
  sessions       — distinct session_id exhibiting this signal type in the day.
  pages          — distinct page (landing_path) the signal fired on.
  avg_scroll_pct — for scroll_depth: integer-floored mean milestone percent (NULL for non-scroll types).
REPLAY-SAFE: full daily recompute from Silver, MERGE-UPDATE'd on the PK.
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_engagement"

COLUMNS_SQL = """
          brand_id         string    NOT NULL,
          engagement_date  date      NOT NULL,
          signal_type      string    NOT NULL,
          signal_count     bigint    NOT NULL,
          sessions         bigint    NOT NULL,
          pages            bigint    NOT NULL,
          avg_scroll_pct   int,
          updated_at       timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id), engagement_date")

    staged = spark.sql(
        f"""
        SELECT
            brand_id,
            CAST(occurred_at AS DATE)                      AS engagement_date,
            signal_type,
            COUNT(*)                                       AS signal_count,
            COUNT(DISTINCT session_id)                     AS sessions,
            COUNT(DISTINCT page)                           AS pages,
            -- Integer-floored mean scroll milestone (scroll_depth only; NULL otherwise) — integer math, no float.
            CASE WHEN signal_type = 'scroll_depth'
                 THEN CAST(SUM(COALESCE(scroll_pct, 0)) / NULLIF(COUNT(scroll_pct), 0) AS INT)
                 ELSE NULL END                             AS avg_scroll_pct,
            current_timestamp()                            AS updated_at
        FROM {silver('silver_engagement_signal')}
        WHERE brand_id IS NOT NULL AND occurred_at IS NOT NULL
        GROUP BY brand_id, CAST(occurred_at AS DATE), signal_type
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "engagement_date", "signal_type"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-engagement", build)
