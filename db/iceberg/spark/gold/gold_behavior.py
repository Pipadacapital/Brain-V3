"""
gold_behavior.py — NET-NEW gap Gold `behavior` mart (Brain V4 Phase 2, GROUP "NEW gap Gold products").

NO dbt predecessor (parity status=NEW; matrix §3/4). The materialized browse-behavior surface — one row
per (brand_id, behavior_date, page_type) holding the daily page-view volume + session/journey reach per
page_type, read from Iceberg brain_silver.silver_page_view. This is the Gold rollup of the TS
computeStorefrontBehavior page-type-mix signal (storefront-behavior.ts), lifted to a daily mart over the
dedicated page-view Silver grain.

GRAIN   : 1 row per (brand_id, behavior_date, page_type). behavior_date = occurred_at::date (UTC).
          page_type is the page taxonomy (product|collection|cart|search|other|''→'unknown'). No money
          (behavior is impression counting — registered money_columns=[]). brand_id first + partition anchor.
COLUMNS :
  views    — page-view events of this page_type in the day.
  sessions — distinct session_id reaching this page_type.
  journeys — distinct brain_anon_id reaching this page_type (journey reach).
REPLAY-SAFE: full daily recompute from Silver, MERGE-UPDATE'd on the PK.
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_behavior"

COLUMNS_SQL = """
          brand_id       string    NOT NULL,
          behavior_date  date      NOT NULL,
          page_type      string    NOT NULL,
          views          bigint    NOT NULL,
          sessions       bigint    NOT NULL,
          journeys       bigint    NOT NULL,
          updated_at     timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id), behavior_date")

    staged = spark.sql(
        f"""
        SELECT
            brand_id,
            CAST(occurred_at AS DATE)                                    AS behavior_date,
            COALESCE(NULLIF(page_type, ''), 'unknown')                   AS page_type,
            COUNT(*)                                                     AS views,
            COUNT(DISTINCT session_id)                                   AS sessions,
            COUNT(DISTINCT brain_anon_id)                                AS journeys,
            current_timestamp()                                          AS updated_at
        FROM {silver('silver_page_view')}
        WHERE brand_id IS NOT NULL AND occurred_at IS NOT NULL
        GROUP BY brand_id, CAST(occurred_at AS DATE), COALESCE(NULLIF(page_type, ''), 'unknown')
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "behavior_date", "page_type"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-behavior", build, entity_incremental={
        "table_name": "gold_behavior", "source_tables": ["silver_page_view"],
    })
