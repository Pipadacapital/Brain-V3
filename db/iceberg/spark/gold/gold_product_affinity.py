"""
gold_product_affinity.py — NET-NEW gap Gold `product_affinity` mart (Brain V4, P3 "frequently bought together").

NO dbt predecessor (parity status=NEW). The materialized market-basket / co-purchase surface — one row per
(brand_id, product_a, product_b) with product_a < product_b, holding how many DISTINCT orders contained BOTH
products (co_purchase_count) and what share of the brand's orders that represents (support_pct). Read entirely
from the Iceberg Silver order-line grain (brain_silver.silver_order_line) via a same-order self-join — the
canonical "frequently bought together" recommendation primitive, lifted to a brand-scoped Gold rollup.

GRAIN   : 1 row per (brand_id, product_a, product_b), product_a < product_b (unordered pair, deduped — a
          pair is counted once per order regardless of line multiplicity / index). brand_id first + partition
          anchor + pk[0] (tenant invariant). NO money — every measure is a count or a count-derived ratio.
COLUMNS :
  co_purchase_count — DISTINCT orders containing BOTH product_a and product_b.
  support_pct       — 100 * co_purchase_count / (DISTINCT orders in the brand), 2-dp percentage (double, not
                      money — it is a ratio of order counts, never a currency amount).
PRODUCT KEY: COALESCE(NULLIF(product_id,''), sku) — product_id is the catalogue identity; fall back to sku when
          a line carries no product_id so a real catalogue line is never silently dropped.
CAP     : to bound the O(n^2) pair fan-out on wide catalogues, only the top TOP_PAIRS_PER_PRODUCT (default 50)
          co-purchased partners per product_a (by co_purchase_count, then product_b) are kept. Set to 0 to
          disable the cap.
REPLAY-SAFE: full per-brand recompute from Silver, MERGE-UPDATE'd on the PK (partition-incremental by brand).
"""
from __future__ import annotations

import os

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_product_affinity"

COLUMNS_SQL = """
          brand_id          string    NOT NULL,
          product_a         string    NOT NULL,
          product_b         string    NOT NULL,
          co_purchase_count bigint    NOT NULL,
          support_pct       double    NOT NULL,
          updated_at        timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # Cap of co-purchase partners kept per product_a (bounds the n^2 pair fan-out). 0 → no cap.
    top_n = int(os.environ.get("TOP_PAIRS_PER_PRODUCT", "50"))
    rank_filter = "" if top_n <= 0 else f"WHERE rn <= {top_n}"

    staged = spark.sql(
        f"""
        WITH order_products AS (
            -- one (brand, order, product) per basket member: DISTINCT collapses line multiplicity /
            -- index so a product present on several lines of one order is counted once.
            SELECT DISTINCT
                brand_id,
                order_id,
                COALESCE(NULLIF(product_id, ''), sku) AS product
            FROM {silver('silver_order_line')}
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
                COUNT(DISTINCT p.order_id)                                         AS co_purchase_count,
                ROUND(100.0 * COUNT(DISTINCT p.order_id) / o.n_orders, 2)          AS support_pct
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
            current_timestamp() AS updated_at
        FROM ranked
        {rank_filter}
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "product_a", "product_b"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-product-affinity", build, entity_incremental={
        "table_name": "gold_product_affinity", "source_tables": ["silver_order_line"],
    })
