"""
silver_keyword_spend.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_keyword_spend.py.

The Google Ads keyword-grain spend breakdown mart — an ISOLATED mart that reads the SAME gated keystone
(event_type='spend.live.v1') as silver_marketing_spend but keeps ONLY the keyword-view breakdown rows
(payload.properties.keyword_id present + non-empty). The distinct breakdown-derived event_id (spend_event_id)
keeps these rows separate from the base campaign-day grain, so nothing downstream that assumes the base grain
reads this table.

GRAIN : (brand_id, spend_event_id). MONEY: bigint MINOR units (spend_minor + conv_value_minor) +
        currency_code (never blended/float). ISOLATION: brand_id first (server-derived in Bronze, MT-1).
REPLAY-SAFE: pure projection → dedup latest-ingested → idempotent MERGE. updated_at = now() (a run-clock
        column, excluded from parity).

DATA AVAILABILITY: Bronze holds ZERO keyword-view spend rows today (no Google Ads keyword breakdown synced),
  so this writes a correct EMPTY table; a keyword-breakdown repull populates it with no code change.

Parity target: brain_silver.silver_keyword_spend (NEW).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_keyword_spend_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_keyword_spend{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SPEND_EVENT = os.environ.get("SPEND_EVENT_TYPE", "spend.live.v1")

COLUMNS_SQL = """
  brand_id           string    NOT NULL,
  spend_event_id     string    NOT NULL,
  platform           string,
  campaign_id        string,
  campaign_name      string,
  keyword_id         string,
  keyword_text       string,
  keyword_match_type string,
  stat_date          date,
  spend_minor        bigint,
  currency_code      string,
  impressions        bigint,
  clicks             bigint,
  conversions        bigint,
  conv_value_minor   bigint,
  ctr                double,
  occurred_at        timestamp,
  updated_at         timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "spend_event_id", "platform", "campaign_id", "campaign_name", "keyword_id",
    "keyword_text", "keyword_match_type", "stat_date", "spend_minor", "currency_code", "impressions",
    "clicks", "conversions", "conv_value_minor", "ctr", "occurred_at", "updated_at",
]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(occurred_at)")

    typed = f"""
      SELECT
        brand_id,
        event_id                                     AS spend_event_id,
        {prop('pj','platform')}                      AS platform,
        {prop('pj','campaign_id')}                   AS campaign_id,
        {prop('pj','campaign_name')}                 AS campaign_name,
        {prop('pj','keyword_id')}                    AS keyword_id,
        {prop('pj','keyword_text')}                  AS keyword_text,
        {prop('pj','keyword_match_type')}            AS keyword_match_type,
        CAST({prop('pj','stat_date')} AS DATE)       AS stat_date,
        CAST({prop('pj','spend_minor')} AS BIGINT)   AS spend_minor,
        {prop('pj','currency_code')}                 AS currency_code,
        CAST({prop('pj','impressions')} AS BIGINT)   AS impressions,
        CAST({prop('pj','clicks')} AS BIGINT)        AS clicks,
        CAST({prop('pj','conversions')} AS BIGINT)   AS conversions,
        CAST({prop('pj','conv_value_minor')} AS BIGINT) AS conv_value_minor,
        CAST({prop('pj','ctr')} AS DOUBLE)           AS ctr,
        occurred_at, ingested_at
      FROM ({read_gated_events_sql([SPEND_EVENT])})
      WHERE {prop('pj','keyword_id')} IS NOT NULL AND {prop('pj','keyword_id')} <> ''
        AND event_id IS NOT NULL AND CAST({prop('pj','stat_date')} AS DATE) IS NOT NULL
    """

    # Dedup latest-ingested per (brand_id, spend_event_id); drop ingested_at then stamp updated_at=now().
    deduped = f"""
      SELECT * EXCLUDE (ingested_at, _rn) FROM (
        SELECT *, row_number() OVER (
          PARTITION BY brand_id, spend_event_id
          ORDER BY ingested_at DESC, occurred_at DESC) AS _rn
        FROM ({typed})
      ) WHERE _rn = 1
    """

    staged = f"SELECT {', '.join(c for c in COLUMNS if c != 'updated_at')}, now() AS updated_at FROM ({deduped})"

    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "spend_event_id"],
                       order_by_desc=["occurred_at"])


if __name__ == "__main__":
    run_job("silver-keyword-spend", build, target_table="silver_keyword_spend")
