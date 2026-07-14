"""
gold_campaign_attribution.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_campaign_attribution.py.

NET-NEW Gold `campaign_attribution` mart (Brain V4 Phase 2): per-CAMPAIGN, per-MODEL attributed-revenue +
ROAS overlay. Closes gap #32c — the live read path exposes attribution at the CHANNEL grain only; this is
the proper per-campaign attribution surface so the Marketing UI can show ROAS per campaign, switchable by
attribution model.

GRAIN / PK — (brand_id, platform, campaign_id, model_id, currency_code):
  - model_id: the credit ledger apportions the SAME realized revenue under EVERY attribution model — summing
    across models would multi-count revenue, so attributed revenue is per-model. brand_id is pk[0].
  - currency_code: money is per-currency, NEVER blended. Spend and attributed revenue JOIN on currency_code —
    a currency mismatch means spend does not attach (spend_minor=0, roas_bps=NULL): honest, never cross-cy.

SOURCES (all read DIRECTLY from Iceberg, exactly like the Spark job):
  ATTRIBUTED REVENUE — {CATALOG}.brain_gold.gold_attribution_credit (the SIGNED credit ledger; ported
    SEPARATELY, may be EMPTY / absent). SUM(credited_revenue_minor) over row_kind IN ('credit','clawback')
    nets clawback. Read OPTIONALLY — absent → this mart writes EMPTY (no attributed revenue → no rows).
  SPEND + PLATFORM + NAME — prefer {CATALOG}.brain_gold.gold_campaign_performance (#29: the per-campaign
    spend surface); if that sibling Gold mart is absent, fall back to aggregating
    {CATALOG}.brain_silver.silver_marketing_spend directly (identical numbers) so this job never
    hard-depends on Gold→Gold refresh ordering; if neither exists, an empty spend CTE (spend_minor=0).

MONEY MATH (integer minor units, per-currency, NEVER float / blended — mirrors computeCampaignRoas):
  attributed_revenue_minor = Σ credited_revenue_minor (signed, net of clawback) per (brand,campaign,model,cy).
  spend_minor              = the campaign's spend.
  roas_bps                 = attributed_revenue_minor * 10000 // spend_minor (integer BASIS POINTS; NULL when
                             spend_minor=0 — honest, never a fabricated ∞ / divide-by-zero).
  ── PORT NOTE (integer division): Spark computes `(a * 10000) DIV b` over BIGINTs (truncating integer
     division). DuckDB's `/` on integers promotes to DOUBLE; to stay byte-identical we use DuckDB's `//`
     (integer division, truncating toward zero) — the exact analogue of Spark's DIV.

The mart is attribution-DRIVEN (attr LEFT JOIN spend): a campaign with spend but no attributed revenue yet
simply has NO row here (its spend still shows via gold_campaign_performance) — honest, never a fabricated
zero-attribution row. A campaign with attribution but no matching spend keeps spend_minor=0 / roas_bps=NULL.

GRAIN-PK: (brand_id, platform, campaign_id, model_id, currency_code). REPLAY-SAFE: full recompute from the
ledger(+spend), MERGE-UPDATE'd on the PK. ADDITIVE / non-breaking.

CAVEAT — orphan-shedding: the Spark job runs entity-incremental with a per-brand recompute; the DuckDB
  _base.merge_on_pk is MATCHED-UPDATE / NOT-MATCHED-INSERT only (no not-matched-by-source DELETE). For the
  parallel-run parity harness (fresh <table>_duckdb_test from the same sources) the admission set is
  identical; divergence only exists after an upstream group disappears between runs. Noted, not dropped.

QUARANTINE: none — this Gold rollup has no Stage-1/quarantine side-write (reads already-gated Silver/Gold);
  the DuckDB framework never writes a quarantine table either. Nothing to skip.

DATA NOTE: current Bronze has 0 spend rows + 0 stitched journeys → 0 credit rows → this writes a correct
  EMPTY mart today (parity oracle 0); it populates with no code change once spend syncs AND journeys stitch.

Honors MIGRATION_TABLE_SUFFIX (→ gold_campaign_attribution_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_campaign_attribution.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_campaign_attribution_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TABLE = "gold_campaign_attribution"
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

# The attribution credit Iceberg Gold mart (owned by the attribution group). REQUIRED source — if absent,
# this mart writes EMPTY (no attributed revenue → no campaign-attribution rows, honest).
ATTR_CREDIT_TABLE = f"{CATALOG}.{GOLD_NAMESPACE}.gold_attribution_credit"
# The per-campaign spend surface (#29). PREFERRED spend source; falls back to silver_marketing_spend.
CAMPAIGN_PERF_TABLE = f"{CATALOG}.{GOLD_NAMESPACE}.gold_campaign_performance"
SILVER_SPEND = f"{CATALOG}.{SILVER_NAMESPACE}.silver_marketing_spend"

# Row kinds that carry signed money in the credit ledger (credit = positive apportionment, clawback = the
# signed-negative reversal). Summing credited_revenue_minor over both nets the clawback exactly.
_MONEY_ROW_KINDS = ("credit", "clawback")

COLUMNS_SQL = """
  brand_id                 string    NOT NULL,
  platform                 string    NOT NULL,
  campaign_id              string    NOT NULL,
  model_id                 string    NOT NULL,
  currency_code            string    NOT NULL,
  campaign_name            string,
  attributed_revenue_minor bigint    NOT NULL,
  spend_minor              bigint    NOT NULL,
  attributed_order_count   bigint    NOT NULL,
  roas_bps                 bigint,
  updated_at               timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "platform", "campaign_id", "model_id", "currency_code", "campaign_name",
    "attributed_revenue_minor", "spend_minor", "attributed_order_count", "roas_bps", "updated_at",
]

