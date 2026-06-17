# Intake Synthesis — feat-razorpay-settlement-connector
**Stage:** 1 — Synthesis (post-persona)
**Req ID:** feat-razorpay-settlement-connector
**Synthesized at:** 2026-06-17T19:50:00Z
**Synthesizer:** Engineering Advisor (cto-advisor, Sonnet tier)
**Verdict:** ADVANCE to Architect (Stage 2)

---

## 1. What the Personas Changed

Both personas reported material findings that rewrite or expand the binding contract. Neither issued a KILL or CHALLENGE-BACK. Together they add 10 new bindings on top of MB-1..MB-7, and they materially rewrite MB-1, finalize MB-2, and expand MB-3. Summary:

| Persona | Top finding | Impact on contract |
|---|---|---|
| Payments Realist | The join in MB-1 is WRONG — Razorpay `order_id` is a Razorpay-native ID (`order_XXXX`), not the Shopify order ID. The entire reconciliation join fails silently in prod unless a two-hop mapping table is built and populated at `payment.captured` webhook time. | REWRITES MB-1 |
| Payments Realist | Rolling reserve is a timing float, not a fee. Single 30-day cursor permanently misses reserve releases (90–180d) and chargebacks (90–150d). uuidv5 seed missing entityType discriminator collapses corrections silently. GST must be a separate event_type. | REWRITES MB-2, EXPANDS MB-3, ADDS multi-cursor binding |
| Compliance Officer | UTR and payment_id are DPDP financial-pseudonymous identifiers — they bypass the existing PII lint gate and must be boundary-hashed in a new `@brain/razorpay-mapper`. Raw IDs in immutable Bronze are an unremediable breach surface. | ADDS compliance bindings C1–C5 |
| Compliance Officer | Webhook replay has no timestamp/nonce protection in Razorpay's signed body. Three credentials have different threat surfaces; webhook_secret must be independently rotatable. PCI card fields not caught by existing lint. Log-grep gate blind to Razorpay ID patterns. | ADDS compliance bindings C1–C5 |

---

## 2. Final Revised Binding Contract

### MB-1 (CRITICAL — REWRITTEN): Two-Hop Reconciliation Join + Mapping Table + Late-Arrival/Unmatched Policy

The MB-1 framing in 02-cto-intake.md was incomplete. The correct statement:

**The join key problem:** Razorpay settlement items carry `razorpay_order_id` (`order_XXXX`) — a Razorpay-native identifier — NOT the Shopify order ID that Brain's provisional ledger rows are keyed by. A direct `settlement.order_id → ledger.order_id` join fails for every row in production. This is not an edge case; it is the normal case.

**The required join chain:**
```
Razorpay settlement item: payment_id + razorpay_order_id (optional)
    ↓
connector_razorpay_order_map(brand_id, razorpay_order_id, shopify_order_id, razorpay_payment_id)
    ↓ populated at payment.captured webhook time, BEFORE settlement arrives
Brain ledger: shopify_order_id (the provisional row key from the Shopify connector)
```

**Architect must bind:**

1. **New table required:** `connector_razorpay_order_map(brand_id, razorpay_order_id, shopify_order_id, razorpay_payment_id, created_at)` — brand-scoped, indexed on `(brand_id, razorpay_payment_id)` and `(brand_id, razorpay_order_id)`. This table is populated by the `payment.captured` webhook handler (NOT the settlement consumer). It is a prerequisite to the `SettlementLedgerConsumer` producing any correctly-reconciled rows.

2. **Join logic in SettlementLedgerConsumer:** always resolve via the mapping table. Never attempt a direct `settlement.order_id → ledger.order_id` join. If `razorpay_order_id` is absent in the settlement item, resolve via `razorpay_payment_id → razorpay_order_id → shopify_order_id` (two hops, both through the mapping table).

3. **Unmatched settlement policy:** if no mapping table row exists for a given `payment_id` (payment webhook not yet received or webhook processing lagged), the settlement event is PARKED — not silently dropped, not crashed. A metric `settlement_unmatched_count{brand_id, reason}` is emitted and monitored. The event is retried after a configurable hold window (recommended: 15-minute retry, 24-hour escalation to alert). After the escalation window with no match, the event is written as an `UNMATCHED` Bronze row for manual reconciliation, and an alert fires. No silent no-op.

