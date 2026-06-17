# CTO Advisor Intake — feat-razorpay-settlement-connector
**Stage:** 1 — Intake
**Req ID:** feat-razorpay-settlement-connector
**Reviewed at:** 2026-06-17T19:10:00Z
**Reviewer:** Engineering Advisor (cto-advisor, Sonnet tier)
**Decision:** ADVANCE (with make-or-break bindings MB-1..MB-7 — Architect must resolve all before any implementation file is written)

---

## 1. Lane Confirmation

**Lane: HIGH_STAKES — CONFIRMED.**

The deterministic scan identified: `connectors`, `money`, `multi_tenancy`.

I add the following surfaces, each independently warranted:

| Surface added | Warrant |
|---|---|
| `pii` | settlement_id, payment_id, order_id, UTR — customer/payment identifiers in the settlement report and webhook payloads. Same PII minimization obligation as Shopify (hash-only in Bronze, no raw identifiers in events). |
| `secrets` | Razorpay key_id + key_secret (API auth) + webhook secret (HMAC validation) — three distinct credentials, all brand-scoped, all must live in Secrets Manager via `secret_ref` (I-S09). The connector must NOT inline any of these three into DB rows, logs, or events. |
| `schema_proto` | Migration 0027 (SECURITY DEFINER settlement enumeration fn, sibling to 0026's `list_connectors_for_repull`), new `settlement.live.v1` Avro schema in `packages/events`, new `settlement_finalization` / `payment_fee` / `settlement_reversal` event_types in the ledger. FULL_TRANSITIVE Apicurio compatibility required on all new event schemas. |
| `outbound_channel` | Razorpay Settlements API calls (outbound HTTP, paginated, rate-limited) + outbound registration of the webhook endpoint with Razorpay. Same dev-honesty boundary as Shopify: real Razorpay webhook delivery requires a public URL that does not exist in dev. |

**Final confirmed trigger surfaces (7):**
`connectors`, `money`, `multi_tenancy`, `pii`, `secrets`, `schema_proto`, `outbound_channel`

Note: `system_of_record_audit` was added for the Shopify live connector because the ledger is THE MOAT. The same logic applies here — net-of-fees finalized ledger rows ARE the money truth. I add `system_of_record_audit` as surface #8.

**Final confirmed trigger surfaces (8):**
`connectors`, `money`, `multi_tenancy`, `pii`, `secrets`, `schema_proto`, `outbound_channel`, `system_of_record_audit`

---

## 2. Dependency Pre-Flight

All stated blockers checked against `state/active.json`:

| Dependency | Status |
|---|---|
| `feat-shopify-live-connector` | `awaiting-stakeholder` (Stage 7) — Stakeholder has not yet approved |
| `feat-realized-revenue-ledger` | `shipped` |
| `feat-connector-backfill` | `shipped` |
| `feat-connector-marketplace` | `shipped` |
| `chore-connector-lifecycle-regression` | `shipped` |
| `fix-dev-token-reach` | `shipped` |

**DEPENDENCY FLAG — feat-shopify-live-connector is NOT yet `shipped`.**

The requirement explicitly reuses the Shopify live connector's patterns: migration 0026 SECURITY DEFINER fns, the LedgerWriter reversal/recognition methods, the LiveLedgerBridgeConsumer wiring, the `@brain/shopify-mapper` boundary-hash pattern, and the connector-lifecycle-regression FROZEN fixtures + assertBrainApp helper. The 14-binding-decision architecture for the Shopify connector (particularly D-4 brand-from-mapping, D-6 per-state dedup, D-7 SECURITY DEFINER, D-12 mapper package) has just been agreed and built — but it is in Stakeholder review, not yet on master.

**Assessment: NOT a hard stop for Stage 1 intake, but a conditional dependency that must be resolved before the Architect begins design.**

Rationale: The `feat-shopify-live-connector` requirement is at Stage 7 (Stakeholder gate only, 0 blocking findings from the final reviewer). The code is fully built and verified; the Stakeholder signature is the only remaining step. This is not a substantive blocker — it is a merge gate. The Architect MUST wait for the Shopify live connector to reach `shipped` before committing any implementation file for the Razorpay connector that imports from the shopify-mapper package or relies on migration 0026 or the LiveLedgerBridgeConsumer wiring.

**Action recorded:** Stakeholder attention file updated. Status: CONDITIONAL advance — pipeline pauses at Stage 2 if Shopify live connector is not shipped before the Architect writes migration 0027 or any code that imports `@brain/shopify-mapper` patterns.

---

## 3. "Make It Less Dumb First"

Scope interrogation: what can be deleted, simplified, or deferred?

**Already correct deferrals (validate, keep):**
1. Argo cron for settlement re-pull — correct to defer. A manually-triggered or scheduled stream-worker job (mirroring backfill + Shopify re-pull patterns) is sufficient for M1.
2. Public Razorpay webhook ingress — correct deferral. Razorpay cannot reach localhost. Dev proves with synthetic HMAC-signed POSTs. This MUST be stated honestly in the developer guide (same contract as Shopify).
3. Full DQ A+→D gating / connector-health detector — correct deferral.
4. Non-Razorpay PSPs (Cashfree/PayU) — correct deferral.
5. Billing-period posting engine beyond dual-date fields — correct deferral.
6. Razorpay Route / marketplace split-payments — correct deferral; materially different API surface.

**Simplification I recommend the Architect evaluate:**
- Can the settlement re-pull reuse the same SECURITY DEFINER pattern as `list_connectors_for_repull()` from 0026 directly, rather than writing a new function from scratch? YES — a new function `list_settlement_connectors_for_repull()` (or a more general `list_razorpay_connectors()`) mirrors 0026 exactly. The Architect should confirm the function signature and whether 0026's function can be extended or whether a sibling 0027 function is cleaner. Given the durable rule, a separate function in the same migration is preferable (single-responsibility).
- The settlement recognition consumer: the requirement offers two options (separate stream-worker consumer vs extending LiveLedgerBridgeConsumer). The simplest path is a **dedicated** `SettlementLedgerConsumer` that filters `settlement.live.v1` events on the live lane — NOT extending the Shopify consumer (which filters `order.live.v1`). The wired-to-nothing watch (occurrence #2, lessons-learned) means wiring this consumer into `main.ts` is MANDATORY and must be verified by an end-to-end wiring test. Do NOT extend LiveLedgerBridgeConsumer with settlement logic — keep the consumers single-purpose.

**No scope cuts recommended beyond the already-stated non-goals.** The scope is tight and purpose-driven.

---

## 4. Domain Check vs. Product Canon

### Money correctness (I-S07, I-E02, THE MOAT)
The requirement is correct on the fundamentals: integer minor units BIGINT, INR, no float, append-only ledger, net-of-fees BEFORE realized. The fee decomposition into distinct ledger rows (settlement_finalization + payment_fee + settlement_reversal event_types) is the right model — it preserves the ability to compute gross separately from net, and it is queryable by fee component. 

One concern to raise with the Architect: a "single net row" approach (gross + all fees in one row) is simpler but loses fee decomposition auditability. The separate-row approach (one finalization delta row, one fee row per fee component) is more honest and replayable but requires the metric engine to SUM across row types correctly. The requirement states the separate-row approach — confirm it and bind it.

### Reconciliation join key (the make-or-break design tension — MB-1)
The requirement states: "join on order_id / payment_id — order_id when Razorpay carries it, else payment_id→order mapping." This is insufficiently bound and must be resolved as a first-principles architecture decision before any code is written. See MB-1 below.

### Dedup namespace collision risk (MB-2)
The requirement correctly calls for a distinct uuidv5 namespace for settlement events (`settlement.live.v1` distinct from `order.live.v1` / `order.backfill.v1`). This must be enforced at the event_type level and in the uuidv5 seed string to guarantee no dedup collision between order events and settlement events. The Architect must define the exact seed string (e.g., `brand:settlement_id:settlement.live.v1`).

### Wired-to-nothing (occurrence #3 trigger)
The requirement's constraint already names this: "WIRE THE CONSUMER INTO main.ts." If the SettlementLedgerConsumer (or equivalent) is built but not started in `main.ts`, this is occurrence #3 of the wired-to-nothing pattern — which triggers the durable-rule proposal. This MUST be caught by an end-to-end wiring test (real produce → real subscribe → observed ledger effect), not just a method-isolation test. The Architect must include this as a first-class test requirement in the design plan.

### PII boundary
Settlement reports from Razorpay contain payment_id, order_id, UTR (Unique Transaction Reference). UTR is a banking reference, not a direct person identifier — but payment_id and order_id are linkable to customers. The Bronze event and ledger rows must carry only hashed/opaque references. The mapper must hash these at the boundary (same pattern as the Shopify order mapper). No raw UTR, payment_id, or order_id strings in Bronze events or logs.

Clarification needed: are UTRs treated as PII by the team's interpretation of DPDP? UTR is a transaction reference, not a personal identifier. Conservatively: hash it or treat as opaque reference (not expose it in logs/events). The Architect should make this call explicitly.

### Secrets seam
Razorpay has THREE credentials: `key_id`, `key_secret`, and `webhook_secret`. All three must be stored as a single JSON bundle in Secrets Manager (one `secret_ref` per `connector_instance`, pointing to a Secrets Manager secret with structure `{key_id, key_secret, webhook_secret}`) OR as three separate `secret_ref` entries. The Architect must bind the secret structure. Recommendation: one composite secret per connector_instance (mirrors how Shopify stores client_id + client_secret + access_token in one bundle).

### No new deployable (I-E05)
Confirmed: webhook receiver in `apps/core`, settlement re-pull job in `apps/stream-worker`, settlement recognition consumer in `apps/stream-worker`. Migrations additive. No new deployable.

### Dev-honesty boundary
Must be explicit: in dev, the Razorpay settlements API CAN be called if `key_id`/`key_secret` are provisioned via `dev_secret` (same dev-token-reach path). The re-pull scheduler CAN run against real Razorpay data in dev. Razorpay webhooks CANNOT be received in dev (no public URL) — synthetic HMAC-signed POSTs are the substitute. The Architect must document this explicitly.

---

## 5. Make-or-Break Decisions — Architect Must Bind All Before Implementation

### MB-1 (CRITICAL): Reconciliation join key + late-arrival ordering

**The question:** Razorpay settlement reports contain `payment_id` and sometimes `order_id`. The provisional order revenue rows in the ledger were written using the Shopify `order_id` (from the order spine). How does a settlement row reconcile to a provisional order revenue row when:

- (a) The settlement carries both `payment_id` and `order_id` → join on `order_id`
- (b) The settlement carries only `payment_id` → must resolve `payment_id → order_id` via a mapping table (does one exist? who writes it?)
- (c) The settlement arrives BEFORE the Shopify order is in Brain (ordering/late-arrival) → the provisional row does not yet exist → what happens?

**Why this is make-or-break:** If there is no reliable join key, the settlement finalization logic cannot produce a correct ledger row. If the late-arrival case is not handled, settlements for orders that are still in transit (Shopify webhook not yet processed) will be silently dropped or incorrectly matched.

**Architect must bind:**
1. Is there a `payment_id → order_id` mapping table in Brain (from the Shopify connector's Bronze events)? If so, the reconciliation can always resolve `order_id`. If not, the connector must create one.
2. What is the authoritative join key? Recommendation: `order_id` is the canonical join key (it is present in both the Shopify spine and Razorpay settlement reports for standard checkouts). For settlements missing `order_id`, the connector maintains a `razorpay_payment_order_map` table (payment_id → order_id) populated from payment webhooks at capture time.
3. Late-arrival: if the order is not yet in Brain when the settlement arrives, the settlement event is held (parked in a `settlement_pending_reconciliation` Bronze state) or re-queued for a configurable retry window. Define the retry/timeout policy and what happens to unmatched settlements after the timeout (error metric, dashboard alert, no silent drop).

This decision has implications for the schema (MB-3) and the test suite (the requirement's test cases all assume successful reconciliation).

---

### MB-2 (CRITICAL): uuidv5 namespace + exact event_id seed string for settlement events

The requirement says "deterministic event_id (uuidv5 from brand:settlement_id:... namespace)." This is under-specified. The Architect must define the exact seed string and confirm it cannot collide with any existing event namespace.

**Existing namespaces (from prior runs):**
- `order.backfill.v1`: `${brandId}:${shopifyOrderId}:order.backfill.v1`
- `order.live.v1`: `sha256(brand:order:updatedAtMs)` effectively via `uuidV5FromOrderLive`

**Required for settlement events:**
- Settlement re-pull event: `uuidv5("${brandId}:${settlementId}:settlement.live.v1")`
- Settlement payment item event (for per-payment fee breakdown): `uuidv5("${brandId}:${settlementId}:${paymentId}:settlement.payment.v1")` — or are payment items embedded in the settlement event (not separate events)?
- Webhook event (settlement.processed): `uuidv5("${brandId}:${razorpayWebhookEventId}:settlement.webhook.v1")`

The Architect must bind: are settlement-level events and per-payment-fee items separate Bronze events, or is the fee breakdown embedded in the settlement event payload? This impacts the Avro schema and the uuidv5 seed.

---

### MB-3 (CRITICAL): Fee decomposition into ledger rows — exact event_type taxonomy

The requirement names: `settlement_finalization`, `payment_fee`, `settlement_reversal`. The Architect must bind the exact mapping from Razorpay fee fields to ledger event_types:

| Razorpay fee field | Ledger event_type | Row sign | amount_minor |
|---|---|---|---|
| settled_amount (net) | settlement_finalization | + | settled_amount in INR minor units |
| fee (MDR/processing) | payment_fee | - | fee in INR minor units |
| tax (GST on fee) | payment_fee | - | tax in INR minor units (or separate `settlement_tax` type?) |
| rolling_reserve deducted | payment_fee (or `rolling_reserve_deduction`?) | - | reserve amount |
| refund | settlement_reversal | - | refund amount |

Open question: Is GST on the Razorpay fee a separate ledger event_type (`settlement_tax`) or bundled into `payment_fee`? For auditability and potential GST reporting, separate is better. The Architect must bind the full event_type list.

Also: what is the unit of reconciliation — per settlement (one finalization row per daily settlement) or per payment (one finalization row per payment within the settlement)? The per-payment model is more granular and matches the Shopify order spine's per-order provisional rows. The Architect must bind this.

---

### MB-4 (HIGH): Settlement recognition consumer — separate class vs. extending LiveLedgerBridgeConsumer

**The options:**
- Option A: A dedicated `SettlementLedgerConsumer` (new class in `apps/stream-worker/src/consumers/`) that subscribes to `settlement.live.v1` events on the live lane and writes finalization ledger rows.
- Option B: Extend `LiveLedgerBridgeConsumer` to also handle `settlement.live.v1` events.

**My recommendation: Option A.** The wired-to-nothing watch (occurrence #2) means this is the highest-risk component for exactly this failure mode. A dedicated, named consumer with its own wiring test is harder to miss than a new event handler bolted onto an existing consumer. The Architect must choose and justify.

**Mandatory regardless of choice:** the consumer MUST be imported, instantiated, started (`consumer.start()`), and stopped in `main.ts`. The end-to-end wiring test (real Redpanda produce → consumer subscribe → observed ledger effect) MUST be in the test suite. If occurrence #3 is confirmed at review, the reviewer MUST file the durable rule proposal per the lessons-learned threshold.

---

### MB-5 (HIGH): SECURITY DEFINER enumeration fn for settlement re-pull (migration 0027)

The adopted durable rule `system-job-force-rls-enumeration` is BINDING. The settlement re-pull is a cross-tenant system job that enumerates `connector_instance` under FORCE RLS. Without a SECURITY DEFINER enumeration fn:
- A bare `brain_app` SELECT on `connector_instance` returns 0 rows (no GUC set at enumeration time).
- The settlement re-pull silently no-ops in production.
- This is the same class of defect that caused SEC-BF-H1 (feat-connector-backfill) and F-SEC-01 (feat-realized-revenue-ledger).

**Architect must bind:**
- Function name: `list_razorpay_connectors_for_settlement_repull()` (or similar)
- Function structure: SECURITY DEFINER, search_path=public pinned, GRANT EXECUTE TO brain_app, migration-time assertion (prosecdef=true, search_path=public, execute grant)
- Dispatch columns only: connector_instance_id, brand_id, secret_ref, cursor_high_water
- Non-inert negative control test: `brain_app` direct SELECT on `connector_instance` without GUC = 0 rows (this has been required on every prior run and must be present here)

---

### MB-6 (HIGH): Dev scheduler trigger for settlement re-pull (dev-honesty boundary)

The requirement defers Argo cron and states "dev proves with triggered/scheduled settlement re-pull." The Architect must specify the exact trigger mechanism:

- Option A: An HTTP endpoint on `apps/core` (e.g., `POST /api/v1/connectors/:connectorId/settlement-repull`) gated to `brand_admin+`, which queues a re-pull job via the `backfill_job` table (or a `settlement_repull_job` table).
- Option B: A direct stream-worker job trigger (e.g., the same `backfill_job` table with a different `job_type='settlement_repull'`).
- Option C: A simple cron expression inside the stream-worker process (not Argo, runs on a fixed interval).

The dev test suite must be able to trigger a re-pull deterministically (not wait for a timer). Bind which option and document the dev trigger mechanism explicitly.

---

### MB-7 (MEDIUM): Dual-date fields on finalized ledger rows + immutability of closed billing periods

The dual-date rule is stated correctly in the requirement: `economic_effective_at = settlement date; closed billing periods immutable (late reversals post forward)`. The Architect must confirm the existing `realized_revenue_ledger` schema supports this:

- Does the schema have `economic_effective_at` and `billing_posted_period` columns? (These were added in the feat-realized-revenue-ledger run — confirm they are present and the SettlementLedgerConsumer uses them correctly.)
- What is the `billing_posted_period` for a settlement received on 2026-06-17 for a settlement dated 2026-06-10? Answer: `billing_posted_period = '2026-06'` (the settlement month), not the posting month. But if June's billing period has already been closed (sealed), the late arrival must post to the CURRENT period with a reference to the original settlement date. Bind this rule explicitly.

---

## 6. Challenge Assessment

### What this requirement does well
- Problem statement and success metric are sharp and testable.
- Non-goals are correctly scoped (deferrals are real deferrals, not scope hiding).
- The reuse of the Shopify live connector patterns (migration 0026, LedgerWriter, LiveLedgerBridgeConsumer wiring, lifecycle regression fixtures) is the correct engineering discipline.
- The requirement explicitly names the wired-to-nothing watch (occurrence #2) and requires wiring — this is correct and should be verified at review as a first-class check.
- HMAC-first is correctly specified (X-Razorpay-Signature, raw body, brand from connector mapping never webhook body).
- dev-honesty boundary is correctly scoped.

### Where the requirement is under-specified (Architect must resolve — not a CHALLENGE-BACK)
The MB-1..MB-7 decisions are real architectural unknowns that will determine whether the implementation is correct. They are not "nice to have" refinements — MB-1 (reconciliation join key + late-arrival) in particular is a make-or-break correctness question. The Architect cannot design the SettlementLedgerConsumer without knowing whether `order_id` is always present, what `payment_id → order_id` mapping exists, and what the late-arrival policy is.

### No KILL or CHALLENGE-BACK warranted
The requirement is sound in intent, scope, and alignment with the product Canon. The under-specifications are design-time decisions, not product-direction problems. ADVANCE is correct.

---

## 7. Personas Recommended

**2 personas required before architecture (high_stakes lane cap = 2):**

| Persona | Tier | Angle |
|---|---|---|
| Payments / Settlement-Reconciliation Realist | `:sonnet` | Razorpay's actual settlement report structure — does `order_id` always appear? What Razorpay API response fields are reliable vs. optional? What edge cases exist in the fee decomposition (partial settlements, rolling-reserve releases, chargeback cycles)? Will late-arrival be common for Indian COD brands? |
| Compliance / Secrets Officer | `:sonnet` | Are UTRs PII under DPDP? Does Brain's handling of payment_id/settlement_id in Bronze events create a new PCI-adjacent obligation (even though Brain is SAQ-A, settlement IDs tied to card payments could be a scope creep risk)? Are three Razorpay credentials (key_id/key_secret/webhook_secret) stored correctly as a single composite secret_ref or three separate refs, and what is the revocation story if one is compromised? |

---

## 8. Paradigm

**Tier-0 deterministic.** $0/month model spend. The entire connector is data-pipeline processing: Razorpay API calls (HTTP), webhook receipt (HTTP), event emission (Redpanda), Bronze writes (Postgres), ledger writes (Postgres). No model calls, no ML, no LLM gateway. Cost-routing audit: trivially clean.

---

## 9. Success Criteria (Binding — extends requirement §Success metric)

These are the non-negotiable acceptance criteria. The Architect must ensure the test suite covers all of these:

- [ ] Synthetic settlement report → net-of-fees finalized ledger rows; provisional sale row untouched; new `settlement_finalization` + `payment_fee` rows visible under brain_app with correct brand GUC
- [ ] HMAC-invalid Razorpay webhook → 401, zero Bronze writes (non-inert: HMAC-valid webhook MUST land a row)
- [ ] Settlement re-pull cursor advances/resumes with 30-day trailing window; overlap-lock verified (two concurrent triggers → one completes, one skipped via SKIP LOCKED)
- [ ] Settlement webhook + re-pull of the same settlement_id = ONE Bronze row (event_id dedup via uuidv5)
- [ ] Refund settlement → new negative ledger row; prior finalized row untouched
- [ ] Cross-brand = 0 under SET ROLE brain_app (assertBrainApp); isolation-fuzz non-inert
- [ ] No-GUC negative control on the SECURITY DEFINER settlement enumeration fn: `brain_app` direct SELECT on `connector_instance` without GUC = 0 rows
- [ ] SettlementLedgerConsumer wired in main.ts (import + instantiate + start + stop) — verified by end-to-end wiring test (real produce → observed ledger row)
- [ ] connector_sync_status reflects settlement sync state (syncing/connected + last_sync_at)
- [ ] No raw UTR / payment_id / settlement_id in Bronze events or logs
- [ ] Late-arrival test: settlement arrives before the Shopify order is in Brain → defined policy (hold/park/alert), not a silent drop

---

## 10. Tracks (Informational — Architect refines)

- **@backend-developer:** Razorpay webhook receiver (HMAC-first, brand from connector mapping, secret seam) + connect/secret_ref wiring for 3 credentials + sync_status updates
- **@data-engineer:** Settlement re-pull job (SECURITY DEFINER enumeration fn 0027, paged Razorpay Settlements API client, cursor management, overlap-lock) + SettlementLedgerConsumer (the settlement event shape, reconciliation join, fee decomposition, net-of-fees ledger writes) + live-lane emission + WIRE into main.ts
- **@frontend-web-developer:** Dashboard realized-revenue gross→net indicator + Razorpay connection tile / health
- **Shared prerequisite before parallel tracks:** Migration 0027 committed; settlement event schema in `packages/events`; fee→event_type taxonomy bound (MB-3)

---

**Decision: ADVANCE** — to persona stress-test (2 personas), then Architect (Stage 2) after synthesis. MB-1 through MB-7 are the Architect's contract. MB-1 (reconciliation join key + late-arrival) and MB-2 (uuidv5 namespace) and MB-5 (SECURITY DEFINER fn) are the three highest-risk bindings and must be resolved and documented BEFORE any implementation file is written.

Conditional: the Architect waits for `feat-shopify-live-connector` to reach `shipped` (Stage 8) before committing any code that imports `@brain/shopify-mapper` patterns or extends migration 0026's functions.
