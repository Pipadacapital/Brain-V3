"""
silver_campaign.py — NET-NEW canonical Silver `campaign` entity (Brain V4 Phase 1, GROUP new-entities).

NO dbt predecessor (parity status=NEW). The conformed marketing-CAMPAIGN DIMENSION — one row per
(brand_id, platform, campaign_id) — distinct from silver_marketing_spend (the per-day spend FACT). This is
the entity a CAC / attribution reader joins to resolve "what campaign is this" (name, platform, first/last
seen, lifetime impressions/clicks/spend) without re-aggregating the spend fact every time.

SOURCE  : rest.brain_bronze.collector_events WHERE event_type = 'spend.live.v1'
          (server-trusted spend bridge — @brain/ad-spend-mapper SpendEventProperties: platform, campaign_id,
           campaign_name, spend_minor, impressions, clicks, currency_code. brand_id is server-derived, MT-1.)
GRAIN   : 1 row per (brand_id, platform, campaign_id) — collapses all per-day spend rows of a campaign into
          one dimension row (lifetime rollup + latest campaign_name). campaign_id NOT NULL (a spend row with
          no campaign_id is account/adset noise → dropped from the campaign dimension).
MONEY   : lifetime_spend_minor is bigint MINOR units + currency_code (the campaign's reporting currency).
ISOLATION: brand_id first column + bucket() partition anchor.

Idempotency: a full GROUP BY over current Bronze spend is deterministic; we MERGE the recomputed dimension
on the PK (UPDATE the lifetime rollup + latest name, INSERT new campaigns). Re-running over the same Bronze
yields identical rows (replay-safe). NOTE: lifetime sums are a FULL recompute from Bronze each run (not an
incremental add), so the MERGE UPDATE is the authoritative latest rollup — never double-counts.

DATA AVAILABILITY (this session): current Bronze has ZERO spend.live.v1 rows (no ad connector has emitted
spend to Bronze yet — spend rode the PG ledger historically), so this writes a correct EMPTY table. The UTM
campaign labels DO exist on touchpoints, but those are free-text utm.campaign strings with NO platform
campaign_id — they belong to silver_touchpoint / the journey entity, not this authoritative campaign
dimension. Parity status=NEW.
"""
from __future__ import annotations

from _silver_base import ensure_silver_table, merge_on_pk, prop, read_bronze_events, run_job
from pyspark.sql.functions import coalesce, col, lit
from pyspark.sql import functions as F
from pyspark.sql.window import Window

TABLE = "silver_campaign"

COLUMNS_SQL = """
          brand_id              string    NOT NULL,
          platform              string    NOT NULL,
          campaign_id           string    NOT NULL,
          campaign_name         string,
          lifetime_spend_minor  bigint    NOT NULL,
          currency_code         string    NOT NULL,
          lifetime_impressions  bigint,
          lifetime_clicks       bigint,
          first_seen_at         timestamp,
          last_seen_at          timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_silver_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(last_seen_at)"
    )

    raw = read_bronze_events(spark, ["spend.live.v1"])
    typed = raw.select(
        col("brand_id"),
        coalesce(prop("pj", "platform"), lit("unknown")).alias("platform"),
        prop("pj", "campaign_id").alias("campaign_id"),
        prop("pj", "campaign_name").alias("campaign_name"),
        coalesce(prop("pj", "spend_minor").cast("bigint"), lit(0).cast("bigint")).alias("spend_minor"),
        coalesce(prop("pj", "currency_code"), lit("INR")).alias("currency_code"),
        coalesce(prop("pj", "impressions").cast("bigint"), lit(0).cast("bigint")).alias("impressions"),
        coalesce(prop("pj", "clicks").cast("bigint"), lit(0).cast("bigint")).alias("clicks"),
        col("occurred_at"),
        col("ingested_at"),
    ).where(col("campaign_id").isNotNull() & (col("campaign_id") != ""))

    # Conform to the campaign-dimension grain: lifetime rollup + latest campaign_name (by occurred_at).
    name_win = F.row_number().over(
        Window.partitionBy("brand_id", "platform", "campaign_id").orderBy(col("occurred_at").desc())
    )
    latest_name = (
        typed.withColumn("_rn", name_win)
        .where(col("_rn") == 1)
        .select("brand_id", "platform", "campaign_id", col("campaign_name").alias("latest_name"), col("currency_code").alias("latest_ccy"))
    )

    rollup = typed.groupBy("brand_id", "platform", "campaign_id").agg(
        F.sum("spend_minor").alias("lifetime_spend_minor"),
        F.sum("impressions").alias("lifetime_impressions"),
        F.sum("clicks").alias("lifetime_clicks"),
        F.min("occurred_at").alias("first_seen_at"),
        F.max("occurred_at").alias("last_seen_at"),
        F.max("ingested_at").alias("_max_ingested"),
    )

    # The groupBy already makes (brand_id, platform, campaign_id) unique, so merge_on_pk's in-batch dedup
    # is a no-op here; last_seen_at is the deterministic order column. Final column set == the table schema.
    staged = (
        rollup.join(latest_name, ["brand_id", "platform", "campaign_id"], "left")
        .select(
            col("brand_id"),
            col("platform"),
            col("campaign_id"),
            col("latest_name").alias("campaign_name"),
            col("lifetime_spend_minor"),
            coalesce(col("latest_ccy"), lit("INR")).alias("currency_code"),
            col("lifetime_impressions"),
            col("lifetime_clicks"),
            col("first_seen_at"),
            col("last_seen_at"),
        )
    )

    merge_on_pk(
        spark, fqtn, staged,
        ["brand_id", "platform", "campaign_id"],
        order_by_desc=["last_seen_at"],
    )
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-campaign", build)