PK = ["brand_id", "platform", "campaign_id", "model_id", "currency_code"]


def _table_exists(con, fq: str) -> bool:
    try:
        con.execute(f"SELECT 1 FROM {fq} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent → caller degrades gracefully.
        return False


def _spend_cte(con) -> str:
    """Spend/platform/name CTE. Prefer the pre-aggregated gold_campaign_performance (#29); if that sibling
    Gold mart is absent, aggregate silver_marketing_spend directly (identical numbers) so this job has no
    hard Gold→Gold ordering dependency. Either way: 1 row per (brand,platform,campaign,currency)."""
    if _table_exists(con, CAMPAIGN_PERF_TABLE):
        return f"""
        spend AS (
            SELECT brand_id, platform, campaign_id, currency_code, campaign_name,
                   CAST(spend_minor AS BIGINT) AS spend_minor
            FROM {CAMPAIGN_PERF_TABLE}
            WHERE brand_id IS NOT NULL AND campaign_id IS NOT NULL AND campaign_id <> ''
        )
        """
    if _table_exists(con, SILVER_SPEND):
        return f"""
        spend AS (
            SELECT
                brand_id,
                COALESCE(platform, 'unknown')              AS platform,
                campaign_id,
                COALESCE(currency_code, 'INR')             AS currency_code,
                MAX(campaign_name)                         AS campaign_name,
                COALESCE(SUM(COALESCE(spend_minor, 0)), 0) AS spend_minor
            FROM {SILVER_SPEND}
            WHERE brand_id IS NOT NULL AND campaign_id IS NOT NULL AND campaign_id <> ''
            GROUP BY brand_id, COALESCE(platform, 'unknown'), campaign_id, COALESCE(currency_code, 'INR')
        )
        """
    # No spend source at all → an empty spend CTE; every campaign-attribution row keeps spend_minor=0.
    return """
        spend AS (
            SELECT CAST(NULL AS VARCHAR) AS brand_id, CAST(NULL AS VARCHAR) AS platform,
                   CAST(NULL AS VARCHAR) AS campaign_id, CAST(NULL AS VARCHAR) AS currency_code,
                   CAST(NULL AS VARCHAR) AS campaign_name, CAST(0 AS BIGINT) AS spend_minor
            WHERE 1 = 0
        )
        """


def build(con):
    # brand-first tenant partitioning (mirrors the Spark bucket(64, brand_id)).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # The credit ledger is the REQUIRED attribution source. Absent → the empty target is already created;
    # nothing to MERGE. Exit clean (parity: both sides row-count 0).
    if not _table_exists(con, ATTR_CREDIT_TABLE):
        print(f"[gold-campaign-attribution] {ATTR_CREDIT_TABLE} absent — no attributed revenue → empty mart",
              flush=True)
        return 0

    row_kinds = ", ".join(f"'{k}'" for k in _MONEY_ROW_KINDS)

    # Faithful SQL port. attr (per brand/campaign/model/currency signed revenue) LEFT JOIN spend. Integer
    # `//` matches Spark's `DIV` (truncating); platform coalesced to 'unknown' from the spend side.
    staged = f"""
        WITH attr AS (
            SELECT
                brand_id,
                campaign_id,
                model_id,
                currency_code,
                COALESCE(SUM(credited_revenue_minor), 0) AS attributed_revenue_minor,
                COUNT(DISTINCT order_id)                 AS attributed_order_count
            FROM {ATTR_CREDIT_TABLE}
            WHERE campaign_id IS NOT NULL AND campaign_id <> ''
              AND row_kind IN ({row_kinds})
            GROUP BY brand_id, campaign_id, model_id, currency_code
        ),
        {_spend_cte(con)}
        SELECT
            attr.brand_id,
            COALESCE(spend.platform, 'unknown')          AS platform,
            attr.campaign_id,
            attr.model_id,
            attr.currency_code,
            spend.campaign_name                          AS campaign_name,
            CAST(attr.attributed_revenue_minor AS BIGINT) AS attributed_revenue_minor,
            CAST(COALESCE(spend.spend_minor, 0) AS BIGINT) AS spend_minor,
            CAST(attr.attributed_order_count AS BIGINT)  AS attributed_order_count,
            -- ROAS in integer BASIS POINTS; NULL when spend=0 (honest — never a fabricated ∞). Truncating
            -- int div (`//`) = Spark's DIV, keeps it bigint (no float money). Read-time ratio = roas/10000.
            CASE WHEN COALESCE(spend.spend_minor, 0) > 0
                 THEN (attr.attributed_revenue_minor * 10000) // spend.spend_minor
                 ELSE NULL END                           AS roas_bps,
            now() AT TIME ZONE 'UTC'                     AS updated_at
        FROM attr
        LEFT JOIN spend
               ON attr.brand_id      = spend.brand_id
              AND attr.campaign_id   = spend.campaign_id
              AND attr.currency_code = spend.currency_code
    """

    # The rollup is already 1 row per PK (GROUP BY upstream), so merge_on_pk's in-batch dedup is a no-op;
    # order_by_desc=[updated_at] is just a deterministic tie-break. MATCHED-UPDATE / NOT-MATCHED-INSERT.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at"])


if __name__ == "__main__":
    run_job("gold-campaign-attribution", build, target_table=TABLE)
