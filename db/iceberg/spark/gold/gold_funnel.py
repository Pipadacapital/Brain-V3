"""
gold_funnel.py — NET-NEW gap Gold `funnel` mart (Brain V4 Phase 2, GROUP "NEW gap Gold products").

NO dbt predecessor (parity status=NEW; matrix §3/4). The materialized checkout/browse FUNNEL — one row
per (brand_id, funnel_date) holding the session-reach counts for each funnel stage over that day, read
from Iceberg brain_silver.silver_page_view (browse/product stages) + brain_silver.silver_cart_event
(cart stage) + brain_silver.silver_checkout_signal (checkout-abandonment stage). This is the Gold
materialization of the TS metric-engine computeStorefrontFunnel signal (storefront-funnel.ts), lifted to
a daily mart so the funnel dashboard reads a precomputed surface instead of recomputing per request.

STAGES (distinct-session reach per UTC day):
  sessions        — distinct sessions that emitted ANY page view  (silver_page_view, the funnel top).
  product_viewed  — distinct sessions with a product.viewed page  (silver_page_view page_event='product').
  cart_added      — distinct sessions with a cart item_added       (silver_cart_event item_added).
  checkout_started— distinct sessions reaching a checkout signal   (silver_checkout_signal, all rows).
  purchased       — checkout signals that are NOT abandonment      (placeholder 0 until an order-stitch
                    column lands on Silver — see gold_abandoned_cart for the cart→order recovery surface;
                    the funnel keeps the column so the shape is stable and fills with no schema change).

"Session" key: silver_page_view / silver_cart_event carry session_id; silver_checkout_signal has no
session grain, so its stage counts distinct order_id (the closest available checkout identity). Counts
are stage-local distinct identities — the funnel is monotonic only by construction of the data, never
forced.

GRAIN   : 1 row per (brand_id, funnel_date). funnel_date = occurred_at::date (UTC). No money (a funnel is
          session counting — registered money_columns=[]). brand_id first column + partition anchor.
ISOLATION: brand_id first; this is the cross-brand Gold ETL writer (per-brand enforced at the read seam).
REPLAY-SAFE: full daily recompute from Silver, MERGE-UPDATE'd on (brand_id, funnel_date).
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_funnel"

COLUMNS_SQL = """
          brand_id          string    NOT NULL,
          funnel_date       date      NOT NULL,
          sessions          bigint    NOT NULL,
          product_viewed    bigint    NOT NULL,
          cart_added        bigint    NOT NULL,
          checkout_started  bigint    NOT NULL,
          purchased         bigint    NOT NULL,
          updated_at        timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id), funnel_date")

    staged = spark.sql(
        f"""
        WITH pv AS (
            SELECT brand_id,
                   CAST(occurred_at AS DATE) AS funnel_date,
                   session_id,
                   page_event
            FROM {silver('silver_page_view')}
            WHERE session_id IS NOT NULL
        ),
        pv_agg AS (
            SELECT brand_id, funnel_date,
                   COUNT(DISTINCT session_id) AS sessions,
                   COUNT(DISTINCT CASE WHEN page_event = 'product' THEN session_id END) AS product_viewed
            FROM pv
            GROUP BY brand_id, funnel_date
        ),
        cart AS (
            SELECT brand_id,
                   CAST(occurred_at AS DATE) AS funnel_date,
                   COUNT(DISTINCT CASE WHEN cart_action = 'item_added' THEN session_id END) AS cart_added
            FROM {silver('silver_cart_event')}
            WHERE session_id IS NOT NULL
            GROUP BY brand_id, CAST(occurred_at AS DATE)
        ),
        chk AS (
            SELECT brand_id,
                   CAST(occurred_at AS DATE) AS funnel_date,
                   COUNT(DISTINCT order_id) AS checkout_started,
                   -- A checkout signal that is NOT an abandonment is a (potential) purchase reach.
                   COUNT(DISTINCT CASE WHEN signal_type <> 'checkout_abandoned' THEN order_id END) AS purchased
            FROM {silver('silver_checkout_signal')}
            WHERE order_id IS NOT NULL AND occurred_at IS NOT NULL
            GROUP BY brand_id, CAST(occurred_at AS DATE)
        ),
        keys AS (
            SELECT brand_id, funnel_date FROM pv_agg
            UNION SELECT brand_id, funnel_date FROM cart
            UNION SELECT brand_id, funnel_date FROM chk
        )
        SELECT
            k.brand_id,
            k.funnel_date,
            COALESCE(pv_agg.sessions, 0)        AS sessions,
            COALESCE(pv_agg.product_viewed, 0)  AS product_viewed,
            COALESCE(cart.cart_added, 0)        AS cart_added,
            COALESCE(chk.checkout_started, 0)   AS checkout_started,
            COALESCE(chk.purchased, 0)          AS purchased,
            current_timestamp()                 AS updated_at
        FROM keys k
        LEFT JOIN pv_agg USING (brand_id, funnel_date)
        LEFT JOIN cart   USING (brand_id, funnel_date)
        LEFT JOIN chk    USING (brand_id, funnel_date)
        WHERE k.brand_id IS NOT NULL AND k.funnel_date IS NOT NULL
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "funnel_date"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-funnel", build, entity_incremental={
        "table_name": "gold_funnel", "source_tables": ["silver_page_view", "silver_cart_event", "silver_checkout_signal"],
    })
