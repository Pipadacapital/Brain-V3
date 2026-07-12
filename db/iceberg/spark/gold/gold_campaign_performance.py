"""
gold_campaign_performance.py — NET-NEW gap Gold `campaign_performance` mart (Brain V4 Phase 2, GROUP "NEW gap Gold").

NO dbt predecessor (parity status=NEW; matrix §3/4). The materialized per-campaign marketing-performance
surface — one row per (brand_id, platform, campaign_id, currency_code) holding lifetime spend, impressions,
clicks, attributed revenue, and the integer-bps CTR / CPC / ROAS, read from Iceberg
brain_silver.silver_marketing_spend (the per-campaign spend FACT) ⨝ brain_silver.silver_campaign (the
campaign DIMENSION, for the latest name) ⨝ brain_gold.gold_attribution_credit (the attribution credit
ledger, for attributed_revenue_minor — read ONLY IF that Iceberg Gold mart exists; else attributed=0). This
is the Gold materialization of the TS computeCampaignRoas signal (attribution-campaign-roas.ts), aggregated
to the campaign grain.

Money math (mirrors the TS exactly, integer minor units, per-currency — NEVER blend currencies):
  spend_minor       = Σ spend_minor per (brand, platform, campaign_id, currency) from silver_marketing_spend.
  attributed_minor  = Σ credited_revenue_minor (signed — net of clawback) per (brand, campaign_id, currency)
                      from gold_attribution_credit (joined on campaign_id + currency; 0 when the credit mart
                      is absent or has no rows for the campaign).
  roas_bps          = attributed_minor * 10000 / spend_minor (integer bps; NULL when spend=0 — honest, the
                      TS returns null roasRatio for spend=0, NEVER a fabricated ∞ / divide-by-zero).
  ctr_bps           = clicks * 10000 / impressions (integer bps; NULL when impressions=0).
  cpc_minor         = spend_minor / clicks (integer minor units; NULL when clicks=0).

Platform-reported VALIDATION measures (side-by-side with the Brain-attributed signal above — the platform's
own conversion value is a validation/reconciliation aid, NEVER a replacement for Brain attribution):
  platform_conv_value_minor = Σ conv_value_minor (bigint MINOR, shares currency_code, never blended) from
                      silver_marketing_spend — the platform-reported attributed REVENUE. NULL when no spend
                      row carries it (older rows lack the prop; absence stays NULL, never fabricated 0).
  platform_roas     = platform_conv_value_minor / spend_minor (double ratio; NULL when spend_minor=0 OR
                      platform_conv_value_minor is NULL — honest, never a fabricated ∞ / divide-by-zero).

GRAIN   : 1 row per (brand_id, platform, campaign_id, currency_code). brand_id first column + partition anchor.
REPLAY-SAFE: full recompute from Silver(+optional Gold credit), MERGE-UPDATE'd on the PK.

DATA NOTE: current Bronze has ZERO spend.live.v1 → silver_marketing_spend / silver_campaign are empty → this
writes a correct EMPTY Gold mart today; it populates with no code change once an ad connector syncs spend.
"""
from __future__ import annotations

import os

from _gold_base import CATALOG, GOLD_NAMESPACE, ensure_gold_table, merge_on_pk, run_job, silver
from pyspark.sql import SparkSession

TABLE = "gold_campaign_performance"

# The attribution credit Iceberg Gold mart (owned by another Phase-2 group). Read OPTIONALLY — if absent,
# attributed revenue folds to 0 (the campaign-performance mart still materializes spend/CTR/CPC).
ATTR_CREDIT_TABLE = f"{CATALOG}.{GOLD_NAMESPACE}.gold_attribution_credit"

COLUMNS_SQL = """
          brand_id          string    NOT NULL,
          platform          string    NOT NULL,
          campaign_id       string    NOT NULL,
          currency_code     string    NOT NULL,
          campaign_name     string,
          spend_minor       bigint    NOT NULL,
          impressions       bigint    NOT NULL,
          clicks            bigint    NOT NULL,
          attributed_minor  bigint    NOT NULL,
          ctr_bps           bigint,
          cpc_minor         bigint,
          roas_bps          bigint,
          platform_conv_value_minor bigint,
          platform_roas             double,
          updated_at        timestamp NOT NULL
""".strip("\n")


def _attr_credit_available(spark: SparkSession) -> bool:
    """True iff the gold_attribution_credit Iceberg mart exists (read it for attributed revenue if so)."""
    try:
        spark.table(ATTR_CREDIT_TABLE).schema
        return True
    except Exception:  # noqa: BLE001 — absent → attributed revenue folds to 0 (still a valid mart).
        return False