4. **Order-keyless settlement events:** rolling reserve releases and adjustment settlements arrive with no `payment_id` or `order_id`. These must be handled as brand-level (not per-order) settlement events — see MB-3 and the `reconciliation_type` enum below.

5. **Late-arrival (settlement before Shopify order is in Brain):** same park-and-retry policy as unmatched above. The hold window for late-arrival should be longer (recommended: 2-hour retry, 6-hour escalation) to allow the Shopify connector to catch up. The success criteria test for late-arrival (existing requirement §Success metric) must verify the park-and-retry path, not just a silent drop.

---

### MB-2 (CRITICAL — FINALIZED): uuidv5 Seed Including EntityType Discriminator

The seed string for settlement Bronze events must include an `entityType` discriminator to survive Razorpay correction events (which reference the same `settlement_id` but with a different entity type or payment item).

**Finalized seed strings:**

| Event class | uuidv5 seed | Notes |
|---|---|---|
| Per-payment settlement item | `"${brandId}:${settlementId}:${paymentId}:${entityType}:settlement.live.v1"` | entityType = `payment`, `refund`, `adjustment`, `reserve_deduction` |
| Settlement-level summary (no payment_id) | `"${brandId}:${settlementId}:summary:settlement.live.v1"` | For brand-level events (reserve releases, adjustment batch settlements) |
| Webhook event (payment.captured, settlement.processed) | `"${brandId}:${razorpayWebhookEventId}:settlement.webhook.v1"` | razorpayWebhookEventId from event body |

The `ON CONFLICT DO NOTHING` on Bronze remains correct. The fix is entirely in the seed — a correction referencing the same `settlement_id` but a different `entityType` or `paymentId` generates a distinct `event_id` and lands correctly. A truly duplicate re-delivery is safely deduped.

---

### MB-3 (CRITICAL — EXPANDED): Full Event_Type Taxonomy + Order-Keyless Handling

The event_type table from 02-cto-intake.md is incomplete. The finalized taxonomy:

| Razorpay source field / event | Ledger event_type | Row sign | amount_minor | reconciliation_type | Notes |
|---|---|---|---|---|---|
| `settled_amount` (net per payment) | `settlement_finalization` | + | settled_amount in INR paisa | `per_order` | The net credit to the merchant per payment |
| `fee` (MDR / processing fee) | `payment_fee` | - | fee in INR paisa | `per_order` | MDR only; does NOT include GST |
| `tax` (GST on MDR, 18%) | `settlement_tax` | - | tax in INR paisa | `per_order` | Separate from `payment_fee`; carries `tax_code: 'GST_18'` for ITC reconciliation |
| Rolling reserve deduction | `rolling_reserve_deduction` | - | reserve amount in INR paisa | `per_order` | Timing float — NOT a permanent fee; will reverse as a future `rolling_reserve_release` |
| Rolling reserve release | `rolling_reserve_release` | + | release amount in INR paisa | `brand_level` | Arrives 90–180d later; no `order_id` join key; brand-level ledger row against reserve balance account |
| Refund / chargeback | `settlement_reversal` | - | refund amount in INR paisa | `per_order` | Per-order, references original settlement row |
| Adjustment settlement | `settlement_adjustment` | +/- | adjustment amount in INR paisa | `brand_level` | Razorpay bulk correction; may have no `payment_id`; brand-level |

**Critical additions vs. MB-3 original:**
- `settlement_tax` (GST) must be SEPARATE from `payment_fee`. Collapsing them makes ITC claims impossible for India GST-registered brands.
- `rolling_reserve_deduction` must NOT be `payment_fee`. It is a float that reverses; the billing module must understand this distinction.
- `rolling_reserve_release` and `settlement_adjustment` are `brand_level` (no per-order join key). The `SettlementLedgerConsumer` must handle `reconciliation_type = 'brand_level'` events without attempting a ledger row join to a Shopify order.
- The `reconciliation_type` enum (`per_order` | `brand_level`) must be added to the ledger schema (or the event shape) so downstream billing logic can correctly aggregate.

**Unit of reconciliation:** per-payment (not per-settlement-batch). One `settlement_finalization` row per payment within the settlement, joined to the per-order provisional revenue row. This preserves per-order net revenue granularity and matches the Shopify order spine.

---

### MB-4 (HIGH — UNCHANGED): Dedicated SettlementLedgerConsumer + Mandatory E2E Wiring Test

