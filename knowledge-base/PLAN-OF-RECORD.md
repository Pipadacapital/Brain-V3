# Brain — AI-Native Commerce OS: Plan of Record

This document is the **single plan-of-record** for upgrading Brain from its current high-integrity analytics pipeline into an AI-native Commerce Operating System. All previous partial plans are superseded. Waves A–D are implemented end-to-end; Waves E–I get contracts, interfaces, and scaffolding only.

---

## PART 0 — EXECUTION PROTOCOL (BINDING)

### 0.1 What you are building
Brain is an AI-native Commerce Operating System for DTC/ecommerce brands in India and the GCC. This program evolves the existing high-integrity analytics pipeline into a full platform across nine architectural domains (Waves A–I). Waves A–D are implemented end-to-end; Waves E–I receive **contracts, interfaces, and scaffolding**.

**Waves E–I business logic is OUT OF SCOPE.** No model training code, LLM agent orchestration logic, recommendation scoring, decision policies, or external action executors. Scaffold-only means: package skeletons, port interfaces, Iceberg table DDL, Avro/Apicurio schemas, ADR stubs, and failing-by-design `NotImplementedError`-style adapters behind feature flags set to OFF.

### 0.2 Execution order and gates
Execute waves strictly in order: **A → B → C → D → (E–I scaffolding)**. Each wave ends with a GATE. A gate is passed only when:
1. All acceptance criteria in the wave's "Acceptance Criteria" section pass with evidence written to `knowledge-base/gates/GATE-<wave>.md`.
2. `pnpm turbo build lint test` passes across the monorepo with zero new warnings.
3. No invariant in §1 has been weakened. Run the invariant checklist (§1.9) and record results in the gate file.
4. A rollback procedure for the wave is documented and the feature flags controlling the wave's new paths are verified to disable it cleanly.

Do not begin the next wave until the gate file exists and all items are checked. If a gate cannot be passed, write `knowledge-base/gates/GATE-<wave>-BLOCKED.md` explaining exactly which criterion failed and why, then halt and report.

### 0.3 First action: Foundation Synthesis (Phase 0)
Before writing any code:
1. Read the monorepo structure (`pnpm-workspace.yaml`, `turbo.json`, all `packages/*/package.json`, `apps/*`).
2. Locate and read: the Identity Bridge service, the Universal Pixel package, connector packages (Shopify, WooCommerce, Shopflo, GoKwik), the Silver/Gold Spark jobs, `silver_identity_map`, `journey_events`, `gold_revenue_ledger`, `gold_customer_360`, the Analytics Gateway (Fastify), Apicurio schema definitions, Neo4j identity graph modules, Redis usage, and the LiteLLM configuration.
3. Produce `knowledge-base/00-foundation-synthesis.md`: current-state map of every component this program touches, including actual table schemas as they exist today (query Iceberg metadata; do not trust documentation over code).
4. Produce `knowledge-base/01-delta-plan.md`: for each requirement in Waves A–D, mark it DONE / PARTIAL / MISSING in the current codebase, with file paths as evidence. Requirements marked DONE are verified with a test, not reimplemented.

**Ground-truth hierarchy (binding):** (1) code as it exists in the repo, (2) live Iceberg/Apicurio/Neo4j metadata, (3) test suites, (4) in-repo docs and this blueprint's claims — lowest priority, assumed stale until confirmed by 1–3. Where any document contradicts the code, the code wins and the discrepancy is logged in the delta plan.

### 0.4 Amendment protocol
If a specification here is impossible, contradictory, or would violate an invariant:
1. Do NOT improvise a workaround.
2. Write `knowledge-base/amendments/AMD-<n>-<slug>.md`: the conflicting spec text, the ground truth discovered, exactly two candidate resolutions with trade-offs, and a recommendation.
3. Implement the recommendation ONLY if it is invariant-preserving and additive; otherwise halt that work item and continue with independent items.

