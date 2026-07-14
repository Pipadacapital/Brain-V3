"""
silver_journey.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_journey.py.

The JOURNEY ENTITY grain — exactly 1 row per (brand_id, brain_anon_id): the reconstructed visitor
journey summary (first/last touch, first/last channel, first utm, landing_path, touch + session counts,
conversion signal). NET-NEW (no dbt predecessor; parity status=NEW in Spark). Journey before attribution;
deterministic first.

SOURCE  : the gated keystone rest.brain_silver.silver_collector_event (ADR-0006 P3), same set Spark's
          read_bronze_events(JOURNEY_EVENTS) reads. (Spark's BRONZE_TABLE resolves to this gated table.)
GRAIN   : 1 row per (brand_id, brain_anon_id). NULL/'' brain_anon_id CANNOT be sessionized → DROPPED
          (the same honest drop; we NEVER synthesize an anon id).
CHANNEL : first/last channel via the SAME deterministic CASE ladder as int_touchpoint_sessionized
          (click_id → utm.medium → referrer → direct). NEVER a model (D-5 / deterministic-first).
CONVERSION: converted = the anon emitted any of payment.succeeded / order.placed / purchase.completed.
MONEY   : none — the journey entity carries no money.
ISOLATION: brand_id first column + bucket() partition anchor.

FAITHFUL to the Spark build() (verbatim grain/ordering/derivation):
  - Touch-grain read of JOURNEY_EVENTS; structural guard (brand_id + event_id NOT NULL).
  - Stage-1 empty_identifier drop: brain_anon_id NOT NULL/'' (anon-keyed grain).
  - Stage-1 DQ gate (per touch): occurred_at present AND <= now()+5min skew (dq_violations_udf over
    occurred_at only — money/currency/quantity rules N/A on this entity). A bad-timestamp touch is
    excluded from the journey it would otherwise distort.
  - Bronze idempotency dedup: collapse re-delivered event_id to ONE touch, keeping earliest occurred_at
    (row_number over (brand_id, event_id) ORDER BY occurred_at ASC, keep #1) — verbatim.
  - channel ladder + is_conversion.
  - Server-side 30-min sessionization RE-DERIVED from source: session starts when prev is NULL or the gap
    from the previous touch (same anon) exceeds 1800s; session_seq = running sum of session-starts; the
    journey's session_count = count(distinct session_seq).
  - first/last touch chosen by (occurred_at, event_id) ASC / DESC respectively (deterministic tiebreak),
    yielding first_channel / last_channel / first_utm_source / first_utm_campaign / landing_path.
  - Aggregate to 1 row per anon; converted = OR over is_conversion; is_synthetic = OR over the touch flag.
  - updated_at = now(); idempotent MERGE on (brand_id, brain_anon_id), order_by_desc=[last_touch_at].

CAVEAT — quarantine side-write SKIPPED: the Spark job routes the empty_identifier drop AND the
bad-timestamp DQ rejects to brain_silver.silver_quarantine (stage='dq'). This DuckDB port preserves the
SAME admitted set (the surviving touches roll up identically) but does NOT write the quarantine ledger
(no _silver_technical analogue here). Bronze keeps the originals, so the ledger can be rebuilt separately.

Honors MIGRATION_TABLE_SUFFIX (→ silver_journey_duckdb_test) for the parallel-run parity harness.
The Spark side is ENTITY-INCREMENTAL (per visitor, full history); this DuckDB build reads the full gated
source in ONE pass — that same full recompute, replay-safe (deterministic GROUP BY + MERGE).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_journey{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

# Same captured behavioral set as stg_touchpoint_events / the Spark JOURNEY_EVENTS.
JOURNEY_EVENTS = [
    "page.viewed", "product.viewed", "collection.viewed", "cart.viewed", "cart.item_added",
    "cart.item_removed", "cart.updated", "search.submitted", "checkout.started", "checkout.step_viewed",
    "checkout.shipping_selected", "payment.initiated", "payment.succeeded", "payment.failed",
    "order.placed", "purchase.completed", "coupon.applied", "form.submitted", "user.logged_in",
    "user.signed_up", "identify", "scroll.depth", "element.clicked", "rage.click", "dead.click",
]
CONVERSION_EVENTS = ["payment.succeeded", "order.placed", "purchase.completed"]

SKEW_MINUTES = 5  # DEFAULT_SKEW_MS = 5min (dq_violations_udf future_occurred_at grace).
SESSION_GAP_SECONDS = 1800  # 30-min server-side sessionization window.

COLUMNS_SQL = """
  brand_id           string    NOT NULL,
  brain_anon_id      string    NOT NULL,
  first_touch_at     timestamp NOT NULL,
  last_touch_at      timestamp NOT NULL,
  first_channel      string,
  last_channel       string,
  first_utm_source   string,
  first_utm_campaign string,
  landing_path       string,
  touch_count        bigint    NOT NULL,
  session_count      bigint    NOT NULL,
  converted          boolean   NOT NULL,
  is_synthetic       boolean,
  updated_at         timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "brain_anon_id", "first_touch_at", "last_touch_at", "first_channel", "last_channel",
    "first_utm_source", "first_utm_campaign", "landing_path", "touch_count", "session_count",
    "converted", "is_synthetic", "updated_at",
]


