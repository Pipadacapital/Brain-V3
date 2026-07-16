"""
silver_ad_spend_normalize.py (DuckDB) — faithful port of
db/iceberg/spark/silver/silver_ad_spend_normalize.py (ADR-0006 P4).

Reads the TWO raw ad-spend Bronze lanes (the ADR-0010 Kafka-Connect sinks):
  - `meta_spend_raw_connect`    — verbatim Meta Ads Insights rows nested under `insight`
  - `google_spend_raw_connect`  — verbatim Google Ads SearchStream rows nested under `row`
Both platforms normalize into ONE canonical event — spend.live.v1 — with envelope/properties `source`
discriminating meta vs google_ads (ADR-AD-4). MERGEs the silver_collector_event 14-column contract into the
SHADOW table silver_collector_event_ad_spend_shadow (dual-run parity; TARGET_TABLE / MIGRATION_TABLE_SUFFIX
override). silver_marketing_spend reads the shadow with ZERO change.

CORRECTNESS: shared crypto goes through the VENDORED port (_raw_normalize_ports.uuid_shaped /
canonical_breakdown_key); the connector-LOCAL money/count/level/date/event_id ports are ported HERE
byte-for-byte with the Spark job (which is byte-verified in test_ad-spend-golden.py). Money is bigint MINOR
units, never a float, emitted as a numeric STRING with a sibling currency_code; per-currency, never blended.
Ad spend has NO PII → there is NO per-brand salt / JDBC join here (unlike the Shopify exemplar).

STAGE-1 QUARANTINE SKIPPED (parity-preserving, per the migration rule): the Spark job routes the inline
drop-gate complement (un-seedable event_id / malformed money / missing stat_date) to silver_quarantine
(stage='dq'). This port does NOT write that diagnostic ledger — Bronze keeps the originals (replay-safe). The
ADMITTED (good-row) set is IDENTICAL: the same `event_id & spend_minor & occurred_at_iso IS NOT NULL`
predicate is applied per-lane before the union+MERGE.

PER-LANE skip-guard (ADR-0010): meta and google are guarded INDEPENDENTLY — each lane's Connect table is
auto-created on ITS OWN first record. BOTH empty → empty-lane skip (HONEST-EMPTY).

Parity target: brain_silver.silver_collector_event_ad_spend_shadow (both lanes empty today → 0 rows).
"""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402
from _normalize_base import (  # noqa: E402
    COLLECTOR_COLUMNS, advance_lane_watermark, connect_source_table, ensure_shadow, lane_window,
    lane_window_predicate, merge_collector_event, run_normalize_job, source_present,
)
import _raw_normalize_ports as rn  # noqa: E402
from _silver_technical_ports import event_category  # noqa: E402

META_LANE = "meta_spend_raw"
GOOGLE_LANE = "google_spend_raw"
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}." + os.environ.get(
    "TARGET_TABLE", "silver_collector_event_ad_spend_shadow"
) + os.environ.get("MIGRATION_TABLE_SUFFIX", "")

META_ROW = os.environ.get("META_ROW_FIELD", "insight")
GOOGLE_ROW = os.environ.get("GOOGLE_ROW_FIELD", "row")

_DECIMAL_RE = re.compile(r"^(\d+)(?:\.(\d+))?$")
_INT_RE = re.compile(r"^\d+$")
_COUNT_RE = re.compile(r"^(\d+)(?:\.\d+)?$")


# ── Connector-LOCAL ports (byte-for-byte with the Spark job / @brain/ad-spend-mapper) ─────────────────
def major_decimal_to_minor(value):
    if value is None:
        return "0"
    s = str(value).strip()
    if s == "":
        return "0"
    m = _DECIMAL_RE.match(s)
    if not m:
        return None
    frac = ((m.group(2) or "") + "00")[:2]
    return str(int(m.group(1)) * 100 + int(frac))


