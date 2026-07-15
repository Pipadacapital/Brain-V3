"""
silver_ga4_normalize.py (DuckDB) — faithful port of
db/iceberg/spark/silver/silver_ga4_normalize.py (ADR-0006 P4).

Reads the RAW GA4 runReport Bronze (the ADR-0010 Kafka-Connect `ga4_rows_raw_connect` lane — the verbatim
provider row nested under `row`), reconstructs the canonical ga4.session.v1 envelope in `payload`, and MERGEs
the silver_collector_event 14-column contract into the SHADOW table silver_collector_event_ga4_shadow
(dual-run parity; TARGET_TABLE / MIGRATION_TABLE_SUFFIX override). GA4 rows carry NO PII (I-S02) — so, unlike
the Shopify exemplar, there is NO per-brand salt join and NO hashed identifier columns.

CORRECTNESS: shared crypto goes through the VENDORED port (_raw_normalize_ports.uuid_shaped); the four GA4
connector-LOCAL ports (major_decimal_to_minor_string / to_count_string / resolve_bounces / event_id seed)
are ported HERE, byte-for-byte with the Spark job (which is itself byte-verified in test_ga4-golden.py).
PK is (brand_id, event_id); money (revenue_minor) is BIGINT minor + a sibling currency_code.

STAGE-1 QUARANTINE SKIPPED (parity-preserving, per the migration rule): the Spark job routes the inline
drop-gate complement (un-seedable event_id / malformed revenue / empty date) to silver_quarantine
(stage='dq'). This port does NOT write that diagnostic ledger — Bronze keeps the originals (replay-safe) so
it can be rebuilt separately. The ADMITTED (good-row) set is IDENTICAL: the same `event_id IS NOT NULL AND
revenue_minor IS NOT NULL AND occurred_at_iso IS NOT NULL` predicate is applied before the MERGE.

Parity target: brain_silver.silver_collector_event_ga4_shadow (empty lane today → 0 rows, HONEST-EMPTY).
"""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402
from _normalize_base import (  # noqa: E402
    advance_lane_watermark, connect_source_table, ensure_shadow, lane_window, lane_window_predicate,
    merge_collector_event, run_normalize_job, source_present,
)
import _raw_normalize_ports as rn  # noqa: E402
from _silver_technical_ports import event_category  # noqa: E402

LANE = "ga4_rows_raw"
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}." + os.environ.get(
    "TARGET_TABLE", "silver_collector_event_ga4_shadow"
) + os.environ.get("MIGRATION_TABLE_SUFFIX", "")

_GA4_DECIMAL_RE = re.compile(r"^(\d+)(?:\.(\d+))?$")
_GA4_COUNT_RE = re.compile(r"^(\d+)(?:\.\d+)?$")


# ── Connector-LOCAL ports (byte-verified in test_ga4-golden.py; mirror @brain/ga4-mapper exactly) ─────
def major_decimal_to_minor_string(value):
    """majorDecimalToMinorString — GA4 major-unit decimal revenue → int minor. null/''/'0' → 0. TRUNCATE
    >2 frac (no rounding, no float). Malformed → None (quarantine). DISTINCT from decimal_to_minor_strict."""
    if value is None:
        return 0
    s = str(value).strip()
    if s == "" or s == "0":
        return 0
    m = _GA4_DECIMAL_RE.match(s)
    if not m:
        return None
    whole = m.group(1)
    frac = ((m.group(2) or "") + "00")[:2]
    return int(whole) * 100 + int(frac)


def to_count_string(value):
    """toCountString — integer-part-only count → str, or None if absent/invalid."""
    if value is None:
        return None
    s = str(value).strip()
    if s == "":
        return None
    m = _GA4_COUNT_RE.match(s)
    return m.group(1) if m else None


def resolve_bounces(bounces, bounce_rate, sessions):
    """resolveBounces — prefer `bounces`; else round(bounceRate*sessions) (JS Math.round: half up)."""
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
    """occurred_at — UTC midnight of the report date: `${date}T00:00:00.000Z`. Empty/absent → None."""
    if date is None:
        return None
    d = str(date).strip()
    if d == "":
        return None
    return f"{d}T00:00:00.000Z"


