"""
gold_contribution_margin.py — NET-NEW gap Gold `contribution_margin` mart (Brain V4 Phase 2, GROUP "NEW gap Gold").

NO dbt predecessor (parity status=NEW; matrix §3/4). The materialized CM1/CM2 margin surface — one row per
(brand_id, currency_code) reproducing the TS computeContributionMargin (contribution-margin.ts, the True-CM2
moat) BYTE/MINOR-UNIT EXACT, but as a Gold mart over the lakehouse:

  net_revenue_minor = realized (net) revenue, per (brand, currency), from Iceberg
                      brain_silver.silver_order_state.order_value_minor (Σ of recognized rows, EXCLUDING
                      placed/provisional — silver_order_state already nets to the recognized total per order;
                      Σ over the brand's orders = the brand's realized revenue, the TS realized_gmv math).
  cogs_minor        = net_revenue × cogs pct_bps / 10000  (INTEGER floor — pctOf, NO float, I-S07).
  variable_minor    = net_revenue × Σ(shipping|packaging|payment_fee|marketplace_fee pct_bps) / 10000.
  cm1_minor         = net_revenue − cogs − variable.
  marketing_minor   = Σ spend_minor from Iceberg brain_silver.silver_marketing_spend, per currency
                      (the ad_spend cumulative math; ONLY the brand's currency contributes — M1 single-ccy).
  cm2_minor         = cm1 − marketing.
  cost_confidence   = FLOOR over the brand's cost_input confidences; 'Insufficient' when NO cogs input
                      (the honest 'D' that keeps the billing cap from applying — TS parity).

Config tier (cost pct rates + brand currency) reads operational Postgres over JDBC — the SAME source the TS
reads (cost_inputs_as_of → billing.cost_input global scope; tenancy.brand.currency_code) — so the pct math
is identical. Money tier (realized + spend) reads the Iceberg Silver lakehouse. Per-currency, NEVER blended.

pctOf reproduced EXACTLY: (revenue_minor * trunc(pct_bps)) / 10000 with INTEGER (floor-toward-zero for the
non-negative revenue/pct here) division — Spark bigint `/` over two bigints is integer division, matching
the TS BigInt `/`. cogs applies to net_revenue; brand-period CM uses pct inputs (fixed per-order amounts are
the M2 order_margin_fact refinement — excluded here, exactly as the TS).

GRAIN   : 1 row per (brand_id, currency_code). brand_id first column + partition anchor.
REPLAY-SAFE: full recompute from Silver + PG config, MERGE-UPDATE'd on (brand_id, currency_code).

DATA NOTE: current billing.cost_input has 0 rows → cogs/variable=0, cost_confidence='Insufficient',
cm1=cm2=net_revenue−marketing — the honest no-COGS posture, IDENTICAL to the TS with no cost inputs.
"""
from __future__ import annotations

import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver  # noqa: E402
from pyspark.sql import SparkSession  # noqa: E402

TABLE = "gold_contribution_margin"

# Operational Postgres (config tier) — the SAME source the TS reads for cost pcts + brand currency.
PG_JDBC_URL = os.environ.get("GOLD_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain")
PG_USER = os.environ.get("GOLD_PG_USER", "brain")
PG_PASSWORD = os.environ.get("GOLD_PG_PASSWORD", "brain")

# The variable-cost types (TS VARIABLE_COST_TYPES) — applied as pct of revenue alongside cogs.
VARIABLE_COST_TYPES = ("shipping", "packaging", "payment_fee", "marketplace_fee")

COLUMNS_SQL = """
          brand_id           string    NOT NULL,
          currency_code      string    NOT NULL,
          as_of_date         date      NOT NULL,
          net_revenue_minor  bigint    NOT NULL,
          cogs_minor         bigint    NOT NULL,
          variable_minor     bigint    NOT NULL,
          cm1_minor          bigint    NOT NULL,
          marketing_minor    bigint    NOT NULL,
          cm2_minor          bigint    NOT NULL,
          cost_confidence    string    NOT NULL,
          updated_at         timestamp NOT NULL
""".strip("\n")


def _read_cost_config(spark: SparkSession):
    """Per-brand currently-effective GLOBAL cost pct rates + confidence (cost_inputs_as_of equivalent).

    Mirrors the TS config read: billing.cost_input WHERE scope='global', picking the latest-effective row
    per (brand_id, cost_type) as of today (effective_from <= today AND (effective_to IS NULL OR >= today)).
    Returns brand-level aggregated cogs_pct_bps / variable_pct_bps + has_cogs + a confidence FLOOR rank.
    Read as the PG superuser (cross-brand ETL read — same posture as silver_order_state's dimension reads).
    """
    var_in = ", ".join(f"'{t}'" for t in VARIABLE_COST_TYPES)
    # Rank=Insufficient(0)|Estimated(1)|Trusted(2); brand-level floor = MIN(rank) over the brand's inputs.
    # NOTE: passed via the JDBC `query` option — Spark wraps it as SELECT * FROM (<this>) <alias>, so the
    # text must be a bare SELECT with NO outer parens / alias of its own (a CTE prefix is fine).
    query = f"""
       WITH eff AS (
          SELECT brand_id::text AS brand_id, cost_type, pct_bps, cost_confidence,
                 row_number() OVER (
                   PARTITION BY brand_id, cost_type
                   ORDER BY effective_from DESC
                 ) AS rn
          FROM billing.cost_input
          WHERE scope = 'global'
            AND pct_bps IS NOT NULL
            AND effective_from <= CURRENT_DATE
            AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
       ),
       latest AS (SELECT * FROM eff WHERE rn = 1)
       SELECT
         brand_id,
         COALESCE(SUM(CASE WHEN cost_type = 'cogs' THEN pct_bps ELSE 0 END), 0)            AS cogs_pct_bps,
         COALESCE(SUM(CASE WHEN cost_type IN ({var_in}) THEN pct_bps ELSE 0 END), 0)       AS variable_pct_bps,
         bool_or(cost_type = 'cogs')                                                       AS has_cogs,
         MIN(CASE cost_confidence WHEN 'Insufficient' THEN 0 WHEN 'Estimated' THEN 1
                                  WHEN 'Trusted' THEN 2 ELSE 0 END)                        AS confidence_rank
       FROM latest
       GROUP BY brand_id
    """
    return (
        spark.read.format("jdbc")
        .option("url", PG_JDBC_URL)
        .option("user", PG_USER)
        .option("password", PG_PASSWORD)
        .option("driver", "org.postgresql.Driver")
        .option("query", query)
        .load()
    )


