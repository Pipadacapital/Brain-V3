"""
gold_product_detail.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_product_detail.py.

NET-NEW Gold `product_detail` mart (Brain V4 P3, GROUP "NEW gap Gold products"). NO dbt predecessor
(parity status=NEW). The per-PRODUCT performance surface — one row per (brand_id, product_id) holding the
full funnel for a single product: storefront views → add-to-cart → purchases → revenue, plus the return
count, and the two conversion rates as parity-safe 2dp strings.

GOLD mart (not a Bronze/keystone read): READS the sibling Silver Iceberg tables
  {CATALOG}.brain_silver.silver_order_line       — product_id + title + line money + order_id (purchases/revenue/title).
  {CATALOG}.brain_silver.silver_collector_event  — pixel events (views / add-to-cart), product_id via JSON.
  {CATALOG}.brain_silver.silver_return           — per-order returns (joined to lines for product attribution).
directly, and idempotently MERGEs into {CATALOG}.brain_gold.gold_product_detail on the mart PK.

GRAIN / PK : 1 row per (brand_id, product_id). brand_id is the tenant key + FIRST column + pk[0]
             (V4 rule 5). product_id is the canonical storefront product id carried on the order line.
COLUMNS :
  product_title     — the product title (authoritative from silver_order_line; pixel product_title fallback).
  views             — pixel `product.viewed` events for this product (silver_collector_event).
  add_to_cart       — pixel `cart.viewed` + `cart.item_added` events for this product (silver_collector_event).
  purchases         — order LINES for this product (silver_order_line).
  revenue_minor     — SUM(line_total_minor) — BIGINT MINOR units, paired with `currency_code` (V4 money
                      rule: minor units + sibling currency_code, NEVER a float, NEVER blended). Per
                      (brand,product) the currency is taken from that product's order lines (single
                      transaction currency per product — documented assumption; revenue summed within it).
  currency_code     — the ISO-4217 currency of `revenue_minor` (NULL for a views/cart-only product with 0
                      purchases — zero revenue has no currency; never fabricated).
  return_count      — distinct returned orders containing this product (silver_return ⋈ silver_order_line).
  add_to_cart_rate  — add_to_cart / views, a 2dp STRING; '0.00' when views=0 (NEVER a 0/0 divide).
  purchase_rate     — purchases / views, a 2dp STRING; '0.00' when views=0 (NEVER a 0/0 divide).

THE TRANSFORM (byte/minor-unit exact — reproduced verbatim from the Spark job's SQL):
  - get_json_object(payload, '$.properties.product_id')  →  json_extract_string(payload, '$.properties.product_id')
    (the _base.prop seam). views = 'product.viewed'; add_to_cart = 'cart.viewed' + 'cart.item_added'.
  - format_string('%.2f', a / CAST(views AS DOUBLE))     →  printf('%.2f', a / CAST(views AS DOUBLE))
    (identical IEEE-754 divide + %.2f half-to-even format on both engines).
  - current_timestamp()  →  now() AT TIME ZONE 'UTC'  (UTC-instant, TZ-artifact-free — session is UTC).
  - the keys UNION ∪ 4 LEFT JOINs shape is preserved verbatim.

MONEY (§1.2): revenue_minor = CAST(SUM(line_total_minor) AS BIGINT) minor units + sibling currency_code,
  per (brand, product), NEVER blended, NEVER a float. The conversion RATES are display strings only
  (2dp), computed from integer counts — money never touches a float.

DEGRADES: reads silver_order_line + silver_collector_event + silver_return. If silver_return is absent →
  every product's return_count degrades to 0 (LEFT JOIN COALESCE). If silver_collector_event carries no
  '$.properties.product_id' (the current universal pixel emits product_handle/variant_id, see DATA NOTE
  below) → views/add_to_cart stay 0 and purchases/revenue/title/returns key on the order-line product_id.

DATA NOTE: the current universal pixel emits `product_handle` on product.viewed and `variant_id` on cart
  events (apps/collector pixel-asset.route.ts), not a product_id — so views/add_to_cart populate per-product
  once the pixel carries `$.properties.product_id`. Schema + transform are the deliverable, no code change.

QUARANTINE: none — this Gold rollup has no Stage-1/quarantine side-write (it reads already-gated Silver).
  NOTED (parity-preserving): the Spark job has none either.

PG: none — all three sources are Iceberg. No postgres-extension ATTACH needed.

FULL RECOMPUTE vs Spark's partition-incremental: the Spark job wraps the identical rollup in
  entity_incremental (a SCALING optimization — recompute only brands with new events, then the SAME
  MATCHED-UPDATE / NOT-MATCHED-INSERT MERGE). A full-scan recompute here is parity-equivalent: the MERGE
  on the mart PK is idempotent and restates every (brand_id, product_id) group.

CAVEAT — orphan-shedding: the Spark merge_on_pk here is MATCHED-UPDATE / NOT-MATCHED-INSERT (NO
  delete_orphans). The DuckDB _base.merge_on_pk matches that exactly — no not-matched-by-source DELETE on
  either side, so a fresh <table>_duckdb_test built from the same Silver has an identical admission set.

Honors MIGRATION_TABLE_SUFFIX (→ gold_product_detail_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_product_detail (494 rows).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, prop, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

TABLE = "gold_product_detail"

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_product_detail_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

ORDER_LINE_SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_line"
COLLECTOR_SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_collector_event"
RETURN_SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_return"

# Mirrors the Spark COLUMNS_SQL order/types exactly. product_title/currency_code nullable; the two rates
# are NOT-NULL display strings; money = bigint minor + sibling currency_code.
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

COLUMNS = [
    "brand_id", "product_id", "product_title", "views", "add_to_cart", "purchases",
    "revenue_minor", "currency_code", "return_count", "add_to_cart_rate", "purchase_rate",
    "updated_at",
]

PK = ["brand_id", "product_id"]

# payload.properties.product_id / product_title as strings (DuckDB get_json_object equivalent).
_P_ID = prop("payload", "product_id")
_P_TITLE = prop("payload", "product_title")


def _return_exists(con) -> bool:
    """True iff silver_return exists — absent → every product's return_count degrades to 0 (LEFT JOIN
    COALESCE), mirroring the Spark job over an absent silver_return. Probe so the job degrades gracefully."""
    try:
        con.execute(f"SELECT 1 FROM {RETURN_SOURCE} LIMIT 1")
        return True
    except Exception:  # noqa: BLE001 — returns not built yet → return_count 0 everywhere (graceful)
        return False


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL)

    # returns CTE: attribute a returned order to a product via silver_return ⋈ silver_order_line on order_id.
    # If silver_return is absent, an empty returns CTE keeps the LEFT JOIN's COALESCE(...,0) → 0.
    if _return_exists(con):
        returns_cte = f"""
        returns AS (
            SELECT
                ol.brand_id,
                ol.product_id,
                COUNT(DISTINCT r.order_id) AS return_count
            FROM {RETURN_SOURCE} r
            JOIN {ORDER_LINE_SOURCE} ol
              ON r.brand_id = ol.brand_id AND r.order_id = ol.order_id
            WHERE COALESCE(r.return_class, 'none') <> 'none'
              AND ol.product_id IS NOT NULL
            GROUP BY ol.brand_id, ol.product_id
        )"""
    else:
        returns_cte = """
        returns AS (
            SELECT CAST('' AS VARCHAR) AS brand_id, CAST('' AS VARCHAR) AS product_id,
                   CAST(0 AS BIGINT) AS return_count
            WHERE FALSE
        )"""

    # Faithful SQL port of the Spark staged CTE. purchases/views/atc/returns are keyed by
    # (brand_id, product_id) and LEFT JOINed onto the key union so a product present in only one source
    # still emits a row. Rates are '0.00' when views=0 (never a 0/0 divide).
    staged = f"""
        WITH purchases AS (
            SELECT
                brand_id,
                product_id,
                COUNT(*)                                AS purchases,
                CAST(SUM(line_total_minor) AS BIGINT)   AS revenue_minor,
                MAX(currency_code)                      AS currency_code,
                MAX(title)                              AS product_title
            FROM {ORDER_LINE_SOURCE}
            WHERE brand_id IS NOT NULL AND product_id IS NOT NULL
            GROUP BY brand_id, product_id
        ),
        views AS (
            SELECT
                brand_id,
                {_P_ID}                     AS product_id,
                COUNT(*)                    AS views,
                MAX({_P_TITLE})             AS pixel_title
            FROM {COLLECTOR_SOURCE}
            WHERE event_type = 'product.viewed'
              AND brand_id IS NOT NULL
              AND {_P_ID} IS NOT NULL
            GROUP BY brand_id, {_P_ID}
        ),
        atc AS (
            SELECT
                brand_id,
                {_P_ID}     AS product_id,
                COUNT(*)    AS add_to_cart
            FROM {COLLECTOR_SOURCE}
            WHERE event_type IN ('cart.viewed', 'cart.item_added')
              AND brand_id IS NOT NULL
              AND {_P_ID} IS NOT NULL
            GROUP BY brand_id, {_P_ID}
        ),
        {returns_cte},
        keys AS (
            SELECT brand_id, product_id FROM purchases
            UNION SELECT brand_id, product_id FROM views
            UNION SELECT brand_id, product_id FROM atc
            UNION SELECT brand_id, product_id FROM returns
        )
        SELECT
            k.brand_id,
            k.product_id,
            COALESCE(p.product_title, v.pixel_title)                     AS product_title,
            COALESCE(v.views, 0)                                        AS views,
            COALESCE(a.add_to_cart, 0)                                  AS add_to_cart,
            COALESCE(p.purchases, 0)                                    AS purchases,
            COALESCE(p.revenue_minor, 0)                                AS revenue_minor,
            p.currency_code                                             AS currency_code,
            COALESCE(r.return_count, 0)                                 AS return_count,
            CASE WHEN COALESCE(v.views, 0) = 0 THEN '0.00'
                 ELSE printf('%.2f', COALESCE(a.add_to_cart, 0) / CAST(v.views AS DOUBLE))
            END                                                         AS add_to_cart_rate,
            CASE WHEN COALESCE(v.views, 0) = 0 THEN '0.00'
                 ELSE printf('%.2f', COALESCE(p.purchases, 0) / CAST(v.views AS DOUBLE))
            END                                                         AS purchase_rate,
            now() AT TIME ZONE 'UTC'                                    AS updated_at
        FROM keys k
        LEFT JOIN purchases p ON k.brand_id = p.brand_id AND k.product_id = p.product_id
        LEFT JOIN views     v ON k.brand_id = v.brand_id AND k.product_id = v.product_id
        LEFT JOIN atc       a ON k.brand_id = a.brand_id AND k.product_id = a.product_id
        LEFT JOIN returns   r ON k.brand_id = r.brand_id AND k.product_id = r.product_id
        WHERE k.brand_id IS NOT NULL AND k.product_id IS NOT NULL
    """

    # The rollup is already 1 row per PK (GROUP BY / UNION upstream), so merge_on_pk's in-batch dedup is a
    # no-op; order_by_desc=[updated_at] is a deterministic tie-break. MATCHED-UPDATE / NOT-MATCHED-INSERT.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at"])


if __name__ == "__main__":
    run_job("gold-product-detail", build, target_table=TABLE)