### 0.5 Non-negotiable engineering rules
- **Additive and non-breaking.** No existing table is dropped, renamed, or has columns removed. New behavior ships behind feature flags (per-brand; if no flag system exists, create `packages/platform-flags` with Redis-backed per-tenant flags, default OFF).
- **Hexagonal everywhere.** New logic in domain packages with ports; Kafka/Neo4j/Redis/Iceberg/Trino access only via adapters. No infrastructure imports inside domain code. Enforce with an ESLint boundary rule added in Wave A.
- **Every table is multi-tenant.** `brand_id` first column of every new table, in every primary key, every Kafka message key, every Neo4j node, every Redis key (`{brand_id}:...`), every API path or auth scope. Missing `brand_id` = gate-failing defect.
- **Traceability.** Every new module carries `// SPEC: <wave>.<section>`. Gate files list spec-section → file-path mappings.
- **Tests are specification.** Each testable requirement gets at least one test named after the spec section.

---

## PART 1 — GLOBAL CONTRACT (INVARIANTS)

### 1.1 Stack lock
Fastify, Kafka KRaft, Spark, Iceberg medallion, Trino (ALL lakehouse query — batch AND interactive; no separate serving engine; see §1.11), Redis, Neo4j, Apicurio, LiteLLM, MCP, pnpm/Turborepo/TypeScript. **No new datastore, queue, or framework.** Splink (Python) is the one sanctioned addition, isolated in a Python Spark job for Wave A.3.

### 1.2 Money
Integer minor units + explicit ISO-4217 `currency` column everywhere. GCC 3-decimal currencies (BHD, KWD, OMR) use 3-decimal minor units. No floats for money, including intermediate Spark computations. Ratios may be decimals derived from integer inputs.

### 1.3 Deletion & privacy (DPDP India + GCC PDPLs)
- Crypto-shredding: per-subject envelope encryption; deletion = key destruction across bronze/silver/gold + Neo4j/Redis/cached results. Every new subject-linked table documents key-envelope columns and registers in `knowledge-base/privacy/shred-manifest.md`.
- PII at the edge: raw email/phone never leaves the browser/connector boundary unhashed except existing lawful flows. Pixel hashes client-side (SHA-256, normalized per §A.1.3). Connectors hash in-process before Kafka.
- Consent gating: pixel identity capture only when the brand's consent config permits (§A.1.2). Default OFF per brand.
- Data residency: in-region processing/storage only. No new cross-region replication.

### 1.4 Attribution truth rule
Revenue attribution, CAC, ROAS, and the ledger consume **deterministic identity links only**. Probabilistic links (A.3) are physically segregated (separate table, `identity_basis='probabilistic'`), structurally excluded from revenue paths by construction, with a data test asserting zero probabilistic-basis rows in attribution outputs. Probabilistic-derived UI surfaces carry `estimated: true`.

### 1.5 Bi-temporality
`silver_identity_map` is bi-temporal (valid-time + system-time). Consumers state their view: `current` for operational paths; `as-of(T_valid, T_system)` for replay/audit. No consumer reads the raw bi-temporal table directly — only via `identity_current_v` / `identity_asof(...)` (§A.2.2).

### 1.6 Event-sourced, versioned, reproducible
Silver/Gold derivations are deterministic functions of upstream data; reruns yield identical outputs (MERGE on natural keys, never blind append for derived tables). `journey_events` versioning (re-version on identity merge) preserved and extended, never bypassed.

### 1.7 Schema governance
Every Kafka topic payload has an Apicurio-registered Avro schema, compatibility BACKWARD. New fields optional with defaults. New topics follow the existing naming convention (discover in Phase 0, record, use consistently).

### 1.8 SLA topology
Strict-SLA path = Collector API + event backbone (sub-5s, HA). Everything in this program is lean-path except Wave A.4 streaming identity upsert + touchpoint cache, which ride the existing stream-worker and must add ≤ 50ms p99 (benchmark-enforced).

