<!-- SPEC: C.2 / AMD-16 / AMD-17 -->
# GATE-C — measurement namespace map (`gold_measurement_*`)

**Status:** LIVE (WC-C2) · **Date:** 2026-07-07 · **Branch:** `feat/commerce-os-program`
**Binds:** AMD-16 (R1 — extend live facts; alias the spec name where load-bearing) requires "an explicit
mapping table in the Wave C gate file; per-table alias-vs-ratify decisions recorded there." This is that
table. AMD-17 (CM naming) mapping ships with `gold_order_economics` (C.3) and is cross-referenced below.

## Per-table alias-vs-ratify decision (SPEC §C.2)

| Spec name (`gold_measurement_*`) | Underlying single-source-of-truth fact | Decision | Lineage / mapping | Serving view |
|---|---|---|---|---|
| `gold_measurement_refunds` | **NEW Gold fact** = extended `silver_refund` ∪ RTO logistics lane | **NEW fact** (AMD-16: add the genuinely-missing measurement projection; RTO cannot be seen by `silver_refund`) | `source_system`/`source_event_id` native; `reason_code` taxonomy (RTO first-class) | `mv_gold_measurement_refunds` |
| `gold_measurement_settlements` | `silver_settlement` (razorpay lane) | **NEW Gold projection** of the live silver fact (gross/fees/net + `settlement_batch_id`); the live `gold_settlement_summary` rollup is **untouched** | `settlement_batch_id ← settlement_id`; `source_event_id ← event_id`; `source_system ← source` | `mv_gold_measurement_settlements` |
| `gold_measurement_fees` | `silver_settlement.fee_minor`/`tax_minor` | **NEW fact** — extracts per-order fees (fee_type ∈ payment\|tax\|platform\|checkout) so CM reads fees directly | `source_event_id ← event_id` (suffixed `:payment`/`:tax`); `source_system ← source` | `mv_gold_measurement_fees` |
| `gold_measurement_costs` | `billing.cost_input` (global) + `gold_product_costs` (SKU COGS) + order/line spine | **NEW fact** (costs were fully MISSING) — cost_type ∈ cogs\|shipping_forward\|**shipping_reverse (RTO)**\|packaging | `source_system` ∈ catalog\|cost_config; `source_event_id` = deterministic `sha2(brand,order,cost_type)` | `mv_gold_measurement_costs` |
| `gold_product_costs` | `billing.cost_input` scope='sku', cost_type='cogs' | **NEW dimension** (the cost_input sku-scope is its ancestor) | `source_system='cost_input'`; `source_event_id ← cost_input_id`; `valid_from/valid_to ← effective_from/effective_to` | `mv_gold_product_costs` |
| `gold_measurement_spend` | **`silver_marketing_spend` IS the fact** (LIVE 30k+ rows, DONE) | **ALIAS (view only)** — AMD-16 R1: no second copy; the silver table stays the single SoR | `source_event_id ← spend_event_id`; `source_system ← platform` | `mv_gold_measurement_spend` (view alias) |
| `gold_measurement_inventory` | `silver_inventory_level` (level history) | **NEW fact, OPTIONAL + FLAG-GATED** (`measurement.inventory_movement`, default OFF) — movement = qty − prev_qty | `source ← source`; `source_event_id` = deterministic per observation | `mv_gold_measurement_inventory` |

## Invariants held (all facts)
- **brand_id FIRST** on every table + partition anchor (`bucket(64, brand_id)`), tenant-scoped.
- **Money** = `bigint` minor units + sibling `currency_code`, per-currency, **never blended/float** (KWD/BHD/OMR
  3-decimal minor units flow unblended — verified: KWD ledger Σ = 14,540,760 minor across 316 rows).
- **Order-linked grain** = `(brand_id, order_id, event_id)` (order_id coalesced to `''` for a non-null merge key).
- **Lineage** `source_system`/`source_event_id` on every fact (spend maps `platform`/`spend_event_id`).
- **Append-only fact + derived current-state view** (mirrors `gold_revenue_ledger`); idempotent MERGE.

## RTO (return-to-origin) is captured across THREE non-double-counted ledgers
1. **Value reversed to customer** → `gold_measurement_refunds` (`reason_code='rto'`; COD → `cod_not_collected`,
   prepaid → `original_payment`).
2. **Reverse-logistics shipping COST** (the parcel's return leg) → `gold_measurement_costs`
   (`cost_type='shipping_reverse'`, emitted only for orders whose forward shipment reached `terminal_class='rto'`).
3. **Revenue reversal** → the existing `gold_revenue_ledger` (`cod_rto_clawback` / `refund`) — untouched.

## AMD-17 cross-reference (CM numbering)
The NEW `gold_order_economics` (C.3) adopts **spec** CM1/CM2/CM3. The live `gold_contribution_margin` (live
CM1 ≙ spec CM2; live CM2 ≙ spec CM3) is **left untouched** in Wave C and deprecation-mapped in Wave D. C.2
facts feed the spec-numbered economics; they do not touch the live CM mart.

## Live golden evidence (2026-07-07, brands a0a0 / b0b0 / c0c0)
- `silver_refund` **0 → 40** rows (BUGFIX: refund-timing gate resolved order-creation time from the Bronze
  order lane instead of `silver_order_state.first_event_at`, which for a refunded order collapses to the
  refund-webhook time and false-quarantined 40 valid golden refunds as `refund_before_order`).
- `gold_measurement_refunds` **212** rows: `return`/shopify **40** (Σ 6,926,000 INR), `rto`/shiprocket COD
  **158** `cod_not_collected` (Σ 5,380,300 INR), `rto` prepaid **14** `original_payment`.
- `gold_measurement_spend` alias **30,517** rows (`source_system='meta'`).
- `gold_measurement_settlements` / `fees` / `costs` / `product_costs` / `inventory` = **0** rows (honest empty:
  no razorpay settlement sync, no configured `cost_input`, inventory flag OFF) — schema + wiring are the
  deliverable; each populates with no code change once its source lands.
