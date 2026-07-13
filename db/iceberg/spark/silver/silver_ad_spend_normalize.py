"""
silver_ad_spend_normalize.py — ADR-0006 P4: normalize RAW ad-spend rows (Meta + Google Ads) in Spark Silver.

Mirrors the Shopify exemplar (silver_shopify_order_normalize.py) EXACTLY in structure: read the RAW provider
Bronze, udf-wrap the shared/golden-verified ports, reconstruct the canonical envelope via to_json(struct),
and MERGE the silver_collector_event contract into a SHADOW table for dual-run parity.

Reads TWO raw Bronze tables (the Kafka Connect Iceberg sink output of the connector emitting verbatim
provider rows):
  - brain_bronze.meta_spend_raw    — verbatim Meta Ads Insights rows  (spend is a MAJOR-unit decimal string)
  - brain_bronze.google_spend_raw  — verbatim Google Ads SearchStream rows (cost_micros is integer micros)

Both platforms normalize into ONE canonical event — spend.live.v1 — with `envelope.source`/`properties.source`
discriminating meta vs google_ads (ADR-AD-4). This REPLACES the TS @brain/ad-spend-mapper
(mapMetaInsightToEvent + mapGoogleRowToEvent) normalization the connector used to do before emitting a
canonical event; the connector now emits the verbatim provider row and ALL normalization happens HERE
(ADR-0006 D3).

Output: the SAME column contract as silver_collector_event (the gated collector lane), so the downstream
silver_marketing_spend mart reads it with ZERO change — `payload` is the reconstructed canonical
spend.live.v1 envelope (event_name + properties.*), event_type='spend.live.v1', brand_id server-trusted
from the envelope ONLY (MT-1).

ASSUMED RAW SCHEMA (Kafka-Connect-sink envelope; verbatim provider object nested under one field, as in the
Shopify exemplar where the order sits under `order`). Field paths are module constants — adjust META_ROW /
GOOGLE_ROW if the sink lands them flat:
  meta_spend_raw:   brand_id, fetched_at, account_currency, account_timezone,
                    insight:{ level, campaign_id, campaign_name, adset_id, ad_id, spend, impressions,
                              clicks, date_start, actions }
  google_spend_raw: brand_id, fetched_at, account_currency, account_timezone,
                    row:{ level, campaign_id, campaign_name, ad_group_id, ad_id, cost_micros, impressions,
                          clicks, conversions, all_conversions, segments_date, currency_code }

MONEY: bigint MINOR units, never float; emitted as a numeric STRING in `spend_minor` with a sibling
  `currency_code`; per-currency, NEVER blended.  Meta major-decimal → minor (whole*100 + 2-dp frac);
  Google micros → minor (micros // 10_000) — integer arithmetic only.
PII: ad spend has NO contact PII (I-S02). Ad-identifiers (campaign/adset/ad ids + names) are OPERATIONAL
  references — stored un-hashed. There is NO per-brand salt / JDBC join here (unlike the Shopify exemplar).
ISOLATION: brand_id is the tenant key, first column, taken ONLY from the server-trusted envelope (MT-1) —
  never the provider body.

DUAL-RUN (P4): writes to a SHADOW table by default (TARGET_TABLE override) so parity can be checked against
the live canonical silver_collector_event spend rows before the connector cutover.

STAGE-1 GATE (Brain V4 two-stage): this normalizer previously DROPPED malformed rows SILENTLY via an inline
where-gate (event_id / spend_minor / occurred_at all non-null). That silent drop is now REPLACED by a routed
_silver_technical.write_quarantine (stage='dq') — the SAME admission set (good rows are byte-identical), but
the rejects are now OBSERVABLE and REPLAYABLE: a row whose event_id seed component is missing
(empty_identifier:event_id), whose money could not be normalized to minor units (non_integer_amount), or
whose stat_date is missing/unparseable (unparseable_timestamp) is appended to brain_silver.silver_quarantine
carrying the reconstructed canonical spend.live.v1 envelope as payload. Bronze keeps the verbatim raw row
(replay-safe: fix the mapper/data, re-run, it re-admits).

CORRECTNESS: every computed field goes through GOLDEN-VECTOR-VERIFIED ports — the SHARED ports in
_raw_normalize.py (uuid_shaped) plus the connector-LOCAL ports defined below (major_decimal_to_minor,
micros_to_minor, to_count_string, resolve_level/level_id/parent_id, stat_date_to_iso, event_id_spend_live).
The local ports are byte-for-byte Python ports of @brain/ad-spend-mapper and are flagged for later
consolidation into _raw_normalize.py (see _p4_golden/test_ad-spend-golden.py, which proves byte-exactness
against vectors captured from the real TS).
"""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import DataFrame, SparkSession  # noqa: E402
from pyspark.sql.functions import col, concat_ws, lit, struct, to_json, udf, when  # noqa: E402
from pyspark.sql.types import StringType  # noqa: E402

from iceberg_base import CATALOG, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402
from job_log import emit_job_log  # noqa: E402
import _raw_normalize as rn
from _raw_normalize import major_decimal_to_minor, micros_to_minor, to_count_string  # consolidated primitives (ADR-0006)  # noqa: E402  (SHARED ports — uuid_shaped reused; never re-implemented here)
from _silver_technical import write_quarantine, event_category_udf  # noqa: E402  (Stage-1 quarantine sink — replaces silent drop)

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
RAW_META_TABLE = f"{CATALOG}.{BRONZE_NAMESPACE}.meta_spend_raw"
RAW_GOOGLE_TABLE = f"{CATALOG}.{BRONZE_NAMESPACE}.google_spend_raw"
# Shadow by default (dual-run parity). Set TARGET_TABLE=silver_collector_event at cutover.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}." + os.environ.get(
    "TARGET_TABLE", "silver_collector_event_ad_spend_shadow"
)

# The verbatim provider object is nested under these fields in the sink envelope (cf. Shopify `order`).
META_ROW = os.environ.get("META_ROW_FIELD", "insight")
GOOGLE_ROW = os.environ.get("GOOGLE_ROW_FIELD", "row")

COLUMNS_SQL = """
  event_id          string  NOT NULL,
  brand_id          string  NOT NULL,
  occurred_at       timestamp NOT NULL,
  ingested_at       timestamp NOT NULL,
  schema_name       string  NOT NULL,
  schema_version    int     NOT NULL,
  event_type        string  NOT NULL,
  event_category    string,
  correlation_id    string,
  partition_key     string  NOT NULL,
  anonymous_id      string,
  device_id         string,
  silver_version    int,
  payload           string  NOT NULL
"""


# ─────────────────────────────────────────────────────────────────────────────────────────────────────
# LOCAL PORTS — byte-for-byte Python ports of @brain/ad-spend-mapper. Defined here (and DUPLICATED in the
# golden test as the reference impl) because _raw_normalize.py is edited concurrently by other agents
# (ADR-0006 P4 rule a). FLAGGED for consolidation into _raw_normalize.py — see new_framework_primitives.
# ─────────────────────────────────────────────────────────────────────────────────────────────────────

_DECIMAL_RE = re.compile(r"^(\d+)(?:\.(\d+))?$")
_INT_RE = re.compile(r"^\d+$")
_COUNT_RE = re.compile(r"^(\d+)(?:\.\d+)?$")








