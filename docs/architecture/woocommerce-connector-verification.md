# WooCommerce Connector — Correctness Verification (ULenin)

> **Writer note (ADR-0010, 2026-07-05):** `bronze_materialize.py` referenced below was removed —
> Bronze is landed verbatim by the Kafka Connect sink with NO Bronze-side gate; the
> `SERVER_TRUSTED` admit set now lives only in `silver_collector_event.py` (one edit, not two).

**Brand:** ULenin — `5b2e975c-7186-4608-84d6-760f51fe2389` (WooCommerce, store `https-ulinen.com`)
**Verdict:** `major_gaps` (4/4 review dimensions + live diagnosis all agree)
**Date:** 2026-06-27

---

## 1. Bottom line

**No — the WooCommerce connector is NOT flowing the full resource set to the UI.** It is structurally an **orders-only** connector. Orders flow correctly and completely end-to-end (Bronze → Silver → Gold/serving), but customers, products, coupons, and refunds are **never produced as first-class resources**, so they cannot surface on the dashboard.

**Precise reason only orders show — this is EMIT-side starvation, not an admission-gate problem.** The Bronze/Silver `SERVER_TRUSTED` lane already admits `product.upsert.v1` / `customer.upsert.v1` / `refund.recorded.v1` (`silver_collector_event.py:97`, `bronze_materialize.py:118`). The downstream is built and waiting. The WooCommerce connector simply **never emits those events**:

- **Webhook strategy** handles only `order.created` / `order.updated`; every other topic is fast-acked (HTTP 200) and dropped — `WooCommerceWebhookStrategy.ts:27` (`ORDER_TOPICS`), `:62-64` (`skip:true`).
- **Connect handshake** registers only the two order webhooks on the store — `ConnectWooCommerceCommand.ts:76` (`WC_WEBHOOK_TOPICS = ['order.created','order.updated']`), loop `:327`. The store is never even subscribed to send customer/product/coupon/refund events.
- **Scheduled sync** runs only `woocommerce-orders-repull` — `sync-request-claimer/run.ts:59`. The products framework backfill (which *does* exist) is invoked by no scheduler/connect hook and **never ran** for this brand (`jobs.resource_backfill_state` = 0 rows).
- **Mappers** for customer and coupon **do not exist anywhere** in `packages/woocommerce-mapper` (only `mapWooOrderToEvent`, `mapWooOrderToDraft`, `mapWooProductToDraft` are exported). There is no `coupon.upsert.v1` canonical type at all — coupons have zero pipeline end-to-end.

What *looks* populated is misleading: `silver_product` (35 rows) is an **order-line projection** built FROM `silver_order_line` (`silver_product.py:5,55,83`) — only the 35 SKUs that actually sold, not the catalogue. `silver_customer` (1324) is **order-identity-derived**, not the customer directory. Coupons have no table, no rows, no surface.

---

## 2. Live flow proof (ULenin)

**Bronze** — `iceberg.brain_bronze.collector_events WHERE brand_id=ULenin`, grouped by `event_type`:

| event_type | count | max(occurred_at) | source |
|---|---|---|---|
| `order.live.v1` | **1857** | 2026-06-27 16:34:24 UTC | woocommerce (100%) |
| *(all other resources)* | **0** | — | — |

**Silver** — `iceberg.brain_silver.silver_collector_event`: `order.live.v1` = 1857 (only row).

**Serving / Gold:**

| view | count | nature |
|---|---|---|
| `mv_silver_order_state` | 1857 | real orders |
| `mv_gold_revenue_ledger` | 3646 | derived from orders |
| `mv_gold_customer_360` | 1324 | order-identity-derived |
| `mv_silver_customer_identity` | 1392 | order-identity-derived |
| `silver_product` | 35 | **order-LINE projection** (sold SKUs only, not catalogue) |
| `silver_customer` | 1324 | **order-derived** (not customer directory) |
| coupons | — | **no table, no surface** |

**Drop point per resource:**

