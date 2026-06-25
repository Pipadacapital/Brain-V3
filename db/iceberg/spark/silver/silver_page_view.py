"""
silver_page_view.py — NET-NEW canonical Silver `page_view` behavior grain (Brain V4 Phase 1b, GROUP pixel-behavior).

NO dbt predecessor (parity status=NEW). The page-view BEHAVIOR grain — one row per browser page-view signal
from the universal first-party pixel, normalized to one analytics-facing shape. This is the
behavior/funnel-facing surface that powers the `behavior` and `funnel` dashboards (D-coverage matrix §2:
page.viewed/product.viewed/collection.viewed → silver_page_view). It is DISTINCT from silver_touchpoint
(the journey/attribution per-touch grain across the FULL behavioral event set) and silver_sessions (the
30-min session rollup): page_view is the raw page-impression fact (one row per view event) that
COUNT/COUNT-DISTINCT-over powers pageviews, product-views, collection-views, bounce, and entry-page metrics
without dragging the whole touchpoint surface in.

SOURCES (universal pixel, collector pixel-asset.route.ts auto-capture):
  - 'page.viewed'       — every SPA/full page load. carries page_type (product|collection|cart|search|other),
                          landing_path, referrer, utm.*, device.*, brain_anon_id, session_id.
  - 'product.viewed'    — a /products/<handle> page. + product_handle.
  - 'collection.viewed' — a /collections/<handle> page. + collection_handle.

GRAIN   : 1 row per (brand_id, event_id) — the Bronze idempotency key. page_event is the normalized
          discriminant (page | product | collection). Rows with no brain_anon_id are DROPPED (cannot
          attribute a page-view to a journey — same D-rule as stg_touchpoint_events).
MONEY   : NONE — a page-view is not monetary (no money column; behavior is impression-counting, the dbt
          touchpoint/sessions marts assert the same no-money posture).
PII     : hashed/anon-only — brain_anon_id is an opaque pseudonymous pixel id (NOT raw PII); session_id is a
          random per-visit uuid. utm/click-id values are campaign metadata, not contact identifiers. No raw
          email/phone/name ever rides through.
ISOLATION: brand_id first column + bucket(256, brand_id) partition anchor + days(occurred_at) for pruning.

CHANNEL: the deterministic channel ladder is reproduced verbatim from silver_touchpoint.py
         (fbclid→paid_meta, gclid/gbraid/wbraid/dclid→paid_google, utm_medium ladder, referrer→referral,
         else direct) so behavior-side channel attribution matches the journey-side touchpoint channel.

DATA AVAILABILITY (this session): current Bronze has page.viewed (613) + product.viewed (429) +
collection.viewed (114) rows → this writes a populated table. Parity status=NEW (no dbt baseline).
"""
from __future__ import annotations

from _silver_base import ensure_silver_table, merge_on_pk, prop, read_bronze_events, run_job
from pyspark.sql.functions import col, lit, lower, regexp_replace, when

TABLE = "silver_page_view"

PAGE_EVENTS = ["page.viewed", "product.viewed", "collection.viewed"]

COLUMNS_SQL = """
          brand_id          string    NOT NULL,
          event_id          string    NOT NULL,
          brain_anon_id     string    NOT NULL,
          session_id        string,
          page_event        string,
          page_type         string,
          path              string,
          referrer          string,
          referrer_host     string,
          channel           string,
          utm_source        string,
          utm_medium        string,
          utm_campaign      string,
          utm_term          string,
          utm_content       string,
          fbclid            string,
          gclid             string,
          ttclid            string,
          msclkid           string,
          gbraid            string,
          wbraid            string,
          dclid             string,
          product_handle    string,
          collection_handle string,
          device_class      string,
          viewport          string,
          occurred_at       timestamp NOT NULL,
          ingested_at       timestamp NOT NULL
""".strip("\n")