### 1.9 Invariant checklist (every gate; PASS/FAIL with evidence)
1. No new datastore/framework. 2. New monetary columns integer minor-units + currency. 3. New subject-linked tables in shred manifest. 4. No unhashed PII in any new topic/log/table. 5. Zero probabilistic-basis rows in attribution/revenue outputs (data test). 6. All new tables/keys carry `brand_id`; cross-tenant isolation test passes. 7. New topics schema-registered, BACKWARD compatible. 8. Flags OFF reproduce pre-wave behavior byte-for-byte on the golden dataset (§1.10). 9. ESLint hexagonal boundary rule passes. 10. Bi-temporal access only via sanctioned views.

### 1.10 Golden dataset
In Wave A, before any behavior change: `packages/testing-golden` — seeded deterministic generator, ~50k events, 3 fictional brands, covering anonymous-only sessions, anon→known mid-session, multi-device users, shared-device families, COD orders, refunds, GCC 3-decimal currency orders, consent-off traffic. Snapshot today's pipeline outputs over it. Every wave's flags-OFF regression compares against this snapshot.

### 1.11 Interactive serving without a dedicated serving engine
All interactive reads are Trino-on-Iceberg with this mandatory pattern:
1. **Pre-aggregation tables** (Spark-maintained Iceberg) for every metric×grain flagged `interactive: true` in the metric registry (§D.2). Raw-entity scans only for ad-hoc/long-tail (p95 < 10s, `slow: true` flag).
2. **Redis result caching** at the gateway: key `{brand_id}:q:{normalized_query_hash}`, TTL per freshness class (`realtime` = no cache, `hourly` = 15 min, `daily` = 4 h). Cache entries crypto-shred-invalidated by brand.
3. **Concurrency protection:** per-brand Trino interactive query gate (max concurrent, queue beyond).
4. If an `interactive` metric cannot meet budget through pre-aggs + cache → AMENDMENT; resolution is a better pre-agg or relaxed budget, never a new datastore.

---

## PART 2 — WAVE A: IDENTITY DOMAIN MODERNISATION

**Goal:** rich, real-time, multi-signal, per-brand-configurable identity resolution — mParticle-class rigor (ordered identity priority, explicit strategies, merge auditing), warehouse-native, deterministic-first.

**Exit:** deterministic identification rate > 40% of purchasers on golden + one live brand; signals from pixel + all four connectors; bi-temporal map consumed only via sanctioned views; probabilistic layer live but quarantined.

### A.1 Rich Identity Signal Capture

#### A.1.1 Universal Pixel — identify events
- New `identify` event (Apicurio `pixel.identify.v1`): `{brand_id, anonymous_id, session_id, ts, identifiers: {email_sha256?, phone_sha256?}, source: 'form_autodetect'|'explicit_api'|'login_hook', consent_state}`.
- **Explicit API first:** `brain.identify({email?, phone?})` on the pixel public API — the primary mechanism.
- **Form auto-detect second, gated:** MutationObserver detector for `input[type=email]`, `input[type=tel]`, `autocomplete="email|tel"`; on blur with valid value AND consent AND brand flag `pixel.autodetect.enabled=true`, hash and fire. Never read fields near `form[action*="password"], input[type=password]`; never persist raw values; hash synchronously, discard raw.
- Debounce: one identify per identifier value per session (hash-dedupe in sessionStorage).

#### A.1.2 Consent model
- Per-brand config: `{identity_capture: 'off'|'explicit_only'|'autodetect', consent_source: 'cmp_signal'|'assume_granted'}`. Default `off`.
- `cmp_signal`: read IAB TCF `__tcfapi` + generic `window.brainConsent` boolean. No signal → denied.
- Every identify carries `consent_state`; Silver drops denied-consent identifies (server-side enforcement, tested).

