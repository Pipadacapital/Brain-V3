# Synthetic fixtures — GoKwik + Shopflo (DEV-HONESTY boundary)

> **These are SYNTHETIC dev fixtures. They are NEVER presented as live data.**
> Every row produced from a fixture carries `_synthetic: true` on the Bronze envelope
> `processing_flags` and `data_source: 'synthetic'` in the mapped Silver/Gold properties,
> which drives the `Synthetic (dev)` UI badge. Real partner credentials / sandbox are a
> **platform follow-up** (exactly as Shopify/Razorpay deferred real-credential validation).

## What is REAL vs SYNTHETIC (05-architecture.md §4)

| Domain | Status in Slice 1 | Fixture here? |
|---|---|---|
| Shopflo `checkout_abandoned` | **REAL** (live HMAC webhook) | `shopflo-checkout-abandoned.json` is dev-seed/test only — production source is the webhook |
| GoKwik AWB lifecycle (RTO/Delivered terminal) | **REAL shape, synthetic SOURCE in dev** | `gokwik-awb-lifecycle.json` |
| GoKwik RTO-Predict (categorical High/Med/Low) | **REAL shape, synthetic SOURCE** | `gokwik-rto-predict.json` |
| Settlement / payments-fees / MDR | **SYNTHETIC ONLY** (undocumented for both vendors) | `synthetic-settlement-fees.json` |
| EMI / loyalty (beyond coupons) | **SYNTHETIC ONLY** | `synthetic-emi-loyalty.json` |
| Numeric RTO score | **DOES NOT EXIST publicly** — GoKwik is categorical | **never fabricated** |

## AWB lifecycle fixture shape

`gokwik-awb-lifecycle.json` is an array of AWB records (the shape the dev `GoKwikAwbClient`
returns). It exercises the FULL transition → terminal lifecycle so the trailing-window re-pull
restatement machinery is testable:

- one order that transitions `order placed` → `in transit` → `out for delivery` → `delivered`
  (terminal Delivered → `cod_delivery_confirmed`)
- one order that transitions `order placed` → `in transit` → `rto initiated` → `rto delivered`
  (terminal RTO → `cod_rto_clawback`, signed-negative ledger clawback)

Each record has a `status_changed_at` so distinct transitions get distinct `event_id`s
(`uuidV5FromAwb(brand, awb, status, status_changed_at)`) — terminal states are restated
idempotently on every re-pull.

> NOTE: the e2e test (`gokwik-awb-repull.e2e.test.ts`) writes a **now-relative** temp fixture
> and points `GOKWIK_AWB_FIXTURE_PATH` at it — the committed fixture's fixed May-2026 dates
> drift out of the 45-day trailing window over wall-clock time, so they are NOT used by the
> window-sensitive test. The committed fixture is the dev *job-runner* sample.