def _page_event(event_type_col):
    return (
        when(event_type_col == "page.viewed", lit("page"))
        .when(event_type_col == "product.viewed", lit("product"))
        .when(event_type_col == "collection.viewed", lit("collection"))
        .otherwise(lit("page"))
    )


def _channel(c):
    """Deterministic channel ladder — verbatim from silver_touchpoint.py so behavior- and journey-side agree."""

    def nz(name):
        v = c(name)
        return v.isNotNull() & (v != lit(""))

    return (
        when(nz("fbclid"), lit("paid_meta"))
        .when(nz("gclid") | nz("gbraid") | nz("wbraid") | nz("dclid"), lit("paid_google"))
        .when(nz("ttclid"), lit("paid_tiktok"))
        .when(nz("msclkid"), lit("paid_bing"))
        .when(lower(c("utm_medium")).isin("cpc", "ppc", "paid"), lit("paid"))
        .when(lower(c("utm_medium")) == lit("email"), lit("email"))
        .when(lower(c("utm_medium")).isin("social", "paid_social"), lit("organic_social"))
        .when(lower(c("utm_medium")) == lit("referral"), lit("referral"))
        .when(c("referrer").isNotNull() & (c("referrer") != lit("")), lit("referral"))
        .otherwise(lit("direct"))
    )


def build(spark):
    fqtn = ensure_silver_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(occurred_at)"
    )

    raw = read_bronze_events(spark, PAGE_EVENTS).select(
        col("brand_id"),
        col("event_id"),
        col("event_type"),
        prop("pj", "brain_anon_id").alias("brain_anon_id"),
        prop("pj", "session_id").alias("session_id"),
        prop("pj", "page_type").alias("page_type"),
        prop("pj", "landing_path").alias("path"),
        prop("pj", "referrer").alias("referrer"),
        prop("pj", "utm.source").alias("utm_source"),
        prop("pj", "utm.medium").alias("utm_medium"),
        prop("pj", "utm.campaign").alias("utm_campaign"),
        prop("pj", "utm.term").alias("utm_term"),
        prop("pj", "utm.content").alias("utm_content"),
        prop("pj", "click_ids.fbclid").alias("fbclid"),
        prop("pj", "click_ids.gclid").alias("gclid"),
        prop("pj", "click_ids.ttclid").alias("ttclid"),
        prop("pj", "click_ids.msclkid").alias("msclkid"),
        prop("pj", "click_ids.gbraid").alias("gbraid"),
        prop("pj", "click_ids.wbraid").alias("wbraid"),
        prop("pj", "click_ids.dclid").alias("dclid"),
        prop("pj", "product_handle").alias("product_handle"),
        prop("pj", "collection_handle").alias("collection_handle"),
        prop("pj", "device.ua_class").alias("device_class"),
        prop("pj", "device.viewport").alias("viewport"),
        col("occurred_at"),
        col("ingested_at"),
    )

    staged = (
        raw.withColumn("page_event", _page_event(col("event_type")))
        .withColumn(
            "referrer_host",
            when(
                col("referrer").isNotNull() & (col("referrer") != lit("")),
                regexp_replace(col("referrer"), "^[a-zA-Z]+://([^/]+).*$", "$1"),
            ).otherwise(lit(None).cast("string")),
        )
        .withColumn("channel", _channel(col))
        .select(
            "brand_id", "event_id", "brain_anon_id", "session_id", "page_event", "page_type",
            "path", "referrer", "referrer_host", "channel", "utm_source", "utm_medium",
            "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "ttclid", "msclkid",
            "gbraid", "wbraid", "dclid", "product_handle", "collection_handle", "device_class",
            "viewport", "occurred_at", "ingested_at",
        )
        # DROP page-views with no anon id — cannot tie to a journey (mirrors stg_touchpoint_events).
        .where(col("event_id").isNotNull() & col("brand_id").isNotNull() & col("brain_anon_id").isNotNull())
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "event_id"], order_by_desc=["ingested_at", "occurred_at"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-page-view", build)
