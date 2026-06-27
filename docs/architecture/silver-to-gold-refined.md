# Silver → Gold: Refined Requirement + Build Plan

> Recon date: 2026-06-28. Method: 4 read-only recon agents mapped the Silver→Gold spec
> (Phase 1 Identity, Customer360 Contract, Phase 2 BI, Gold/Gateway/orchestration) to the
> existing Brain V4 code. Key paths re-grepped before writing. **Repo-wins / extend-not-rebuild.**

---

## 1. Honest verdict

**~80% of the Silver→Gold spec is already built and live.** The deterministic spine is complete
end-to-end: Silver canonical entities, deterministic identity resolution (union-find on strong
identifiers), Neo4j graph SoR, the Customer360 contract (formal Zod schema + producers + consumers),
30 Gold marts in a registry-first catalog, 5 attribution models (first/last/linear/position/data-driven
Markov), RFM + deterministic health, executive KPIs, and the Redis→Trino→Fastify serving seam with a
brand-scoped cache-invalidation loop. The medallion refreshes via `tools/dev/v4-refresh-loop.sh`.

**The headline gaps are four kinds, in priority order:** (1) **cheap formalizations** — the Phase-1→Phase-2
boundary, the Analytics Gateway, and the per-phase replay seam all *work* but are implicit in code
convention rather than named/contracted; (2) **real but bounded new Gold/Silver builds** — full
cross-channel lifecycle journey (support/CRM/repeat/churn signals), behavioral/lifecycle **segments**
(only 4 static value-tiers exist today), `time_decay` attribution, and the affinity feature vectors
(brand/category/device/discount) for recommendations; (3) **Customer360 enrichment** — preferred
channel, category preference, acquisition source, health/churn/lifecycle-stage are absent from
`gold_customer_360`; (4) **one BIG deferred effort that must stay gated** — all probabilistic/ML/household/
cross-device matchers are *registered-disabled and fail-closed* (`NotImplementedYet`), plus the two
`predictive_*` Gold marts. These are correctly NOT faked and should remain a separate, ground-truth-gated
project. **Nothing in the core deterministic path needs a rebuild.**

---

## 2. Coverage table

### Phase 1 — Identity Intelligence (Silver → Customer360)

| Spec step | Status | Exact file(s) | Precise gap |
|---|---|---|---|
| 1. Read canonical Silver (incremental) | BUILT | `db/iceberg/spark/silver/silver_journey.py`, `silver_customer.py`, `silver_customer_identity.py`, `silver_identity_alias.py` | — (Spark MERGE incremental) |
| 2. Identifier extraction + per-id confidence | BUILT | `apps/stream-worker/src/domain/identity/extract-identifiers.ts`; `packages/identity-core/src/index.ts` (`normalizePhone`, `hashIdentifier`) | — (email/phone/customer_id/device/anon/pre-hashed; tier+confidence) |
| 3. Identity lookup (existing vs new) | BUILT | `apps/stream-worker/src/infrastructure/neo4j/Neo4jIdentityRepository.ts` (`readState()`) | Hybrid Neo4j SoR + PG ledger (ADR-0004) by design |
| 4. Deterministic matching | BUILT | `…/identity/matchers/DeterministicUnionFindMatcher.ts` | Strong keys only; exact salted-hash overlap → canonical lowest-UUID |
| 5. Probabilistic / ML / household / cross-device matching | **PARTIAL (registered-disabled, fails-closed)** | `…/identity/matchers/DisabledMatchers.ts`; `MatcherRegistry.ts`; `MatcherRegistry.test.ts`; `packages/contracts/src/identity/matcher.ts` | All 4 throw `NotImplementedYet` (never faked). Algorithms unbuilt. household/cross-device not yet in `IDENTITY_MATCHER_REGISTRY` contract descriptor. **BIG deferred — see §3(c).** |
| 6. Confidence engine → merge/new/review/split | BUILT | `…/identity/confidence/ConfidenceEngine.ts`; `…/decisions/DecisionEngine.ts`; `…/identity/IdentityResolver.ts` | Integer 0–100, never float; never-merge clamp for medium tier; deterministic `merge_id` (D-4); cycle/phone-guard → review |
| 7. Neo4j identity graph update | BUILT | `Neo4jIdentityRepository.writeOutcome()`; `apps/stream-worker/src/jobs/identity-export/run.ts` | Idempotent MERGE; IDENTIFIES/ALIAS_OF/MergeEvent/SharedUtility/MergeReview |
| 8. Customer Journey (full lifecycle) | **PARTIAL** | `silver_journey.py` (anon spine); `gold_journey.py` (rollup); `apps/core/.../queries/get-journey-timeline.ts` | MISSING: support-ticket / CRM-interaction touches, repeat-purchase signal, churn/dormancy signal; journey is anon-grain only (not forward-stitched to brain_id) |
| 9. Customer360 builder | **PARTIAL** | `db/iceberg/spark/gold/gold_customer_360.py`; `apps/core/.../queries/get-customer-360.ts` | Has identity+LTV+order-lifecycle. MISSING: preferred device/channel, product categories, acquisition source, last-activity-all-channels, health score, churn risk, business lifecycle-stage |

