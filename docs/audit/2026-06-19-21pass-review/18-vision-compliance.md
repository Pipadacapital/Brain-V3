# Pass 18: Vision Compliance Audit (vision-compliance)

**Board:** Vision Compliance
**Date:** 2026-06-19
**Auditor:** Principal-level independent review

---

## Board Verdict

The Brain implementation is not quietly becoming a dashboard. The foundational Commerce-OS pillars — deterministic attribution credit ledger with clawback, realized-revenue measurement with dual-date dual-pass recognition, confidence-gated metric engine, append-only Postgres ledgers with RLS FORCE, pixel/collector, identity graph (stream-worker IdentityResolver), and the NLQ/Ask Brain honesty seam — are architecturally sound and hold up against the BRD, doc 08, and doc 09. However, three material gaps exist between the frozen vision and what is running or migrated: (1) the Decision Intelligence layer — the Morning Brief, the ranked recommendation engine with deterministic detectors, the Decision Log, and the signal_snapshot store — has zero implementation beyond a `.gitkeep` placeholder; the `recommendation`, `billing`, and `identity` core modules are empty stubs; (2) the two-pass provisional attribution (doc 08 §7.2 `credit_pass`, BRD §10.5.3, event contracts 07) is not implemented — the attribution credit ledger has no `credit_pass` column and the code writes only finalized-basis credits; and (3) True CM2 / cost_input / order_margin_fact — the primary economic differentiator the billing cap and every margin recommendation depends on — has no migration, no `cost_input` table, no `order_margin_fact` table, and no engine path. These are not theoretical: they are the named product moat ("realized CM2" grounding every recommendation) that is completely absent from executed migrations and TS code.

**Severity summary:** 1 Critical · 2 High · 2 Medium

---

## Finding VC-1

**Title:** Decision Intelligence engine, Morning Brief, and Decision Log are entirely unimplemented — `.gitkeep` stubs; no migrations; no detectors

**Severity:** Critical

**Category:** Vision drift — Brain's primary "Decide" pillar absent

**evidenceRef:**
- `apps/core/src/modules/recommendation/index.ts:7` — `export {}; // TODO: expose the public operations of this bounded context.`
- `apps/core/src/modules/billing/internal/.gitkeep` — module body is a single `.gitkeep` file
- `apps/core/src/modules/recommendation/index.ts:7` — no detector, no signal_snapshot, no prioritization engine
- `db/migrations/` (0001–0036) — grep for `recommendation`, `decision_log`, `signal_snapshot`, `detector_definition` returns 0 rows (verified against all 36 migration files)
- `apps/web/app/(dashboard)/dashboard/dashboard-content.tsx:204-233` — Home / Command Center renders KPI tiles, revenue trend, recent-activity; no "Top 3 Actions", no recommendation contract cards, no Decision Log entry — this is a pure analytics dashboard
- `docs/requirements/09_Brain_Decision_Engine_Architecture.md:23` — "The unit of output is a **decision**, not a chart."
- `docs/requirements/02_Brain_Product_Functional_Specification.md:523` — "**At most three actions**, each rendering the recommendation contract (§8.11) with Approve/Reject/Edit/Ask-why; every response writes to the Decision Log."

**Impact:** The flagship Brain differentiator — ranked CM2-grounded recommendations with confidence, cost-of-inaction, and a closed learning loop — produces nothing. Every analytics surface correctly computes realized revenue and attribution confidence, but the engine that converts those measurements into ranked actions with expected ΔCM2 is non-existent. The Home / Command Center is a metrics dashboard, not a Command Center, despite the label. The Morning Brief cannot send because no detector fires and no `recommendation` table exists. The Decision Log referenced in PFS §8.12 has no migration.

**Root Cause:** Phased delivery plan — doc 05 §13 build order places `core/billing + core/recommendation + core/ai` in Phase-1b/1c. The phases have been partially executed (attribution Phase 5, AI/NLQ Phase 8) but the recommendation/decision engine was not started. The `.gitkeep` pattern is the explicit placeholder mechanism.

**Fix:** Create migrations for `recommendation`, `recommendation_feedback`, `recommendation_outcome`, `recommendation_effectiveness`, and `decision_log` (columns defined in doc 08 §5.5 and §21). Implement the first deterministic detector set (doc 09 Part 5: RTO spike, spend-waste, margin alert, tracking issue) as stream-worker Argo jobs. Wire the Home / Command Center to the recommendation feed instead of the current analytics-only layout. Gate Morning Brief sends on `notification_type='morning_brief'` rows in the existing `send_log` table.

**Priority:** P0

**Tenant Impact:** All tenants — every brand gets analytics without the Decision Intelligence output, which is the core value proposition. The product is currently a measurement platform, not a decision engine.

