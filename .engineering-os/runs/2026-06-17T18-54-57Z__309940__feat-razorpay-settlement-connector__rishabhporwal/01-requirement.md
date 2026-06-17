# Requirement: Deep Razorpay-with-settlement connector — net-of-fees realized revenue (the honest-bill money path)

| Field | Value |
|-------|-------|
| **req_id** | `feat-razorpay-settlement-connector` |
| **Title** | Deep Razorpay connector — settlement ingestion + payment webhooks (HMAC-first) finalizing realized revenue NET of fees through the append-only ledger |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-17T18:54:57Z |
| **Tier impact** | Connector-ingestion epic §7 (the money path) — Phase-1a deep connector; makes realized revenue honest (net, not gross) |
| **Region impact** | India (Razorpay INR; MDR/referral/rolling-reserve fees 15–35%; settlements arrive/correct days after capture) |

---

## Lane *(set by the Engineering Advisor at Stage 1)*

| Field | Value |
|-------|-------|
| **feature_class** | high_stakes |
| **feature_class_rationale** | deterministic scan — trigger surfaces: connectors, money, multi_tenancy (advisor to add: pii, secrets/oauth, schema_proto, outbound_channel) |
| **trigger_surfaces_touched** | connectors, money, multi_tenancy (+ pii, secrets, schema_proto, outbound_channel — advisor confirms) |

---

## Raw text (from the Stakeholder)

> Build the **deep Razorpay-with-settlement connector** — Phase-1a's money-truth must-have ("there's no honest bill without it"). The Shopify live connector (shipped) gives the order spine: provisional revenue is recognized at placement, RTO/cancel creates negative ledger rows. But realized revenue is still GROSS GMV — gross-of-fees, horizon-finalized but not net of what Razorpay actually deducted. This connector closes the money loop: ingest the Razorpay daily settlement file/report + payment webhooks, capture the marketplace/prepaid fees (referral/closing/MDR/rolling-reserve, often 15–35%), and FINALIZE realized revenue net-of-fees through the SAME append-only ledger spine.
>
> DELIVER:
> 1. **Connect:** Razorpay credentials (key_id + key_secret) stored via the secrets seam (DEV-TOKEN-REACH dev_secret / prod AWS), brand-scoped, never logged. Reuse the connector_instance + connector marketplace tile pattern (provider='razorpay').
> 2. **Settlement ingestion (the catch-up/truth path):** pull the Razorpay settlements API / settlement report on a schedule — settlement_id, settled amount (minor units, INR), fees, tax, the per-payment breakdown (utr, payment_id, order_id where available) — cursor-tracked in connector_cursor (resource='settlements', high-water = settlement created_at/date). Trailing 30-day re-pull window (settlements correct/arrive late). Reuse the stream-worker job pattern from the Shopify 35-day re-pull (SECURITY DEFINER enumeration fn, FOR UPDATE SKIP LOCKED overlap-lock, no-GUC negative control, GUC set before brand reads). Land on the LIVE lane (dev.collector.event.v1) as settlement events.
> 3. **Payment webhooks (the freshness path, dev = synthetic HMAC-signed POSTs like Shopify):** payment.captured / payment.failed / refund.created / settlement.processed → HMAC-first validation over the raw body as the ABSOLUTE FIRST op (Razorpay X-Razorpay-Signature, the webhook secret), brand resolved from the account→connector mapping (asserted from connector_instance, NEVER the webhook body), mapped to the same event shape, emitted to the live lane. dev-honesty: real public ingress is a platform follow-up; prove with synthetic signed POSTs.
> 4. **Net-of-fees finalization through the ledger (the core deliverable):** a settlement event reconciles to the provisional order revenue (join on order_id / payment_id), captures the fee components, and writes the FINALIZED realized-revenue ledger rows NET of fees as NEW signed rows (provisional → finalized delta + a fee/MDR line) — append-only, never an edit, per-currency INR, integer minor units, no float. A refund/chargeback settlement = a new negative row. The dual-date rule: economic_effective_at (settlement date) drives as-of math; closed billing periods immutable (late reversals post forward). Marketplace/prepaid fees are captured BEFORE the order counts as realized — realized is net, not gross.
> 5. **Idempotent + dedup:** deterministic event_id (uuidv5 from brand:settlement_id:... namespace, distinct from the order namespaces) so re-pull + webhook + report of the same settlement collapse to one Bronze row; ledger ON CONFLICT DO NOTHING; effectively-once.
> 6. **Per-brand isolation (the ONE invariant):** RLS FORCE, verify cross-brand = 0 under SET ROLE brain_app (assertBrainApp); no raw PII; secrets from the seam.
> 7. **Sync health:** connector_sync_status reflects settlement sync (syncing/connected + last_sync_at); the dashboard realized-revenue number updates from gross→net as settlements land, and the connection tile stays truthful.
> 8. **Automated tests:** a synthetic settlement report → net-of-fees finalized ledger rows (provisional sale untouched, new finalized + fee rows); HMAC-invalid webhook → 401 no write; the 30-day re-pull cursor advances/resumes + overlap-lock; settlement webhook + re-pull dedup to ONE Bronze row; a refund settlement → new negative ledger row; isolation negative-control under brain_app; the no-GUC negative control on the enumeration fn.

---

## Problem statement

