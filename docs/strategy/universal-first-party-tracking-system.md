# Brain — Universal First-Party Tracking System

**Status:** ~80% already shipped. This document maps the Universal Tracking vision to what exists in
the codebase today (with evidence), what was just built, and the prioritized roadmap to close the rest.

Brain is already a first-party customer-intelligence system: pixel → Kafka → Bronze (Iceberg) →
Silver → Gold → feature layer → insights/recommendations, with deterministic identity resolution and
a connector framework. The vision spec is mostly a re-statement of capabilities that exist — the work
remaining is targeted, not greenfield.

---

## 1. Data collection (event capture)

**Where:** `apps/collector/src/interfaces/rest/pixel-asset.route.ts` (served pixel.js) →
`/collect` → Kafka → `db/dbt/models/staging/stg_touchpoint_events.sql` (allowlist) → `silver_touchpoint`.

| Spec event | Status | Notes |
|---|---|---|
| Page / product / category / collection views | ✅ | `page.viewed`, `product.viewed`, `collection.viewed` (Shopify + WooCommerce URL shapes) |
| Search | ✅ | `search.submitted` (incl. Woo `?s=`) |
| Scroll depth | ✅ | `scroll.depth` 25/50/75/100 |
| Click events | ✅ | `element.clicked` (delegated) |
| **Rage clicks** | ✅ NEW | `rage.click` — ≥3 clicks <1s in a 40px box |
| **Dead clicks** | ✅ NEW | `dead.click` — looks clickable (cursor:pointer) but no handler |
| Add / remove / update cart | ✅ | fetch + XHR + form interception, Shopify + Woo endpoints |
| Checkout started / step | ✅ | `checkout.started`, `checkout.step_viewed` (counts into funnel) |
| **Shipping selected** | ✅ NEW | `W.brain.shippingSelected` → `checkout.shipping_selected` |
| **Payment initiated / success / failure** | ✅ NEW | `W.brain.payment*` (paste on payment screen) |
| **Order placed** | ✅ NEW | `order.placed` auto-fires on the thank-you page (behavioral marker, **not** revenue) |
| **Coupon usage** | ✅ NEW | `coupon.applied` (discount/coupon/promo field) |
| Login / signup | ✅ | `user.logged_in`, `user.signed_up` (Shopify + Woo forms) |
| **Form submissions** | ✅ NEW | `form.submitted` (newsletter/contact) |
| UTM / campaign ids | ✅ | utm_*; click-ids fbclid/gclid/ttclid/msclkid/gbraid/wbraid/dclid + cookie _fbc/_fbp/li_fat_id/epik |
| Device / browser | ✅ | ua_class, viewport (privacy-preserving) |
| Refunds / returns | ✅ (connector) | Deterministic via order/logistics connectors, **not** the pixel (revenue truth) |
| Video interactions | ⛔ GAP | Needs a player adapter (YouTube/Vimeo/HTML5) — roadmap |
| Geo / location | ◑ partial | Derivable from IP at ingest; not yet enriched onto touches — roadmap |

Works across desktop, mobile web, PWA, checkout/payment/thank-you pages (the last three via a pasted
script, since a storefront ScriptTag cannot run on the checkout origin).

**Session duration** needs no new event — it is `max(occurred_at) − min(occurred_at)` per
`session_key` in `silver_touchpoint`.

---

## 2. Customer identity

**Where:** `packages/identity-core` (per-brand salted SHA-256), `apps/stream-worker/.../IdentityResolver.ts`
(deterministic merge), `packages/identity-graph` (Neo4j), migrations 0090/0095.

| Spec identifier | Status |
|---|---|
| Anonymous id / session id | ✅ `brain_anon_id` + 30-min session, client-minted |
| Email / phone | ✅ hashed, strong tier (E.164 phone normalization) |
| Customer id / order id / checkout id | ✅ storefront_customer_id + connector order ids |
| Browser identifiers | ✅ device_id (medium tier) |
| **Anonymous → known merge** | ✅ the pixel hashes email **client-side, unsalted** → matches an order's `pre_hashed_email` → resolver links the anon journey to the customer (no raw PII on the wire, ADR-2) |

Deterministic, replay-safe, brand-isolated. **Gap:** consent-state check before linking; probabilistic
matching (intentionally deferred — deterministic-first).

---

## 3. Attribution

**Where:** `packages/metric-engine/src/attribution-models.ts`, `attribution-credit.ts`,
`attribution-clawback.ts`, `gold_attribution_paths.sql`, `gold_marketing_attribution.sql`.

