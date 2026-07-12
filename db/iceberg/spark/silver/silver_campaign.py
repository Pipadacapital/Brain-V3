"""
silver_campaign.py — NET-NEW canonical Silver `campaign` entity (Brain V4 Phase 1, GROUP new-entities).

NO dbt predecessor (parity status=NEW). The conformed marketing-CAMPAIGN DIMENSION — one row per
(brand_id, platform, campaign_id) — distinct from silver_marketing_spend (the per-day spend FACT). This is
the entity a CAC / attribution reader joins to resolve "what campaign is this" (name, platform, first/last
seen, lifetime impressions/clicks/spend) without re-aggregating the spend fact every time.

SOURCE  : silver_collector_event for TWO event types (A1 revival):
          - 'spend.live.v1'    — the per-day spend FACT (@brain/ad-spend-mapper SpendEventProperties:
                                 platform, campaign_id, campaign_name, spend_minor, impressions, clicks,
                                 conversions, currency_code). Drives the lifetime rollup + the conversion
                                 count that arms the inactive-campaign rule.
          - 'ad.entity.updated' — the AUTHORITATIVE campaign-metadata feed emitted by the entity-sync job
                                 (Transport slices) and admitted to SERVER_TRUSTED (Admission slice). Carries
                                 the latest name/status/objective/advertising_channel_type per campaign,
                                 DECOUPLED from spend volume (a campaign without recent spend keeps a fresh
                                 name/status). brand_id is server-derived, MT-1 — never from the provider body.
          The entity feed is OPTIONAL: when not yet emitted/admitted the entity side is empty and the dim
          falls back to the spend-row name exactly as before (empty-safe revival).
GRAIN   : 1 row per (brand_id, platform, campaign_id) — collapses all per-day spend rows of a campaign into
          one dimension row (lifetime rollup + AUTHORITATIVE latest name/status/objective/channel). A campaign
          known from EITHER source gets a row (FULL OUTER); campaign_id NOT NULL (a spend row with no
          campaign_id is account/adset noise → dropped from the campaign dimension).
MONEY   : lifetime_spend_minor is bigint MINOR units + currency_code (the campaign's reporting currency).
ISOLATION: brand_id first column + bucket() partition anchor.

STAGE-1 GATE (Brain V4 two-stage): runs the spec BUSINESS rule "an inactive campaign cannot receive a
  conversion" as a FLAG, never a drop (the conversion is real data the attribution layer must SEE, not
  discard). The job derives is_active from the latest optional campaign_status property
  (active/enabled→true; paused/inactive/disabled/archived/removed→false; absent→unknown/null) and the
  campaign's summed conversions, then writes the additive boolean column
  received_conversion_while_inactive = _silver_technical.inactive_campaign_conversion_flag(is_active,
  conversions) — true ONLY when the campaign is EXPLICITLY inactive yet carries conversions (>0). Unknown
  status ⇒ false (every well-formed/legacy spend row is UNCHANGED). No row is quarantined here.

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
from _silver_technical import inactive_conversion_flag_udf
from pyspark.sql.functions import coalesce, col, lit, lower, when
from pyspark.sql import functions as F
from pyspark.sql.window import Window

TABLE = "silver_campaign"

# received_conversion_while_inactive is an ADDITIVE Stage-1 business FLAG (see module docstring): true iff
# the campaign is explicitly inactive yet carries conversions. false for every well-formed/unknown campaign.
# campaign_status / objective / advertising_channel_type are the AUTHORITATIVE dimension attributes sourced
# from the ad.entity.updated metadata feed (A1) — additive columns the create_iceberg_table reconciler
# ALTER-ADDs to the existing table. They are nullable (a campaign with spend but no entity row yet → null).
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
          last_seen_at          timestamp NOT NULL,
          received_conversion_while_inactive boolean,
          campaign_status            string,
          objective                  string,
          advertising_channel_type   string,
          -- ── FIREHOSE campaign entity depth (additive/nullable; ALTER-ADDed by the reconciler). ──
          advertising_channel_sub_type  string,
          bidding_strategy_type         string,
          start_date                    string,
          end_date                      string,
          campaign_budget_amount_minor  bigint
""".strip("\n")


