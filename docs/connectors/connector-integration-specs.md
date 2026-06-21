# Brain Connector Integration Specs (authoritative)

> This file collects the authoritative connector specs requested via /deep-research:
> **GoKwik (payments)**, WooCommerce (storefront), Shiprocket (logistics), Shopflo (payments).
> Each is grounded in (a) a codebase audit of what already exists and (b) a verified
> deep-research run on the vendor's public capabilities (gaps flagged honestly).
>
> **BUILD STATUS (shipped to master):** WooCommerce (backfill + live REST + real-time webhook),
> Shiprocket (Slice 1 + live-read scaffold), the multi-source logistics Silver surface, and the
> Storefront Behavior analytics surface are all MERGED. GoKwik + Shopflo were consolidated in place.
> The partner-doc-blocked remainder (GoKwik OTP/checkout, Shopflo Tier-B, Shiprocket NDR/COD-
> remittance/freight/real-time-webhook) is tracked in docs/connectors/shiprocket-partner-blockers.md
> and the per-spec "partner-gated" sections below. The "▶ IMPLEMENTATION PLAN — Shiprocket Slice 1"
> section near the end is a historical record (executed + merged).

---

## CORE PRINCIPLE (applies to ALL four connectors)

**Uniform ingestion, category-driven normalization.** The ingestion pipeline is identical
for every connector and ALREADY EXISTS — no connector invents its own:

```
Source (webhook OR pull/repull job)
  → CollectorEventV1 envelope  (brand_id, event_id [uuidv5], event_type, occurred_at,
                                schema_version, payload, processing_flags{_synthetic})
  → collector_spool            (durable, accept-before-validate, D-1 ordering)
  → Redpanda {APP_ENV}.collector.event.v1   (partition key = brand_id)
  → bronze_events / Iceberg    (raw payload preserved; idempotent PK (brand_id, event_id))
  → dbt Silver normalization   (CATEGORY-SPECIFIC — the only connector-authored mapping)
  → metric-engine / dbt Gold   (non-additive aggregation; sole-emitter per ADR-002)
```

The connector's **catalog category** (storefront | payments | logistics | …) is the routing
key that selects the Silver normalizer. Per-connector code is therefore minimal:
**(1) a source adapter** (webhook handler or repull job that emits the envelope) and
**(2) a mapper** (raw → envelope, PII-hashed at the boundary). Everything else is inherited:
replay, backfill, tenant isolation (RLS + the Silver brand-seam), schema-version, DQ, health.

