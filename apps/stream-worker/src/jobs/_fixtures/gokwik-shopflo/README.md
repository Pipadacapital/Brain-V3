# Synthetic fixtures — GoKwik + Shopflo (DEV-HONESTY boundary)

> **These are SYNTHETIC dev fixtures. They are NEVER presented as live data.**
> Every row produced from a fixture carries `_synthetic: true` on the Bronze envelope
> `processing_flags` and `data_source: 'synthetic'` in the mapped Silver/Gold properties,
> which drives the `Synthetic (dev)` UI badge. Real partner credentials / sandbox are a
> **platform follow-up** (exactly as Shopify/Razorpay deferred real-credential validation).

## What is REAL vs SYNTHETIC (05-architecture.md §4)

| Domain | Status | Fixture here? |
|---|---|---|
| Shopflo `checkout_abandoned` | **REAL** (live HMAC webhook) | `shopflo-checkout-abandoned.json` is dev-seed/test only — production source is the webhook |
| GoKwik RTO-Predict (categorical High/Med/Low) | **REAL shape, synthetic SOURCE** | `gokwik-rto-predict.json` |
| Settlement / payments-fees / MDR | **SYNTHETIC ONLY** (undocumented for both vendors) | `synthetic-settlement-fees.json` |
| EMI / loyalty (beyond coupons) | **SYNTHETIC ONLY** | `synthetic-emi-loyalty.json` |
| Numeric RTO score | **DOES NOT EXIST publicly** — GoKwik is categorical | **never fabricated** |

> RETIRED (migration 0117): the GoKwik synthetic logistics lifecycle fixture and its re-pull job
> were removed. GoKwik is **webhook-first payments/checkout** and has no logistics-read API —
> logistics truth is **Shiprocket** (`shiprocket-shipment-repull`), not GoKwik.