#### A.1.3 Normalization before hashing (uniform pixel + connectors)
- Email: trim, lowercase, NFC-normalize, SHA-256 hex. Do NOT strip Gmail dots/plus-tags (ADR).
- Phone: E.164 via libphonenumber using brand default country (IN/AE/SA/QA/BH/KW/OM); unparseable → no phone identifier. SHA-256 hex of E.164 including `+`.
- Shared package `packages/identity-normalization` (TS) + mirrored Python module; property-based cross-language equivalence tests (mandatory — hash drift silently destroys stitch rates).

#### A.1.4 Connector enhancements (Shopify, WooCommerce, Shopflo, GoKwik)
- Each connector extracts customer email/phone, normalizes+hashes via shared module, writes `email_sha256`, `phone_sha256`, `platform_customer_id` into the Silver canonical envelope (new optional Avro fields, BACKWARD).
- GoKwik/Shopflo additionally carry `checkout_session_id` (high-value India-COD join key) on pixel checkout events + connector order events.
- Backfill: one-off Spark job re-derives hashes for historical Silver orders from bronze payloads (skip shredded subjects).

#### A.1.5 Identity Bridge ingestion
- Consume new fields from Silver, upsert Neo4j near-real-time: `(:Identifier {type, value_hash, brand_id})`, `(:BrainId {brain_id, brand_id})`, `OBSERVED_WITH {first_seen, last_seen, source, count}`.
- **Identity priority (per brand, configurable):** default `[platform_customer_id, email_sha256, phone_sha256, anonymous_id]`. Highest-priority matching identifier wins; lower-priority conflicts → A.2.3 merge/disambiguation, never silent overwrite. Priority config versioned per brand.
- All `silver_identity_map` writes are bi-temporal appends (close old interval, open new), never in-place.

### A.2 Deterministic Multi-Key Stitch (Stitch v2)

#### A.2.1 Purpose
Replace single-key (`anonymous_id`) stitch with multi-key deterministic stitch: session links to a customer sharing ANY common identifier (email hash, phone hash, platform customer id, anonymous id, checkout_session_id) — unambiguously.

#### A.2.2 Sanctioned identity views
- `identity_current_v(brand_id, identifier_type, identifier_hash, brain_id)` — current valid+known.
- `identity_asof(t_valid, t_system)` — parameterized as-of view/function.
- CI check greps Spark jobs + Trino queries for direct raw-table reads outside these views; fails CI.

#### A.2.3 Stitch algorithm (Spark, incremental)
Per unstitched session (watermarked):
1. Identifier set S = {anonymous_id, checkout_session_id?, email_sha256?, phone_sha256?} from all session events.
2. Resolve via `identity_current_v` → candidate brain_ids B.
3. |B|=1 → link; write `{brand_id, session_id, brain_id, matched_via[], stitch_version: 2, stitched_at}` to `silver_session_identity` (legacy `ops.silver_identity_link` dual-written during rollout, flag-controlled). |B|=0 → unstitched (probabilistic-eligible). |B|>1 → **ambiguous, do not guess** → `silver_stitch_conflicts {brand_id, session_id, candidate_brain_ids, identifiers, detected_at}` (input queue for merge review).
4. Shared-device rule: `anonymous_id` alone links only when it maps to exactly one brain_id AND `last_seen` within 90 days (per-brand configurable).
5. Re-stitch on identity change: Kafka `identity.map.changed.v1` (keyed brand_id+identifier_hash, emitted on every map mutation); stitch job consumes it, finds sessions containing that identifier within the attribution lookback, re-runs 1–3. This mechanism lifts PAST journeys — most of the >40% target.

#### A.2.4 Merge & unmerge (audited)
- Merge on deterministic evidence (shared email/phone hash): survivor = older brain_id; `identity_merge_log {brand_id, survivor, absorbed, evidence, merged_at, actor}`; emit `identity.map.changed.v1`; journey re-versioning consumes (verify in Phase 0).
- Unmerge: admin-triggered; bi-temporal close + re-version. API endpoint + reversal job REQUIRED before enabling autodetect for any live brand.

