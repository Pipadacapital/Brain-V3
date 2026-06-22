# 03 — Application Implementations

> **Scope:** One section per connector application. Each section documents the platform's external API shape (auth, historical sync, real-time events, webhooks, rate limits, retries), the key entity-to-Silver mappings, the preferred ingestion mechanism, official doc links, Brain's CURRENT coverage with precise file evidence, and what remains to build.
>
> **Conventions:**
> - EXISTS TODAY — code or migration lives in this repository and is exercised in CI.
> - RECOMMENDED — identified gap; implementation plan entry or follow-up slice required.
> - All money in integer minor units + `currency_code` (I-S07). All PII hashed at the mapper boundary (I-S02).
> - `brain_app` = restricted Postgres role; FORCE RLS on all connector tables. brand_id always from the DB row (MT-1), never from a request header or payload.
> - Kafka topics: `{env}.collector.event.v1` (live lane) / `{env}.collector.order.backfill.v1` (backfill lane).
> - Bronze: Iceberg, append-only, dedup key = `event_id` (uuidV5 deterministic). ON CONFLICT DO NOTHING.
> - Silver: StarRocks dbt marts (incremental watermark). Gold: denormalized serving views.

---

## Table of Contents

1. [Shopify](#1-shopify)
2. [WooCommerce](#2-woocommerce)
3. [Meta Ads](#3-meta-ads)
4. [Google Ads](#4-google-ads)
5. [GA4 (Google Analytics 4)](#5-ga4-google-analytics-4)
6. [Razorpay](#6-razorpay)
7. [Shiprocket](#7-shiprocket)
8. [GoKwik](#8-gokwik)
9. [Shopflo](#9-shopflo)

---

## 1. Shopify

### 1.1 Authentication

**Mechanism:** OAuth 2.0 offline (permanent) access token via Shopify's Authorization Code Grant.

**Scopes (EXISTS TODAY — `InitiateOAuthCommand.ts` line 33-34):**
```
read_orders, read_products, read_customers,
write_script_tags, write_pixels, read_customer_events
```

**Token lifecycle:**
- Shopify deprecated offline tokens for NEW public apps from 2026-04-01; ALL apps must migrate to expiring offline tokens by 2027-01-01.
- Brain currently uses the legacy non-expiring offline token pattern.
- Token stored in AWS Secrets Manager (ARN in `connector_instance.secret_ref`). Never touches Postgres (NN-2).
- Client secret (`SHOPIFY_CLIENT_SECRET` env var) used as the webhook HMAC key — same secret for all brands on the same Brain app install.

**File evidence:**
- `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/InitiateOAuthCommand.ts` — OAuth initiation, scope definition.
- `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/HandleOAuthCallbackCommand.ts` — code exchange, secret storage, connector row creation.
- `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/api/ShopifyAdminClient.ts` — `DEFAULT_API_VERSION = '2025-07'` (env-overridable via `SHOPIFY_API_VERSION`).

**RECOMMENDED — Expiring token migration:**
- Implement token refresh flow before 2027-01-01 deadline. Requires a proactive refresh job analogous to `meta-token-refresh` (30 days before expiry). The Shopify `rotate_app_oauth_token` endpoint returns a new offline token; the old one is immediately invalidated. Store issued-at alongside the ARN to drive the expiry check.

### 1.2 Historical Sync / Backfill

**Mechanism:** Shopify Admin REST API `GET /admin/api/2025-07/orders.json` with `created_at_min`/`created_at_max` paging (`since_id` + `limit=250`).

**Backfill window:** 24 months (`BACKFILL_WINDOW_MS = 24 * 30 * 24 * 60 * 60 * 1000`, confirmed in `apps/stream-worker/src/jobs/shopify-backfill/run.ts` line 60).

**Backfill topic:** `{env}.collector.order.backfill.v1` — separate from the live lane to allow independent consumer lag management.

**Re-pull (catch-up) window:** 35 days (`REPULL_WINDOW_MS = 35 * 24 * 60 * 60 * 1000`, `apps/stream-worker/src/jobs/shopify-repull/run.ts` line 63). Re-polls `updated_at_min = now - 35d` to catch COD status changes. Cursor resource: `orders.repull`. Distinct from the backfill cursor `orders`.

**Cursor:** `connector_cursor` row, `resource = 'orders'` (backfill) / `resource = 'orders.repull'` (re-pull). FOR UPDATE SKIP LOCKED on each job run — guarantees no concurrent runs for the same connector.

**Scheduler claim:** `claim_due_repull_connectors()` SECURITY DEFINER fn (migration 0053). Shopify is in `REPULL_DISPATCH` (`apps/stream-worker/src/jobs/sync-request-claimer/run.ts` line 51) and in `enumerateConnectedConnectors()` via `list_connectors_for_repull()`.

**Dedup key:** `event_id = uuidV5FromOrderLive(brandId, orderId, updatedAtUtcMs)` for live lane; namespace `':order.live.v1'`. Different from backfill namespace `':order.backfill.v1'` — provably no collision.

```
Shopify Backfill Flow:
shopify-backfill/run.ts
  → list_connectors_for_repull() [SECURITY DEFINER]
  → FOR UPDATE SKIP LOCKED on connector_cursor (resource='orders')
  → GET /orders.json?since_id=cursor&limit=250
  → @brain/shopify-mapper → mapOrderToEvent()
  → Kafka: {env}.collector.order.backfill.v1
  → Spark sink → bronze_iceberg.collector_events (ON CONFLICT DO NOTHING)
```

**File evidence:**
- `apps/stream-worker/src/jobs/shopify-backfill/run.ts`
- `apps/stream-worker/src/jobs/shopify-repull/run.ts`
- `packages/shopify-mapper/src/index.ts`

### 1.3 Real-Time Events

**Mechanism:** Shopify webhooks (HTTP POST, HMAC-SHA256 signed). Brain registers 5 order topics on `connect` or `enable-live-sync`.

**Registered webhook topics (EXISTS TODAY — `RegisterWebhooksCommand.ts` lines 24-30):**
```
orders/create
orders/updated
orders/paid
orders/fulfilled
orders/cancelled
```

**Webhook receiver:** `POST /api/v1/webhooks/shopify` (all topics share one endpoint). Handler: `shopifyWebhookHandler.ts`.

**Signature validation:** `X-Shopify-Hmac-Sha256` header = `base64(HMAC-SHA256(rawBody, clientSecret))`. Validated before any payload parsing (HMAC-first pattern, NN-4).

**Brand resolution:** `X-Shopify-Shop-Domain` is a lookup key only. `brand_id` is authoritative from the DB row returned by `resolve_connector_by_shop_domain()` SECURITY DEFINER fn. The HMAC proves the request came from the party holding the client_secret.

**Age gate:** No replay-window age gate on the Shopify webhook handler (confirmed gap — Razorpay, WooCommerce, and Shopflo all have 5-minute replay windows). A Shopify delivery retry arriving after a restart is silently re-processed; dedup at Bronze (ON CONFLICT DO NOTHING) prevents double-counting.

**Shopify API version:** `2025-07` (both `RegisterWebhooksCommand.ts` constant and `ShopifyAdminClient.ts` default).

**File evidence:**
- `apps/core/src/modules/connector/sources/storefront/shopify/interfaces/webhooks/shopifyWebhookHandler.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/RegisterWebhooksCommand.ts`

**RECOMMENDED gaps:**
1. GDPR mandatory webhooks (`customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled`) — absent from `ORDER_WEBHOOK_TOPICS`. Shopify requires these for all public apps. Missing = app review rejection risk.
2. Replay-window age gate (5-minute pattern from Razorpay/Shopflo handlers) to avoid re-processing stale retries.
3. Inventory / product webhooks (`products/update`, `inventory_levels/update`) not registered — needed for product catalog truth.

### 1.4 Key Entity-to-Silver Mappings

| Source Entity | Bronze Event Type | Silver Mart | Gold / Serving |
|---|---|---|---|
| Order (all lifecycle states) | `order.live.v1` / `order.backfill.v1` | `silver_order_state` (via `int_order_lifecycle`) | `gold_revenue_ledger`, `gold_executive_metrics` |
| Order line items | `order_line.live.v1` / `order_line.backfill.v1` | `silver_order_line` | `silver_product`, `gold_cac` |
| Customer (hashed at boundary) | embedded in order event | `silver_customers` | `gold_customer_scores`, `gold_cohorts` |

**Silver mart files:**
- `db/dbt/models/marts/silver_order_state.sql` — latest-state projection via `int_order_lifecycle`. Incremental watermark on `ingested_at`.
- `db/dbt/models/marts/silver_order_line.sql`
- `db/dbt/models/marts/silver_customers.sql`
- `db/dbt/models/intermediate/int_order_lifecycle.sql`

**Mapper:** `packages/shopify-mapper/src/index.ts` — `mapOrderToEvent()`, `uuidV5FromOrderLive()`, `ORDER_LIVE_V1_EVENT_NAME`.

### 1.5 Rate Limits and Retries

- Shopify Admin REST: 2 requests/second per shop (leaky-bucket, 40 call burst). GraphQL: bucket-based cost points (1000 points/minute, each node ~1 point).
- Brain's backfill/repull uses REST; no explicit throttle wrapper confirmed in code. A 429 response causes the job to fail and retry on the next scheduled run (cursor not advanced — safe replay).
- KafkaJS client configured with `retry: { retries: 5 }` (confirmed in repull run).
- Exponential backoff on connector fetch errors via job re-schedule (ingest-scheduler interval).

### 1.6 Official Documentation

- Admin REST API: https://shopify.dev/docs/api/admin-rest
- Webhooks: https://shopify.dev/docs/apps/build/webhooks
- OAuth: https://shopify.dev/docs/apps/auth/get-access-tokens/authorization-code-grant
- GDPR webhooks: https://shopify.dev/docs/apps/build/privacy-law-compliance
- Expiring tokens: https://shopify.dev/changelog/expiring-access-tokens-for-apps-installed-on-shopify-stores

### 1.7 Brain Coverage Summary

| Area | Status | Evidence |
|---|---|---|
| OAuth connect + token storage | FULL | `InitiateOAuthCommand.ts`, `HandleOAuthCallbackCommand.ts` |
| 24-month backfill | FULL | `shopify-backfill/run.ts` |
| 35-day re-pull (COD catch-up) | FULL | `shopify-repull/run.ts` |
| Webhook receiver (5 order topics) | FULL | `shopifyWebhookHandler.ts` |
| Webhook registration on connect | FULL (dev stub) | `RegisterWebhooksCommand.ts` (env-gated no-op in dev) |
| Sync-Now claim dispatch | FULL | `sync-request-claimer/run.ts` REPULL_DISPATCH + `enumerateConnectedConnectors()` |
| silver_order_state | FULL | `db/dbt/models/marts/silver_order_state.sql` |
| GDPR compliance webhooks | MISSING | Gap — not in ORDER_WEBHOOK_TOPICS |
| Expiring token refresh | MISSING | 2027-01-01 deadline |
| Webhook age gate | MISSING | Present in Razorpay/WooCommerce/Shopflo; absent here |
| Product / inventory webhooks | MISSING | Not registered |

---

## 2. WooCommerce

### 2.1 Authentication

**Mechanism:** WooCommerce REST API consumer key + consumer secret (Basic Auth or query-param). Stored as a composite bundle in AWS Secrets Manager; ARN in `connector_instance.secret_ref`.

**Credential fields (`woocommerce-orders-repull/run.ts` lines 68-69):**
```
consumer_key: string
consumer_secret: string
```

**No OAuth.** WooCommerce uses API keys generated from the WP admin panel (WooCommerce > Settings > Advanced > REST API). These are static and do not expire unless manually rotated.

**Webhook secret:** Separate `webhook_secret` field in the credential bundle. Used to validate `X-WC-Webhook-Signature` header (HMAC-SHA256). Stored alongside `consumer_key`/`consumer_secret` in the same Secrets Manager bundle.

**File evidence:**
- `apps/stream-worker/src/jobs/woocommerce-orders-repull/run.ts` — credential resolution and REST call auth.
- `apps/core/src/modules/connector/sources/storefront/woocommerce/interfaces/webhooks/woocommerceWebhookHandler.ts` — webhook HMAC validation.

### 2.2 Historical Sync / Backfill

**Mechanism:** WooCommerce REST API `GET /wp-json/wc/v3/orders` with `modified_after` / `page` / `per_page=100`.

**Re-pull window:** 90 days (`ORDERS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000`, `woocommerce-orders-repull/run.ts` line — the longest window of any connector, reflecting WooCommerce's tendency toward slower logistics state changes).

**Cursor resource:** `orders.repull`. FOR UPDATE SKIP LOCKED overlap-lock.

**Scheduler claim:** `claim_due_repull_connectors()` (migration 0053) — works for WooCommerce because the function is provider-agnostic.

**Sync-Now gap:** `enumerateConnectedConnectors()` in `sync-request-claimer/run.ts` does NOT call `list_woocommerce_connectors_for_repull()`. The "Sync Now" button on the dashboard will claim a sentinel row but never dispatch the WooCommerce repull. Scheduled polling works correctly; only manual sync-now is broken.

**Dedup key:** `uuidV5FromOrderLive(brandId, orderId, updatedAtUtcMs)` — SAME namespace as Shopify's order live events (`order.live.v1`). A webhook + a later re-pull of the same order at the same `updated_at` produces the same event_id → Bronze ON CONFLICT DO NOTHING → dedup.

**File evidence:**
- `apps/stream-worker/src/jobs/woocommerce-orders-repull/run.ts`
- `packages/woocommerce-mapper/src/index.ts`

### 2.3 Real-Time Events

**Mechanism:** WooCommerce webhooks (HTTP POST). Signature: `X-WC-Webhook-Signature` = `base64(HMAC-SHA256(rawBody, webhook_secret))`.

**Lookup key:** `X-WC-Webhook-Source` header (store base URL) — used to resolve the connector row. NOT brand authority.

**Replay window (EXISTS TODAY):** 5 minutes (`SHOPFLO_REPLAY_WINDOW_SECONDS = 5*60` — same constant pattern). Events older than the window are rejected (C3).

**Redis dedup:** SET NX EX on deterministic event_id, after HMAC validation.

**Covered topics:** WooCommerce webhook sends `order.created`, `order.updated`, `order.deleted`, `order.restored` via user-configured webhooks. Brain registers callbacks on connect.

**File evidence:**
- `apps/core/src/modules/connector/sources/storefront/woocommerce/interfaces/webhooks/woocommerceWebhookHandler.ts`
- `apps/core/src/modules/connector/sources/storefront/woocommerce/domain/value-objects/WooCommerceHmac.ts`

### 2.4 Key Entity-to-Silver Mappings

| Source Entity | Bronze Event Type | Silver Mart | Notes |
|---|---|---|---|
| WooCommerce Order | `order.live.v1` (shared) | `silver_order_state` | Same canonical event as Shopify — multi-source mart |
| Order line items | `order_line.live.v1` | `silver_order_line` | |
| Customer | embedded in order event (PII hashed) | `silver_customers` | |

WooCommerce orders flow into the same `silver_order_state` and `silver_order_line` marts as Shopify because the mapper produces the canonical `order.live.v1` event type. `int_order_lifecycle` unionizes by `event_type` — no mart change required when adding a new storefront source.

### 2.5 Rate Limits and Retries

- WooCommerce REST has no platform-level rate limit by default; the host's PHP/NGINX may impose limits (varies by hosting).
- Brain's repull job pages with `per_page=100`. A 429 or 5xx aborts the current run; cursor not advanced → safe replay on next scheduled run.
- KafkaJS `retry: { retries: 5 }`.

### 2.6 Official Documentation

- REST API: https://woocommerce.github.io/woocommerce-rest-api-docs/
- Webhooks: https://woocommerce.com/document/webhooks/

### 2.7 Brain Coverage Summary

| Area | Status | Evidence |
|---|---|---|
| Credential storage (consumer key/secret) | FULL | `woocommerce-orders-repull/run.ts` |
| 90-day re-pull | FULL | `woocommerce-orders-repull/run.ts` |
| Webhook receiver + HMAC validation | FULL | `woocommerceWebhookHandler.ts` |
| WooCommerce Hmac value object + tests | FULL | `WooCommerceHmac.ts` |
| silver_order_state coverage | FULL | via `order.live.v1` shared event |
| Sync-Now dispatch | PARTIAL | In REPULL_DISPATCH but MISSING from `enumerateConnectedConnectors()` |
| Automatic webhook registration on connect | MISSING | No `RegisterWooCommerceWebhooksCommand` |
| Backfill job (initial historical load) | MISSING | No dedicated backfill; re-pull covers 90d only |

**RECOMMENDED next:**
1. Add `list_woocommerce_connectors_for_repull()` call to `enumerateConnectedConnectors()` in `sync-request-claimer/run.ts` (one-line fix, closes the Sync-Now gap).
2. Build `RegisterWooCommerceWebhooksCommand` — POST `/wp-json/wc/v3/webhooks` for `order.created` + `order.updated` on connect.
3. Consider a dedicated backfill job for initial load if the 90-day re-pull window is insufficient.

---

## 3. Meta Ads

### 3.1 Authentication

**Mechanism:** Meta OAuth 2.0 (Authorization Code Grant). App-level OAuth via the Meta App Dashboard. Scope: `ads_read` (least privilege, confirmed `InitiateMetaOAuthCommand.ts` line 34).

**Token lifecycle:**
- Meta issues a short-lived token (~1 hour) on the OAuth callback. Brain immediately exchanges it for a long-lived token (~60 days) via `fb_exchange_token` at the callback handler (`HandleMetaOAuthCallbackCommand.ts` lines 113-121).
- Token issued-at is stored alongside the token in the Secrets Manager bundle (`access_token_issued_at`).
- `meta-token-refresh` job (`apps/stream-worker/src/jobs/meta-token-refresh/`) proactively re-exchanges the long-lived token when it is >= 30 days old (`DEFAULT_REFRESH_AGE_DAYS = 30`, `meta-token-client.ts` line 78). This prevents silent expiry death at ~60 days.
- Meta tokens CANNOT be refreshed after expiry — there is no refresh-token mechanism. A missed refresh requires the brand to reconnect.
- Token stored in AWS Secrets Manager; ARN in `connector_instance.secret_ref`. Never in Postgres (NN-2). Never logged (I-S09). Access token rides the `Authorization: Bearer` header (SEC-AD-M1 — never in URL).

**Meta API version:** `v22.0` (or current stable — confirm in `HandleMetaOAuthCallbackCommand.ts` `META_GRAPH_API_VERSION` constant).

**File evidence:**
- `apps/core/src/modules/connector/sources/advertising/meta/application/commands/InitiateMetaOAuthCommand.ts`
- `apps/core/src/modules/connector/sources/advertising/meta/application/commands/HandleMetaOAuthCallbackCommand.ts`
- `apps/stream-worker/src/jobs/meta-token-refresh/run.ts`
- `apps/stream-worker/src/jobs/meta-token-refresh/meta-token-client.ts`

### 3.2 Historical Sync / Backfill

**Mechanism:** Meta Marketing API — `/act_{ad_account_id}/insights` with `time_range`, `level=campaign/adset/ad`, `fields=[spend, impressions, clicks, ...]`, `time_increment=1` (daily breakdown). Paginated via `after` cursor.

**Re-pull window:** 28 days (`WINDOW_DAYS = 28`, `meta-spend-repull/run.ts` line 54). Meta insights are retroactively updated for up to 28 days (attribution window corrections, view-through attribution). Querying a trailing window captures these corrections.

**Cursor resource:** `meta.insights`. FOR UPDATE SKIP LOCKED overlap-lock.

**Rate-limit handling (EXISTS TODAY):** `META_RATE_LIMITED` error string detection in `meta-spend-repull/run.ts` lines 162-164, 202-204. On rate limit: marks `connector_sync_status.state = 'error'` with `'RateLimited — retry next run'` message, aborts the current run. Next scheduled run retries from the same cursor position.

**KafkaJS retry:** `retries: 5`.

**File evidence:**
- `apps/stream-worker/src/jobs/meta-spend-repull/run.ts`
- `packages/ad-spend-mapper/src/index.ts`

### 3.3 Real-Time Events

**No real-time webhooks for ad spend.** Meta does not offer webhooks for Ads Insights data. Spend/performance data is available only via the Marketing API polling mechanism. The re-pull job IS the real-time path (5-minute intervals via ingest-scheduler → 28-day trailing window).

Meta does offer Facebook Pixel server-side events (via Conversions API) for attribution signal delivery — but that is the outbound direction (Brain → Meta), not ingestion.

### 3.4 Key Entity-to-Silver Mappings

| Source Entity | Bronze Event Type | Silver Mart | Gold / Serving |
|---|---|---|---|
| Daily ad spend (campaign/adset/ad) | `ad_spend.daily.v1` | `silver_marketing_spend` | `gold_cac`, `gold_executive_metrics` |

**Silver mart:** `db/dbt/models/marts/silver_marketing_spend.sql` — currently reads from `oltp.ad_spend_ledger` (JDBC shim, Phase G re-point in progress). Source flip to `bronze_iceberg.ad_spend` is gated on the dbt INCREMENTAL-CTAS StarRocks cascade bug resolution.

**Mapper:** `packages/ad-spend-mapper/src/index.ts` — maps campaign/adset/ad spend to the canonical `ad_spend.daily.v1` event. Both Meta and Google Ads use the same mapper + event type → single `silver_marketing_spend` mart regardless of source.

### 3.5 Rate Limits

- Meta Marketing API: tiered by account spend level. Basic tier: ~200 calls/hour per app-token per ad account. Brain queries at the ad-set level with 1-day granularity — typical brands fit within basic tier.
- Rate limit header: `X-Business-Use-Case-Usage` response header signals remaining capacity. Brain currently detects rate limit via error string pattern (`#17`, `#32`) rather than proactive header inspection.
- RECOMMENDED: inspect `X-Business-Use-Case-Usage` proactively and back off before hitting the limit.

### 3.6 Official Documentation

- Marketing API: https://developers.facebook.com/docs/marketing-api/reference/adaccount/insights/
- OAuth: https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
- Long-lived tokens: https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived#long-lived-user-access-tokens
- Rate limits: https://developers.facebook.com/docs/marketing-api/overview/rate-limiting

### 3.7 Brain Coverage Summary

| Area | Status | Evidence |
|---|---|---|
| OAuth connect + long-lived token exchange | FULL | `HandleMetaOAuthCallbackCommand.ts` |
| Proactive token refresh (30-day threshold) | FULL | `meta-token-refresh/run.ts` |
| 28-day trailing-window spend re-pull | FULL | `meta-spend-repull/run.ts` |
| Rate limit detection + abort | FULL | `meta-spend-repull/run.ts` lines 162-204 |
| silver_marketing_spend | FULL (PG shim) | `db/dbt/models/marts/silver_marketing_spend.sql` |
| Sync-Now dispatch | FULL | REPULL_DISPATCH `meta` entry + `list_ad_connectors_for_spend_repull()` in `enumerateConnectedConnectors()` |
| Proactive rate limit header inspection | MISSING | Reactive error-string detection only |
| Campaign-level spend breakdown (creative) | PARTIAL | Depends on `fields` list in repull — verify coverage |

---

## 4. Google Ads

### 4.1 Authentication

**Mechanism:** Google OAuth 2.0 (Authorization Code Grant). Scope: `https://www.googleapis.com/auth/adwords` (Ads API access, confirmed `InitiateGoogleAdsOAuthCommand.ts`). `include_granted_scopes: 'true'` for incremental auth.

**Token lifecycle:**
- Google issues a short-lived access token + a long-lived refresh token.
- The refresh token does not expire unless explicitly revoked by the user. Brain stores both in AWS Secrets Manager.
- No proactive refresh job exists (unlike Meta). The Google OAuth2 client library refreshes the access token automatically using the refresh token when the access token expires (~1 hour).
- Token stored in Secrets Manager; ARN in `connector_instance.secret_ref`. Never in Postgres (NN-2).

**File evidence:**
- `apps/core/src/modules/connector/sources/advertising/google/application/commands/InitiateGoogleAdsOAuthCommand.ts`
- `apps/core/src/modules/connector/sources/advertising/google/application/commands/HandleGoogleAdsOAuthCallbackCommand.ts`
- `apps/stream-worker/src/jobs/google-ads-spend-repull/run.ts`

### 4.2 Historical Sync / Backfill

**Mechanism:** Google Ads API — GAQL (Google Ads Query Language) report query on `metrics.cost_micros`, `metrics.clicks`, `metrics.impressions`, `campaign.name`, `ad_group.name`, segmented by `segments.date`. REST HTTP endpoint: `POST /v18/customers/{customer_id}/googleAds:search`.

**Re-pull window:** 35 days (`WINDOW_DAYS = 35`, `google-ads-spend-repull/run.ts` line 57). Google Ads allows conversion data to be back-dated up to 90 days, but spend data is typically finalized within 3 days. 35 days provides a conservative buffer.

**Cursor resource:** `google_ads.spend`. FOR UPDATE SKIP LOCKED.

**Rate-limit handling:** Rate limit detection + abort-on-429 pattern (same as Meta). Marks `connector_sync_status.state = 'error'`.

**KafkaJS retry:** `retries: 5`.

**File evidence:**
- `apps/stream-worker/src/jobs/google-ads-spend-repull/run.ts`
- `packages/ad-spend-mapper/src/index.ts`

### 4.3 Real-Time Events

**No real-time webhooks for Google Ads spend data.** Google Ads API is polling-only for performance data. The 35-day trailing re-pull is the operational real-time path.

Google Ads does support offline conversion import (sending conversion events TO Google), but that is outbound attribution feedback, not ingestion.

### 4.4 Key Entity-to-Silver Mappings

| Source Entity | Bronze Event Type | Silver Mart | Notes |
|---|---|---|---|
| Daily ad spend (campaign/ad group) | `ad_spend.daily.v1` | `silver_marketing_spend` | Same event type + mart as Meta — multi-source |

Google Ads and Meta both produce `ad_spend.daily.v1` via `packages/ad-spend-mapper/src/index.ts`. `silver_marketing_spend` is source-agnostic (filters by event_type, not by source column). The `source` column on the Bronze event distinguishes them for drill-down.

### 4.5 Rate Limits

- Google Ads API: 15,000 operations/day per developer token (standard access). Basic access (most accounts): 1,000 requests/day. Each GAQL search = 1 request.
- Brain queries per connector instance per run. With many brands, daily quota exhaustion is a real risk.
- RECOMMENDED: implement per-brand quota tracking or move to Basic → Standard developer token approval.

**Official developer token tiers:** https://developers.google.com/google-ads/api/docs/access-levels

### 4.6 Official Documentation

- Google Ads API: https://developers.google.com/google-ads/api/docs/start
- GAQL: https://developers.google.com/google-ads/api/docs/query/overview
- OAuth: https://developers.google.com/identity/protocols/oauth2
- Rate limits: https://developers.google.com/google-ads/api/docs/best-practices/rate-limits

### 4.7 Brain Coverage Summary

| Area | Status | Evidence |
|---|---|---|
| OAuth connect + refresh token storage | FULL | `HandleGoogleAdsOAuthCallbackCommand.ts` |
| 35-day trailing-window spend re-pull | FULL | `google-ads-spend-repull/run.ts` |
| Rate limit detection + abort | FULL | `google-ads-spend-repull/run.ts` lines 167-181 |
| silver_marketing_spend | FULL (PG shim) | shared with Meta |
| Sync-Now dispatch | FULL | REPULL_DISPATCH `google_ads` + `list_ad_connectors_for_spend_repull()` |
| Proactive access token refresh job | MISSING | Implicit via OAuth library; no explicit refresh job |
| Developer token quota guard | MISSING | No quota tracking across brands |

---

## 5. GA4 (Google Analytics 4)

### 5.1 Current Status

**GA4 is a catalog placeholder only.** The connector registry entry (`apps/core/src/modules/connector/catalog/registry.ts` lines 129-136) shows:
```
id: 'ga4', category: 'analytics',
displayName: 'Google Analytics 4',
connectMethod: 'coming_soon',
availability: 'coming_soon'
```

No implementation files exist. No mapper, no repull job, no DB migration, no cursor, no OAuth flow.

### 5.2 Platform Capabilities (for implementation planning)

**Authentication:** Google OAuth 2.0 with scope `https://www.googleapis.com/auth/analytics.readonly`. Same OAuth infrastructure as Google Ads — the `HandleGoogleAdsOAuthCallbackCommand.ts` pattern can be reused.

**Data API (polling only):** GA4 Data API v1 — `POST https://analyticsdata.googleapis.com/v1beta/properties/{property_id}:runReport`. Returns aggregated dimension/metric data. NOT real-time; typical latency 24-48h for standard reports.

**Admin API:** `https://analyticsadmin.googleapis.com/v1beta/` — enumerate properties and streams.

**No webhooks.** GA4 does not offer push webhooks for analytics data. All data is polling-only.

**Key dimensions/metrics for Brain:**
- `sessionSource`, `sessionMedium`, `sessionCampaign` — marketing attribution (supplementary to pixel-based touchpoints).
- `purchaseRevenue`, `transactions` — supplementary revenue signal (NOT revenue SoR; Shopify/Razorpay is the SoR).
- `newUsers`, `activeUsers` — user acquisition metrics.
- `landingPage`, `pagePath` — funnel context.

**Ingestion mechanism:** Polling (no webhooks). Daily report pull for the previous day. 7-day trailing window recommended (GA4 data can be sampled for large properties; fresh data has higher fidelity than hourly exports).

**Rate limits:** 10 concurrent requests per property per project; 200,000 tokens per day (property-level quota). Sampling activates for properties with >10M events/day.

**Key entity-to-Silver mapping (target design):**

| GA4 Entity | Bronze Event Type | Silver Mart | Notes |
|---|---|---|---|
| Daily session report | `ga4.session_report.v1` | `silver_sessions` (supplement) | Supplementary to pixel sessions |
| Daily acquisition report | `ga4.acquisition.v1` | `silver_touchpoint` (supplement) | UTM-level aggregates |

**IMPORTANT:** GA4 is a supplementary analytics source, NOT a revenue SoR. GA4 revenue figures are based on client-side event tracking and are subject to sampling, ITP, and ad-blocker loss. Brain's revenue truth comes from Shopify + Razorpay. GA4 data enriches touchpoint context only.

### 5.3 Official Documentation

- Data API: https://developers.google.com/analytics/devguides/reporting/data/v1
- Admin API: https://developers.google.com/analytics/devguides/config/admin/v1
- Quotas: https://developers.google.com/analytics/devguides/reporting/data/v1/quotas

### 5.4 What to Build

1. OAuth flow (`InitiateGA4OAuthCommand`, `HandleGA4OAuthCallbackCommand`) — reuse Google OAuth infrastructure.
2. `ga4-report-repull/run.ts` — daily report polling job. Cursor: `ga4.session_report` (date). SECURITY DEFINER enumeration fn: `list_ga4_connectors_for_repull()`.
3. `@brain/ga4-mapper` package — map GA4 report rows to `ga4.session_report.v1` events. Hash `user_id` at boundary.
4. Add `ga4` to `REPULL_DISPATCH` and `enumerateConnectedConnectors()`.
5. `silver_sessions` and/or `silver_touchpoint` supplement with GA4 aggregate rows.

---

## 6. Razorpay

### 6.1 Authentication

**Mechanism:** API key + secret (Basic Auth). Razorpay uses static key ID + key secret — no OAuth, no token expiry.

**Credential fields:** `key_id` + `key_secret` stored as a composite bundle in AWS Secrets Manager. Additionally `webhook_secret` stored in the same bundle (C2). ARN in `connector_instance.secret_ref`.

**No token rotation.** Credentials are static until the merchant manually rotates them in the Razorpay Dashboard.

**File evidence:**
- `apps/stream-worker/src/jobs/razorpay-settlement-repull/run.ts` — credential extraction from Secrets Manager bundle.
- `apps/core/src/modules/connector/sources/payment/razorpay/interfaces/webhooks/razorpayWebhookHandler.ts` — webhook_secret fetch from Secrets Manager bundle.

### 6.2 Historical Sync / Backfill

**Mechanism:** Razorpay Settlement API — three separate cursor resources representing distinct settlement entity types:

| Resource | Cursor Key | Window | Razorpay API Endpoint |
|---|---|---|---|
| Settlement payments | `settlements.payments` | 30 days | `GET /v1/settlements/{id}/recon/combined` |
| Settlement reserves | `settlements.reserves` | 180 days | `GET /v1/settlements` |
| Settlement adjustments | `settlements.adjustments` | 90 days | `GET /v1/adjustments` |

**Why three cursors:** Razorpay's settlement model is complex — a settlement batch is a bundle of payments, refunds, fees, and adjustments. Reserves (the float/escrow component) have longer settlement cycles (up to 180 days). Each resource has independent pagination and update cadence.

**High-water cursor:** `from` / `to` epoch timestamps (Razorpay uses Unix timestamps). Cursor advances to `max(settled_at)` seen in the batch.

**File evidence:**
- `apps/stream-worker/src/jobs/razorpay-settlement-repull/run.ts`
- `packages/razorpay-mapper/src/index.ts`

### 6.3 Real-Time Events (Webhooks)

**Receiver:** `POST /api/v1/webhooks/razorpay`

**Signature:** `X-Razorpay-Signature = HMAC-SHA256(rawBody, webhook_secret)`. HMAC-first (NN-4). webhook_secret fetched from Secrets Manager by account_id lookup.

**Brand resolution:** `resolve_razorpay_connector_by_account(account_id)` SECURITY DEFINER fn. `brand_id` from DB row (MT-1) — never from webhook body.

**Covered events (EXISTS TODAY — `razorpayWebhookHandler.ts` lines 342-346):**
```
settlement.processed
refund.created
payment.failed
```

**Special handling:** `payment.captured` is handled separately (not in SETTLEMENT_EVENTS set) for **MB-1 map-table populate**: when Razorpay captures a payment, Brain upserts `connector_razorpay_order_map` with `(razorpay_payment_id, shopify_order_id)` — the cross-reference required to join Razorpay settlements to Shopify orders in the revenue ledger.

**Replay window:** 5-minute age gate on webhook events (C3). Events older than 5 minutes are rejected.

**Redis dedup:** SET NX EX on deterministic event_id after HMAC validation.

**Missing events (gap):**
- `refund.processed` — the settlement completion of a refund (vs `refund.created` which is the initiation).
- `refund.failed` — failed refund attempt.
- `payment.dispute.*` (`payment.dispute.created`, `payment.dispute.won`, `payment.dispute.lost`) — chargebacks. Critical for revenue truth.
- `order.paid` — Razorpay's own order completion event.
- `payment.authorized` — pre-capture state.

**File evidence:**
- `apps/core/src/modules/connector/sources/payment/razorpay/interfaces/webhooks/razorpayWebhookHandler.ts`

### 6.4 Key Entity-to-Silver Mappings

| Source Entity | Bronze Event Type | Silver Mart | Gold / Serving |
|---|---|---|---|
| Settlement payment | `settlement.live.v1` / `settlement.webhook.v1` | `gold_revenue_ledger` (via Iceberg Bronze) | `gold_executive_metrics` |
| Refund | `settlement.live.v1` (event_type=refund) | `gold_revenue_ledger` | |
| Payment capture (map-table) | (not a Bronze event — PG upsert only) | N/A — cross-reference table | Enables Shopify/Razorpay join |

**Revenue ledger source chain:**
```
Razorpay API → razorpay-settlement-repull → Kafka
  → Spark sink → bronze_iceberg.revenue_ledger
  → gold_revenue_ledger.sql (var ledger_source='iceberg')
  → gold_executive_metrics
```

**Silver mart:** `db/dbt/models/marts/gold_revenue_ledger.sql` — var-gated source flip (`ledger_source='iceberg'` reads from `bronze_iceberg.revenue_ledger`; `ledger_source='pg'` reads JDBC shim from `billing.realized_revenue_ledger`).

**Mapper:** `packages/razorpay-mapper/src/index.ts` — `mapSettlementItemToEvent()`. PII hashed at boundary. UTR (Unique Transaction Reference) hashed with per-brand salt (DPDP compliance).

### 6.5 Rate Limits

- Razorpay API: 300 requests/minute per key. Settlement API pages 100 records per request.
- Brain uses a trailing window approach — no explicit rate limit header inspection. A 429 propagates as an error, cursor not advanced, retries on next scheduled run.
- RECOMMENDED: inspect `Retry-After` header on 429 and implement exponential back-off within the run.

### 6.6 Official Documentation

- Settlements API: https://razorpay.com/docs/api/settlements/
- Webhooks: https://razorpay.com/docs/webhooks/
- Webhook events: https://razorpay.com/docs/webhooks/event-object/
- Refund events: https://razorpay.com/docs/api/refunds/
- Dispute (chargeback): https://razorpay.com/docs/payments/disputes/

### 6.7 Brain Coverage Summary

| Area | Status | Evidence |
|---|---|---|
| API key storage (key_id + key_secret + webhook_secret) | FULL | `razorpay-settlement-repull/run.ts` |
| Settlement payments re-pull (30d) | FULL | `razorpay-settlement-repull/run.ts` |
| Settlement reserves re-pull (180d) | FULL | `razorpay-settlement-repull/run.ts` |
| Settlement adjustments re-pull (90d) | FULL | `razorpay-settlement-repull/run.ts` |
| Webhook HMAC validation | FULL | `razorpayWebhookHandler.ts` |
| payment.captured → MB-1 map-table | FULL | `razorpayWebhookHandler.ts` lines 285-323 |
| settlement.processed webhook | FULL | SETTLEMENT_EVENTS set |
| refund.created webhook | FULL | SETTLEMENT_EVENTS set |
| payment.failed webhook | FULL | SETTLEMENT_EVENTS set |
| gold_revenue_ledger (Iceberg source) | FULL | `gold_revenue_ledger.sql` var-gated |
| Sync-Now dispatch | FULL | REPULL_DISPATCH + `enumerateConnectedConnectors()` |
| refund.processed webhook | MISSING | Not in SETTLEMENT_EVENTS |
| refund.failed webhook | MISSING | Not in SETTLEMENT_EVENTS |
| payment.dispute.* webhooks | MISSING | Chargebacks not captured |
| Retry-After header inspection | MISSING | |

---

## 7. Shiprocket

### 7.1 Authentication

**Mechanism:** Email + password exchanged at `POST https://apiv2.shiprocket.in/v1/external/auth/login` for a 10-day Bearer JWT. The JWT is minted and stored (in memory or Secrets Manager) by Brain; the email + password credential bundle is stored in Secrets Manager.

**Credential fields (`ConnectShiprocketCommand.ts` lines 31-34):**
```
email: string      // API-user email — never logged (I-S09)
password: string   // never logged (I-S09)
```

**Token refresh:** The 10-day JWT must be refreshed before expiry. The repull job (`shiprocket-shipment-repull/run.ts`) re-authenticates at the start of each run by exchanging email+password for a fresh JWT. This means credentials are fetched from Secrets Manager on every run — no token storage in Postgres (NN-2).

**Channel ID:** `shiprocket_channel_id` stored on `connector_instance` (migration 0059) as a non-secret lookup key for `list_shiprocket_connectors_for_repull()`.

**File evidence:**
- `apps/core/src/modules/connector/sources/logistics/shiprocket/application/commands/ConnectShiprocketCommand.ts`
- `apps/stream-worker/src/jobs/shiprocket-shipment-repull/run.ts`

### 7.2 Historical Sync / Backfill

**Mechanism:** Shiprocket Shipments API — `GET https://apiv2.shiprocket.in/v1/external/shipments` with `from_date`/`to_date` and page cursor. Returns paginated shipment objects including AWB number, status, order ID, channel ID.

**Re-pull window:** 45 days (`SHIPMENT_WINDOW_MS = 45 * 24 * 60 * 60 * 1000`, `shiprocket-shipment-repull/run.ts` line 66). 45 days covers most logistics return cycles.

**Cursor resource:** `shipment.lifecycle`. FOR UPDATE SKIP LOCKED.

**Enumeration:** `list_shiprocket_connectors_for_repull()` SECURITY DEFINER fn (confirms migration 0059). Called within the repull job (`run.ts` lines 10-11, 99, 115-166).

**Scheduler claim:** `claim_due_repull_connectors()` (migration 0053) works for Shiprocket (provider-agnostic function).

**Sync-Now gap:** `enumerateConnectedConnectors()` in `sync-request-claimer/run.ts` does NOT call `list_shiprocket_connectors_for_repull()`. Sync-Now is broken for Shiprocket (same gap as WooCommerce). Scheduled polling works correctly.

**File evidence:**
- `apps/stream-worker/src/jobs/shiprocket-shipment-repull/run.ts`
- `packages/shiprocket-mapper/src/index.ts`

### 7.3 Real-Time Events (Webhooks)

**No webhook receiver exists for Shiprocket.** Shiprocket offers status-update push webhooks (configurable in the Shiprocket dashboard), but Brain has not implemented a receiver endpoint.

All logistics data is obtained via the trailing-window polling job. This means logistics status changes are visible in Brain with up to a 1-interval lag (ingest-scheduler interval, typically 5-15 minutes).

**What Shiprocket webhooks offer:** `POST` callback with shipment status update payload including AWB number, order ID, current status. Signature: custom HMAC or API key in header (varies by Shiprocket version).

**RECOMMENDED:** Implement `POST /api/v1/webhooks/shiprocket` receiver for real-time status pushes. Reduces lag from interval polling to seconds. Required for real-time logistics alerts.

### 7.4 Key Entity-to-Silver Mappings

| Source Entity | Bronze Event Type | Silver Mart | Notes |
|---|---|---|---|
| Shipment status update | `shiprocket.shipment_status.v1` | `silver_shipment` (via `silver_shipment_event`) | Multi-source with GoKwik |
| AWB number | embedded (hashed at boundary) | `silver_shipment` | AWB hashed per I-S02 |

**Silver mart chain:**
```
shiprocket.shipment_status.v1 → bronze_iceberg.collector_events
  → stg_shipment_events.sql (filter: event_type IN ('gokwik.awb_status.v1', 'shiprocket.shipment_status.v1'))
  → silver_shipment_event.sql
  → silver_shipment.sql (latest-state, terminal-preferred)
```

**File evidence:**
- `db/dbt/models/staging/stg_shipment_events.sql` lines 7-8, 36
- `db/dbt/models/marts/silver_shipment_event.sql`
- `db/dbt/models/marts/silver_shipment.sql`
- `packages/shiprocket-mapper/src/index.ts`

**Terminal class authority:** `@brain/logistics-status` package provides shared deterministic `status→terminal_class` mapping for both GoKwik and Shiprocket (PR #207 merged). Immutable sets — a delivered shipment never reverts.

### 7.5 Rate Limits

- Shiprocket API: no publicly documented rate limit. De facto 10 requests/second observed. Brain pages 10 records/request by default.
- Re-auth on 401 (token expired): repull job re-fetches credentials from Secrets Manager and retries.

### 7.6 Official Documentation

- API Reference: https://apiv2.shiprocket.in/v1/external/
- Shipments: https://apiv2.shiprocket.in/v1/external/shipments
- Webhooks: https://support.shiprocket.in/support/solutions/articles/43000576133-setting-up-webhooks

### 7.7 Brain Coverage Summary

| Area | Status | Evidence |
|---|---|---|
| Credential storage (email + password bundle) | FULL | `ConnectShiprocketCommand.ts` |
| 45-day trailing-window repull | FULL | `shiprocket-shipment-repull/run.ts` |
| silver_shipment (multi-source mart) | FULL | `stg_shipment_events.sql`, `silver_shipment.sql` |
| @brain/logistics-status terminal class | FULL | `packages/logistics-status` (PR #207) |
| Sync-Now dispatch | PARTIAL | In REPULL_DISPATCH; MISSING from `enumerateConnectedConnectors()` |
| Webhook receiver | MISSING | No `shiprocketWebhookHandler.ts` |
| Automatic JWT refresh job | PARTIAL | Re-auth per run (pull); no proactive refresh between runs |

**RECOMMENDED next:**
1. Add `list_shiprocket_connectors_for_repull()` call to `enumerateConnectedConnectors()` in `sync-request-claimer/run.ts` (one-line fix, closes the Sync-Now gap — same fix as WooCommerce).
2. Implement `POST /api/v1/webhooks/shiprocket` receiver for real-time status pushes.

---

## 8. GoKwik

### 8.1 Authentication

**Mechanism:** API key + secret (custom header pair). No OAuth, no JWT.

**Credential fields (`gokwik-awb-client.ts` lines 35-37):**
```
appid: string      // NEVER logged (I-S09)
appsecret: string  // NEVER logged (I-S09)
```

**Headers:** `appid` and `appsecret` ride the API request headers (not Basic Auth). Stored as a bundle in AWS Secrets Manager; ARN in `connector_instance.secret_ref`.

**App ID:** `gokwik_appid` also stored on `connector_instance` (non-secret lookup column) for enumeration via `list_gokwik_connectors_for_awb_repull()`.

**File evidence:**
- `apps/stream-worker/src/jobs/gokwik-awb-repull/gokwik-awb-client.ts`
- `apps/stream-worker/src/jobs/gokwik-awb-repull/run.ts`

### 8.2 Historical Sync / Backfill

**Mechanism:** GoKwik AWB Read API — paginated endpoint returning AWB (Air Waybill) status records for a trailing window. Paged by `page` parameter, `GOKWIK_AWB_PAGE_SIZE` records per request.

**Re-pull window:** 45 days (`AWB_WINDOW_MS = 45 * 24 * 60 * 60 * 1000`, `gokwik-awb-repull/run.ts`). 45 days aligns with Shiprocket (both cover return cycles).

**Cursor resource:** `awb.lifecycle`. FOR UPDATE SKIP LOCKED.

**Enumeration:** `list_gokwik_connectors_for_awb_repull()` SECURITY DEFINER fn. Correctly included in `enumerateConnectedConnectors()` in `sync-request-claimer/run.ts` lines 125-130.

**Synthetic fallback:** `GOKWIK_SYNTH_FROM_ORDERS` env flag (default ON). When the GoKwik AWB API returns no data (or in dev without credentials), the job synthesizes AWB records from Shopify order fulfillment data. This is a dev/testing bridge — production must flip to real GoKwik API calls.

**AWB client in dev:** `GokwikAwbClient` is a synthetic stub in dev (never hits network). The `GokwikAwbClient` constructor accepts `_credentials: GokwikApiCredentials` and `extraRecords: GokwikAwbRecord[]`. The real HTTP implementation requires production credentials.

**File evidence:**
- `apps/stream-worker/src/jobs/gokwik-awb-repull/run.ts`
- `apps/stream-worker/src/jobs/gokwik-awb-repull/gokwik-awb-client.ts`
- `packages/gokwik-mapper/src/index.ts`

### 8.3 Real-Time Events

**Checkout signals (EXISTS TODAY):** GoKwik RTO-predict (`gokwik.rto_predict.v1`) is produced by the `gokwik-rto-predict-emit` job (`apps/stream-worker/src/jobs/gokwik-rto-predict-emit/`). This is a computed signal (Brain's own prediction), not a GoKwik push event.

**No real-time webhooks for AWB lifecycle.** GoKwik does not offer push webhooks for AWB status changes. All AWB data is obtained via the trailing-window polling job.

**GoKwik checkout events:** GoKwik offers a checkout event stream for RTO risk scoring inputs. These are read via API polling, not webhooks. The `silver_checkout_signal` mart (`db/dbt/models/marts/silver_checkout_signal.sql`) aggregates GoKwik RTO-Predict + Shopflo checkout signals.

### 8.4 Key Entity-to-Silver Mappings

| Source Entity | Bronze Event Type | Silver Mart | Notes |
|---|---|---|---|
| AWB status update | `gokwik.awb_status.v1` | `silver_shipment` (via `silver_shipment_event`) | Multi-source with Shiprocket |
| RTO predict signal | `gokwik.rto_predict.v1` | `silver_checkout_signal` | Brain-computed; not GoKwik push |
| AWB number | embedded (hashed at boundary per I-S02) | `silver_shipment` | |

**AWB hash:** AWB numbers are hashed at the `@brain/gokwik-mapper` boundary (I-S02 — PII). The `order_id` is passed through (non-PII internal identifier).

**Mapper:** `packages/gokwik-mapper/src/index.ts` — `GOKWIK_AWB_STATUS_V1_EVENT_NAME`, `GOKWIK_AWB_PAGE_SIZE`, `GOKWIK_AUTH_ERROR`.

### 8.5 Rate Limits

- GoKwik API: not publicly documented. Brain pages at `GOKWIK_AWB_PAGE_SIZE` records/request.
- `GOKWIK_AUTH_ERROR` detection: on auth failure, marks connector_sync_status error and records `connector_auth_rejected_total` metric.

### 8.6 Official Documentation

- GoKwik Developer Portal: https://developer.gokwik.co/ (requires partner access)
- AWB API: internal GoKwik merchant portal documentation (not public)

### 8.7 Brain Coverage Summary

| Area | Status | Evidence |
|---|---|---|
| Credential storage (appid + appsecret) | FULL | `gokwik-awb-client.ts` |
| 45-day trailing-window AWB repull | FULL | `gokwik-awb-repull/run.ts` |
| Enumeration via `list_gokwik_connectors_for_awb_repull()` | FULL | `sync-request-claimer/run.ts` lines 125-130 |
| silver_shipment (multi-source mart) | FULL | shared with Shiprocket |
| @brain/logistics-status terminal class | FULL | `packages/logistics-status` |
| Sync-Now dispatch | FULL | REPULL_DISPATCH + `enumerateConnectedConnectors()` |
| silver_checkout_signal (RTO) | FULL | `db/dbt/models/marts/silver_checkout_signal.sql` |
| Real AWB API calls in dev | MISSING | Synthetic client only; dev returns stub data |
| Webhook / push receiver | MISSING | Not offered by GoKwik |

---

## 9. Shopflo

### 9.1 Authentication

**Mechanism:** Shopflo sends a `X-Shopflo-Signature` HMAC header with each webhook delivery. The shared secret is provisioned by Shopflo during onboarding and stored in AWS Secrets Manager.

**No OAuth flow.** Shopflo is webhook-only — there is no polling API for historical data. The connector is configured by providing Brain's webhook endpoint URL to Shopflo and receiving the shared secret.

**Credential fields:** `webhook_secret` stored in Secrets Manager; ARN in `connector_instance.secret_ref`.

**Brand resolution:** Shopflo sends a `brand_id` or equivalent identifier in the webhook payload header. `brand_id` authority is from the DB row (MT-1) — the header is used as a lookup key only.

**File evidence:**
- `apps/core/src/modules/connector/sources/checkout/shopflo/interfaces/webhooks/shopfloWebhookHandler.ts`
- `packages/shopflo-mapper/src/index.ts`

### 9.2 Historical Sync / Backfill

**No historical sync capability.** Shopflo is webhook-only by design. There is no Shopflo REST API for querying past checkout events.

- No repull job exists for Shopflo.
- Shopflo is absent from `REPULL_DISPATCH` in `sync-request-claimer/run.ts`.
- Shopflo is absent from `enumerateConnectedConnectors()`.
- Shopflo is absent from `claim_due_repull_connectors()` results (no scheduled repull).

This is correct by design — Shopflo's value is real-time checkout abandonment capture. Brands connecting Shopflo after going live will not receive historical abandoned checkout data.

**Implication:** `silver_checkout_signal` has a cold-start gap for newly connected Shopflo brands. Historical abandoned carts prior to connection are invisible.

### 9.3 Real-Time Events (Webhooks)

**Receiver:** `POST /api/v1/webhooks/shopflo`

**Signature:** `X-Shopflo-Signature` = HMAC-SHA256 (exact header name / algorithm — confirm with Shopflo partner docs; handler validates this before payload parsing). HMAC-first (NN-4).

**Covered events (EXISTS TODAY — `shopfloWebhookHandler.ts` line 227):**
```
checkout_abandoned
```
Unknown events are fast-acked (200 OK, no-op) without payload processing.

**Replay window:** `SHOPFLO_REPLAY_WINDOW_SECONDS = 5 * 60` (5 minutes, line 85). Events older than the replay window are rejected (C3 — replay protection).

**Redis dedup:** SET NX EX on deterministic event_id after HMAC validation. `event_id = uuidV5FromShopfloCheckout(brandId, checkout_id, occurred_at)` — dedup key, Bronze key, and correlation ID.

**Missing events (gap):**
- `order_placed` — Shopflo order confirmation (if Shopflo handles checkout completion).
- `checkout_initiated` — start of checkout funnel.
- `payment_initiated` — customer reached payment step.

**File evidence:**
- `apps/core/src/modules/connector/sources/checkout/shopflo/interfaces/webhooks/shopfloWebhookHandler.ts`
- `packages/shopflo-mapper/src/index.ts`

### 9.4 Key Entity-to-Silver Mappings

| Source Entity | Bronze Event Type | Silver Mart | Notes |
|---|---|---|---|
| Abandoned checkout | `shopflo.checkout_abandoned.v1` | `silver_checkout_signal` | Multi-source with GoKwik RTO |

**Silver mart:** `db/dbt/models/marts/silver_checkout_signal.sql` — grain: `(brand_id, event_id)`. Multi-source: GoKwik RTO-Predict + Shopflo checkout_abandoned. Additive design — new event_types extend the mart without schema change.

**Mapper:** `packages/shopflo-mapper/src/index.ts` — `SHOPFLO_CHECKOUT_ABANDONED_V1_EVENT_NAME`, `uuidV5FromShopfloCheckout()`.

### 9.5 Rate Limits

- Not applicable (webhook-only). Brain is the receiver, not the caller. Shopflo's delivery rate depends on their checkout volume.
- Brain's webhook endpoint must be able to handle Shopflo's peak delivery rate. The Fastify server + Kafka producer handles this asynchronously (respond 200 quickly, produce to Kafka, return).

### 9.6 Official Documentation

- Shopflo Developer Portal: https://developer.shopflo.com/ (requires partner access)
- Webhook events: Shopflo partner onboarding documentation (not public)

### 9.7 Brain Coverage Summary

| Area | Status | Evidence |
|---|---|---|
| Webhook HMAC validation | FULL | `shopfloWebhookHandler.ts` |
| checkout_abandoned event handling | FULL | `shopfloWebhookHandler.ts` lines 227-360 |
| 5-minute replay window + rejection | FULL | `SHOPFLO_REPLAY_WINDOW_SECONDS = 5*60` |
| Redis dedup (SET NX EX) | FULL | `shopfloWebhookHandler.ts` |
| silver_checkout_signal | FULL | `db/dbt/models/marts/silver_checkout_signal.sql` |
| Historical backfill | MISSING | By design — Shopflo is webhook-only |
| order_placed / checkout_initiated events | MISSING | Only checkout_abandoned handled |

---

## Appendix A — Connector Platform Flow (All Providers)

```
                          CONNECT (OAuth / API key entry)
                                    │
                          ConnectXxxCommand.ts
                          │  - store credentials in Secrets Manager
                          │  - create connector_instance row (brain_app, RLS)
                          │  - create connector_cursor row
                          │  - emit connector.connected event
                          │
                    ┌─────┴──────────────────────────────┐
                    │                                    │
              WEBHOOK RECEIVER                    POLLING JOBS
              (real-time lane)                (stream-worker tier)
                    │                                    │
         POST /api/v1/webhooks/{provider}    ingest-scheduler (claim_due_repull_connectors)
         HMAC-first → brand resolution       + sync-request-claimer (tick every 5s)
         → map via @brain/{provider}-mapper       │
         → emit to live Kafka topic          list_{provider}_connectors_for_repull()
                    │                        GUC set → FOR UPDATE SKIP LOCKED cursor lock
                    │                        GET provider API (trailing window)
                    │                        → map via @brain/{provider}-mapper
                    │                        → emit to live/backfill Kafka topic
                    │                             │
                    └─────────────┬───────────────┘
                                  │
                    {env}.collector.event.v1  (live)
                    {env}.collector.order.backfill.v1  (backfill)
                                  │
                          Spark Kafka→Iceberg sink
                                  │
                      bronze_iceberg.collector_events
                      (append-only, dedup: ON CONFLICT DO NOTHING on event_id)
                                  │
                          dbt (StarRocks, incremental)
                                  │
              ┌───────────────────┼───────────────────────┐
              │                   │                       │
       silver_order_state  silver_shipment   silver_marketing_spend
       silver_order_line   silver_checkout_signal   silver_customers
       silver_touchpoint
              │
       gold_revenue_ledger  gold_cac  gold_executive_metrics
       gold_customer_scores  gold_cohorts
```

---

## Appendix B — Sync-Now (On-Demand) Dispatch Status

The `sync-request-claimer` tick (`apps/stream-worker/src/jobs/sync-request-claimer/run.ts`) claims sentinel `connector_cursor` rows written by `POST /api/v1/connectors/{id}/sync` and dispatches the provider's `run()`.

| Provider | In REPULL_DISPATCH | In enumerateConnectedConnectors() | Sync-Now Status |
|---|---|---|---|
| shopify | YES (line 51) | YES — `list_connectors_for_repull()` | FULL |
| razorpay | YES (line 52) | YES — `list_razorpay_connectors_for_settlement_repull()` | FULL |
| meta | YES (line 54) | YES — `list_ad_connectors_for_spend_repull()` | FULL |
| google_ads | YES (line 55) | YES — `list_ad_connectors_for_spend_repull()` | FULL |
| gokwik | YES (line 56) | YES — `list_gokwik_connectors_for_awb_repull()` | FULL |
| shiprocket | YES (line 57) | NO — `list_shiprocket_connectors_for_repull()` not called | BROKEN (Sync-Now only; scheduled poll works) |
| woocommerce | YES (line 58) | NO — `list_woocommerce_connectors_for_repull()` not called | BROKEN (Sync-Now only; scheduled poll works) |
| shopflo | NO | NO — webhook-only, no repull | N/A (correct by design) |
| ga4 | NO | NO — not implemented | N/A (catalog placeholder) |

**Fix for shiprocket + woocommerce Sync-Now:** Add to `enumerateConnectedConnectors()` in `apps/stream-worker/src/jobs/sync-request-claimer/run.ts`:

```typescript
const shiprocket = await pool.query<{ connector_instance_id: string; brand_id: string }>(
  `SELECT connector_instance_id, brand_id FROM list_shiprocket_connectors_for_repull()`,
);
for (const r of shiprocket.rows) {
  rows.push({ ...r, provider: 'shiprocket' });
}

const woocommerce = await pool.query<{ connector_instance_id: string; brand_id: string }>(
  `SELECT connector_instance_id, brand_id FROM list_woocommerce_connectors_for_repull()`,
);
for (const r of woocommerce.rows) {
  rows.push({ ...r, provider: 'woocommerce' });
}
```

---

## Appendix C — Security Invariants (All Connectors)

| Invariant | Rule | Enforcement point |
|---|---|---|
| MT-1 | `brand_id` always from DB SECURITY DEFINER fn result, never from request payload | All webhook handlers + repull enumeration fns |
| NN-2 | No credentials / tokens in Postgres; only Secrets Manager ARNs in `secret_ref` | `ConnectXxxCommand.ts` (all connectors) |
| NN-4 | HMAC validation before any payload parsing or DB lookup | All webhook handlers |
| I-S02 | PII hashed at mapper boundary using per-brand salt | All `@brain/{provider}-mapper` packages |
| I-S07 | Money in integer minor units + `currency_code` | All mappers + money ledger writers |
| I-S09 | Secrets never logged at any log level | All repull jobs + OAuth handlers |
| RLS | FORCE RLS on all connector tables; two-arg `current_setting('app.current_brand_id', true)` pattern | Postgres migrations |
| Dedup | Deterministic `event_id = uuidV5(...)` → Bronze `ON CONFLICT DO NOTHING` | All mappers |
| Overlap-lock | `FOR UPDATE SKIP LOCKED` on `connector_cursor` row per connector_instance_id | All repull jobs |
| GUC order | `set_config('app.current_brand_id', ...)` AFTER enumerate, BEFORE any brand-scoped read/write | All repull jobs (ADR-LV-7) |
