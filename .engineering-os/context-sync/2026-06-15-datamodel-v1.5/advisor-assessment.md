# Engineering Advisor — Context-Sync Assessment
## doc-03 / doc-08 v1.5 — Foundation-Amendment Impact

**Date:** 2026-06-15
**Assessor:** Engineering Advisor (cto-advisor)
**Source diff:** `.engineering-os/context-sync/2026-06-15-datamodel-v1.5/source-diff.patch`
**Canon files examined:** STACK.md, HLD.md, INVARIANTS.md, METRICS.md, TRIGGER-SURFACES.md, COMPLIANCE.md
**Ruling:** PARTIALLY WARRANTED — two targeted notes to METRICS.md and TRIGGER-SURFACES.md; all other Canon files are NO-CHANGE.

---

## 1. What Changed (tight summary)

The v1.4 (§36) and v1.5 (§37) additions to doc-08, plus a one-line clarification to doc-03 §5 item 5, make four concrete changes: (1) **region / currency / tax-regime is now first-class in the data model** — `reporting_currency_value_minor` (normalized rollup column), `tax_regime` enum (`GST_IN | VAT_AE_5 | VAT_SA_15 | …`), and a `region` column are added to cross-region rollup facts and taxable rows, with COD/RTO explicitly de-India-hardcoded; (2) **`connector_instance` gets three new columns** (`category`, `provider_type`, `region`) that extend the registry without removing anything or adding a new service; (3) **five canonical domains are explicitly RESERVED for Phase 2+** (accounting GL, marketplace fees, messaging-as-touchpoint, reviews, capi_dispatch_log) — modeled but built none in Phase 1; (4) **§37 delivers a field-complete canonical dictionary** proving every field in the Data Layer Storage Spec maps to a Brain canonical field, adding canonical Silver tables (ad_account/campaign/set/creative, product_variant, order_line_item, order_status_history, refund, shipment_tracking_event) that are additive to §6/§11 — no field removed, medallion architecture and the two ledgers unchanged. The Iceberg + StarRocks stack is confirmed and the stale BigQuery reference in the companion spec is superseded.

---

## 2. Canon-Amendment Impact — File-by-File Ruling

### STACK.md — NO-CHANGE

The diff explicitly states "no new services/ledgers/platforms." Iceberg + StarRocks as the analytic stack is already bound (ADR-002). The RegionAdapter seam (ADR-014) already reads "seam is built now, only the India binding is active; Phase 5 = GCC graduation." The new `connector_instance` columns (`category`, `provider_type`, `region`) are additive schema fields on an existing Postgres table — not a new adapter, service, or seam. The 13 locked ADRs are unaffected. The Phase-5 GCC graduation trigger remains correctly in the Deferred section.

**Verdict: NO-CHANGE.**

---

### HLD.md — NO-CHANGE

The bounded-context decomposition (13 modules) is unchanged. The five reserved domains (accounting GL, marketplace, messaging, reviews, capi_dispatch_log) are explicitly modeled-not-built-Phase-1; they do not add a bounded context in Phase 1 and will enter the HLD as a future amendment when built. The data-ownership section's OLTP/OLAP split, the one-way `Iceberg → dbt → StarRocks → Analytics API` rule, and the Silver canonical-domain list are unchanged in their Phase-1 binding; the new tables (product_variant, order_line_item, order_status_history, refund, shipment_tracking_event) are additive Silver tables within the existing `connector` and `measurement` bounded contexts — no new context required. The `region` column on `brand` already exists per §36's own language ("exists"); making it first-class in cross-region rollup facts does not alter the data-ownership model in Phase 1.

**Verdict: NO-CHANGE.**

---

### INVARIANTS.md — NO-CHANGE (with observation)

The critical question is whether "region / currency / tax-regime first-class NOW" breaks or extends any existing invariant.

- **I-S07 (money = minor units + currency_code):** The new `reporting_currency_value_minor` column is fully compliant — it is `BIGINT` minor units paired with the brand's `reporting_currency` code. The `tax_regime` enum is not a monetary column. No float introduced. I-S07 is satisfied, not broken.
- **I-E02 (data-first, replayability-first):** New columns are additive. No existing Bronze/ledger row is mutated. Replayability is unaffected.
- **I-E05 (simplicity-first / Single-Primitive Rule):** No new service, ledger, or deployable. Additive schema columns and reserved domain stubs. No violation.
- **I-S01 (brand isolation):** `region` and `tax_regime` are per-row brand-scoped data, not isolation mechanisms. No change to RLS or tenant context. No violation.

The "COD/RTO are region attributes, not India-only" clarification is a conceptual de-hardcoding, not a code or schema invariant change — the ledger logic already handles them generically per the existing True CM2 invariant in METRICS.md.

**Observation (not an amendment):** the doc explicitly states this is "a model invariant built now (cheap; expensive to retrofit)." This is a development discipline note, not an addition to the binding INVARIANTS table — the existing invariants already cover the money and replayability properties that make this safe. No new invariant row is warranted; the existing I-S07 is sufficient.

**Verdict: NO-CHANGE.**

---

### METRICS.md — AMEND (one note, minimal)

The METRICS.md preamble reads: `Currencies: INR (primary) / AED / SAR. Money = integer minor units (*_minor BIGINT) + currency_code CHAR(3); never floats.`

With `reporting_currency_value_minor` now a first-class canonical column on cross-region rollup facts, the metric registry's money rule should explicitly acknowledge FX normalization to reporting currency as a sanctioned pattern — distinct from blended-rate FX (which is prohibited). Without this note, a future implementer might incorrectly treat `reporting_currency_value_minor` as a violation of the "FX conversion uses the fx_rate row pinned to the ledger row's economic_effective_at date" rule (METRICS.md Rules, line 6 of Rules section).

