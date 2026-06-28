"""
silver_ad_account.py — GAP canonical Silver `ad_account` entity (Brain V4 Phase 1b, GROUP payments/logistics).

NO dbt predecessor (parity status=NEW). The ad-ACCOUNT DIMENSION — exactly ONE row per
(brand_id, platform, ad_account_id): the connected advertising account a brand spends through. This is the
root of the ad hierarchy (account → campaign → adset → ad/creative); silver_campaign is the campaign
dimension below it and silver_marketing_spend is the per-day spend fact. A CAC / spend / attribution reader
joins here to answer "which ad accounts is this brand actually running, in what currency/timezone, and what
is the lifetime spend per account" — exactly the grain the activated-ad-account model (migration 0106
`activated_at`: ingest only the ONE ad account a brand picks) needs normalized for analytics.

SOURCE  : rest.brain_bronze.collector_events WHERE event_type = 'spend.live.v1'
          (server-trusted spend bridge — @brain/ad-spend-mapper SpendEventProperties. brand_id is
           server-derived from the connector row, MT-1, NEVER read from the ad-platform payload.)
GRAIN   : 1 row per (brand_id, platform, ad_account_id). Lifetime rollup of spend/impressions/clicks +
          first/last seen + the account's reporting currency and stat timezone. ad_account_id NOT NULL (a
          spend row with no resolvable account id is dropped from the account dimension).
MONEY   : lifetime_spend_minor is bigint MINOR units (integer paisa, I-S07) + currency_code (the account's
          reporting currency — accounts are single-currency by platform contract).
PII     : none — platform/account/campaign ids are operational refs (I-S02), not person-linkable.
ISOLATION: brand_id is the first column + the bucket() partition anchor (tenant key on every row).

STAGE-1 GATE (Brain V4 two-stage): this job now runs the Stage-1 DQ gate _silver_technical.dq_check over
  the rolled-up account dimension BEFORE the canonical MERGE: an account whose lifetime_spend_minor is
  negative/non-integer, or whose currency_code is not ISO-4217 alpha-3 (UPPERCASE), is diverted to
  brain_silver.silver_quarantine (stage='dq') and NEVER written to silver_ad_account; Bronze keeps the
  original (replay-safe: fix + re-run re-admits). Only money+currency are gated — last_seen_at is an
  AGGREGATE max (not a raw event ts), so the timestamp rule is intentionally not applied at this grain
  (mirrors silver_customer's aggregate currency gate). Good rows are byte-identical (parity-faithful).

ACCOUNT-ID RESOLUTION: the ad-account id is read from the spend payload's `ad_account_id` (preferred) or
`account_id` property. Today the @brain/ad-spend-mapper does NOT yet stamp the activated account id onto
each spend.live.v1 row (the spend hierarchy in Bronze is campaign→adset→ad, with campaign-level
parent_id=NULL — the account root is held at the connector layer, the activated-ad-account row). This job
is written so that the moment the spend mapper carries the activated `ad_account_id` (the natural next step
of the migration-0106 activation model — it already knows the single activated account at sync time), this
dimension populates with NO code change. Until then the account id is absent in Bronze → 0 rows is the
honest, correct output (data-thin), exactly like the Phase-1 settlement/campaign empty-table case.

Idempotency: a full GROUP BY over current Bronze spend is deterministic; we MERGE the recomputed dimension
on the PK (UPDATE the lifetime rollup + latest currency/timezone, INSERT new accounts). Re-running over the
same Bronze yields identical rows (replay-safe). Lifetime sums are a FULL recompute (not an incremental
add), so the MERGE UPDATE is the authoritative latest rollup — never double-counts. Parity status=NEW.
"""
from __future__ import annotations

from _silver_base import ensure_silver_table, merge_on_pk, prop, read_bronze_events, run_job
from _silver_technical import dq_violations_udf, write_quarantine
from pyspark.sql import functions as F
from pyspark.sql.functions import array_join, coalesce, col, lit, size, struct, to_json
from pyspark.sql.window import Window

TABLE = "silver_ad_account"

SPEND_EVENT = "spend.live.v1"