#### A.2.5 Performance
- Incremental, partitioned brand_id+event_date; broadcast join identity view <50M rows/brand else sort-merge; daily increment for a 5M-event brand < 20 min (record baseline in gate).
- Local: runs on golden within 4GB executor memory (explicit local Spark profile).

### A.3 Probabilistic Stitch (quarantined)
- Splink Spark (Python) over unstitched sessions: features = UA family, OS, screen class, IP /24 (truncated only), timezone, hour-of-day histogram distance, top-category overlap. Blocking: same brand + same IP /24 + 7-day activity, OR same brand + device fingerprint hash.
- Output ≥ 0.95 only → `silver_probabilistic_stitch {brand_id, session_id, probabilistic_brain_id, confidence, model_version, features_used, scored_at}`.
- Versioned; train on deterministic labels, 20% holdout; publish precision/recall to `knowledge-base/models/splink-<version>.md`. Ship bar: holdout precision ≥ 0.98 (score floor 0.95 is separate).
- Consumers: segments/behavior only via `customer_sessions_extended_v` (union + `identity_basis`). Attribution reads only `silver_session_identity` (§1.4). Gateway auto-adds `estimated: true` when probabilistic rows contribute.

### A.4 Real-Time Identity & Touchpoint Cache
- Stream-worker upserts identifiers to Neo4j on identify/order events (verify existing; complete gaps). Budget ≤ 50ms p99 added (1k-event replay benchmark).
- New consumer group maintains Redis zset `{brand_id}:tp:{brain_id}` — last 200 touchpoints, score=ts, member=compact JSON `{type, channel, url_path, ts, session_id}`. TTL 30d sliding. Deterministic brain_ids only. On merge: union absorbed into survivor, delete absorbed key.
- Cache, not truth — journey APIs fall back to Iceberg.

### A.5 Wave A Acceptance Criteria
1. Golden: deterministic identification of purchasing sessions ≥ 40% autodetect-off, ≥ 55% autodetect-on.
2. Cross-language hash equivalence: 0 mismatches over 10k generated identifiers.
3. Ambiguity: email→X, anon→Y session produces conflict row, NO stitch.
4. Consent: denied identifies never reach `silver_identity_map` (pixel + Silver assertions).
5. Re-stitch: day-7 identification stitches day-1 sessions within one incremental run.
6. Probabilistic quarantine data test passes.
7. Merge/unmerge round-trip: merge → journey re-version → unmerge → restoration.
8. Flags OFF: byte-identical golden outputs.

---

## PART 3 — WAVE B: JOURNEY ENGINE AS FIRST-CLASS DOMAIN

**Goal:** reusable Journey domain (`packages/domain-journey`) constructing canonical cross-session, cross-device journeys, exposed via versioned APIs consumed by Attribution, Segmentation, AI, UI. Explainable and replayable. **Depends on Wave A.**

### B.1 Canonical Journey Generation
- Input: Silver touchpoints + `silver_session_identity` (v2).
- Spark incremental: resolve brain_id per event (unstitched → null, journey-eligible after re-stitch); group `(brand_id, brain_id)`, order by ts tie-break `(session_id, event_seq)`; monotone `journey_seq` per brain_id (recomputed per version); write to versioned `journey_events` extended with `matched_via`, `identity_basis='deterministic'` (canonical journeys deterministic-only; probabilistic overlays in a separate view).
- Idempotent: MERGE on `(brand_id, brain_id, journey_version, event_id)`.

### B.2 Cross-Device Stitching
- Via identity merges + re-versioning. Wave B work: re-version consumer on `identity.map.changed.v1` → mark dirty brain_ids, rebuild journeys as N+1, write `journey_version_log {brand_id, brain_id, from_version, to_version, cause: merge|unmerge|restitch, at}`. Verify existing re-versioning in Phase 0; complete if PARTIAL.