| resource | drop point |
|---|---|
| **orders** | none — flows cleanly Bronze → Silver → serving |
| **customers** | never emitted (no mapper, no fetcher, no webhook). Order-derived projection only. |
| **products** | never emitted live (no product webhook); backfill exists but **never ran** (`resource_backfill_state`=0). Order-line projection only. |
| **coupons** | never emitted; no mapper, no fetcher, no canonical type, no admit-list entry, no mart |
| **refunds** | only opportunistically folded into an `order.live.v1` payload; standalone `order.refunded` dropped; no `refund.recorded.v1` emitted |

There is **no drop inside the pipeline** — the gap is entirely upstream at emit.

---

## 3. Findings (de-duped, critical → low)

| Sev | Dimension | Issue | Fix |
|---|---|---|---|
| **Critical** | Webhook coverage | Strategy handles ONLY `order.created`/`order.updated`; all other topics fast-acked + dropped (`WooCommerceWebhookStrategy.ts:27,62-64`). Only `order.live.v1` is ever emitted. Direct cause of "orders show, nothing else." | Add per-topic `payloadMap` branches: `customer.*`→`customer.upsert.v1`, `product.*`→`product.upsert.v1`, `coupon.*`→new `coupon.upsert.v1`, `order.refunded`→`refund.recorded.v1`, `order.deleted`→tombstone. |
| **Critical** | Connect handshake | `WC_WEBHOOK_TOPICS` registers only the 2 order webhooks (`ConnectWooCommerceCommand.ts:76`, loop `:327`). Store never subscribed to send other resources, so even an extended strategy would receive nothing. | Expand `WC_WEBHOOK_TOPICS` to full spec set; keep idempotent `listExistingWebhooks` de-dup. |
| **Critical** | Mapper completeness | No customer mapper and no coupon mapper exist anywhere in `packages/woocommerce-mapper` (`event-names.ts:15-18` defines only ORDER_LIVE + PRODUCT_UPSERT). Customers-directory + coupons starved by construction. | Add `mapWooCustomerToDraft`→`customer.upsert.v1` (hash email/phone at boundary) and `mapWooCouponToDraft`→`coupon.upsert.v1`. |
| **High** | Connect / webhook secret **[SHARED PLATFORM GAP — see Shopify]** | Stored secret bundle for ULenin lacks `webhook_secret` (keys = `consumer_key`/`consumer_secret`/`site_url` only). `WooCommerceWebhookStrategy.ts:46-53` fail-closes `HMAC_INVALID` when absent → the **webhook lane is dead even for orders**; the 1857 orders arrived via REST repull. | Provision `webhook_secret` at connect time and backfill existing connectors. Same provisioning gap pattern flagged for Shopify — fix once at the connect-secrets layer, not per-connector. |
| **High** | Coupons (end-to-end) | Zero pipeline: no resource, mapper, webhook, fetcher, mart, AND no `coupon.upsert.v1` in `SERVER_TRUSTED` (`silver_collector_event.py:76-98`, `bronze_materialize.py:118`). Coupons survive only as order-nested `discount_codes[]` (`index.ts:321-325`). | Define `coupon.upsert.v1`; add to BOTH `SERVER_TRUSTED` sets (must stay byte-identical); add mapper + `/wc/v3/coupons` fetcher + manifest resource + silver/gold coupon mart. |
| **High** | Products (scheduling) | Products path exists end-to-end (`manifest.ts:51`, `WooProductsFetcher` `woocommerce-resource-fetchers.ts:94`, `run.ts:182`) but the framework backfill is a manual CLI invoked by no scheduler/connect hook and **never ran** (`resource_backfill_state`=0). No `product.*` webhook either. | Enqueue products (+ customers) resumable backfill on connect and on each scheduled sync; add `product.*` webhook for real-time catalogue. **Lowest-effort win** — fetcher + admit-list already exist. |
| **High** | Customers (ingestion) | No first-class customer ingestion: no webhook, no `WooCustomersFetcher` (`run.ts:179-186` handles only orders/products; Shopify branch `:160` has `ShopifyCustomersFetcher`), no mapper. `silver_customer.py:87,175` is order-derived. Customers who never ordered are invisible. | Mirror Shopify customer path: mapper + `/wc/v3/customers` fetcher + manifest resource + `customer.*` webhook. |
| **High** | Money correctness | `decimalStringToMinor` (`index.ts:170-182`) hardcodes 2dp (`×100`, `slice(0,2)`, `\d{1,2}`) on EVERY amount. Under-scales 3dp (KWD/BHD/OMR) by 10×, over-scales 0dp (JPY) by 100×. Missing `currency` **defaults to INR** (`index.ts:346`) — blending risk. | Use `@brain/money` `minorUnitsFromDecimal` keyed on `order.currency` (per-currency exponent). Do not default missing currency to INR — fail closed or carry configured store currency. |
| **High** | Backfill window | `woocommerce-orders-repull/run.ts:67-79` defaults to 90-day trailing window (clamp 1-730); `fromMs=max(highWater,windowStart)` can never reach older orders. Manifest advertises 2-year (`manifest.ts:40`) but that path is unscheduled. | Run true initial 2-year backfill via framework path on connect; keep repull as trailing incremental safety-net. |
| **Medium** | Live-vs-backfill drift **[SHARED PLATFORM GAP]** | `product.upsert.v1`/`customer.upsert.v1` are NOT in `BRONZE_BRIDGES` (`bronzeBridges.ts:33-60`) nor `SERVER_TRUSTED_EVENT_NAMES` (`ProcessEventUseCase.ts:44-54`). A product/customer event on the LIVE collector topic would fail the `install_token` join and be quarantined `tenant_unresolved`. Only the backfill topic (gate off) works — and it never ran. | If real-time wanted: add to `SERVER_TRUSTED_EVENT_NAMES` + `BRONZE_BRIDGES` (mirror Shopify CRIT-4). Else document as backfill-only and schedule it. Same fix shape as Shopify. |
| **Medium** | Refunds | Captured only when embedded in an `order.updated` payload (`index.ts:329-339`); `order.refunded` dropped; no `refund.recorded.v1` emitted despite Bronze admitting it. Refund freshness depends on a same-delivery order payload / repull window → revenue-truth gap. Also refund `processed_at` reads `date_created` not `date_created_gmt` (`index.ts:335`) → TZ drift via `toUtcIso` `Z` append. | Subscribe `order.refunded` → emit `refund.recorded.v1`; add `/orders/<id>/refunds` backfill; read `date_created_gmt`. |
| **Low** | occurred_at drift | `occurredAt = date_modified_gmt ?? date_created_gmt` (`index.ts:268-271`); spec says `date_created`. Advances on every edit → skews acquisition-date cohorting. `cancelled_at` synthesized from `status==='cancelled'`. | Document the deliberate `date_modified` choice or carry `created_at` separately. |
| **Low** | PII / raw payload | Raw billing email/phone hashed and **dropped** at mapper (`index.ts:278-290`); spec asks raw payload preserved + PII hashed into metadata sidecar. | Decide explicitly: preserve raw JSON in Bronze with PII hashed sidecar (replay/audit), or update spec. Divergence flagged, not asserted defect. |
| **Info** | Dead Spark shadow | `silver_woocommerce_normalize.py:66` reads RETIRED `woocommerce_orders_raw` (Kafka-Connect sink) and writes `silver_collector_event_woocommerce_shadow`; skip-guard no-ops every run (`:127-129`). Reconstructed payload OMITS line_items/refunds/discount_codes/tax (`:200-213`) → latent REGRESSION if ever cut over. | Delete/quarantine, or repoint to live `collector_events` and reach `mapWooOrderToEvent` payload parity before any cutover. |
| **Info** | Security layer (no defect) | HMAC base64(HMAC-SHA256(rawBody)) + `timingSafeEqual`, fail-closed (`WooCommerceHmac.ts:35-57`, strategy `:37-55`). Tenant from `X-WC-Webhook-Source` URL (`registerWebhookRoutes.ts:123-127`). Money bigint+sibling currency_code, brand_id MT-1 from connector row never payload. Idempotency via `uuidV5FromOrderLive`. | No change to signature/tenant/idempotency layer. Preserve when adding missing lanes. |

