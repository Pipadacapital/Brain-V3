"""
mart_registry.py — the declarative mart contract the parity oracle compares on (Brain V4 Phase 0, AREA C).

ONE place that pins, per mart: which medallion layer it lives in, its PRIMARY KEY (the identity the row
count is keyed by), where its CURRENT (dbt/StarRocks or PG) copy lives, and which columns are MONEY
(bigint minor units, summed per-(brand,currency) for the exact-Σ check). Every spec carries the tenant
key `brand_id` implicitly (the oracle always groups/scopes by it).

WHY a registry (not per-mart scripts): the parity harness is reused by every later phase (1→6). Each
phase that builds a new Spark→Iceberg mart adds/edits exactly ONE row here — the comparator code never
changes. This mirrors the metric-engine's "one definition per metric" discipline.

PK + money columns are sourced from the V4 audit reports (08-spark-ownership / 09-starrocks) and the
live StarRocks DDL (e.g. db/starrocks/gold_attribution_credit.sql → PK (brand_id, credit_id),
money = credited_revenue_minor, realized_revenue_minor). Marts whose exact Gold schema is finalized in
a later phase are listed with their best-known PK + money set and a `provisional=True` flag so the owner
of that phase confirms the columns when they build the Spark job. The oracle SKIPs any mart whose NEW
Iceberg table doesn't exist yet, so a provisional row is harmless until its phase lands.

Adding/curating a mart: append a MartSpec to MARTS. `current_schema` is the StarRocks DB (brain_gold /
brain_silver) or the PG schema for source="pg". Money columns MUST be minor-unit bigint columns paired
with a `currency_code` column on the same table (the per-currency Σ requires it).
"""
from dataclasses import dataclass, field
from typing import Dict, List


@dataclass(frozen=True)
class MartSpec:
    name: str                       # table name (same on both sides — the Spark mart mirrors the dbt model name)
    layer: str                      # "silver" | "gold" — picks the Iceberg namespace/warehouse
    pk: List[str]                   # PRIMARY KEY columns (row count keyed by distinct PK); brand_id is implicit
    money_columns: List[str] = field(default_factory=list)  # bigint minor-unit columns (need a sibling currency_code)
    source: str = "starrocks"       # CURRENT side store: "starrocks" (MySQL wire) | "pg"
    current_schema: str = "brain_gold"  # StarRocks DB or PG schema holding the CURRENT table
    provisional: bool = False       # True until the owning phase confirms PK/money against the built Spark mart


# ── Gold business-truth marts (Phase 2) — the cut-over-load-bearing set ───────────────────────────
# Money columns are minor-unit bigint; each mart that carries money also carries currency_code.
_GOLD: List[MartSpec] = [
    # VERIFIED against db/starrocks/gold_attribution_credit.sql (PK + signed minor-unit columns).
    MartSpec(
        name="gold_attribution_credit",
        layer="gold",
        pk=["brand_id", "credit_id"],
        money_columns=["credited_revenue_minor", "realized_revenue_minor"],
        current_schema="brain_gold",
    ),
    # ⚠️ HIGH-RISK money marts (report 08 §3.3) — PK/money provisional until the Phase-2 Spark job lands.
    MartSpec(
        name="gold_revenue_ledger",
        layer="gold",
        pk=["brand_id", "order_id"],
        money_columns=["realized_revenue_minor"],
        current_schema="brain_gold",
        provisional=True,
    ),
    MartSpec(
        name="gold_revenue_analytics",
        layer="gold",
        pk=["brand_id", "period"],
        money_columns=["realized_revenue_minor"],
        current_schema="brain_gold",
        provisional=True,
    ),
    MartSpec(
        name="gold_marketing_attribution",
        layer="gold",
        pk=["brand_id", "channel", "campaign_id", "period"],
        money_columns=["attributed_revenue_minor", "spend_minor"],
        current_schema="brain_gold",
        provisional=True,
    ),
    MartSpec(
        name="gold_attribution_paths",
        layer="gold",
        pk=["brand_id", "path_id"],
        money_columns=["attributed_revenue_minor"],
        current_schema="brain_gold",
        provisional=True,
    ),
    MartSpec(
        name="gold_customer_360",
        layer="gold",
        pk=["brand_id", "brain_id"],
        money_columns=["ltv_minor", "total_revenue_minor"],
        current_schema="brain_gold",
        provisional=True,
    ),
    MartSpec(
        name="gold_cac",
        layer="gold",
        pk=["brand_id", "channel", "period"],
        money_columns=["cac_minor", "spend_minor"],
        current_schema="brain_gold",
        provisional=True,
    ),
    # Non-money Gold marts (PR-2.1) — row-identity parity only.
    MartSpec(name="gold_customer_scores", layer="gold", pk=["brand_id", "brain_id"], current_schema="brain_gold", provisional=True),
    MartSpec(name="gold_customer_segments", layer="gold", pk=["brand_id", "brain_id"], current_schema="brain_gold", provisional=True),
    MartSpec(name="gold_cohorts", layer="gold", pk=["brand_id", "cohort_month"], current_schema="brain_gold", provisional=True),
    MartSpec(name="gold_executive_metrics", layer="gold", pk=["brand_id", "metric_date"], current_schema="brain_gold", provisional=True),
]

