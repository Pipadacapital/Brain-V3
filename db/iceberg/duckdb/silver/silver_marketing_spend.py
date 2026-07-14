"""
silver_marketing_spend.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_marketing_spend.py.

Per-campaign/day spend FACT folded from the gated keystone (event_type='spend.live.v1'):
  read → typed projection of payload.properties.* → BASE-grain filter → dedup latest-ingested →
  final cast/coalesce/filter → idempotent MERGE on (brand_id, spend_event_id).

GRAIN = (brand_id, spend_event_id)  — spend_event_id IS the Bronze event_id (mapper-seeded, ADR-AD-5),
  so a trailing re-pull re-emits the SAME row with the SAME id → dedup keeps the latest ingested version.
BASE-GRAIN ONLY: keep breakdown_key NULL/'' so breakdown rows never explode the campaign-day grain.
MONEY = bigint MINOR units (spend_minor + the *_minor block) paired with currency_code (never a float).
ISOLATION: brand_id first on every row.

QUARANTINE SKIPPED: the Spark job also runs a Stage-1 DQ gate (dq_violations_udf → silver_quarantine,
  stage='dq') that diverts negative/non-int spend_minor, non-ISO-4217 currency, future/unparseable
  occurred_at BEFORE the MERGE. That side-write is intentionally OMITTED here (the migration framework
  has no quarantine seam; parity is on the GOOD-row projection, which is byte-identical). If the oracle's
  live data contained any quarantined spend rows they would be `duckdb-only` here — acceptable drift, not
  a mismatch. Parity target: brain_silver.silver_marketing_spend (30548 rows).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_marketing_spend{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SPEND_EVENT = "spend.live.v1"

# Column contract — the dbt mart output projection PLUS the additive enriched-advertising + FIREHOSE
# base-grain block. brand_id tenant key first; money = bigint MINOR sharing currency_code (never float);
# count measures = bigint; ratio measures = double; stat_date is a DATE (dbt expression-partition key).
COLUMNS_SQL = """
  brand_id          string    NOT NULL,
  spend_event_id    string    NOT NULL,
  platform          string,
  level             string,
  level_id          string,
  parent_id         string,
  campaign_id       string,
  campaign_name     string,
  stat_date         date,
  spend_minor       bigint,
  currency_code     string,
  impressions       bigint,
  clicks            bigint,
  conversions               bigint,
  all_conversions           bigint,
  conv_value_minor          bigint,
  view_through_conversions  bigint,
  cpc_minor                 bigint,
  cpm_minor                 bigint,
  ctr                       double,
  advertising_channel_type  string,
  breakdown_key             string,
  video_views               bigint,
  reach                     bigint,
  frequency                 double,
  cpp_minor                 bigint,
  unique_clicks             bigint,
  unique_ctr                double,
  inline_link_clicks        bigint,
  inline_link_click_ctr     double,
  outbound_clicks           bigint,
  unique_outbound_clicks    bigint,
  cost_per_unique_click_minor        bigint,
  cost_per_inline_link_click_minor   bigint,
  landing_page_views        bigint,
  purchase_roas_ratio       double,
  website_purchase_roas_ratio        double,
  mobile_app_purchase_roas_ratio     double,
  post_engagement           bigint,
  page_engagement           bigint,
  inline_post_engagement    bigint,
  video_p25_watched         bigint,
  video_p50_watched         bigint,
  video_p75_watched         bigint,
  video_p100_watched        bigint,
  video_thruplay_watched    bigint,
  video_30_sec_watched      bigint,
  video_avg_time_watched_secs        bigint,
  quality_ranking           string,
  engagement_rate_ranking   string,
  conversion_rate_ranking   string,
  video_view_rate                      double,
  engagements                          bigint,
  engagement_rate                      double,
  cost_per_conversion_minor            bigint,
  value_per_conversion_minor           bigint,
  all_conversions_value_minor          bigint,
  cost_per_all_conversions_minor       bigint,
  average_cost_minor                   bigint,
  search_impression_share              double,
  search_budget_lost_impression_share  double,
  search_rank_lost_impression_share    double,
  absolute_top_impression_percentage   double,
  top_impression_percentage            double,
  interactions                         bigint,
  interaction_rate                     double,
  conversions_from_interactions_rate   double,
  account_timezone  string,
  occurred_at       timestamp,
  updated_at        timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "spend_event_id", "platform", "level", "level_id", "parent_id", "campaign_id",
    "campaign_name", "stat_date", "spend_minor", "currency_code", "impressions", "clicks",
    "conversions", "all_conversions", "conv_value_minor", "view_through_conversions", "cpc_minor",
    "cpm_minor", "ctr", "advertising_channel_type", "breakdown_key", "video_views", "reach",
    "frequency", "cpp_minor", "unique_clicks", "unique_ctr", "inline_link_clicks",
    "inline_link_click_ctr", "outbound_clicks", "unique_outbound_clicks", "cost_per_unique_click_minor",
    "cost_per_inline_link_click_minor", "landing_page_views", "purchase_roas_ratio",
    "website_purchase_roas_ratio", "mobile_app_purchase_roas_ratio", "post_engagement",
    "page_engagement", "inline_post_engagement", "video_p25_watched", "video_p50_watched",
    "video_p75_watched", "video_p100_watched", "video_thruplay_watched", "video_30_sec_watched",
    "video_avg_time_watched_secs", "quality_ranking", "engagement_rate_ranking",
    "conversion_rate_ranking", "video_view_rate", "engagements", "engagement_rate",
    "cost_per_conversion_minor", "value_per_conversion_minor", "all_conversions_value_minor",
    "cost_per_all_conversions_minor", "average_cost_minor", "search_impression_share",
    "search_budget_lost_impression_share", "search_rank_lost_impression_share",
    "absolute_top_impression_percentage", "top_impression_percentage", "interactions",
    "interaction_rate", "conversions_from_interactions_rate", "account_timezone", "occurred_at",
    "updated_at",
]