### Customer360 Contract (boundary)

| Requirement | Status | Exact file(s) | Precise gap |
|---|---|---|---|
| (a) Formal Customer360 contract type/schema | BUILT | `packages/contracts/src/api/identity.api.v1.ts` (`Customer360{Profile,Identifier,Merge,Schema}`); exported `packages/contracts/src/index.ts` | Zod SoT; hash-prefix-only PII (I-S02) |
| (a) Producers / consumers bound to schema | BUILT | producer `apps/core/.../get-customer-360.ts`; consumer-side `packages/metric-engine/src/customer-360.ts`; MCP `customer360_lookup` (`packages/ai-gateway-client/src/mcp-tools.ts`); web `apps/web/app/(dashboard)/identity/customer-360/…` | — |
| (b) Identity-side vs BI-side separation | BUILT | schema split + MCP split (`identity_explainability_lookup` vs `customer360_lookup`, `mcp-dispatch.ts`); module isolation (no cross-import); BI never invokes resolver/matcher | ESLint boundary for `@brain/metric-engine` is structurally inert (9 pre-existing violations) — cosmetic, no identity-matching leak |
| (c) Formal Phase-1→Phase-2 handoff exchange | **MISSING (implicit)** | recompute loop: `apps/stream-worker/src/domain/identity/ScopedRecompute.ts` + `IdentityChangeRecomputeConsumer.ts` + `packages/contracts/src/events/cache.invalidate.v1.ts` | brain_id is the only thing crossing; no formal handoff message, no Phase-2-complete receipt, no `gold_customer_360` entry in `GoldDataProductSchema` |

### Phase 2 — Business Intelligence (Gold)

