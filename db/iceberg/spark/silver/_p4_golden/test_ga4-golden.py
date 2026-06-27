"""
test_ga4-golden.py — ADR-0006 P4 byte-exactness proof for the GA4 normalizer.

Asserts the PySpark-side reference ports reproduce, byte-for-byte, the canonical fields the REAL
TypeScript @brain/ga4-mapper produced — using golden vectors captured by running the actual TS
(ga4-rows-golden.json, from mapGa4RowToEvent + uuidV5FromGa4Row). This is the parity-loop closure:
if these pass, the Spark normalizer (silver_ga4_normalize.py, which udf-wraps the SAME functions) is
identical to the connector's old TS normalization → Silver-from-raw == canonical Silver on money
(bigint minor + currency), counts, sampling, occurred_at, and the uuid-shaped event_id.

PORTS UNDER TEST:
  - rn.uuid_shaped            — SHARED (hashToUuidShaped), reused via the ga4 seed builder below.
  - major_decimal_to_minor_string / to_count_string / resolve_bounces / ga4_occurred_at /
    event_id_ga4_session — connector-LOCAL ports (NOT yet in _raw_normalize.py — flagged for
    consolidation in new_framework_primitives_needed). The reference copies here are byte-identical
    to the copies the normalizer udf-wraps; they must stay in lockstep until consolidated.

Run:  python3 -m pytest db/iceberg/spark/silver/_p4_golden/test_ga4-golden.py -q
  or: python3 db/iceberg/spark/silver/_p4_golden/test_ga4-golden.py   (plain assert runner)
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _raw_normalize import uuid_shaped  # noqa: E402  (the SHARED, verified hashToUuidShaped port)

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ga4-rows-golden.json")

_GA4_DECIMAL_RE = re.compile(r"^(\d+)(?:\.(\d+))?$")
_GA4_COUNT_RE = re.compile(r"^(\d+)(?:\.\d+)?$")


# ── Connector-LOCAL reference ports (byte-identical to silver_ga4_normalize.py) ───────────────────────
def major_decimal_to_minor_string(value):
    """@brain/ga4-mapper majorDecimalToMinorString — TRUNCATE >2 frac digits, '0' for null/empty/'0',
    malformed → None (TS throws → Silver quarantines). Distinct from shared decimal_to_minor_strict."""
    if value is None:
        return 0
    s = str(value).strip()
    if s == "" or s == "0":
        return 0
    m = _GA4_DECIMAL_RE.match(s)
    if not m:
        return None
    whole = m.group(1)
    frac = (m.group(2) or "")
    frac = (frac + "00")[:2]
    return int(whole) * 100 + int(frac)


def to_count_string(value):
    if value is None:
        return None
    s = str(value).strip()
    if s == "":
        return None
    m = _GA4_COUNT_RE.match(s)
    if not m:
        return None
    return m.group(1)


def resolve_bounces(bounces, bounce_rate, sessions):
    if bounces is not None and str(bounces).strip() != "":
        return to_count_string(bounces)
    if bounce_rate is not None and sessions is not None:
        try:
            rate = float(str(bounce_rate))
            sess = int(str(sessions))
        except (ValueError, TypeError):
            return None
        return str(int(rate * sess + 0.5))
    return None


def ga4_occurred_at(date):
    if date is None:
        return None
    d = str(date).strip()
    if d == "":
        return None
    return f"{d}T00:00:00.000Z"


def event_id_ga4_session(brand_id, property_id, date, source, medium, campaign, channel, device, country):
    def _s(x):
        return "" if x is None else str(x)
    seed = (
        f"{brand_id}:ga4:{property_id}:{_s(date)}:{_s(source)}:{_s(medium)}:"
        f"{_s(campaign)}:{_s(channel)}:{_s(device)}:{_s(country)}:ga4.session.v1"
    )
    return uuid_shaped(seed)


def _to_minor_string(value):
    """Mirror the normalizer payload step: int minor → string (the TS revenue_minor is a string)."""
    m = major_decimal_to_minor_string(value)
    return None if m is None else str(m)


def _normalize_row(v):
    """Reproduce the canonical ga4.session.v1 fields from the RAW row using ONLY the ports above."""
    row = v["raw_row"]
    brand = v["brand_id"]
    prop = v["property_id"]
    date = str(row.get("date") or "").strip()
    src_cnt = v["samples_read_count"]
    space = v["sampling_space_size"]
    return {
        "event_id": event_id_ga4_session(
            brand, prop, date,
            row.get("sessionSource"), row.get("sessionMedium"), row.get("sessionCampaignName"),
            row.get("sessionDefaultChannelGroup"), row.get("deviceCategory"), row.get("country")),
        "occurred_at": ga4_occurred_at(row.get("date")),
        "revenue_minor": _to_minor_string(row.get("totalRevenue")),
        "currency_code": str(v["currency_input"]).strip().upper(),
        "sessions": to_count_string(row.get("sessions")),
        "engaged_sessions": to_count_string(row.get("engagedSessions")),
        "bounces": resolve_bounces(row.get("bounces"), row.get("bounceRate"), row.get("sessions")),
        "total_users": to_count_string(row.get("totalUsers")),
        "new_users": to_count_string(row.get("newUsers")),
        "screen_page_views": to_count_string(row.get("screenPageViews")),
        "event_count": to_count_string(row.get("eventCount")),
        "conversions": to_count_string(row.get("conversions")),
        "is_sampled": (src_cnt is not None) or (space is not None),
        "samples_read_count": src_cnt if ((src_cnt is not None) or (space is not None)) else None,
        "sampling_space_size": space if ((src_cnt is not None) or (space is not None)) else None,
    }


def test_ga4_session_ports_match_ts():
    vectors = json.load(open(GOLDEN))
    assert vectors, "no golden vectors"
    for v in vectors:
        got = _normalize_row(v)
        exp = v["expected"]
        for field in exp:
            assert got[field] == exp[field], (
                f"ga4 row date={v['raw_row'].get('date')!r} field {field}: "
                f"port={got[field]!r} != ts={exp[field]!r}"
            )


if __name__ == "__main__":
    test_ga4_session_ports_match_ts()
    n = len(json.load(open(GOLDEN)))
    print(f"OK — all {n} ga4 golden vectors match the PySpark ports byte-for-byte "
          f"(money + counts + sampling + occurred_at + event_id).")
