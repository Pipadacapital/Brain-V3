"""
silver_page_view.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_page_view.py.

The page-view BEHAVIOR grain — one row per (brand_id, event_id) browser page-view signal from the
universal first-party pixel, normalized to one analytics-facing shape (powers the behavior/funnel
dashboards: pageviews, product-views, collection-views, bounce, entry-page). DISTINCT from
silver_touchpoint (journey/attribution per-touch) and silver_sessions (30-min rollup): this is the raw
page-impression fact. Parity target: brain_silver.silver_page_view (43544 rows).

FAITHFUL to the Spark build():
  - SOURCES: page.viewed | product.viewed | collection.viewed (single lane — same event grain;
    page_event discriminates page|product|collection).
  - projections verbatim: brain_anon_id, session_id, page_type, path (landing_path), referrer,
    utm.{source,medium,campaign,term,content}, click_ids.{fbclid,gclid,ttclid,msclkid,gbraid,wbraid,dclid},
    product_handle, collection_handle, device.{ua_class→device_class, viewport}.
  - page_event CASE (page.viewed→page, product.viewed→product, collection.viewed→collection, else page).
  - referrer_host: regexp of referrer stripping scheme + path (^[a-zA-Z]+://([^/]+).*$ → $1); NULL when
    referrer NULL/empty.
  - channel: the deterministic ladder reproduced verbatim from silver_touchpoint.py (fbclid→paid_meta,
    gclid|gbraid|wbraid|dclid→paid_google, ttclid→paid_tiktok, msclkid→paid_bing, utm_medium ladder,
    referrer→referral, else direct) so behavior-side channel matches journey-side touchpoint channel.
  - GATE ORDER (verbatim): structural PK guard (event_id + brand_id NOT NULL) → Stage-1
    empty_identifier:brain_anon_id drop (anon-keyed grain; a no-anon row cannot tie to a journey) →
    Stage-1 DQ gate (occurred_at ONLY — future/unparseable → dropped). money/currency,
    impossible_quantity, clean_name/clean_string rules are N/A on this grain.
  - dedup: merge_on_pk on (brand_id, event_id), DESC by (ingested_at, occurred_at) — identical to Spark.

MONEY: NONE — a page-view is not monetary (no money column).
PII: hashed/anon-only — brain_anon_id is an opaque pseudonymous pixel id; utm/click-id are campaign metadata.
ISOLATION: brand_id first + bucket(256, brand_id) partition anchor + day(occurred_at).

CAVEAT — quarantine side-write SKIPPED: the Spark job diverts the empty_identifier + dq rejects to
brain_silver.silver_quarantine (stage='dq') via write_quarantine and drops them. This DuckDB port preserves
the SAME admission set (good rows are data-equivalent — the canonical table is byte-identical) but does NOT
write the quarantine ledger (no _silver_technical analogue here). Bronze keeps every original, so the
quarantine ledger remains rebuildable separately.

Honors MIGRATION_TABLE_SUFFIX (→ silver_page_view_duckdb_test) for the parallel-run parity harness.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GATED_SOURCE, ensure_table, incremental_window, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write to silver_page_view_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_page_view{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

PAGE_EVENTS = ["page.viewed", "product.viewed", "collection.viewed"]

# 5-minute clock-skew grace for "future" timestamps — DEFAULT_SKEW_MS parity (occurred_at is already a
# parsed timestamp here, so "unparseable" collapses to NULL and is excluded alongside future-dated rows).
_SKEW = "INTERVAL 5 MINUTE"

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

COLUMNS = [
    "brand_id", "event_id", "brain_anon_id", "session_id", "page_event", "page_type",
    "path", "referrer", "referrer_host", "channel", "utm_source", "utm_medium",
    "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "ttclid", "msclkid",
    "gbraid", "wbraid", "dclid", "product_handle", "collection_handle", "device_class",
    "viewport", "occurred_at", "ingested_at",
]

# page_event discriminant — verbatim CASE port of _page_event (event_type → normalized page grain).
_PAGE_EVENT = (
    "CASE event_type "
    "WHEN 'page.viewed'       THEN 'page' "
    "WHEN 'product.viewed'    THEN 'product' "
    "WHEN 'collection.viewed' THEN 'collection' "
    "ELSE 'page' END"
)


def _channel() -> str:
    """Deterministic channel ladder — verbatim from silver_touchpoint.py so behavior- and journey-side agree.

    nz(x) = x IS NOT NULL AND x <> '' (the Spark `nz` helper for click ids). utm_medium branches mirror
    Spark's lower(...).isin(...) / == comparisons (NULL-safe: a NULL utm_medium fails every isin/==, so it
    falls through — same as Spark). Column order of the ladder is preserved exactly.
    """
    def nz(c: str) -> str:
        return f"({c} IS NOT NULL AND {c} <> '')"

    med = "lower(utm_medium)"
    return (
        "CASE "
        f"WHEN {nz('fbclid')} THEN 'paid_meta' "
        f"WHEN {nz('gclid')} OR {nz('gbraid')} OR {nz('wbraid')} OR {nz('dclid')} THEN 'paid_google' "
        f"WHEN {nz('ttclid')} THEN 'paid_tiktok' "
        f"WHEN {nz('msclkid')} THEN 'paid_bing' "
        f"WHEN {med} IN ('cpc', 'ppc', 'paid') THEN 'paid' "
        f"WHEN {med} = 'email' THEN 'email' "
        f"WHEN {med} IN ('social', 'paid_social') THEN 'organic_social' "
        f"WHEN {med} = 'referral' THEN 'referral' "
        "WHEN referrer IS NOT NULL AND referrer <> '' THEN 'referral' "
        "ELSE 'direct' END"
    )


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL)

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) ─────────────────────────────────────────────
    #   per_event grain: each gated keystone row → 0..1 page-view row via the idempotent MERGE on
    #   (brand_id, event_id), so windowing the SOURCE read on ingested_at is safe. read_gated_events_sql
    #   builds the [lo, hi) predicate itself and OMITS it when lo/hi are None → default OFF (lo=None) is a
    #   byte-identical full scan.
    lo, hi = incremental_window(con, "silver-page-view", GATED_SOURCE, ts_col="ingested_at")

    # Project the three page-view event shapes into ONE canonical row shape (single lane — same event
    # grain; page_event discriminates). All click-id/utm/handle fields are NULL by construction when the
    # source event does not carry them.
    raw = f"""
      SELECT brand_id, event_id, event_type,
             {prop('pj', 'brain_anon_id')}  AS brain_anon_id,
             {prop('pj', 'session_id')}     AS session_id,
             {prop('pj', 'page_type')}      AS page_type,
             {prop('pj', 'landing_path')}   AS path,
             {prop('pj', 'referrer')}       AS referrer,
             {prop('pj', 'utm.source')}     AS utm_source,
             {prop('pj', 'utm.medium')}     AS utm_medium,
             {prop('pj', 'utm.campaign')}   AS utm_campaign,
             {prop('pj', 'utm.term')}       AS utm_term,
             {prop('pj', 'utm.content')}    AS utm_content,
             {prop('pj', 'click_ids.fbclid')}  AS fbclid,
             {prop('pj', 'click_ids.gclid')}   AS gclid,
             {prop('pj', 'click_ids.ttclid')}  AS ttclid,
             {prop('pj', 'click_ids.msclkid')} AS msclkid,
             {prop('pj', 'click_ids.gbraid')}  AS gbraid,
             {prop('pj', 'click_ids.wbraid')}  AS wbraid,
             {prop('pj', 'click_ids.dclid')}   AS dclid,
             {prop('pj', 'product_handle')}    AS product_handle,
             {prop('pj', 'collection_handle')} AS collection_handle,
             {prop('pj', 'device.ua_class')}   AS device_class,
             {prop('pj', 'device.viewport')}   AS viewport,
             occurred_at, ingested_at
      FROM ({read_gated_events_sql(PAGE_EVENTS, lo=lo, hi=hi)})
    """

    # Derive page_event, referrer_host (scheme+path stripped from referrer), channel.
    typed = f"""
      SELECT brand_id, event_id, brain_anon_id, session_id,
             {_PAGE_EVENT} AS page_event, page_type, path, referrer,
             CASE WHEN referrer IS NOT NULL AND referrer <> ''
                  THEN regexp_replace(referrer, '^[a-zA-Z]+://([^/]+).*$', '\\1')
                  ELSE CAST(NULL AS VARCHAR) END AS referrer_host,
             {_channel()} AS channel,
             utm_source, utm_medium, utm_campaign, utm_term, utm_content,
             fbclid, gclid, ttclid, msclkid, gbraid, wbraid, dclid,
             product_handle, collection_handle, device_class, viewport,
             occurred_at, ingested_at
      FROM ({raw})
      WHERE event_id IS NOT NULL AND brand_id IS NOT NULL   -- structural PK guard
    """

    # Stage-1 empty_identifier:brain_anon_id drop (anon-keyed grain — a no-anon row cannot tie to a
    # journey), then Stage-1 DQ gate (occurred_at ONLY: present + not future beyond the 5-min skew).
    # Rejected rows are simply not emitted (quarantine side-write skipped — see module docstring).
    good = f"""
      SELECT {', '.join(COLUMNS)} FROM ({typed})
      WHERE brain_anon_id IS NOT NULL AND brain_anon_id <> ''
        AND occurred_at IS NOT NULL
        AND occurred_at <= now() + {_SKEW}
    """

    return merge_on_pk(con, TARGET, good, COLUMNS, ["brand_id", "event_id"],
                       order_by_desc=["ingested_at", "occurred_at"])


if __name__ == "__main__":
    run_job("silver-page-view", build, target_table="silver_page_view")