This is why the GoKwik+Shopflo → `payments` recategorization (merged, PR #196) mattered:
category is the normalization router.

---

# SPEC 1 — GoKwik (category: payments) — RE-ARCHITECTURE & CONSOLIDATION

## 1. Executive summary

GoKwik is a **critical connector but with an HONEST, bounded scope.** The deep-research run
(verified, 20 confirmed / 5 refuted claims) establishes that GoKwik exposes **almost no public
server-to-server data contract**. What Brain can reliably ingest splits into three tiers:

| Tier | Surface | Status in Brain | Buildable today? |
|------|---------|-----------------|------------------|
| **A — solid** | AWB shipment-lifecycle feed | ✅ built (`gokwik-awb-repull` → RTO/Delivered ledger) | yes |
| **A — solid** | RTO Predict output (categorical risk_flag + reason) | ⚠️ emitted synthetically (`gokwik-rto-predict-emit`) | yes, but capture point is at-checkout |
| **B — partner-gated** | Abandoned-checkout webhook | ❌ not built | only after partner provisioning + docs |
| **C — partner-gated/unknown** | OTP/phone verification status, COD-verification fields, checkout-session/step, payment-selection | ❌ not built | **blocked** — no public schema; needs GoKwik partner docs |

**Verdict on the final questions:** GoKwik is critical (it is the RTO/COD truth source —
India's #1 revenue-leakage cause). It improves **Revenue Truth** (CoD recognition/clawback —
already wired) and **Decisions** (RTO risk → COD interventions) **today**. It *could* improve
**Identity** (phone-first OTP) and **Journey** (checkout steps) **only once partner data access
is secured** — those must not be designed as if the data is in hand.

The re-architecture consolidates the currently-scattered GoKwik code (AWB repull, RTO-predict
emit, AWB-ledger consumer, COD/RTO metrics) under one coherent **payments-category medallion
design**, and lays clearly-marked seams for the partner-gated surfaces so adding them later is
config + mapper, not re-architecture.

## 2. GoKwik capability review (verified facts → ingestible fields)

- **RTO Predict API** (only public contract): `POST v2/rto/predict`, headers `appid`+`appsecret`
  (Merchant Dashboard → Account). **Inline/synchronous** at checkout (TP99 200ms, 500ms hard
  timeout) — *not* a webhook. Success `data` = `{ request_id, risk_flag ∈ {High|Medium|Low Risk}, reason }`.
  No numeric score exposed. Reason codes map to internal "Klotho" rules (Duplicate Order,
  Address too short/incomplete, Known RTOer, Blacklisted phone/pincode/product/UTM, High RTO Intent).
  **Ingestible:** request_id (correlation/idempotency), risk_flag (3-band), reason (enumerable code).
- **AWB Service** (merchant→GoKwik feedback): shipment states (placed, shipped, in-transit,
  out-for-delivery, delivered, RTO + sub-states, lost, damaged, returned) + AWB number.
  **Directionality caveat:** docs describe merchant *pushing* AWB to GoKwik; Brain's repull
  assumes a readable feed — confirm read access in partner docs.
- **Smart COD Suite / KwikPass**: risk-tiered interventions (block/verify-OTP/captcha/partial-COD),
  phone-first OTP login (phone = primary identifier). **No public data-field schema** for
  verification status/confidence/tier → Tier C.
- **Mobile wrappers** (Flutter/React-Native) emit 20+ **client-side** `onEvent` callbacks
  (order-complete, payment-method-selected, login_otp_verification_passed/failed, address-selected,
  coupon-applied…). These reveal GoKwik's event taxonomy but are **client-side, not a server
  ingestion contract** — do not build backend ingestion on them.
- **Gaps (must obtain partner docs):** webhook event-type names, payload shapes, delivery/retry/
  HMAC, idempotency keys, historical/batch export + pagination + rate limits, non-RTO auth model.

## 3. Connector architecture (consolidated)

- **Auth:** `appid` (non-secret, on `connector_instance.gokwik_appid`, indexed for enumeration)
  + `appsecret` (secret → AWS Secrets Manager `secret_ref` in prod / `dev_secret` in dev,
  I-S09 never logged). Mirrors Razorpay/Shopflo. No token refresh documented (key-pair only).
- **Sync model:** PULL/repull (no reliable inbound webhook in Tier A). Two jobs, both already
  on the generic envelope path: `awb.lifecycle` (45-day trailing re-scan, late-changing
  lifecycle, cursor = max(status_changed_at)), and RTO-predict emit. Enumeration via the
  SECURITY DEFINER fn `list_gokwik_connectors_for_awb_repull()` (RLS-safe: GUC set AFTER enumerate).
- **Consolidation actions (the re-architecture):**
  1. Keep both repull jobs but unify their **mapper** (`@brain/gokwik-mapper`) and event-naming
     under one versioned namespace (`gokwik.awb_status.v1`, `gokwik.rto_predict.v1`).
  2. Route the RTO-predict **real** capture (when partner access lands) through the SAME envelope —
     today it is `_synthetic: true`; flipping to real is a data-source change, not new plumbing.
  3. Introduce the **payments-category Silver normalizer** (see §4) — currently the COD/RTO
     metrics read straight from Bronze; consolidation adds the canonical Silver layer they should
     read instead (closes the "no checkout-session Silver table" gap honestly).
- **Failure/health:** `connector_auth_rejected_total{provider='gokwik'}` on 401/403; sync_status
  (connected|syncing|error, last_error); DQ checks (freshness, row_count) on each resource.

## 4. Medallion design + canonical mapping (payments category)

**Bronze** (unchanged, generic): raw GoKwik payload + envelope. Tier-A events land today;
Tier-B/C events land the same way once a source adapter exists. Nothing GoKwik-specific.

**Silver** — NEW payments-category canonical entities (dbt marts, brand-first, replay-safe).
Classification vs existing Brain schema (Phase 11):

| GoKwik signal | Canonical target | Classification |
|---------------|------------------|----------------|
| AWB terminal RTO | `realized_revenue_ledger` `cod_rto_clawback` | **existing** (0030) ✅ |
| AWB terminal Delivered | `realized_revenue_ledger` `cod_delivery_confirmed` | **existing** (0030) ✅ |
| AWB tracking states (non-terminal) | `silver_shipment_event` (shared w/ Shiprocket logistics spec) | **new mart, raw-backed** |
| RTO risk_flag + reason | `silver_risk_signal` (order_id, risk_flag, reason_code, source='gokwik', occurred_at) | **new canonical entity** |
| OTP/phone verification | identity-hint → `customer` confidence inputs | **new field, PARTNER-GATED** (do not build yet) |
| COD confirmation | payment/ledger (already via AWB) | **equivalent** |
| Checkout session/step | `silver_checkout_session` (shared w/ Shopflo) | **new, PARTNER-GATED** |
| Payment-method selected | checkout_session attribute | **PARTNER-GATED** |
| Address completeness | `has_address` boolean only (PII-reduced) | **raw-only beyond boolean** |

**Gold:** RTO-rate cohorts (by pincode), CoD CM2 / CoD-vs-prepaid mix, RTO-risk distribution —
ALL already emitted by metric-engine (`cod-rto-rates`, `cod-mix`, `cod-rto-prediction`) as
sole-emitters (ADR-002). Re-point them at the new Silver entities once those exist (today they
read Bronze directly — acceptable, but Silver is the durable seam).

## 5–10 (real-time, historical, identity, journey, revenue, decisions) — condensed

- **Real-time:** N/A for Tier A (pull-only). Abandoned-checkout webhook (Tier B) would ride the
  collector→Bronze path with HMAC verify at the handler (mirror the Shopflo handler exactly).
- **Historical/backfill:** AWB 45-day re-scan IS the backfill (idempotent restatement via
  uuidv5(brand,awb,status,status_changed_at)). Deeper history → partner export API (unknown; gap).
- **Identity:** phone-first OTP is GoKwik's strongest *potential* identity contribution (phone =
  deterministic key) — **but Tier C, partner-gated.** Spec it as a future identity-hint feed into
  the existing `customer`/salted-phone-hash model; DO NOT claim it as available.
- **Journey:** checkout-step events would strengthen journey/touchpoints — **Tier C, partner-gated.**
- **Revenue Truth:** delivered TODAY — CoD recognition + RTO clawback via the ledger (the single
  highest-value GoKwik contribution; this is why GoKwik is critical).
- **Decisions:** RTO risk_flag + reason → signals → "verify/block COD" + "high-RTO-pincode"
  decision candidates → recommendations. Reason-code taxonomy is the candidate vocabulary.

## 11–17 (db impact, events, DQ, observability, scale, negative) — condensed

- **DB impact:** additive only — new Silver marts (`silver_risk_signal`, `silver_shipment_event`,
  later `silver_checkout_session`); NO new business tables, NO new DB/service. `connector_instance`
  already supports gokwik (0030). Reject: numeric RTO score (not exposed → never fabricate).
- **Events:** `gokwik.awb_status.v1`, `gokwik.rto_predict.v1` exist; reserve `gokwik.checkout.*`,
  `gokwik.cod.verified.v1`, `gokwik.otp.verified.v1` names for partner-gated Tier B/C. Producer =
  repull/webhook adapter; consumers = bronze-bridge + AWB-ledger consumer; versioned `.vN`.
- **DQ/observability:** freshness + row_count per resource into `dq_check_result`; auth-rejected
  counter; sync lag; the `_synthetic` flag drives the honest dev badge (RTO-predict is synthetic
  until real capture lands — surface that, never hide it).
- **Scale (100/500/1000 brands):** AWB volume ≈ orders × lifecycle-transitions; 45-day re-scan is
  the cost driver — bound by per-connector cursor + SKIP LOCKED claiming; storage linear in Bronze.
- **Negative review:** duplicate AWB transitions → uuidv5 + ledger UNIQUE(brand,order,type,date)
  dedupe; missing partner data → fail honest (no fabrication); RTO timeout at checkout → GoKwik
  fails-open at merchant, Brain just won't see that event (gap, acceptable).

