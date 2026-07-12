"""
test_ad-spend-golden.py — ADR-0006 P4 byte-exactness proof for the ad-spend normalizer (Meta + Google).

Asserts the PySpark-side reference ports reproduce, byte-for-byte, the canonical fields the REAL TypeScript
@brain/ad-spend-mapper produced — using golden vectors captured by running the actual TS
(ad-spend-golden.json, from mapMetaInsightToEvent / mapGoogleRowToEvent + uuidV5FromSpendRow). If these pass,
the Spark normalizer (which udf-wraps the SAME functions) is identical to the connector's old TS
normalization, so Silver-from-raw == canonical Silver on money (bigint minor + currency) + event_id + time.

The SHARED port reused is _raw_normalize.uuid_shaped. The connector-LOCAL ports
(major_decimal_to_minor / micros_to_minor / to_count_string / resolve_level / resolve_level_id /
resolve_parent_id / stat_date_to_iso / event_id_spend_live) are defined here as the reference impl — kept
byte-identical to the copies in silver_ad_spend_normalize.py (FLAGGED for consolidation into
_raw_normalize.py). The test is pyspark-free so it runs in plain CI.

Run:  python3 -m pytest db/iceberg/spark/silver/_p4_golden/test_ad-spend-golden.py -q
  or: python3 db/iceberg/spark/silver/_p4_golden/test_ad-spend-golden.py   (plain assert runner)
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _raw_normalize import uuid_shaped  # noqa: E402  (the ONLY shared port reused)
from _raw_normalize import major_decimal_to_minor, micros_to_minor, to_count_string  # consolidated primitives (ADR-0006)
from _raw_normalize import canonical_breakdown_key  # noqa: E402  (breakdown spec §2.B — shared port)

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ad-spend-golden.json")

_DECIMAL_RE = re.compile(r"^(\d+)(?:\.(\d+))?$")
_INT_RE = re.compile(r"^\d+$")
_COUNT_RE = re.compile(r"^(\d+)(?:\.\d+)?$")


# ── LOCAL PORTS (byte-identical to silver_ad_spend_normalize.py) ───────────────────────────────────────






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
    return uuid_shaped(f"{brand_id}:{platform}:{stat_date}:{level}:{level_id}{bk}:spend.live.v1")


def google_breakdown_key(o):
    """Byte-port of googleBreakdownKey(props) over the RAW Google row's segment dims (spec §2.C)."""
    return canonical_breakdown_key(
        {
            "device": o.get("segment_device"),
            "ad_network_type": o.get("segment_ad_network_type"),
            "day_of_week": o.get("segment_day_of_week"),
            "hour": o.get("segment_hour"),
            "click_type": o.get("segment_click_type"),
            "conversion_action": o.get("segment_conversion_action"),
            "geo_target": o.get("segment_geo_target"),
            "age_range": o.get("segment_age_range"),
            "gender": o.get("segment_gender"),
            "keyword_id": o.get("keyword_id"),
            "search_term": o.get("search_term"),
            "product_item_id": o.get("product_item_id"),
        }
    )


def _s(v):
    """String(x) for non-null ids; None passthrough (matches the TS `!= null ? String(x) : null`)."""
    return None if v is None else str(v)


def _micros_opt(v):
    return micros_to_minor(v) if v is not None else None


def _major_opt(v):
    return major_decimal_to_minor(v) if v is not None else None


