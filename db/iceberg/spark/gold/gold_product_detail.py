"""
gold_product_detail.py — NET-NEW Gold `product_detail` mart (Brain V4 P3, GROUP "NEW gap Gold products").

NO dbt predecessor (parity status=NEW). The per-PRODUCT performance surface — one row per
(brand_id, product_id) holding the full funnel for a single product: storefront views → add-to-cart →
purchases → revenue, plus the return count, and the two conversion rates as parity-safe 2dp strings.

GRAIN / PK : 1 row per (brand_id, product_id). brand_id is the tenant key + FIRST column + pk[0]
             (V4 rule 5). product_id is the canonical storefront product id carried on the order line.
COLUMNS :
  product_title     — the product title (authoritative from silver_order_line; pixel product_title fallback).
  views             — pixel `product.viewed` events for this product (silver_collector_event).
  add_to_cart       — pixel `cart.viewed` + `cart.item_added` events for this product (silver_collector_event).
  purchases         — order LINES for this product (silver_order_line).
  revenue_minor     — SUM(line_total_minor) — BIGINT minor units, paired with `currency_code` (V4 money
                      rule: minor units + sibling currency_code, NEVER a float, NEVER blended). Per
                      (brand,product) the currency is taken from that product's order lines (single
                      transaction currency per product — documented assumption; revenue is summed within it).
  currency_code     — the ISO-4217 currency of `revenue_minor` (NULL for a views/cart-only product with 0
                      purchases — zero revenue has no currency; never fabricated).
  return_count      — distinct returned orders containing this product (silver_return ⋈ silver_order_line).
  add_to_cart_rate  — add_to_cart / views, a 2dp STRING; '0.00' when views=0 (NEVER a 0/0 divide).
  purchase_rate     — purchases / views, a 2dp STRING; '0.00' when views=0 (NEVER a 0/0 divide).

SOURCES (read ONLY via the silver() seam — bounded + brand-filtered under partition-incremental):
  silver_order_line       — product_id, title, quantity, line_total_minor, currency_code, order_id (purchases/revenue/title).
  silver_collector_event  — pixel events; product_id via get_json_object(payload,'$.properties.product_id')
                            (views = 'product.viewed'; add_to_cart = 'cart.viewed' + 'cart.item_added').
  silver_return           — per-(brand,order_id) latest return state; joined to order lines on order_id to
                            attribute returns to a product (return_class <> 'none' = an actual return).

DATA NOTE: the current universal pixel emits `product_handle` on product.viewed and `variant_id` on cart
events (apps/collector pixel-asset.route.ts), not a product_id — so views/add_to_cart populate per-product
once the pixel carries `$.properties.product_id` (schema + transform are the deliverable, no code change to
populate, mirroring the silver_cart_event value_minor convention). purchases/revenue/title/returns key on
the order-line product_id today.

REPLAY-SAFE: full recompute from Silver, MERGE-UPDATE'd on the (brand_id, product_id) PK.
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_product_detail"

COLUMNS_SQL = """
          brand_id          string    NOT NULL,
          product_id        string    NOT NULL,
          product_title     string,
          views             bigint    NOT NULL,
          add_to_cart       bigint    NOT NULL,
          purchases         bigint    NOT NULL,
          revenue_minor     bigint    NOT NULL,
          currency_code     string,
          return_count      bigint    NOT NULL,
          add_to_cart_rate  string    NOT NULL,
          purchase_rate     string    NOT NULL,
          updated_at        timestamp NOT NULL
