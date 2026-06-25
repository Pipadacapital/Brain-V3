"""
silver_journey.py — NET-NEW canonical Silver `journey` ENTITY (Brain V4 Phase 1, GROUP new-entities).

NO dbt predecessor (parity status=NEW). dbt has silver_touchpoint (the TOUCH grain — 1 row per event) and
int_touchpoint_sessionized (the sessionized touch). This is the JOURNEY ENTITY grain — exactly 1 row per
(brand_id, brain_anon_id): the reconstructed visitor journey summary (first/last touch, first/last channel,
touch + session counts, conversion signal). The entity a journey/attribution reader joins to answer
"who is this visitor and how did they arrive" without re-folding every touch. (Brain rule: journey before
attribution; deterministic first.)

SOURCE  : rest.brain_bronze.collector_events — the journey touch events (same set stg_touchpoint_events
          reads: page.viewed / product.viewed / collection.viewed / cart.* / checkout.* / payment.* /
          order.placed / search.submitted / coupon.applied / form.submitted / user.* / *.click / scroll.depth).
GRAIN   : 1 row per (brand_id, brain_anon_id). Rows with NULL brain_anon_id CANNOT be sessionized (no
          journey key) and are DROPPED (the same honest drop stg_touchpoint_events does) — we NEVER
          synthesize an anon id.
CHANNEL : first/last channel via the SAME deterministic CASE ladder as int_touchpoint_sessionized
          (click_id → utm.medium → referrer → direct). NEVER a model (D-5 / deterministic-first).
CONVERSION: converted = the anon emitted any of payment.succeeded / order.placed / purchase.completed.
PII     : brain_anon_id is a pseudonymous id (not raw PII). No raw contact/financial identifier here.
MONEY   : none — the journey entity carries no money (revenue truth stays in the order/settlement marts).
ISOLATION: brand_id first column + bucket() partition anchor.

DATA AVAILABILITY (this session): current Bronze HAS journey touches (page.viewed=302, product.viewed=207,
…) BUT only the SDK-instrumented subset carries brain_anon_id, so the journey-entity row count == the
distinct keyed-anon count (honest; un-keyed touches are dropped, mirroring dbt). Parity status=NEW (no dbt
journey-entity predecessor to compare against).
"""
from __future__ import annotations

from _silver_base import ensure_silver_table, merge_on_pk, prop, read_bronze_events, run_job
from pyspark.sql import functions as F
from pyspark.sql.functions import coalesce, col, lit, lower, when
from pyspark.sql.window import Window

TABLE = "silver_journey"

# Same captured behavioral set as stg_touchpoint_events (feat-universal-pixel).
JOURNEY_EVENTS = [
    "page.viewed", "product.viewed", "collection.viewed", "cart.viewed", "cart.item_added",
    "cart.item_removed", "cart.updated", "search.submitted", "checkout.started", "checkout.step_viewed",
    "checkout.shipping_selected", "payment.initiated", "payment.succeeded", "payment.failed",
    "order.placed", "purchase.completed", "coupon.applied", "form.submitted", "user.logged_in",
    "user.signed_up", "identify", "scroll.depth", "element.clicked", "rage.click", "dead.click",
]
CONVERSION_EVENTS = {"payment.succeeded", "order.placed", "purchase.completed"}

COLUMNS_SQL = """
          brand_id          string    NOT NULL,
          brain_anon_id     string    NOT NULL,
          first_touch_at    timestamp NOT NULL,
          last_touch_at     timestamp NOT NULL,
          first_channel     string,
          last_channel      string,
          first_utm_source  string,
          first_utm_campaign string,
          landing_path      string,
          touch_count       bigint    NOT NULL,
          session_count     bigint    NOT NULL,
          converted         boolean   NOT NULL,
          is_synthetic      boolean,
          updated_at        timestamp NOT NULL
""".strip("\n")


def _channel():
    """The deterministic channel ladder — byte-identical to int_touchpoint_sessionized (NEVER a model)."""
    def nz(name):
        return col(name).isNotNull() & (col(name) != "")
    medium = lower(coalesce(col("utm_medium"), lit("")))
    return (
        when(nz("fbclid"), lit("paid_meta"))
        .when(nz("gclid") | nz("gbraid") | nz("wbraid") | nz("dclid"), lit("paid_google"))
        .when(nz("ttclid"), lit("paid_tiktok"))
        .when(nz("msclkid"), lit("paid_bing"))
        .when(medium.isin("cpc", "ppc", "paid"), lit("paid"))
        .when(medium == "email", lit("email"))
        .when(medium.isin("social", "paid_social"), lit("organic_social"))
        .when(medium == "referral", lit("referral"))
        .when(nz("referrer"), lit("referral"))
        .otherwise(lit("direct"))
    )