---

## 4. Recommended actions

### MUST FIX before production

1. **Provision `webhook_secret` at connect** — `ConnectWooCommerceCommand.ts` + connect-secrets layer. Without it the webhook lane is dead even for orders (ULenin's orders came via REST repull). **Shared fix with Shopify** — do once at the secrets-provisioning layer. *(High)*
2. **Expand webhook coverage (both sides):**
   - `ConnectWooCommerceCommand.ts:76` — `WC_WEBHOOK_TOPICS` → full spec set (`order.*`, `customer.*`, `product.*`, `coupon.*`, `order.deleted`, `order.refunded`).
   - `WooCommerceWebhookStrategy.ts:27,62-64` — add `payloadMap` branches for each topic → canonical event. *(Critical)*
3. **Build the missing mappers** — `packages/woocommerce-mapper`: `mapWooCustomerToDraft`→`customer.upsert.v1`, `mapWooCouponToDraft`→`coupon.upsert.v1` (new type). *(Critical)*
4. **Fix money scaling** — `index.ts:170-182` → `@brain/money` per-currency decimals; remove INR default (`index.ts:346`). Silent revenue corruption on any non-2dp / multi-currency store. *(High)*
5. **Schedule products + customers backfill on connect** and add real-time `product.*`/`customer.*` paths. Products fetcher + admit-list already exist (`woocommerce-resource-fetchers.ts:94`) — wiring into the claimer/connect hook lights up the products surface with near-zero new code. *(High)*
6. **Add `coupon.upsert.v1` to BOTH `SERVER_TRUSTED` sets** (`silver_collector_event.py` + `bronze_materialize.py`, byte-identical) plus a silver/gold coupon mart. *(High)*
7. **Live-vs-backfill parity** — add `product.upsert.v1`/`customer.upsert.v1` (+ new coupon type) to `SERVER_TRUSTED_EVENT_NAMES` (`ProcessEventUseCase.ts:44-54`) and `BRONZE_BRIDGES` (`bronzeBridges.ts:33-60`), or document backfill-only and guarantee the backfill is scheduled. **Same fix shape as Shopify CRIT-4.** *(Medium)*
8. **True 2-year initial backfill** via the framework path on connect — `woocommerce-orders-repull/run.ts:67-79` 90-day window cannot reach history. *(High)*

### NICE TO HAVE

9. **Refunds as a first-class grain** — subscribe `order.refunded` → `refund.recorded.v1` + `/orders/<id>/refunds` backfill; read `date_created_gmt` (`index.ts:335`). *(Medium)*
10. **Delete/quarantine `silver_woocommerce_normalize.py`** (dead shadow on a retired table; latent regression). *(Info)*
11. **Document `occurred_at = date_modified` choice** or carry `created_at` separately (`index.ts:268-271`). *(Low)*
12. **Resolve raw-payload vs PII-boundary** divergence (`index.ts:278-290`) — preserve raw + hashed sidecar, or update spec. *(Low)*
13. **Implement deferred per-variation price fetch** in product mapper (`resources.ts:85-91,101-114`) so variant SKUs/prices populate. *(Medium)*

### Shared-platform fixes (do NOT duplicate per connector)

- **`webhook_secret` provisioning** (action 1) — same gap on Shopify; fix at connect-secrets layer.
- **SERVER_TRUSTED / BRONZE_BRIDGES live bridge** (action 7) — mirror Shopify's CRIT-4; the resource event types should be admitted on the live lane once for all storefronts.
- **Live-vs-backfill drift** — products/customers landing only via the backfill topic (gate off) while the live topic quarantines them is a platform-wide pattern; one bridge fix covers Shopify + Woo.

---

*All findings evidence-backed against the cited files; nothing invented beyond the audit + live-diagnosis inputs.*
