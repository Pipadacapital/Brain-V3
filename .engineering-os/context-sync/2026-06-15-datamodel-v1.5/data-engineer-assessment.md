# Data Engineer Assessment — Doc-08 v1.5 Delta Map (M1 Context Sync)
**Date:** 2026-06-15  
**Doc:** 08 — Data Model & Database Schema v1.5 (§36 + §37)  
**Purpose:** M1 data-model delta map: new canonical Silver tables, envelope additions, region/tax fields, reserved domains, contract-first promotion rule. Context-sync only — no build, no Canon change.

---

## 1. What Changed (v1.4 → v1.5)

v1.4 (§36) added multi-region/currency/tax-regime as a first-class model concern and reserved five new domains.  
v1.5 (§37) added the field-complete canonical dictionary — proving every field in the Data Layer Storage Spec maps to a Brain canonical field. It is additive to §6/§11 (no field removed). It also adds concrete canonical Silver tables that §11 listed only at a representative level.

---

## 2. Provenance Envelope Extension (§37 preamble)

Every Silver canonical row already carries the doc-07 §4 universal envelope. §37 extends that envelope with fields Sprint-0's `CollectorEventV1Schema` and Bronze `brain_bronze.collector_events` do not yet include.

**Fields that must be added to the Bronze schema (additive-optional, I-E02 compliant) and to `packages/contracts` canonical Silver types:**

| New envelope field | Type | Note |
|---|---|---|
| `region` | `CHAR(2)` — `IN|AE|SA|...` | Lives on brand (already) AND on region-varying rows in Silver |
| `transaction_currency` | `CHAR(3)` | The currency the transaction was denominated in; distinct from the brand's reporting currency |
| `reporting_currency_value_minor` | `BIGINT` | Cross-region rollup: value normalized via `fx_rate` to brand's reporting currency |
| `source_system` | `TEXT` | Originating connector type / system name |
| `connector_id` | `UUID` | FK to `connector_instance` — every ingested row references its connector |
| `source_object_id` | `TEXT` | Provider-native PK (e.g. Shopify `order.id`) |
| `source_created_at` | `TIMESTAMPTZ` | Provider's own created-at timestamp |
| `source_updated_at` | `TIMESTAMPTZ` | Provider's own updated-at timestamp |
| `sync_batch_id` | `UUID` | The sync job batch that produced this row — for backfill tracing |
| `dedup_key` | `TEXT` | Deterministic deduplication key (provider-specific composite) |

**Impact on Sprint-0 artifacts:**
- `db/iceberg/bronze_spec.json` + `db/iceberg/bronze_table.sql`: the new envelope fields are additive-optional (nullable, no default required beyond NULL) — safe under I-E02's additive-optional-only evolution policy. The partition spec (bucket(brand_id) + days(occurred_at)) is unchanged.
- `packages/contracts/src/events/sample.collector.event.v1.ts`: the Zod envelope schema needs these fields added as `.optional()` fields (the canonical Silver contracts will require most of them as non-null after the dbt staging layer enforces presence).
- `packages/contracts/src/dq/index.ts`: the DQ completeness check now has a concrete target shape — `connector_id` and `dedup_key` non-null rates on Silver tables are M1 DQ assertions.

---

## 3. New Canonical Silver Tables (M1 Must-Build vs Sprint-0)

Sprint-0 §11 shipped Silver as a template with placeholder DDL covering: `behavior_event`, `order_state`, `order_cost_component`, `payment`, `settlement`, `marketing_spend`, `shipment`, `product`, `inventory`, `support`, `customer`, `identity_projection`.

§37 defines the **field-complete** schema for every one of those AND adds **8 net-new canonical Silver tables** that M1 must build.

### 3.1 Tables Sprint-0 has (now field-complete in §37 — existing DDL must be expanded)