| Spec area | Status | Exact file(s) | Precise gap |
|---|---|---|---|
| Customer360 consumption seam | BUILT | `packages/metric-engine/src/customer-360.ts` (reads `mv_gold_customer_360`) | — |
| Attribution: first/last/linear/position_based | BUILT | `packages/metric-engine/src/attribution-models.ts` (`PER_JOURNEY_MODEL_IDS`, default `position_based`) | — |
| Attribution: data_driven (Markov) | BUILT | `packages/metric-engine/src/attribution-datadriven.ts` (`computeMarkovChannelWeights`) | — |
| Attribution: **time_decay** | **MISSING** | — (grep-confirmed absent in `packages/metric-engine/src/`) | spec mentions; zero implementation, not in model id list |
| Attribution: **custom/pluggable model** | **MISSING** | — | fixed 5-model set; no pluggable interface |
| Attribution credit ledger / paths / marketing | BUILT | `gold_attribution_credit.py`, `gold_attribution_paths.py`, `gold_marketing_attribution.py`; closed-sum `apportionMinor()` | clawback rows folded but sparse under current 0-credit state (documented follow-up) |
| Segmentation (value tiers) | BUILT | `gold_customer_segments.py` (high/mid/low/no_realized_value, deterministic CASE) | — |
| Segmentation (**behavioral/lifecycle**: VIP, loyal, first-time, at-risk, churned, cart-abandoner, window-shopper as named segments) | **MISSING / PARTIAL** | at_risk/churned exist only as *attributes* in `gold_customer_health.py`; cohorts in `gold_cohorts.py` | no behavioral/lifecycle **segment partitions**; only 4 static value-tiers |
| Customer intelligence: RFM, LTV, frequency, health score/band, recency | BUILT | `gold_customer_scores.py`, `gold_customer_health.py`, `gold_customer_360.py`, `gold_recommendation_features.py` | — |
| Churn probability / retention / repeat-rate | **MISSING** | — | deterministic health only; no retention/repeat-rate mart |
| **predictive_ltv / predictive_health** | **DISABLED (fails-closed)** | `db/iceberg/spark/gold/_gold_registry.py:506-538` (`enabled=False`, `module=None`, `NotImplementedYet`) | needs ML model + registered version. **BIG deferred — §3(c).** |
| Marketing: ROAS (campaign/channel/blended), CAC, campaign perf | BUILT | `attribution-campaign-roas.ts`, `attribution-channel-roas.ts`, `blended-roas.ts`, `cac.ts`, `gold_cac.py`, `gold_campaign_performance.py` | — |
| Marketing: creative / audience performance | **MISSING** | — | no creative_id / audience_id dimension in silver_marketing_spend |
| Marketing: conversion-rate mart | PARTIAL | `gold_funnel.py`, `gold_abandoned_cart.py` | folded into funnel counts; no explicit rate mart |
| Executive KPIs (additive components) | BUILT | `gold_executive_metrics.py`, `gold_settlement_summary.py`, `gold_contribution_margin.py` | derived ratios (AOV/refund-rate/repeat-rate) computed at read per ADR-004 (by design) |
| Executive KPIs: region/geo revenue | **MISSING** | — | no geo dimension in schema |
| Recommendation features: RFM + top_channel + distinct_products + tenure | BUILT | `gold_recommendation_features.py`, `gold_ai_features.py`; serving `recommendation-features.ts` | — |
| Recommendation features: **affinity vectors** (brand, category, price, discount-sensitivity, device) | **MISSING** | — | none in schema or build |
| Gold catalog (registry-first) | BUILT | `db/iceberg/spark/gold/_gold_registry.py` (30 `GoldMartSpec`); TS mirror `packages/contracts/src/api/intelligence.api.v1.ts` (`GoldDataProductSchema`) | flat registry; no `phase` grouping field |

### Gateway / Orchestration

| Requirement | Status | Exact file(s) | Precise gap |
|---|---|---|---|
| Serving gateway Redis→Trino→Fastify | PARTIAL (works, unnamed) | `packages/metric-engine/src/serving-cache.ts`, `analytics-cache.ts`; `apps/stream-worker/.../consumers/AnalyticsCacheInvalidateConsumer.ts`; `db/trino/views/*.sql` (35 views, 25 `mv_gold_*`); `apps/core/.../frontend-api/internal/bff.routes.ts` | functional distributed seam; no named "Analytics Gateway" ADR/component |
| Gold refresh orchestration (Silver→Gold) | PARTIAL (flat 6-step) | `tools/dev/v4-refresh-loop.sh` (`run_once()`); Spark `run-*.sh`; stream jobs `identity-export/run.ts`, `journey-stitch-from-identity.ts` | runs full sequence every cycle; no Phase-1/Phase-2 labels or gating |
| Per-phase replay / incrementality | PARTIAL | every step idempotent (Spark MERGE / `CREATE OR REPLACE VIEW` / idempotent stream jobs) | per-STEP incremental but no per-PHASE replay flag |
| Named Gold-data-product catalog | BUILT | `_gold_registry.py` + TS mirror | no `phase: 'identity'|'bi'` annotation |