def build(spark):
    fqtn = ensure_silver_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(last_seen_at)"
    )

    # A1 REVIVAL: read BOTH the per-day spend FACT (lifetime rollups + conversion counts) AND the
    # ad.entity.updated metadata feed (AUTHORITATIVE latest name/status/objective/channel — decoupled from
    # spend volume). When the entity feed isn't admitted/emitted yet, the entity side is simply empty and the
    # dim falls back to the spend-row name exactly as before (empty-safe).
    raw = read_bronze_events(spark, ["spend.live.v1", "ad.entity.updated"])

    # ── Spend FACT side: lifetime rollup + latest spend-row name (fallback) ───────────────────────────────
    spend = raw.where(col("event_type") == "spend.live.v1").select(
        col("brand_id"),
        coalesce(prop("pj", "platform"), lit("unknown")).alias("platform"),
        prop("pj", "campaign_id").alias("campaign_id"),
        prop("pj", "campaign_name").alias("campaign_name"),
        coalesce(prop("pj", "spend_minor").cast("bigint"), lit(0).cast("bigint")).alias("spend_minor"),
        coalesce(prop("pj", "currency_code"), lit("INR")).alias("currency_code"),
        coalesce(prop("pj", "impressions").cast("bigint"), lit(0).cast("bigint")).alias("impressions"),
        coalesce(prop("pj", "clicks").cast("bigint"), lit(0).cast("bigint")).alias("clicks"),
        # A1: the mapper now emits a first-class `conversions` count → the inactive-campaign rule can fire.
        coalesce(prop("pj", "conversions").cast("bigint"), lit(0).cast("bigint")).alias("conversions"),
        col("occurred_at"),
        col("ingested_at"),
    ).where(col("campaign_id").isNotNull() & (col("campaign_id") != ""))

    spend_name_win = F.row_number().over(
        Window.partitionBy("brand_id", "platform", "campaign_id").orderBy(col("occurred_at").desc())
    )
    latest_spend_name = (
        spend.withColumn("_rn", spend_name_win)
        .where(col("_rn") == 1)
        .select(
            "brand_id", "platform", "campaign_id",
            col("campaign_name").alias("spend_name"),
            col("currency_code").alias("spend_ccy"),
        )
    )

    rollup = spend.groupBy("brand_id", "platform", "campaign_id").agg(
        F.sum("spend_minor").alias("lifetime_spend_minor"),
        F.sum("impressions").alias("lifetime_impressions"),
        F.sum("clicks").alias("lifetime_clicks"),
        F.sum("conversions").alias("lifetime_conversions"),
        F.min("occurred_at").alias("first_seen_at"),
        F.max("occurred_at").alias("spend_last_seen"),
    )
    spend_side = rollup.join(latest_spend_name, ["brand_id", "platform", "campaign_id"], "left")

    # ── Entity DIMENSION side: ad.entity.updated, CAMPAIGN-level only → latest name/status/objective/channel.
    # campaign_id = the explicit campaign_id prop, else the entity_id (a campaign entity IS its own id).
    entity = raw.where(col("event_type") == "ad.entity.updated").select(
        col("brand_id"),
        coalesce(prop("pj", "platform"), lit("unknown")).alias("platform"),
        lower(prop("pj", "level")).alias("level"),
        coalesce(prop("pj", "campaign_id"), prop("pj", "entity_id")).alias("campaign_id"),
        prop("pj", "name").alias("entity_name"),
        lower(prop("pj", "status")).alias("entity_status"),
        prop("pj", "objective").alias("objective"),
        prop("pj", "advertising_channel_type").alias("advertising_channel_type"),
        # ── FIREHOSE campaign entity depth (additive; null on non-firehose/legacy entity rows). ──
        prop("pj", "advertising_channel_sub_type").alias("advertising_channel_sub_type"),
        prop("pj", "bidding_strategy_type").alias("bidding_strategy_type"),
        prop("pj", "campaign_start_date").alias("start_date"),
        prop("pj", "campaign_end_date").alias("end_date"),
        prop("pj", "campaign_budget_amount_minor").cast("bigint").alias("campaign_budget_amount_minor"),
        col("occurred_at").alias("entity_occurred_at"),
    ).where(
        (col("level") == "campaign")
        & col("campaign_id").isNotNull()
        & (col("campaign_id") != "")
    )

    entity_win = F.row_number().over(
        Window.partitionBy("brand_id", "platform", "campaign_id").orderBy(col("entity_occurred_at").desc())
    )
    latest_entity = (
        entity.withColumn("_rn", entity_win)
        .where(col("_rn") == 1)
        .select(
            "brand_id", "platform", "campaign_id",
            col("entity_name"),
            col("entity_status"),
            col("objective"),
            col("advertising_channel_type"),
            col("advertising_channel_sub_type"),
            col("bidding_strategy_type"),
            col("start_date"),
            col("end_date"),
            col("campaign_budget_amount_minor"),
            col("entity_occurred_at"),
        )
    )

    # ── Combine FULL OUTER so the dim reflects a campaign known from EITHER source (entity-only campaigns
    #    that have not yet spent still get a dimension row). Join on the key list → keys are coalesced.
    combined = spend_side.join(latest_entity, ["brand_id", "platform", "campaign_id"], "full_outer")

    # is_active from the AUTHORITATIVE entity status: explicit active/enabled→true, inactive set→false, else
    # null (unknown ⇒ never flagged ⇒ legacy/entity-less campaigns unchanged).
    is_active = (
        when(col("entity_status").isin("active", "enabled", "running"), lit(True))
        .when(col("entity_status").isin("paused", "inactive", "disabled", "archived", "removed", "ended"), lit(False))
        .otherwise(lit(None).cast("boolean"))
    )

    # last_seen_at = max event time across both sources (NOT NULL since a full-outer row has ≥1 source).
    last_seen = F.greatest(col("spend_last_seen"), col("entity_occurred_at"))

    staged = combined.select(
        col("brand_id"),
        col("platform"),
        col("campaign_id"),
        # AUTHORITATIVE name from the entity feed; spend-row name is the fallback.
        coalesce(col("entity_name"), col("spend_name")).alias("campaign_name"),
        coalesce(col("lifetime_spend_minor"), lit(0).cast("bigint")).alias("lifetime_spend_minor"),
        coalesce(col("spend_ccy"), lit("INR")).alias("currency_code"),
        col("lifetime_impressions"),
        col("lifetime_clicks"),
        coalesce(col("first_seen_at"), col("entity_occurred_at")).alias("first_seen_at"),
        coalesce(last_seen, col("spend_last_seen"), col("entity_occurred_at")).alias("last_seen_at"),
        coalesce(
            inactive_conversion_flag_udf()(is_active, coalesce(col("lifetime_conversions"), lit(0).cast("bigint"))),
            lit(False),
        ).alias("received_conversion_while_inactive"),
        col("entity_status").alias("campaign_status"),
        col("objective"),
        col("advertising_channel_type"),
        # ── FIREHOSE campaign entity depth (additive/nullable). budget is bigint MINOR (currency_code). ──
        col("advertising_channel_sub_type"),
        col("bidding_strategy_type"),
        col("start_date"),
        col("end_date"),
        col("campaign_budget_amount_minor"),
    )

    merge_on_pk(
        spark, fqtn, staged,
        ["brand_id", "platform", "campaign_id"],
        order_by_desc=["last_seen_at"],
    )
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-campaign", build, entity_incremental={
        "table_name": "silver_campaign", "event_types": ["spend.live.v1", "ad.entity.updated"], "entity_path": "$.properties.campaign_id",
    })