def resolve_level(raw, fallback="campaign"):
    """resolveLevel — map a provider level token onto the canonical AdSpendLevel."""
    r = (raw or "").lower()
    if r == "campaign":
        return "campaign"
    if r in ("adset", "ad_group", "adgroup"):
        return "adset"
    if r in ("ad", "ad_group_ad"):
        return "ad"
    if r == "creative":
        return "creative"
    return fallback


def resolve_level_id(level, campaign_id, adset_id, ad_id):
    """resolveLevelId — platform-native id at the resolved level (with the TS coalesce fallbacks)."""
    if level == "campaign":
        return campaign_id or ""
    if level == "adset":
        return adset_id or campaign_id or ""
    # 'ad' | 'creative'
    return ad_id or adset_id or campaign_id or ""


def resolve_parent_id(level, campaign_id, adset_id, ad_id):
    """resolveParentId — hierarchy parent id for the resolved level (None at campaign)."""
    if level == "campaign":
        return None
    if level == "adset":
        return campaign_id
    if level == "ad":
        return adset_id or campaign_id
    if level == "creative":
        return ad_id or adset_id
    return None


def stat_date_to_iso(stat_date):
    """statDateToIso — anchor occurred_at at UTC midnight of the click-date: new Date(`${d}T00:00:00.000Z`)
    .toISOString() === `${d}T00:00:00.000Z`. Empty stat_date → None (quarantine; the spend grain requires
    a stat_date — the TS falls back to now(), but a dateless spend row cannot be a canonical grain row)."""
    d = (stat_date or "").strip()
    if d == "":
        return None
    return f"{d}T00:00:00.000Z"


def event_id_spend_live(brand_id, platform, stat_date, level, level_id, breakdown_key=""):
    """uuidV5FromSpendRow(brandId, platform, statDate, level, levelId, breakdownKey='') — REUSES the
    SHARED uuid_shaped port. Seed: `${brandId}:${platform}:${statDate}:${level}:${levelId}[:breakdownKey]
    :spend.live.v1` (ADR-AD-5 + breakdown spec §2). breakdownKey='' (base pass) → seed byte-identical to
    the pre-breakdown 5-arg seed (backward-compat: base event_ids unchanged, zero re-dedup churn)."""
    bk = "" if breakdown_key == "" else f":{breakdown_key}"
    return rn.uuid_shaped(f"{brand_id}:{platform}:{stat_date}:{level}:{level_id}{bk}:spend.live.v1")


def google_breakdown_key(
    device=None, ad_network_type=None, day_of_week=None, hour=None, click_type=None,
    conversion_action=None, geo_target=None, age_range=None, gender=None,
    keyword_id=None, search_term=None, product_item_id=None,
):
    """GOOGLE-ONLY (spec §2.C) — byte-port of googleBreakdownKey(props). Maps the projected Google
    segment dims onto the canonical breakdownKey. A base spend row has all dims None → "" → base id."""
    return rn.canonical_breakdown_key(
        {
            "device": device,
            "ad_network_type": ad_network_type,
            "day_of_week": day_of_week,
            "hour": hour,
            "click_type": click_type,
            "conversion_action": conversion_action,
            "geo_target": geo_target,
            "age_range": age_range,
            "gender": gender,
            "keyword_id": keyword_id,
            "search_term": search_term,
            "product_item_id": product_item_id,
        }
    )


# ── A1: Meta purchase action lookup (byte-port of @brain/ad-spend-mapper metaActionValue) ──────────────
# The first matching action_type's `value` (priority: purchase → omni_purchase → pixel purchase) lifted out
# of Meta's nested actions[] (counts) / action_values[] (revenue) arrays. Full arrays stay in conversions_raw.
_META_PURCHASE_TYPES = ("purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase")

# ── META-ONLY (Impl-M) FIREHOSE — action-type priority lists (byte-mirror of @brain/ad-spend-mapper). ──
_META_LANDING_PAGE_VIEW_TYPES = ("landing_page_view", "omni_landing_page_view")
_META_OUTBOUND_CLICK_TYPES = ("outbound_click",)
_META_PURCHASE_ROAS_TYPES = ("omni_purchase", "purchase")
_META_WEBSITE_PURCHASE_ROAS_TYPES = ("offsite_conversion.fb_pixel_purchase", "purchase")
_META_MOBILE_APP_PURCHASE_ROAS_TYPES = ("app_custom_event.fb_mobile_purchase", "omni_purchase")
_META_POST_ENGAGEMENT_TYPES = ("post_engagement",)
_META_PAGE_ENGAGEMENT_TYPES = ("page_engagement",)
_META_VIDEO_VIEW_TYPES = ("video_view",)


def _meta_action_value_by(arr, action_types):
    """metaActionValue(raw, actionTypes) — first-match by priority action_type; else None. The generic
    array-lift the firehose reuses for every Meta array metric (byte-port of the TS helper)."""
    if not arr:
        return None
    for t in action_types:
        for a in arr:
            at = a["action_type"] if isinstance(a, dict) else getattr(a, "action_type", None)
            if at == t:
                v = a["value"] if isinstance(a, dict) else getattr(a, "value", None)
                if v is not None:
                    return str(v)
    return None


def meta_action_value(arr):
    return _meta_action_value_by(arr, _META_PURCHASE_TYPES)


# ── UDFs over the verified ports (Spark output == verified python == TS) ───────────────────────────────
u_minor_major = udf(lambda v: major_decimal_to_minor(v), StringType())
u_minor_micros = udf(lambda v: micros_to_minor(v), StringType())
# Null-guarded money ports (A1): absent insight field → null (mapper emits null, not "0", when absent).
u_minor_major_opt = udf(lambda v: major_decimal_to_minor(v) if v is not None else None, StringType())
u_minor_micros_opt = udf(lambda v: micros_to_minor(v) if v is not None else None, StringType())
u_meta_action = udf(lambda a: meta_action_value(a), StringType())
u_count = udf(lambda v: to_count_string(v), StringType())
# Ratio passthrough (spec §1: NOT scaled) — trimmed string, empty/None → None. Byte-port of toRatioString.
u_ratio = udf(lambda v: (str(v).strip() or None) if v is not None else None, StringType())
u_level = udf(lambda r: resolve_level(r, "campaign"), StringType())
u_level_id = udf(lambda lvl, c, a, ad: resolve_level_id(lvl, c, a, ad), StringType())
u_parent = udf(lambda lvl, c, a, ad: resolve_parent_id(lvl, c, a, ad), StringType())
u_stat_iso = udf(lambda d: stat_date_to_iso(d), StringType())
u_eid = udf(
    lambda b, p, d, lvl, lid, bk: event_id_spend_live(b, p, d, lvl, lid, bk)
    if (b and p and d and lvl and lid is not None)
    else None,
    StringType(),
)
# Google breakdown-aware event_id: folds the projected segment dims into the seed (spec §2.C). Base
# Google spend rows (all dims None) collapse to breakdownKey='' → byte-identical to the 5-arg u_eid.
u_eid_gbk = udf(
    lambda b, p, d, lvl, lid, bk: event_id_spend_live(b, p, d, lvl, lid, bk or "")
    if (b and p and d and lvl and lid is not None)
    else None,
    StringType(),
)
u_gbk = udf(
    lambda dev, net, dow, hr, ct, ca, geo, age, gen, kid, st, pid: google_breakdown_key(
        dev, net, dow, hr, ct, ca, geo, age, gen, kid, st, pid
    ),
    StringType(),
)