""".strip("\n")


def build(spark):
    # Resolve each Silver source ONCE via the silver() seam (under partition-incremental it returns a
    # brand-filtered temp view; reusing the same handle keeps every read bounded to this bucket's brands).
    sol = silver("silver_order_line")        # product_id + title + line money + order_id
    sce = silver("silver_collector_event")   # pixel events (views / add-to-cart)
    sret = silver("silver_return")           # per-order returns (joined to lines for product attribution)

    staged = spark.sql(
        f"""
        WITH purchases AS (
            SELECT
                brand_id,
                product_id,
                COUNT(*)                            AS purchases,
                CAST(SUM(line_total_minor) AS BIGINT) AS revenue_minor,
                MAX(currency_code)                  AS currency_code,
                MAX(title)                          AS product_title
            FROM {sol}
            WHERE brand_id IS NOT NULL AND product_id IS NOT NULL
            GROUP BY brand_id, product_id
        ),
        views AS (
            SELECT
                brand_id,
                get_json_object(payload, '$.properties.product_id')          AS product_id,
                COUNT(*)                                                      AS views,
                MAX(get_json_object(payload, '$.properties.product_title'))   AS pixel_title
            FROM {sce}
            WHERE event_type = 'product.viewed'
              AND brand_id IS NOT NULL
              AND get_json_object(payload, '$.properties.product_id') IS NOT NULL
            GROUP BY brand_id, get_json_object(payload, '$.properties.product_id')
        ),
        atc AS (
            SELECT
                brand_id,
                get_json_object(payload, '$.properties.product_id') AS product_id,
                COUNT(*)                                            AS add_to_cart
            FROM {sce}
            WHERE event_type IN ('cart.viewed', 'cart.item_added')
              AND brand_id IS NOT NULL
              AND get_json_object(payload, '$.properties.product_id') IS NOT NULL
            GROUP BY brand_id, get_json_object(payload, '$.properties.product_id')
        ),
        returns AS (
            SELECT
                ol.brand_id,
                ol.product_id,
                COUNT(DISTINCT r.order_id) AS return_count
            FROM {sret} r
            JOIN {sol} ol
              ON r.brand_id = ol.brand_id AND r.order_id = ol.order_id
            WHERE COALESCE(r.return_class, 'none') <> 'none'
              AND ol.product_id IS NOT NULL
            GROUP BY ol.brand_id, ol.product_id
        ),
        keys AS (
            SELECT brand_id, product_id FROM purchases
            UNION SELECT brand_id, product_id FROM views
            UNION SELECT brand_id, product_id FROM atc
            UNION SELECT brand_id, product_id FROM returns
        )
        SELECT
            k.brand_id,
            k.product_id,
            COALESCE(p.product_title, v.pixel_title)                      AS product_title,
            COALESCE(v.views, 0)                                         AS views,
            COALESCE(a.add_to_cart, 0)                                   AS add_to_cart,
            COALESCE(p.purchases, 0)                                     AS purchases,
            COALESCE(p.revenue_minor, 0)                                 AS revenue_minor,
            p.currency_code                                             AS currency_code,
            COALESCE(r.return_count, 0)                                  AS return_count,
            CASE WHEN COALESCE(v.views, 0) = 0 THEN '0.00'
                 ELSE format_string('%.2f', COALESCE(a.add_to_cart, 0) / CAST(v.views AS DOUBLE))
            END                                                          AS add_to_cart_rate,
            CASE WHEN COALESCE(v.views, 0) = 0 THEN '0.00'
                 ELSE format_string('%.2f', COALESCE(p.purchases, 0) / CAST(v.views AS DOUBLE))
            END                                                          AS purchase_rate,
            current_timestamp()                                          AS updated_at
        FROM keys k
        LEFT JOIN purchases p ON k.brand_id = p.brand_id AND k.product_id = p.product_id
        LEFT JOIN views     v ON k.brand_id = v.brand_id AND k.product_id = v.product_id
        LEFT JOIN atc       a ON k.brand_id = a.brand_id AND k.product_id = a.product_id
        LEFT JOIN returns   r ON k.brand_id = r.brand_id AND k.product_id = r.product_id
        WHERE k.brand_id IS NOT NULL AND k.product_id IS NOT NULL
        """
    )

    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")
    merge_on_pk(spark, fqtn, staged, ["brand_id", "product_id"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-product-detail", build, entity_incremental={
        "table_name": "gold_product_detail",
        "source_tables": ["silver_order_line", "silver_collector_event", "silver_return"],
    })