The Shopify live connector recognizes revenue at placement (provisional) and reverses on RTO/cancel — but "realized" revenue is still **gross GMV**: it does not yet reflect what Razorpay actually deducted (MDR, referral/closing fees, rolling reserve — 15–35% in India). Brain bills on realized revenue, so without the settlement file there is **no honest bill**. The settlement connector ingests Razorpay's authoritative settlement data and finalizes realized revenue **net of fees** through the same append-only ledger, so the dashboard number moves from gross→net as settlements land — and the bill is truthful.

## Target user

Owner / Brand Admin of an India DTC brand (Boddactive) whose realized-revenue number — and therefore their Brain bill — must reflect actual money received net of payment fees. M1.

## Success metric

A synthetic Razorpay settlement report reconciles to provisional order revenue and writes finalized net-of-fees ledger rows (provisional sale row untouched; new finalized + fee/MDR rows); a refund settlement writes a new negative row; settlement webhook/re-pull/report of the same settlement = ONE Bronze row (event_id dedup); the 30-day re-pull cursor advances/resumes with overlap-lock; cross-brand = 0 under brain_app; the dashboard realized number visibly shifts gross→net. Proven by automated tests (+ optional real Boddactive settlement validation).

## Constraints

- **Same code path / same Bronze shape / same append-only ledger** as the order spine — reuse the Shopify-live-connector patterns (SECURITY DEFINER enumeration fn precedent from migration 0026, the LedgerWriter reversal/recognition methods, the live-lane emission, the connector-lifecycle-regression fixtures + assertBrainApp).
- **HMAC-first (NN-4):** Razorpay X-Razorpay-Signature validated over the RAW body as the absolute first op; any failure → 401, no processing. brand_id from the connector mapping, never the webhook body.
- **Money:** append-only ledger, status/fee changes are NEW signed rows; integer minor units BIGINT + currency_code (INR), no float. Net-of-fees BEFORE realized.
- **WIRE THE CONSUMER INTO main.ts** — the wired-to-nothing watch is at occurrence #2 (ADR-BF-9, ORCH-LV-H1). A settlement-recognition consumer built but not started in the deployable = occurrence #3 → triggers the durable-rule proposal.
- Absolute brand/tenant isolation (the ONE invariant); RLS FORCE; verify under SET ROLE brain_app. No raw PII. Token from the secrets seam, never logged.
- Idempotent + replayable: Bronze insert-if-absent on event_id; cursor upsert on connector_cursor.
- Hard rule: **no NEW deployable** — webhook receiver in core, settlement re-pull as a stream-worker job, the live lane + connector_cursor + connector_sync_status exist. Migrations additive.

## Non-goals

- Net-banking/UPI reconciliation beyond what Razorpay settlement reports give; Razorpay Route / marketplace split-payments.
- Non-Razorpay PSPs (Cashfree / PayU = later slices).
- The full DQ A+→D gating + connector-health detector / tracking-dark (later slice).
- Prod public webhook ingress (tunnel/ingress) + Argo cron orchestration of the re-pull (platform follow-ups) — dev proves with synthetic signed POSTs + triggered re-pull (be HONEST about this dev limitation, as Shopify was).
- Settlement-to-billing-period posting engine beyond writing the dual-date fields (the billing close engine is a separate slice).

## Linked prior runs

- feat-shopify-live-connector (the live lane, the re-pull job pattern, migration 0026 SECURITY DEFINER fns, LedgerWriter, LiveLedgerBridgeConsumer wiring lesson, @brain/shopify-mapper boundary-hash pattern)
- feat-realized-revenue-ledger (the append-only recognition spine the net-of-fees rows flow through)
- feat-connector-backfill / feat-connector-marketplace (connect + secret_ref + connector_instance + the paged client + the cursor)
- chore-connector-lifecycle-regression (the FROZEN fixtures + assertBrainApp helper to reuse)

## Notes

- **Architect must bind:** where the settlement→ledger reconciliation lives (a new stream-worker consumer on the live lane filtering settlement events, vs extending the LiveLedgerBridgeConsumer — and WIRE IT into main.ts); the settlement event shape + the new uuidv5 namespace (`settlement.live.v1` — distinct from order.live.v1 / order.backfill.v1 so no dedup collision); how a settlement reconciles to the provisional order revenue (join key: order_id when Razorpay carries it, else payment_id→order mapping — and what happens when the order isn't in Brain yet, ordering/late-arrival); the fee decomposition into ledger rows (one finalized delta row + one fee row, or a single net row — bind the event_type taxonomy: `settlement_finalization`, `payment_fee`, `settlement_reversal`); the dual-date fields on the ledger (economic_effective_at = settlement date; billing_posted_period); the Razorpay settlements API client (reuse the paged-client pattern; rate-limit aware); the webhook receiver (core, raw-body, HMAC-first, brand from account_id→connector_instance); the SECURITY DEFINER enumeration fn for the settlement re-pull (migration 0027, mirroring 0026); the dev-honesty boundary.
- Builder tracks: **@backend-developer** (Razorpay webhook receiver + HMAC + brand resolution + connect/secret + sync_status) ∥ **@data-engineer** (the settlement re-pull job + cursor + settlements API client + the live-lane landing + the net-of-fees reconciliation consumer + WIRE IT) ∥ **@frontend-web-developer** (the realized gross→net indicator on the dashboard + the Razorpay connection tile/health). Verify isolation under SET ROLE brain_app. Reuse connector-lifecycle-regression fixtures.
- This is the slice that makes Brain's bill HONEST — it converts horizon-finalized gross GMV into net-of-fees realized revenue, the India money path the whole architecture is shaped around.