## 18. Final recommendations (GoKwik)

1. **Ship the consolidation now** (Tier A): unify mappers/event-naming, add `silver_risk_signal`
   + `silver_shipment_event`, re-point COD/RTO Gold metrics at Silver. No partner dependency.
2. **Gate Tier B/C behind partner documentation** — create a tracked "GoKwik partner data access"
   blocker; do NOT build OTP/checkout/COD-verification ingestion on guessed schemas (research
   refuted several guessed payloads — proof that guessing is unsafe here).
3. **Honesty invariant:** RTO is categorical (3-band) — never synthesize a numeric score; keep the
   `_synthetic` provenance badge until real RTO capture is wired.

---

# SPEC 2 — WooCommerce (category: storefront) — SECOND STOREFRONT SOURCE

## 1. Executive summary

WooCommerce is a **Tier-1 storefront connector** and, unlike GoKwik, is **fully buildable from
public docs** (verified: REST `wc/v3`, consumer-key auth, HMAC-SHA256 webhooks, WP pagination —
23 confirmed / 2 refuted claims). The decisive architectural point: WooCommerce maps to the
**SAME canonical entities Shopify already populates** (`silver_order_state`, `silver_order_line`,
`customer`, product marts, `realized_revenue_ledger`). Per the uniform-ingestion principle, this
is **not a new integration shape** — it is *"Shopify's storefront normalizer, second source."*

New connector-authored code is minimal: **(a) a WooCommerce source adapter** (webhook handler +
REST backfill job) and **(b) `@brain/woocommerce-mapper`** that emits the SAME canonical envelope
Shopify emits. The dbt Silver models and the revenue ledger are source-agnostic and need no
redesign — only a `source='woocommerce'` provenance stamp.

**Verdict:** Yes, Tier-1. Strengthens **Revenue Truth** (platform revenue: order totals/tax/
shipping/discounts), **Identity** (email + phone + billing/shipping → deterministic keys), and
**Decisions** (product/refund/coupon performance) — all by widening coverage to non-Shopify
merchants, reusing existing canonical surfaces.

## 2. Capability review (verified → ingestible)

- **REST API:** `wc/v3`, base `/wp-json/wc/v3/` (Woo 3.5+/WP 4.4+). Full CRUD + `POST {resource}/batch`
  on orders, products, product variations, categories, customers, coupons, refunds, taxes,
  shipping zones/methods, payment_gateways, reports, system_status. **List + retrieve = ingestion path.**
- **Auth:** consumer key/secret (WooCommerce → Settings → Advanced → REST API), **HTTP Basic over
  HTTPS** (key=user, secret=pass) or OAuth 1.0a one-legged over HTTP (15-min nonce window).
  Scopes read/write/read_write — **request `read`**. Revocable; bound to a WP user.