def build(spark):
    fqtn = ensure_silver_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(first_touch_at)"
    )

    raw = read_bronze_events(spark, JOURNEY_EVENTS)
    touches = (
        raw.select(
            col("brand_id"),
            col("event_id"),
            col("event_type"),
            col("occurred_at"),
            prop("pj", "brain_anon_id").alias("brain_anon_id"),
            prop("pj", "session_id").alias("session_id_raw"),
            prop("pj", "utm.source").alias("utm_source"),
            prop("pj", "utm.medium").alias("utm_medium"),
            prop("pj", "utm.campaign").alias("utm_campaign"),
            prop("pj", "click_ids.fbclid").alias("fbclid"),
            prop("pj", "click_ids.gclid").alias("gclid"),
            prop("pj", "click_ids.ttclid").alias("ttclid"),
            prop("pj", "click_ids.msclkid").alias("msclkid"),
            prop("pj", "click_ids.gbraid").alias("gbraid"),
            prop("pj", "click_ids.wbraid").alias("wbraid"),
            prop("pj", "click_ids.dclid").alias("dclid"),
            prop("pj", "referrer").alias("referrer"),
            prop("pj", "landing_path").alias("landing_path"),
            when(prop("pj", "_synthetic") == "true", lit(True)).otherwise(lit(False)).alias("is_synthetic"),
        )
        # Honest drop: no journey key → cannot sessionize (mirror stg_touchpoint_events).
        .where(col("brain_anon_id").isNotNull() & (col("brain_anon_id") != ""))
        # Dedup the Bronze idempotency key first (re-delivered event_id collapses to one touch).
        .withColumn(
            "_dedup_rn",
            F.row_number().over(Window.partitionBy("brand_id", "event_id").orderBy(col("occurred_at").asc())),
        )
        .where(col("_dedup_rn") == 1)
        .drop("_dedup_rn")
        .withColumn("channel", _channel())
        .withColumn("is_conversion", col("event_type").isin(*CONVERSION_EVENTS))
        # Server-side 30-min sessionization (re-derived from Bronze, not the client clock) → session_seq.
        .withColumn(
            "_prev",
            F.lag("occurred_at").over(Window.partitionBy("brand_id", "brain_anon_id").orderBy(col("occurred_at").asc())),
        )
        .withColumn(
            "_session_start",
            when(col("_prev").isNull(), lit(1))
            .when((col("occurred_at").cast("long") - col("_prev").cast("long")) > 1800, lit(1))
            .otherwise(lit(0)),
        )
        .withColumn(
            "session_seq",
            F.sum("_session_start").over(
                Window.partitionBy("brand_id", "brain_anon_id").orderBy(col("occurred_at").asc())
                .rowsBetween(Window.unboundedPreceding, Window.currentRow)
            ),
        )
    )

    asc = Window.partitionBy("brand_id", "brain_anon_id").orderBy(col("occurred_at").asc(), col("event_id").asc())
    desc = Window.partitionBy("brand_id", "brain_anon_id").orderBy(col("occurred_at").desc(), col("event_id").desc())
    enriched = (
        touches
        .withColumn("_first", F.row_number().over(asc))
        .withColumn("_last", F.row_number().over(desc))
        .withColumn("_first_channel", F.first(col("channel")).over(asc.rowsBetween(Window.unboundedPreceding, Window.currentRow)))
    )

    # Aggregate to the journey-entity grain (1 row per anon).
    agg = enriched.groupBy("brand_id", "brain_anon_id").agg(
        F.min("occurred_at").alias("first_touch_at"),
        F.max("occurred_at").alias("last_touch_at"),
        F.max(when(col("_first") == 1, col("channel"))).alias("first_channel"),
        F.max(when(col("_last") == 1, col("channel"))).alias("last_channel"),
        F.max(when(col("_first") == 1, col("utm_source"))).alias("first_utm_source"),
        F.max(when(col("_first") == 1, col("utm_campaign"))).alias("first_utm_campaign"),
        F.max(when(col("_first") == 1, col("landing_path"))).alias("landing_path"),
        F.count(lit(1)).alias("touch_count"),
        F.countDistinct("session_seq").alias("session_count"),
        F.max(when(col("is_conversion"), lit(True)).otherwise(lit(False))).alias("converted"),
        F.max(col("is_synthetic")).alias("is_synthetic"),
    )

    staged = agg.withColumn("updated_at", F.current_timestamp())
    merge_on_pk(spark, fqtn, staged, ["brand_id", "brain_anon_id"], order_by_desc=["last_touch_at"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-journey", build)
