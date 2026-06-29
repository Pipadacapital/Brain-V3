"""
gold_campaign_attribution.py — NET-NEW Gold `campaign_attribution` mart (Brain V4 Phase 2): per-CAMPAIGN,
per-MODEL attributed-revenue + ROAS overlay.

WHY (the gap #32c closes): the live read path exposes attribution at the CHANNEL grain only
(metric-engine getAttributionByChannel over gold_attribution_credit). There is no campaign-grain ROAS
surface — gold_campaign_performance carries spend/CTR/CPC + a single blended attributed_minor (summed
across ALL models, which is only safe today because the credit ledger is empty). This mart is the proper
per-campaign attribution surface: one row per (brand_id, platform, campaign_id, model_id, currency_code)
holding the Brain-attributed revenue (from the attribution credit ledger), the campaign spend (from
gold_campaign_performance / silver_marketing_spend), and the integer-bps ROAS — so the Marketing UI can
show ROAS per campaign, switchable by attribution model.

GRAIN — (brand_id, platform, campaign_id, model_id, currency_code). The handoff names the logical grain
(brand_id, platform, campaign_id); model_id + currency_code are REQUIRED grain extensions:
  - model_id: the credit ledger apportions the SAME realized revenue under EVERY attribution model
    (first_touch / last_touch / linear / position_based / time_decay / data_driven). Summing across
    models would 6×-count revenue. So attributed revenue is per-model; the read layer picks a default
    model (e.g. position_based) and lets the user switch. brand_id is pk[0] (tenant key, V4 rule 5).
  - currency_code: money is per-currency, NEVER blended (V4 rule 5). Spend and attributed revenue are
    JOINED on currency_code — when a campaign's ad spend currency differs from the order revenue currency
    the spend does not attach (spend_minor=0, roas_bps=NULL): honest, never a cross-currency ROAS.

SOURCES:
  ATTRIBUTED REVENUE — brain_gold.gold_attribution_credit (the SIGNED credit ledger; SUM(credited_revenue_minor)
    nets clawback). Campaign comes from the credit row's campaign_id (carried from the touchpoint utm_campaign).
    Read OPTIONALLY — if the credit Iceberg mart is absent the mart writes EMPTY (no fabricated rows).
  SPEND + PLATFORM + NAME — brain_gold.gold_campaign_performance (#29: the per-campaign spend surface; one
    row per (brand,platform,campaign,currency) with spend_minor + campaign_name). If that sibling Gold mart
    is absent we fall back to aggregating silver_marketing_spend directly (same numbers) so this job never
    hard-depends on Gold→Gold refresh ordering. NOTE: this makes gold_campaign_performance / its serving view
    mv_gold_campaign_performance a USED upstream — it is excluded from any view prune.

MONEY MATH (integer minor units, per-currency, NEVER float / blended — mirrors computeCampaignRoas):
  attributed_revenue_minor = Σ credited_revenue_minor (signed, net of clawback) per (brand,campaign,model,currency).
  spend_minor              = the campaign's spend (from gold_campaign_performance / silver_marketing_spend).
  roas_bps                 = attributed_revenue_minor * 10000 DIV spend_minor (integer BASIS POINTS; NULL when
                             spend_minor=0 — honest, the TS returns null roasRatio for spend=0, NEVER a
                             fabricated ∞ / divide-by-zero). Read-time ratio = roas_bps / 10000.0.

The mart is attribution-DRIVEN (LEFT JOIN attr → spend): a campaign with spend but no attributed revenue
yet simply has NO row here (the spend still shows via gold_campaign_performance) — honest, never a
fabricated zero-attribution row. A campaign with attribution but no matching spend keeps spend_minor=0 /
roas_bps=NULL.

GRAIN-PK: (brand_id, platform, campaign_id, model_id, currency_code). REPLAY-SAFE: full recompute from the
ledger(+spend), MERGE-UPDATE'd on the PK. ADDITIVE / non-breaking: repoints NO reader, changes NO app code,
writes ONLY brain_gold.gold_campaign_attribution.

DATA NOTE: current Bronze has 0 spend rows + 0 stitched journeys → 0 credit rows → this writes a correct
EMPTY mart today; it populates with no code change once an ad connector syncs spend AND journeys stitch.
"""
from __future__ import annotations  # Spark image is Python 3.8.

from _gold_base import CATALOG, GOLD_NAMESPACE, ensure_gold_table, merge_on_pk, run_job, silver, silver_exists
from pyspark.sql import SparkSession

TABLE = "gold_campaign_attribution"

# The attribution credit Iceberg Gold mart (#owned by the attribution group). REQUIRED source — if absent,
# this mart writes EMPTY (no attributed revenue → no campaign-attribution rows, honest).
ATTR_CREDIT_TABLE = f"{CATALOG}.{GOLD_NAMESPACE}.gold_attribution_credit"
# The per-campaign spend surface (#29). PREFERRED spend source; falls back to silver_marketing_spend.
CAMPAIGN_PERF_TABLE = f"{CATALOG}.{GOLD_NAMESPACE}.gold_campaign_performance"

# Row kinds that carry signed money in the credit ledger (credit = positive apportionment, clawback =
# the signed-negative reversal). Summing credited_revenue_minor over both nets the clawback exactly.
_MONEY_ROW_KINDS = ("credit", "clawback")