Retained verbatim from 02-cto-intake.md. A dedicated `SettlementLedgerConsumer` (Option A). Wired into `main.ts` (import + instantiate + `consumer.start()` + `consumer.stop()`). Verified by an end-to-end wiring test (real Redpanda produce → consumer subscribe → observed ledger row). This is the third instance of the wired-to-nothing pattern; the wiring test is a mandatory CI gate, not a best-effort check. If a third occurrence is confirmed at review, a durable rule proposal is filed per the lessons-learned threshold.

---

### MB-5 (HIGH — UNCHANGED): SECURITY DEFINER Enumeration Function (Migration 0027)

Retained verbatim from 02-cto-intake.md. `list_razorpay_connectors_for_settlement_repull()` — SECURITY DEFINER, `search_path=public` pinned, `GRANT EXECUTE TO brain_app`, migration-time assertion (`prosecdef=true`, execute grant). Non-inert negative control test mandatory: `brain_app` direct `SELECT` on `connector_instance` without GUC = 0 rows. Multi-resource cursor dispatch must come through this function only.

**New addition from multi-cursor strategy:** the function must dispatch cursor state for ALL three cursor resources per brand (`cursor_settlements_payments`, `cursor_settlements_reserves`, `cursor_settlements_adjustments`) — not just a single high-water mark. The schema change to `connector_cursor` (or `connector_razorpay_cursor`) to hold three rows per brand must be in migration 0027.

---

### MB-6 (HIGH — UNCHANGED): Dev Scheduler Trigger for Settlement Re-Pull

Retained from 02-cto-intake.md. The Architect selects Option A (HTTP endpoint `POST /api/v1/connectors/:connectorId/settlement-repull`, gated `brand_admin+`) or Option B (backfill_job table with `job_type='settlement_repull'`), documents the choice, and ensures the dev test suite can trigger a re-pull deterministically. The trigger must exercise all three cursors in a single run.

---

### MB-7 (MEDIUM — UNCHANGED): Dual-Date Fields + Billing Period Immutability

Retained from 02-cto-intake.md. `economic_effective_at = settlement date`; `billing_posted_period` = current open period if the settlement's natural period is closed. Late-arriving reserve releases (90–180d) and chargebacks (90–150d) always post forward under this rule — they will never be backdated into a closed period. The Architect must document this in the developer guide explicitly, including the expected cash-flow reconciliation lag for reserve releases.

---

### C1 (CRITICAL — NEW): @brain/razorpay-mapper Boundary-Hash for DPDP Financial Identifiers

**Binding:** UTR and `payment_id` are DPDP financial-pseudonymous identifiers — linkable to a natural person via the banking system. They are NOT caught by the existing PII-named-column lint gate (which looks for `email text`, `phone text`, etc.). They must be hashed at the connector boundary using the same `sha256(per-brand-salt || normalized_value)` pattern established by D-10 (`@brain/shopify-mapper`).

**Architect must bind:**
1. A new `@brain/razorpay-mapper` package (or module within the connector) that hashes `utr → utr_hash` and `payment_id → payment_id_hash` before any Bronze write.
2. `settlement_id` linkability assessment: if `settlement_id` alone is not linkable to a natural person (it identifies a batch, not a payment), it may be stored as an opaque operational reference. The Architect must make this call explicitly and document it as a PII data catalog entry.
3. Bronze events and ledger rows carry `utr_hash` and `payment_id_hash` only. The mapping table `connector_razorpay_order_map` carries `razorpay_payment_id` (the raw Razorpay payment ID) for internal join use — this table is NOT a Bronze event table and must be covered by RLS with the same `brand_id` isolation as all connector tables.
4. Raw identifiers may exist ONLY in the mapper boundary layer (in-memory, never persisted, never logged). The mapper must not log raw values at any log level.
5. This is an **Architect-binding decision** (not builder judgment) because failing to hash at the mapper boundary makes the entire Bronze settlement partition in scope for DPDP erasure walks — and Bronze is immutable, leaving no remediation path short of full partition compaction.

---

### C2 (HIGH — NEW): Three-Credential Secret Model + Disconnect Flow

**Binding:** Razorpay credentials (`key_id`, `key_secret`, `webhook_secret`) have different threat surfaces. `key_id`/`key_secret` are compromised via API interception; `webhook_secret` is compromised via endpoint discovery or reverse proxy logging. These require independent revocation paths.

