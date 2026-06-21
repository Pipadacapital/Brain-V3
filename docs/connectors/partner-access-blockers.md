# Connector partner-access map (authoritative dependency tracker)

> One place that states, per connector, **what is buildable from public docs** vs **what genuinely
> requires partner / merchant engagement**. Grounded in the official portals (URLs below) and our
> no-fabrication posture: nothing partner-gated is built on guessed schemas — it is documented here
> with a clearly-flagged seam in code, ready to flip to config when real docs/payloads arrive.
>
> Companion: `connector-integration-specs.md` (the full specs) and
> `shiprocket-partner-blockers.md` (Shiprocket detail).

## Official sources (verified)

| Connector | Website | Developer / API docs | Notes |
|---|---|---|---|
| **GoKwik** | https://www.gokwik.co/ • https://www.gokwik.co/integrations | https://developers.gokwik.co/ | Public portal covers commerce/payments. Checkout/OTP/abandoned-checkout event schemas are **not** public → partner-only. |
| **Shopflo** | https://www.shopflo.com/ | _no public developer docs_ | Funnel/session/checkout events, HMAC scheme, webhook payloads = merchant/partner access. |
| **Shiprocket** | https://www.shiprocket.in/developers/ • https://community.shiprocket.in/ | https://apidocs.shiprocket.in/ | Public APIs for orders/shipments/tracking/couriers. COD-remittance/UTR/some NDR fields need a live merchant account. |
| **WooCommerce** | https://woocommerce.com/document/woocommerce-rest-api/ | https://developer.woocommerce.com/docs/apis/rest-api/ • https://woocommerce.github.io/woocommerce-rest-api-docs/ | Fully public: pagination/`per_page`, date filters, orders, customers, products, webhooks. |
| **Shopify** (Brain Pixel) | https://shopify.dev/ | https://shopify.dev/docs/api • https://shopify.dev/docs/api/web-pixels-api • https://shopify.dev/docs/api/webhooks • https://shopify.dev/docs/apps/build/checkout | Web Pixels, Webhooks, Checkout Extensibility all public. |

---

## Status by connector

### WooCommerce (storefront) — ✅ NO partner dependency
Fully buildable and **fully verified against public docs.** Built + merged (backfill + live REST +
real-time webhook). The previously-open "confirm-at-build" items are now **confirmed correct** —
`apps/stream-worker/src/jobs/woocommerce-orders-repull/woocommerce-client.ts` needs no change:

| Assumption in the live client | Public-doc verdict |
|---|---|
| `per_page = 100` is the max | ✅ 100 is the WP REST hard cap (`per_page` default 10, max 100) |
| `modified_after=<ISO8601>` incremental cursor | ✅ valid `wc/v3` param (added to `WC_REST_CRUD_Controller`: orders/products/coupons) |
| `dates_are_gmt=true` | ✅ valid param; governs GMT interpretation of `modified_after`/`after` |
| `X-WP-TotalPages` drives `hasMore` | ✅ documented response header (+ `X-WP-Total`, `Link` rel=next) |
| `after` / `before` ISO8601 date filters | ✅ documented on list endpoints |

→ No remaining WooCommerce blocker. **(Verified 2026-06-21 against the GitHub REST API docs.)**

### Shiprocket (logistics) — ⚠️ partial: public core built, settlement/NDR gated
Public order/shipment/tracking/courier APIs → **built** (Slice 1 + live-read scaffold; see
`shiprocket-partner-blockers.md`). Needs a **live merchant account** for:
- **COD remittance** payloads — amount, **UTR**, status, expected/paid **settlement dates**
- **Detailed NDR** payloads — reason codes, attempt count, escalate/re-escalate fields
- **Real-time tracking webhook** — payload shape + auth header (X-Api-Key/token)
- per-shipment **freight / charge** breakdown (CM2 cost input)

Each is additive (no redesign) with a reserved event name + flagged seam already in place.

### GoKwik (payments) — ⛔ partner-only for checkout surfaces
Tier-A (AWB lifecycle → RTO/Delivered ledger; categorical RTO risk) is **built**. The following are
**not publicly documented → partner-only** (do NOT build on guessed schemas — research refuted guesses):
- **Abandoned-checkout webhook** event schema
- **OTP / phone-verification** events
- **Checkout step / session** events, payment-method-selected

### Shopflo (payments/checkout) — ⛔ partner-only for the funnel/HMAC
Tier-A abandoned-checkout ingestion runs **live** (`shopflo.checkout_abandoned.v1`). Partner/merchant
access required for:
- **Checkout funnel events** (started/step/payment-selected/completed) — Tier-B
- **HMAC signing scheme** — reconcile our HMAC-first handler against a real signed payload
- full **webhook payloads** for the funnel stream

---

## The genuinely-blocked backlog (needs partner engagement, not engineering)

1. GoKwik abandoned-checkout events
2. GoKwik OTP / checkout-step events
3. Shopflo funnel events
4. Shopflo HMAC signatures (reconcile the live handler)
5. Shiprocket COD-remittance payloads (amount / UTR / settlement dates)
6. Shiprocket detailed NDR payloads

**To unblock:** a sandbox/merchant account + partner API & webhook docs (and, for Shopflo, one real
signed payload). Each item then flips from "documented seam" to config + mapper — no re-architecture.