- **Webhooks:** topics `resource.event` for order/product/customer/coupon × created/updated/deleted
  (+ `order.restored`, + custom). Headers `X-WC-Webhook-Topic/Resource/Event/ID/Delivery-ID`.
  **Signature = `base64(HMAC-SHA256(secret, raw_body))`** in `X-WC-Webhook-Signature` (secret
  defaults to the API user's consumer secret). Auto-disables after **>5 consecutive** non-(2xx/301/302)
  deliveries (tunable). ⚠️ **Refuted:** webhook body is NOT byte-identical to the REST response —
  validate/parse webhook bodies independently, don't blindly reuse REST parsers.
- **Pagination/backfill:** `per_page` (default 10; commonly max 100 — treat as open), `page`, `offset`,
  `X-WP-Total`/`X-WP-TotalPages` + `Link` rel=next. Date/`modified_after` filters: likely but
  unverified → confirm at build. Rate limits: hosting-dependent (assume none in core; be polite).
- **Order statuses** (standard, stable): pending, processing, on-hold, completed, cancelled,
  refunded, failed, trash → revenue mapping in §9.
- **Settlement:** WooCommerce core exposes only order-level `payment_method` + `transaction_id`;
  **net-of-fees settlement lives in the gateway** (Stripe/Razorpay/WooPayments) — same platform-vs-
  realized split Brain already handles via the payments connectors. Do NOT expect payout data from Woo.

## 3. Connector architecture

- **Auth/secrets:** consumer key+secret bundle → `secret_ref` (AWS SM prod / dev_secret dev),
  store `shop_domain` (the WP site URL) on `connector_instance`. Mirror the Shopify connector's
  secret pattern. Add `woocommerce` to the provider CHECK (additive migration) + catalog flip to
  `available` (currently `coming_soon`).
- **Sync model — both paths, both generic:**
  1. **Real-time:** WooCommerce webhooks → **Brain collector** `/collect` (HMAC verified at the
     handler, mirror the Shopflo HMAC handler) → spool → Bronze. Topics: order.*, refund (via
     order.updated), customer.*, product.*.
  2. **Backfill/historical:** a REST list job (cursor = `page`/`modified_after`, idempotent) for
     products → customers → orders → refunds, emitting the SAME envelope. Reuse the connector
     cursor table (`resource ∈ {wc.orders, wc.products, wc.customers, wc.refunds}`).
- **Health/DQ/observability:** inherited — `connector_auth_rejected_total{provider='woocommerce'}`,
  sync_status, freshness + row_count DQ. Webhook auto-disable is a **first-class health signal**:
  surface "webhook disabled by WooCommerce" as a reconnect prompt.

## 4. Medallion + canonical mapping (storefront category — REUSE)

**Bronze:** raw Woo payload + envelope (generic). Event names: `woocommerce.order.created/updated.v1`,
`woocommerce.refund.created.v1`, `woocommerce.customer.updated.v1`, `woocommerce.product.updated.v1`.

**Silver** — maps onto EXISTING canonical entities (Phase 11 classification):

| WooCommerce | Canonical target | Classification |
|-------------|------------------|----------------|
| Order (+ status) | `silver_order_state` | **existing** ✅ (add source provenance) |
| Line items | `silver_order_line` | **existing** ✅ |
| Customer (email/phone/billing/shipping) | `customer` / identity graph (salted-hash PII at mapper) | **existing** ✅ |
| Product / Variation | product/variant mart (as Shopify) | **existing/equivalent** |
| Refund | `realized_revenue_ledger` `refund` event | **existing** ✅ |
| Coupon / coupon_lines | discount fields on order | **existing field** |
| Tax lines | tax fields on order_state | **existing field** |
| payment_method + transaction_id | order attribute (settlement = gateway connector) | **existing** |
| UTM / campaign meta_data | journey/attribution touchpoint inputs | **equivalent** (if present in meta) |
| Arbitrary `meta_data` | Bronze | **raw-only** |

**Gold:** realized revenue, order/customer/product/category metrics, refund analysis, CLV — all via
the existing metric-engine sole-emitters; WooCommerce just adds rows to the same marts.

## 5–10 condensed

- **Real-time:** order/refund/customer/product webhooks → collector → Bronze → Silver (near-RT).
- **Historical:** REST backfill, resumable (page cursor) + idempotent (uuidv5(brand, woo_order_id,
  status, modified_at)) + replayable (Bronze).
- **Identity:** email + phone + billing/shipping = strong deterministic keys → existing salted-hash
  identity model. WooCommerce is a **real identity contributor** (unlike GoKwik's gated OTP).
- **Journey:** order/checkout-completed events + any UTM in order meta → touchpoint/journey marts.
  (WooCommerce has no native checkout-step events — that's the checkout connectors' job.)
- **Revenue Truth:** platform revenue from order totals; recognized on `processing`/`completed`;
  reversed on `refunded`/`cancelled`; not-recognized on `pending`/`on-hold`/`failed`. Net-of-fees
  needs the gateway connector (same as Shopify).
- **Decisions:** refund-risk, coupon-dependence, repeat-customer, product/category performance,
  high-value customers → signals → candidates → recommendations (reuse decision-intelligence layer).

## 11–18 condensed

- **DB impact:** additive only — `woocommerce` provider value; reuse all storefront marts + ledger.
  NO new business tables/services. Reject: nothing (clean storefront fit).
- **Events:** `woocommerce.{order,refund,customer,product}.{event}.v1`; producer = adapter; consumers =
  bronze-bridge + existing order/refund silver builders; versioned.
- **DQ:** order-count vs WooCommerce report cross-check (coverage), freshness, dup detection (uuidv5).
- **Observability:** webhook health (auto-disable!), backfill progress, sync lag, auth-rejected.
- **Scale (100/500/1000):** order webhooks dominate; volume ∝ GMV; Bronze linear; backfill bounded
  by per-connector cursor + REST pagination. Hosting rate-limits are the external constraint.
- **Negative review:** duplicate webhooks → uuidv5 dedupe at Bronze PK; webhook auto-disabled →
  health alert + REST reconcile job closes gaps; out-of-order updates → `silver_order_state` is a
  latest-state fold (replay-safe); webhook body ≠ REST shape → independent parser (per refutation).
- **Final recommendation:** build it — lowest-risk, highest-coverage connector; ~90% reuse of the
  Shopify storefront canonical surface. The only genuine net-new work is the Woo source adapter +
  mapper + HMAC verify; confirm `per_page` max + date-filter params at implementation time.

# SPEC 3 — Shiprocket (category: logistics) — PRIMARY LOGISTICS SOURCE

## 1. Executive summary

Shiprocket is a **Tier-1 logistics connector** and the **richest logistics source available** —
it is India's dominant shipping aggregator, i.e. the actual carrier-management layer that *owns*
the AWB/tracking truth. Verified (22 confirmed / 3 refuted): a real REST API
(`apiv2.shiprocket.in/v1/external/`), a 10-day Bearer-JWT auth, a documented multi-set status
taxonomy (forward / NDR / RTO / return / pickup), and **shipment-tracking webhooks** (real-time
push — which GoKwik's pull-only AWB feed lacks).

**The key architectural point:** Brain ALREADY has a logistics-category canonical surface — the
GoKwik `awb.lifecycle` repull → terminal-state classification → `cod_rto_clawback` /
`cod_delivery_confirmed` ledger. Shiprocket is the **second (and likely primary) source feeding the
SAME canonical entities** (`silver_shipment_event`, the RTO/delivered ledger semantics from SPEC 1).
The consolidation: **generalize `@brain/gokwik-mapper`'s `classifyAwbStatus` into a shared
logistics status-normalizer** that maps BOTH GoKwik AWB statuses AND Shiprocket statuses to one
canonical `terminal_class` (rto | delivered | in_transit | ndr | other). No duplicate shipment system.

**Verdict:** Yes, Tier-1. Improves **Realized Revenue** (COD remittance with UTR/dates →
settlement ledger; delivered/RTO → recognition/clawback — same ledger GoKwik feeds), **RTO
Intelligence** (NDR reasons + RTO sub-states + scan timeline — far richer than GoKwik's terminal
flag), and **Decisions** (courier performance, high-RTO pincodes, freight cost, NDR patterns).

## 2. Capability review (verified → ingestible)

- **REST API:** base `apiv2.shiprocket.in/v1/external/` (apidocs.shiprocket.in). Endpoints:
  `orders/create/adhoc` (→ order_id+shipment_id), `courier/assign/awb` (→ awb_code+courier),
  `courier/serviceability/`, `courier/track/awb/{awb_code}`, `courier/generate/pickup`. Ingestion
  path = track + list endpoints.
- **Auth:** `POST /v1/external/auth/login` (dedicated API user email+password, Settings→API→Configure,
  max 4) → **Bearer JWT valid 240h (10 days), no refresh token — re-mint by re-login.** Connector
  must store email+password (a credential bundle, not just a key) and auto-relogin on 401/expiry.
- **Status taxonomy (LABELS, verified):** Forward (Pickup Scheduled→Picked Up→Shipped→In-Transit→
  Out for Delivery→Delivered; + Delayed/Misrouted/Lost/Destroyed); NDR/Undelivered (reattempts +
  escalate/re-escalate up to 6); RTO (Initiated, OFD, Delivered, Acknowledged, Rejected, NDR,
  Disposed); separate Return-order and Pickup-ID sets. RTO typically after ~3 failed attempts (also
  address-unserviceable/refusal/fraud — not a strict rule).
- **Webhooks:** shipment-tracking webhooks exist (Settings→API→Webhooks) AND SR-Checkout
  (cart/order) webhooks are a *separate* surface. ⚠️ **Gaps:** the tracking webhook payload shape
  (awb, current_status, current_status_id, scans[], courier_name) + its auth-header (X-Api-Key/token)
  + retry/idempotency are NOT in public docs — confirm against apidocs + a live payload at build.
- **Other gaps to confirm at build:** numeric `current_status_id`→label map, NDR list/action field
  schemas, COD remittance fields (amount, status, UTR, expected/paid dates), freight/charge fields,
  scan-timeline field names, pagination params, rate limits, sandbox availability.

## 3. Connector architecture

- **Auth/secrets:** email+password API-user bundle → `secret_ref` (AWS SM / dev_secret). Token
  cache + auto-relogin (10-day JWT). New: a small token-cache concern (GoKwik/Razorpay are static
  key-pairs; Shiprocket needs a refreshable token) — handle in the source adapter, not a new service.
- **Sync model — both paths, both generic:**
  1. **Real-time:** Shiprocket tracking webhook → Brain collector `/collect` → spool → Bronze.
     Verify the (gap) auth header at the handler. This makes Shiprocket the real-time logistics feed.
  2. **Backfill/poll:** `courier/track/awb/{awb}` + order/shipment list (cursor = page/date), to
     restate late-changing lifecycle (same 45-day-window restatement logic as GoKwik AWB). Idempotent
     via uuidv5(brand, awb, status, scan_datetime).
- **Health/DQ/observability:** inherited; token-expiry → `connector_auth_rejected_total{provider='shiprocket'}`
  + auto-relogin; shipment-coverage and tracking-freshness DQ checks.

## 4. Medallion + canonical mapping (logistics category — SHARED with GoKwik AWB)

**Bronze:** raw Shiprocket payload + envelope. Events: `shiprocket.shipment.created/updated.v1`,
`shiprocket.tracking.scan.v1`, `shiprocket.ndr.created.v1`, `shiprocket.rto.initiated.v1`,
`shiprocket.cod.remitted.v1`.

**Silver/Gold** — Phase-10 classification:

| Shiprocket | Canonical target | Classification |
|------------|------------------|----------------|
| Shipment (awb, courier, shipment_id, order_ref) | `silver_shipment` | **new mart (shared w/ GoKwik)** |
| Tracking scan / status | `silver_shipment_event` (SPEC 1) | **new, shared** |
| Status label/id | canonical `terminal_class` via shared logistics normalizer | **generalize `classifyAwbStatus`** |
| Terminal RTO | ledger `cod_rto_clawback` | **existing** ✅ |
| Terminal Delivered | ledger `cod_delivery_confirmed` | **existing** ✅ |
| NDR (reason, attempts, escalation) | `silver_delivery_attempt` / ndr_event | **new canonical entity** |
| COD remittance (amount, UTR, status, dates) | `realized_revenue_ledger` settlement event | **existing event types** ✅ (like Razorpay) |
| Freight / courier charges | CM2 cost input (feeds `cod-mix` CM2) | **new field** |
| Courier name | carrier dimension on shipment | **new attribute** |
| Pickup-ID statuses | Bronze | **raw-only** |

**Gold:** delivery performance, RTO analysis, courier performance, shipping-cost analysis,
fulfillment performance — metric-engine sole-emitters; extend the existing `cod-rto-rates` cohort
logic to read `silver_shipment_event` (multi-source) rather than GoKwik Bronze only.

## 5–9 condensed

- **Real-time:** tracking webhook → collector → Bronze → Silver (near-RT; the upgrade over GoKwik pull).
- **Historical:** track/list polling, resumable (page/date cursor) + idempotent (uuidv5) + replayable.
- **Revenue Truth:** the chain Order→Shipment→Delivery→COD-collection→Remittance→(RTO reversal) is
  exactly Brain's CoD recognition model. Shiprocket supplies the *delivery* + *remittance* truth
  (UTR/dates) that closes provisional→finalized recognition. Highest-value contribution.
- **RTO Intelligence:** NDR reason + attempt history + RTO sub-states + scan timeline → far richer
  RTO signal than GoKwik's terminal flag; raises delivery/revenue confidence (deterministic, observed).
- **Decisions:** high-RTO pincode/courier, courier delays, freight-cost outliers, NDR patterns →
  signals → candidates → recommendations (extend the existing CM2/RTO decision surface).

## 10–17 condensed

- **DB impact:** additive — `silver_shipment`, `silver_shipment_event` (shared), `silver_delivery_attempt`;
  `shiprocket` provider value; reuse the revenue/settlement ledger. NO new business tables/services.
  Reject: nothing. **Consolidation requirement:** the shared logistics normalizer must own status→
  terminal_class for both GoKwik and Shiprocket (single deterministic mapping, no per-source drift).
- **Events:** `shiprocket.{shipment,tracking,ndr,rto,cod}.*.v1`; producer = adapter; consumers =
  bronze-bridge + the (generalized) AWB/shipment ledger consumer; versioned.
- **DQ:** shipment coverage (orders w/ shipment), tracking freshness, dup scans (uuidv5), missing
  terminal states → fulfillment/delivery confidence.
- **Observability:** webhook health, token-relogin events, sync lag, scan-ingest freshness.
- **Scale (100/500/1000):** tracking scans are the high-volume stream (many scans/shipment) — the
  dominant logistics volume driver; Bronze linear; webhook + bounded poll. Status normalizer is O(1).
- **Negative review:** duplicate scans → uuidv5 dedupe; delayed/out-of-order webhooks → latest-state
  fold in `silver_shipment_event`; missing terminal → 45-day poll restatement closes it; RTO/AWB
  mismatch across GoKwik vs Shiprocket → shared normalizer + ledger UNIQUE(brand,order,type,date)
  prevents double-clawback (**critical: both sources must not double-book the same RTO**).

## 18. Final recommendations (Shiprocket)

1. **Build it as the primary logistics source** — real-time tracking + COD remittance + freight make
   it strictly richer than the GoKwik AWB feed; it closes the revenue-recognition loop (remittance UTR).
2. **Consolidate the logistics normalizer FIRST** — generalize `classifyAwbStatus` to a shared
   GoKwik+Shiprocket status→terminal_class map, and guard against double-booking the same RTO across
   the two sources (ledger dedup key already enforces this; verify with a cross-source test).
3. **Confirm the gaps at build** — tracking-webhook payload + auth header, numeric status_id map, COD
   remittance + freight field schemas (apidocs + live payload). Public KB gives labels, not field schemas.

# SPEC 4 — Shopflo (category: payments/checkout) — CONSOLIDATE & EXTEND

## 1. Executive summary

Shopflo is a **Tier-1 checkout-intelligence connector** and Brain's **best-documented checkout
source** (verified 24/25 confirmed). Unlike GoKwik (RTO/COD-focused, partner-gated), Shopflo's
**abandoned-checkout webhook is self-serve and its full JSON payload is publicly documented** —
and **Brain already runs it live** (`shopflo.checkout_abandoned.v1` via an HMAC handler +
`@brain/shopflo-mapper` + the `checkout-funnel` metric). So this spec is **consolidate the existing
live ingestion + extend** to the richer checkout-funnel event stream.

Shopflo's distinctive value is exactly the trio GoKwik *cannot* give us today: **Identity**
(checkout-captured email/phone/address — deterministic keys), **Journey** (a named checkout-funnel
event sequence), and **Attribution** (note-attributes: landing page + referrer; UTM in the order
export). Together GoKwik (RTO/COD) + Shopflo (checkout/identity) = the full **payments/checkout
category** — they must share the canonical `silver_checkout_session` entity, NOT build two.

**Critical boundary (the user's "no duplicate checkout/journey systems" constraint):** Shopflo's
`Order Completed` is **NOT** the order system-of-record — Shopify/WooCommerce is. Shopflo
contributes checkout-journey + identity + attribution that *link to* the storefront order; it must
not create a parallel order or journey table.

**Verdict:** Tier-1. Improves **Identity** (real deterministic email/phone/address at checkout —
the strongest of the four for identity), **Journey** (checkout funnel reconstruction), **Attribution**
(landing/referrer/UTM), and **Decisions** (abandonment, coupon dependence, checkout friction).

## 2. Capability review (verified → ingestible)

- **Products:** one-click checkout, payments orchestration (7 gateways, auto-route+fallback),
  cart/AOV, upsells, discount engine, COD/RTO, identity/auto-login.
- **Abandoned-checkout webhook (Tier A — built):** single event `checkout_abandoned`, HTTP POST to
  a merchant endpoint, **self-serve** (Settings → Integrations → Abandoned Cart Webhook).
  **Documented payload:** `email`, `phone`, `customer{uid,email,first_name,last_name,phone,marketing_consent}`,
  `shipping_address`+`billing_address{city,country,country_code,province,province_code,zip}`,
  `line_items[{price,id,quantity,title}]`, `currency`, `subtotal_price`, `total_discount`,
  `total_shipping`, `total_tax`, `total_price`, `checkout_id`, `cart_token`, `abandoned_checkout_url`,
  note attributes (landing page + referrer), `created_at`/`updated_at`. Captures even address-less abandons.
- **Checkout-funnel events (Tier B — extend):** Checkout Started/Button Clicked, Login Completed,
  Address Submitted, Payment Method Selected/Payment Initiated, Coupon Success/Failed, Order
  Completed — documented as *partner-provisioned* streams (MoEngage/WebEngage/CleverTap/Klaviyo),
  naming varies per integration. `Order Completed` payload: order_id, total_price, currency,
  cart_token, first/last_name, discount_value, discount_codes, line_items, shipping_address_*,
  buyer_accepts_marketing, tyPageURL.
- **Token API:** `api.shopflo.com/public/api/v2/tokens` (session-id → checkout_url) — SDK helper,
  NOT a data-ingestion API.
- **Auth:** dashboard-provisioned API keys/tokens (dashboard.shopflo.com/settings).
- **⚠️ Gaps / flags:** HMAC/signature, idempotency keys, retry semantics, pagination, bulk/list
  API, rate limits = **not publicly documented**. Backfill → dashboard **orders export (CSV)**, no
  documented list API. **Action item:** the public abandoned-cart doc shows NO HMAC, yet Brain's
  live handler is "HMAC-first" — reconcile this (either Shopflo sends an undocumented signature, or
  the handler verifies a secret it shouldn't expect → potential latent verification mismatch). Verify
  against a live payload.

## 3–4. Architecture + medallion + canonical mapping

- **Auth/secrets:** API key/secret + `shopflo_merchant_id` (already on `connector_instance`, 0030)
  → `secret_ref`. Webhook resolved by merchant_id via the existing SECURITY DEFINER fn.
- **Ingestion:** webhook → Brain collector → spool → Bronze (already live for `checkout_abandoned`).
  Extend: subscribe the Tier-B funnel events the same way (needs Shopflo-side config). Backfill =
  parse the CSV orders export into the same envelope (no list API).

**Canonical mapping (payments/checkout — SHARED with GoKwik):**

| Shopflo | Canonical target | Classification |
|---------|------------------|----------------|
| checkout_abandoned | `silver_checkout_session` (shared) + abandonment flag | **new mart; feeds existing `checkout-funnel` metric** |
| identity (email/phone/address/customer) | identity-hint → `customer` (PII hashed at mapper) | **existing** ✅ (mapper already hashes) — strongest identity feed |
| note attributes (landing/referrer), order-export UTM | journey/attribution touchpoint inputs | **equivalent** (feeds touchpoint/attribution) |
| line_items + financials | checkout_session attributes (abandoned value) | **existing** (in `checkout-funnel`) |
| checkout-funnel steps (Tier B) | `silver_checkout_step` / journey_step | **new, partner-config** |
| payment method selected | checkout_session attribute | **new field, Tier B** |
| coupon success/failed | discount signal | **existing field** |
| upsell/offer accepted | offer_conversion | **new entity** |
| Order Completed | LINK to storefront order (NOT a new order) | **reference-only** (avoid duplicate order system) |

**Gold:** checkout conversion rate, abandonment analysis, payment-preference, upsell performance,
checkout-friction — metric-engine sole-emitters; `checkout-funnel` already exists, extend onto Silver.

## 5–18 condensed

- **Identity (Shopflo's #1 contribution):** deterministic email+phone+address at checkout → existing
  salted-hash identity model → raises Brain-ID confidence. This is the data GoKwik's gated OTP can't yet give.
- **Journey:** checkout-funnel steps → checkout-session reconstruction + touchpoints (links anon
  pixel journey → known checkout). **Do not** duplicate the journey mart — feed it.
- **Attribution:** landing/referrer/UTM → attribution confidence on the converting session.
- **Revenue Truth:** Shopflo is checkout-side; recognized revenue still flows from the storefront
  order + payment connector. Shopflo confirms checkout completion + payment method, not settlement.
- **Decisions:** abandonment patterns, coupon dependence, payment-method friction, low-converting
  steps → signals → candidates → recommendations.
- **DB impact:** additive — `silver_checkout_session`, `silver_checkout_step` (shared w/ GoKwik checkout);
  reuse identity/touchpoint/discount. `shopflo` provider + merchant_id already exist (0030). No new
  tables/services. Reject: Shopflo order as an order SoR (reference-only).
- **Events:** `shopflo.checkout_abandoned.v1` (live); reserve `shopflo.checkout.{started,step,payment_selected,
  completed}.v1`, `shopflo.offer.accepted.v1` for Tier B.
- **DQ/observability:** checkout/session/abandonment coverage, dup (uuidv5FromShopfloCheckout — exists),
  webhook health; reconcile the HMAC question above.
- **Scale:** checkout events ∝ sessions (> orders); Bronze linear; webhook-driven.
- **Negative review:** dup sessions → uuidv5 dedupe (exists); partial/abandoned sessions are the
  PURPOSE (not errors); Order-Completed vs storefront-order double-count → reference-only mapping
  prevents it; missing HMAC → resolve before trusting the live handler.
- **Final recommendation:** consolidate the live abandoned-checkout ingestion onto the shared
  `silver_checkout_session`, reconcile the HMAC discrepancy, then extend to the Tier-B funnel events
  (requires Shopflo-side config). Shopflo is the identity/journey/attribution workhorse of the four.

---

# CONSOLIDATED WRAP-UP — all four connectors

## The shape: 4 connectors, 3 category normalizers, 1 ingestion pipeline

Per the **uniform-ingestion / category-normalization** principle, the four connectors collapse into
**three shared category normalizers** over **one generic ingestion pipeline** (collector → spool →
Redpanda → Bronze, already built). Nothing below is a new service or database.

| Category | Connectors | Shared canonical target | New normalizer work |
|----------|-----------|------------------------|---------------------|
| **storefront** | Shopify (live) + **WooCommerce** | `silver_order_state`, `silver_order_line`, `customer`, product marts, revenue ledger | WooCommerce mapper only (~90% reuse) |
| **payments/checkout** | **GoKwik** + **Shopflo** (live) | `silver_checkout_session`, `silver_risk_signal`, identity-hints, CoD/RTO ledger | shared checkout-session + risk normalizer |
| **logistics** | GoKwik-AWB (live) + **Shiprocket** | `silver_shipment`, `silver_shipment_event`, RTO/delivered ledger, settlement (COD remittance) | **one** shared status→terminal_class normalizer (generalize `classifyAwbStatus`) |

## What each connector uniquely strengthens (the final-questions answer)

| | Identity | Journey | Revenue Truth | Decisions | Buildable today? |
|--|--------|---------|---------------|-----------|------------------|
| **WooCommerce** | ✅ strong (email/phone/billing) | ✅ orders | ✅ platform revenue | ✅ product/refund | **Yes — fully public** |
| **Shiprocket** | — | — | ✅✅ delivery + COD remittance (closes recognition) | ✅✅ RTO/courier/freight | **Yes — public API; webhook payload to confirm** |
| **Shopflo** | ✅✅ strongest (checkout email/phone/addr) | ✅✅ checkout funnel | ◻ checkout-side only | ✅ abandonment/coupon | **Partly live; extend Tier-B** |
| **GoKwik** | ◻ OTP (partner-gated) | ◻ checkout (partner-gated) | ✅ CoD recognition/clawback | ✅✅ RTO risk | **Tier-A live; Tier-B/C gated** |

## Recommended build order (value ÷ risk)

1. **Shiprocket** — highest value (closes revenue recognition via remittance + richest RTO), public
   API, and it consolidates the logistics normalizer GoKwik already half-built. Do the shared
   status→terminal_class normalizer here (guard double-RTO-booking across GoKwik+Shiprocket).
2. **WooCommerce** — lowest risk, ~90% reuse of the Shopify storefront surface; widens merchant TAM.
3. **Shopflo (extend)** — consolidate the live abandoned-checkout onto `silver_checkout_session`,
   reconcile the HMAC discrepancy, add Tier-B funnel events; unlocks Identity/Journey/Attribution.
4. **GoKwik (consolidate Tier-A + gate Tier-B/C)** — unify mappers/event-naming, add
   `silver_risk_signal`; open a **"GoKwik partner data access"** blocker for OTP/checkout/COD-verification.

## Cross-cutting honesty invariants

- Two connectors (GoKwik, Shopflo) are **consolidate-existing**, not greenfield — build on the live code.
- **Never fabricate** the partner-gated fields (GoKwik OTP/checkout, GoKwik numeric RTO score — verified
  refuted in research). Mark `_synthetic` until real capture lands.
- **No duplicate entities:** WooCommerce reuses storefront marts; Shiprocket+GoKwik share the logistics
  normalizer + RTO ledger (dedup key prevents double-clawback); Shopflo links to (never re-creates) the
  storefront order and feeds (never forks) the journey mart.
- **Confirm-at-build gaps** are flagged per spec (webhook payloads/HMAC/pagination for the partner-gated
  surfaces) — public docs gave product + auth + (for Woo) full mechanics, but India-checkout vendors
  (GoKwik/Shopflo/Shiprocket) keep field-level webhook schemas semi-private.

---

# ═══ IMPLEMENTATION PLAN — Shiprocket connector, SLICE 1 (BUILD NOW) ═══

## Context
User chose to build connector #1 (Shiprocket). This is the buildable Slice 1 of SPEC 3,
mirroring the existing GoKwik AWB connector exactly and executing the spec's key consolidation:
**generalize `classifyAwbStatus` into one shared logistics normalizer used by BOTH GoKwik and
Shiprocket**, feeding the SAME RTO/delivery ledger (with the dedup key guarding against
double-booking the same order's RTO across the two sources).

No Shiprocket partner credentials / confirmed webhook schemas exist, so Slice 1 is **pull-based
with synthetic dev fixtures** (`_synthetic: true`) and a real-HTTP client as a documented one-line
swap — the established GoKwik pattern (honest, shippable). Real-time webhook + new Silver marts +
courier-dimension UI are **Slice 2**.

**Ships visible UI with zero new UI code:** Shiprocket terminal RTO/Delivered flow into the SAME
`realized_revenue_ledger`, so the existing CoD/RTO analytics surface (`cod-rto-rates`, `cod-mix`)
automatically reflects Shiprocket-sourced data once the ledger consumer writes it.

## Build steps (each mirrors a named existing file)

1. **New shared package `@brain/logistics-status`** — extract `TerminalClass`, the terminal-state
   sets, `classifyAwbStatus`, `isTerminalStatus`, `normalizeStatus` out of `@brain/gokwik-mapper`.
   Add Shiprocket label mappings (RTO Initiated/OFD/Delivered/Acknowledged/Rejected/NDR → rto;
   Delivered → delivered; Lost/Damaged/Cancelled/Disposed → other; rest → none). `@brain/gokwik-mapper`
   re-exports from it (NO behavior change — existing gokwik tests must stay green = the safety net).

2. **New `@brain/shiprocket-mapper`** (mirror `@brain/gokwik-mapper`):
   `SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME = 'shiprocket.shipment_status.v1'`;
   `mapShiprocketShipment(record, brandId, saltHex, dataSource)` → properties
   {source:'shiprocket', data_source, awb_number_hash, order_id, status, terminal_class, is_terminal,
   payment_method, pincode, courier, status_changed_at, occurred_at}; `uuidV5FromShipment(brand, awb,
   status, status_changed_at)`; reuse `hashAwbNumber`; terminal_class via `@brain/logistics-status`.

3. **Migration `db/migrations/00NN_shiprocket_connector.sql`** (mirror 0030):
   add `'shiprocket'` to `connector_instance.provider` CHECK; add nullable `shiprocket_channel_id`
   + partial index; `CREATE FUNCTION list_shiprocket_connectors_for_repull()` SECURITY DEFINER
   (mirror `list_gokwik_connectors_for_awb_repull`), GRANT EXECUTE TO brain_app.

4. **Connector source module** `apps/core/src/modules/connector/sources/logistics/shiprocket/`:
   `ConnectShiprocketCommand` (mirror ConnectShopflo) — store {email, password} bundle → `secret_ref`,
   provider 'shiprocket', set `shiprocket_channel_id`, create connector_instance + sync_status, emit
   `connector.connected` (no creds — I-S09). Wire into core routes + the catalog connect dispatch.

5. **Catalog** `apps/core/.../catalog/registry.ts`: flip `shiprocket` `coming_soon`→`available`,
   `connectMethod: 'credential'` (already in logistics category).

6. **Stream-worker job** `apps/stream-worker/src/jobs/shiprocket-shipment-repull/run.ts` +
   `shiprocket-client.ts` (mirror `gokwik-awb-repull`): enumerate via the new SECURITY DEFINER fn,
   cursor resource `shipment.lifecycle`, 45-day restatement window, dev-fixture/prod-HTTP swap, emit
   `shiprocket.shipment_status.v1` CollectorEventV1 to the live topic, advance cursor, set sync_state.
   **New: `ShiprocketTokenProvider`** — POST `/v1/external/auth/login` → 10-day JWT cached in Redis
   per connector (TTL < 10d) + auto-relogin on 401 (the one genuinely-new mechanic vs GoKwik's static
   key-pair). Fixture: `_fixtures/shiprocket/shiprocket-shipment-lifecycle.json`. Register in
   `sync-request-claimer/run.ts` `loadRun()`: `case 'shiprocket'`.

7. **Generalize the ledger consumer**: rename/extend `GokwikAwbLedgerConsumer` →
   `ShipmentLedgerConsumer` accepting BOTH `gokwik.awb_status.v1` and `shiprocket.shipment_status.v1`
   (identical terminal_class → cod_rto_clawback / cod_delivery_confirmed logic via the same
   `LedgerWriter`). The ledger `UNIQUE(brand_id, order_id, event_type, date)` key makes GoKwik +
   Shiprocket idempotent on the same order's RTO (no double clawback). Update `main.ts` wiring +
   the `gokwik-awb-ledger-wiring.e2e.test.ts` reference (it guards "wired-to-nothing").

8. **Tests:** (a) `@brain/logistics-status` unit — all existing GoKwik statuses classify identically
   + new Shiprocket statuses; (b) shiprocket-mapper unit; (c) **cross-source ledger dedup e2e** —
   GoKwik + Shiprocket both emit terminal RTO for the same order → exactly ONE `cod_rto_clawback`;
   (d) repull smoke against the fixture (emits N `shiprocket.shipment_status.v1`).

## Out of scope (Slice 2)
Real-time tracking webhook handler (payload/auth header unconfirmed — gap); `silver_shipment` +
`silver_shipment_event` dbt marts; courier-performance + multi-source RTO UI panel; COD remittance
(settlement ledger) + freight cost ingestion.

## Verification
1. `pnpm -w build` / typecheck the touched packages (logistics-status, shiprocket-mapper, core,
   stream-worker). 2. Run new unit + e2e tests (esp. cross-source dedup). 3. Apply migration on dev;
   confirm provider CHECK + SECURITY DEFINER fn. 4. Seed a Shiprocket connector + fixture; run the
   repull job; verify `shiprocket.shipment_status.v1` rows in Bronze and that terminal RTO/Delivered
   produced ledger rows. 5. Confirm the existing CoD/RTO dashboard reflects the new (synthetic-badged)
   Shiprocket data. 6. Confirm existing GoKwik tests still pass (normalizer extraction = no regression).

## Honesty invariants
Synthetic dev data badged `_synthetic`; never fabricate fields behind the confirm-at-build gaps;
shared normalizer is the single deterministic status→terminal_class authority (no per-source drift);
additive-only migration; no new service/DB.