| Table | PK | Key delta from Sprint-0 representative schema |
|---|---|---|
| `silver.behavior_event` | `(brand_id, event_id)` | Full UTM set (utm_source/medium/campaign/content/term), all click-ids (fbclid/gclid/wbraid/gbraid/ttclid/msclkid/sclid/epik/li_fat_id/twclid), fbp/fbc/ga_client_id, device/os/browser/screen_resolution/viewport/language/timezone, ip_hash, geo_country/region/city, consent_state(json), product/cart context (product_id/variant_id/price_minor/currency_code/quantity/cart_token/cart_value_minor), pixel_version, dedup_state, identity_state |
| `silver.order_state` | `(brand_id, order_id)` | is_cod, tax_regime, subtotal/total_discounts/total_tax/total_shipping/total_price_minor, discount_codes(json), landing_site/referring_site, source_name enum (+marketplace), ship_country/state_or_emirate/city/postcode, cart_attr_brain_anon_id/click_ids/first_utms (the §35 stitch), settled_status enum, net_realized_value_minor, recognition_label |
| `silver.payment` | `(brand_id, payment_id)` | provider_type enum, tax_on_fee_minor, cod_confirmation_status, BNPL extras (installment_count/installment_schedule(json)/down_payment_minor/merchant_fee_minor), GoKwik extras (rto_risk_score/rto_risk_tier/address_quality_score/prepaid_conversion_flag) |
| `silver.settlement` | `(brand_id, settlement_id)` | utr field added |
| `silver.marketing_spend` | `(brand_id, platform, account_id, campaign_id, adset_id, ad_id, spend_date)` | link_clicks, reach, frequency, video_views_3s, thruplays, ctr, cpc, cpm, platform_reported_conversions/conversion_value, breakdown_placement/device, reporting_currency_value_minor, is_final, fx_rate_id |
| `silver.shipment` | `(brand_id, shipment_id)` | provider_type enum, carrier (separate from provider), cod_amount_minor/currency/remitted/remitted_at, forward_shipping_cost_minor, rto_shipping_cost_minor (both cost legs), delivery_postcode, zone, ndr_count/reason canonical |
| `silver.product` | `(brand_id, product_id)` | handle, product_type, vendor, status, tags(json) |
| `silver.customer` | `(brand_id, brain_id)` | orders_count, total_spent_minor, aov_minor, ltv_minor, acquisition_channel, acquisition_cohort, first_order_at, accepts_email/sms/whatsapp, country, state_or_emirate, city, postcode, tags(json), identity_confidence, completeness |

### 3.2 Net-New Tables M1 Must Build (not in Sprint-0)

| Table | PK | Purpose / Key fields |
|---|---|---|
| `silver.ad_account` | `(brand_id, platform, account_id)` | Ad account dim: account_name, currency, timezone, spend_cap. Needed for multi-account spend attribution |
| `silver.ad_campaign` | `(brand_id, campaign_id)` | Campaign dim: account_id, campaign_name, objective, status, buying_type, bid_strategy, daily/lifetime_budget_minor, start_time, stop_time |
| `silver.ad_set` | `(brand_id, adset_id)` | Ad set dim: campaign_id, name, optimization_goal, billing_event, bid_strategy, bid_amount_minor, budget_minor, targeting_summary(json), placements(json), schedule |
| `silver.ad_creative` | `(brand_id, ad_id)` | Creative dim: adset_id, ad_name, creative_id, format, creative_assets(json), **destination_url, url_tags** (THE join key for UTM-to-spend attribution), status |
| `silver.product_variant` | `(brand_id, variant_id)` | Variant dim: product_id, sku, barcode, price_minor, compare_at_price_minor, unit_cost_minor (COGS net recoverable tax), tax_treatment, inventory_item_id, options(json), cost_confidence |
| `silver.inventory_level` | `(brand_id, inventory_item_id, location_id)` | Stock level: available, reserved, reorder_point, updated_at |
| `silver.order_line_item` | `(brand_id, line_item_id)` | Line item: order_id, product_id, variant_id, sku, quantity, unit_price_minor, line_discount_minor, line_tax_minor, unit_cost_snapshot_minor |
| `silver.order_status_history` | `(brand_id, order_id, changed_at)` | Append-only status audit: status_type enum (financial/fulfillment/shipment/settlement), from_status, to_status |
| `silver.refund` | `(brand_id, refund_id)` | Refund: order_id, amount_minor, reason, line_items(json), created_at. Drives ledger event_type=refund (§7) — this is the canonical source for refund events |
| `silver.shipment_tracking_event` | `(brand_id, shipment_id, event_at)` | Per-scan tracking: provider_status_raw, status(canonical), location, ndr_reason |