def event_id_ga4_session(brand_id, property_id, date, source, medium, campaign, channel, device, country):
    """uuidV5FromGa4Row — uuid_shaped over the ga4 dimension seed (absent dim → '')."""
    def _s(x):
        return "" if x is None else str(x)
    seed = (
        f"{brand_id}:ga4:{property_id}:{_s(date)}:{_s(source)}:{_s(medium)}:"
        f"{_s(campaign)}:{_s(channel)}:{_s(device)}:{_s(country)}:ga4.session.v1"
    )
    return rn.uuid_shaped(seed)


def _register_udfs(con) -> None:
    con.create_function("rn_minor", major_decimal_to_minor_string, ["VARCHAR"], "BIGINT",
                        null_handling="special")
    con.create_function("rn_count", to_count_string, ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_bounces", resolve_bounces, ["VARCHAR", "VARCHAR", "VARCHAR"], "VARCHAR",
                        null_handling="special")
    con.create_function("rn_occurred", lambda d: ga4_occurred_at(d), ["VARCHAR"], "VARCHAR",
                        null_handling="special")
    con.create_function(
        "rn_eid",
        lambda brand, prop, d, src, med, camp, chan, dev, cty:
            event_id_ga4_session(brand, prop, d, src, med, camp, chan, dev, cty) if (brand and d) else None,
        ["VARCHAR"] * 9, "VARCHAR", null_handling="special",
    )
    con.create_function("rn_event_category", event_category, ["VARCHAR"], "VARCHAR", null_handling="special")


