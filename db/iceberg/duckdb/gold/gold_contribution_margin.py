"""
gold_contribution_margin.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_contribution_margin.py.

NET-NEW gap Gold `contribution_margin` mart (Brain V4 Phase 2, GROUP "NEW gap Gold"). NO dbt predecessor
(parity status=NEW). The materialized CM1/CM2 margin surface — one row per (brand_id, currency_code)
reproducing the TS computeContributionMargin (packages/metric-engine/src/contribution-margin.ts, the
True-CM2 moat) BYTE/MINOR-UNIT EXACT, but as a Gold mart over the lakehouse:

  net_revenue_minor = realized (net) revenue, per (brand, currency), from Iceberg
                      brain_silver.silver_order_state.order_value_minor (Σ of recognized rows).
  cogs_minor        = net_revenue × cogs pct_bps // 10000   (INTEGER floor — pctOf, NO float, I-S07).
  variable_minor    = net_revenue × Σ(shipping|packaging|payment_fee|marketplace_fee pct_bps) // 10000.
  cm1_minor         = net_revenue − cogs − variable.
  marketing_minor   = Σ spend_minor from Iceberg brain_silver.silver_marketing_spend, per currency, credited
                      ONLY in the brand's reporting currency (M1 single-currency).
  cm2_minor         = cm1 − marketing.
  cost_confidence   = FLOOR over the brand's cost_input confidences; 'Insufficient' when NO cogs input
                      (the honest 'D' that keeps the billing cap from applying — TS parity).

TWO tiers, faithful to the Spark job:
  • MONEY tier (Iceberg Silver): realized + marketing spend. Per-currency, NEVER blended.
  • CONFIG tier (operational Postgres): cost pct rates (billing.cost_input scope='global') + brand
    reporting currency (tenancy.brand). The SAME source the TS reads, so the pct math is identical.

pctOf reproduced EXACTLY: (revenue_minor * trunc(pct_bps)) // 10000. Spark bigint `/` over two bigints is
INTEGER (truncating) division; TS BigInt `/` truncates toward zero; for the non-negative revenue/pct here
DuckDB `//` == floor == trunc — all three agree. cogs applies to net_revenue; brand-period CM uses pct
inputs (fixed per-order amounts are the M2 order_margin_fact refinement — excluded here, exactly as the TS).

── PG portability (DuckDB vs Spark JDBC) ────────────────────────────────────────────────────────────────
The Spark job reads Postgres over the JDBC driver. This DuckDB port reads the SAME two PG queries through
the DuckDB `postgres` extension (ATTACH). When Postgres is UNREACHABLE — the parallel-run parity harness /
prod-local posture, where only iceberg-rest + MinIO are up — both PG reads degrade GRACEFULLY to the honest
no-config posture:
    - cost config absent  → cogs/variable = 0, cost_confidence = 'Insufficient'  (identical to the current
      live data, whose billing.cost_input has 0 rows → every Spark row is 'Insufficient').
    - brand currency absent → marketing is credited on its OWN currency row. This is parity-equivalent under
      the M1 single-currency invariant the Spark job itself relies on: silver_marketing_spend.spend is landed
      in the brand's reporting currency, so `marketing.currency == brand.reporting_currency` == the row the
      Spark `bc.currency_code = r.currency_code` gate credits. (Set GOLD_PG_JDBC_URL / a reachable PG to take
      the exact Spark path when a cost config exists.)

GRAIN   : 1 row per (brand_id, currency_code). brand_id first column + partition anchor.
MONEY   : all *_minor are bigint MINOR units + sibling currency_code, never a float, never blended.
REPLAY-SAFE: full recompute from Silver (+ PG config), MERGE-UPDATE'd on (brand_id, currency_code).

CAVEATS vs the Spark job (parity-preserving):
  - QUARANTINE: none — this Gold rollup has no Stage-1/quarantine side-write (reads already-gated Silver).
  - ORPHAN-SHEDDING: the Spark job passes delete_orphans=True (WHEN NOT MATCHED BY SOURCE DELETE) to shed a
    disappeared group's Gold row on a full per-brand recompute. _base.merge_on_pk here is MATCHED-UPDATE /
    NOT-MATCHED-INSERT only — for the parity harness (fresh <table>_duckdb_test from the same Silver) the
    admission set is identical; divergence only exists after an upstream group disappears between runs.
    Noted, not silently dropped.
  - PARTITION-INCREMENTAL: the Spark job wraps the identical rollup in run_entity_incremental (a SCALING
    optimisation whose end-state is byte-identical to a full recompute). This port does a full recompute —
    parity-equivalent because the MERGE on the mart PK is idempotent and restates every group.

Honors MIGRATION_TABLE_SUFFIX (→ gold_contribution_margin_duckdb_test) for the parallel-run parity harness.

Parity target: brain_gold.gold_contribution_margin (17 rows).
"""
from __future__ import annotations

