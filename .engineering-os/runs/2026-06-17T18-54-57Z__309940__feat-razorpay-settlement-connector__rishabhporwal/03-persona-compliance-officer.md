# Dynamic Persona Review — Compliance / Secrets Officer (India DPDP + Payments-Data Scope)

| Field | Value |
|-------|-------|
| **req_id** | `feat-razorpay-settlement-connector` |
| **Persona** | `compliance-officer` — India DPDP 2023 + payments-data + secrets management lens |
| **Timestamp** | 2026-06-17T19:30:00Z |

---

## What this lens sees

The requirement ingests Razorpay settlement data — a rich payload of financial identifiers (settlement_id, payment_id, UTR, order_id, fees, settled amounts). Every one of these fields touches a boundary this lens defends. The DPDP 2023 + I-S02 (no raw PII in events/logs) obligation is stated at the requirement level but the exact classification of payment_id and UTR as PII vs operational ID is left unresolved — the CTO intake flags this as "clarification needed" but does not bind a decision. That is the first gap. The second is secrets structure: the requirement says "key_id + key_secret stored via the secrets seam" but the webhook_secret is mentioned separately without a clear revocation-path story — if the webhook endpoint is compromised, the attacker can forge signed events indefinitely until someone remembers there are THREE credentials to rotate. The third gap is replay protection: the HMAC-first contract (NN-4) is correctly stated but Razorpay webhooks carry no nonce and no timestamp header — HMAC alone does not prevent replay of a captured valid webhook body within the event's natural processing window.

---

## Concerns

### Concern 1 — CRITICAL: UTR and payment_id classification under DPDP is unbound; if treated as operational IDs rather than hashed identifiers, they escape the Bronze boundary-hash and flow into logs/events as raw strings