# ── META-ONLY (Impl-M) FIREHOSE array-lift UDFs (each folds a fixed action_type priority list) ─────────
u_meta_landing = udf(lambda a: _meta_action_value_by(a, _META_LANDING_PAGE_VIEW_TYPES), StringType())
u_meta_outbound = udf(lambda a: _meta_action_value_by(a, _META_OUTBOUND_CLICK_TYPES), StringType())
u_meta_purchase_roas = udf(lambda a: _meta_action_value_by(a, _META_PURCHASE_ROAS_TYPES), StringType())
u_meta_website_roas = udf(lambda a: _meta_action_value_by(a, _META_WEBSITE_PURCHASE_ROAS_TYPES), StringType())
u_meta_mobile_roas = udf(lambda a: _meta_action_value_by(a, _META_MOBILE_APP_PURCHASE_ROAS_TYPES), StringType())
u_meta_post_eng = udf(lambda a: _meta_action_value_by(a, _META_POST_ENGAGEMENT_TYPES), StringType())
u_meta_page_eng = udf(lambda a: _meta_action_value_by(a, _META_PAGE_ENGAGEMENT_TYPES), StringType())
u_meta_video = udf(lambda a: _meta_action_value_by(a, _META_VIDEO_VIEW_TYPES), StringType())

# ── COMMON (Impl-M + Impl-G) breakdown_key UDF — canonical, byte-identical to the TS mapper. Dims are
#    passed as a fixed-order map { name: value }; absent/empty dims omitted; sorted+escaped+joined. ─────
u_breakdown_key = udf(
    lambda names, vals: rn.canonical_breakdown_key(
        {n: v for n, v in zip(names or [], vals or [])}
    ),
    StringType(),
)


# Stage-1 admission gate (was the inline `.where(...)` silent drop): a canonical spend row needs a seeded
# event_id, a normalized minor amount, and a parseable stat_date-derived occurred_at. The COMPLEMENT is now
# routed to silver_quarantine instead of being dropped — same admission set, observable + replayable.
def _spend_admit():
    """Stage-1 admission predicate, built LAZILY. `col()` needs an active Spark context, so it must NOT
    run at module-import time (the file is exec'd by spark-submit BEFORE main() creates the session) —
    a module-level `col(...)` raised AssertionError at import and never reached build(). Call this inside
    build()/helpers, where the session exists."""
    return col("event_id").isNotNull() & col("spend_minor").isNotNull() & col("occurred_at_iso").isNotNull()


def _spend_reject_reason():
    """Per-row reason for a quarantined spend normalization (the failed admission predicate(s), joined)."""
    return concat_ws(
        ",",
        when(col("event_id").isNull(), lit("empty_identifier:event_id")),
        when(col("spend_minor").isNull(), lit("non_integer_amount")),
        when(col("occurred_at_iso").isNull(), lit("unparseable_timestamp")),
    )


def _spend_rejects(canon: DataFrame, platform: str, payload_col) -> DataFrame:
    """The quarantine projection for rows that FAIL _SPEND_ADMIT (brand_id, source, bronze_event_id,
    canonical_target, reason, payload). payload = the reconstructed canonical envelope (replayable)."""
    return canon.where(~_spend_admit()).select(
        col("brand_id"),
        lit(platform).alias("source"),
        col("event_id").alias("bronze_event_id"),
        lit(TARGET.rsplit(".", 1)[1]).alias("canonical_target"),
        _spend_reject_reason().alias("reason"),
        payload_col.alias("payload"),
    )


def _collector_event_select(canon: DataFrame, payload_col) -> DataFrame:
    """Project a per-platform canonical DataFrame onto the silver_collector_event 14-column contract.
    Identical output schema for both platforms → unionByName is safe (payload is a single JSON STRING)."""
    _event_category = event_category_udf()  # SAME SoT as the keystone collector gate (Gap A port)
    return canon.select(
        col("event_id"),
        col("brand_id"),
        col("occurred_at_iso").cast("timestamp").alias("occurred_at"),
        col("fetched_at").cast("timestamp").alias("ingested_at"),
        lit("brain.collector.event.v1").alias("schema_name"),
        lit(1).alias("schema_version"),
        lit("spend.live.v1").alias("event_type"),
        _event_category(lit("spend.live.v1")).alias("event_category"),
        lit(None).cast("string").alias("correlation_id"),
        col("brand_id").alias("partition_key"),
        lit(None).cast("string").alias("anonymous_id"),  # pixel-only identifiers — connector-derived rows have none
        lit(None).cast("string").alias("device_id"),
        lit(1).alias("silver_version"),  # seed; bumped only on a REAL payload change by the MERGE below
        payload_col.alias("payload"),
    )


