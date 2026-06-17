# Requirement: Deep Shopify live connector — webhooks + 35-day re-pull (keep Boddactive fresh)

| Field | Value |
|-------|-------|
| **req_id** | `feat-shopify-live-connector` |
| **Title** | Deep Shopify live sync — order webhooks (HMAC-first) + the COD 35-day re-pull, landing on the live lane |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-17T16:13:32Z |
| **Tier impact** | Connector-ingestion epic §3 (Live sync) — keeps the connected store fresh after backfill |
| **Region impact** | India (COD: status changes weeks after placement → the 35-day re-pull is essential) |

---

## Lane *(advisor to confirm — deterministic scan: high_stakes; surfaces: connectors, multi_tenancy, money, pii, schema_proto, outbound_channel, oauth/secrets)*

---

## Raw text (from the Stakeholder)

> Build the **deep Shopify live connector** — epic §3. The backfill (`feat-connector-backfill`, shipped) pulled Boddactive's 24-month history; now KEEP IT FRESH as new orders arrive and old ones change status. Wire the EXISTING scaffolds: the webhook handler `apps/core/src/modules/connector/sources/storefront/shopify/interfaces/webhooks/shopifyWebhookHandler.ts` (HMAC-first at `POST /api/v1/webhooks/shopify/:topic`), `ShopifyHmac`, the collector `/collect` accept-before-validate edge, the LIVE lane (`dev.collector.event.v1` / `stream-worker-live` / `CollectorEventConsumer`), and `connector_cursor` (0006). Reuse the backfill's order→Bronze mapper + the paged Admin client + the metric-engine path.
>
> DELIVER:
> 1. **Order webhooks (event-driven, the freshness path):** on a connected store, REGISTER Shopify webhooks (orders/create, orders/updated, orders/paid, orders/fulfilled, orders/cancelled) → the receiver validates the Shopify HMAC as the ABSOLUTE FIRST op (NN-4; the webhook signature over the raw body), resolves the brand from the shop→connector mapping (brand_id ASSERTED from connector_instance, NEVER from the webhook body), maps the order to the SAME Bronze order event shape the backfill uses (hashed PII only, D-10), and emits it to the LIVE lane (collector → Redpanda → stream-worker → Bronze). Freshness target: 95% < 30s, 99% < 2min.
> 2. **The COD 35-day re-pull (the catch-up path):** a polling sync that re-pulls orders updated in a trailing 35-day window (`updated_at_min = now-35d`) via the Admin API, cursor-tracked in `connector_cursor` (resource='orders', high-water = updated_at), overlap-locked per (connector, brand), on a schedule. India COD status changes weeks after placement (RTO/delivery) — the cursor is NEVER "final" inside the window. Reuses the backfill paged client + order mapper, lands on the LIVE lane.
> 3. **Idempotent + dedup-with-backfill:** the SAME deterministic event_id (sha256(brand_id:order_id) → uuid) as the backfill, so a webhook order, a re-pulled order, and a backfilled order COLLAPSE to one Bronze row (insert-if-absent on event_id). The server/connector value wins on disagreement (effectively-once).
> 4. **Recognition flows through the existing ledger:** updated orders (status changes) flow Bronze → identity → the realized-revenue ledger as NEW signed rows (provisional → finalized → reversal) — the ledger is append-only; a late RTO/refund is a new negative row, never an edit. The dashboard number updates as live data lands.
> 5. **Per-brand isolation + secrets:** the webhook receiver + the re-pull are brand-scoped (RLS FORCE); brand_id asserted from the connector mapping; the token read from the secrets seam (DEV-TOKEN-REACH dev_secret / prod AWS); webhook HMAC over the API secret; no raw PII in events/Bronze/logs; cross-brand = 0 under `SET ROLE brain_app`.
> 6. **Sync health:** `connector_sync_status` reflects live sync (syncing/connected + last_sync_at) as webhooks/re-pulls land; the dashboard Connection Status stays truthful.
> 7. **Automated tests:** a synthetic order webhook (HMAC-valid) → Bronze on the LIVE lane (not backfill), brand-scoped; HMAC-invalid webhook → 401, no write; the re-pull pulls updated-in-window orders, cursor advances/resumes; webhook + backfill dedup to ONE Bronze row (same event_id); a late status change creates a new ledger row (RTO reversal), sale row untouched; isolation negative-control under `brain_app`; overlap-lock (no double re-pull).

---

## Problem statement

The backfill loaded history, but without live sync the data goes stale the moment a new Boddactive order is placed or an existing one ships/RTOs. India COD makes this acute: an order's economic truth changes for weeks after placement (delivery, RTO, refund). The deep Shopify live connector keeps the store fresh two ways — webhooks for near-real-time new/changed orders, and a 35-day re-pull to catch the late COD status changes webhooks can miss — both landing through the SAME spine the backfill proved (Bronze → identity → ledger → metric → dashboard), so the dashboard number tracks reality.

## Target user

Owner / Brand Admin whose connected store's numbers must stay current. India DTC brand, M1. (Boddactive is the live target.)

## Success metric