**Detection:** No alert exists. The Home / Command Center renders without errors because it shows analytics data; the missing recommendation section is invisible in monitoring. Would surface as "Brain never tells me what to do" in qualitative user research or NPS.

---

## Finding VC-2

**Title:** Two-pass provisional attribution (`credit_pass` column) is unimplemented — ledger only writes finalized-basis credits, violating the India attribution fix

**Severity:** High

**Category:** Implementation drift from doc 08 / BRD §10.5.3 / event contracts 07

**evidenceRef:**
- `db/migrations/0032_attribution_credit_ledger.sql:74-113` — the `attribution_credit_ledger` DDL has no `credit_pass` column
- `apps/core/src/modules/attribution/internal/credit-writer.ts:117-131` — `computeAttributionCredit()` call inserts credits with no `credit_pass` discriminator
- `packages/metric-engine/src/attribution-models.ts:1-36` — pure weight computation; no `credit_pass` parameter or provisional/finalized path
- `docs/requirements/08_Brain_Data_Model_and_Database_Schema.md:360` — DDL spec: `credit_pass text CHECK in('provisional','finalized')`
- `docs/requirements/08_Brain_Data_Model_and_Database_Schema.md:376` — concept map: `attribution_credit → attribution_credit_ledger (credit_pass provisional/finalized)`
- `docs/requirements/07_Brain_Event_Contracts.md:384` — event `attribution.credit.provisional.v1` with `"credit_pass": "provisional"`
- `docs/requirements/01_Brain_Business_Requirements_Document.md:325` — "Credit is assigned to realized revenue in two passes — **Provisional** (an expected-realized estimate discounted by RTO likelihood at placement; never feeds billing or high-stakes recommendations) and **Finalized** (restated to net realized at the horizon)."
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:77` — "Realized-time two-pass attribution + proportional clawback … These are the moat — the build must not dilute them under deadline pressure."

**Impact:** The "India fix" — the core attribution differentiator that prevents showing inflated campaign credit before an order is delivered — is not implemented. All credit rows written today are effectively finalized-basis only. There is no provisional credit that gets restated at the horizon. The BRD explicitly says provisional attribution never feeds billing or high-stakes recommendations; without the discriminator the system cannot enforce this gate. This means an RTO'd order will generate a clawback, but there was never a provisional credit to track separately — the two-ledger-pass picture the CFO and COO are supposed to see does not exist.

**Root Cause:** The `credit-writer.ts` and `attribution-models.ts` were built as a Phase-5 slice that implements the credit+clawback mechanics correctly but omits the provisional vs finalized pass column. The data model spec (`credit_pass`) was not honored in the DDL.

**Fix:** Add `credit_pass TEXT NOT NULL CHECK (credit_pass IN ('provisional','finalized'))` to `attribution_credit_ledger` in a new additive migration. Extend `WriteCreditParams` in `credit-writer.ts` to accept a `creditPass: 'provisional' | 'finalized'` field. Emit `credit_pass='provisional'` when writing at order placement, and re-run with `credit_pass='finalized'` at the recognition horizon. Update the `channel_contribution_as_of` function in migration 0032 to filter on `credit_pass='finalized'` for billing and recommendation surfaces.

**Priority:** P1

**Tenant Impact:** All brands. Every brand's attribution ledger currently lacks the provisional/finalized discriminator, so the realized-time CM2 guarantee cannot be enforced.

**Detection:** Would surface during billing reconciliation when finalized GMV is compared against credited GMV and the provisional-pass isolation cannot be demonstrated. Also surfaces in a data audit against event contracts 07.

---

## Finding VC-3

**Title:** True CM2 / cost_input / order_margin_fact entirely absent — no migration, no engine path, no CM2 waterfall surface

**Severity:** High

**Category:** Core measurement gap — the primary economic differentiator that grounds every recommendation

**evidenceRef:**
- `db/migrations/` (0001–0036) — grep for `cost_input`, `order_margin_fact`, `true_cm2`, `COGS`, `contribution_margin` returns 0 rows across all 36 migrations
- `packages/metric-engine/src/` — grep for `order_margin_fact`, `cost_input`, `TrueCM2`, `True CM2` returns 0 rows
- `apps/core/src/modules/measurement/internal/domain/recognition/policies/RecognitionPolicy.ts:30-57` — recognition policy maps event to ledger entry; no cost component, no COGS, no CM1/CM2 waterfall
- `docs/requirements/08_Brain_Data_Model_and_Database_Schema.md:468` — `gold.order_margin_fact PK(brand_id,order_id) -- cost COMPONENTS only (CM1/CM2/CM3/TrueCM2 computed by the ENGINE, never SQL)`
- `docs/requirements/08_Brain_Data_Model_and_Database_Schema.md:216` — `cost_input(brand_id, cost_input_id uuid, scope text CHECK in('global','sku','category','channel','order_type'), ...)`
- `docs/requirements/09_Brain_Decision_Engine_Architecture.md:82` — Finance signal: `CM2 trend, margin compression, contribution-by-channel, cash pressure | realized_revenue_ledger, order_margin_fact | measurement | hourly–daily | cost_confidence (True CM2) | ledger, cost_input`
- `docs/requirements/01_Brain_Business_Requirements_Document.md:314` — "The contribution-margin waterfall: Revenue (net of per-SKU tax) − COGS − other variable costs = CM1; − marketing = CM2; − fixed costs = CM3."
- `apps/core/src/modules/billing/internal/.gitkeep` — billing module is a `.gitkeep` stub; no `gmv_meter_snapshot`, `billing_invoice`, or `entitlement` table exists

**Impact:** The billing cap (`fee = max(min(tier% × realized GMV, cap% × CM2), floor)`) cannot be applied because CM2 is never computed. The `cost_confidence` metric (which exists in the metric registry at `packages/metric-engine/src/registry.ts:344`) reads from `dq_check_result` for freshness/completeness grades — but there is no `cost_input` table to supply the cost data those grades are supposed to certify. Every recommendation that is supposed to be grounded in "expected ΔCM2" has no CM2 to reference. The BRD's central promise ("true profit," "True CM2," "honest CM2") is not computed anywhere.

**Root Cause:** `cost_input`, `order_margin_fact`, and `gold.channel_contribution` are Phase-1b/1c scope per doc 05 build order §13 (step 12: `core/billing`) but have not been built. The metric registry correctly reserves the `cost_confidence` and `effective_confidence` metric IDs and the DQ grader runs — but the cost data inputs those grades are supposed to reflect do not exist yet.

**Fix:** Create an additive migration for `cost_input` (scope, cost_confidence, effective_from/to per doc 08 §5.4). Create a StarRocks DDL for `gold.order_margin_fact` with CM1/CM2/CM3 cost component columns. Implement a cost-input UI surface in `apps/web/settings/costs`. Add a `cost_input_as_of()` read seam in the metric engine and expose `contribution_margin` / `true_cm2` as registered metric IDs. Wire the DQ `cost_confidence` grade to read the new `cost_input` coverage rather than returning 'D' on empty (the current honest-empty path is correct but makes the metric permanently meaningless).

**Priority:** P1

**Tenant Impact:** All brands. Every billing calculation, every recommendation grounded in CM2, and the entire cost-confidence gate all fail to reflect actual margin economics.

**Detection:** The `cost_confidence` metric computes 'D' for every brand (no cost data → honest-empty path returns 'D'), meaning all brands appear "untrusted" on cost permanently. An SRE checking the `dq_check_result` table would see no cost-category DQ rows. The billing module stub is a compile-time signal.

---

## Finding VC-4

**Title:** Ask Brain `computeBinding` dispatches only 2 of 16 registered metric IDs — 14 metrics silently return `figure_kind='none'`

**Severity:** Medium

**Category:** Partial implementation of decision intelligence surface

**evidenceRef:**
- `apps/core/src/modules/ai/internal/ask-brain.ts:184-201` — `computeBinding` switch: only `case 'realized_revenue'` and `case 'provisional_revenue'` are dispatched; all other 14 metric IDs fall through to `default:` returning `{ figure_kind: 'none', money: null, no_data: false }`
- `packages/metric-engine/src/registry.ts:16-33` — full `MetricId` union: `realized_revenue | provisional_revenue | ad_spend | blended_roas | cod_rto_rate | cod_mix | checkout_funnel | order_status_mix | journey_first_touch_mix | journey_stitch_rate | journey_timeline | attribution_credit | attribution_reconciliation_rate | attribution_confidence | cost_confidence | effective_confidence`
- `db/migrations/0036_ai_provenance.sql:47-54` — `metric_id CHECK` constraint lists all 16 IDs, meaning the provenance row is accepted but the answer is not computed
- `apps/web/app/(dashboard)/ask/ask-content.tsx:188-202` — the UI correctly handles `figure_kind='none'` but the user sees no number for 14 of 16 registered metrics

**Impact:** A user asking "What is our blended ROAS?" or "What is our attribution confidence?" gets a valid provenance row (the binding is accepted, the question is logged) but `figure_kind='none'` — no number. The honesty guarantee is preserved (no fabrication) but the product is incomplete for decision-intelligence use: ROAS, attribution confidence, CoD/RTO rate, checkout funnel, journey stitch rate, and all attribution metrics cannot be answered by Ask Brain. The BRD positions Ask Brain as the "NLQ layer over all certified metrics," not just revenue.

**Root Cause:** The `computeBinding` dispatcher was built incrementally — Phase 8 Track B D7 initially wired only the two revenue metrics and deferred the rest with the honest `figure_kind='none'` fallback. The metric registry and provenance table were built completely, but the engine dispatch was not completed.

**Fix:** Add cases in `computeBinding` for each remaining metric ID: `ad_spend` → `computeAdSpend`; `blended_roas` → `computeBlendedRoas`; `cod_rto_rate` → `computeCodRtoRates`; `cod_mix` → `computeCodMix`; `checkout_funnel` → `computeCheckoutFunnel`; `order_status_mix` → `computeOrderStatusMix`; etc. Each function already exists in `packages/metric-engine/src/`. The engine-to-binding wiring is the missing connective tissue.

**Priority:** P2

**Tenant Impact:** All brands. Affects the Ask Brain / NLQ surface only; the analytics dashboard computes all metrics correctly via the BFF routes.

**Detection:** Users who ask "What is our ROAS?" receive a silent `figure_kind='none'` response. No error is logged; the provenance row has `metric_id='blended_roas'` but no computed number. Would show up as a high no-number rate in AI provenance telemetry once that is tracked.

---

## Finding VC-5

**Title:** Customer 360 and cohort-based retention signals have no Gold-tier materialization — `gold.customer_360` table is unreachable

**Severity:** Medium

**Category:** Data-foundation gap — Pillar 3 (Identity) + Pillar 5 (Decision Intelligence) dependency missing

**evidenceRef:**
- `db/starrocks/ddl/silver_template.sql:35` — "PLACEHOLDER — no business marts in Sprint-0 (deferred to M1 per scope ruling 6)." The only StarRocks DDL file in `ddl/` is the template.
- `db/dbt/models/marts/` — only `silver_touchpoint.sql` and `silver_order_state.sql` exist; no `customer_360`, `customer_rfm`, `customer_health`, `cohort_decay`, or `channel_contribution` dbt models
- `apps/core/src/modules/analytics/internal/application/queries/` — no `get-customer-360.ts`, no `get-cohort.ts`, no `get-ltv.ts`, no `get-retention.ts`
- `docs/requirements/08_Brain_Data_Model_and_Database_Schema.md:478` — `gold.customer_360 PK(brand_id,canonical_brain_id) -- derived read model; PII-minimized; rebuildable`
- `docs/requirements/09_Brain_Decision_Engine_Architecture.md:79-80` — Retention signals: `repeat rate, cohort decay, winback-eligible count | customer_360, cohort, ledger | analytics | daily`; Customer signals: `LTV bands, churn indicators | customer_360, health | analytics | daily`
- `apps/core/src/modules/analytics/internal/application/queries/get-cod-rto-rates.ts:40` — the term "cohort" appears only in the context of RTO pincode cohorts (GoKwik AWB), not customer LTV/retention cohorts

**Impact:** Every detector in doc 09 Part 5 that depends on retention signals (launch winback, recover dormant, high-value segment opportunity) cannot fire because `customer_360`, `cohort_decay`, and LTV bands are not materialized. The `identity` module has a functioning stream-worker identity resolution bridge, but the derived read model built on top of it (C360, RFM, segment) is absent. The Brain identity graph resolves brain_ids correctly but they are never aggregated into the customer profile that downstream recommendations consume. The doc 09 retention opportunity catalog is completely gated on this missing mart.

**Root Cause:** `gold.customer_360` is explicitly scoped as a Phase-1 Gold mart (doc 08 §19) built by dbt from the identity graph + ledger + behavior events. The dbt project in `db/dbt/models/` only has the two Silver marts (touchpoint + order_state) and their staging/intermediate models. The Gold tier materialization was deferred.

**Fix:** Add dbt Gold models: `gold/customer_360.sql`, `gold/customer_rfm.sql`, `gold/customer_cohort_decay.sql`. Define StarRocks DDL in `db/starrocks/ddl/` for `gold.customer_360` following the silver_template invariants (brand-first PK + hash distribution + row policy). Expose `getCustomer360`, `getCohortDecay`, and `getLtvBands` query functions under `apps/core/src/modules/analytics/internal/application/queries/`. Wire the identity merge-event hook to trigger customer_360 re-projection (doc 08 §19 materialization rule).

**Priority:** P2

**Tenant Impact:** All brands. The retention/winback/segment opportunity class of recommendations (doc 09 Part 5 retention catalog) cannot produce any signals until C360 exists.

**Detection:** The dbt build produces only 2 mart models; the Gold tier is missing from the dbt manifest. No StarRocks `brain_gold` schema tables are created beyond what the migrations wire via the JDBC catalog. No monitoring alerts on missing mart materialization.