def build_meta(spark: SparkSession):
    """RAW Meta Insights rows → (good canonical spend.live.v1 collector_event rows, Stage-1 quarantine rejects)."""
    r = META_ROW
    df = rn.read_bronze(spark, CATALOG, BRONZE_NAMESPACE, "meta_spend_raw", "meta").select(
        col("brand_id").cast("string").alias("brand_id"),  # MT-1: server-trusted envelope ONLY
        col("fetched_at").cast("string").alias("fetched_at"),
        col("account_currency").cast("string").alias("account_currency"),
        col("account_timezone").cast("string").alias("account_timezone"),
        col(f"{r}.level").cast("string").alias("raw_level"),
        col(f"{r}.campaign_id").cast("string").alias("campaign_id"),
        col(f"{r}.campaign_name").cast("string").alias("campaign_name"),
        col(f"{r}.adset_id").cast("string").alias("adset_id"),
        col(f"{r}.ad_id").cast("string").alias("ad_id"),
        col(f"{r}.spend").cast("string").alias("spend_raw"),
        col(f"{r}.impressions").cast("string").alias("impressions_raw"),
        col(f"{r}.clicks").cast("string").alias("clicks_raw"),
        col(f"{r}.date_start").cast("string").alias("stat_date_raw"),
        col(f"{r}.actions").alias("actions"),
        col(f"{r}.action_values").alias("action_values"),  # A1: conversion REVENUE arrays
        col(f"{r}.ctr").cast("string").alias("ctr_raw"),
        col(f"{r}.cpc").cast("string").alias("cpc_raw"),  # MAJOR-unit decimal cost-per-click
        col(f"{r}.cpm").cast("string").alias("cpm_raw"),  # MAJOR-unit decimal cost-per-mille
        # ── META-ONLY (Impl-M) FIREHOSE base-grain raw fields (absent → null → mapper leaves prop null). ──
        col(f"{r}.reach").cast("string").alias("reach_raw"),
        col(f"{r}.frequency").cast("string").alias("frequency_raw"),
        col(f"{r}.cpp").cast("string").alias("cpp_raw"),  # MAJOR-unit decimal
        col(f"{r}.unique_clicks").cast("string").alias("unique_clicks_raw"),
        col(f"{r}.unique_ctr").cast("string").alias("unique_ctr_raw"),
        col(f"{r}.inline_link_clicks").cast("string").alias("inline_link_clicks_raw"),
        col(f"{r}.inline_link_click_ctr").cast("string").alias("inline_link_click_ctr_raw"),
        col(f"{r}.outbound_clicks").alias("outbound_clicks_arr"),
        col(f"{r}.unique_outbound_clicks").alias("unique_outbound_clicks_arr"),
        col(f"{r}.cost_per_unique_click").cast("string").alias("cost_per_unique_click_raw"),  # MAJOR decimal
        col(f"{r}.cost_per_inline_link_click").cast("string").alias("cost_per_inline_link_click_raw"),
        col(f"{r}.purchase_roas").alias("purchase_roas_arr"),
        col(f"{r}.website_purchase_roas").alias("website_purchase_roas_arr"),
        col(f"{r}.mobile_app_purchase_roas").alias("mobile_app_purchase_roas_arr"),
        col(f"{r}.video_play_actions").alias("video_play_arr"),
        col(f"{r}.video_p25_watched_actions").alias("video_p25_arr"),
        col(f"{r}.video_p50_watched_actions").alias("video_p50_arr"),
        col(f"{r}.video_p75_watched_actions").alias("video_p75_arr"),
        col(f"{r}.video_p100_watched_actions").alias("video_p100_arr"),
        col(f"{r}.video_thruplay_watched_actions").alias("video_thruplay_arr"),
        col(f"{r}.video_30_sec_watched_actions").alias("video_30_sec_arr"),
        col(f"{r}.video_avg_time_watched_actions").alias("video_avg_time_arr"),
        col(f"{r}.inline_post_engagement").cast("string").alias("inline_post_engagement_raw"),
        col(f"{r}.quality_ranking").cast("string").alias("quality_ranking_raw"),
        col(f"{r}.engagement_rate_ranking").cast("string").alias("engagement_rate_ranking_raw"),
        col(f"{r}.conversion_rate_ranking").cast("string").alias("conversion_rate_ranking_raw"),
        # ── Breakdown dimension values (present only on the corresponding breakdown pass; else null). ──
        col(f"{r}.age").cast("string").alias("bd_age"),
        col(f"{r}.gender").cast("string").alias("bd_gender"),
        col(f"{r}.country").cast("string").alias("bd_country"),
        col(f"{r}.region").cast("string").alias("bd_region"),
        col(f"{r}.dma").cast("string").alias("bd_dma"),
        col(f"{r}.publisher_platform").cast("string").alias("bd_publisher_platform"),
        col(f"{r}.platform_position").cast("string").alias("bd_platform_position"),
        col(f"{r}.device_platform").cast("string").alias("bd_device_platform"),
        col(f"{r}.impression_device").cast("string").alias("bd_impression_device"),
        col(f"{r}.hourly_stats_aggregated_by_advertiser_time_zone").cast("string").alias("bd_hourly"),
    )

    from pyspark.sql.functions import array

    canon = (
        df.withColumn("platform", lit("meta"))
        # FIREHOSE: canonical breakdown_key over the dims present (base pass → '' → base ids unchanged).
        # Dim NAME order here fixes the map iteration; canonical_breakdown_key sorts+escapes them.
        .withColumn(
            "breakdown_key",
            u_breakdown_key(
                array(
                    lit("age"), lit("gender"), lit("country"), lit("region"), lit("dma"),
                    lit("publisher_platform"), lit("platform_position"), lit("device_platform"),
                    lit("impression_device"),
                    lit("hourly_stats_aggregated_by_advertiser_time_zone"),
                ),
                array(
                    col("bd_age"), col("bd_gender"), col("bd_country"), col("bd_region"), col("bd_dma"),
                    col("bd_publisher_platform"), col("bd_platform_position"), col("bd_device_platform"),
                    col("bd_impression_device"), col("bd_hourly"),
                ),
            ),
        )
        .withColumn("level", u_level(col("raw_level")))
        .withColumn("level_id", u_level_id(col("level"), col("campaign_id"), col("adset_id"), col("ad_id")))
        .withColumn("parent_id", u_parent(col("level"), col("campaign_id"), col("adset_id"), col("ad_id")))
        .withColumn("stat_date", _trim(col("stat_date_raw")))
        .withColumn("spend_minor", u_minor_major(col("spend_raw")))
        .withColumn("currency_code", _upper_trim(col("account_currency")))
        .withColumn("impressions", u_count(col("impressions_raw")))
        .withColumn("clicks", u_count(col("clicks_raw")))
        # A1 insight set: purchase COUNT (actions[]) + purchase REVENUE (action_values[] → MINOR, no float).
        .withColumn("conversions", u_count(u_meta_action(col("actions"))))
        .withColumn("all_conversions", lit(None).cast("string"))  # Meta has no distinct all_conversions
        .withColumn("conv_value_minor", u_minor_major_opt(u_meta_action(col("action_values"))))
        .withColumn("view_through_conversions", lit(None).cast("string"))
        .withColumn("ctr", col("ctr_raw"))
        .withColumn("cpc_minor", u_minor_major_opt(col("cpc_raw")))
        .withColumn("cpm_minor", u_minor_major_opt(col("cpm_raw")))
        .withColumn("advertising_channel_type", lit(None).cast("string"))  # Google-only
        # ── META-ONLY (Impl-M) FIREHOSE enriched insight set. Money via major-decimal→minor; counts via
        #    to_count_string; ratios/rankings passthrough; frequency is a decimal ratio (NOT money). Array
        #    metrics lifted via the fixed action-type lists; full raw arrays preserved in conversions_raw. ──
        .withColumn("video_views", u_count(u_meta_video(col("video_play_arr"))))
        .withColumn("reach", u_count(col("reach_raw")))
        .withColumn("frequency", col("frequency_raw"))
        .withColumn("cpp_minor", u_minor_major_opt(col("cpp_raw")))
        .withColumn("unique_clicks", u_count(col("unique_clicks_raw")))
        .withColumn("unique_ctr", col("unique_ctr_raw"))
        .withColumn("inline_link_clicks", u_count(col("inline_link_clicks_raw")))
        .withColumn("inline_link_click_ctr", col("inline_link_click_ctr_raw"))
        .withColumn("outbound_clicks", u_count(u_meta_outbound(col("outbound_clicks_arr"))))
        .withColumn("unique_outbound_clicks", u_count(u_meta_outbound(col("unique_outbound_clicks_arr"))))
        .withColumn("cost_per_unique_click_minor", u_minor_major_opt(col("cost_per_unique_click_raw")))
        .withColumn("cost_per_inline_link_click_minor", u_minor_major_opt(col("cost_per_inline_link_click_raw")))
        .withColumn("landing_page_views", u_count(u_meta_landing(col("actions"))))
        .withColumn("purchase_roas_ratio", u_meta_purchase_roas(col("purchase_roas_arr")))
        .withColumn("website_purchase_roas_ratio", u_meta_website_roas(col("website_purchase_roas_arr")))
        .withColumn("mobile_app_purchase_roas_ratio", u_meta_mobile_roas(col("mobile_app_purchase_roas_arr")))
        .withColumn("post_engagement", u_count(u_meta_post_eng(col("actions"))))
        .withColumn("page_engagement", u_count(u_meta_page_eng(col("actions"))))
        .withColumn("inline_post_engagement", u_count(col("inline_post_engagement_raw")))
        .withColumn("video_p25_watched", u_count(u_meta_video(col("video_p25_arr"))))
        .withColumn("video_p50_watched", u_count(u_meta_video(col("video_p50_arr"))))
        .withColumn("video_p75_watched", u_count(u_meta_video(col("video_p75_arr"))))
        .withColumn("video_p100_watched", u_count(u_meta_video(col("video_p100_arr"))))
        .withColumn("video_thruplay_watched", u_count(u_meta_video(col("video_thruplay_arr"))))
        .withColumn("video_30_sec_watched", u_count(u_meta_video(col("video_30_sec_arr"))))
        .withColumn("video_avg_time_watched_secs", u_count(u_meta_video(col("video_avg_time_arr"))))
        .withColumn("quality_ranking", col("quality_ranking_raw"))
        .withColumn("engagement_rate_ranking", col("engagement_rate_ranking_raw"))
        .withColumn("conversion_rate_ranking", col("conversion_rate_ranking_raw"))
        .withColumn("occurred_at_iso", u_stat_iso(col("stat_date")))
        .withColumn(
            "event_id",
            u_eid(
                col("brand_id"), col("platform"), col("stat_date"), col("level"), col("level_id"),
                col("breakdown_key"),
            ),
        )
    )

    # conversions_raw (ADR-AD-8): Meta → { actions, action_values, + FIREHOSE array metrics } when ANY
    # present, else null. Native nested struct so the single to_json on the envelope emits proper nested
    # JSON. Every new array-valued raw field is preserved verbatim (mirrors the TS conversions_raw).
    _raw_arr_cols = [
        col("actions").alias("actions"),
        col("action_values").alias("action_values"),
        col("outbound_clicks_arr").alias("outbound_clicks"),
        col("unique_outbound_clicks_arr").alias("unique_outbound_clicks"),
        col("purchase_roas_arr").alias("purchase_roas"),
        col("website_purchase_roas_arr").alias("website_purchase_roas"),
        col("mobile_app_purchase_roas_arr").alias("mobile_app_purchase_roas"),
        col("video_play_arr").alias("video_play_actions"),
        col("video_p25_arr").alias("video_p25_watched_actions"),
        col("video_p50_arr").alias("video_p50_watched_actions"),
        col("video_p75_arr").alias("video_p75_watched_actions"),
        col("video_p100_arr").alias("video_p100_watched_actions"),
        col("video_thruplay_arr").alias("video_thruplay_watched_actions"),
        col("video_30_sec_arr").alias("video_30_sec_watched_actions"),
        col("video_avg_time_arr").alias("video_avg_time_watched_actions"),
    ]
    _any_arr = col("actions").isNotNull() | col("action_values").isNotNull()
    for _c in (
        "outbound_clicks_arr", "unique_outbound_clicks_arr", "purchase_roas_arr",
        "website_purchase_roas_arr", "mobile_app_purchase_roas_arr", "video_play_arr",
        "video_p25_arr", "video_p50_arr", "video_p75_arr", "video_p100_arr",
        "video_thruplay_arr", "video_30_sec_arr", "video_avg_time_arr",
    ):
        _any_arr = _any_arr | col(_c).isNotNull()
    conversions_raw = when(_any_arr, struct(*_raw_arr_cols))

    props = struct(
        lit("meta").alias("source"),
        lit("meta").alias("platform"),
        col("level").alias("level"),
        col("level_id").alias("level_id"),
        col("parent_id").alias("parent_id"),
        col("campaign_id").alias("campaign_id"),
        col("campaign_name").alias("campaign_name"),
        col("stat_date").alias("stat_date"),
        col("spend_minor").alias("spend_minor"),
        col("currency_code").alias("currency_code"),
        col("impressions").alias("impressions"),
        col("clicks").alias("clicks"),
        # A1 enriched insight set (sibling measures; conv_value_minor shares currency_code, never blended).
        col("conversions").alias("conversions"),
        col("all_conversions").alias("all_conversions"),
        col("conv_value_minor").alias("conv_value_minor"),
        col("view_through_conversions").alias("view_through_conversions"),
        col("ctr").alias("ctr"),
        col("cpc_minor").alias("cpc_minor"),
        col("cpm_minor").alias("cpm_minor"),
        col("advertising_channel_type").alias("advertising_channel_type"),
        conversions_raw.alias("conversions_raw"),
        col("account_timezone").alias("account_timezone"),
        col("occurred_at_iso").alias("occurred_at"),
        # ── COMMON — Meta populates video_views; rest Google-only (null here). breakdown_key audit surface. ──
        col("video_views").alias("video_views"),
        lit(None).cast("string").alias("video_view_rate"),
        lit(None).cast("string").alias("engagements"),
        lit(None).cast("string").alias("engagement_rate"),
        lit(None).cast("string").alias("cost_per_conversion_minor"),
        lit(None).cast("string").alias("value_per_conversion_minor"),
        col("breakdown_key").alias("breakdown_key"),
        # ── META-ONLY (Impl-M) enriched insight metrics ────────────────────────────────────────────────
        col("reach").alias("reach"),
        col("frequency").alias("frequency"),
        col("cpp_minor").alias("cpp_minor"),
        col("unique_clicks").alias("unique_clicks"),
        col("unique_ctr").alias("unique_ctr"),
        col("inline_link_clicks").alias("inline_link_clicks"),
        col("inline_link_click_ctr").alias("inline_link_click_ctr"),
        col("outbound_clicks").alias("outbound_clicks"),
        col("unique_outbound_clicks").alias("unique_outbound_clicks"),
        col("cost_per_unique_click_minor").alias("cost_per_unique_click_minor"),
        col("cost_per_inline_link_click_minor").alias("cost_per_inline_link_click_minor"),
        col("landing_page_views").alias("landing_page_views"),
        col("purchase_roas_ratio").alias("purchase_roas_ratio"),
        col("website_purchase_roas_ratio").alias("website_purchase_roas_ratio"),
        col("mobile_app_purchase_roas_ratio").alias("mobile_app_purchase_roas_ratio"),
        col("post_engagement").alias("post_engagement"),
        col("page_engagement").alias("page_engagement"),
        col("inline_post_engagement").alias("inline_post_engagement"),
        col("video_p25_watched").alias("video_p25_watched"),
        col("video_p50_watched").alias("video_p50_watched"),
        col("video_p75_watched").alias("video_p75_watched"),
        col("video_p100_watched").alias("video_p100_watched"),
        col("video_thruplay_watched").alias("video_thruplay_watched"),
        col("video_30_sec_watched").alias("video_30_sec_watched"),
        col("video_avg_time_watched_secs").alias("video_avg_time_watched_secs"),
        col("quality_ranking").alias("quality_ranking"),
        col("engagement_rate_ranking").alias("engagement_rate_ranking"),
        col("conversion_rate_ranking").alias("conversion_rate_ranking"),
        # ── Breakdown dims (base pass → all null; a breakdown pass populates its dims) ──────────────────
        col("bd_age").alias("age"),
        col("bd_gender").alias("gender"),
        col("bd_country").alias("country"),
        col("bd_region").alias("region"),
        col("bd_dma").alias("dma"),
        col("bd_publisher_platform").alias("publisher_platform"),
        col("bd_platform_position").alias("platform_position"),
        col("bd_device_platform").alias("device_platform"),
        col("bd_impression_device").alias("impression_device"),
        col("bd_hourly").alias("hourly_stats_aggregated_by_advertiser_time_zone"),
    )
    payload = to_json(
        struct(
            lit("spend.live.v1").alias("event_name"),
            col("occurred_at_iso").alias("occurred_at"),
            props.alias("properties"),
        )
    )
    # Stage-1: admit good rows; route the (formerly silently-dropped) complement to quarantine.
    good = _collector_event_select(canon.where(_spend_admit()), payload)
    rejects = _spend_rejects(canon, "meta", payload)
    return good, rejects