**All 10 new tables:** brand_id is the tenant key on every row; all partitioned HASH(brand_id, high-card key) in StarRocks; row policy applied at creation per the silver_template invariant.

### 3.3 Identity Table Field-Complete Additions (§37.1)

These are Postgres-resident (not Silver/StarRocks) but M1 must extend the existing DDL:

- `identity_link.identifier_type` enum: add `brain_anon_id`, `platform_customer_id`, `fbp`, `fbc`, `ga_client_id`, `click_id`, `device_signature`, `fp_cookie` to the Sprint-0 set
- `identity_link`: add `click_id_platform`, `edge_type` (deterministic|probabilistic), `evidence_event_id`, `first_seen_at`, `last_seen_at`
- `customer`: add `anonymous_id`, `resolved_at`, `first_touch_at` (Sprint-0 had lifecycle_state + merge fields only)
- `consent_record`: add `region` column + expand `category` enum to include `email`, `sms`, `whatsapp`, `ai_processing` (Sprint-0 had analytics/marketing/personalization/ai_processing — add email/sms/whatsapp)

---

## 4. Region / Currency / Tax — First-Class M1 Model Fields (§36 Delta 1)

These fields are **model invariants built now** (cheap; expensive to retrofit). GCC go-to-market stays Phase 5 (doc 03 ADR-014; doc 04 §528/§656).

**What every taxable value must carry:**

| Field | Type | Rule |
|---|---|---|
| `tax_regime` | `TEXT CHECK IN ('GST_IN','VAT_AE_5','VAT_SA_15',...)` | Never a bare tax number — always a labelled regime + breakdown |
| `tax_breakdown` | `JSONB` | Itemized tax components (CGST/SGST/IGST for GST_IN; VAT for AE/SA) |
| `region` | `CHAR(2)` CHECK IN ('IN','AE','SA',...) | On region-varying rows and on the `brand` table (already present) |

**What every cross-region rollup fact must carry (in addition to transaction_currency):**

| Field | Type | Rule |
|---|---|---|
| `transaction_currency` | `CHAR(3)` | The currency the transaction occurred in |
| `reporting_currency_value_minor` | `BIGINT` | Value converted to brand's reporting currency via `fx_rate` (§5.4) |
| `fx_rate_id` | `UUID FK → fx_rate` | The exact rate row used — auditable, reproducible |

**Specific Silver tables that need tax_regime + region:**
- `silver.order_state`: already has `tax_regime` in §37.5; needs `region` (derivable from ship_country but explicit for query performance)
- `silver.order_line_item`: `line_tax_minor` must be paired with `tax_regime` on the parent order
- `silver.payment`: tax_on_fee_minor requires the tax_regime of the provider's jurisdiction
- `gold.order_margin_fact`: needs `region` for True-CM2 slices

**COD/RTO discipline (§36):** COD and RTO are region attributes, not India-only. The ledger's existing event_types (provisional_recognition, rto_reversal) and order_cost_component cost_types (cod_fee, return_cost) already handle this — no India hard-coding is permissible anywhere in the pipeline or dbt models.

**Connector registry (§36 Delta 2):** `connector_instance` must gain three columns in M1:
- `category` TEXT CHECK IN ('ads','storefront','marketplace','payments','logistics','accounting','messaging','reviews')
- `provider_type` TEXT CHECK IN ('gateway','checkout_platform','bnpl','aggregator','direct_courier',...)
- `region` CHAR(2) — the region this connector instance serves