---

## 3. Genuine gaps (prioritized, scoped) — built items excluded

### (a) Cheap formalizations — low effort, high architectural clarity

| # | Gap | Extend/New | Files it touches |
|---|---|---|---|
| F1 | **Customer360 phase-handoff contract** — formalize the implicit brain_id bridge as a versioned contract + add `gold_customer_360` to `GoldDataProductSchema`; optional Phase-2 completion receipt event (`intelligence.customer360.recomputed.v1`) | New (small) | `packages/contracts/src/api/intelligence.api.v1.ts` (registry entry), new `packages/contracts/src/events/intelligence.customer360.recomputed.v1.ts`; emit in `ScopedRecompute.ts`/`IdentityChangeRecomputeConsumer.ts` |
| F2 | **2-phase orchestration labels + per-phase replay** — wrap steps 0–4 (identity) and 5–6 (BI) in a `run_phase()` and add `--phase=1\|2\|both` | Extend | `tools/dev/v4-refresh-loop.sh` |
| F3 | **Phase annotation in Gold registry** — add `phase: 'identity'|'bi'` to `GoldMartSpec` + TS mirror; partition `enabled_marts()` by phase | Extend | `db/iceberg/spark/gold/_gold_registry.py`, `packages/contracts/src/api/intelligence.api.v1.ts` |
| F4 | **Analytics-Gateway ADR** — name the Redis→Trino→Fastify seam as a first-class component (doc only) | New (doc) | `docs/architecture/` (new ADR); no code change |
| F5 | **Contract-sync for disabled matchers** — add household-clustering + cross-device-graph descriptors to `IDENTITY_MATCHER_REGISTRY` (still `disabled`) so contract mirrors `MatcherRegistry` | Extend | `packages/contracts/src/identity/matcher.ts` |

### (b) Real new builds — bounded, deterministic, no ML

| # | Gap | Extend/New | Files it touches |
|---|---|---|---|
| B1 | **Behavioral / lifecycle segments** — promote at_risk/churned/loyal/first-time/VIP/cart-abandoner from health *attributes* to named **segment partitions** (deterministic, recency/frequency-based) | Extend (new mart alongside) | new `db/iceberg/spark/gold/gold_customer_segments_behavioral.py` (or extend `gold_customer_segments.py`); `_gold_registry.py`; new Trino view; serving in metric-engine |
| B2 | **Customer360 enrichment** — add preferred channel, top product category, acquisition source (utm), last-activity-all-channels, deterministic churn-risk flag + business lifecycle-stage | Extend | `db/iceberg/spark/gold/gold_customer_360.py` (join `silver_journey`/`silver_touchpoint` first-touch); `_gold_registry.py`; `identity.api.v1.ts` (if surfaced) |
| B3 | **Full cross-channel lifecycle journey** — new `silver_support_ticket` / `silver_crm_interaction` Silver tables + support/CRM/repeat/churn touches; forward-stitch journey to brain_id | New | new `db/iceberg/spark/silver/silver_support_ticket.py`, `silver_crm_interaction.py`; extend `silver_journey.py` / `gold_journey.py`; requires a support/CRM connector source first |
| B4 | **time_decay attribution model** — exponential half-life decay; add to model id list + registry | Extend | `packages/metric-engine/src/attribution-models.ts`; `intelligence.api.v1.ts` `ATTRIBUTION_MODEL_REGISTRY` |
| B5 | **Recommendation affinity vectors** — brand/category/price/discount-sensitivity/device features (deterministic aggregates from `silver_touchpoint`/order lines) | Extend | `db/iceberg/spark/gold/gold_recommendation_features.py`; `_gold_registry.py`; `recommendation-features.ts` |
| B6 | **Creative / audience marketing performance** — requires creative_id/audience_id in `silver_marketing_spend` first | New | `silver_marketing_spend` schema; `gold_campaign_performance.py`; connector enrichment |
| B7 | **Retention / repeat-rate mart** — deterministic repeat-purchase & retention curves | New | new `db/iceberg/spark/gold/gold_retention.py`; `_gold_registry.py`; Trino view; serving |
| B8 | **Region/geo revenue** — needs geo dimension in spine first | New (blocked on schema) | spine geo column; `gold_executive_metrics.py` / `gold_revenue_analytics.py` |