def build(con):
    ensure_shadow(con, TARGET)
    if not source_present(con, LANE):
        print(f"[silver-ga4-normalize] {connect_source_table(LANE)} absent/empty — skipping "
              f"(empty lane; table auto-creates on first record, ADR-0010)", flush=True)
        return TARGET, 0
    _register_udfs(con)
    src = connect_source_table(LANE)

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) ─────────────────────────────────────────────
    #   GA4 is PER-EVENT (each raw GA4 row → 0..1 shadow row via the idempotent MERGE on (brand_id,
    #   event_id)), so narrowing the source read to a kafka_timestamp window is safe. Default OFF / first
    #   run / FULL_REFRESH → lo=None → lane_window_predicate == "" → byte-identical full scan.
    lo_ga4, hi_ga4 = lane_window(con, "silver-ga4-normalize", LANE)
    _pred_ga4 = lane_window_predicate(lo_ga4, hi_ga4)
    _ga4_where = f"\n      {_pred_ga4}" if _pred_ga4 else ""

    # The verbatim GA4 runReport row is nested under `row` (the connector wraps it). Envelope columns
    # (server-trusted brand_id / property_id / currency — MT-1) come from the record, NEVER the row body.
    df = f"""
      SELECT
        CAST(brand_id AS VARCHAR)                        AS brand_id,
        CAST(fetched_at AS VARCHAR)                      AS fetched_at,
        CAST(property_id AS VARCHAR)                     AS property_id,
        CAST(currency_code AS VARCHAR)                   AS currency_code_raw,
        CAST(samples_read_count AS VARCHAR)              AS samples_read_count,
        CAST(sampling_space_size AS VARCHAR)             AS sampling_space_size,
        CAST("row".date AS VARCHAR)                      AS date,
        CAST("row".sessionSource AS VARCHAR)             AS session_source,
        CAST("row".sessionMedium AS VARCHAR)             AS session_medium,
        CAST("row".sessionCampaignName AS VARCHAR)       AS session_campaign_name,
        CAST("row".sessionDefaultChannelGroup AS VARCHAR) AS session_default_channel_group,
        CAST("row".deviceCategory AS VARCHAR)            AS device_category,
        CAST("row".country AS VARCHAR)                   AS country,
        CAST("row".sessions AS VARCHAR)                  AS sessions,
        CAST("row".engagedSessions AS VARCHAR)           AS engaged_sessions,
        CAST("row".bounces AS VARCHAR)                   AS bounces_raw,
        CAST("row".bounceRate AS VARCHAR)                AS bounce_rate,
        CAST("row".totalUsers AS VARCHAR)                AS total_users,
        CAST("row".newUsers AS VARCHAR)                  AS new_users,
        CAST("row".screenPageViews AS VARCHAR)           AS screen_page_views,
        CAST("row".eventCount AS VARCHAR)                AS event_count,
        CAST("row".conversions AS VARCHAR)               AS conversions,
        CAST("row".totalRevenue AS VARCHAR)              AS total_revenue
      FROM {src}{_ga4_where}
    """

    canon = f"""
      SELECT *,
        rn_occurred(date)                                        AS occurred_at_iso,
        rn_minor(total_revenue)                                  AS revenue_minor,
        upper(trim(currency_code_raw))                           AS currency_code,
        rn_count(sessions)                                       AS c_sessions,
        rn_count(engaged_sessions)                               AS c_engaged,
        rn_bounces(bounces_raw, bounce_rate, sessions)           AS c_bounces,
        rn_count(total_users)                                    AS c_total_users,
        rn_count(new_users)                                      AS c_new_users,
        rn_count(screen_page_views)                              AS c_page_views,
        rn_count(event_count)                                    AS c_event_count,
        rn_count(conversions)                                    AS c_conversions,
        ((samples_read_count IS NOT NULL) OR (sampling_space_size IS NOT NULL)) AS is_sampled,
        trim(property_id)                                        AS property_id_t,
        trim(date)                                               AS date_t,
        rn_eid(brand_id, property_id, trim(date), session_source, session_medium,
               session_campaign_name, session_default_channel_group, device_category, country) AS event_id
      FROM ({df})
    """

    # Reconstruct the canonical ga4.session.v1 envelope. json_object drops NULL keys (Spark to_json(struct)
    # also omits null struct fields) so an absent dimension is OMITTED, matching the oracle payloads.
    props = (
        "json_object("
        "'source','ga4',"
        "'property_id', property_id_t,"
        "'date', date_t,"
        "'session_source', session_source,"
        "'session_medium', session_medium,"
        "'session_campaign_name', session_campaign_name,"
        "'session_default_channel_group', session_default_channel_group,"
        "'device_category', device_category,"
        "'country', country,"
        "'sessions', c_sessions,"
        "'engaged_sessions', c_engaged,"
        "'bounces', c_bounces,"
        "'total_users', c_total_users,"
        "'new_users', c_new_users,"
        "'screen_page_views', c_page_views,"
        "'event_count', c_event_count,"
        "'conversions', c_conversions,"
        "'revenue_minor', CAST(revenue_minor AS VARCHAR),"
        "'currency_code', currency_code,"
        "'is_sampled', is_sampled,"
        "'samples_read_count', samples_read_count,"
        "'sampling_space_size', sampling_space_size,"
        "'occurred_at', occurred_at_iso)"
    )
    payload = (
        "json_object('event_name','ga4.session.v1','occurred_at', occurred_at_iso, 'properties', "
        f"{props})"
    )

    good = f"""
      SELECT
        event_id,
        brand_id,
        CAST(occurred_at_iso AS TIMESTAMP)               AS occurred_at,
        CAST(fetched_at AS TIMESTAMP)                    AS ingested_at,
        'brain.collector.event.v1'                       AS schema_name,
        CAST(1 AS INTEGER)                               AS schema_version,
        'ga4.session.v1'                                 AS event_type,
        rn_event_category('ga4.session.v1')              AS event_category,
        CAST(NULL AS VARCHAR)                            AS correlation_id,
        brand_id                                         AS partition_key,
        CAST(NULL AS VARCHAR)                            AS anonymous_id,
        CAST(NULL AS VARCHAR)                            AS device_id,
        CAST(1 AS INTEGER)                               AS silver_version,
        {payload}                                        AS payload
      FROM ({canon})
      WHERE event_id IS NOT NULL AND revenue_minor IS NOT NULL AND occurred_at_iso IS NOT NULL
    """

    n = merge_collector_event(con, TARGET, good)
    advance_lane_watermark(con, "silver-ga4-normalize", LANE, hi_ga4)
    return TARGET, n


if __name__ == "__main__":
    run_normalize_job("silver-ga4-normalize", build,
                      target_table="silver_collector_event_ga4_shadow")
