"""
silver_campaign.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_campaign.py.

NET-NEW canonical Silver `campaign` DIMENSION — one row per (brand_id, platform, campaign_id) —
distinct from the per-day spend FACT. Folds TWO event types from the gated keystone:

  - 'spend.live.v1'    — per-day spend FACT. Drives the lifetime rollup (spend/impressions/clicks/
                         conversions), first/last-seen, and the fallback campaign name.
  - 'ad.entity.updated' — the AUTHORITATIVE campaign-metadata feed (CAMPAIGN level only). Carries the
                         latest name/status/objective/advertising_channel_type + FIREHOSE depth cols,
                         DECOUPLED from spend volume. OPTIONAL: when absent the entity side is empty and
                         the dim falls back to the spend-row name (empty-safe revival).

GRAIN   : 1 row per (brand_id, platform, campaign_id). FULL OUTER of spend-rollup ⋈ latest-entity, so a
          campaign known from EITHER source gets a row. campaign_id NOT NULL/'' (account/adset noise dropped).
MONEY   : lifetime_spend_minor / campaign_budget_amount_minor are BIGINT MINOR units + currency_code.
ISOLATION: brand_id first + bucket() partition anchor.

STAGE-1 FLAG (never a drop): received_conversion_while_inactive = TRUE iff the campaign is EXPLICITLY
  inactive (status in the inactive set) AND carries conversions (>0). Unknown status → false. No row is
  quarantined here (no quarantine side-write in this framework — parity with the Spark FLAG-not-drop rule).

Idempotency: a full GROUP-BY recompute over current Bronze is deterministic; MERGE on the PK is the
  authoritative latest rollup (never double-counts). Entity-incremental in Spark re-folds each entity over
  its FULL history — the DuckDB build() reads the full gated source unfiltered, so ONE pass = that same
  full recompute (replay-safe). Parity target: brain_silver.silver_campaign (221 rows).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import (  # noqa: E402
    GATED_SOURCE,
    ensure_table,
    incremental_window,
    merge_on_pk,
    prop,
    read_gated_events_sql,
    run_job,
)
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_campaign{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SPEND_EVENT = "spend.live.v1"
ENTITY_EVENT = "ad.entity.updated"

_INACTIVE = ("paused", "inactive", "disabled", "archived", "removed", "ended")

COLUMNS_SQL = """
  brand_id              string    NOT NULL,
  platform              string    NOT NULL,
  campaign_id           string    NOT NULL,
  campaign_name         string,
  lifetime_spend_minor  bigint    NOT NULL,
  currency_code         string    NOT NULL,
  lifetime_impressions  bigint,
  lifetime_clicks       bigint,
  first_seen_at         timestamp,
  last_seen_at          timestamp NOT NULL,
  received_conversion_while_inactive boolean,
  campaign_status            string,
  objective                  string,
  advertising_channel_type   string,
  advertising_channel_sub_type  string,
  bidding_strategy_type         string,
  start_date                    string,
  end_date                      string,
  campaign_budget_amount_minor  bigint