**Architect must bind:**
1. Store all three as named keys in a single composite JSON bundle per `connector_instance`: `{key_id, key_secret, webhook_secret}`. One `secret_ref` per connector_instance (mirrors Shopify pattern).
2. The rotation function for `webhook_secret` must be independently executable — it updates ONLY the `webhook_secret` key in Secrets Manager without touching `key_id`/`key_secret`.
3. **Disconnect flow must explicitly:** (a) call Razorpay's API to deregister the webhook endpoint registration, (b) mark the `secret_ref` as invalidated in Secrets Manager (rotation or deletion), (c) set `connector_instance.status = 'disconnected'` and halt all processing. Silent disconnect with secrets left live is not acceptable.
4. A test must simulate revocation: delete the Secrets Manager secret → connector marks as disconnected within N seconds, all webhook processing halts.
5. A documented revocation SLA: how quickly can the operator rotate `webhook_secret` independently without disrupting the API integration (target: < 5 minutes).

---

### C3 (HIGH — NEW): Webhook Replay Protection (Timestamp Age Check + Redis Event-ID Dedup)

**Binding:** Razorpay HMAC-SHA256 signs the raw body but does NOT include a timestamp or nonce in the signed payload. A captured valid webhook body can be replayed indefinitely. The Bronze `event_id` idempotency is a data-correctness control, not a security control — the Bronze write still occurs on replay.

**Architect must bind:**
1. **Age check at the webhook receiver** (before any processing): reject events whose `created_at` field (in the Razorpay event body) is older than a configurable replay window (recommended: 5 minutes). Return 400 on rejection; log the rejection (hashed event reference only, no raw body).
2. **Redis short-TTL event-ID dedup set:** maintain processed Razorpay `event_id` values in a Redis set with TTL = replay window + processing margin (recommended: 10 minutes). Reject events whose `event_id` is already in the set BEFORE Bronze write. This is a security control; the Bronze dedup is a separate data-correctness control.
3. Both controls operate in the webhook receiver, not in the consumer. The consumer can assume it receives only HMAC-valid, age-valid, non-replayed events.

---

### C4 (HIGH — NEW): PCI SAQ-A Card-Field Allowlist + Lint Extension

**Binding:** Razorpay settlement API responses and payment webhooks may carry card-network metadata (`card.network`, `card.issuer`, `card.international`, `card_last4`, `card_brand`, `card_type`). These are NOT caught by the existing `pan-cvv-column-lint` CI gate (which looks for `pan`, `cvv`, `card_number`, `full_account`). If any of these fields enter Brain's Bronze layer, Brain's PCI SAQ-A scope expands to SAQ-A-EP, triggering a full scoping review.

**Architect must bind:**
1. A **field allowlist** in `@brain/razorpay-mapper`: ONLY the following fields are ingested from Razorpay settlement API responses: `settlement_id`, `payment_id`, `order_id`, `amount`, `fee`, `tax`, `utr`, `status`, `created_at`, `settled_at`, `currency`, `entity_type`. All other fields — including any `card.*` fields — are dropped at the mapper boundary BEFORE Bronze write.
2. Extend the `pan-cvv-column-lint` CI gate to include field/column names: `card_last4`, `card_network`, `card_brand`, `card_issuer`, `card_international`, `card_type`, `card_country`.
3. A CI test that: (a) provides a Razorpay API response fixture containing card-network fields, (b) asserts the emitted Bronze event does NOT contain any of those fields.
4. The allowlist and the test are mandatory CI gates, not code-review expectations.

---

### C5 (MEDIUM — NEW): Log-Grep Gate Extension for Razorpay Financial Identifier Patterns

**Binding:** The existing nightly log-grep gate covers email, phone, and PAN patterns. It does NOT cover Razorpay-specific financial identifier patterns. A developer who accidentally logs a raw Razorpay API response for debugging will pass the gate silently.

**Architect must bind:**
1. Extend the nightly log-grep CI gate with patterns: `pay_[A-Za-z0-9]{14}`, `setl_[A-Za-z0-9]{10}`, `UTR[0-9]{16,22}` (and the full UTR alphanumeric format).
2. The webhook receiver and settlement re-pull job MUST NOT log raw Razorpay API responses or raw webhook bodies at any log level. Structured log fields for settlement events use hashed/truncated equivalents: `settlement_id_hash`, `payment_id_hash`, `utr_hash`.
3. This pattern extension is added in the same commit as the connector code — it is not a separate follow-up ticket.