### B.3 Journey APIs (Fastify gateway; tenant from auth token, never query params; Redis cache + Trino fallback)
- `GET /v1/customers/{brain_id}/journey?cursor=&limit=` — newest-first timeline: `{ts, type, channel, campaign?, url_path?, session_id, matched_via, journey_version}` + `X-Journey-Version` header.
- `GET /v1/journeys/trace?order_id=` — lookback-window touchpoints before the order + identity evidence per touchpoint (`matched_via`) — the explainability surface.
- `GET /v1/journeys/compare?left=&right=` — two journeys with `t_minus_conversion_ms` per touchpoint.
- Contract tests; p95 < 300ms cache-hit, < 2s cold over golden.

### B.4 Journey Replay & Explainability
- `?as_of=<iso>`: Iceberg time-travel on `journey_events` + `identity_asof` — journey as known then. Batch-path only; `replayed: true`.
- Every item carries `matched_via`; probabilistic overlays add `confidence` + `estimated: true`; trace returns `identity_evidence: [{identifier_type, first_seen, source}]`.

### B.5 Wave B Acceptance Criteria
1. Golden multi-device customer → one canonical journey across devices post-merge, version bump logged.
2. Trace: 5-touch golden order returns exactly those 5 in order with correct matched_via.
3. Replay: pre-identification as_of returns the shorter anonymous-era journey.
4. Attribution parity: attribution consuming Journey output (flagged) == legacy path on golden with identity held constant; then document the improved delta with Stitch v2 on.
5. Latency budgets; flags-OFF regression.

---

## PART 6 — WAVES E–I: BINDING CONTRACTS (SCAFFOLD ONLY)

Interfaces, schemas, DDL, package skeletons, flags OFF, ADR stubs. NO business logic/model training/agent loops/executors. Each: `knowledge-base/contracts/CONTRACT-<wave>.md`.

### E. AI Feature Layer
- **Point-in-time correctness load-bearing**: `gold_ai_features {brand_id, entity_type: customer|product|campaign, entity_id, feature_name, feature_value (typed union), event_timestamp, created_timestamp, feature_version}`. Training reads = as-of joins on event_timestamp, NEVER "latest".
- Online contract: Redis hash `{brand_id}:feat:{entity_type}:{entity_id}`; endpoint stub `GET /v1/features/...` → 501 behind flag.
- Registry `packages/ai-features` YAML per feature `{name, entity, dtype, source, freshness_sla, owner, pii}`; PII features join shred manifest.
- Deferred: computation jobs, embeddings, materialization.

### F. AI Platform Infrastructure
- LLM Gateway = LiteLLM config: routing table (aliases per task class), per-brand budget/rate-limit keys, logging to `ops_llm_calls {brand_id, request_id, model, prompt_hash, tokens_in/out, cost_minor, currency, latency_ms, ts}` (prompt hashes + redacted-PII store; masking hook stub).
- Tool registry = MCP: every copilot tool over the semantic layer + Journey/Feature APIs. Tools NEVER query Trino/raw tables — contract test: MCP server package has no Trino client dependency.
- `execution_mode` enum (`suggest|approve|auto`) on every agent-action schema, default `suggest`; `auto` unreachable until Wave I governance.
- Git-backed `prompts/` + loader; no runtime.
- Deferred: agent runtime, memory, guardrail models, fine-tunes.

### G. Recommendation Engine
- Schema only: `gold_recommendations {brand_id, subject_type, subject_id, rec_type: product|campaign|nba, payload, score, confidence, evidence (features+values), model_version, business_rules_applied, generated_at, expires_at}` — explainability schema-enforced.
- `GET /v1/recommendations` → 501 behind flag. Deferred: all models/scoring.

### H. Decision Engine
- `gold_decisions {brand_id, decision_id, subject, candidates (with per-candidate expected_value_minor + constraint evaluations), selected, policy_version, rationale, decided_at}` — the road not taken persisted.
- Policies = versioned YAML (`packages/decision-policies`, compiler pattern); constraints reference certified metrics ONLY.
- Deferred: evaluation engine, EV models, arbitration.