| Model | Status |
|---|---|
| First / last touch | ✅ |
| Linear | ✅ |
| Position-based (U-shaped) | ✅ (default) |
| **Data-driven** | ⛔ GAP — roadmap (Markov / Shapley over `silver_touchpoint`) |

Integer-only weights, closed-sum guaranteed (Σ credit = realized revenue exactly), refund-aware.
Channels covered via click-ids + UTM: Meta, Google (search + display + iOS), TikTok, Bing, LinkedIn,
Pinterest, email, WhatsApp/referral/direct/organic (classified in `silver_touchpoint`).

---

## 4. Customer insights

**Where:** `packages/metric-engine/src/insights.ts` (8 detectors) + the gold marts.

✅ Customer journeys (`gold_attribution_paths`, journey UI) · conversion funnels & drop-off
(`storefront-funnel.ts`) · checkout abandonment (`silver_checkout_signal`, abandoned-cart mart) ·
session analytics & engagement (`storefront-engagement`) · conversion rates · product performance
(`silver_order_line`, product_concentration) · cohorts (`gold_cohorts`) · CLV/RFM/churn
(`gold_customer_scores`, `gold_customer_360`) · repeat/retention · CAC (`gold_cac`) · campaign &
channel effectiveness (blended ROAS + attribution). Geographic/device analysis: device ✅, geo ◑ (see §1).

**Gaps:** predictive churn/CLV (ML), behavioral clustering, anomaly detection (roadmap, on the ML platform).

---

## 5. AI recommendations

**Where:** `apps/core/src/modules/recommendation` (4 detectors: rto_risk, realization_gap,
margin_erosion, scale_opportunity) + `insights.ts` (8) + ML registry/serving in `apps/core/src/modules/ml`.

Closed decision loop: detect → raise → action ledger → measure outcome (then-vs-now). Confidence-gated
(Trusted/Estimated/Insufficient). Covers: conversion-drop reasons, checkout bottlenecks (now sharper
with rage/dead clicks), high-value segments (VIP concentration), best/worst channels & campaigns,
retargeting/upsell/growth opportunities.

**Gap:** LLM narrative layer over the structured detector output ("Copilot briefing"); real-time
(vs daily) scoring. Roadmap.

---

## 6. Connectors (universal framework)

**Where:** `apps/core/src/modules/connector/sources/` + `apps/stream-worker/src/jobs/`.

✅ Shopify, WooCommerce (storefront) · GoKwik, Shopflo (checkout) · Razorpay (payment) ·
Google Ads, Meta (ad spend) · GA4 (analytics) · Shiprocket (logistics). Webhook + backfill/repull
per source; `connector-core` kernel + `PixelInstallerRegistry` make new platforms additive.

**Gaps:** email/SMS/WhatsApp ESP, CRM, marketplaces (Amazon/Flipkart) — scaffolds exist, unimplemented.

---

## What was just shipped (this stream)

1. `checkout.step_viewed` → funnel checkout stage (funnel no longer structurally 0).
2. Multi-storefront pixel (Shopify + WooCommerce) + client-side identity bridge.
3. **Storefront-agnostic `PixelInstaller` registry** — connect a storefront, Brain offers exactly its
   install option; a new platform = register one installer (no edits to existing ones / routes / UI).
4. **WooCommerce one-click install** (Brain Pixel WP plugin + authenticated REST config + dashboard
   download) — the honest parallel of Shopify's one-time OAuth authorization.
5. Universal capture: rage/dead clicks, coupon, forms, payment & order funnel.

## Prioritized roadmap (remaining gaps)

| Priority | Gap | Where it lands |
|---|---|---|
| P1 | Data-driven attribution (Markov removal-effect) | `metric-engine` + `silver_touchpoint`; new `gold_attribution_datadriven` |
| P1 | LLM narrative over detector output (Copilot briefing) | `intelligence` + `recommendation` (gateway already present) |
| P2 | Predictive churn / CLV models | ML platform (registry + serving exist) → `gold_customer_scores` |
| P2 | Geo enrichment at ingest (IP → region, residency-aware) | collector / `silver_touchpoint` |
| P3 | Video-interaction adapter | pixel.js |
| P3 | ESP / CRM / marketplace connectors | `connector/sources/*` scaffolds |

**Invariants preserved throughout:** deterministic-first; revenue truth over platform truth (pixel
never sources money); no event loss; brand isolation; no raw PII / no salt on the wire (ADR-2);
every behavioral signal flows Bronze → Silver → Gold before it informs a decision.
