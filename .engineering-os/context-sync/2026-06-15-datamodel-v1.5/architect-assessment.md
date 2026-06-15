# Architect Assessment — Context-Sync: Data Model v1.5 (doc 08 §36/§37 + doc 03 region note)

**Agent:** architect (subagent, context-sync; no spawn, no Canon change)
**Date:** 2026-06-15
**Inputs read:** `source-diff.patch` (doc 03 line 43; doc 08 §36/§37) · `STACK.md` (ADR-001/002/003/014) · `INVARIANTS.md` (I-S01/S02/S07, I-E02/E05) · `HLD.md` (§Data ownership L91–L98; Silver domains L96; Gold ledgers L97) · doc 03 §65
**Verdict:** **Frozen architecture intact — no new primitive.** Region seam = **additive columns now**. M1 data-model scope grows by the field-complete dictionary + named canonical dims; reserved domains stay modeled-not-built.

---

## 1. Single-Primitive / frozen-architecture check — PASS (no new primitive)

The doc claims "no new services/ledgers; Phase-1 build scope unchanged." Verified against the Canon, item by item:

| §36/§37 element | Fits existing primitive? | Canon anchor |
|---|---|---|
| 5 reserved canonical domains (accounting GL, marketplace_fees, messaging_events, reviews, capi_dispatch_log) | **Yes — Silver tables, modeled-not-built.** None is a service/deployable/DB. None is a new ledger. | HLD L96 (Silver = StarRocks-native dbt-on-StarRocks PK tables); STACK ADR-002; I-E05 (folder-not-service) |
| "no new ledger" claim | **Verified.** The realized-revenue + attribution-credit ledgers remain the only two; accounting GL is a **Silver canonical domain** (read-derived analytics), NOT a third economic SoR. | HLD L97 (the two Gold ledgers are exhaustively named); STACK locked-choice #5; INVARIANTS anti-pattern list (only `realized_revenue_ledger`/`attribution_credit_ledger` are protected) |
| Connector-registry extension (`category`, `provider_type`, `region` on `connector_instance`) | **Yes — additive columns on an existing Postgres control-plane table.** New providers = adapter/folder per conform-by-category, not a schema change. | STACK ADR-001 (Postgres control plane owns connector cursors/credentials); I-E05; HLD L51 (connector module) |
| Region columns (`reporting_currency_value_minor`, `tax_regime` enum, `region`) | **Yes — additive columns on existing Silver facts + `brand`.** Money already `*_minor BIGINT` + `currency_code`. | I-S07 (money in minor units); STACK ADR-014 (RegionAdapter seam built, India binding active) |
| Field-complete dictionary (§37) + named dims (`product_variant`, `order_line_item`, `order_status_history`, `refund`, ad-structure dims, `shipment_tracking_event`, `inventory_level`) | **Yes — additive Silver columns + child dims under existing canonical domains** (`behavior_event`, `order_state`, `product`, `marketing_spend`, `shipment`). §37 explicitly "additive to §6/§11, no field removed." | HLD L96 (Silver canonical domain list already names customer/identity/behavior_event/order_state/product/payment/marketing_spend/shipment/inventory/support/touchpoint) |

**Nothing flagged as NOT fitting.** Every delta lands in: Postgres control-plane (connector registry cols), Iceberg Bronze (raw_payload retains everything per §37.11), StarRocks Silver (canonical dims + region cols), StarRocks Gold (reporting-currency rollup cols on existing facts) — the four physical tiers in STACK ADR-001/002/005. **Zero new deployable, DB, ledger, or platform.** Single-Primitive rule (I-E05) holds.

**§37.11 promotion rule ("a raw field becomes canonical only via a `packages/contracts` change") is consistent with contract-first (I-E01)** — it is the correct gating mechanism: canonical-model growth is contract-gated, not ad-hoc. No conflict.

---

## 2. Region seam impact — **additive-columns-now; RegionAdapter posture UNCHANGED**

- **No change to RegionAdapter posture.** STACK ADR-014 already states the seam is *built in Phase 1, India binding only active*; UAE/GCC coverage + Arabic/RTL = Phase-5 graduation trigger. §36 Delta 1 is **data-model first-class-ness**, which is a different axis from runtime region behaviour. The seam was always there; v1.5 ensures the **data carries the region/currency/tax dimensions so Phase 5 is purely additive (a binding flip), never a backfill/retrofit.** doc 03 line 43 + §65 reaffirm "multi-region is a Phase-5 trigger" — no regression.
- **No change to HLD data-ownership.** The reporting-currency rollup column lives on existing Gold facts (owned by the computing context); `tax_regime`/`region` live on existing Silver rows + `brand`. OLTP/OLAP split, one-way `Iceberg→dbt→StarRocks`, single-Analytics-API read path (I-ST01) all untouched.
- **`currency_code` set ∈ {INR, AED, SAR}** already declared in STACK + INVARIANTS I-S07 — the AED/SAR codes pre-anticipate GCC; v1.5 adds the `tax_regime` enum (`GST_IN | VAT_AE_5 | VAT_SA_15`) and the reporting-currency normalization, consistent with that set.

### Cheap-now / expensive-to-retrofit — M1 MUST carry from day one
- `tax_regime` enum + tax breakdown on every taxable value (never a bare tax number) — retrofitting tax-regime onto historical immutable Bronze/ledger rows is expensive; cheap as a day-one column.
- `region` on `brand` (exists) **and** on region-varying Silver rows.
- `reporting_currency_value_minor` alongside `transaction_currency` on cross-region rollup facts (normalized via `fx_rate` §5.4) — FX-at-realization is path-dependent; capture-at-write is cheap, recompute-from-history is not.
- COD/RTO treated as **region attributes, not India-only** (the True-CM2 / ledger logic already handles them — no India hard-coding to unwind later).