def build_google(spark: SparkSession):
    """RAW Google Ads SearchStream rows → (good canonical spend.live.v1 collector_event rows, Stage-1 rejects)."""
    r = GOOGLE_ROW
    df = rn.read_bronze(spark, CATALOG, BRONZE_NAMESPACE, "google_spend_raw", "google").select(
        col("brand_id").cast("string").alias("brand_id"),  # MT-1
        col("fetched_at").cast("string").alias("fetched_at"),
        col("account_currency").cast("string").alias("account_currency"),
        col("account_timezone").cast("string").alias("account_timezone"),
        col(f"{r}.level").cast("string").alias("raw_level"),
        col(f"{r}.campaign_id").cast("string").alias("campaign_id"),
        col(f"{r}.campaign_name").cast("string").alias("campaign_name"),
        col(f"{r}.ad_group_id").cast("string").alias("ad_group_id"),  # ad_group → canonical 'adset'
        col(f"{r}.ad_id").cast("string").alias("ad_id"),
        col(f"{r}.cost_micros").cast("string").alias("cost_micros_raw"),
        col(f"{r}.impressions").cast("string").alias("impressions_raw"),
        col(f"{r}.clicks").cast("string").alias("clicks_raw"),
        col(f"{r}.conversions").cast("string").alias("conversions_raw_count"),
        col(f"{r}.all_conversions").cast("string").alias("all_conversions_raw_count"),
        col(f"{r}.conversions_value").cast("string").alias("conv_value_raw"),  # MAJOR-unit double (acct ccy)
        col(f"{r}.view_through_conversions").cast("string").alias("view_through_raw"),
        col(f"{r}.ctr").cast("string").alias("ctr_raw"),
        col(f"{r}.average_cpc").cast("string").alias("avg_cpc_raw"),  # integer MICROS
        col(f"{r}.average_cpm").cast("string").alias("avg_cpm_raw"),  # integer MICROS
        col(f"{r}.advertising_channel_type").cast("string").alias("adv_channel_raw"),
        col(f"{r}.segments_date").cast("string").alias("stat_date_raw"),
        col(f"{r}.currency_code").cast("string").alias("row_currency_code"),
        # ── FIREHOSE metrics (additive; nullable). money = micros/major; count = int; ratio = passthrough. ──
        col(f"{r}.cost_per_conversion").cast("string").alias("cost_per_conv_raw"),  # micros
        col(f"{r}.value_per_conversion").cast("string").alias("value_per_conv_raw"),  # micros
        col(f"{r}.all_conversions_value").cast("string").alias("all_conv_value_raw"),  # MAJOR double
        col(f"{r}.cost_per_all_conversions").cast("string").alias("cost_per_all_conv_raw"),  # micros
        col(f"{r}.average_cost").cast("string").alias("avg_cost_raw"),  # micros
        col(f"{r}.search_impression_share").cast("string").alias("search_is_raw"),
        col(f"{r}.search_budget_lost_impression_share").cast("string").alias("search_budget_lost_is_raw"),
        col(f"{r}.search_rank_lost_impression_share").cast("string").alias("search_rank_lost_is_raw"),
        col(f"{r}.absolute_top_impression_percentage").cast("string").alias("abs_top_imp_pct_raw"),
        col(f"{r}.top_impression_percentage").cast("string").alias("top_imp_pct_raw"),
        col(f"{r}.interactions").cast("string").alias("interactions_raw"),
        col(f"{r}.interaction_rate").cast("string").alias("interaction_rate_raw"),
        col(f"{r}.engagements").cast("string").alias("engagements_raw"),
        col(f"{r}.engagement_rate").cast("string").alias("engagement_rate_raw"),
        col(f"{r}.video_views").cast("string").alias("video_views_raw"),
        col(f"{r}.video_view_rate").cast("string").alias("video_view_rate_raw"),
        col(f"{r}.conversions_from_interactions_rate").cast("string").alias("conv_from_interactions_rate_raw"),
        # ── FIREHOSE segment/breakdown dims (fold into breakdownKey) ──
        col(f"{r}.segment_device").cast("string").alias("seg_device"),
        col(f"{r}.segment_ad_network_type").cast("string").alias("seg_ad_network_type"),
        col(f"{r}.segment_day_of_week").cast("string").alias("seg_day_of_week"),
        col(f"{r}.segment_hour").cast("string").alias("seg_hour"),
        col(f"{r}.segment_click_type").cast("string").alias("seg_click_type"),
        col(f"{r}.segment_conversion_action").cast("string").alias("seg_conversion_action"),
        col(f"{r}.segment_conversion_action_name").cast("string").alias("seg_conversion_action_name"),
        col(f"{r}.segment_geo_target").cast("string").alias("seg_geo_target"),
        col(f"{r}.segment_age_range").cast("string").alias("seg_age_range"),
        col(f"{r}.segment_gender").cast("string").alias("seg_gender"),
        col(f"{r}.keyword_id").cast("string").alias("keyword_id"),
        col(f"{r}.keyword_text").cast("string").alias("keyword_text"),
        col(f"{r}.keyword_match_type").cast("string").alias("keyword_match_type"),
        col(f"{r}.search_term").cast("string").alias("search_term"),
        col(f"{r}.product_item_id").cast("string").alias("product_item_id"),
        col(f"{r}.product_title").cast("string").alias("product_title"),
        col(f"{r}.product_brand").cast("string").alias("product_brand"),
    )

    canon = (
        df.withColumn("platform", lit("google_ads"))
        .withColumn("level", u_level(col("raw_level")))
        # Google ad_group maps to the canonical 'adset' level → pass ad_group_id as the adset id.
        .withColumn("level_id", u_level_id(col("level"), col("campaign_id"), col("ad_group_id"), col("ad_id")))
        .withColumn("parent_id", u_parent(col("level"), col("campaign_id"), col("ad_group_id"), col("ad_id")))
        .withColumn("stat_date", _trim(col("stat_date_raw")))
        .withColumn("spend_minor", u_minor_micros(col("cost_micros_raw")))
        # currency = (row.currency_code ?? account_currency).trim().toUpperCase()
        .withColumn(
            "currency_code",
            _upper_trim(_coalesce_nonempty(col("row_currency_code"), col("account_currency"))),
        )
        .withColumn("impressions", u_count(col("impressions_raw")))
        .withColumn("clicks", u_count(col("clicks_raw")))
        # A1 insight set: counts lifted first-class; conversions_value (MAJOR double → MINOR, no float);
        # average_cpc/cpm MICROS → MINOR units. conv_value_minor shares currency_code (never blended).
        .withColumn("conversions", u_count(col("conversions_raw_count")))
        .withColumn("all_conversions", u_count(col("all_conversions_raw_count")))
        .withColumn("conv_value_minor", u_minor_major_opt(col("conv_value_raw")))
        .withColumn("view_through_conversions", u_count(col("view_through_raw")))
        .withColumn("ctr", col("ctr_raw"))
        .withColumn("cpc_minor", u_minor_micros_opt(col("avg_cpc_raw")))
        .withColumn("cpm_minor", u_minor_micros_opt(col("avg_cpm_raw")))
        .withColumn("advertising_channel_type", col("adv_channel_raw"))
        # ── FIREHOSE metrics (mirror mapGoogleRowToEvent, byte-for-byte). money → minor; count; ratio. ──
        .withColumn("video_views", u_count(col("video_views_raw")))
        .withColumn("video_view_rate", u_ratio(col("video_view_rate_raw")))
        .withColumn("engagements", u_count(col("engagements_raw")))
        .withColumn("engagement_rate", u_ratio(col("engagement_rate_raw")))
        .withColumn("cost_per_conversion_minor", u_minor_micros_opt(col("cost_per_conv_raw")))
        .withColumn("value_per_conversion_minor", u_minor_micros_opt(col("value_per_conv_raw")))
        .withColumn("all_conversions_value_minor", u_minor_major_opt(col("all_conv_value_raw")))
        .withColumn("cost_per_all_conversions_minor", u_minor_micros_opt(col("cost_per_all_conv_raw")))
        .withColumn("average_cost_minor", u_minor_micros_opt(col("avg_cost_raw")))
        .withColumn("search_impression_share", u_ratio(col("search_is_raw")))
        .withColumn("search_budget_lost_impression_share", u_ratio(col("search_budget_lost_is_raw")))
        .withColumn("search_rank_lost_impression_share", u_ratio(col("search_rank_lost_is_raw")))
        .withColumn("absolute_top_impression_percentage", u_ratio(col("abs_top_imp_pct_raw")))
        .withColumn("top_impression_percentage", u_ratio(col("top_imp_pct_raw")))
        .withColumn("interactions", u_count(col("interactions_raw")))
        .withColumn("interaction_rate", u_ratio(col("interaction_rate_raw")))
        .withColumn("conversions_from_interactions_rate", u_ratio(col("conv_from_interactions_rate_raw")))
        # breakdownKey folds this row's segment dims (base spend row → all None → "" → base id).
        .withColumn(
            "breakdown_key",
            u_gbk(
                col("seg_device"), col("seg_ad_network_type"), col("seg_day_of_week"), col("seg_hour"),
                col("seg_click_type"), col("seg_conversion_action"), col("seg_geo_target"),
                col("seg_age_range"), col("seg_gender"), col("keyword_id"), col("search_term"),
                col("product_item_id"),
            ),
        )
        .withColumn("occurred_at_iso", u_stat_iso(col("stat_date")))
        .withColumn(
            "event_id",
            u_eid_gbk(
                col("brand_id"), col("platform"), col("stat_date"), col("level"), col("level_id"),
                col("breakdown_key"),
            ),
        )
    )

    # conversions_raw (ADR-AD-8): Google → BOTH conversions + all_conversions RAW (verbatim doubles,
    # null-preserving) — distinct from the integer-floored `conversions` count column below.
    conversions_raw = struct(
        col("conversions_raw_count").alias("conversions"),
        col("all_conversions_raw_count").alias("all_conversions"),
    )

    props = struct(
        lit("google_ads").alias("source"),
        lit("google_ads").alias("platform"),
        col("level").alias("level"),
        col("level_id").alias("level_id"),
        col("parent_id").alias("parent_id"),
        col("campaign_id").alias("campaign_id"),
        col("campaign_name").alias("campaign_name"),
        col("stat_date").alias("stat_date"),
        col("spend_minor").alias("spend_minor"),
        col("currency_code").alias("currency_code"),
        col("impressions").alias("impressions"),
        col("clicks").alias("clicks"),
        # A1 enriched insight set (sibling measures; conv_value_minor shares currency_code, never blended).
        col("conversions").alias("conversions"),
        col("all_conversions").alias("all_conversions"),
        col("conv_value_minor").alias("conv_value_minor"),
        col("view_through_conversions").alias("view_through_conversions"),
        col("ctr").alias("ctr"),
        col("cpc_minor").alias("cpc_minor"),
        col("cpm_minor").alias("cpm_minor"),
        col("advertising_channel_type").alias("advertising_channel_type"),
        conversions_raw.alias("conversions_raw"),
        col("account_timezone").alias("account_timezone"),
        # ── COMMON (spec §1.A) firehose analog metrics ──
        col("video_views").alias("video_views"),
        col("video_view_rate").alias("video_view_rate"),
        col("engagements").alias("engagements"),
        col("engagement_rate").alias("engagement_rate"),
        col("cost_per_conversion_minor").alias("cost_per_conversion_minor"),
        col("value_per_conversion_minor").alias("value_per_conversion_minor"),
        # ── GOOGLE-ONLY firehose metrics (money = MINOR sharing currency_code; ratio passthrough) ──
        col("all_conversions_value_minor").alias("all_conversions_value_minor"),
        col("cost_per_all_conversions_minor").alias("cost_per_all_conversions_minor"),
        col("average_cost_minor").alias("average_cost_minor"),
        col("search_impression_share").alias("search_impression_share"),
        col("search_budget_lost_impression_share").alias("search_budget_lost_impression_share"),
        col("search_rank_lost_impression_share").alias("search_rank_lost_impression_share"),
        col("absolute_top_impression_percentage").alias("absolute_top_impression_percentage"),
        col("top_impression_percentage").alias("top_impression_percentage"),
        col("interactions").alias("interactions"),
        col("interaction_rate").alias("interaction_rate"),
        col("conversions_from_interactions_rate").alias("conversions_from_interactions_rate"),
        # ── GOOGLE-ONLY breakdown/segment dims (projected to payload for the breakdown marts) ──
        col("seg_device").alias("segment_device"),
        col("seg_ad_network_type").alias("segment_ad_network_type"),
        col("seg_day_of_week").alias("segment_day_of_week"),
        col("seg_hour").alias("segment_hour"),
        col("seg_click_type").alias("segment_click_type"),
        col("seg_conversion_action").alias("segment_conversion_action"),
        col("seg_conversion_action_name").alias("segment_conversion_action_name"),
        col("seg_geo_target").alias("segment_geo_target"),
        col("seg_age_range").alias("segment_age_range"),
        col("seg_gender").alias("segment_gender"),
        col("keyword_id").alias("keyword_id"),
        col("keyword_text").alias("keyword_text"),
        col("keyword_match_type").alias("keyword_match_type"),
        col("search_term").alias("search_term"),
        col("product_item_id").alias("product_item_id"),
        col("product_title").alias("product_title"),
        col("product_brand").alias("product_brand"),
        col("occurred_at_iso").alias("occurred_at"),
        # ── COMMON — Impl-G owns the Google population (this PR = Impl-M → null-defaulted; the Google
        #    lane PR fills video_views/…/value_per_conversion_minor + its own breakdown_key). ────────────
        lit(None).cast("string").alias("video_views"),
        lit(None).cast("string").alias("video_view_rate"),
        lit(None).cast("string").alias("engagements"),
        lit(None).cast("string").alias("engagement_rate"),
        lit(None).cast("string").alias("cost_per_conversion_minor"),
        lit(None).cast("string").alias("value_per_conversion_minor"),
        col("breakdown_key").alias("breakdown_key"),
        # ── META-ONLY fields — never populated on the Google lane (null). ──────────────────────────────
        lit(None).cast("string").alias("reach"),
        lit(None).cast("string").alias("frequency"),
        lit(None).cast("string").alias("cpp_minor"),
        lit(None).cast("string").alias("unique_clicks"),
        lit(None).cast("string").alias("unique_ctr"),
        lit(None).cast("string").alias("inline_link_clicks"),
        lit(None).cast("string").alias("inline_link_click_ctr"),
        lit(None).cast("string").alias("outbound_clicks"),
        lit(None).cast("string").alias("unique_outbound_clicks"),
        lit(None).cast("string").alias("cost_per_unique_click_minor"),
        lit(None).cast("string").alias("cost_per_inline_link_click_minor"),
        lit(None).cast("string").alias("landing_page_views"),
        lit(None).cast("string").alias("purchase_roas_ratio"),
        lit(None).cast("string").alias("website_purchase_roas_ratio"),
        lit(None).cast("string").alias("mobile_app_purchase_roas_ratio"),
        lit(None).cast("string").alias("post_engagement"),
        lit(None).cast("string").alias("page_engagement"),
        lit(None).cast("string").alias("inline_post_engagement"),
        lit(None).cast("string").alias("video_p25_watched"),
        lit(None).cast("string").alias("video_p50_watched"),
        lit(None).cast("string").alias("video_p75_watched"),
        lit(None).cast("string").alias("video_p100_watched"),
        lit(None).cast("string").alias("video_thruplay_watched"),
        lit(None).cast("string").alias("video_30_sec_watched"),
        lit(None).cast("string").alias("video_avg_time_watched_secs"),
        lit(None).cast("string").alias("quality_ranking"),
        lit(None).cast("string").alias("engagement_rate_ranking"),
        lit(None).cast("string").alias("conversion_rate_ranking"),
        lit(None).cast("string").alias("age"),
        lit(None).cast("string").alias("gender"),
        lit(None).cast("string").alias("country"),
        lit(None).cast("string").alias("region"),
        lit(None).cast("string").alias("dma"),
        lit(None).cast("string").alias("publisher_platform"),
        lit(None).cast("string").alias("platform_position"),
        lit(None).cast("string").alias("device_platform"),
        lit(None).cast("string").alias("impression_device"),
        lit(None).cast("string").alias("hourly_stats_aggregated_by_advertiser_time_zone"),
    )
    payload = to_json(
        struct(
            lit("spend.live.v1").alias("event_name"),
            col("occurred_at_iso").alias("occurred_at"),
            props.alias("properties"),
        )
    )
    # Stage-1: admit good rows; route the (formerly silently-dropped) complement to quarantine.
    good = _collector_event_select(canon.where(_spend_admit()), payload)
    rejects = _spend_rejects(canon, "google_ads", payload)
    return good, rejects