def build(spark):
    fqtn = ensure_gold_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)"
    )

    have_attr = _attr_credit_available(spark)
    # Per-(brand, campaign_id, currency) attributed revenue — net of clawback (signed credited_revenue_minor),
    # exactly as computeCampaignRoas. When the credit mart is absent, an empty CTE keeps attributed_minor=0.
    attr_cte = (
        f"""
        attr AS (
            SELECT brand_id, campaign_id, currency_code,
                   COALESCE(SUM(credited_revenue_minor), 0) AS attributed_minor
            FROM {ATTR_CREDIT_TABLE}
            WHERE campaign_id IS NOT NULL
            GROUP BY brand_id, campaign_id, currency_code
        )
        """
        if have_attr
        else """
        attr AS (
            SELECT CAST(NULL AS string) AS brand_id, CAST(NULL AS string) AS campaign_id,
                   CAST(NULL AS string) AS currency_code, CAST(0 AS bigint) AS attributed_minor
            WHERE 1 = 0
        )
        """
    )

    staged = spark.sql(
        f"""
        WITH spend AS (
            SELECT
                brand_id,
                COALESCE(platform, 'unknown')              AS platform,
                campaign_id,
                COALESCE(currency_code, 'INR')             AS currency_code,
                MAX(campaign_name)                         AS spend_campaign_name,
                COALESCE(SUM(COALESCE(spend_minor, 0)), 0) AS spend_minor,
                COALESCE(SUM(COALESCE(impressions, 0)), 0) AS impressions,
                COALESCE(SUM(COALESCE(clicks, 0)), 0)      AS clicks,
                -- Platform-reported attributed revenue (bigint MINOR, shares currency_code). NOT coalesced:
                -- SUM over all-NULL stays NULL so platform_roas honestly reports "no platform value", not 0.
                SUM(conv_value_minor)                      AS platform_conv_value_minor
            FROM {silver('silver_marketing_spend')}
            WHERE brand_id IS NOT NULL AND campaign_id IS NOT NULL AND campaign_id <> ''
            GROUP BY brand_id, COALESCE(platform, 'unknown'), campaign_id, COALESCE(currency_code, 'INR')
        ),
        dim AS (
            SELECT brand_id, platform, campaign_id, campaign_name AS dim_campaign_name
            FROM {silver('silver_campaign')}
        ),
        {attr_cte}
        SELECT
            spend.brand_id,
            spend.platform,
            spend.campaign_id,
            spend.currency_code,
            COALESCE(dim.dim_campaign_name, spend.spend_campaign_name) AS campaign_name,
            spend.spend_minor,
            spend.impressions,
            spend.clicks,
            COALESCE(attr.attributed_minor, 0)                        AS attributed_minor,
            CASE WHEN spend.impressions > 0
                 THEN CAST(spend.clicks AS bigint) * 10000 / spend.impressions
                 ELSE NULL END                                       AS ctr_bps,
            CASE WHEN spend.clicks > 0
                 THEN spend.spend_minor / spend.clicks
                 ELSE NULL END                                       AS cpc_minor,
            -- ROAS in integer bps; NULL when spend=0 (honest — never a fabricated ∞).
            CASE WHEN spend.spend_minor > 0
                 THEN COALESCE(attr.attributed_minor, 0) * 10000 / spend.spend_minor
                 ELSE NULL END                                       AS roas_bps,
            -- Platform-reported VALIDATION measures, side-by-side with the Brain-attributed roas_bps above
            -- (validation/reconciliation aid, NEVER a replacement for Brain attribution). conv value is
            -- bigint MINOR sharing currency_code (never blended); platform_roas is a double ratio, NULL when
            -- spend=0 or the platform reported no conv value (honest — never a fabricated ∞).
            spend.platform_conv_value_minor                          AS platform_conv_value_minor,
            CASE WHEN spend.spend_minor > 0 AND spend.platform_conv_value_minor IS NOT NULL
                 THEN CAST(spend.platform_conv_value_minor AS double) / CAST(spend.spend_minor AS double)
                 ELSE NULL END                                       AS platform_roas,
            current_timestamp()                                      AS updated_at
        FROM spend
        LEFT JOIN dim  ON spend.brand_id = dim.brand_id
                       AND spend.platform = dim.platform
                       AND spend.campaign_id = dim.campaign_id
        LEFT JOIN attr ON spend.brand_id = attr.brand_id
                       AND spend.campaign_id = attr.campaign_id
                       AND spend.currency_code = attr.currency_code
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "platform", "campaign_id", "currency_code"], delete_orphans=True)  # AUD-IMPL-012: full per-brand recompute — shed disappeared-group orphans
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-campaign-performance", build, entity_incremental={
        "table_name": "gold_campaign_performance", "source_tables": ["silver_marketing_spend", "silver_campaign"],
    })