These are additive columns on an existing Postgres table — standard `node-pg-migrate` migration.

---

## 5. Reserved Domains — Phase 2+ (Build NONE in M1) (§36 Delta 3)

The following domains are **modeled in §36, reserved, not built in Phase 1**. Do not create tables, dbt models, connectors, or event contracts for any of these in M1. When built (Phase 2+), their event types enter the doc-07 catalog at that point.

| Reserved domain | Tables | Phase trigger |
|---|---|---|
| Accounting / AICFO | `chart_of_accounts`, `ledger_transactions`, `bills`, `accounting_invoices`, `tax_ledger` | Phase 2+ (Zoho/Tally/QuickBooks/Xero adapters) |
| Marketplace fees | `marketplace_fees` | Phase 2+ (Amazon/Noon); `order_state.channel='marketplace'` works in M1 for attribution-only |
| Messaging as touchpoints | `messaging_events` | Phase 2+ (email/sms/whatsapp attribution); WhatsApp send chokepoint (Phase 3 per STACK.md) |
| Reviews | `reviews` | Phase 2+ |
| CAPI dispatch log | `capi_dispatch_log` | Built with CAPI passback (Phase 3 per STACK.md ADR-012) |

**Note:** `silver.support` (§11) IS in scope for M1 — it is not a reserved domain.

---

## 6. Canonicalization Boundary — raw_payload vs Canonical (§37.11)

This is a design discipline, not a schema change. The rule is:

**A field is canonicalized only when a named Brain capability (identity, attribution, journey, revenue/CM2, decision engine) depends on it. Everything else stays in Bronze `raw_payload`.**

Fields confirmed raw_payload-only (never to be promoted without a `packages/contracts` change):
- **Ads:** `targeting_summary` detail, creative binary asset refs beyond headline/primary_text/CTA, Google `keywords`/`search_terms`/`quality_score`, placement micro-breakdowns
- **Payments:** BNPL `installment_schedule` detail (canonical keeps `installment_count` + `merchant_fee_minor`); raw acquirer/3DS response codes
- **Web events:** raw `user_agent` string + full device fingerprint (canonical keeps parsed device_type/os/browser + device-signal fields); raw IP (only `ip_hash` canonical)
- **Marketplace:** Amazon BuyerInfo / masked buyer PII (PII-restricted — never canonical); internal marketplace flags
- **Reviews:** review body / photo refs (canonical keeps rating/verified_buyer/sentiment)

**Promotion rule (I-E01 + §37.11 combined):** A raw Bronze field becomes canonical **only via a `packages/contracts` change** when a named Brain capability requires it. This prevents canonical-model bloat and keeps the contract-first invariant clean.

---

## 7. DQ / Parity Implications for M1

Sprint-0 shipped DQ as structural stubs in `db/dbt/tests/_dq_stubs.yml` with four categories (freshness, completeness, schema_validity, reconciliation). §37 gives those stubs a concrete target shape.

**What M1 must instantiate in the DQ framework:**

| DQ category | Concrete M1 assertions (examples — non-exhaustive) |
|---|---|
| Completeness | `connector_id NOT NULL` on all Silver canonical rows; `dedup_key NOT NULL`; `tax_regime NOT NULL` on all taxable Silver rows; `brand_id NOT NULL` on every row (already in stubs) |
| Uniqueness | `(brand_id, order_id)` unique on `silver.order_state` after dedup; `(brand_id, refund_id)` unique on `silver.refund`; `(brand_id, line_item_id)` on `silver.order_line_item` |
| Referential integrity | every `order_line_item.order_id` resolves to `silver.order_state`; every `refund.order_id` resolves; every `shipment_tracking_event.(brand_id,shipment_id)` resolves to `silver.shipment` |
| Reconciliation | Bronze row count by brand/day vs StarRocks Silver ingested count within ±0% (exact, per METRICS.md parity oracle assumption); ledger closed-sum per order = 0 for fully-RTO'd orders |
| Distribution drift | `marketing_spend.spend_minor` daily total per brand within ±3σ of trailing-30d; `order_state` daily order count per brand within ±3σ |
| Range / sign | `marketing_spend.spend_minor >= 0`; `order_state.total_price_minor >= 0`; `refund.amount_minor >= 0` |
| Tax regime coverage | every `order_state` row with `total_tax_minor > 0` has a non-null `tax_regime` |
| Currency pairing | every `*_minor` column on canonical Silver rows has a non-null paired `currency_code` (the money-lint rule in DQ form) |