# (col_name, path, sql_type) for the payload.properties.* projection. money → bigint MINOR; counts →
# bigint; ratios → double; passthrough strings → varchar. Absence stays NULL (never fabricated).
_BIGINT_PROPS = [
    "conversions", "all_conversions", "conv_value_minor", "view_through_conversions", "cpc_minor",
    "cpm_minor", "video_views", "reach", "cpp_minor", "unique_clicks", "inline_link_clicks",
    "outbound_clicks", "unique_outbound_clicks", "cost_per_unique_click_minor",
    "cost_per_inline_link_click_minor", "landing_page_views", "post_engagement", "page_engagement",
    "inline_post_engagement", "video_p25_watched", "video_p50_watched", "video_p75_watched",
    "video_p100_watched", "video_thruplay_watched", "video_30_sec_watched",
    "video_avg_time_watched_secs", "engagements", "cost_per_conversion_minor",
    "value_per_conversion_minor", "all_conversions_value_minor", "cost_per_all_conversions_minor",
    "average_cost_minor", "interactions",
]
_DOUBLE_PROPS = [
    "ctr", "frequency", "unique_ctr", "inline_link_click_ctr", "purchase_roas_ratio",
    "website_purchase_roas_ratio", "mobile_app_purchase_roas_ratio", "video_view_rate",
    "engagement_rate", "search_impression_share", "search_budget_lost_impression_share",
    "search_rank_lost_impression_share", "absolute_top_impression_percentage",
    "top_impression_percentage", "interaction_rate", "conversions_from_interactions_rate",
]
_STRING_PROPS = [
    "platform", "level", "level_id", "parent_id", "campaign_id", "campaign_name", "currency_code",
    "advertising_channel_type", "breakdown_key", "quality_ranking", "engagement_rate_ranking",
    "conversion_rate_ranking", "account_timezone",
]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(occurred_at)")

    # ── stg_ad_spend_bronze: raw → typed projection from the gated keystone (event_type='spend.live.v1'). ──
    proj = [
        "brand_id",
        "event_id AS spend_event_id",
    ]
    for p in _STRING_PROPS:
        proj.append(f"{prop('pj', p)} AS {p}")
    # stat_date raw string → date at the final projection (dbt cast('date')).
    proj.append(f"{prop('pj', 'stat_date')} AS stat_date_raw")
    proj.append(f"CAST({prop('pj', 'spend_minor')} AS BIGINT) AS spend_minor")
    proj.append(f"CAST({prop('pj', 'impressions')} AS BIGINT) AS impressions")
    proj.append(f"CAST({prop('pj', 'clicks')} AS BIGINT) AS clicks")
    for p in _BIGINT_PROPS:
        proj.append(f"CAST({prop('pj', p)} AS BIGINT) AS {p}")
    for p in _DOUBLE_PROPS:
        proj.append(f"CAST({prop('pj', p)} AS DOUBLE) AS {p}")
    proj.append("occurred_at")
    proj.append("ingested_at")

    typed = (
        f"SELECT {', '.join(proj)} FROM ({read_gated_events_sql([SPEND_EVENT])}) "
        # Drop malformed events with no spend_event_id (cannot be a canonical spend row).
        "WHERE event_id IS NOT NULL AND event_id <> '' "
        # BASE-GRAIN ONLY: keep the base pass (breakdown_key NULL/''); breakdown rows go to their own marts.
        f"AND ({prop('pj', 'breakdown_key')} IS NULL OR {prop('pj', 'breakdown_key')} = '')"
    )

    # ── dedup: keep the LATEST ingested version per (brand_id, spend_event_id) — Spark Window
    # (ingested_at desc, occurred_at desc). Done here (typed HAS ingested_at) since the final projection
    # drops ingested_at; merge_on_pk's own dedup then re-orders on occurred_at (a no-op post-dedup). ──
    deduped = f"""
      SELECT * FROM (SELECT *, row_number() OVER (
              PARTITION BY brand_id, spend_event_id
              ORDER BY ingested_at DESC, occurred_at DESC) AS _rn
            FROM ({typed})) WHERE _rn = 1
    """

    # ── final projection (cast stat_date→date, coalesce impressions/clicks→0, updated_at=now, grain filter). ──
    final_cols = list(COLUMNS)
    sel = {c: c for c in final_cols}
    sel["stat_date"] = "CAST(stat_date_raw AS DATE) AS stat_date"
    sel["impressions"] = "CAST(coalesce(impressions, 0) AS BIGINT) AS impressions"
    sel["clicks"] = "CAST(coalesce(clicks, 0) AS BIGINT) AS clicks"
    sel["updated_at"] = "now() AS updated_at"
    select_list = ", ".join(sel[c] for c in final_cols)

    staged = f"""
      SELECT {select_list} FROM ({deduped})
      WHERE spend_event_id IS NOT NULL AND CAST(stat_date_raw AS DATE) IS NOT NULL
    """

    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "spend_event_id"],
                       order_by_desc=["occurred_at"])


if __name__ == "__main__":
    run_job("silver-marketing-spend", build, target_table="silver_marketing_spend")