""".strip("\n")

COLUMNS = [
    "brand_id", "platform", "campaign_id", "campaign_name", "lifetime_spend_minor", "currency_code",
    "lifetime_impressions", "lifetime_clicks", "first_seen_at", "last_seen_at",
    "received_conversion_while_inactive", "campaign_status", "objective", "advertising_channel_type",
    "advertising_channel_sub_type", "bidding_strategy_type", "start_date", "end_date",
    "campaign_budget_amount_minor",
]


def _gated_utc(event_types):
    """read_gated_events_sql, but re-project occurred_at/ingested_at to UTC-naive.

    The gated source stores occurred_at/ingested_at as TIMESTAMP WITH TIME ZONE. Our Silver columns are
    naive `timestamp` (Iceberg parity with Spark, which persists UTC instants). A bare read renders a
    TIMESTAMPTZ in the DuckDB session's LOCAL zone, so storing it into a naive column would shift the
    wall-clock off UTC (the Spark table's convention). `AT TIME ZONE 'UTC'` pins the wall-clock to UTC
    regardless of the session TZ — byte-parity with the Spark UTC instants. (Framework-agnostic: done
    here, in the job, without touching _base.read_gated_events_sql.)
    """
    return (
        "SELECT brand_id, event_id, event_type, "
        "occurred_at AT TIME ZONE 'UTC' AS occurred_at, "
        "ingested_at AT TIME ZONE 'UTC' AS ingested_at, pj "
        f"FROM ({read_gated_events_sql(event_types)})"
    )


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL)

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) — GRAIN=entity_fold, so CHANGED-ENTITY REFOLD ──
    #   This dim FOLDS many gated-keystone rows (spend.live.v1 + ad.entity.updated) into ONE row per
    #   (brand_id, platform, campaign_id), and the rollup depends on events BELOW the watermark — so we must
    #   NOT window the fold input directly. Instead we window the source ONLY to discover which entity keys
    #   changed this batch, then re-fold each changed entity over its FULL, UNWINDOWED history; the MERGE on
    #   the entity PK upserts exactly those. Default OFF (lo=None) → NO changed-set, NO semi-join → the SQL
    #   is byte-identical to the pre-incremental full recompute.
    lo, hi = incremental_window(con, "silver-campaign", GATED_SOURCE, ts_col="ingested_at")

    # CHANGED-KEY set: UNION of both event types' entity-key derivations, each with the SAME not-null/''
    # guard its fold side uses — spend uses campaign_id directly; entity uses coalesce(campaign_id, entity_id)
    # at CAMPAIGN level. Built from a WINDOWED [lo, hi) read; only referenced when lo is not None.
    changed = None
    if lo is not None:
        changed_spend = f"""
          SELECT brand_id,
                 coalesce({prop('pj','platform')}, 'unknown') AS platform,
                 {prop('pj','campaign_id')} AS campaign_id
          FROM ({read_gated_events_sql([SPEND_EVENT], lo=lo, hi=hi)})
          WHERE {prop('pj','campaign_id')} IS NOT NULL AND {prop('pj','campaign_id')} <> ''
        """
        changed_entity = f"""
          SELECT brand_id,
                 coalesce({prop('pj','platform')}, 'unknown') AS platform,
                 coalesce({prop('pj','campaign_id')}, {prop('pj','entity_id')}) AS campaign_id
          FROM ({read_gated_events_sql([ENTITY_EVENT], lo=lo, hi=hi)})
          WHERE lower({prop('pj','level')}) = 'campaign'
            AND coalesce({prop('pj','campaign_id')}, {prop('pj','entity_id')}) IS NOT NULL
            AND coalesce({prop('pj','campaign_id')}, {prop('pj','entity_id')}) <> ''
        """
        changed = (
            "SELECT DISTINCT brand_id, platform, campaign_id FROM ("
            f"({changed_spend}) UNION ALL ({changed_entity}))"
        )

    # Semi-join clause folded into each fold input's WHERE — only when lo is not None (else empty string).
    spend_semijoin = (
        f" AND (brand_id, coalesce({prop('pj','platform')}, 'unknown'), {prop('pj','campaign_id')}) "
        f"IN (SELECT brand_id, platform, campaign_id FROM ({changed}))"
        if lo is not None else ""
    )
    entity_semijoin = (
        f" AND (brand_id, coalesce({prop('pj','platform')}, 'unknown'), "
        f"coalesce({prop('pj','campaign_id')}, {prop('pj','entity_id')})) "
        f"IN (SELECT brand_id, platform, campaign_id FROM ({changed}))"
        if lo is not None else ""
    )

    # ── Spend FACT side: per-row projection (campaign_id NOT NULL/'' → account/adset noise dropped). ──
    #   Reads the FULL, UNWINDOWED spend history; the changed-entity semi-join (empty when lo is None)
    #   narrows the re-fold to only campaigns touched this batch — full history per changed entity.
    spend = f"""
      SELECT brand_id,
             coalesce({prop('pj','platform')}, 'unknown') AS platform,
             {prop('pj','campaign_id')} AS campaign_id,
             {prop('pj','campaign_name')} AS campaign_name,
             coalesce(CAST({prop('pj','spend_minor')} AS BIGINT), CAST(0 AS BIGINT)) AS spend_minor,
             coalesce({prop('pj','currency_code')}, 'INR') AS currency_code,
             coalesce(CAST({prop('pj','impressions')} AS BIGINT), CAST(0 AS BIGINT)) AS impressions,
             coalesce(CAST({prop('pj','clicks')} AS BIGINT), CAST(0 AS BIGINT)) AS clicks,
             coalesce(CAST({prop('pj','conversions')} AS BIGINT), CAST(0 AS BIGINT)) AS conversions,
             occurred_at, ingested_at
      FROM ({_gated_utc([SPEND_EVENT])})
      WHERE {prop('pj','campaign_id')} IS NOT NULL AND {prop('pj','campaign_id')} <> ''{spend_semijoin}
    """

    # latest spend-row name/ccy per campaign (row_number by occurred_at DESC, keep #1).
    latest_spend_name = f"""
      SELECT brand_id, platform, campaign_id,
             campaign_name AS spend_name, currency_code AS spend_ccy
      FROM (SELECT *, row_number() OVER (
              PARTITION BY brand_id, platform, campaign_id ORDER BY occurred_at DESC) AS _rn
            FROM ({spend})) WHERE _rn = 1
    """

    rollup = f"""
      SELECT brand_id, platform, campaign_id,
             sum(spend_minor)  AS lifetime_spend_minor,
             sum(impressions)  AS lifetime_impressions,
             sum(clicks)       AS lifetime_clicks,
             sum(conversions)  AS lifetime_conversions,
             min(occurred_at)  AS first_seen_at,
             max(occurred_at)  AS spend_last_seen
      FROM ({spend}) GROUP BY brand_id, platform, campaign_id
    """

    spend_side = f"""
      SELECT r.*, n.spend_name, n.spend_ccy
      FROM ({rollup}) r
      LEFT JOIN ({latest_spend_name}) n
        ON r.brand_id = n.brand_id AND r.platform = n.platform AND r.campaign_id = n.campaign_id
    """

    # ── Entity DIMENSION side: ad.entity.updated, CAMPAIGN level only. campaign_id = explicit prop else entity_id. ──
    entity = f"""
      SELECT brand_id,
             coalesce({prop('pj','platform')}, 'unknown') AS platform,
             lower({prop('pj','level')}) AS level,
             coalesce({prop('pj','campaign_id')}, {prop('pj','entity_id')}) AS campaign_id,
             {prop('pj','name')} AS entity_name,
             lower({prop('pj','status')}) AS entity_status,
             {prop('pj','objective')} AS objective,
             {prop('pj','advertising_channel_type')} AS advertising_channel_type,
             {prop('pj','advertising_channel_sub_type')} AS advertising_channel_sub_type,
             {prop('pj','bidding_strategy_type')} AS bidding_strategy_type,
             {prop('pj','campaign_start_date')} AS start_date,
             {prop('pj','campaign_end_date')} AS end_date,
             CAST({prop('pj','campaign_budget_amount_minor')} AS BIGINT) AS campaign_budget_amount_minor,
             occurred_at AS entity_occurred_at
      FROM ({_gated_utc([ENTITY_EVENT])})
      WHERE lower({prop('pj','level')}) = 'campaign'
        AND coalesce({prop('pj','campaign_id')}, {prop('pj','entity_id')}) IS NOT NULL
        AND coalesce({prop('pj','campaign_id')}, {prop('pj','entity_id')}) <> ''{entity_semijoin}
    """

    latest_entity = f"""
      SELECT brand_id, platform, campaign_id, entity_name, entity_status, objective,
             advertising_channel_type, advertising_channel_sub_type, bidding_strategy_type,
             start_date, end_date, campaign_budget_amount_minor, entity_occurred_at
      FROM (SELECT *, row_number() OVER (
              PARTITION BY brand_id, platform, campaign_id ORDER BY entity_occurred_at DESC) AS _rn
            FROM ({entity})) WHERE _rn = 1
    """

    # ── FULL OUTER so a campaign known from EITHER source gets a row; keys coalesced. ──
    combined = f"""
      SELECT
        coalesce(s.brand_id, e.brand_id)       AS brand_id,
        coalesce(s.platform, e.platform)       AS platform,
        coalesce(s.campaign_id, e.campaign_id) AS campaign_id,
        s.lifetime_spend_minor, s.lifetime_impressions, s.lifetime_clicks, s.lifetime_conversions,
        s.first_seen_at, s.spend_last_seen, s.spend_name, s.spend_ccy,
        e.entity_name, e.entity_status, e.objective, e.advertising_channel_type,
        e.advertising_channel_sub_type, e.bidding_strategy_type, e.start_date, e.end_date,
        e.campaign_budget_amount_minor, e.entity_occurred_at
      FROM ({spend_side}) s
      FULL OUTER JOIN ({latest_entity}) e
        ON s.brand_id = e.brand_id AND s.platform = e.platform AND s.campaign_id = e.campaign_id
    """

    # is_active from AUTHORITATIVE entity status; unknown → NULL (never flagged).
    is_active = (
        "CASE WHEN entity_status IN ('active','enabled','running') THEN TRUE "
        f"WHEN entity_status IN ({', '.join(repr(s) for s in _INACTIVE)}) THEN FALSE "
        "ELSE NULL END"
    )
    # received_conversion_while_inactive: TRUE iff is_active IS FALSE and conversions > 0 (else FALSE).
    flag = (
        f"coalesce(({is_active}) = FALSE AND coalesce(lifetime_conversions, 0) > 0, FALSE)"
    )

    staged = f"""
      SELECT
        brand_id, platform, campaign_id,
        coalesce(entity_name, spend_name) AS campaign_name,
        coalesce(lifetime_spend_minor, CAST(0 AS BIGINT)) AS lifetime_spend_minor,
        coalesce(spend_ccy, 'INR') AS currency_code,
        lifetime_impressions, lifetime_clicks,
        coalesce(first_seen_at, entity_occurred_at) AS first_seen_at,
        coalesce(greatest(spend_last_seen, entity_occurred_at), spend_last_seen, entity_occurred_at) AS last_seen_at,
        {flag} AS received_conversion_while_inactive,
        entity_status AS campaign_status,
        objective, advertising_channel_type,
        advertising_channel_sub_type, bidding_strategy_type, start_date, end_date,
        campaign_budget_amount_minor
      FROM ({combined})
    """

    return merge_on_pk(con, TARGET, staged, COLUMNS,
                       ["brand_id", "platform", "campaign_id"], order_by_desc=["last_seen_at"])


if __name__ == "__main__":
    run_job("silver-campaign", build, target_table="silver_campaign")
