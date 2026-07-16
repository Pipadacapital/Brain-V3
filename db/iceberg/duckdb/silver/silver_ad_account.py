"""
silver_ad_account.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_ad_account.py.

The ad-ACCOUNT DIMENSION — exactly ONE row per (brand_id, platform, ad_account_id): the connected
advertising account a brand spends through (the root of account → campaign → adset → ad). Reads the gated
keystone (event_type='spend.live.v1'), resolves the account id, rolls up a LIFETIME spend/impressions/clicks
+ first/last-seen aggregate, joins the LATEST currency/timezone (by occurred_at), and MERGEs the recomputed
dimension.

GRAIN : (brand_id, platform, ad_account_id). ad_account_id resolves ad_account_id → account_id; a spend row
        with no resolvable account id is dropped from the dimension.
MONEY : lifetime_spend_minor is bigint MINOR units (a FULL recompute — the MERGE UPDATE is the authoritative
        latest rollup, never double-counts) + currency_code (default INR).
PII   : none. ISOLATION: brand_id first + bucket() anchor.

QUARANTINE SKIPPED: the Spark job runs a Stage-1 DQ money/currency gate over the rolled-up dimension →
  silver_quarantine (stage='dq') before the MERGE (occurred_at gate intentionally N/A — last_seen_at is an
  aggregate). The migration framework has no quarantine seam, so — matching the other ports — this port does
  NOT write the side-table and does NOT re-implement the dq drop; Bronze keeps the originals (replay-safe).
  Good rows are identical.

DATA AVAILABILITY: the spend mapper does not yet stamp the activated ad_account_id onto each spend.live.v1
  row, so the account id is absent in Bronze → 0 rows is the honest output; the moment it carries the
  activated ad_account_id this dimension populates with no code change.

Parity target: brain_silver.silver_ad_account (NEW).
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

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_ad_account_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_ad_account{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SPEND_EVENT = "spend.live.v1"

COLUMNS_SQL = """
  brand_id              string    NOT NULL,
  platform              string    NOT NULL,
  ad_account_id         string    NOT NULL,
  account_timezone      string,
  lifetime_spend_minor  bigint    NOT NULL,
  currency_code         string    NOT NULL,
  lifetime_impressions  bigint,
  lifetime_clicks       bigint,
  campaign_count        bigint,
  first_seen_at         timestamp,
  last_seen_at          timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "platform", "ad_account_id", "account_timezone", "lifetime_spend_minor",
    "currency_code", "lifetime_impressions", "lifetime_clicks", "campaign_count", "first_seen_at",
    "last_seen_at",
]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(last_seen_at)")

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) ─────────────────────────────────────────────
    #   GRAIN = entity_fold: MANY spend rows roll up into ONE (brand_id, platform, ad_account_id) row whose
    #   lifetime spend/impressions/clicks + first/last-seen depend on events that may sit BELOW the
    #   watermark. Windowing the fold input directly would silently drop history → wrong money. So we window
    #   ONLY to DISCOVER the changed entity keys, then re-fold each changed entity over its FULL history via
    #   a semi-join. Default OFF → lo=None → NO changed-set, NO semi-join → byte-identical full recompute.
    lo, hi = incremental_window(con, "silver-ad-account", GATED_SOURCE, ts_col="ingested_at")

    # ── typed spend rows: resolve account id (ad_account_id → account_id), default money/counts to 0. ──
    #    fold_filter is EMPTY when lo is None (full recompute, unchanged) and, when incremental is on, a
    #    semi-join that restricts the FULL-history fold to ONLY the entities that changed in [lo, hi).
    fold_filter = ""
    if lo is not None:
        changed = f"""
          SELECT DISTINCT
            brand_id,
            coalesce({prop('pj','platform')}, 'unknown')                     AS platform,
            coalesce({prop('pj','ad_account_id')}, {prop('pj','account_id')}) AS ad_account_id
          FROM ({read_gated_events_sql([SPEND_EVENT], lo=lo, hi=hi)})
          WHERE coalesce({prop('pj','ad_account_id')}, {prop('pj','account_id')}) IS NOT NULL
            AND coalesce({prop('pj','ad_account_id')}, {prop('pj','account_id')}) <> ''
        """
        # Leading "\n        " lives INSIDE the string so the EMPTY (lo=None) case leaves the `typed`
        # SQL byte-identical to the pre-incremental version — no stray blank/whitespace line.
        fold_filter = (
            "\n        AND (brand_id, coalesce({p}, 'unknown'), coalesce({a}, {ac})) "
            "IN (SELECT brand_id, platform, ad_account_id FROM ({changed}))"
        ).format(
            p=prop('pj', 'platform'),
            a=prop('pj', 'ad_account_id'),
            ac=prop('pj', 'account_id'),
            changed=changed,
        )

    # ── typed spend rows: resolve account id (ad_account_id → account_id), default money/counts to 0. ──
    typed = f"""
      SELECT
        brand_id,
        coalesce({prop('pj','platform')}, 'unknown')                          AS platform,
        coalesce({prop('pj','ad_account_id')}, {prop('pj','account_id')})      AS ad_account_id,
        {prop('pj','account_timezone')}                                       AS account_timezone,
        coalesce(CAST({prop('pj','spend_minor')} AS BIGINT), CAST(0 AS BIGINT)) AS spend_minor,
        coalesce({prop('pj','currency_code')}, 'INR')                         AS currency_code,
        coalesce(CAST({prop('pj','impressions')} AS BIGINT), CAST(0 AS BIGINT)) AS impressions,
        coalesce(CAST({prop('pj','clicks')} AS BIGINT), CAST(0 AS BIGINT))     AS clicks,
        {prop('pj','campaign_id')}                                            AS campaign_id,
        occurred_at, ingested_at
      FROM ({read_gated_events_sql([SPEND_EVENT])})
      WHERE coalesce({prop('pj','ad_account_id')}, {prop('pj','account_id')}) IS NOT NULL
        AND coalesce({prop('pj','ad_account_id')}, {prop('pj','account_id')}) <> ''{fold_filter}
    """

    # ── latest currency/timezone for the account (by occurred_at DESC) — a re-pull could restate. ──
    latest_meta = f"""
      SELECT brand_id, platform, ad_account_id,
             currency_code AS latest_ccy, account_timezone AS latest_tz
      FROM (
        SELECT *, row_number() OVER (
          PARTITION BY brand_id, platform, ad_account_id ORDER BY occurred_at DESC) AS _rn
        FROM ({typed})
      ) WHERE _rn = 1
    """

    # ── lifetime rollup (FULL recompute over current Bronze). ──
    rollup = f"""
      SELECT brand_id, platform, ad_account_id,
             sum(spend_minor)            AS lifetime_spend_minor,
             sum(impressions)            AS lifetime_impressions,
             sum(clicks)                 AS lifetime_clicks,
             count(DISTINCT campaign_id) AS campaign_count,
             min(occurred_at)            AS first_seen_at,
             max(occurred_at)            AS last_seen_at
      FROM ({typed})
      GROUP BY brand_id, platform, ad_account_id
    """

    staged = f"""
      SELECT
        r.brand_id, r.platform, r.ad_account_id,
        m.latest_tz                        AS account_timezone,
        r.lifetime_spend_minor,
        coalesce(m.latest_ccy, 'INR')      AS currency_code,
        r.lifetime_impressions,
        r.lifetime_clicks,
        r.campaign_count,
        r.first_seen_at,
        r.last_seen_at
      FROM ({rollup}) r
      LEFT JOIN ({latest_meta}) m
        ON r.brand_id = m.brand_id AND r.platform = m.platform AND r.ad_account_id = m.ad_account_id
    """

    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "platform", "ad_account_id"],
                       order_by_desc=["last_seen_at"])


if __name__ == "__main__":
    run_job("silver-ad-account", build, target_table="silver_ad_account")
