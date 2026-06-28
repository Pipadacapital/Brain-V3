"""
silver_cart_event.py — NET-NEW canonical Silver `cart_event` grain (Brain V4 Phase 1b, GROUP pixel-behavior).

NO dbt predecessor (parity status=NEW). The cart-interaction grain — one row per cart mutation/view signal
from the universal first-party pixel, normalized to one shape. Powers the `abandoned-cart` and `funnel`
dashboards (coverage matrix §2: cart.item_added/removed/updated/viewed + coupon.applied → silver_cart_event).
DISTINCT from silver_checkout_signal (the checkout-step / shopflo-abandonment grain): cart_event is the
pre-checkout cart-shape fact (add/remove/update/view + promo-code application) that powers
add-to-cart-rate, cart-abandonment, and promo-attach metrics.

SOURCES (universal pixel, collector pixel-asset.route.ts cart-XHR interceptor + form capture):
  - 'cart.item_added'   — /cart/add (Shopify) | wc add-to-cart (Woo). carries variant_id, quantity.
  - 'cart.item_removed' — /cart/change|update qty 0 | wc remove. variant_id, quantity(0).
  - 'cart.updated'      — other /cart/change|update | wc update_cart. variant_id, quantity.
  - 'cart.viewed'       — /cart page view (no line item; a cart-impression).
  - 'coupon.applied'    — a discount/promo/coupon form input on submit. carries `code` (a discount code is
                          NOT PII — folded here as cart_action='coupon_applied' with coupon_code set).

GRAIN   : 1 row per (brand_id, event_id) — the Bronze idempotency key. cart_action is the normalized
          discriminant (item_added | item_removed | updated | viewed | coupon_applied).
MONEY   : value_minor is bigint MINOR units + currency_code — the per-action cart line/total value WHEN the
          storefront emits it. NULL for storefronts (Shopify cart-add XHR, current Bronze) that carry no
          price on the cart payload — NEVER fabricated. Always paired with currency_code.
PII     : hashed/anon-only — brain_anon_id (opaque pixel id), session_id (per-visit uuid). variant_id is a
          product-catalog id (not PII); coupon_code is a discount code (not PII). No raw contact identifier.
ISOLATION: brand_id first column + bucket(256, brand_id) + days(occurred_at) partition.

STAGE-1 GATE (Brain V4 two-stage, _silver_technical): a cart event is anon-keyed, TIMESTAMPED, and OPTIONALLY
  money-bearing (value_minor + currency_code) with a line quantity — so several Stage-1 rules apply, all
  → stage='dq':
    - empty_identifier:brain_anon_id — the silent no-anon drop (cannot tie to a journey) is REPLACED by a
      routed write_quarantine (same admitted set, now observable + replayable).
    - money gate (negative_amount / non_integer_amount / invalid_currency / missing_currency) — run on
      value_minor + currency_code. value_minor is NULL for storefronts that carry no cart price → the gate
      OMITS the money fields for those rows (no false missing_currency); a row that DOES carry value_minor
      must carry a sibling ISO-4217 currency_code (HARD RULE — money never blended/assumed).
    - impossible_quantity — on the cart line `quantity` (negative or absurd ceiling).
    - future/unparseable timestamp — on occurred_at.
  N/A: clean_name/clean_string — product_handle/variant_id are catalog ids, coupon_code is a CASE-SENSITIVE
  discount code (never lowercased/cleaned), path/referrer are URLs. Bronze keeps every original; good rows
  are byte-identical to before (parity-faithful).

DATA AVAILABILITY (this session): current Bronze has cart.item_added (42) + cart.viewed (2) +
cart.updated (1) → populated; value_minor is NULL (Shopify cart XHR carries no price), coupon.applied is 0
(none captured yet) — the schema + transform are the deliverable, both populate with no code change once a
storefront emits cart value / a coupon form is submitted. Parity status=NEW (no dbt baseline).
"""
from __future__ import annotations

from _silver_base import ensure_silver_table, merge_on_pk, prop, read_bronze_events, run_job
from _silver_technical import dq_violations_udf, write_quarantine
from pyspark.sql.functions import array_join, coalesce, col, lit, size, when

TABLE = "silver_cart_event"

CART_EVENTS = ["cart.item_added", "cart.item_removed", "cart.updated", "cart.viewed"]
COUPON_EVENT = "coupon.applied"

COLUMNS_SQL = """
          brand_id        string    NOT NULL,
          event_id        string    NOT NULL,
          brain_anon_id   string    NOT NULL,
          session_id      string,
          cart_action     string,
          product_handle  string,
          variant_id      string,
          quantity        bigint,
          value_minor     bigint,
          currency_code   string,
          coupon_code     string,
          path            string,
          referrer        string,
          device_class    string,
          occurred_at     timestamp NOT NULL,
          ingested_at     timestamp NOT NULL
""".strip("\n")