def micros_to_minor(value):
    if value is None:
        return "0"
    s = str(value).strip()
    if not _INT_RE.match(s):
        return None
    return str(int(s) // 10000)


def to_count_string(value):
    if value is None:
        return None
    s = str(value).strip()
    if s == "":
        return None
    m = _COUNT_RE.match(s)
    return m.group(1) if m else None


def resolve_level(raw, fallback="campaign"):
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
    if level == "campaign":
        return campaign_id or ""
    if level == "adset":
        return adset_id or campaign_id or ""
    return ad_id or adset_id or campaign_id or ""


def resolve_parent_id(level, campaign_id, adset_id, ad_id):
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
    d = (stat_date or "").strip()
    if d == "":
        return None
    return f"{d}T00:00:00.000Z"


def event_id_spend_live(brand_id, platform, stat_date, level, level_id, breakdown_key=""):
    bk = "" if breakdown_key == "" else f":{breakdown_key}"
    return rn.uuid_shaped(f"{brand_id}:{platform}:{stat_date}:{level}:{level_id}{bk}:spend.live.v1")


def _register_udfs(con) -> None:
    con.create_function("rn_minor_major", major_decimal_to_minor, ["VARCHAR"], "VARCHAR",
                        null_handling="special")
    con.create_function("rn_minor_micros", micros_to_minor, ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_minor_major_opt",
                        lambda v: major_decimal_to_minor(v) if v is not None else None,
                        ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_minor_micros_opt",
                        lambda v: micros_to_minor(v) if v is not None else None,
                        ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_count", to_count_string, ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_ratio", lambda v: (str(v).strip() or None) if v is not None else None,
                        ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_level", lambda r: resolve_level(r, "campaign"), ["VARCHAR"], "VARCHAR",
                        null_handling="special")
    con.create_function("rn_level_id", resolve_level_id, ["VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR"],
                        "VARCHAR", null_handling="special")
    con.create_function("rn_parent", resolve_parent_id, ["VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR"],
                        "VARCHAR", null_handling="special")
    con.create_function("rn_stat_iso", stat_date_to_iso, ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function(
        "rn_eid",
        lambda b, p, d, lvl, lid, bk: event_id_spend_live(b, p, d, lvl, lid, bk or "")
        if (b and p and d and lvl and lid is not None) else None,
        ["VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR"], "VARCHAR", null_handling="special",
    )
    con.create_function("rn_event_category", event_category, ["VARCHAR"], "VARCHAR", null_handling="special")


def _select_collector(good_body: str) -> str:
    """Wrap a per-platform canonical SELECT (which must expose event_id, brand_id, occurred_at_iso,
    fetched_at, payload + the admission cols) into the silver_collector_event 14-column contract."""
    return f"""
      SELECT
        event_id,
        brand_id,
        CAST(occurred_at_iso AS TIMESTAMP)               AS occurred_at,
        CAST(fetched_at AS TIMESTAMP)                    AS ingested_at,
        'brain.collector.event.v1'                       AS schema_name,
        CAST(1 AS INTEGER)                               AS schema_version,
        'spend.live.v1'                                  AS event_type,
        rn_event_category('spend.live.v1')               AS event_category,
        CAST(NULL AS VARCHAR)                            AS correlation_id,
        brand_id                                         AS partition_key,
        CAST(NULL AS VARCHAR)                            AS anonymous_id,
        CAST(NULL AS VARCHAR)                            AS device_id,
        CAST(1 AS INTEGER)                               AS silver_version,
        payload                                          AS payload
      FROM ({good_body})
      WHERE event_id IS NOT NULL AND spend_minor IS NOT NULL AND occurred_at_iso IS NOT NULL
    """


def _build_meta(con, window_predicate: str = ""):
    src = connect_source_table(META_LANE)
    r = META_ROW
    # Byte-identity guard: when window_predicate is "" (default OFF / full scan) the FROM clause is exactly
    # `FROM {src}` as before this edit; only a non-empty predicate appends a WHERE line.
    from_clause = f"{src}\n      {window_predicate}" if window_predicate else src
    df = f"""
      SELECT
        CAST(brand_id AS VARCHAR)                        AS brand_id,
        CAST(fetched_at AS VARCHAR)                      AS fetched_at,
        CAST(account_currency AS VARCHAR)                AS account_currency,
        CAST(account_timezone AS VARCHAR)                AS account_timezone,
        CAST("{r}".level AS VARCHAR)                     AS raw_level,
        CAST("{r}".campaign_id AS VARCHAR)              AS campaign_id,
        CAST("{r}".campaign_name AS VARCHAR)            AS campaign_name,
        CAST("{r}".adset_id AS VARCHAR)                 AS adset_id,
        CAST("{r}".ad_id AS VARCHAR)                    AS ad_id,
        CAST("{r}".spend AS VARCHAR)                    AS spend_raw,
        CAST("{r}".impressions AS VARCHAR)             AS impressions_raw,
        CAST("{r}".clicks AS VARCHAR)                  AS clicks_raw,
        CAST("{r}".date_start AS VARCHAR)              AS stat_date_raw,
        CAST("{r}".ctr AS VARCHAR)                     AS ctr_raw,
        CAST("{r}".cpc AS VARCHAR)                     AS cpc_raw,
        CAST("{r}".cpm AS VARCHAR)                     AS cpm_raw
      FROM {from_clause}
    """
    canon = f"""
      SELECT *,
        'meta'                                                   AS platform,
        ''                                                       AS breakdown_key,
        rn_level(raw_level)                                      AS level,
        rn_level_id(rn_level(raw_level), campaign_id, adset_id, ad_id) AS level_id,
        rn_parent(rn_level(raw_level), campaign_id, adset_id, ad_id)   AS parent_id,
        trim(stat_date_raw)                                     AS stat_date,
        rn_minor_major(spend_raw)                              AS spend_minor,
        upper(trim(account_currency))                          AS currency_code,
        rn_count(impressions_raw)                             AS impressions,
        rn_count(clicks_raw)                                  AS clicks,
        ctr_raw                                               AS ctr,
        rn_minor_major_opt(cpc_raw)                           AS cpc_minor,
        rn_minor_major_opt(cpm_raw)                           AS cpm_minor,
        rn_stat_iso(trim(stat_date_raw))                      AS occurred_at_iso
      FROM ({df})
    """
    canon2 = f"""
      SELECT *,
        rn_eid(brand_id, platform, stat_date, level, level_id, breakdown_key) AS event_id
      FROM ({canon})
    """
    props = (
        "json_object("
        "'source','meta','platform','meta',"
        "'level', level,'level_id', level_id,'parent_id', parent_id,"
        "'campaign_id', campaign_id,'campaign_name', campaign_name,"
        "'stat_date', stat_date,'spend_minor', spend_minor,'currency_code', currency_code,"
        "'impressions', impressions,'clicks', clicks,"
        "'ctr', ctr,'cpc_minor', cpc_minor,'cpm_minor', cpm_minor,"
        "'account_timezone', account_timezone,'occurred_at', occurred_at_iso,"
        "'breakdown_key', CASE WHEN breakdown_key = '' THEN NULL ELSE breakdown_key END)"
    )
    good_body = f"""
      SELECT brand_id, fetched_at, event_id, spend_minor, occurred_at_iso,
             json_object('event_name','spend.live.v1','occurred_at', occurred_at_iso,
                         'properties', {props}) AS payload
      FROM ({canon2})
    """
    return _select_collector(good_body)


def _build_google(con, window_predicate: str = ""):
    src = connect_source_table(GOOGLE_LANE)
    r = GOOGLE_ROW
    # Byte-identity guard: "" predicate → FROM clause is exactly `FROM {src}` as before this edit.
    from_clause = f"{src}\n      {window_predicate}" if window_predicate else src
    df = f"""
      SELECT
        CAST(brand_id AS VARCHAR)                        AS brand_id,
        CAST(fetched_at AS VARCHAR)                      AS fetched_at,
        CAST(account_currency AS VARCHAR)                AS account_currency,
        CAST(account_timezone AS VARCHAR)                AS account_timezone,
        CAST("{r}".level AS VARCHAR)                     AS raw_level,
        CAST("{r}".campaign_id AS VARCHAR)              AS campaign_id,
        CAST("{r}".campaign_name AS VARCHAR)            AS campaign_name,
        CAST("{r}".ad_group_id AS VARCHAR)             AS ad_group_id,
        CAST("{r}".ad_id AS VARCHAR)                    AS ad_id,
        CAST("{r}".cost_micros AS VARCHAR)             AS cost_micros_raw,
        CAST("{r}".impressions AS VARCHAR)             AS impressions_raw,
        CAST("{r}".clicks AS VARCHAR)                  AS clicks_raw,
        CAST("{r}".conversions AS VARCHAR)             AS conversions_raw_count,
        CAST("{r}".all_conversions AS VARCHAR)         AS all_conversions_raw_count,
        CAST("{r}".conversions_value AS VARCHAR)       AS conv_value_raw,
        CAST("{r}".view_through_conversions AS VARCHAR) AS view_through_raw,
        CAST("{r}".ctr AS VARCHAR)                     AS ctr_raw,
        CAST("{r}".average_cpc AS VARCHAR)             AS avg_cpc_raw,
        CAST("{r}".average_cpm AS VARCHAR)             AS avg_cpm_raw,
        CAST("{r}".advertising_channel_type AS VARCHAR) AS adv_channel_raw,
        CAST("{r}".segments_date AS VARCHAR)           AS stat_date_raw,
        CAST("{r}".currency_code AS VARCHAR)           AS row_currency_code
      FROM {from_clause}
    """
    canon = f"""
      SELECT *,
        'google_ads'                                            AS platform,
        ''                                                      AS breakdown_key,
        rn_level(raw_level)                                     AS level,
        rn_level_id(rn_level(raw_level), campaign_id, ad_group_id, ad_id) AS level_id,
        rn_parent(rn_level(raw_level), campaign_id, ad_group_id, ad_id)   AS parent_id,
        trim(stat_date_raw)                                    AS stat_date,
        rn_minor_micros(cost_micros_raw)                      AS spend_minor,
        upper(trim(coalesce(row_currency_code, account_currency))) AS currency_code,
        rn_count(impressions_raw)                             AS impressions,
        rn_count(clicks_raw)                                  AS clicks,
        rn_count(conversions_raw_count)                       AS conversions,
        rn_count(all_conversions_raw_count)                   AS all_conversions,
        rn_minor_major_opt(conv_value_raw)                    AS conv_value_minor,
        rn_count(view_through_raw)                            AS view_through_conversions,
        ctr_raw                                               AS ctr,
        rn_minor_micros_opt(avg_cpc_raw)                      AS cpc_minor,
        rn_minor_micros_opt(avg_cpm_raw)                      AS cpm_minor,
        adv_channel_raw                                       AS advertising_channel_type,
        rn_stat_iso(trim(stat_date_raw))                      AS occurred_at_iso
      FROM ({df})
    """
    canon2 = f"""
      SELECT *,
        rn_eid(brand_id, platform, stat_date, level, level_id, breakdown_key) AS event_id
      FROM ({canon})
    """
    props = (
        "json_object("
        "'source','google_ads','platform','google_ads',"
        "'level', level,'level_id', level_id,'parent_id', parent_id,"
        "'campaign_id', campaign_id,'campaign_name', campaign_name,"
        "'stat_date', stat_date,'spend_minor', spend_minor,'currency_code', currency_code,"
        "'impressions', impressions,'clicks', clicks,"
        "'conversions', conversions,'all_conversions', all_conversions,"
        "'conv_value_minor', conv_value_minor,'view_through_conversions', view_through_conversions,"
        "'ctr', ctr,'cpc_minor', cpc_minor,'cpm_minor', cpm_minor,"
        "'advertising_channel_type', advertising_channel_type,"
        "'account_timezone', account_timezone,'occurred_at', occurred_at_iso,"
        "'breakdown_key', CASE WHEN breakdown_key = '' THEN NULL ELSE breakdown_key END)"
    )
    good_body = f"""
      SELECT brand_id, fetched_at, event_id, spend_minor, occurred_at_iso,
             json_object('event_name','spend.live.v1','occurred_at', occurred_at_iso,
                         'properties', {props}) AS payload
      FROM ({canon2})
    """
    return _select_collector(good_body)


def build(con):
    ensure_shadow(con, TARGET)

    meta_present = source_present(con, META_LANE)
    google_present = source_present(con, GOOGLE_LANE)
    if not meta_present and not google_present:
        print(f"[silver-ad-spend-normalize] {connect_source_table(META_LANE)} + "
              f"{connect_source_table(GOOGLE_LANE)} both absent/empty — skipping "
              f"(empty lanes; tables auto-create on first record, ADR-0010)", flush=True)
        return TARGET, 0

    _register_udfs(con)

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) — per lane, keyed (job, lane) ────────────────
    #   GRAIN = per_event: each raw lane row → 0..1 shadow row via the idempotent merge_collector_event on
    #   (brand_id, event_id), so windowing the source read is safe. Raw Connect lanes have no lifted
    #   ingested_at → the watermark tracks each lane's kafka_timestamp independently (a lane skipped by the
    #   empty-lane guard keeps its old watermark). Default OFF → lo=None → predicate "" → byte-identical full
    #   scan, and the SQL string is unchanged.
    lo_meta, hi_meta = lane_window(con, "silver-ad-spend-normalize", META_LANE)
    lo_google, hi_google = lane_window(con, "silver-ad-spend-normalize", GOOGLE_LANE)

    parts = []
    if meta_present:
        parts.append(_build_meta(con, lane_window_predicate(lo_meta, hi_meta)))
    if google_present:
        parts.append(_build_google(con, lane_window_predicate(lo_google, hi_google)))

    collist = ", ".join(COLLECTOR_COLUMNS)
    union = " UNION ALL BY NAME ".join(f"SELECT {collist} FROM ({p})" for p in parts)

    n = merge_collector_event(con, TARGET, union)

    # Advance each lane's watermark to the SAME hi the read used (only for lanes actually read this run;
    # a lane skipped by the empty-lane guard keeps its old watermark).
    if meta_present:
        advance_lane_watermark(con, "silver-ad-spend-normalize", META_LANE, hi_meta)
    if google_present:
        advance_lane_watermark(con, "silver-ad-spend-normalize", GOOGLE_LANE, hi_google)
    return TARGET, n


if __name__ == "__main__":
    run_normalize_job("silver-ad-spend-normalize", build,
                      target_table="silver_collector_event_ad_spend_shadow")