---

### C6 (HIGH — NEW): Multi-Cursor Strategy (Three Cursor Resources Per Brand)

This is a joint finding from RISK-P3 and RISK-P6 (Payments Realist), binding a distinct multi-cursor architecture:

**The problem:** a single 30-day re-pull cursor advances past reserve release dates (90–180d) and chargeback reversal dates (90–150d), permanently missing them.

**Architect must bind:**
Three separate cursor resources per brand in `connector_cursor` (or `connector_razorpay_cursor`):

| Cursor resource | Window | Poll frequency | Settlement types covered |
|---|---|---|---|
| `cursor_settlements_payments` | 30 days | Daily | Standard payment settlements (T+2) |
| `cursor_settlements_reserves` | 180 days | Weekly | Rolling reserve releases |
| `cursor_settlements_adjustments` | 90 days | Weekly | Chargeback reversals, correction/adjustment settlements |

Each cursor is a distinct row per brand. The `list_razorpay_connectors_for_settlement_repull()` SECURITY DEFINER function dispatches all three cursor states per brand per run. The re-pull job processes all three cursors in a single execution cycle. The migration 0027 schema must include this multi-cursor model.

---

## 3. Scope Tension and Slice Recommendation

There are two competing concerns here. First, the `payment.captured` webhook handler + `connector_razorpay_order_map` population is a STRICT PREREQUISITE for the `SettlementLedgerConsumer` to produce any correctly-reconciled rows. Second, the full settlement reconciliation path (including reserve releases and chargebacks) adds significant complexity.

**My recommendation: ONE slice, with an explicit prerequisite ordering within it.**

The payment.captured webhook handler and mapping table cannot be a separate future ticket. If it is deferred, the settlement consumer writes ZERO correctly-reconciled ledger rows in production — the requirement's core success metric fails entirely. This is not optional scope; it is the mechanism that makes reconciliation possible.

However, the following CAN be deferred within the slice to a second implementation pass (not a separate requirement):
- `rolling_reserve_release` and `rolling_reserve_deduction` event handling: if the initial pass handles only standard `settlement_finalization` + `payment_fee` + `settlement_tax` + `settlement_reversal`, the reserve handling can follow in a fast-follow commit within the same slice. The schema (multi-cursor, reconciliation_type enum, order-keyless handler) must be in from day one; the reserve-specific consumer logic can follow.
- `cursor_settlements_adjustments` (90-day cursor): can be implemented after `cursor_settlements_payments` and `cursor_settlements_reserves` are proven.

**Required in this slice (non-negotiable for a shippable M1):**
1. `payment.captured` webhook handler writing to `connector_razorpay_order_map` (prerequisite, must be FIRST)
2. `SettlementLedgerConsumer` reading from the mapping table (the two-hop join)
3. `settlement_finalization`, `payment_fee`, `settlement_tax`, `settlement_reversal` event_types
4. `rolling_reserve_deduction` and `rolling_reserve_release` event_types (schema + basic consumer logic)
5. Multi-cursor schema in migration 0027 (all three cursor rows, even if only the payments cursor is active in the first iteration)
6. `@brain/razorpay-mapper` with boundary-hash for `utr_hash` and `payment_id_hash`
7. Card-field allowlist + lint extension + test
8. Webhook replay protection (age check + Redis dedup)
9. Three-credential disconnect flow
10. Log-grep gate extension

**Can fast-follow within the same slice (second commit, same branch):**
- `rolling_reserve_release` consumer handling (order-keyless path)
- `cursor_settlements_reserves` and `cursor_settlements_adjustments` polling logic
- `settlement_adjustment` event_type consumer logic

**Explicit deferral (separate future requirement):**
- Billing module understanding of `rolling_reserve_deduction` reversal cycles (the cash-flow view reconciliation)
- GSTR-2B ITC reconciliation reporting
- Automated chargeback workflow integration

**Verdict on scope:** Keep as one slice. The prerequisite ordering (payment.captured webhook + mapping table first) is the Architect's highest-priority structural call. Everything else builds on top of it. Splitting the mapping table into a separate ticket creates a window where the settlement consumer is deployed and silently producing zero correct rows — which is worse than deferring the entire feature.

---

## 4. Consolidated Binding List

