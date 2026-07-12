"""
gold_abandoned_cart.py — NET-NEW gap Gold `abandoned_cart` mart (Brain V4 Phase 2, GROUP "NEW gap Gold").

NO dbt predecessor (parity status=NEW; matrix §3/4). The materialized abandoned-cart recovery surface —
one row per (brand_id, cart_date) holding, for that UTC day, how many cart sessions there were, how many
reached a checkout signal (proxy for recovery/intent), and how many abandoned. Read from Iceberg
brain_silver.silver_cart_event (the cart sessions) ⨝ brain_silver.silver_checkout_signal (the checkout/
abandonment signal). This is the Gold materialization of the TS computeAbandonedCart signal
(storefront-abandoned-cart.ts), lifted to a daily mart.

DEFINITIONS (session grain, per UTC day):
  cart_sessions      — distinct sessions with ≥1 cart.item_added in the day (silver_cart_event).
  abandoned_carts    — distinct order_ids that hit a shopflo checkout_abandoned signal in the day
                       (silver_checkout_signal signal_type='checkout_abandoned'). This is the authoritative
                       abandonment signal Brain already captures (the shopflo abandonment webhook).
  abandoned_value_minor — the at-risk cart value: Σ total_price_minor of those abandonment signals, per
                       currency (bigint minor units + currency_code; NEVER blended across currencies).
  recovered_carts    — placeholder 0 until a cart→order stitch column lands on Silver (kept so the shape is
                       stable; fills with no schema change). recovery is the order-stitch the TS reads from
                       silver_touchpoint.stitched_order_id — not present on the cart/checkout Silver grains.

GRAIN   : 1 row per (brand_id, cart_date, currency_code) — per-currency so abandoned_value never blends.
          Rows with no checkout-signal currency carry the cart-event currency or 'INR' fallback consistent
          with the Silver defaults. brand_id first column + partition anchor.
MONEY   : abandoned_value_minor is bigint MINOR units + currency_code (per-currency Σ; never a float).
REPLAY-SAFE: full daily recompute from Silver, MERGE-UPDATE'd on the PK.
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_abandoned_cart"

COLUMNS_SQL = """
          brand_id               string    NOT NULL,
          cart_date              date      NOT NULL,
          currency_code          string    NOT NULL,
          cart_sessions          bigint    NOT NULL,
          abandoned_carts        bigint    NOT NULL,
          recovered_carts        bigint    NOT NULL,
          abandoned_value_minor  bigint    NOT NULL,
          updated_at             timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id), cart_date")

    staged = spark.sql(
        f"""
        WITH cart AS (
            SELECT brand_id,
                   CAST(occurred_at AS DATE) AS cart_date,
                   COALESCE(currency_code, 'INR') AS currency_code,
                   session_id
            FROM {silver('silver_cart_event')}
            WHERE cart_action = 'item_added' AND session_id IS NOT NULL
        ),
        cart_agg AS (
            SELECT brand_id, cart_date, currency_code,
                   COUNT(DISTINCT session_id) AS cart_sessions
            FROM cart
            GROUP BY brand_id, cart_date, currency_code
        ),
        abandoned AS (
            SELECT brand_id,
                   CAST(occurred_at AS DATE) AS cart_date,
                   COALESCE(currency_code, 'INR') AS currency_code,
                   COUNT(DISTINCT order_id) AS abandoned_carts,
                   -- Per-currency Σ of the at-risk abandoned cart value (bigint minor; never blended).
                   COALESCE(SUM(COALESCE(total_price_minor, 0)), 0) AS abandoned_value_minor
            FROM {silver('silver_checkout_signal')}
            WHERE signal_type = 'checkout_abandoned' AND occurred_at IS NOT NULL
            GROUP BY brand_id, CAST(occurred_at AS DATE), COALESCE(currency_code, 'INR')
        ),
        keys AS (
            SELECT brand_id, cart_date, currency_code FROM cart_agg
            UNION SELECT brand_id, cart_date, currency_code FROM abandoned
        )
        SELECT
            k.brand_id,
            k.cart_date,
            k.currency_code,
            COALESCE(cart_agg.cart_sessions, 0)             AS cart_sessions,
            COALESCE(abandoned.abandoned_carts, 0)          AS abandoned_carts,
            CAST(0 AS bigint)                               AS recovered_carts,
            COALESCE(abandoned.abandoned_value_minor, 0)    AS abandoned_value_minor,
            current_timestamp()                             AS updated_at
        FROM keys k
        LEFT JOIN cart_agg  USING (brand_id, cart_date, currency_code)
        LEFT JOIN abandoned USING (brand_id, cart_date, currency_code)
        WHERE k.brand_id IS NOT NULL AND k.cart_date IS NOT NULL
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "cart_date", "currency_code"], delete_orphans=True)  # AUD-IMPL-012: full per-brand recompute — shed disappeared-group orphans
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-abandoned-cart", build, entity_incremental={
        "table_name": "gold_abandoned_cart", "source_tables": ["silver_cart_event", "silver_checkout_signal"],
    })