def _read_brand_currency(spark: SparkSession):
    """Per-brand reporting currency (tenancy.brand.currency_code) — the M1 single-currency anchor."""
    query = "SELECT id::text AS brand_id, currency_code FROM tenancy.brand"
    return (
        spark.read.format("jdbc")
        .option("url", PG_JDBC_URL)
        .option("user", PG_USER)
        .option("password", PG_PASSWORD)
        .option("driver", "org.postgresql.Driver")
        .option("query", query)
        .load()
    )


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")
    as_of = date.today().isoformat()

    # ── Money tier (Iceberg Silver): realized revenue + marketing spend, per (brand, currency) ──────────
    spark.sql(
        f"""
        SELECT brand_id,
               COALESCE(currency_code, 'INR') AS currency_code,
               COALESCE(SUM(COALESCE(order_value_minor, 0)), 0) AS net_revenue_minor
        FROM {silver('silver_order_state')}
        WHERE brand_id IS NOT NULL
        GROUP BY brand_id, COALESCE(currency_code, 'INR')
        """
    ).createOrReplaceTempView("_cm_realized")

    spark.sql(
        f"""
        SELECT brand_id,
               COALESCE(currency_code, 'INR') AS currency_code,
               COALESCE(SUM(COALESCE(spend_minor, 0)), 0) AS marketing_minor
        FROM {silver('silver_marketing_spend')}
        WHERE brand_id IS NOT NULL
        GROUP BY brand_id, COALESCE(currency_code, 'INR')
        """
    ).createOrReplaceTempView("_cm_marketing")

    # ── Config tier (PG): cost pct rates + brand currency ──────────────────────────────────────────────
    _read_cost_config(spark).createOrReplaceTempView("_cm_cost")
    _read_brand_currency(spark).createOrReplaceTempView("_cm_ccy")

    # CM math — integer minor units (pctOf = revenue * pct_bps / 10000, bigint division = TS BigInt `/`).
    # marketing only contributes in the brand's reporting currency (M1) — joined on (brand, currency==ccy).
    staged = spark.sql(
        f"""
        WITH base AS (
            SELECT
                r.brand_id,
                r.currency_code,
                r.net_revenue_minor,
                COALESCE(c.cogs_pct_bps, 0)      AS cogs_pct_bps,
                COALESCE(c.variable_pct_bps, 0)  AS variable_pct_bps,
                COALESCE(c.has_cogs, false)      AS has_cogs,
                c.confidence_rank                AS confidence_rank,
                -- marketing only when this row's currency IS the brand's reporting currency (M1 single-ccy).
                CASE WHEN bc.currency_code = r.currency_code
                     THEN COALESCE(m.marketing_minor, 0) ELSE 0 END AS marketing_minor
            FROM _cm_realized r
            LEFT JOIN _cm_cost c     ON r.brand_id = c.brand_id
            LEFT JOIN _cm_ccy  bc    ON r.brand_id = bc.brand_id
            LEFT JOIN _cm_marketing m ON r.brand_id = m.brand_id AND r.currency_code = m.currency_code
        ),
        calc AS (
            SELECT
                brand_id,
                currency_code,
                net_revenue_minor,
                -- pctOf: bigint floor division (matches TS BigInt `(rev * pct)/10000n`).
                (net_revenue_minor * CAST(cogs_pct_bps AS bigint)) / 10000      AS cogs_minor,
                (net_revenue_minor * CAST(variable_pct_bps AS bigint)) / 10000  AS variable_minor,
                marketing_minor,
                has_cogs,
                confidence_rank
            FROM base
        )
        SELECT
            brand_id,
            currency_code,
            CAST('{as_of}' AS date)                                   AS as_of_date,
            net_revenue_minor,
            cogs_minor,
            variable_minor,
            (net_revenue_minor - cogs_minor - variable_minor)         AS cm1_minor,
            marketing_minor,
            (net_revenue_minor - cogs_minor - variable_minor - marketing_minor) AS cm2_minor,
            -- cost_confidence: no COGS ⇒ Insufficient (can't trust margin); else the floor of input confidences.
            CASE
                WHEN has_cogs = false OR confidence_rank IS NULL THEN 'Insufficient'
                WHEN confidence_rank = 2 THEN 'Trusted'
                WHEN confidence_rank = 1 THEN 'Estimated'
                ELSE 'Insufficient'
            END                                                       AS cost_confidence,
            current_timestamp()                                       AS updated_at
        FROM calc
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "currency_code"], delete_orphans=True)  # AUD-IMPL-012: full per-brand recompute — shed disappeared-group orphans
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-contribution-margin", build, entity_incremental={
        "table_name": "gold_contribution_margin", "source_tables": ["silver_order_state", "silver_marketing_spend"],
    })