- **Severity:** Critical
- **Concern:** The requirement says "no raw PII" and the CTO intake flags UTR/payment_id as requiring DPDP clarification, but neither document binds a decision. UTR (Unique Transaction Reference) is a banking system identifier that directly links a payment to a specific bank account and timestamp — under DPDP 2023 "personal data" encompasses any data that, alone or in combination, identifies a data principal. UTR + brand_id is not anonymous: it is traceable to a named bank account holder via the bank's records. Under the DPDP minimization obligation and I-S02 (no raw PII in events, logs, marts, or caches), UTR must be hashed at the connector boundary using the same `sha256(per-brand-salt ‖ normalized value)` pattern as email_hash/phone_hash. The same applies to payment_id (Razorpay's identifier links back to cardholder/UPI handle via Razorpay's records). If these are written raw into Bronze events, logs, or the ledger's `event_payload`, (a) the no-PII schema-lint gate will NOT catch them because the lint looks for PII-named columns (`email text`, `phone text`, etc.) — payment_id and utr are not PII-named, so they silently pass the gate; (b) any breach of the Bronze layer exposes financial-identifier data for every customer whose payment settled through Razorpay; (c) erasure requests cannot crypto-shred these identifiers from Bronze because they are stored by value, not by vault reference, defeating the DPDP erasure guarantee.
- **Rationale:** DPDP 2023 §2(t) defines "personal data" broadly. UTR is pseudonymous-financial-data: linkable to a natural person via the banking system. The compliance-engine skill and COMPLIANCE.md §1 require minimization: "hashed identifiers in all operational tables; raw PII only in the KMS-encrypted vault." The no-PII lint gate is insufficient: it catches PII-named columns but not financial identifiers with non-PII column names. I-S02 explicitly bans raw PII from Bronze events. The Shopify mapper established the `@brain/shopify-mapper` boundary-hash pattern (D-10 binding) — the Razorpay mapper MUST apply the same pattern to UTR, payment_id, and any other linkable financial identifier before they reach Bronze. This decision must be explicitly bound by the Architect (not left to the builder's judgment), because failing to hash at the connector boundary means the entire settlement data set is in scope for DPDP erasure walks — and Bronze is immutable, so there is no remediation path short of erasure-aware Iceberg compaction of the entire settlement partition.

---

### Concern 2 — High: The webhook_secret must be independently rotatable and revocable from the API key pair; a composite single-JSON-bundle secret makes the webhook_secret revocation story ambiguous and creates a window where a compromised webhook endpoint leaks indefinitely

- **Severity:** High
- **Concern:** The CTO intake recommends storing all three Razorpay credentials (key_id, key_secret, webhook_secret) in one composite JSON bundle as a single `secret_ref` per connector_instance, mirroring the Shopify pattern. This is operationally convenient but creates a secrets-management gap: `key_id`/`key_secret` are compromised when an API call is intercepted or a key leaks; `webhook_secret` is compromised when the webhook endpoint URL is discovered and traffic is sniffed or logged. These are different threat surfaces with different revocation triggers. If the webhook_secret is bundled with the API key, rotating it requires updating the entire bundle — which is a single Secrets Manager operation that also invalidates and re-provisions the API key, creating unnecessary churn and coupling two independent security events. More critically: there is no stated revocation-on-disconnect story. When a brand disconnects the Razorpay connector (or a security incident is detected), what happens to the webhook_secret? If it is not explicitly rotated or invalidated in Razorpay's dashboard, the attacker who captured a signed webhook body can continue replaying it against the public ingress endpoint indefinitely. The requirement does not specify what "disconnect" does to the secret lifecycle.
- **Rationale:** I-S09 requires secrets stored by reference only and never in plaintext. The three-credential structure creates a separable threat model: API credential compromise ≠ webhook credential compromise. Best practice (and Stripe/Razorpay's own documentation) is to treat the webhook secret as independently rotatable from the API key pair. The Architect must bind: (a) whether webhook_secret is a separate `secret_ref` entry or a named key within the composite bundle, with an explicit independent-rotation procedure documented; (b) what the connector `disconnect` flow does — specifically whether it calls Razorpay's API to deregister the webhook endpoint and whether the secret is rotated/invalidated on disconnect; (c) what the revocation SLA is (how quickly can Brain's operator rotate the webhook_secret if the endpoint is compromised without breaking the API integration). The requirement states "revocation on disconnect" is in scope for this persona but is completely absent from both the requirement text and the CTO intake.

---

### Concern 3 — High: Webhook HMAC validation has no replay protection; a valid Razorpay webhook body captured once can be replayed indefinitely against the ingress endpoint

- **Severity:** High
- **Concern:** The requirement correctly specifies HMAC-first validation over the raw body (X-Razorpay-Signature, NN-4), 401 on failure, zero side effects. However, Razorpay's webhook signature scheme (HMAC-SHA256 of the raw body with the webhook_secret) does not include a timestamp or nonce in the signed payload. A valid signed webhook body captured via network interception, log leakage, or a misbehaving reverse proxy can be replayed at any time. Since the Bronze idempotency is based on `event_id = uuidv5(brand:settlement_id:...)`, a replay of the SAME payment.captured event will be deduped to one Bronze row — but only if the event carries the SAME settlement_id/payment_id. A replay of a `settlement.processed` webhook for a LARGE settlement could cause the SettlementLedgerConsumer to attempt finalization again; even if the ledger's `ON CONFLICT DO NOTHING` catches the duplicate, the replay still consumes processing resources and generates misleading observability signals. More importantly: a replay attack on a `refund.created` webhook is not automatically safe — the refund ledger row dedup depends on the refund's unique ID being present in the event. If Razorpay webhooks for refunds carry the same event_id across retries (which they do), the ON CONFLICT catches it; but if a replay injects a slightly different payload (e.g., different amount due to a Razorpay API inconsistency), the uuidv5 seed may differ and a second ledger row could be written.
- **Rationale:** The requirement is silent on replay-window mitigation. The Architect must bind: (a) a processing-time check — reject any webhook whose Razorpay-delivered timestamp (available in the event payload's `created_at` field) is older than a configurable replay window (e.g., 5 minutes); (b) a nonce/idempotency-key check — Razorpay sends a `X-Razorpay-Event-Id` (or `event_id` in the body) that can serve as a short-window nonce; the webhook receiver should store processed event IDs in a short-TTL Redis set and reject duplicates within the replay window before they reach the consumer; (c) the dedup on Bronze event_id is necessary but not sufficient as a replay defense — it is a data-correctness measure, not a security measure, because the Bronze write still happens.

---

### Concern 4 — High: PCI SAQ-A boundary could be threatened if Razorpay settlement payloads include card-network metadata or partial card identifiers; the requirement must explicitly assert these fields are excluded from ingestion

- **Severity:** High
- **Concern:** The requirement ingests Razorpay settlement reports including "per-payment breakdown (utr, payment_id, order_id where available)." Razorpay settlement reports and payment webhooks for card payments MAY include card-network metadata: card brand (Visa/MC), card last-4 digits, card type (credit/debit), card country. The requirement does not explicitly state that these fields are excluded from ingestion. If Brain's Razorpay connector ingests card last-4 or card brand into any Bronze event, log, or database column, this constitutes transmission of cardholder data and pulls Brain out of SAQ-A scope into at minimum SAQ-A-EP, triggering a full PCI-DSS scoping review (COMPLIANCE.md §4, I-S10). The `pan-cvv-column-lint` CI gate catches columns named `pan`, `cvv`, `card_number`, `full_account` — but `card_last4`, `card_brand`, `network`, `issuer` would not be caught by this lint rule, allowing card-network metadata to silently enter Brain's perimeter.
- **Rationale:** COMPLIANCE.md §4 states: "Any change that would bring card data into Brain's perimeter requires a Security Reviewer VETO and a full PCI-DSS scoping review before proceeding." The lint gate (I-S10) is name-based and does not catch card-adjacent identifiers. The Razorpay settlement API response includes `method` (card/upi/netbanking), and for card methods may include `card.network`, `card.issuer`, `card.international`. The Architect must bind: (a) a field allowlist for Razorpay settlement ingestion — ONLY the fields required for net-of-fees calculation (settlement_id, payment_id, order_id, amount, fee, tax, utr, status, created_at, settled_at, currency) are ingested; card-network fields are explicitly dropped at the connector boundary BEFORE Bronze write; (b) the no-card-data lint gate must be extended to include `card_last4`, `card_network`, `card_brand`, `card_issuer`, `card_international` column/field names; (c) a test that asserts the Razorpay API response fixture contains card fields but the emitted Bronze event does NOT.

---

### Concern 5 — Medium: No raw financial identifiers (UTR, payment_id, settlement_id) in logs or traces — this constraint is stated but has no enforcement gate specific to the payments path

- **Severity:** Medium
- **Concern:** The CTO intake's success criteria include "No raw UTR / payment_id / settlement_id in Bronze events or logs." The existing `pii_in_logs_incidents = 0` SLO and nightly log-grep gate check for email/phone patterns. Financial identifiers like UTR (format: `HDFC0000000001234567` — 22 chars alphanumeric), payment_id (`pay_XxxXxxXxxXxx` — Razorpay format), and settlement_id (`setl_XxxXxxXxx`) have distinct string shapes that are NOT covered by the existing log-grep patterns (`@.*\.com`, `[6-9][0-9]{9}`, `pan_`). These will silently pass the nightly log-grep gate even if a developer accidentally logs the raw Razorpay API response for debugging and leaves it in production.
- **Rationale:** The compliance-engine skill requires: "Grep new code paths + sample log lines for direct identifiers — none present." The existing grep patterns target personal identifiers (email, phone), not financial transaction identifiers. The Architect must bind: (a) explicit grep patterns for Razorpay financial identifiers added to the nightly log-grep gate: `pay_[A-Za-z0-9]{14}`, `setl_[A-Za-z0-9]{10}`, `UTR[0-9]{16,22}`, and the full UTC reference format; (b) the webhook receiver and settlement re-pull job MUST NOT log the raw Razorpay API response or raw webhook body at any log level — only hashed/truncated references; (c) structured log fields for settlement events must use hashed equivalents: `settlement_id_hash`, `payment_id_hash`, not the raw values.

---

## Recommendations

1. **Bind the D-10 boundary-hash decision for financial identifiers in the Razorpay mapper now, before implementation.** The Architect must produce an explicit PII data catalog entry for: UTR (hash as `utr_hash`), payment_id (hash as `payment_id_hash`), settlement_id (operational reference — assess whether it is a linkable identifier; if in doubt, hash it). The mapper boundary is the ONLY place raw values may exist; Bronze events and ledger rows carry hashes only. The Shopify mapper's `@brain/shopify-mapper` boundary-hash precedent (D-10) must be explicitly extended to the Razorpay mapper. Failure to bind this decision before implementation means the entire settlement Bronze partition is a DPDP breach surface.

2. **Require a three-credential revocation runbook as part of the connector design.** The Architect's design plan must include: (a) a documented trigger for independent webhook_secret rotation (e.g., endpoint compromise, security incident) without forcing API key rotation; (b) a `disconnect` flow that explicitly deregisters the Razorpay webhook endpoint via API and marks the secret_ref as invalidated in Secrets Manager; (c) a test that simulates revocation (delete the Secrets Manager secret → connector marks as disconnected within N seconds, all webhook processing halts, no silent no-op). The webhook_secret should be stored as a named key in the composite bundle (`{key_id, key_secret, webhook_secret}`) with a rotation function that can update ONLY the webhook_secret key without touching the API credentials.

3. **Add replay-window protection to the webhook receiver.** The Architect must bind: a `created_at`-based age check (reject events older than 5 minutes at the receiver) and a Redis short-TTL event_id dedup set (TTL = replay window + processing margin, e.g., 10 minutes). These operate BEFORE the Bronze write and are separate from the Bronze event_id idempotency (which is a data-correctness control, not a security control).

4. **Extend the PCI SAQ-A lint gate to cover card-adjacent field names.** Add `card_last4`, `card_network`, `card_brand`, `card_issuer`, `card_international`, `card_type` to the `pan-cvv-column-lint` gate. Add a field-allowlist test for the Razorpay settlement event shape that asserts card-network fields are stripped at the mapper boundary. This must be an automated CI gate, not a code-review expectation.

5. **Extend the nightly log-grep gate to include Razorpay financial identifier patterns.** Add regex patterns for `pay_[A-Za-z0-9]{14}`, `setl_[A-Za-z0-9]{10}`, and UTR format strings to the existing log-grep CI gate. Log the webhook receiver and settlement re-pull at the DEBUG level only for hashed/truncated identifiers; ensure INFO and above contain no raw Razorpay IDs.

---

## Skills consulted

- `compliance-engine` (the enforcement machinery for DPDP minimization, PII boundary, breach notification, erasure scope)
- `dynamic-persona-spawning` (auto-loaded — the count rule, lens discipline, ≥1-concern contract)

---

## One line for the CTO Advisor synthesis

**The compliance posture has five binding gaps that are unresolved at Stage 1: UTR/payment_id DPDP classification + boundary-hash, webhook_secret independent revocability, HMAC replay-window protection, PCI SAQ-A card-field allowlist enforcement, and log-grep gate coverage for financial identifiers — all five must be Architect-bound before any implementation file is written, but none are blockers to ADVANCE given they are design-time decisions with clear remediation paths.**

---

## Journal stub

```markdown
## 2026-06-17T19:30:00Z — Persona:compliance-officer — feat-razorpay-settlement-connector
**Angle:** India DPDP PII classification of UTR/payment_id + PCI SAQ-A card-field boundary + secrets revocation structure + HMAC replay window + log-grep coverage gap · **Top concern:** UTR/payment_id raw in Bronze events bypasses existing lint gates and creates DPDP breach surface + erasure-impossible partition · **Severity:** H
```