def _trim(c):
    from pyspark.sql.functions import trim

    return trim(c)


def _upper_trim(c):
    from pyspark.sql.functions import trim, upper

    return upper(trim(c))


def _coalesce_nonempty(primary, fallback):
    """(row.currency_code ?? account_currency) — TS uses `??` (null/undefined only). The raw column is NULL
    when absent, so coalesce reproduces it. (Empty-string currency is malformed upstream; left as-is.)"""
    from pyspark.sql.functions import coalesce

    return coalesce(primary, fallback)


def build(spark: SparkSession):
    create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        TARGET.rsplit(".", 1)[1],
        COLUMNS_SQL,
        partitioned_by="bucket(256, brand_id), days(occurred_at)",
    )

    # PER-LANE skip-guard (ADR-0010): each spend lane's Connect table is auto-created on ITS OWN first
    # record, so meta and google must be guarded INDEPENDENTLY — under the old joint guard, one live
    # lane would send the other (still-empty / not-yet-created) lane into build_meta/build_google, whose
    # struct-column select dies on the empty-lane placeholder frame read_bronze returns. A lane with no
    # source rows contributes nothing; BOTH empty → empty-lane skip: each *_raw_connect table
    # auto-creates on its lane's first record (ADR-0010), so return cleanly until then.
    meta_empty = rn.read_bronze(spark, CATALOG, BRONZE_NAMESPACE, "meta_spend_raw", "meta").limit(1).count() == 0
    google_empty = rn.read_bronze(spark, CATALOG, BRONZE_NAMESPACE, "google_spend_raw", "google").limit(1).count() == 0
    if meta_empty and google_empty:
        print(f"[silver-ad-spend-normalize] {rn.connect_source_table(CATALOG, BRONZE_NAMESPACE, 'meta_spend_raw')} + {rn.connect_source_table(CATALOG, BRONZE_NAMESPACE, 'google_spend_raw')} both empty — skipping (empty lanes; tables auto-create on first record, ADR-0010)", flush=True)
        return TARGET, 0

    goods, rejects = [], []
    if not meta_empty:
        meta_good, meta_rejects = build_meta(spark)
        goods.append(meta_good)
        rejects.append(meta_rejects)
    if not google_empty:
        google_good, google_rejects = build_google(spark)
        goods.append(google_good)
        rejects.append(google_rejects)
    union = goods[0]
    for _g in goods[1:]:
        union = union.unionByName(_g)

    # Stage-1: route the formerly silently-dropped rows to silver_quarantine (observable + replayable).
    all_rejects = rejects[0]
    for _r in rejects[1:]:
        all_rejects = all_rejects.unionByName(_r)
    write_quarantine(spark, all_rejects, stage="dq")

    # ADR-0010: the append-only Connect Bronze can carry redelivered duplicates — collapse to one row
    # per (brand_id, event_id) or the MERGE below aborts on a source-cardinality violation.
    union = rn.dedupe_latest(union, ["brand_id", "event_id"], "ingested_at")
    union.createOrReplaceTempView("_ad_spend_canon")
    spark.sql(
        f"""
        MERGE INTO {TARGET} t USING _ad_spend_canon s
        ON t.brand_id = s.brand_id AND t.event_id = s.event_id
        -- Keystone-mirrored idempotency (silver_collector_event.py Gap C): overwrite only on a REAL
        -- payload change; bump silver_version (coalesce so pre-widening 10-col rows start from 1, never NULL+1).
        WHEN MATCHED AND s.payload <> t.payload THEN UPDATE SET
          occurred_at = s.occurred_at, ingested_at = s.ingested_at,
          schema_name = s.schema_name, schema_version = s.schema_version,
          event_type = s.event_type, event_category = s.event_category,
          correlation_id = s.correlation_id, partition_key = s.partition_key,
          anonymous_id = s.anonymous_id, device_id = s.device_id,
          payload = s.payload,
          silver_version = coalesce(t.silver_version, 1) + 1
        -- One-time widen-backfill: pre-widening 10-col rows (payload unchanged, so the clause above
        -- no-ops forever) get the ALTER-ADDed columns populated WITHOUT counting it as a revision.
        WHEN MATCHED AND t.silver_version IS NULL THEN UPDATE SET
          event_category = s.event_category, anonymous_id = s.anonymous_id,
          device_id = s.device_id, silver_version = 1
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.sql(f"SELECT COUNT(*) AS n FROM {TARGET}").collect()[0]["n"]
    return TARGET, n


def main() -> None:
    import time

    spark = build_spark("silver-ad-spend-normalize")
    spark.sparkContext.setLogLevel("WARN")
    started = time.monotonic()
    try:
        fqtn, n = build(spark)
        emit_job_log(
            "silver-ad-spend-normalize", status="ok", rows_out=n, fqtn=fqtn,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        print(f"[silver-ad-spend-normalize] DONE — {fqtn} now has {n} rows", flush=True)
    except Exception as exc:  # noqa: BLE001
        emit_job_log(
            "silver-ad-spend-normalize", status="fail",
            duration_ms=int((time.monotonic() - started) * 1000), error=str(exc),
        )
        raise


if __name__ == "__main__":
    main()
