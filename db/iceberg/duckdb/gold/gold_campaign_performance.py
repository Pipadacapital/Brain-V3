"""
gold_campaign_performance.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_campaign_performance.py.

NET-NEW gap Gold `campaign_performance` mart (Brain V4 Phase 2, GROUP "NEW gap Gold"). NO dbt predecessor.
The materialized per-campaign marketing-performance surface — one row per
(brand_id, platform, campaign_id, currency_code) holding lifetime spend, impressions, clicks, attributed
revenue, and the integer-bps CTR / CPC / ROAS. Reads Iceberg brain_silver.silver_marketing_spend (the
per-campaign spend FACT) ⨝ brain_silver.silver_campaign (the campaign DIMENSION, for the latest name) ⨝
brain_gold.gold_attribution_credit (the attribution credit ledger, for attributed_minor — read ONLY IF that
Iceberg Gold mart exists; else attributed=0). This is the Gold materialization of the TS computeCampaignRoas
signal (attribution-campaign-roas.ts), aggregated to the campaign grain.

Money math (mirrors the TS / Spark exactly — integer minor units, per-currency — NEVER blend currencies):
  spend_minor       = Σ spend_minor per (brand, platform, campaign_id, currency) from silver_marketing_spend.
  attributed_minor  = Σ credited_revenue_minor (signed — net of clawback) per (brand, campaign_id, currency)
                      from gold_attribution_credit (joined on campaign_id + currency; 0 when the credit mart
                      is absent or has no rows for the campaign).
  roas_bps          = attributed_minor * 10000 // spend_minor (integer bps; NULL when spend=0 — honest, the
                      TS returns null roasRatio for spend=0, NEVER a fabricated ∞ / divide-by-zero).
  ctr_bps           = clicks * 10000 // impressions (integer bps; NULL when impressions=0).
  cpc_minor         = spend_minor // clicks (integer minor units; NULL when clicks=0).

  ── PORT NOTE (integer division): Spark computes `a * 10000 / b` over BIGINTs, and Spark's `/` on two
     integral types is INTEGER division that TRUNCATES toward zero. DuckDB's `/` on integers promotes to
     DOUBLE (would produce fractional bps). To stay byte-identical we use DuckDB's `//` (integer division,
     truncating) for the three integer-bps/minor ratios. The DOUBLE `platform_roas` deliberately keeps `/`
     (float division is the intended semantics there — see below).

Platform-reported VALIDATION measures (side-by-side with the Brain-attributed signal above — the platform's
own conversion value is a validation/reconciliation aid, NEVER a replacement for Brain attribution):
  platform_conv_value_minor = Σ conv_value_minor (bigint MINOR, shares currency_code, never blended) from
                      silver_marketing_spend — the platform-reported attributed REVENUE. NOT coalesced: a
                      SUM over all-NULL stays NULL so platform_roas honestly reports "no platform value",
                      never a fabricated 0 (absence stays NULL).
  platform_roas     = platform_conv_value_minor / spend_minor (DOUBLE ratio; NULL when spend_minor=0 OR
                      platform_conv_value_minor is NULL — honest, never a fabricated ∞ / divide-by-zero).

GRAIN / PK: 1 row per (brand_id, platform, campaign_id, currency_code). brand_id first + partition anchor.
MONEY: spend_minor / attributed_minor / cpc_minor / platform_conv_value_minor are bigint MINOR units paired
  with on-row currency_code (per-currency, GROUP BY currency_code isolates it; NEVER blended, never a float).
REPLAY-SAFE: full recompute from Silver(+optional Gold credit), MERGE-UPDATE'd on the PK (idempotent re-run).

CAVEAT — orphan-shedding: the Spark job passes delete_orphans=True (WHEN NOT MATCHED BY SOURCE DELETE) so a
full per-brand recompute sheds a disappeared group's Gold row. The DuckDB _base.merge_on_pk does NOT
implement a not-matched-by-source DELETE — this port is a MATCHED-UPDATE / NOT-MATCHED-INSERT MERGE only.
For the parallel-run parity harness (fresh <table>_duckdb_test built from the same Silver) the admission set
is identical; the divergence only exists after an upstream group disappears from Silver between runs. Noted,
not silently dropped.

QUARANTINE: none — this Gold rollup has no Stage-1/quarantine side-write (it reads already-gated Silver).

DATA NOTE: when Bronze has ZERO spend.live.v1, silver_marketing_spend / silver_campaign are empty → this
writes a correct EMPTY Gold mart; it populates with no code change once an ad connector syncs spend.

Honors MIGRATION_TABLE_SUFFIX (→ gold_campaign_performance_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_campaign_performance.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GOLD_INCREMENTAL, ensure_table, incremental_window, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_campaign_performance_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TABLE = "gold_campaign_performance"
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SILVER_SPEND = f"{CATALOG}.{SILVER_NAMESPACE}.silver_marketing_spend"
SILVER_CAMPAIGN = f"{CATALOG}.{SILVER_NAMESPACE}.silver_campaign"
# The attribution credit Iceberg Gold mart (owned by another Phase-2 group). Read OPTIONALLY — if absent,
# attributed revenue folds to 0 (the campaign-performance mart still materializes spend/CTR/CPC).
ATTR_CREDIT_TABLE = f"{CATALOG}.{GOLD_NAMESPACE}.gold_attribution_credit"

COLUMNS_SQL = """
  brand_id                  string    NOT NULL,
  platform                  string    NOT NULL,
  campaign_id               string    NOT NULL,
  currency_code             string    NOT NULL,
  campaign_name             string,
  spend_minor               bigint    NOT NULL,
  impressions               bigint    NOT NULL,
  clicks                    bigint    NOT NULL,
  attributed_minor          bigint    NOT NULL,
  ctr_bps                   bigint,
  cpc_minor                 bigint,
  roas_bps                  bigint,
  platform_conv_value_minor bigint,
  platform_roas             double,
  updated_at                timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "platform", "campaign_id", "currency_code", "campaign_name",
    "spend_minor", "impressions", "clicks", "attributed_minor",
    "ctr_bps", "cpc_minor", "roas_bps",
    "platform_conv_value_minor", "platform_roas", "updated_at",
]

