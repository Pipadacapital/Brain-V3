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
from _silver_technical import write_quarantine  # noqa: E402  (Stage-1 quarantine sink — replaces silent drop)

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
  correlation_id    string,
  partition_key     string  NOT NULL,
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


def event_id_spend_live(brand_id, platform, stat_date, level, level_id):
    """uuidV5FromSpendRow(brandId, platform, statDate, level, levelId) — REUSES the SHARED uuid_shaped
    port. Seed: `${brandId}:${platform}:${statDate}:${level}:${levelId}:spend.live.v1` (ADR-AD-5)."""
    return rn.uuid_shaped(f"{brand_id}:{platform}:{stat_date}:{level}:{level_id}:spend.live.v1")


# ── A1: Meta purchase action lookup (byte-port of @brain/ad-spend-mapper metaActionValue) ──────────────
# The first matching action_type's `value` (priority: purchase → omni_purchase → pixel purchase) lifted out
# of Meta's nested actions[] (counts) / action_values[] (revenue) arrays. Full arrays stay in conversions_raw.
_META_PURCHASE_TYPES = ("purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase")


def meta_action_value(arr):
    if not arr:
        return None
    for t in _META_PURCHASE_TYPES:
        for a in arr:
            at = a["action_type"] if isinstance(a, dict) else getattr(a, "action_type", None)
            if at == t:
                v = a["value"] if isinstance(a, dict) else getattr(a, "value", None)
                if v is not None:
                    return str(v)
    return None


# ── UDFs over the verified ports (Spark output == verified python == TS) ───────────────────────────────
u_minor_major = udf(lambda v: major_decimal_to_minor(v), StringType())
u_minor_micros = udf(lambda v: micros_to_minor(v), StringType())
# Null-guarded money ports (A1): absent insight field → null (mapper emits null, not "0", when absent).
u_minor_major_opt = udf(lambda v: major_decimal_to_minor(v) if v is not None else None, StringType())
u_minor_micros_opt = udf(lambda v: micros_to_minor(v) if v is not None else None, StringType())
u_meta_action = udf(lambda a: meta_action_value(a), StringType())
u_count = udf(lambda v: to_count_string(v), StringType())
u_level = udf(lambda r: resolve_level(r, "campaign"), StringType())
u_level_id = udf(lambda lvl, c, a, ad: resolve_level_id(lvl, c, a, ad), StringType())
u_parent = udf(lambda lvl, c, a, ad: resolve_parent_id(lvl, c, a, ad), StringType())
u_stat_iso = udf(lambda d: stat_date_to_iso(d), StringType())
u_eid = udf(
    lambda b, p, d, lvl, lid: event_id_spend_live(b, p, d, lvl, lid)
    if (b and p and d and lvl and lid is not None)
    else None,
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
    """Project a per-platform canonical DataFrame onto the silver_collector_event 10-column contract.
    Identical output schema for both platforms → unionByName is safe (payload is a single JSON STRING)."""
    return canon.select(
        col("event_id"),
        col("brand_id"),
        col("occurred_at_iso").cast("timestamp").alias("occurred_at"),
        col("fetched_at").cast("timestamp").alias("ingested_at"),
        lit("brain.collector.event.v1").alias("schema_name"),
        lit(1).alias("schema_version"),
        lit("spend.live.v1").alias("event_type"),
        lit(None).cast("string").alias("correlation_id"),
        col("brand_id").alias("partition_key"),
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
    )

    canon = (
        df.withColumn("platform", lit("meta"))
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
        .withColumn("occurred_at_iso", u_stat_iso(col("stat_date")))
        .withColumn(
            "event_id",
            u_eid(col("brand_id"), col("platform"), col("stat_date"), col("level"), col("level_id")),
        )
    )

    # conversions_raw (ADR-AD-8): Meta → { actions, action_values } when EITHER present, else null. Native
    # nested struct so the single to_json on the envelope emits proper nested JSON (raw passthrough).
    conversions_raw = when(
        col("actions").isNotNull() | col("action_values").isNotNull(),
        struct(col("actions").alias("actions"), col("action_values").alias("action_values")),
    )

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
        .withColumn("occurred_at_iso", u_stat_iso(col("stat_date")))
        .withColumn(
            "event_id",
            u_eid(col("brand_id"), col("platform"), col("stat_date"), col("level"), col("level_id")),
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
        col("occurred_at_iso").alias("occurred_at"),
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
    # source rows contributes nothing; BOTH empty → return cleanly. Full payload-JSON normalize is G1.
    meta_empty = rn.read_bronze(spark, CATALOG, BRONZE_NAMESPACE, "meta_spend_raw", "meta").limit(1).count() == 0
    google_empty = rn.read_bronze(spark, CATALOG, BRONZE_NAMESPACE, "google_spend_raw", "google").limit(1).count() == 0
    if meta_empty and google_empty:
        print(f"[silver-ad-spend-normalize] {RAW_META_TABLE} + {RAW_GOOGLE_TABLE} both empty — skipping (awaiting ad-connector data / G1)", flush=True)
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
        WHEN MATCHED THEN UPDATE SET *
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