# ── Silver entity marts (Phase 1) — row-identity parity keyed by (brand_id, entity_id) ────────────
# Silver is canonical entities; most carry no money column (money lands in Gold). Provisional PKs are
# the documented entity grain from report 08 §3.2; the Phase-1 owner confirms when each Spark job lands.
_SILVER: List[MartSpec] = [
    # CONFIRMED (Phase 1, GROUP customer+identity) against db/dbt/models/marts/silver_customer.sql:
    #   silver_customer          PK (brand_id, brain_id) [identity-resolved key, NOT customer_id];
    #                            money = lifetime_value_minor (bigint minor + currency_code).
    #   silver_customer_identity PK (brand_id, brain_id); no money — the Neo4j Customer-node projection
    #                            (identity SoR, ADR-0004); CURRENT side = StarRocks (TS identity-export).
    MartSpec(name="silver_customer", layer="silver", pk=["brand_id", "brain_id"], money_columns=["lifetime_value_minor"], current_schema="brain_silver"),
    MartSpec(name="silver_customer_identity", layer="silver", pk=["brand_id", "brain_id"], current_schema="brain_silver"),
    # CONFIRMED (Phase 1, GROUP orders) against the built Spark jobs + live StarRocks DESC:
    #   silver_order_state PK (brand_id, order_id);                    money order_value_minor.
    #   silver_order_line  PK (brand_id, order_id, line_index);        money unit_price/line_total/line_discount_minor.
    #   silver_product     PK (brand_id, product_key, currency_code);  money gross_revenue_minor/discount_minor.
    MartSpec(name="silver_order_state", layer="silver", pk=["brand_id", "order_id"], money_columns=["order_value_minor"], current_schema="brain_silver"),
    MartSpec(name="silver_order_line", layer="silver", pk=["brand_id", "order_id", "line_index"], money_columns=["unit_price_minor", "line_total_minor", "line_discount_minor"], current_schema="brain_silver"),
    MartSpec(name="silver_product", layer="silver", pk=["brand_id", "product_key", "currency_code"], money_columns=["gross_revenue_minor", "discount_minor"], current_schema="brain_silver"),
    # CONFIRMED (Phase 1, GROUP touchpoint+sessions) against the built Spark jobs + the dbt grain:
    #   silver_touchpoint PK (brand_id, brain_anon_id, touch_seq) — per-touch grain; there is NO
    #                     touchpoint_id column (silver_touchpoint.sql config keys = brand_id/brain_anon_id/
    #                     touch_seq). No money (asserted no-money mart) → row-identity parity only.
    #   silver_sessions   PK (brand_id, brain_anon_id, session_key) — the 30-min session grain rolled up
    #                     from silver_touchpoint. No money → row-identity parity only.
    MartSpec(name="silver_touchpoint", layer="silver", pk=["brand_id", "brain_anon_id", "touch_seq"], current_schema="brain_silver"),
    MartSpec(name="silver_sessions", layer="silver", pk=["brand_id", "brain_anon_id", "session_key"], current_schema="brain_silver"),
    # ── GROUP checkout+shipment (Phase 1 Spark Silver, dual-run) — PK/money CONFIRMED against the built
    # Spark jobs (db/iceberg/spark/silver/*.py) + the live StarRocks DESC of the dbt marts. ───────
    # silver_checkout_signal grain = (brand_id, event_id); money = total_price_minor / total_discount_minor
    # (bigint minor, paired with currency_code on-row — only populated for shopflo checkout_abandoned rows).
    MartSpec(
        name="silver_checkout_signal",
        layer="silver",
        pk=["brand_id", "event_id"],
        money_columns=["total_price_minor", "total_discount_minor"],
        current_schema="brain_silver",
    ),
    # silver_shipment latest-state grain = (brand_id, order_id); no money column.
    MartSpec(name="silver_shipment", layer="silver", pk=["brand_id", "order_id"], current_schema="brain_silver"),
    # silver_shipment_event transition-log grain = (brand_id, event_id); no money column.
    MartSpec(name="silver_shipment_event", layer="silver", pk=["brand_id", "event_id"], current_schema="brain_silver"),
    # CONFIRMED (Phase 1, GROUP marketing) against db/dbt/models/marts/silver_marketing_spend.sql +
    # the live StarRocks DESC brain_silver.silver_marketing_spend: GRAIN = (brand_id, spend_event_id),
    # money = spend_minor (bigint minor) + currency_code. (The earlier provisional PK
    # platform/campaign_id/spend_date predated the Bronze rebuild; spend_date is not a column.)
    MartSpec(
        name="silver_marketing_spend",
        layer="silver",
        pk=["brand_id", "spend_event_id"],
        money_columns=["spend_minor"],
        current_schema="brain_silver",
    ),
]

