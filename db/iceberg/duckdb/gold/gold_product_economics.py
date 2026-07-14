"""
gold_product_economics.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_product_economics.py.

SPEC C.3 — Wave-C product×day economics rollup (AMD-17 companion of gold_order_economics).

GOLD mart (not a Bronze/keystone read): READS the sibling Gold Iceberg table
{CATALOG}.brain_gold.gold_order_economics + the Silver table {CATALOG}.brain_silver.silver_order_line
directly, pushes each order's measured economics DOWN onto its product lines (apportioned by line-revenue
share, ZERO money leak — largest-remainder), rolls up to one row per
(brand_id, product_key, econ_date, currency_code), and idempotently MERGEs into
{CATALOG}.brain_gold.gold_product_economics.

THE TRANSFORM (byte/minor-unit exact — reproduced verbatim from the Spark job's SQL):
  product_key = coalesce(nullif(product_id,''), nullif(sku,''), '__unknown__')  — the product identity.
  econ_date   = date(order_recognized_at)                                       — the recognition day.

  APPORTIONMENT (largest-remainder, exact-sum, per money component, per order):
    1. weight each line by its line_total_minor; rank lines highest-value-first
       (row_number OVER (PARTITION BY brand,order ORDER BY line_total_minor DESC, line_index ASC)).
    2. floor part per line: when order_line_total > 0  →  (component * line_total_minor) div order_line_total,
       else  →  component div n_lines   (line-less / zero-revenue orders split evenly).
    3. remainder r = component − Σ(floor parts), assigned WHOLE to the top-ranked line (_lr = 1)
       → Σ(line parts) == the order's component EXACTLY (zero money leak).
    Orders with NO lines → a single synthetic '__unknown__' line carrying the whole order (LEFT JOIN
    fallback, weight 0 → n_lines split path) so no revenue is dropped.

  CM waterfall (cm1/cm2/cm3) is RECOMPUTED from the SUMMED apportioned parts at the rollup grain (linear →
  reconciles to gold_order_economics EXACTLY per (brand, day, currency)).

GRAIN / PK: exactly one row per (brand_id, product_key, econ_date, currency_code) — the mart PK.
MONEY (§1.2): all *_minor are signed BIGINT MINOR units + sibling currency_code, per-currency, NEVER
  blended, NO float. `div` (Spark integer divide, truncate-toward-zero) → DuckDB `//` (which ALSO truncates
  toward zero, verified: -7 // 2 = -3 in both engines) — so the exact-fils apportionment is byte-identical
  even for net-negative (return-adjusted) components. brand_id first + partition anchor.
IDEMPOTENT / REPLAY-SAFE: MERGE on the 4-col PK — re-running over the same sources restates every group.

DEGRADES: reads silver_order_line + gold_order_economics. If gold_order_economics is absent/empty → empty
  mart (graceful). If silver_order_line is absent → every order lands under product_key='__unknown__'.

QUARANTINE: none — this Gold rollup has no Stage-1/quarantine side-write (it reads already-gated Silver +
  the gold_order_economics mart). NOTED (parity-preserving): the Spark job has none either.

PG: none — this job reads NO Postgres (both sources are Iceberg). No postgres-extension ATTACH needed.

FULL RECOMPUTE vs Spark's entity-incremental: the Spark job's merge_on_pk is MATCHED-UPDATE / NOT-MATCHED-
  INSERT (no delete_orphans); a full-scan recompute here is parity-equivalent because the MERGE on the mart
  PK is idempotent and restates every (brand, product_key, econ_date, currency) group.

Honors MIGRATION_TABLE_SUFFIX (→ gold_product_economics_duckdb_test) for the parallel-run parity harness.

Parity target: brain_gold.gold_product_economics (14013 rows).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

TABLE = "gold_product_economics"
JOB_VERSION = "c3.product_economics.v1"

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_product_economics_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
ECON_SOURCE = f"{CATALOG}.{GOLD_NAMESPACE}.gold_order_economics"
ORDER_LINE_SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_line"

COLUMNS_SQL = """
  brand_id             string    NOT NULL,
  product_key          string    NOT NULL,
  econ_date            date      NOT NULL,
  currency_code        string    NOT NULL,
  order_count          bigint    NOT NULL,
  net_revenue_minor    bigint    NOT NULL,
  cogs_minor           bigint    NOT NULL,
  shipping_fwd_minor   bigint    NOT NULL,
  shipping_rev_minor   bigint    NOT NULL,
  packaging_minor      bigint    NOT NULL,
  fees_minor           bigint    NOT NULL,
  cm1_minor            bigint    NOT NULL,
  cm2_minor            bigint    NOT NULL,
  marketing_minor      bigint    NOT NULL,
  cm3_minor            bigint    NOT NULL,
  source_system        string    NOT NULL,
  job_version          string    NOT NULL,
  updated_at           timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "product_key", "econ_date", "currency_code", "order_count",
    "net_revenue_minor", "cogs_minor", "shipping_fwd_minor", "shipping_rev_minor",
    "packaging_minor", "fees_minor", "cm1_minor", "cm2_minor", "marketing_minor",
    "cm3_minor", "source_system", "job_version", "updated_at",
]