### I. Action Platform
- Apicurio envelopes: `action.requested/approved/executed/failed/rolled_back.v1` with `{brand_id, action_id, decision_id?, executor, payload, execution_mode, approved_by?, holdout_group?}` — holdout in the envelope from day one.
- Executor port (TS) + four NotImplemented adapters (shopify-discount, meta-audience, messaging, webhook) behind flags.
- Governance: no `auto` without human-approved policy version + holdout support + rollback per executor (gate precondition for Wave I).

---

## PART 7 — COMPETITOR-DERIVED REQUIREMENTS (DIGEST)

ADOPTED: mParticle IDSync ordered identity priority + audited merge/unmerge (A.1.5/A.2.3/A.2.4); Northbeam first-party capture resilience + new-vs-returning in every economic view (A.1.4/C.5.5); Triple Whale LLM-optimized universal schema (D.2) + Copilot/Autopilot enum now, runtime later (F); Feast point-in-time discipline (E); Cube/dbt metrics-as-code + compile-time row security + MCP exposure (D.2); NBA candidates-vs-rules-vs-EV + holdouts (H/I).
REJECTED: Northbeam Clicks+Modeled Views for revenue paths (violates §1.4).
DEFERRED: platform-verified impressions, attribution passback (Wave I / partnerships).

Post-program position: verified financial facts (C) + deterministic identity (A) + governed semantic layer (D) under one tenancy/privacy model — the substrate the AI waves need that pixel-only or engagement-only competitors lack.

---

## PART 8 — CROSS-CUTTING VERIFICATION

1. Golden regression at every gate, flags OFF. 2. Invariant checklist at every gate. 3. Local resource discipline: every new Spark job ships a local profile within the 24GB Docker envelope; local OOM on golden = defect. 4. Load smoke: stream-worker A.4 budget; Journey API budgets. 5. Privacy audit per wave: shred manifest, topic PII sampling, consent-off → zero identity rows. 6. Docs: additive appendices + Graphviz sources.

## PART 9 — ROLLBACK MATRIX

| Wave | Disable | Cleanup | Verified by |
|---|---|---|---|
| A | flags: pixel.identify, connector.identity_fields, stitch.v2, probabilistic, tp_cache | tables additive; legacy silver_identity_link dual-written until D | golden regression |
| B | flag: journey.engine | versions retained (append-only) | B.5.4 parity |
| C | flag: measurement.marts_migration | fact tables additive | C.4 parity |
| D | flag: semantic.serving | views regenerable | D.4 same-number |
| E–I | all flags OFF by construction | schemas/DDL inert | contract tests |

*(PARTS 4–5 — Waves C and D full text — maintained in this file at full fidelity; see sections C.1–C.5 and D.1–D.4 below.)*

## PART 4 — WAVE C: MEASUREMENT ENGINE EXPANSION

**Goal:** one Measurement domain (`packages/domain-measurement`) owning every business fact — revenue (exists), refunds/returns, COD settlement, platform fees, shipping costs, marketing spend, inventory movement — so every metric (ROAS, CAC, CM1/CM2/CM3, MER/aMER) computes from the same audited base.

### C.1 Verify current state (Phase 0)
`gold_revenue_ledger`: confirm recognition rules (prepaid at capture; COD at delivery confirmation; reversals on RTO/refund) and 3-way reconciliation; record actual tolerances. All Wave C tables adopt the event-sourced pattern: append-only facts + derived current-state views.