# ── NET-NEW canonical-entity Silver marts (Phase 1, GROUP new-entities) — parity status=NEW ──────────
# These five entities have NO dbt/StarRocks predecessor, so there is no CURRENT table to compare against:
# the oracle reads the NEW Iceberg mart, finds no current mart, and emits status=SKIP
# reason=current-mart-absent (exit 0) — the honest "NEW, no baseline" signal (parity policy: status=NEW).
# Registered so they are first-class in the harness the moment any baseline predecessor ever lands.
# current_schema points at brain_silver (where they'd live if dbt built them); current-absent → SKIP today.
_SILVER_NEW_ENTITIES: List[MartSpec] = [
    # settlement/refund/dispute normalizer (settlement.live.v1). Money = amount/fee/tax minor + currency_code.
    MartSpec(
        name="silver_settlement",
        layer="silver",
        pk=["brand_id", "event_id"],
        money_columns=["amount_minor", "fee_minor", "tax_minor"],
        current_schema="brain_silver",
        provisional=True,
    ),
    # payment-event grain (pixel payment.* + razorpay pre-settlement). amount_minor + currency_code.
    MartSpec(
        name="silver_payment",
        layer="silver",
        pk=["brand_id", "event_id"],
        money_columns=["amount_minor"],
        current_schema="brain_silver",
        provisional=True,
    ),
    # marketing-campaign DIMENSION (1 row per brand/platform/campaign). lifetime_spend_minor + currency_code.
    MartSpec(
        name="silver_campaign",
        layer="silver",
        pk=["brand_id", "platform", "campaign_id"],
        money_columns=["lifetime_spend_minor"],
        current_schema="brain_silver",
        provisional=True,
    ),
    # journey ENTITY grain (1 row per brand/brain_anon_id). No money (revenue truth stays in order/settlement).
    MartSpec(
        name="silver_journey",
        layer="silver",
        pk=["brand_id", "brain_anon_id"],
        current_schema="brain_silver",
        provisional=True,
    ),
    # identity_alias = Iceberg projection of Neo4j IDENTIFIES edges. Hashed identifier → brain_id. No money.
    MartSpec(
        name="silver_identity_alias",
        layer="silver",
        pk=["brand_id", "identifier_type", "identifier_value"],
        current_schema="brain_silver",
        provisional=True,
    ),
]

# ── GAP canonical Silver marts (Phase 1b, category/pixel coverage gap-fill) — parity status=NEW ──────
# The matrix (docs/architecture/v4/_category-coverage-matrix.md §4) GAP tables: each connector category
# AND the universal pixel must have a normalized canonical Silver. Like the Phase-1 new-entities, these
# have NO dbt/StarRocks predecessor → the oracle SKIPs (current-mart-absent) until a baseline ever lands.
_SILVER_GAP: List[MartSpec] = [
    # MESSAGING gap (matrix §1, category='messaging' / WhatsApp+outbound): normalize the outbound
    # send/delivery/read lifecycle into ONE canonical row per message. GRAIN = (brand_id, message_id);
    # money = cost_minor (provider per-message price, bigint minor) + currency_code. recipient_hash is the
    # identity-core subject_hash (hashed-PII only). DATA-THIN: no message.*.v1 in Bronze yet (0 rows).
    MartSpec(
        name="silver_message_send",
        layer="silver",
        pk=["brand_id", "message_id"],
        money_columns=["cost_minor"],
        current_schema="brain_silver",
        provisional=True,
    ),
]