import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

TABLE = "gold_contribution_margin"

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_contribution_margin_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SILVER_ORDER_STATE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"
SILVER_MARKETING = f"{CATALOG}.{SILVER_NAMESPACE}.silver_marketing_spend"

# Operational Postgres (config tier) — the SAME source the TS reads for cost pcts + brand currency.
# jdbc:postgresql://host:port/db → the DuckDB postgres-extension needs a libpq DSN; we translate below.
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

COLUMNS = [
    "brand_id", "currency_code", "as_of_date", "net_revenue_minor", "cogs_minor", "variable_minor",
    "cm1_minor", "marketing_minor", "cm2_minor", "cost_confidence", "updated_at",
]

PK = ["brand_id", "currency_code"]


def _jdbc_to_libpq(jdbc_url: str) -> str:
    """Translate a jdbc:postgresql://host:port/db URL into a DuckDB postgres-extension DSN string.

    ATTACH '<dsn>' AS pg (TYPE postgres) wants a libpq connection string: host=… port=… dbname=… .
    """
    rest = jdbc_url.replace("jdbc:postgresql://", "").replace("postgresql://", "")
    hostport, _, dbname = rest.partition("/")
    dbname = (dbname.split("?")[0] or "brain")
    host, _, port = hostport.partition(":")
    parts = [f"host={host or 'postgres'}", f"port={port or '5432'}", f"dbname={dbname}",
             f"user={PG_USER}", f"password={PG_PASSWORD}"]
    return " ".join(parts)


def _try_attach_pg(con) -> bool:
    """Attach operational Postgres READ-ONLY as `pg` via the DuckDB postgres extension.

    Returns True on success. On ANY failure (extension missing, PG unreachable — the parity-harness /
    prod-local posture) returns False and the config tier degrades to the honest no-config path (cogs=0,
    confidence='Insufficient', marketing credited on its own currency), which is parity-equivalent to the
    Spark output whenever billing.cost_input is empty (the current live data). Best-effort, non-fatal.
    """
    try:
        con.execute("INSTALL postgres; LOAD postgres;")
        dsn = _jdbc_to_libpq(PG_JDBC_URL)
        con.execute(f"ATTACH IF NOT EXISTS '{dsn}' AS pg (TYPE postgres, READ_ONLY);")
        # Probe a trivial query so an unreachable server fails HERE (not mid-build).
        con.execute("SELECT 1 FROM pg_catalog.pg_class LIMIT 1;")
        return True
    except Exception as exc:  # noqa: BLE001 — PG optional; degrade to no-config posture.
        print(f'{{"job":"gold-contribution-margin","pg":"unreachable","detail":"{str(exc)[:120]}",'
              f'"fallback":"no-config (cogs=0, Insufficient); marketing on own currency"}}', flush=True)
        return False