**Estimated→authoritative gate for M1:** the gate from `packages/contracts/src/dq/index.ts` now has concrete column targets. The DQ `DqCompletenessCheckSchema.required_columns` arrays for each Silver table can be derived directly from the §37 field dictionaries.

**Stream/batch parity:** `silver.marketing_spend` is a known dual-path table (the live connector sync and the daily batch reconciliation must agree within `is_final` semantics). The `reconciliation` DQ check category in Sprint-0 stubs must be instantiated against this table specifically — the metric `mer` (MER) depends on it.

---

## 8. dbt Model Targets (M1 staging→intermediate→canonical)

Sprint-0's `db/dbt/dbt_project.yml` declares staging (view) → intermediate (view) → marts (table) with an empty stub model. M1's concrete dbt model count implied by §37:

| dbt layer | Models implied |
|---|---|
| staging | One staging model per Bronze event family per connector category (e.g. stg_shopify_orders, stg_meta_ad_insights, stg_shiprocket_shipments, ...) — 1:1 Bronze dedup on (brand_id, event_id) |
| intermediate | int_order_state (lifecycle merge), int_identity_projection, int_marketing_spend_dedup, int_product_variant_join, int_shipment_status_canonical |
| marts / Silver canonical | One dbt model per Silver canonical table listed in §3 above (18 total: 8 expanded + 10 new) |
| Gold marts | `order_margin_fact`, `channel_contribution`, `attribution_confidence_mart`, `customer_360` — unchanged from §12, but now fed by the richer Silver |

All dbt models: `DISTRIBUTED BY HASH(brand_id, <high-card key>)`; row policy applied; no metric computation in SQL (metric engine only, I-E03).

---

## 9. What Is NOT Changing

- The medallion architecture (Bronze Iceberg → dbt → StarRocks Silver/Gold) — unchanged
- The single realized_revenue_ledger + attribution_credit_ledger — unchanged (no new ledgers)
- The metric registry definitions in `METRICS.md` — unchanged (richer Silver inputs feed them, no formula change)
- The two-ledger append-only design — unchanged
- The GCC go-to-market timing — Phase 5 (doc 04 §528/§656)
- The partition spec on Bronze (`bucket(16, brand_id) + days(occurred_at)`) — additive evolution only
- StarRocks as serving layer — unchanged until Phase-3 Iceberg-SoR flip

---

## 10. Cross-Checks Against Canon

| Canon constraint | Status after §36/§37 |
|---|---|
| STACK.md: money = `*_minor BIGINT + currency_code CHAR(3)` | All §37 tables comply; `reporting_currency_value_minor` is correctly a BIGINT |
| STACK.md: tenant key = `brand_id` on every row | All §37 tables have `brand_id` as first PK component |
| INVARIANTS.md I-E01: contract-first | §37.11 promotion rule is the data-layer equivalent — `packages/contracts` change gates canonical promotion |
| INVARIANTS.md I-E02: replayable; additive evolution only | Envelope extensions are additive-optional; no Bronze field is removed |
| INVARIANTS.md I-S07: no float money | §37 uses `*_minor BIGINT` throughout; `fx_rate NUMERIC(18,8)` is the only non-integer (a rate, not a stored value) |
| INVARIANTS.md I-ST04: idempotent on (brand_id, event_id) | `dedup_key` in envelope supports deterministic dedup; Bronze MERGE predicate unchanged |
| METRICS.md: no metric recomputed outside the TS engine | §37 Silver tables hold components only; Gold mart holds cost components only — engine does all math |
