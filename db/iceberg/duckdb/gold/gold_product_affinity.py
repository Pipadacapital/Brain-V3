"""
gold_product_affinity.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_product_affinity.py.

The materialized market-basket / co-purchase ("frequently bought together") surface — one row per
(brand_id, product_a, product_b) with product_a < product_b, holding how many DISTINCT orders contained
BOTH products (co_purchase_count) and what share of the brand's orders that represents (support_pct).
Read entirely from the Iceberg Silver order-line grain ({CATALOG}.brain_silver.silver_order_line) via a
same-order self-join — the canonical co-purchase recommendation primitive, lifted to a brand-scoped Gold
rollup. Reuses the framework's ensure_table / merge_on_pk / run_job.

THE TRANSFORM (reproduced verbatim from the Spark staged SQL; NO money — every measure is a count or a
count-derived ratio, so NO currency_code column):
  1. order_products = SELECT DISTINCT (brand_id, order_id, product) where
       product = COALESCE(NULLIF(product_id,''), sku)  — product_id is catalogue identity, fall back to sku
       so a real catalogue line is never silently dropped; DISTINCT collapses line multiplicity / index so
       a product present on several lines of one order is counted once. brand_id/order_id/product NOT NULL.
  2. brand_orders = per brand, COUNT(DISTINCT order_id) = n_orders (the support denominator).
  3. pairs = same-order self-join, a.product < b.product → unordered pair, no (A,B)/(B,A) dupes, no self-pairs.
  4. pair_counts = per (brand_id, product_a, product_b):
       co_purchase_count = COUNT(DISTINCT order_id) containing BOTH products
       support_pct       = ROUND(100.0 * COUNT(DISTINCT order_id) / n_orders, 2)   — 2-dp DOUBLE ratio
  5. ranked / CAP = only the top TOP_PAIRS_PER_PRODUCT (default 50) partners per product_a
       (ROW_NUMBER OVER (PARTITION BY brand_id, product_a ORDER BY co_purchase_count DESC, product_b)),
       to bound the O(n^2) pair fan-out. TOP_PAIRS_PER_PRODUCT=0 → no cap.

GRAIN / PK : 1 row per (brand_id, product_a, product_b), product_a < product_b. brand_id tenant key first
  + partition anchor + pk[0]. Matches the Spark PK exactly.
RATIO      : support_pct is a DOUBLE (ratio of order counts), never money — no bigint/minor-unit typing.
INTEGER DIV: the Spark expression is `100.0 * COUNT(DISTINCT order_id) / n_orders` — the leading 100.0
  (double) forces DOUBLE division (NOT integer `//`), identical in DuckDB. There is no integer-division
  step in this mart.
REPLAY-SAFE: full recompute from Silver each run, idempotent MERGE-UPDATE on the PK — a re-run over the
  same Silver yields identical rows.

QUARANTINE: the Spark job has NO Stage-1/quarantine side-write (it reads already-gated Silver order lines);
  nothing to skip. NO watermark table is read here (source is a Silver mart, not the gated keystone) —
  run_job's best-effort watermark advance over the gated keystone is a harmless non-fatal no-op.

PARTITION-INCREMENTAL: the Spark run_job wraps this rollup in entity_incremental (a SCALING optimization —
  recompute only brands with new silver_order_line rows, each over full history, then the SAME MERGE). A
  full-scan recompute here is parity-equivalent: the MERGE on the mart PK is idempotent and restates every
  (brand, product_a, product_b) to the current Silver aggregate.

Parity target: brain_gold.gold_product_affinity (Spark).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_product_affinity_duckdb_test
# instead of the live Spark-owned mart. Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_product_affinity{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_line"

# Mirrors the Spark _COLUMNS order/types exactly (NO money column, NO currency_code — counts + a ratio).
COLUMNS_SQL = """
  brand_id          string    NOT NULL,
  product_a         string    NOT NULL,
  product_b         string    NOT NULL,
  co_purchase_count bigint    NOT NULL,
  support_pct       double    NOT NULL,
  updated_at        timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "product_a", "product_b", "co_purchase_count", "support_pct", "updated_at",
]


def build(con):
    # brand-first tenant partitioning (mirrors the Spark bucket(64, brand_id) hidden partitioning).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # Cap of co-purchase partners kept per product_a (bounds the n^2 pair fan-out). 0 → no cap. Verbatim
    # to the Spark TOP_PAIRS_PER_PRODUCT env (default 50) + `WHERE rn <= {top_n}` rank filter.
    top_n = int(os.environ.get("TOP_PAIRS_PER_PRODUCT", "50"))
    rank_filter = "" if top_n <= 0 else f"WHERE rn <= {top_n}"

    staged = f"""
        WITH order_products AS (
            -- one (brand, order, product) per basket member: DISTINCT collapses line multiplicity /
            -- index so a product present on several lines of one order is counted once.
            SELECT DISTINCT
                brand_id,
                order_id,
                COALESCE(NULLIF(product_id, ''), sku) AS product
            FROM {SOURCE}
            WHERE brand_id IS NOT NULL
              AND order_id IS NOT NULL
              AND COALESCE(NULLIF(product_id, ''), sku) IS NOT NULL
        ),
        brand_orders AS (
            SELECT brand_id, COUNT(DISTINCT order_id) AS n_orders
            FROM order_products
            GROUP BY brand_id
        ),
        pairs AS (
            -- same-order self-join, unordered pair (product_a < product_b) → no (A,B)/(B,A) dupes, no self-pairs.
            SELECT
                a.brand_id,
                a.product AS product_a,
                b.product AS product_b,
                a.order_id
            FROM order_products a
            JOIN order_products b
              ON a.brand_id = b.brand_id
             AND a.order_id = b.order_id
             AND a.product < b.product
        ),
        pair_counts AS (
            SELECT
                p.brand_id,
                p.product_a,
                p.product_b,
                CAST(COUNT(DISTINCT p.order_id) AS BIGINT)                        AS co_purchase_count,
                ROUND(100.0 * COUNT(DISTINCT p.order_id) / o.n_orders, 2)         AS support_pct
            FROM pairs p
            JOIN brand_orders o ON p.brand_id = o.brand_id
            GROUP BY p.brand_id, p.product_a, p.product_b, o.n_orders
        ),
        ranked AS (
            SELECT
                pc.*,
                ROW_NUMBER() OVER (
                    PARTITION BY pc.brand_id, pc.product_a
                    ORDER BY pc.co_purchase_count DESC, pc.product_b
                ) AS rn
            FROM pair_counts pc
        )
        SELECT
            brand_id,
            product_a,
            product_b,
            co_purchase_count,
            support_pct,
            now() AT TIME ZONE 'UTC' AS updated_at
        FROM ranked
        {rank_filter}
    """

    # Idempotent MERGE on the (brand_id, product_a, product_b) PK. staged is already 1 row per PK (the
    # GROUP BY + rank-cap upstream), so order_by_desc is a stable, deterministic no-op tie-break.
    return merge_on_pk(con, TARGET, staged, COLUMNS,
                       ["brand_id", "product_a", "product_b"],
                       order_by_desc=["co_purchase_count", "support_pct"])


if __name__ == "__main__":
    run_job("gold-product-affinity", build, target_table="gold_product_affinity")
