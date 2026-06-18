# Requirement: GoKwik + Shopflo data connectors (Slice 1 — Shopflo-led, dev-honest)

| Field | Value |
|-------|-------|
| **req_id** | `feat-gokwik-shopflo-connectors` |
| **Title** | First-party data connectors for Shopflo (self-serve) + GoKwik (RTO-Predict events + AWB-lifecycle re-pull), ingesting CoD/RTO + checkout-conversion into Brain — with honest synthetic fixtures for partner-gated domains |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-18 |
| **Lane** | high_stakes (connectors, money, multi_tenancy, pii, secrets, webhooks/outbound) |
| **Source research** | `docs/data-collection-platform/research-gokwik-shopflo.md` |

## Why now
The India-D2C unit-economics signal Razorpay/Shopify don't carry: CoD verification + RTO
(return-to-origin) and one-click-checkout conversion. Brain READS this data for analytics
(RTO%, CoD CM2, checkout conversion) — it does NOT run checkout.

## The research that drives the design (verified — see research doc)
- **Shopflo is MORE self-serve (lead with it):** merchant self-creates a Channel → static
  **API Access Token** (API-key, NOT OAuth; Merchant-ID from support) AND self-configures a
  **`checkout_abandoned` webhook** (Dashboard → Settings → Integrations) pointing at Brain.
  Rich payload (checkout_id/cart_token, customer, line_items, discount, financial summary).
- **GoKwik is partner-gated + differently shaped:** the only public APIs are (a) `POST
  v2/rto/predict` — synchronous at-checkout, static `appid`/`appsecret` headers, returns a
  **categorical** risk_flag (High/Med/Low — NOT numeric), and (b) the **AWB Service** — RTO
  OUTCOME is a LATE-CHANGING shipment lifecycle (transition → terminal RTO/Delivered
  end-states) = the canonical **trailing-window re-pull** signal. GoKwik abandoned-checkout
  webhooks require GoKwik's integration team (not self-serve).
- **NOT publicly documented for either** → dev-honest **synthetic fixtures only**: settlement/
  payments-fees (domain 3), EMI/loyalty beyond coupons (domain 4), any numeric RTO score,
  rate limits, backfill depth, webhook HMAC scheme.

## Deliverables (Slice 1)
1. **Shopflo connector (REAL, self-serve):** marketplace tile → credential connect (API token +
   Merchant-ID via the secrets seam, never logged); an HMAC-verified `/webhooks/shopflo`
   collector endpoint accepting `checkout_abandoned` (accept-before-validate → Bronze);
   canonical Silver mapping for the checkout-conversion funnel + discount fields.
2. **GoKwik connector (REAL where public):** marketplace tile → credential connect
   (appid/appsecret); capture **RTO-Predict** as order-keyed risk events (risk_flag + reason +
   request_id); an **AWB-lifecycle** connector_instance + cursor with a **weeks-long trailing-
   window re-pull** that RESTATES RTO/Delivered terminal states (→ feeds CoD CM2 / RTO-clawback
   Gold ledger semantics). Reuse the Shopify/Razorpay re-pull pattern.
3. **Dev-honesty (MANDATORY + explicit):** for the partner-gated domains (settlement/fees,
   EMI/loyalty, numeric-RTO) ship clearly-labelled **synthetic fixtures** + a documented dev
   boundary — NEVER fake "live". Real partner credentials/sandbox are a platform follow-up.
4. **UI (MANDATORY — stakeholder-visible):** GoKwik + Shopflo marketplace tiles become
   connectable; a **CoD / RTO analytics surface** (RTO% by pincode/cohort, CoD vs prepaid mix,
   checkout-conversion funnel) reusing the analytics UI (shadcn/Recharts/KpiTile, BFF +
   metric-engine sole-read-path, honest empty + honest "synthetic (dev)" labelling).

## Constraints
- **Reuse the connector framework** — connector_instance/cursor/sync_status, the trailing-window
  re-pull, the marketplace, the secrets seam, the collector accept-before-validate +
  HMAC-verified webhook pattern (mirror Shopify webhooks). Additive migrations only. No new
  deployable.
- Per-brand isolation (RLS FORCE, verify under brain_app — superuser `brain` bypasses RLS so any
  non-brain_app isolation check is INERT). Money BIGINT minor units. PII (email/phone in Shopflo
  payload) hashed at the boundary. Webhook HMAC + replay protection; secrets never logged.
- Brand from the connector/session, never trusted from the webhook body alone (resolve the brand
  from the connector credential/install mapping server-side).

## Non-goals (follow-on)
- Real settlement/fee ingestion + numeric RTO score (need partner agreement — synthetic now).
- GoKwik self-serve abandoned-checkout (GoKwik-team-mediated — defer).
- Writing back to GoKwik/Shopflo (we only READ). Full deterministic checkout→order attribution join.

## Build tracks (the architect will bind)
@data-engineer (Shopflo webhook ingest + GoKwik AWB trailing-window re-pull job + canonical
Silver mapping + synthetic fixtures + migration) ∥ @backend-developer (the two connector
connect flows + secrets + HMAC webhook verify + brand resolution) ∥ @frontend-web-developer
(marketplace tiles + the CoD/RTO analytics surface, honest synthetic labelling). Verify
isolation + webhook HMAC under brain_app. Reuse connector-lifecycle + Shopify-webhook fixtures.