COLUMNS_SQL = """
          brand_id              string    NOT NULL,
          platform              string    NOT NULL,
          ad_account_id         string    NOT NULL,
          account_timezone      string,
          lifetime_spend_minor  bigint    NOT NULL,
          currency_code         string    NOT NULL,
          lifetime_impressions  bigint,
          lifetime_clicks       bigint,
          campaign_count        bigint,
          first_seen_at         timestamp,
          last_seen_at          timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_silver_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(last_seen_at)"
    )

    raw = read_bronze_events(spark, [SPEND_EVENT])
    typed = raw.select(
        col("brand_id"),
        coalesce(prop("pj", "platform"), lit("unknown")).alias("platform"),
        # Resolve the account id: prefer ad_account_id, fall back to account_id (forward-compatible with
        # the activated-ad-account stamping). Drop rows where neither is present (no account dimension).
        coalesce(prop("pj", "ad_account_id"), prop("pj", "account_id")).alias("ad_account_id"),
        prop("pj", "account_timezone").alias("account_timezone"),
        coalesce(prop("pj", "spend_minor").cast("bigint"), lit(0).cast("bigint")).alias("spend_minor"),
        coalesce(prop("pj", "currency_code"), lit("INR")).alias("currency_code"),
        coalesce(prop("pj", "impressions").cast("bigint"), lit(0).cast("bigint")).alias("impressions"),
        coalesce(prop("pj", "clicks").cast("bigint"), lit(0).cast("bigint")).alias("clicks"),
        prop("pj", "campaign_id").alias("campaign_id"),
        col("occurred_at"),
        col("ingested_at"),
    ).where(col("ad_account_id").isNotNull() & (col("ad_account_id") != ""))

    # Latest currency / timezone for the account (by occurred_at) — accounts are single-currency, but a
    # re-pull could restate; take the most recent verbatim.
    latest_win = F.row_number().over(
        Window.partitionBy("brand_id", "platform", "ad_account_id").orderBy(col("occurred_at").desc())
    )
    latest_meta = (
        typed.withColumn("_rn", latest_win)
        .where(col("_rn") == 1)
        .select(
            "brand_id", "platform", "ad_account_id",
            col("currency_code").alias("latest_ccy"),
            col("account_timezone").alias("latest_tz"),
        )
    )

    rollup = typed.groupBy("brand_id", "platform", "ad_account_id").agg(
        F.sum("spend_minor").alias("lifetime_spend_minor"),
        F.sum("impressions").alias("lifetime_impressions"),
        F.sum("clicks").alias("lifetime_clicks"),
        F.countDistinct("campaign_id").alias("campaign_count"),
        F.min("occurred_at").alias("first_seen_at"),
        F.max("occurred_at").alias("last_seen_at"),
    )

    # The groupBy makes (brand_id, platform, ad_account_id) unique → merge_on_pk's in-batch dedup is a
    # no-op; last_seen_at is the deterministic order column. Final column set == the table schema.
    staged = (
        rollup.join(latest_meta, ["brand_id", "platform", "ad_account_id"], "left")
        .select(
            col("brand_id"),
            col("platform"),
            col("ad_account_id"),
            col("latest_tz").alias("account_timezone"),
            col("lifetime_spend_minor"),
            coalesce(col("latest_ccy"), lit("INR")).alias("currency_code"),
            col("lifetime_impressions"),
            col("lifetime_clicks"),
            col("campaign_count"),
            col("first_seen_at"),
            col("last_seen_at"),
        )
    )

    # ── Stage-1 DQ gate: the account money rollup must be a non-negative integer minor amount in a valid
    # ISO-4217 currency. Violations → silver_quarantine (stage='dq'), NEVER silver_ad_account. occurred_at
    # is omitted (last_seen_at is an aggregate, not a raw event ts). brand_id-first; payload carries the
    # rolled-up grain so the quarantine row is self-describing/replayable.
    gated = staged.withColumn(
        "_dq",
        dq_violations_udf()(col("lifetime_spend_minor"), col("currency_code"), lit(None).cast("string")),
    )
    write_quarantine(
        spark,
        gated.where(size(col("_dq")) > 0).select(
            col("brand_id"),
            lit(SPEND_EVENT).alias("source"),
            col("ad_account_id").alias("bronze_event_id"),
            lit(TABLE).alias("canonical_target"),
            array_join(col("_dq"), ",").alias("reason"),
            to_json(
                struct("brand_id", "platform", "ad_account_id", "lifetime_spend_minor", "currency_code")
            ).alias("payload"),
        ),
        stage="dq",
    )
    good = gated.where(size(col("_dq")) == 0).drop("_dq")

    merge_on_pk(
        spark, fqtn, good,
        ["brand_id", "platform", "ad_account_id"],
        order_by_desc=["last_seen_at"],
    )
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-ad-account", build, target_table="silver_ad_account")