def _ratio(v):
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _normalize_meta(v):
    o = v["raw_row"]
    brand = v["brand_id"]
    campaign_id = _s(o.get("campaign_id"))
    adset_id = _s(o.get("adset_id"))
    ad_id = _s(o.get("ad_id"))
    level = resolve_level(o.get("level"), "campaign")
    level_id = resolve_level_id(level, campaign_id, adset_id, ad_id)
    parent_id = resolve_parent_id(level, campaign_id, adset_id, ad_id)
    stat_date = (o.get("date_start") or "").strip()
    return {
        "event_id": event_id_spend_live(brand, "meta", stat_date, level, level_id, ""),
        "breakdown_key": "",  # Meta rows carry no Google segment dims here → base pass
        "occurred_at": stat_date_to_iso(stat_date),
        "platform": "meta",
        "level": level,
        "level_id": level_id,
        "parent_id": parent_id,
        "campaign_id": campaign_id,
        "campaign_name": _s(o.get("campaign_name")),
        "stat_date": stat_date,
        "spend_minor": major_decimal_to_minor(o.get("spend") if o.get("spend") is not None else "0"),
        "currency_code": v["account_currency"].strip().upper(),
        "impressions": to_count_string(o.get("impressions")),
        "clicks": to_count_string(o.get("clicks")),
        # Meta does not populate the Google-only firehose fields → null.
        "cost_per_conversion_minor": None,
        "value_per_conversion_minor": None,
        "all_conversions_value_minor": None,
        "cost_per_all_conversions_minor": None,
        "average_cost_minor": None,
        "interactions": None,
        "video_views": None,
        "search_impression_share": None,
        "interaction_rate": None,
    }


def _normalize_google(v):
    o = v["raw_row"]
    brand = v["brand_id"]
    campaign_id = _s(o.get("campaign_id"))
    adset_id = _s(o.get("ad_group_id"))  # ad_group → canonical 'adset'
    ad_id = _s(o.get("ad_id"))
    level = resolve_level(o.get("level"), "campaign")
    level_id = resolve_level_id(level, campaign_id, adset_id, ad_id)
    parent_id = resolve_parent_id(level, campaign_id, adset_id, ad_id)
    stat_date = (o.get("segments_date") or "").strip()
    currency = (o.get("currency_code") if o.get("currency_code") is not None else v["account_currency"])
    bk = google_breakdown_key(o)
    return {
        "event_id": event_id_spend_live(brand, "google_ads", stat_date, level, level_id, bk),
        "breakdown_key": bk,
        "occurred_at": stat_date_to_iso(stat_date),
        "platform": "google_ads",
        "level": level,
        "level_id": level_id,
        "parent_id": parent_id,
        "campaign_id": campaign_id,
        "campaign_name": _s(o.get("campaign_name")),
        "stat_date": stat_date,
        "spend_minor": micros_to_minor(o.get("cost_micros") if o.get("cost_micros") is not None else "0"),
        "currency_code": currency.strip().upper(),
        "impressions": to_count_string(o.get("impressions")),
        "clicks": to_count_string(o.get("clicks")),
        # ── FIREHOSE money (micros→minor / major→minor) + ratio (passthrough) fields ──
        "cost_per_conversion_minor": _micros_opt(o.get("cost_per_conversion")),
        "value_per_conversion_minor": _micros_opt(o.get("value_per_conversion")),
        "all_conversions_value_minor": _major_opt(o.get("all_conversions_value")),
        "cost_per_all_conversions_minor": _micros_opt(o.get("cost_per_all_conversions")),
        "average_cost_minor": _micros_opt(o.get("average_cost")),
        "interactions": to_count_string(o.get("interactions")),
        "video_views": to_count_string(o.get("video_views")),
        "search_impression_share": _ratio(o.get("search_impression_share")),
        "interaction_rate": _ratio(o.get("interaction_rate")),
    }


def _normalize(v):
    return _normalize_meta(v) if v["platform"] == "meta" else _normalize_google(v)


def test_ad_spend_ports_match_ts():
    vectors = json.load(open(GOLDEN))
    assert vectors, "no golden vectors"
    for v in vectors:
        got = _normalize(v)
        exp = v["expected"]
        for field in exp:
            assert got[field] == exp[field], (
                f"{v['platform']} level={got['level']} field {field}: "
                f"port={got[field]!r} != ts={exp[field]!r}"
            )


if __name__ == "__main__":
    test_ad_spend_ports_match_ts()
    n = len(json.load(open(GOLDEN)))
    print(
        f"OK — all {n} ad-spend golden vectors match the PySpark ports byte-for-byte "
        f"(money + event_id + level hierarchy + time)."
    )