# ── GAP pixel-engagement Silver marts (Phase 1b, GROUP pixel-engagement) — parity status=NEW ─────────
# Two first-party-pixel gap-fill marts (matrix §2) with NO dbt/StarRocks predecessor → the oracle SKIPs
# (current-mart-absent) until a baseline ever lands. Both are non-money grains keyed by the Bronze
# idempotency key (brand_id, event_id) — row-identity parity only (money_columns=[]).
_SILVER_GAP_PIXEL_ENGAGEMENT: List[MartSpec] = [
    # silver_engagement_signal: 1 row per (brand_id, event_id) — the normalized UX-quality/engagement signal
    # grain folded from rage.click/dead.click/scroll.depth/element.clicked. No money (a UX-quality marker).
    MartSpec(
        name="silver_engagement_signal",
        layer="silver",
        pk=["brand_id", "event_id"],
        current_schema="brain_silver",
        provisional=True,
    ),
    # silver_form_submission: 1 row per (brand_id, event_id) — the lead/conversion-feedback grain from
    # form.submitted (STRUCTURAL metadata ONLY — NO raw field values / PII). No money.
    MartSpec(
        name="silver_form_submission",
        layer="silver",
        pk=["brand_id", "event_id"],
        current_schema="brain_silver",
        provisional=True,
    ),
]

# ── GAP storefront-category Silver marts (Phase 1b, GROUP storefront gap-fill) — parity status=NEW ────
# The matrix (docs/architecture/v4/_category-coverage-matrix.md §1, storefront) GAP tables built as
# Spark→Iceberg jobs reading raw Bronze (silver_refund.py / silver_fulfillment.py / silver_product_variant.py
# / silver_inventory_level.py), dual-run beside dbt brain_silver. NO dbt/StarRocks predecessor → the oracle
# SKIPs (current-mart-absent) until a baseline ever lands. DATA-THIN: refund.*/fulfillment.recorded.v1/
# product.upsert.v1 are not in Bronze yet (the resources are unsynced) → correct EMPTY tables today.
_SILVER_GAP_STOREFRONT: List[MartSpec] = [
    # refund normalizer (refund.recorded.v1 / refund.processed). Money = amount_minor (settled total) + currency_code.
    MartSpec(
        name="silver_refund",
        layer="silver",
        pk=["brand_id", "event_id"],
        money_columns=["amount_minor"],
        current_schema="brain_silver",
        provisional=True,
    ),
    # fulfillment latest-state grain (fulfillment.recorded.v1). PK (brand_id, fulfillment_id); no money column.
    MartSpec(
        name="silver_fulfillment",
        layer="silver",
        pk=["brand_id", "fulfillment_id"],
        current_schema="brain_silver",
        provisional=True,
    ),
    # per-variant catalogue grain (product.upsert.v1 variants[] / woo flat). Money = price_minor + currency_code.
    MartSpec(
        name="silver_product_variant",
        layer="silver",
        pk=["brand_id", "product_id", "variant_id"],
        money_columns=["price_minor"],
        current_schema="brain_silver",
        provisional=True,
    ),
    # point-in-time per-variant stock history (product.upsert.v1). PK (brand_id, product_id, variant_id, observed_at);
    # no money — inventory_quantity is a count, not money.
    MartSpec(
        name="silver_inventory_level",
        layer="silver",
        pk=["brand_id", "product_id", "variant_id", "observed_at"],
        current_schema="brain_silver",
        provisional=True,
    ),
]