### (c) BIG deferred — MUST stay a separate, ground-truth-gated project (do NOT fake)

| # | Item | State today | What it genuinely needs |
|---|---|---|---|
| D1 | **Probabilistic matcher (Fellegi–Sunter)** | registered-disabled, throws `NotImplementedYet` (`DisabledMatchers.ts`) | weighted record-linkage, EM-fitted weights from ground-truth merges, Bayes threshold tuning, per-tenant calibration |
| D2 | **ML-embedding matcher** | registered-disabled | trained embedding model on identity features + inference + similarity threshold |
| D3 | **Household-clustering matcher** | registered-disabled | fuzzy graph walk over weak edges (shared address / card tail); explicitly out of v1-deterministic scope |
| D4 | **Cross-device-graph matcher** | registered-disabled | probabilistic device co-occurrence / session-similarity link prediction |
| D5 | **predictive_ltv Gold mart** | `enabled=False`, `module=None` (`_gold_registry.py`) | ML model on silver_customer + gold_revenue_ledger + registered model version |
| D6 | **predictive_health / churn-probability mart** | `enabled=False`, `module=None` | ML on behavioral signals + registered model |

**Recommendation:** keep D1–D6 behind their current fail-closed registry gates. The codebase already
enforces "never fake a verdict" (`MatcherRegistry.test.ts` proves disabled `match()` throws). Promoting
any of these requires a labeled ground-truth corpus, model registry/versioning, and per-tenant threshold
calibration — a standalone ML project with its own evaluation harness, NOT an incremental Gold slice.
Deterministic-first (D-5) holds: do not enable until a measured precision/recall gate is met.

---

## 4. Recommended build-wave ordering

**Wave 0 — Formalizations (parallelizable, ~1 sprint).** F1, F2, F3, F4, F5 are independent and touch
disjoint files (contracts / refresh-loop / registry / docs). Run all in parallel. These convert
"implicit-in-code" into "named + contracted" with near-zero risk and unblock clean phase reasoning.

**Wave 1 — Deterministic Gold extensions (mostly parallelizable).** B1 (behavioral segments), B2
(Customer360 enrichment), B4 (time_decay), B5 (affinity vectors), B7 (retention) are all deterministic,
read existing Silver, and touch mostly-disjoint marts → parallelizable. **Sequencing constraint:** B2 and
B1 both read first-touch/journey signals — land the shared `silver_journey`→`silver_customer` first-touch
join once (in B2) and let B1 reuse it. B4 is fully standalone (metric-engine only).

**Wave 2 — Source-blocked builds (serialized behind connectors).** B3 (support/CRM journey), B6
(creative/audience), B8 (geo revenue) each need a NEW upstream source (support/CRM connector, ad-creative
fields, geo dimension) before the mart is meaningful. Do connector/schema work first, then the mart.
Do not start until the source lands — otherwise you ship empty marts (violates "no empty charts").

**Wave 3 — Gated ML project (separate track, do not interleave).** D1–D6. Stand up a labeled-merge
ground-truth set + model registry + evaluation harness as its own project. Promote one matcher / one
predictive mart at a time, each behind a precision/recall gate. Runs independently of Waves 0–2.

**Parallelism summary:** Wave 0 fully parallel; Wave 1 ~4-way parallel (B2 before/with B1); Wave 2
serialized per-source; Wave 3 isolated track. Critical path to "spec-complete deterministic" = Wave 0 +
Wave 1 (Wave 2 gated on external sources, Wave 3 intentionally deferred).