**Recommended exact edit to METRICS.md — append to the "Money = integer minor units + currency_code" rule bullet:**

> FX normalization to the brand's `reporting_currency` (via the `fx_rate` row pinned to the row's `economic_effective_at`) produces `reporting_currency_value_minor BIGINT` for cross-region rollup facts. This is the approved multi-currency aggregation pattern (doc 08 §36 Delta 1); blended or period-average FX rates remain prohibited for any ledger computation.

**Verdict: AMEND — one sentence appended to the money rule.**

---

### TRIGGER-SURFACES.md — AMEND (one note, minimal)

The Compliance / regulatory boundary surface row currently reads: `Regime = DPDP (India) now; PDPL/GDPR seams reserved.` The RegionAdapter row in STACK.md already documents that the seam is built in Phase 1 with GCC as Phase 5. However, TRIGGER-SURFACES.md does not currently note that the `tax_regime` enum and `region` column are now live model fields — a schema change touching either is a high-stakes surface.

**Recommended exact edit to TRIGGER-SURFACES.md — extend the Compliance / regulatory boundary row's "Threshold / notes" cell:**

> Append to the existing cell: `The tax_regime enum (GST_IN | VAT_AE_5 | VAT_SA_15 | …) and region column are live model fields from Phase 1 (doc 08 §36 Delta 1); any change to the enum values or region-routing logic is a compliance surface change requiring this lane.`

**Verdict: AMEND — one sentence added to the Compliance surface row.**

---

### COMPLIANCE.md — NO-CHANGE

COMPLIANCE.md already contains the GCC activation gate (`organization.region IN/GCC`), data-residency controls for both India and GCC, and tax obligations for GST/VAT/ZATCA on Brain's own fee. The `tax_regime` enum addition is a data-model field on brand/transaction rows — it does not alter the compliance regime itself, only makes the model capable of recording which regime applies. The GCC go-to-market remaining Phase 5 means no new compliance obligation is triggered now. The existing open decisions (UAE/KSA PDPL breach windows, GCC AWS region selection) are unchanged.

**Verdict: NO-CHANGE.**

---

## 3. Net Judgment

**Foundation amendment: PARTIALLY WARRANTED — two targeted Canon notes, not a structural redesign.**

The five reserved domains and the field-complete §37 dictionary are purely additive documentation — absorb as context, no Canon change. The `connector_instance` registry extensions are schema additions within an existing table — absorb as context.

The one item that warrants a small Canon touch is the **`reporting_currency_value_minor` pattern** (§36 Delta 1): it is a new first-class canonical column type used in metric rollups, and the METRICS.md money rule should explicitly sanction the approved FX-normalization pattern to prevent future misapplication. The **`tax_regime` enum** warrants a single sentence in TRIGGER-SURFACES.md to ensure future schema changes to it are correctly routed to the high-stakes lane.

Both recommended edits are one sentence each. Neither changes an invariant, locks a new seam, adds a service, or alters cost routing. They close a documentation gap only.

**Reserved/Phase-2+ items** (accounting GL, marketplace fees, messaging, reviews, capi_dispatch_log) are context — absorbed into the journal. They enter the Canon only when built, via a normal requirement intake.

---

## Per-File Amendment Table

| Canon file | Ruling | Recommended edit (if AMEND) |
|---|---|---|
| STACK.md | NO-CHANGE | — |
| HLD.md | NO-CHANGE | — |
| INVARIANTS.md | NO-CHANGE | — (existing I-S07 covers money; no new invariant row needed) |
| METRICS.md | AMEND | Append to the "Money = integer minor units + currency_code" rule: *FX normalization to the brand's `reporting_currency` (via the `fx_rate` row pinned to `economic_effective_at`) produces `reporting_currency_value_minor BIGINT` for cross-region rollup facts. This is the approved multi-currency aggregation pattern (doc 08 §36 Delta 1); blended or period-average FX rates remain prohibited for any ledger computation.* |
| TRIGGER-SURFACES.md | AMEND | Append to the Compliance / regulatory boundary row's notes cell: *The tax_regime enum (GST_IN \| VAT_AE_5 \| VAT_SA_15 \| …) and region column are live model fields from Phase 1 (doc 08 §36 Delta 1); any change to the enum values or region-routing logic is a compliance surface change requiring this lane.* |
| COMPLIANCE.md | NO-CHANGE | — |

---

## Absorb-as-Context (journal only — no Canon change)

- §37 field-complete canonical dictionary (Silver tables: ad_account, ad_campaign, ad_set, ad_creative, product_variant, order_line_item, order_status_history, refund, shipment_tracking_event) — additive to §6/§11, Phase-1 build scope unchanged.
- Five reserved domains (accounting GL, marketplace fees, messaging-as-touchpoint, reviews, capi_dispatch_log) — modeled, built none in Phase 1. Enter Canon when built.
- `connector_instance` extension columns (`category`, `provider_type`, `region`) — additive schema fields, no new service.
- COD/RTO de-India-hardcoding — conceptual clarification, existing ledger/True-CM2 logic already handles them generically.
- Iceberg + StarRocks confirmation over stale BigQuery ref — already bound in STACK.md ADR-002; no change.
- GCC go-to-market confirmed Phase 5 — already in STACK.md Deferred section.

---

*This assessment is a RECOMMENDATION. The Stakeholder must approve any Canon file edit via a Foundation amendment before the Engineering Advisor or any other agent edits METRICS.md or TRIGGER-SURFACES.md.*