A new/changed order on a connected store appears in Bronze (live lane) within the freshness target via webhook; the 35-day re-pull catches updated orders and advances its cursor; a webhook/re-pull/backfill of the same order is ONE Bronze row (event_id dedup); a late RTO creates a new negative ledger row (sale untouched) and the dashboard realized/provisional updates; cross-brand = 0 under `brain_app`. Proven by automated tests (+ optionally a real Boddactive webhook/re-pull validation).

## Constraints

- **Same code path, same Bronze shape as backfill** (the §governing principle): webhooks + re-pull reuse the backfill order→event mapper + the deterministic event_id (dedup across all three sources). Live lane (NOT the backfill lane).
- **HMAC-first (NN-4):** the webhook receiver validates the Shopify webhook HMAC over the RAW body as the absolute first op; any failure → 401, no processing. brand_id from the connector mapping, never the webhook body.
- **Append-only ledger:** status changes are NEW signed rows (the ledger already owns recognition); never edit a row. Per-currency (Boddactive=INR), no float.
- Absolute brand/tenant isolation (the ONE invariant); RLS FORCE; verify under `SET ROLE brain_app`. No raw PII in events/Bronze/logs (hashed at the boundary). Token from the secrets seam, never logged.
- Idempotent + replayable (I-ST04): Bronze insert-if-absent on event_id; cursor upsert on connector_cursor.
- Hard rule: **no NEW deployable** — the webhook receiver in the existing core (or collector), the re-pull as a stream-worker job (like the backfill worker), the live lane already exists. Migrations additive (likely none — connector_cursor + connector_sync_status exist).

## Non-goals

- **Settlement / net-of-fees / Razorpay** (realized stays horizon-finalized GMV gross-of-fees, labeled — the settlement connector is a separate slice).
- **Meta / Google Ads / other connectors** — Shopify orders only.
- **Full Argo Workflows cron orchestration** — M1 uses a simpler scheduler/trigger for the re-pull (dev: manual/triggered, like the backfill; prod cron is a platform follow-up).
- **The public webhook-URL infra (tunnel/ingress)** — Shopify can't reach `localhost`, so in DEV the webhook receiver is proven with synthetic HMAC-signed POSTs + the 35-day re-pull is what keeps dev actually fresh. Real production webhook delivery needs a public ingress (platform follow-up). Be HONEST about this dev limitation (as the backfill was about real OAuth).
- **The connector-health detector / tracking-dark / DQ A+→D gating** — a later slice; this slice keeps sync truthful via connector_sync_status only.
- Product/customer/inventory webhooks — orders only (the realized-revenue spine).

## Linked prior runs

- feat-connector-backfill (the order→event mapper, the deterministic event_id, the paged Admin client, the worker pattern this reuses), feat-connector-marketplace (connect + secret_ref + the webhook handler scaffold), feat-data-plane-ingest-spine (the collector→Redpanda→stream-worker→Bronze LIVE lane), feat-realized-revenue-ledger (append-only recognition the status changes flow through), feat-analytics-api-dashboard (the number that updates).

## Notes

- Scaffolds: `shopifyWebhookHandler.ts` (HMAC-first POST /api/v1/webhooks/shopify/:topic — needs raw-body + the brand resolution + the order→event emit wired), `ShopifyHmac` (HMAC validate — confirm it covers the WEBHOOK signature, not just OAuth callback), the collector `/collect` edge + the live lane, `connector_cursor` (the re-pull watermark), the backfill `order-mapper`/`shopify-paged-client`/`uuidV5FromOrderBackfill` (reuse — the event_id MUST match so webhook/re-pull/backfill dedup), `connector_sync_status`.
- **Architect must bind:** where the webhook receiver lives (core vs collector) + the raw-body capture + the shop→brand resolution (a lookup by shop_domain → connector_instance, asserting brand_id — guard against a spoofed shop header by binding it to the HMAC-verified payload/registration); the webhook registration step (on connect, or an explicit enable — and the callback URL, which in dev is non-public → registration may be a no-op/stubbed in dev with synthetic-POST tests); the live-lane emission (via collector /collect vs direct produce — note backfill went DIRECT to its topic; webhooks could go through the collector accept-before-validate edge for the 99.95% durability, or direct — bind it); the re-pull job (stream-worker, reuse backfill loop with updated_at_min + connector_cursor + overlap-lock + the LIVE lane); the event_id reuse (MUST equal the backfill's for dedup); how status-change updates create new ledger rows (the existing recognition path); the dev-honesty boundary (synthetic webhooks + re-pull for dev; public ingress = follow-up).
- Builder lesson (carried, reinforced by the lifecycle gap we just closed): tight scopes + COMMIT PER SLICE, and TEST THE LIFECYCLE (a webhook + a re-pull + dedup-with-backfill, not just one happy path). Tracks: **@backend-developer** (webhook receiver + HMAC + brand resolution + registration + sync_status) ∥ **@data-engineer** (the 35-day re-pull job + cursor + live-lane landing + dedup + the recognition flow) ∥ **@frontend-web-developer** (the live-sync status surface + freshness indicator on the dashboard/connector tile). Verify isolation under `SET ROLE brain_app`. Reuse the connector-lifecycle-regression patterns/fixtures.
- This makes the connected store SELF-UPDATING — the M1 connector path is then complete end-to-end (connect → backfill → live sync), and the dashboard tracks reality as Boddactive's orders evolve.