def _cart_action(event_type_col):
    return (
        when(event_type_col == "cart.item_added", lit("item_added"))
        .when(event_type_col == "cart.item_removed", lit("item_removed"))
        .when(event_type_col == "cart.updated", lit("updated"))
        .when(event_type_col == "cart.viewed", lit("viewed"))
        .when(event_type_col == "coupon.applied", lit("coupon_applied"))
        .otherwise(lit("unknown"))
    )


def build(spark):
    fqtn = ensure_silver_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(occurred_at)"
    )

    # ── Lane 1: cart.* interaction events (variant/qty; value only if the storefront emits it) ──────
    cart = read_bronze_events(spark, CART_EVENTS).select(
        col("brand_id"),
        col("event_id"),
        prop("pj", "brain_anon_id").alias("brain_anon_id"),
        prop("pj", "session_id").alias("session_id"),
        _cart_action(col("event_type")).alias("cart_action"),
        prop("pj", "product_handle").alias("product_handle"),
        prop("pj", "variant_id").alias("variant_id"),
        prop("pj", "quantity").cast("bigint").alias("quantity"),
        # Storefronts that DO carry a cart line/total value emit value_minor (minor units); else NULL.
        prop("pj", "value_minor").cast("bigint").alias("value_minor"),
        prop("pj", "currency_code").alias("currency_code"),
        lit(None).cast("string").alias("coupon_code"),
        prop("pj", "landing_path").alias("path"),
        prop("pj", "referrer").alias("referrer"),
        prop("pj", "device.ua_class").alias("device_class"),
        col("occurred_at"),
        col("ingested_at"),
        # Transient Stage-1 carriers (dropped before MERGE): source event_name + raw payload (replayable).
        col("event_type").alias("_source_event"),
        col("pj").alias("_payload"),
    )

    # ── Lane 2: coupon.applied folded in as a cart action (carries the discount `code`, NOT PII) ─────
    coupon = read_bronze_events(spark, [COUPON_EVENT]).select(
        col("brand_id"),
        col("event_id"),
        prop("pj", "brain_anon_id").alias("brain_anon_id"),
        prop("pj", "session_id").alias("session_id"),
        lit("coupon_applied").alias("cart_action"),
        lit(None).cast("string").alias("product_handle"),
        lit(None).cast("string").alias("variant_id"),
        lit(None).cast("bigint").alias("quantity"),
        prop("pj", "value_minor").cast("bigint").alias("value_minor"),
        prop("pj", "currency_code").alias("currency_code"),
        # The emitter sends `code`; accept `coupon_code` too for non-Shopify storefronts.
        coalesce(prop("pj", "code"), prop("pj", "coupon_code")).alias("coupon_code"),
        prop("pj", "landing_path").alias("path"),
        prop("pj", "referrer").alias("referrer"),
        prop("pj", "device.ua_class").alias("device_class"),
        col("occurred_at"),
        col("ingested_at"),
        col("event_type").alias("_source_event"),
        col("pj").alias("_payload"),
    )

    # Structural PK guard (brand_id/event_id anchor the quarantine row + tenant partition).
    typed = cart.unionByName(coupon).where(col("event_id").isNotNull() & col("brand_id").isNotNull())

    # ── Stage-1 empty_identifier: REPLACE the silent no-anon drop with a routed quarantine (observable) ──
    anon_missing = typed.where(col("brain_anon_id").isNull() | (col("brain_anon_id") == lit("")))
    write_quarantine(
        spark,
        anon_missing.select(
            col("brand_id"),
            col("_source_event").alias("source"),
            col("event_id").alias("bronze_event_id"),
            lit(TABLE).alias("canonical_target"),
            lit("empty_identifier:brain_anon_id").alias("reason"),
            col("_payload").alias("payload"),
        ),
        stage="dq",
    )
    keyed = typed.where(col("brain_anon_id").isNotNull() & (col("brain_anon_id") != lit("")))

    # ── Stage-1 DQ gate: cart money (value_minor + currency) + line quantity + occurred_at → stage='dq' ──
    gated = keyed.withColumn(
        "_dq",
        dq_violations_udf()(
            col("value_minor"), col("currency_code"),
            col("occurred_at").cast("string"), col("quantity"),
        ),
    )
    write_quarantine(
        spark,
        gated.where(size(col("_dq")) > 0).select(
            col("brand_id"),
            col("_source_event").alias("source"),
            col("event_id").alias("bronze_event_id"),
            lit(TABLE).alias("canonical_target"),
            array_join(col("_dq"), ",").alias("reason"),
            col("_payload").alias("payload"),
        ),
        stage="dq",
    )
    staged = gated.where(size(col("_dq")) == 0).drop("_dq", "_payload", "_source_event")

    merge_on_pk(spark, fqtn, staged, ["brand_id", "event_id"], order_by_desc=["ingested_at", "occurred_at"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-cart-event", build, target_table="silver_cart_event")