### C.2 New fact tables (`gold_measurement_*`; keyed (brand_id, order_id, event_id) where order-linked; integer minor units + currency; source_system/source_event_id lineage; shred-manifest where subject-linked)
1. `gold_measurement_refunds` — `{..., order_line_id?, amount_minor, currency, reason_code, refund_method, initiated_at, settled_at?}`; RTO is a first-class reason_code.
2. `gold_measurement_settlements` — `{..., gross_minor, fees_minor, net_minor, settlement_batch_id, settled_at}`; reconciles against ledger recognition.
3. `gold_measurement_fees` — platform/payment/checkout-provider fees per order.
4. `gold_measurement_costs` — shipping (forward + REVERSE logistics), packaging (brand default), COGS (catalog cost fields else brand-uploaded cost sheet: CSV ingest endpoint + validation + `gold_product_costs {brand_id, sku, cost_minor, currency, valid_from, valid_to}`).
5. `gold_measurement_spend` — day×channel×campaign canonical spend facts from ad connectors.
6. `gold_measurement_inventory` — movement events where connectors provide; flag-gated.

### C.3 Contribution margin
`gold_order_economics` (per order, idempotent as facts arrive): CM1 = net revenue − COGS; CM2 = CM1 − shipping(fwd+rev) − packaging − payment/platform fees; CM3 = CM2 − allocated marketing spend (deterministic attributed where available, else day×channel pro-rata; `cm3_allocation_basis` per row). `economics_state: provisional|settled|reversed`; RTO flips revenue AND adds reverse-logistics cost. `gold_product_economics` daily rollup.

### C.4 Migration
CAC/ROAS/executive marts switch to `gold_measurement_*` behind flag; parity vs legacy with line-by-line explained deltas (new fees/costs, never revenue changes).

### C.5 Acceptance Criteria
1. `GET /v1/metrics/{metric}/lineage?date=` — fact tables + row counts + job versions.
2. Golden RTO order: negative CM3 + ledger reversal, exact minor units.
3. KWD order: 3-decimal economics, zero rounding loss.
4. Settlements vs ledger diff = 0 on golden; live tolerance documented.
5. `is_new_customer` per order present (aMER, honest CAC).
6. Flags OFF regression.

## PART 5 — WAVE D: SEMANTIC BUSINESS MODELS

**Goal:** refactor Gold into semantic ENTITY models + governed METRIC DEFINITION layer — dashboards, APIs, BAI, future agents consume identical certified definitions.

### D.1 Semantic entities (`semantic_*`)
`semantic_customer` (customer_360 + identity timeline summary + segments + identity_basis flags), `semantic_order` (customer link, line summary, channel, deterministic campaign, Wave C economics, is_new_customer, journey pointer), `semantic_product` (catalog + performance + cost validity), `semantic_campaign` (unified spend + deterministic attributed revenue/orders + ROAS/CAC-new), `semantic_journey` (alias of journey_events). Old marts deprecated in `knowledge-base/semantic/deprecation-map.md`.

### D.2 Metric registry
`packages/semantic-metrics`: YAML per metric `{name, entity, expression, grain, dimensions_allowed, currency_handling, identity_basis, owner, description, examples}`. Launch set: net_revenue, gross_revenue, refund_amount, orders, aov, mer, amer, roas, cac, cac_new, cm1, cm2, cm3, cm3_pct, rto_rate, return_rate, repeat_rate, ltv_realized, identified_purchase_rate. Compiler generates: Trino views per metric×grain + Spark pre-agg tables for `interactive: true` + JSON catalog at `GET /v1/semantic/metrics` + TS types. Governance: YAML-only changes via PR; compiled-SQL snapshot tests. Tenancy compiled in: every view filters `brand_id = current_brand()`.

### D.3 Consumer migration
Gateway endpoints + dashboards migrate behind flags with per-endpoint parity; BAI serves from compiled views — BAI and dashboards cannot disagree by construction.

### D.4 Acceptance Criteria
1. Same-number test: 10 golden scenarios — endpoint == compiled view == direct entity computation, to the minor unit.
2. Metric catalog serves all metrics, valid JSON schema; MCP-shaped tool definition per metric emitted + shape-validated.
3. Cross-tenant test on compiled views.
4. `deterministic_only` metrics provably exclude probabilistic rows.
5. Deprecation map complete; lint blocks NEW consumers of deprecated marts.