PK = ["brand_id", "platform", "campaign_id", "currency_code"]


def _attr_credit_available(con) -> bool:
    """True iff the gold_attribution_credit Iceberg mart exists (read it for attributed revenue if so).

    Mirrors the Spark _attr_credit_available probe: absent → attributed revenue folds to 0 (still a valid
    mart). NOTE: when the mart EXISTS but is empty (current state), the attr CTE aggregates zero rows and
    attributed_minor folds to 0 via the LEFT JOIN + COALESCE — exactly the Spark behavior.
    """
    try:
        con.execute(f"SELECT 1 FROM {ATTR_CREDIT_TABLE} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent → attributed revenue folds to 0.
        return False


def build(con):
    # brand-first tenant partitioning (mirrors Spark bucket(64, brand_id)).
    ensure_table(con, TARGET, COLUMNS_SQL)

    # ── INCREMENTAL WINDOW (opt-in; GOLD_INCREMENTAL=1) — CHANGED-ENTITY REFOLD ────────────────────────
    #   GRAIN = entity_fold: MANY silver_marketing_spend rows aggregate into ONE
    #   (brand_id, platform, campaign_id, currency_code) campaign row whose lifetime spend/impressions/
    #   clicks/platform-conv totals depend on the campaign's FULL spend history — including rows BELOW the
    #   watermark. Windowing the fold input directly would silently drop history → wrong lifetime money.
    #   So we window ONLY to DISCOVER which campaigns changed (a new spend row landed since the last run),
    #   then re-fold each changed campaign over its FULL, UNWINDOWED spend history. The MERGE on the PK
    #   upserts exactly those restated rollups.
    #
    #   CLOCK: the fold-driving source is the spend FACT silver_marketing_spend. That mart's final projection
    #   DROPS ingested_at (used only for its own dedup) — its arrival/write clock is updated_at (NOW-stamped
    #   at each write → exactly "which spend rows changed since last run"). So ts_col='updated_at'.
    #
    #   TIER GATE: pass enabled=GOLD_INCREMENTAL so Gold flips INDEPENDENTLY of Silver (which is already ON in
    #   prod). Default OFF / first run / FULL_REFRESH → lo=None → NO changed-set, NO semi-join → the SQL below
    #   is byte-identical to the pre-incremental full recompute.
    lo, hi = incremental_window(con, "gold-campaign-performance", SILVER_SPEND,
                                ts_col="updated_at", enabled=GOLD_INCREMENTAL)

    # Window predicate as an EMPTY string when lo is None (byte-identical full scan); a [lo, hi] range over
    # the spend FACT's write clock otherwise.
    win = []
    if lo is not None:
        win.append(f"updated_at >= '{lo}'")
    if hi is not None:
        win.append(f"updated_at <= '{hi}'")
    spend_window = f" AND {' AND '.join(win)}" if win else ""

    # CHANGED-KEY set: campaigns whose spend FACT changed within [lo, hi], using the EXACT same key
    # derivation + guards the `spend` CTE fold uses (brand_id/campaign_id NOT NULL & non-empty; platform and
    # currency_code COALESCE'd to 'unknown'/'INR'). Built ONLY when incremental (lo not None).
    changed = f"""
      SELECT DISTINCT
             brand_id,
             COALESCE(platform, 'unknown')  AS platform,
             campaign_id,
             COALESCE(currency_code, 'INR') AS currency_code
      FROM {SILVER_SPEND}
      WHERE brand_id IS NOT NULL AND campaign_id IS NOT NULL AND campaign_id <> ''
        -- GAP-C: pin to 'campaign' level — adset rows carry the same campaign_id + spend and would
        -- double-count into the per-campaign rollup (adsets roll up to their campaign).
        AND level = 'campaign'{spend_window}
    """

    # Semi-join clause: when incremental, restrict the FULL-history `spend` fold to only the changed
    # campaigns so each re-folds over its ENTIRE spend history. The key expressions match the GROUP BY of the
    # `spend` CTE exactly. EMPTY when lo is None → unwindowed full recompute (byte-identical).
    refold_filter = (
        "              AND (brand_id, COALESCE(platform, 'unknown'), campaign_id, "
        f"COALESCE(currency_code, 'INR')) IN (SELECT brand_id, platform, campaign_id, currency_code "
        f"FROM ({changed}))\n"
        if lo is not None else ""
    )

    have_attr = _attr_credit_available(con)
    # Per-(brand, campaign_id, currency) attributed revenue — net of clawback (signed credited_revenue_minor),
    # exactly as computeCampaignRoas. When the credit mart is absent, an empty CTE keeps attributed_minor=0.
    attr_cte = (
        f"""
        attr AS (
            SELECT brand_id, campaign_id, currency_code,
                   COALESCE(SUM(credited_revenue_minor), 0) AS attributed_minor
            FROM {ATTR_CREDIT_TABLE}
            WHERE campaign_id IS NOT NULL
            GROUP BY brand_id, campaign_id, currency_code
        )
        """
        if have_attr
        else """
        attr AS (
            SELECT CAST(NULL AS VARCHAR) AS brand_id, CAST(NULL AS VARCHAR) AS campaign_id,
                   CAST(NULL AS VARCHAR) AS currency_code, CAST(0 AS BIGINT) AS attributed_minor
            WHERE 1 = 0
        )
        """
    )

    # Faithful SQL port of the Spark staged CTE. spend (per-campaign lifetime rollup from the spend FACT)
    # LEFT JOIN dim (silver_campaign, for the AUTHORITATIVE latest name) LEFT JOIN attr (credit ledger).
    # Integer-bps/minor ratios use `//` (truncating int division) to match Spark's integer `/`; platform_roas
    # keeps DOUBLE `/`.
    staged = f"""
        WITH spend AS (
            SELECT
                brand_id,
                COALESCE(platform, 'unknown')              AS platform,
                campaign_id,
                COALESCE(currency_code, 'INR')             AS currency_code,
                MAX(campaign_name)                         AS spend_campaign_name,
                COALESCE(SUM(COALESCE(spend_minor, 0)), 0) AS spend_minor,
                COALESCE(SUM(COALESCE(impressions, 0)), 0) AS impressions,
                COALESCE(SUM(COALESCE(clicks, 0)), 0)      AS clicks,
                -- Platform-reported attributed revenue (bigint MINOR, shares currency_code). NOT coalesced:
                -- SUM over all-NULL stays NULL so platform_roas honestly reports "no platform value", not 0.
                SUM(conv_value_minor)                      AS platform_conv_value_minor
            FROM {SILVER_SPEND}
            WHERE brand_id IS NOT NULL AND campaign_id IS NOT NULL AND campaign_id <> ''
              -- GAP-C: 'campaign' level only — adset rows share campaign_id + spend and would 2×-count.
              AND level = 'campaign'
{refold_filter}            GROUP BY brand_id, COALESCE(platform, 'unknown'), campaign_id, COALESCE(currency_code, 'INR')
        ),
        dim AS (
            SELECT brand_id, platform, campaign_id, campaign_name AS dim_campaign_name
            FROM {SILVER_CAMPAIGN}
        ),
        {attr_cte}
        SELECT
            spend.brand_id,
            spend.platform,
            spend.campaign_id,
            spend.currency_code,
            COALESCE(dim.dim_campaign_name, spend.spend_campaign_name) AS campaign_name,
            spend.spend_minor,
            spend.impressions,
            spend.clicks,
            COALESCE(attr.attributed_minor, 0)                        AS attributed_minor,
            -- CTR in integer bps (clicks*10000 / impressions), truncating int div; NULL when impressions=0.
            CASE WHEN spend.impressions > 0
                 THEN CAST(spend.clicks AS BIGINT) * 10000 // spend.impressions
                 ELSE NULL END                                       AS ctr_bps,
            -- CPC in integer minor units (spend / clicks), truncating int div; NULL when clicks=0.
            CASE WHEN spend.clicks > 0
                 THEN spend.spend_minor // spend.clicks
                 ELSE NULL END                                       AS cpc_minor,
            -- ROAS in integer bps; NULL when spend=0 (honest — never a fabricated ∞). Truncating int div.
            CASE WHEN spend.spend_minor > 0
                 THEN COALESCE(attr.attributed_minor, 0) * 10000 // spend.spend_minor
                 ELSE NULL END                                       AS roas_bps,
            -- Platform-reported VALIDATION measures, side-by-side with the Brain-attributed roas_bps above
            -- (validation/reconciliation aid, NEVER a replacement for Brain attribution). conv value is
            -- bigint MINOR sharing currency_code (never blended); platform_roas is a DOUBLE ratio, NULL when
            -- spend=0 or the platform reported no conv value (honest — never a fabricated ∞).
            spend.platform_conv_value_minor                          AS platform_conv_value_minor,
            CASE WHEN spend.spend_minor > 0 AND spend.platform_conv_value_minor IS NOT NULL
                 THEN CAST(spend.platform_conv_value_minor AS DOUBLE) / CAST(spend.spend_minor AS DOUBLE)
                 ELSE NULL END                                       AS platform_roas,
            now() AT TIME ZONE 'UTC'                                 AS updated_at
        FROM spend
        LEFT JOIN dim  ON spend.brand_id = dim.brand_id
                       AND spend.platform = dim.platform
                       AND spend.campaign_id = dim.campaign_id
        LEFT JOIN attr ON spend.brand_id = attr.brand_id
                       AND spend.campaign_id = attr.campaign_id
                       AND spend.currency_code = attr.currency_code
    """

    # The rollup is already 1 row per PK (GROUP BY upstream), so merge_on_pk's in-batch dedup is a no-op;
    # order_by_desc=[updated_at] is just a deterministic tie-break. MATCHED-UPDATE / NOT-MATCHED-INSERT.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at"])


if __name__ == "__main__":
    # The watermark tracks the spend FACT's write clock (silver_marketing_spend.updated_at) — this Gold
    # mart is folded from that Silver spend FACT, not the gated keystone default.
    run_job("gold-campaign-performance", build, target_table=TABLE,
            source_table=SILVER_SPEND, ts_col="updated_at")