def _register_config_views(con, pg_ok: bool) -> None:
    """Register _cm_cost (per-brand cogs/variable pct_bps + confidence floor) and _cm_ccy (brand reporting
    currency) as temp views — from PG when attached, else EMPTY (no-config) views.

    _cm_cost mirrors the Spark _read_cost_config: latest-effective GLOBAL cost_input per (brand, cost_type)
    as of today, aggregated to brand-level cogs_pct_bps / variable_pct_bps + has_cogs + confidence_rank
    (Insufficient=0|Estimated=1|Trusted=2, floor = MIN over the brand's inputs).
    _cm_ccy mirrors _read_brand_currency: tenancy.brand.currency_code (the M1 reporting-currency anchor).
    """
    var_in = ", ".join(f"'{t}'" for t in VARIABLE_COST_TYPES)
    if pg_ok:
        con.execute(f"""
            CREATE OR REPLACE TEMP VIEW _cm_cost AS
            WITH eff AS (
                SELECT CAST(brand_id AS VARCHAR) AS brand_id, cost_type, pct_bps, cost_confidence,
                       row_number() OVER (PARTITION BY brand_id, cost_type
                                          ORDER BY effective_from DESC) AS rn
                FROM pg.billing.cost_input
                WHERE scope = 'global'
                  AND pct_bps IS NOT NULL
                  AND effective_from <= CURRENT_DATE
                  AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
            ),
            latest AS (SELECT * FROM eff WHERE rn = 1)
            SELECT
              brand_id,
              COALESCE(SUM(CASE WHEN cost_type = 'cogs' THEN pct_bps ELSE 0 END), 0)      AS cogs_pct_bps,
              COALESCE(SUM(CASE WHEN cost_type IN ({var_in}) THEN pct_bps ELSE 0 END), 0) AS variable_pct_bps,
              bool_or(cost_type = 'cogs')                                                 AS has_cogs,
              MIN(CASE cost_confidence WHEN 'Insufficient' THEN 0 WHEN 'Estimated' THEN 1
                                       WHEN 'Trusted' THEN 2 ELSE 0 END)                  AS confidence_rank
            FROM latest
            GROUP BY brand_id;
        """)
        con.execute("""
            CREATE OR REPLACE TEMP VIEW _cm_ccy AS
            SELECT CAST(id AS VARCHAR) AS brand_id, currency_code FROM pg.tenancy.brand;
        """)
    else:
        # No-config posture: empty typed views. Every LEFT JOIN misses → cogs/variable=0,
        # confidence_rank NULL → 'Insufficient'. _cm_ccy empty → marketing gated by own currency below.
        con.execute("""
            CREATE OR REPLACE TEMP VIEW _cm_cost AS
            SELECT CAST(NULL AS VARCHAR) AS brand_id,
                   CAST(0 AS BIGINT) AS cogs_pct_bps, CAST(0 AS BIGINT) AS variable_pct_bps,
                   CAST(NULL AS BOOLEAN) AS has_cogs, CAST(NULL AS INTEGER) AS confidence_rank
            WHERE FALSE;
        """)
        con.execute("""
            CREATE OR REPLACE TEMP VIEW _cm_ccy AS
            SELECT CAST(NULL AS VARCHAR) AS brand_id, CAST(NULL AS VARCHAR) AS currency_code WHERE FALSE;
        """)


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL)
    as_of = date.today().isoformat()

    # ── INCREMENTAL (Phase 1b, GOLD_INCREMENTAL): DELIBERATELY LEFT FULL-SCAN — money-safety. ─────────────
    #   GRAIN = entity_fold: one (brand_id, currency_code) row folds TWO independent Silver sources —
    #   silver_order_state (net_revenue → cm1) AND silver_marketing_spend (marketing → cm2). An output row's
    #   cm2_minor can change because EITHER source changed, so a correct changed-entity refold would need the
    #   UNION of changed keys from BOTH sources. But _base.incremental_window / run_job track a SINGLE source
    #   clock (run_job pins _CURRENT_HI = max(ts_col) of ONE source_table): windowing the second source by the
    #   first source's `hi` would drop a marketing update newer than the order-spine max, and the single-source
    #   watermark would never re-admit it → permanently skipped marketing → WRONG cm2 money. This is the FINAL
    #   money tier, so per the invariant we LEAVE THIS JOB FULL-SCAN rather than risk an unsafe two-clock
    #   refold. Both sources carry only `updated_at` as an arrival clock (no `ingested_at`); the blocker is the
    #   two-source fold vs. the single-clock framework, not a missing column. Default OFF is already a full
    #   scan; keeping it full-scan under GOLD_INCREMENTAL preserves parity exactly.

    # ── Config tier (PG, optional): cost pct rates + brand reporting currency ──
    pg_ok = _try_attach_pg(con)
    _register_config_views(con, pg_ok)

    # ── Money tier (Iceberg Silver): realized revenue + marketing spend, per (brand, currency) ──
    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW _cm_realized AS
        SELECT brand_id,
               COALESCE(currency_code, 'INR') AS currency_code,
               COALESCE(SUM(COALESCE(order_value_minor, 0)), 0) AS net_revenue_minor
        FROM {SILVER_ORDER_STATE}
        WHERE brand_id IS NOT NULL
        GROUP BY brand_id, COALESCE(currency_code, 'INR');
    """)
    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW _cm_marketing AS
        SELECT brand_id,
               COALESCE(currency_code, 'INR') AS currency_code,
               COALESCE(SUM(COALESCE(spend_minor, 0)), 0) AS marketing_minor
        FROM {SILVER_MARKETING}
        WHERE brand_id IS NOT NULL
        GROUP BY brand_id, COALESCE(currency_code, 'INR');
    """)

    # Marketing gate (M1 single-currency): marketing contributes to a row ONLY when this row's currency IS
    # the brand's reporting currency. Spark: `bc.currency_code = r.currency_code` (bc = tenancy.brand). When
    # PG is attached we honor that gate exactly; when PG is absent (_cm_ccy empty) we fall back to crediting
    # marketing on its own currency row — parity-equivalent because M1 lands marketing in the reporting ccy.
    marketing_expr = (
        "CASE WHEN bc.currency_code = r.currency_code THEN COALESCE(m.marketing_minor, 0) ELSE 0 END"
        if pg_ok else
        "COALESCE(m.marketing_minor, 0)"
    )

    # CM math — integer minor units. pctOf = (revenue * trunc(pct_bps)) // 10000  (DuckDB `//` == floor ==
    # trunc for the non-negative revenue/pct here == Spark bigint `/` == TS BigInt `/`).
    staged = f"""
        WITH base AS (
            SELECT
                r.brand_id,
                r.currency_code,
                r.net_revenue_minor,
                COALESCE(c.cogs_pct_bps, 0)      AS cogs_pct_bps,
                COALESCE(c.variable_pct_bps, 0)  AS variable_pct_bps,
                COALESCE(c.has_cogs, false)      AS has_cogs,
                c.confidence_rank                AS confidence_rank,
                {marketing_expr}                 AS marketing_minor
            FROM _cm_realized r
            LEFT JOIN _cm_cost c      ON r.brand_id = c.brand_id
            LEFT JOIN _cm_ccy  bc     ON r.brand_id = bc.brand_id
            LEFT JOIN _cm_marketing m ON r.brand_id = m.brand_id AND r.currency_code = m.currency_code
        ),
        calc AS (
            SELECT
                brand_id,
                currency_code,
                net_revenue_minor,
                (net_revenue_minor * CAST(cogs_pct_bps AS BIGINT)) // 10000     AS cogs_minor,
                (net_revenue_minor * CAST(variable_pct_bps AS BIGINT)) // 10000 AS variable_minor,
                marketing_minor,
                has_cogs,
                confidence_rank
            FROM base
        )
        SELECT
            brand_id,
            currency_code,
            CAST('{as_of}' AS DATE)                                              AS as_of_date,
            net_revenue_minor,
            cogs_minor,
            variable_minor,
            (net_revenue_minor - cogs_minor - variable_minor)                    AS cm1_minor,
            marketing_minor,
            (net_revenue_minor - cogs_minor - variable_minor - marketing_minor)  AS cm2_minor,
            -- cost_confidence: no COGS ⇒ Insufficient; else the floor of input confidences.
            CASE
                WHEN has_cogs = false OR confidence_rank IS NULL THEN 'Insufficient'
                WHEN confidence_rank = 2 THEN 'Trusted'
                WHEN confidence_rank = 1 THEN 'Estimated'
                ELSE 'Insufficient'
            END                                                                  AS cost_confidence,
            now() AT TIME ZONE 'UTC'                                             AS updated_at
        FROM calc
    """

    # Full-recompute MERGE on (brand_id, currency_code): the GROUP BY upstream already yields exactly one row
    # per PK, so the in-batch dedup is a no-op; order_by is a nominal tie-break. WHEN MATCHED UPDATE restates
    # the rollup, WHEN NOT MATCHED INSERT — replay-safe (the rollup is authoritative). See CAVEATS on the
    # Spark delete_orphans=True (not implemented by _base.merge_on_pk).
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at", "net_revenue_minor"])


if __name__ == "__main__":
    run_job("gold-contribution-margin", build, target_table=TABLE)