| ID | Severity | One-line | Status |
|---|---|---|---|
| MB-1 | CRITICAL | Two-hop join via `connector_razorpay_order_map` (populated at `payment.captured`); park+retry+alert for unmatched; order-keyless path for brand-level events | REWRITTEN |
| MB-2 | CRITICAL | uuidv5 seed = `${brandId}:${settlementId}:${paymentId}:${entityType}:settlement.live.v1`; summary = `${brandId}:${settlementId}:summary:settlement.live.v1` | FINALIZED |
| MB-3 | CRITICAL | Full event_type taxonomy: settlement_finalization, payment_fee, settlement_tax (GST_18), rolling_reserve_deduction, rolling_reserve_release, settlement_reversal, settlement_adjustment; per_order vs brand_level reconciliation_type | EXPANDED |
| MB-4 | HIGH | Dedicated SettlementLedgerConsumer; wired in main.ts; mandatory E2E wiring test; wired-to-nothing occurrence #3 trigger | UNCHANGED |
| MB-5 | HIGH | `list_razorpay_connectors_for_settlement_repull()` SECURITY DEFINER fn in migration 0027; dispatches all three cursor resources; non-inert negative control test | EXTENDED |
| MB-6 | HIGH | Dev scheduler trigger for re-pull; exercises all three cursors per run | UNCHANGED |
| MB-7 | MEDIUM | Dual-date: economic_effective_at = settlement date; late arrivals (reserve releases, chargebacks) always post forward; documented in dev guide | UNCHANGED |
| C1 | CRITICAL | `@brain/razorpay-mapper` hashes utr→utr_hash, payment_id→payment_id_hash at Bronze boundary; raw IDs never in Bronze events, logs, or ledger; settlement_id linkability assessed and cataloged | NEW |
| C2 | HIGH | Three creds in one composite secret_ref bundle; webhook_secret independently rotatable; disconnect = deregister webhook + invalidate secret + halt processing; revocation SLA < 5 min | NEW |
| C3 | HIGH | Webhook receiver: age check (reject created_at older than 5 min replay window) + Redis short-TTL (10 min) event-ID dedup before Bronze write; separate from Bronze data-correctness idempotency | NEW |
| C4 | HIGH | Field allowlist in razorpay-mapper (drop all card.* fields at boundary); extend pan-cvv-column-lint to card_last4/network/brand/issuer/international; CI test asserting card fields absent from emitted Bronze event | NEW |
| C5 | MEDIUM | Extend nightly log-grep gate: pay_[A-Za-z0-9]{14}, setl_[A-Za-z0-9]{10}, UTR[0-9]{16,22}; no raw IDs in structured logs at any level | NEW |
| C6 | HIGH | Multi-cursor: cursor_settlements_payments (30d, daily), cursor_settlements_reserves (180d, weekly), cursor_settlements_adjustments (90d, weekly); three cursor rows per brand in migration 0027 schema | NEW |

---

## 5. Final Verdict

**ADVANCE to Architect (Stage 2).** No persona issued a KILL or CHALLENGE-BACK. The requirement is sound in intent, correctly scoped for M1, and aligned with the Product Canon. The personas materially strengthened the contract — the critical finding (RISK-P1 / two-hop join) was a correctness-breaking assumption that would have produced zero reconciled rows in production; that is now resolved at the design gate rather than in a prod incident.

The binding contract (MB-1..MB-7 + C1..C6, 13 total bindings) is the Architect's contract. All 13 must be addressed in the design plan before any implementation file is written. The conditional from 02-cto-intake.md stands: the Architect waits for `feat-shopify-live-connector` to reach `shipped` before committing any code that imports `@brain/shopify-mapper` patterns or extends migration 0026 functions.

---

## Journal

```markdown
## 2026-06-17T19:50:00Z — Engineering Advisor (cto-advisor) — feat-razorpay-settlement-connector
**Stage:** 1 · **Action:** Synthesis (post-persona) · **Personas:** payments-realist:sonnet + compliance-officer:sonnet · **Decision:** ADVANCE
**Rationale:** RISK-P1 (two-hop join) would have produced zero correct ledger rows in prod silently — caught at gate. COMPL-01 (DPDP boundary-hash) is an unremediable breach surface if missed. Both resolved in binding contract. 13 total bindings (MB-1..MB-7 + C1..C6). Scope is one slice with explicit prerequisite ordering (payment.captured webhook + mapping table first). · **Next:** Stage 2, owner: architect
```