PK = ["brand_id", "product_key", "econ_date", "currency_code"]

# The money components apportioned from order → line (each an exact-sum split).
_COMPONENTS = [
    "net_revenue_minor", "cogs_minor", "shipping_fwd_minor", "shipping_rev_minor",
    "packaging_minor", "fees_minor", "marketing_minor",
]


def _econ_exists(con) -> bool:
    """True iff gold_order_economics exists — a totally absent upstream would raise; probe so the job
    degrades gracefully to an empty mart (parity SKIPs). Mirrors the Spark try/except on spark.table."""
    try:
        con.execute(f"SELECT 1 FROM {ECON_SOURCE} LIMIT 1")
        return True
    except Exception:  # noqa: BLE001 — economics not built yet → empty mart (graceful)
        return False


def _lines_exists(con) -> bool:
    """True iff silver_order_line exists. Absent → the LEFT JOIN fallback lands every order under
    product_key='__unknown__' (no revenue dropped), exactly like the Spark has_lines=False branch."""
    try:
        con.execute(f"SELECT 1 FROM {ORDER_LINE_SOURCE} LIMIT 1")
        return True
    except Exception:  # noqa: BLE001
        return False


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    if not _econ_exists(con):
        print("[gold_product_economics] gold_order_economics absent — writing empty mart", flush=True)
        return 0

    # ── lines with per-order line-revenue weights + a deterministic rank (highest line first) ──
    if _lines_exists(con):
        con.execute(f"""
            CREATE OR REPLACE TEMP VIEW _pe_lines AS
            SELECT brand_id, order_id,
                   coalesce(nullif(product_id, ''), nullif(sku, ''), '__unknown__') AS product_key,
                   CAST(coalesce(line_total_minor, 0) AS BIGINT) AS line_total_minor,
                   line_index
            FROM {ORDER_LINE_SOURCE}
            WHERE brand_id IS NOT NULL AND order_id IS NOT NULL;
        """)
    else:
        con.execute("""
            CREATE OR REPLACE TEMP VIEW _pe_lines AS
            SELECT CAST('' AS VARCHAR) AS brand_id, CAST('' AS VARCHAR) AS order_id,
                   CAST('' AS VARCHAR) AS product_key, CAST(0 AS BIGINT) AS line_total_minor,
                   CAST(0 AS BIGINT) AS line_index
            WHERE FALSE;
        """)

    # ── attach economics to each line; orders with NO lines → a single synthetic '__unknown__' line
    #    carrying the whole order (weight 0 → even-split path) so no revenue is dropped ──
    comp_e = ", ".join(_COMPONENTS)
    comp_ee = ", ".join("e." + c for c in _COMPONENTS)
    # floor part per line: order_line_total>0 → (component * line_total_minor) // order_line_total,
    # else → component // n_lines. `//` truncates toward zero in DuckDB == Spark `div`.
    floored_parts = ", ".join(
        f"""CASE WHEN order_line_total > 0
                 THEN ({c} * line_total_minor) // order_line_total
                 ELSE {c} // n_lines END AS f_{c}"""
        for c in _COMPONENTS
    )
    remainder_parts = ", ".join(
        f"({c} - sum(f_{c}) OVER (PARTITION BY brand_id, order_id)) AS r_{c}"
        for c in _COMPONENTS
    )
    apportioned_parts = ", ".join(
        f"(f_{c} + CASE WHEN _lr = 1 THEN r_{c} ELSE 0 END) AS a_{c}"
        for c in _COMPONENTS
    )
    sum_parts = ", ".join(f"CAST(sum(a_{c}) AS BIGINT) AS {c}" for c in _COMPONENTS)

    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW _pe_rollup AS
        WITH econ AS (
            SELECT brand_id, order_id, currency_code,
                   CAST(order_recognized_at AS DATE) AS econ_date,
                   {comp_e}
            FROM {ECON_SOURCE}
        ),
        lines AS (
            SELECT e.brand_id, e.order_id, e.currency_code, e.econ_date,
                   {comp_ee},
                   coalesce(l.product_key, '__unknown__') AS product_key,
                   coalesce(l.line_total_minor, 0)        AS line_total_minor,
                   coalesce(l.line_index, 0)              AS line_index
            FROM econ e
            LEFT JOIN _pe_lines l ON l.brand_id = e.brand_id AND l.order_id = e.order_id
        ),
        weighted AS (
            SELECT *,
                   sum(line_total_minor) OVER (PARTITION BY brand_id, order_id) AS order_line_total,
                   count(*)              OVER (PARTITION BY brand_id, order_id) AS n_lines,
                   row_number() OVER (
                     PARTITION BY brand_id, order_id
                     ORDER BY line_total_minor DESC, line_index ASC
                   ) AS _lr
            FROM lines
        ),
        floored AS (
            SELECT brand_id, order_id, currency_code, econ_date, product_key, _lr, n_lines,
                   {floored_parts},
                   {comp_e}
            FROM weighted
        ),
        remainder AS (
            SELECT *,
                   {remainder_parts}
            FROM floored
        ),
        apportioned AS (
            SELECT brand_id, order_id, currency_code, econ_date, product_key,
                   {apportioned_parts}
            FROM remainder
        )
        SELECT
            brand_id, product_key, econ_date, currency_code,
            CAST(count(DISTINCT order_id) AS BIGINT) AS order_count,
            {sum_parts}
        FROM apportioned
        GROUP BY brand_id, product_key, econ_date, currency_code;
    """)

    # ── recompute CM waterfall from the summed apportioned parts (linear → reconciles exactly) ──
    staged = f"""
        SELECT
            brand_id, product_key, econ_date, currency_code, order_count,
            net_revenue_minor, cogs_minor, shipping_fwd_minor, shipping_rev_minor,
            packaging_minor, fees_minor,
            (net_revenue_minor - cogs_minor) AS cm1_minor,
            (net_revenue_minor - cogs_minor - shipping_fwd_minor - shipping_rev_minor
              - packaging_minor - fees_minor) AS cm2_minor,
            marketing_minor,
            (net_revenue_minor - cogs_minor - shipping_fwd_minor - shipping_rev_minor
              - packaging_minor - fees_minor - marketing_minor) AS cm3_minor,
            CAST('gold_order_economics' AS VARCHAR) AS source_system,
            CAST('{JOB_VERSION}' AS VARCHAR)        AS job_version,
            now() AT TIME ZONE 'UTC'                AS updated_at
        FROM _pe_rollup
    """

    # Idempotent MERGE on the 4-col mart PK — replay-safe restatement. The GROUP BY upstream already yields
    # one row per PK, so the in-batch dedup order_by is a stable no-op tie-break.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK,
                       order_by_desc=["updated_at", "net_revenue_minor"])


if __name__ == "__main__":
    run_job("gold-product-economics", build, target_table=TABLE)