### Stays Phase 5 (RegionAdapter graduation trigger — NOT M1)
- GCC connectors (Telr/Tap/Tabby/Tamara/Noon/Amazon-AE/Aramex/DHL etc.) — connector roadmap, adapter-per-folder.
- GCC go-to-market / launch.
- Arabic / RTL UI (`next-intl` seam built; binding deferred).

---

## 3. Reserved-domains architecture — confirmed modeled-not-built, slot cleanly into Silver

All five reserved domains (`chart_of_accounts`/`ledger_transactions`/`bills`/`accounting_invoices`/`tax_ledger`, `marketplace_fees`, `messaging_events`, `reviews`, `capi_dispatch_log`) confirmed:
- **Modeled-not-built** — defined in §36/§37; **NONE built in Phase 1** (built Phase 2+). doc 07 reserved event types (`messaging.*`, `marketplace.*`, `capi.*`) enter the event catalog **only when built**.
- **Brand-scoped (RLS)** — §36 states "all brand-scoped (RLS)"; satisfies I-S01.
- **No-PII** — §36 "no-PII + provenance-stamped"; Amazon `BuyerInfo`/masked buyer PII explicitly PII-restricted → never canonical (§37.11); satisfies I-S02.
- **Slot into Silver** — all are canonical Silver tables, not new services/ledgers. Accounting GL is **read-derived analytics into CM2/CM3 (AICFO)**, NOT a third economic ledger — the two-ledger invariant holds.
- **Promotion only via `packages/contracts` change (§37.11)** — consistent with contract-first (I-E01). Reserved tables become live only when a named Brain capability requires them, via a contract change + connector build. This is the correct, frozen mechanism.

**`capi_dispatch_log` note:** CAPI passback is output-only / consent-gated / never an attribution input (doc 01 §7.4.10) — the dispatch log is built *with* the CAPI passback (Phase 3 per STACK locked-choice #11, when the send/consent chokepoint goes live for WhatsApp + CAPI). Consistent with I-S08 (no write tool on MCP — this is a connector-side dispatch record, not an AI write path) and I-S03/S04 (consent-gated, deletion-aware).

---

## 4. M1 implications — for the data-platform builder

**The frozen architecture does not change. M1's data-model build scope grows additively** — the field-complete dictionary (§37) enriches the existing canonical Silver tables, and several named child dims become part of M1's canonical layer. Summary for `@data-engineer`:

**M1 NOW carries (additive, day-one — cheap, retrofit-expensive):**
- **Provenance envelope** extended with region/currency fields on every Silver row: `region`, `transaction_currency`, `reporting_currency_value_minor` (+ existing `brand_id, source_system, category, connector_id, source_object_id, source_created_at/updated_at, ingested_at, sync_batch_id, dedup_key`).
- **`tax_regime` enum + tax breakdown** on every taxable value (`order_state`, payments, etc.) — never a bare tax number.
- **Connector registry cols** on `connector_instance`: `category`, `provider_type`, `region`.
- **Field-complete canonical Silver** (§37.1–§37.8) — `behavior_event` (full UTM set, click-id map, fbp/fbc/ga_client_id, device/geo/cart context, pixel_version), `customer`, `payment` (provider_type, tax_on_fee, cod_confirmation, BNPL + GoKwik RTO-risk extras), `shipment` (carrier vs provider, COD remittance, both cost legs, canonical status).
- **New canonical child dims** (part of M1's canonical layer):
  - `silver.ad_account`, `silver.ad_campaign`, `silver.ad_set`, `silver.ad_creative` (ad-structure dims; `destination_url`+`url_tags` are THE attribution join key)
  - `silver.product_variant` (+ `silver.inventory_level`)
  - `silver.order_line_item`, `silver.order_status_history`, `silver.refund`
  - `silver.shipment_tracking_event`
- **§37.11 canonicalization discipline:** store raw always in Bronze `raw_payload`; canonicalize a field **only if** a named Brain capability (identity / attribution / journey / revenue-CM2 / decision engine) depends on it. The listed raw-only fields (targeting detail, BNPL installment schedule, raw UA/IP, marketplace BuyerInfo, review body) stay in `raw_payload` — do not promote without a `packages/contracts` change. This keeps the canonical model **complete and lean**.

**M1 does NOT build (reserved / Phase-gated):**
- The 5 reserved domains (accounting GL, marketplace_fees, messaging_events, reviews, capi_dispatch_log) — modeled-not-built; built Phase 2+. Do not create these tables or their event types in M1.
- GCC connectors / Arabic-RTL — Phase 5.
- `capi_dispatch_log` — built with the Phase-3 CAPI passback.

**Build-team guidance:** treat §37 as the **field source-of-truth for the M1 canonical migration** (`db/migrations` + `packages/contracts` Zod→types/Avro per I-E01). All additions are column/dim additions over the existing medallion — **no destructive migration** (I-E02), no `DROP COLUMN` on Bronze/ledger. Region/tax columns and the new dims must land in M1's contract-first pass so Phase-5 region activation and Phase-2+ reserved-domain promotion are purely additive.

---

## Risk / watch items (no action this sync; for M1 planning)
- **R1 (low):** §37 grows the M1 canonical migration surface. Mitigation: it is additive-only and contract-gated; sequence the new dims behind their parent canonical domain in the M1 migration order.
- **R2 (low):** `tax_regime` enum must be modeled as an extensible enum (room for future regimes) without becoming a schema change per regime. Mitigation: enum + breakdown table pattern as §36 specifies.
- **R3 (informational):** reserved event types must NOT leak into the doc-07 active catalog in M1 — confirm the M1 tracking-plan excludes `messaging.*`/`marketplace.*`/`capi.*`.

---

## HANDOFF
See below.