COLUMNS_SQL = """
          brand_id                 string    NOT NULL,
          platform                 string    NOT NULL,
          campaign_id              string    NOT NULL,
          model_id                 string    NOT NULL,
          currency_code            string    NOT NULL,
          campaign_name            string,
          attributed_revenue_minor bigint    NOT NULL,
          spend_minor              bigint    NOT NULL,
          attributed_order_count   bigint    NOT NULL,
          roas_bps                 bigint,
          updated_at               timestamp NOT NULL
""".strip("\n")


def _table_exists(spark: SparkSession, fqtn: str) -> bool:
    try:
        spark.table(fqtn).schema
        return True
    except Exception:  # noqa: BLE001 — absent → caller degrades gracefully.
        return False


def _spend_cte(spark: SparkSession) -> str:
    """Spend/platform/name CTE. Prefer the pre-aggregated gold_campaign_performance (#29); if that sibling
    Gold mart is absent, aggregate silver_marketing_spend directly (identical numbers) so this job has no
    hard Gold→Gold ordering dependency. Either way: 1 row per (brand,platform,campaign,currency)."""
    if _table_exists(spark, CAMPAIGN_PERF_TABLE):
        return f"""
        spend AS (
            SELECT brand_id, platform, campaign_id, currency_code, campaign_name,
                   CAST(spend_minor AS bigint) AS spend_minor
            FROM {CAMPAIGN_PERF_TABLE}
            WHERE brand_id IS NOT NULL AND campaign_id IS NOT NULL AND campaign_id <> ''
        )
        """
    if silver_exists(spark, "silver_marketing_spend"):
        return f"""
        spend AS (
            SELECT
                brand_id,
                COALESCE(platform, 'unknown')              AS platform,
                campaign_id,
                COALESCE(currency_code, 'INR')             AS currency_code,
                MAX(campaign_name)                         AS campaign_name,
                COALESCE(SUM(COALESCE(spend_minor, 0)), 0) AS spend_minor
            FROM {silver('silver_marketing_spend')}
            WHERE brand_id IS NOT NULL AND campaign_id IS NOT NULL AND campaign_id <> ''
            GROUP BY brand_id, COALESCE(platform, 'unknown'), campaign_id, COALESCE(currency_code, 'INR')
        )
        """
    # No spend source at all → an empty spend CTE; every campaign-attribution row keeps spend_minor=0.
    return """
        spend AS (
            SELECT CAST(NULL AS string) AS brand_id, CAST(NULL AS string) AS platform,
                   CAST(NULL AS string) AS campaign_id, CAST(NULL AS string) AS currency_code,
                   CAST(NULL AS string) AS campaign_name, CAST(0 AS bigint) AS spend_minor
            WHERE 1 = 0
        )
        """


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # The credit ledger is the REQUIRED attribution source. Absent → write an empty (but valid) mart.
    if not _table_exists(spark, ATTR_CREDIT_TABLE):
        print(
            f"[gold_campaign_attribution] {ATTR_CREDIT_TABLE} absent — no attributed revenue → empty mart",
            flush=True,
        )
        return fqtn, spark.table(fqtn).count()

    row_kinds = ", ".join(f"'{k}'" for k in _MONEY_ROW_KINDS)

    staged = spark.sql(
        f"""
        WITH attr AS (
            -- Per (brand, campaign, model, currency) attributed revenue — SIGNED credited_revenue_minor
            -- nets clawback (computeCampaignRoas semantics). campaign_id from the touchpoint utm_campaign.
            SELECT
                brand_id,
                campaign_id,
                model_id,
                currency_code,
                COALESCE(SUM(credited_revenue_minor), 0) AS attributed_revenue_minor,
                COUNT(DISTINCT order_id)                 AS attributed_order_count
            FROM {ATTR_CREDIT_TABLE}
            WHERE campaign_id IS NOT NULL AND campaign_id <> ''
              AND row_kind IN ({row_kinds})
            GROUP BY brand_id, campaign_id, model_id, currency_code
        ),
        {_spend_cte(spark)}
        SELECT
            attr.brand_id,
            COALESCE(spend.platform, 'unknown')          AS platform,
            attr.campaign_id,
            attr.model_id,
            attr.currency_code,
            spend.campaign_name                          AS campaign_name,
            attr.attributed_revenue_minor                AS attributed_revenue_minor,
            COALESCE(spend.spend_minor, 0)               AS spend_minor,
            attr.attributed_order_count                  AS attributed_order_count,
            -- ROAS in integer BASIS POINTS; NULL when spend=0 (honest — never a fabricated ∞). Integer DIV
            -- keeps it bigint (no float money). Read-time ratio = roas_bps / 10000.0.
            CASE WHEN COALESCE(spend.spend_minor, 0) > 0
                 THEN (attr.attributed_revenue_minor * 10000) DIV spend.spend_minor
                 ELSE NULL END                           AS roas_bps,
            current_timestamp()                          AS updated_at
        FROM attr
        LEFT JOIN spend
               ON attr.brand_id      = spend.brand_id
              AND attr.campaign_id   = spend.campaign_id
              AND attr.currency_code = spend.currency_code
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "platform", "campaign_id", "model_id", "currency_code"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    # PARTITION-INCREMENTAL (partition = brand_id): recompute brands changed in any source (the credit
    # ledger / campaign performance / marketing spend). silver_marketing_spend reads are brand-filtered;
    # the recompute keeps parity. build() unchanged.
    run_job("gold-campaign-attribution", build, entity_incremental={
        "table_name": "gold_campaign_attribution",
        "source_tables": ["gold_attribution_credit", "gold_campaign_performance", "silver_marketing_spend"],
    })