# ── GAP pixel-behavior Silver marts (Phase 1b, GROUP pixel-behavior) — parity status=NEW ─────────────
# The universal first-party-pixel BEHAVIOR grains the coverage matrix §2 flags as GAP. NO dbt/StarRocks
# predecessor → the oracle SKIPs (current-mart-absent) until a baseline ever lands. All three are
# event-grain keyed by the Bronze idempotency key (brand_id, event_id); behavior is impression/interaction
# counting → NO money (page-view/search), EXCEPT the OPTIONAL cart line/total value_minor (bigint minor +
# currency_code, populated only when a storefront emits cart value; NULL for Shopify cart-XHR).
_SILVER_GAP_PIXEL_BEHAVIOR: List[MartSpec] = [
    # silver_page_view: page.viewed / product.viewed / collection.viewed → behavior, funnel. No money.
    MartSpec(
        name="silver_page_view",
        layer="silver",
        pk=["brand_id", "event_id"],
        current_schema="brain_silver",
        provisional=True,
    ),
    # silver_cart_event: cart.* + coupon.applied → abandoned-cart, funnel. value_minor is OPTIONAL cart
    # value (minor + currency_code; NULL when the storefront's cart payload carries no price).
    MartSpec(
        name="silver_cart_event",
        layer="silver",
        pk=["brand_id", "event_id"],
        money_columns=["value_minor"],
        current_schema="brain_silver",
        provisional=True,
    ),
    # silver_search: search.submitted → behavior, merchandising. No money.
    MartSpec(
        name="silver_search",
        layer="silver",
        pk=["brand_id", "event_id"],
        current_schema="brain_silver",
        provisional=True,
    ),
]

# ── GAP payments/logistics-category Silver marts (Phase 1b, GROUP payments/logistics) — parity status=NEW ─
# The matrix (docs/architecture/v4/_category-coverage-matrix.md §1, payments/logistics) GAP tables built as
# Spark→Iceberg jobs reading raw Bronze (silver_dispute.py / silver_cod_rto.py / silver_ad_account.py),
# dual-run beside dbt brain_silver. NO dbt/StarRocks predecessor → the oracle SKIPs (current-mart-absent)
# until a baseline ever lands. PK + money CONFIRMED against the built Spark jobs; verified live over current
# Bronze: silver_cod_rto = 492 rows (COD orders ⨝ rto-predict ⨝ awb); silver_dispute / silver_ad_account =
# correctly EMPTY (data-thin: no dispute/settlement events; spend.live.v1 carries no ad_account_id yet).
_SILVER_GAP_PAYMENTS_LOGISTICS: List[MartSpec] = [
    # chargeback/dispute normalizer (settlement.live.v1 entity_type='dispute' + standalone dispute.*).
    # GRAIN (brand_id, event_id); money = amount_minor (POSITIVE chargeback amount; sign applied by
    # consumers from dispute_direction) + currency_code.
    MartSpec(
        name="silver_dispute",
        layer="silver",
        pk=["brand_id", "event_id"],
        money_columns=["amount_minor"],
        current_schema="brain_silver",
        provisional=True,
    ),
    # COD/RTO risk-and-outcome surface (cod order.live.v1 ⨝ gokwik.rto_predict.v1 ⨝ gokwik.awb_status.v1).
    # GRAIN (brand_id, order_id); money = cod_amount_minor (at-risk COD cash) + currency_code.
    MartSpec(
        name="silver_cod_rto",
        layer="silver",
        pk=["brand_id", "order_id"],
        money_columns=["cod_amount_minor"],
        current_schema="brain_silver",
        provisional=True,
    ),
    # ad-account DIMENSION (1 row per brand/platform/ad_account_id from spend.live.v1).
    # GRAIN (brand_id, platform, ad_account_id); money = lifetime_spend_minor + currency_code.
    MartSpec(
        name="silver_ad_account",
        layer="silver",
        pk=["brand_id", "platform", "ad_account_id"],
        money_columns=["lifetime_spend_minor"],
        current_schema="brain_silver",
        provisional=True,
    ),
]

MARTS: Dict[str, MartSpec] = {
    spec.name: spec
    for spec in (
        _GOLD
        + _SILVER
        + _SILVER_NEW_ENTITIES
        + _SILVER_GAP
        + _SILVER_GAP_PIXEL_ENGAGEMENT
        + _SILVER_GAP_STOREFRONT
        + _SILVER_GAP_PIXEL_BEHAVIOR
        + _SILVER_GAP_PAYMENTS_LOGISTICS
    )
}


def resolve_mart(name: str) -> MartSpec:
    """Look up a mart spec by name; raise a clear error (with the known set) on a typo."""
    spec = MARTS.get(name)
    if spec is None:
        known = ", ".join(sorted(MARTS))
        raise SystemExit(f"[parity-oracle] unknown mart '{name}'. Known marts: {known}")
    return spec