def _nz(name: str) -> str:
    """Non-null, non-empty guard — DuckDB analogue of the Spark `nz()` helper in _channel()."""
    return f"({name} IS NOT NULL AND {name} <> '')"


def _channel() -> str:
    """The deterministic channel ladder — byte-identical to int_touchpoint_sessionized / Spark _channel()."""
    medium = "lower(coalesce(utm_medium, ''))"
    return (
        "CASE "
        f"WHEN {_nz('fbclid')} THEN 'paid_meta' "
        f"WHEN {_nz('gclid')} OR {_nz('gbraid')} OR {_nz('wbraid')} OR {_nz('dclid')} THEN 'paid_google' "
        f"WHEN {_nz('ttclid')} THEN 'paid_tiktok' "
        f"WHEN {_nz('msclkid')} THEN 'paid_bing' "
        f"WHEN {medium} IN ('cpc', 'ppc', 'paid') THEN 'paid' "
        f"WHEN {medium} = 'email' THEN 'email' "
        f"WHEN {medium} IN ('social', 'paid_social') THEN 'organic_social' "
        f"WHEN {medium} = 'referral' THEN 'referral' "
        f"WHEN {_nz('referrer')} THEN 'referral' "
        "ELSE 'direct' END"
    )


def _gated_utc(event_types):
    """read_gated_events_sql, re-projecting occurred_at/ingested_at to UTC-naive (parity with Spark UTC
    instants; a bare TIMESTAMPTZ would render in the session-local zone and shift the wall-clock)."""
    return (
        "SELECT brand_id, event_id, event_type, "
        "occurred_at AT TIME ZONE 'UTC' AS occurred_at, "
        "ingested_at AT TIME ZONE 'UTC' AS ingested_at, pj "
        f"FROM ({read_gated_events_sql(event_types)})"
    )


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(first_touch_at)")

    # ── Touch-grain projection (mirrors the Spark `base` select). ──
    base = f"""
      SELECT brand_id, event_id, event_type, occurred_at,
             {prop('pj','brain_anon_id')}   AS brain_anon_id,
             {prop('pj','utm.source')}      AS utm_source,
             {prop('pj','utm.medium')}      AS utm_medium,
             {prop('pj','utm.campaign')}    AS utm_campaign,
             {prop('pj','click_ids.fbclid')}  AS fbclid,
             {prop('pj','click_ids.gclid')}   AS gclid,
             {prop('pj','click_ids.ttclid')}  AS ttclid,
             {prop('pj','click_ids.msclkid')} AS msclkid,
             {prop('pj','click_ids.gbraid')}  AS gbraid,
             {prop('pj','click_ids.wbraid')}  AS wbraid,
             {prop('pj','click_ids.dclid')}   AS dclid,
             {prop('pj','referrer')}        AS referrer,
             {prop('pj','landing_path')}    AS landing_path,
             CASE WHEN {prop('pj','_synthetic')} = 'true' THEN TRUE ELSE FALSE END AS is_synthetic
      FROM ({_gated_utc(JOURNEY_EVENTS)})
      WHERE brand_id IS NOT NULL AND event_id IS NOT NULL
    """

    # ── Stage-1 empty_identifier drop (anon-keyed grain) + Stage-1 DQ gate (occurred_at present AND not
    #    future beyond skew). money/currency/quantity DQ rules are N/A on this entity. ──
    keyed = f"""
      SELECT * FROM ({base})
      WHERE brain_anon_id IS NOT NULL AND brain_anon_id <> ''
        AND occurred_at IS NOT NULL                                    -- unparseable_timestamp
        AND (occurred_at AT TIME ZONE 'UTC')
            <= (now() AT TIME ZONE 'UTC') + INTERVAL {SKEW_MINUTES} MINUTE   -- future_occurred_at
    """

    # ── Bronze idempotency dedup: collapse a re-delivered event_id to ONE touch (earliest occurred_at). ──
    touches = f"""
      SELECT brand_id, event_id, event_type, occurred_at, brain_anon_id, utm_source, utm_medium,
             utm_campaign, referrer, landing_path, is_synthetic,
             ({_channel()}) AS channel,
             (event_type IN ({", ".join(f"'{e}'" for e in CONVERSION_EVENTS)})) AS is_conversion
      FROM (
        SELECT *, row_number() OVER (PARTITION BY brand_id, event_id ORDER BY occurred_at ASC) AS _dedup_rn
        FROM ({keyed})
      ) WHERE _dedup_rn = 1
    """

    # ── Server-side 30-min sessionization RE-DERIVED per (brand_id, brain_anon_id). session_seq = running
    #    sum of session-starts (prev NULL OR gap > 1800s). ──
    sessionized = f"""
      SELECT *,
             sum(_session_start) OVER (
               PARTITION BY brand_id, brain_anon_id ORDER BY occurred_at ASC
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS session_seq
      FROM (
        SELECT *,
               CASE
                 WHEN _prev IS NULL THEN 1
                 WHEN (epoch(occurred_at) - epoch(_prev)) > {SESSION_GAP_SECONDS} THEN 1
                 ELSE 0
               END AS _session_start
        FROM (
          SELECT *,
                 lag(occurred_at) OVER (
                   PARTITION BY brand_id, brain_anon_id ORDER BY occurred_at ASC
                 ) AS _prev
          FROM ({touches})
        )
      )
    """

    # ── first/last touch by (occurred_at, event_id) ASC / DESC (deterministic tiebreak). ──
    enriched = f"""
      SELECT *,
             row_number() OVER (
               PARTITION BY brand_id, brain_anon_id ORDER BY occurred_at ASC,  event_id ASC
             ) AS _first,
             row_number() OVER (
               PARTITION BY brand_id, brain_anon_id ORDER BY occurred_at DESC, event_id DESC
             ) AS _last
      FROM ({sessionized})
    """

    # ── Aggregate to the journey-entity grain (1 row per anon). ──
    agg = f"""
      SELECT
        brand_id, brain_anon_id,
        min(occurred_at) AS first_touch_at,
        max(occurred_at) AS last_touch_at,
        max(CASE WHEN _first = 1 THEN channel END)      AS first_channel,
        max(CASE WHEN _last  = 1 THEN channel END)      AS last_channel,
        max(CASE WHEN _first = 1 THEN utm_source END)   AS first_utm_source,
        max(CASE WHEN _first = 1 THEN utm_campaign END) AS first_utm_campaign,
        max(CASE WHEN _first = 1 THEN landing_path END) AS landing_path,
        CAST(count(*) AS BIGINT)                        AS touch_count,
        CAST(count(DISTINCT session_seq) AS BIGINT)     AS session_count,
        coalesce(max(CASE WHEN is_conversion THEN TRUE ELSE FALSE END), FALSE) AS converted,
        max(CASE WHEN is_synthetic THEN TRUE ELSE FALSE END) AS is_synthetic
      FROM ({enriched})
      GROUP BY brand_id, brain_anon_id
    """

    staged = f"""
      SELECT brand_id, brain_anon_id, first_touch_at, last_touch_at, first_channel, last_channel,
             first_utm_source, first_utm_campaign, landing_path, touch_count, session_count,
             converted, is_synthetic, now() AT TIME ZONE 'UTC' AS updated_at
      FROM ({agg})
    """

    return merge_on_pk(con, TARGET, staged, COLUMNS,
                       ["brand_id", "brain_anon_id"], order_by_desc=["last_touch_at"])


if __name__ == "__main__":
    run_job("silver-journey", build, target_table="silver_journey")
