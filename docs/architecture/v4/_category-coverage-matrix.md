# V4 — Category & Pixel Coverage Matrix (Silver/Gold completeness)

**Purpose:** guarantee EVERY ingest category (all connector categories + the universal first-party pixel)
produces its **normalized canonical Silver tables** and the **Gold data products** that power analytics,
recommendations, and decisioning. This is the authoritative completeness spec for the V4 Silver/Gold build —
the Spark Silver/Gold jobs must cover every "Need" row; `HAVE` = a model exists today, `GAP` = must be added.

Sources (evidence): connector catalog `apps/core/src/modules/connector/catalog/registry.ts` (categories: storefront,
ads, payments, logistics, analytics, messaging, crm), mapper event-names (`order.live.v1`, `fulfillment.recorded.v1`,
`customer.upsert.v1`, `product.upsert.v1`, `refund.processed`, `settlement.live.v1`, `spend.live.v1`,
`shiprocket.shipment_status.v1`, `gokwik.awb_status.v1`, `gokwik.rto_predict.v1`, `shopflo.checkout_abandoned.v1`,
`dispute.*`), the pixel taxonomy (24 events, `_pixel-events.ts`), and the 15 analytics dashboard surfaces.

---

## 1. Connector categories → canonical Silver

| Category | Connectors | Source events | Canonical Silver table(s) | Status |
|---|---|---|---|---|
| **storefront** | Shopify, WooCommerce | order.live/backfill.v1 | `silver_order_state` | ✅ HAVE |
| | | fulfillment.recorded.v1 / order lines | `silver_order_line`, **`silver_fulfillment`** | HAVE / **GAP** |
| | | product.upsert.v1 | `silver_product`, **`silver_product_variant`**, **`silver_inventory_level`** | HAVE / **GAP** / **GAP** |
| | | customer.upsert.v1 | `silver_customer` | ✅ HAVE |
| | | refund.processed / refund.recorded.v1 | **`silver_refund`** | **GAP** (only folded into recognition) |
| **payments** | GoKwik, Shopflo, Razorpay | (per-order payment) | **`silver_payment`** | NEW (Phase 1) |
| | | settlement.live.v1 | **`silver_settlement`** | NEW (Phase 1) |
| | | dispute.created/won/lost/under_review | **`silver_dispute`** (chargebacks) | **GAP** |
| | | gokwik.rto_predict.v1 | **`silver_cod_rto`** (COD/RTO risk) | **GAP** |
| | | shopflo.checkout_abandoned.v1 | `silver_checkout_signal` | ✅ HAVE |
| **logistics** | Shiprocket, GoKwik AWB | shiprocket.shipment_status.v1, gokwik.awb_status.v1 | `silver_shipment`, `silver_shipment_event` | ✅ HAVE |
| **ads** | Meta, Google Ads | spend.live.v1 | `silver_marketing_spend` | ✅ HAVE |
| | | (campaign metadata) | **`silver_campaign`**, **`silver_ad_account`** | NEW (Phase 1) / **GAP** |
| **analytics** | GA4 | ga4 session/page events | `silver_sessions`, `silver_touchpoint` | ✅ HAVE |
| **messaging** | WhatsApp / outbound | send / delivery / read events | **`silver_message_send`** | **GAP** |
| **crm** | CRM connector | contact upserts / lists | enrich `silver_customer` (+ **`silver_contact`** if distinct) | **GAP (assess)** |

## 2. Universal first-party pixel → canonical Silver

| Pixel events | Canonical Silver table | Powers | Status |
|---|---|---|---|
| page.viewed, product.viewed, collection.viewed | **`silver_page_view`** (behavior grain) | behavior, funnel | **GAP** |
| product.viewed (+ cart) | feeds `silver_touchpoint` | attribution, journey | ✅ HAVE (touchpoint) |
| cart.item_added/removed/updated/viewed | **`silver_cart_event`** | abandoned-cart, funnel | **GAP** |
| checkout.started/step_viewed/shipping_selected | `silver_checkout_signal` | funnel, abandoned-cart | ✅ HAVE (extend) |
| payment.initiated/succeeded/failed | feeds `silver_payment` + funnel | conversion-feedback | partial |
| search.submitted | **`silver_search`** | behavior, merchandising | **GAP** |
| rage.click, dead.click, scroll.depth, element.clicked | **`silver_engagement_signal`** | engagement, UX-quality | **GAP** |
| form.submitted | **`silver_form_submission`** | conversion-feedback, lead | **GAP** |
| coupon.applied | feeds `silver_cart_event` / promo | margin, behavior | **GAP (fold)** |
| user.logged_in/signed_up, identify | `silver_customer_identity`, **`silver_identity_alias`** | identity, customer-360 | NEW (Phase 1) |
| order.placed (pixel-side) | reconciles `silver_order_state` | revenue, conversion-feedback | ✅ HAVE |
| all browser events | `silver_sessions`, **`silver_journey`** (entity grain) | journey, attribution | HAVE / NEW (Phase 1) |

## 3. Gold data products → dashboard surfaces (15)

| Dashboard surface | Gold product needed | Status |
|---|---|---|
| revenue | `gold_revenue_ledger`, `gold_revenue_analytics` | ✅ HAVE |
| orders / order-status | (reads `silver_order_state`) | ✅ HAVE |
| attribution | `gold_attribution_paths`, `gold_marketing_attribution`, `gold_attribution_credit` | ✅ HAVE |
| spend | `silver_marketing_spend` rollup | ✅ HAVE |
| margin | **`gold_contribution_margin`** (CM2) | **GAP** (computed in TS today) |
| logistics | **`gold_logistics_performance`** | **GAP** |
| cod-rto | **`gold_cod_rto`** | **GAP** |
| settlements | **`gold_settlement_summary`** | **GAP** |
| funnel | **`gold_funnel`** | **GAP** |
| abandoned-cart | **`gold_abandoned_cart`** | **GAP** |
| engagement | **`gold_engagement`** | **GAP** |
| behavior | **`gold_behavior`** | **GAP** |
| conversion-feedback | **`gold_conversion_feedback`** | **GAP** |
| journey | (reads `silver_journey`/`silver_touchpoint`) | partial |
| (cross) | `gold_customer_360`, `gold_customer_scores/segments`, `gold_cohorts`, `gold_cac`, `gold_executive_metrics` | ✅ HAVE |

---

## 4. The GAP list to BUILD (drives Phase 1b + Phase 2)

**Silver to ADD (category):** `silver_refund`, `silver_fulfillment`, `silver_product_variant`, `silver_inventory_level`,
`silver_dispute`, `silver_cod_rto`, `silver_ad_account`, `silver_message_send`, (`silver_contact` if CRM distinct).
**Silver to ADD (pixel):** `silver_page_view`, `silver_cart_event`, `silver_search`, `silver_engagement_signal`,
`silver_form_submission`.
**Silver already NEW in Phase 1:** `silver_payment`, `silver_settlement`, `silver_campaign`, `silver_journey`, `silver_identity_alias`.
**Gold to ADD:** `gold_contribution_margin`, `gold_logistics_performance`, `gold_cod_rto`, `gold_settlement_summary`,
`gold_funnel`, `gold_abandoned_cart`, `gold_engagement`, `gold_behavior`, `gold_conversion_feedback`, `gold_campaign_performance`.

**Rule:** every GAP table is built as a Spark→Iceberg job (Silver reads Bronze; Gold reads Silver), `brand_id`-keyed,
money in bigint minor units + currency_code, dual-run + parity-checked, so all 7 connector categories + the universal
pixel are fully normalized for analytics, recommendations, and decisioning.
