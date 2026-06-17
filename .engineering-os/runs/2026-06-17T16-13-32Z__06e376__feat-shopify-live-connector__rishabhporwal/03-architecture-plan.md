# Architecture Plan — feat-shopify-live-connector
**Stage:** 2 — Architecture (binding) · **Lane:** high_stakes · **Branch:** `feat/shopify-live-connector`
**Author:** Architect · **Date:** 2026-06-17 · **Paradigm:** Tier-0 deterministic ($0/mo model spend — pure data pipeline; no LLM/ML)
**Inputs honored:** `02-cto-advisor-review.md` D-1..D-14 (all) + Success Criteria §7 + Scope Cuts §8 + durable rule `system-job-force-rls-enumeration`.

> **The product (the make-or-break):** webhooks are the PRIMARY live path; the 35-day re-pull is the COD catch-up. Both land on the **generic live streaming substrate** (`dev.collector.event.v1` → `stream-worker-live` → Bronze) — Shopify is the first source wired to it; every future connector plugs into the same lane. The single hardest decision is **D-6**: a LIVE order must produce a NEW Bronze row per STATE (so status changes land, not get deduped away), while a re-pull retry of the SAME state dedups, and the backfill row never collides. Resolution below, with a worked example across backfill→webhook→re-pull→RTO.

---

## 0. Codebase grounding (cited — no abstract bullets)

| Fact | Evidence |
|---|---|
| Webhook scaffold exists; reads `shop_domain` from header (D-4 gap) + has no Kafka producer | `apps/core/.../webhooks/shopifyWebhookHandler.ts:66` (header), `:70` (emitEvent stub), `:33` rawBody flag |
| `ShopifyHmac.validateWebhook` IS correct — HMAC-SHA256 over raw body, base64, timing-safe | `apps/core/.../domain/value-objects/ShopifyHmac.ts:70-91` |
| Core registers Shopify routes in `main.ts`; webhook path already exempt from auth guard | `apps/core/src/main.ts:43-44`, `:212` (`/api/v1/webhooks/` exempt) |
| Core has **no Kafka producer wired** (emitEvent is a passed dep used only by pixel/tests) — webhook receiver must wire one | grep: no `new Kafka`/`producer` in `apps/core/src/main.ts` |
| Backfill mapper + money + uuid live in stream-worker (cross-app import problem) | `apps/stream-worker/src/jobs/shopify-backfill/order-mapper.ts`, `money-utils.ts`, `uuid-utils.ts` |
| Backfill event_id = sha256(`brand:order:order.backfill.v1`) → UUIDv5-shaped; ONE id per (brand,order) | `uuid-utils.ts:32-56` |
| Backfill emits **direct to Redpanda** on the backfill topic | `run.ts:421-425` |
| Live lane = `dev.collector.event.v1`, group `stream-worker-live`, `CollectorEventConsumer` → `ProcessEventUseCase` → Bronze | `apps/stream-worker/src/main.ts:37-54` |
| Backfill enumeration uses SECURITY DEFINER `list_queued_backfill_jobs()`; GUC set after | `run.ts:226-253`, migration `0023` |
| `loadConnectorInstance` = the GUC-after-enumerate template (BEGIN; set_config; SELECT; COMMIT) | `run.ts:255-296` |
| `LedgerWriter` writes ONLY `provisional_recognition`, `ON CONFLICT (brand,order,event_type,occurred_at::date) DO NOTHING` | `LedgerWriter.ts:77-153` |
| Finalization writes `finalization` rows; **CHECKS** for `rto_reversal`/`cancellation` but **nothing writes them** | `revenue-finalization.ts:134-146`, `:159-206` |
| Ledger schema ALREADY allows `rto_reversal`/`cancellation` event_type; `realized_gmv_as_of` subtracts them; `recognition_label ∈ {provisional,settling,finalized}` (no 'reversal' label) | `0018:66-78`, `:87-88`, `:165-186` |
| Ledger is append-only by GRANT (SELECT+INSERT only, no UPDATE/DELETE) | `0018:119-123`, `:229-244` |
| `connector_instance` FORCE RLS; `UNIQUE (brand_id, provider)`; cols brand_id/provider/shop_domain/secret_ref | `0006:19-50` |
| `connector_sync_status.state ∈ {connected,syncing,waiting_for_data,error}`, `last_sync_at`, UNIQUE(brand,ci) | `0006:57-59`, `0025:25-26` |
| `connector_cursor` UNIQUE(brand,ci,resource) — upsert key; backfill uses resource='orders' | `0006:82-91`, `run.ts:446-451` |
| Worker secrets path (DEV-TOKEN-REACH dev_secret 0024 + AWS prod) proven live | `worker-secrets.ts:36-131` |
| BFF connector-status route returns `syncState`+`lastSyncAt` already | `bff.routes.ts:651-710`; `GetConnectorStatusQuery.ts` |
| Web tile consumes it: `components/connectors/connectors-list.tsx` + `backfill-control.tsx` | `apps/web/components/connectors/` |
| Latest migration = `0025` → new work is `0026` | `db/migrations/` |

**Single-Primitive sweep: CLEAN (extend-only).** Reuse: `ProcessEventUseCase`, `CollectorEventConsumer`/live lane, `LedgerWriter`, `revenue-finalization`, `IdentityBridgeConsumer`, `connector_cursor`/`connector_sync_status`, `worker-secrets`, `SaltProvider`, the SECURITY-DEFINER-enumeration pattern (`0023`), `assertBrainApp` + dual-pool harness (`chore-connector-lifecycle-regression`), the BFF status route + web tile. **New:** 1 shared package, 1 webhook-receiver wire, 1 re-pull job, **1 new ledger event_type writer (reversal)**, 2 SECURITY DEFINER fns (additive `0026`). No new deployable, no new lane, no new topic (D-14 dedicated re-pull topic is a documented future option).

---

## 1. Bound seams (one-line ADRs)

- **ADR-LV-0 (A0 — D-12, FROZEN FIRST):** Extract `packages/shopify-mapper` (`@brain/shopify-mapper`) exporting `mapOrderToEvent`, `decimalStringToMinor`, `uuidV5FromOrderBackfill`, **new `uuidV5FromOrderLive`**, and the live event-name/properties contract — a REAL workspace package (`main: src/index.ts`, `tsc -b`, `workspace:*`), imported by BOTH `stream-worker` (re-pull) and `core` (webhook receiver). Mirrors `@brain/money`/`@brain/identity-core` (both already dual-imported). Retires the cross-rootDir deep-import class (QA-CLR-LOW-01). The backfill keeps importing the SAME functions from this package (move, not fork).
- **ADR-LV-1 (D-1):** Webhook receiver stays in `apps/core` (the scaffold's home), registered in `main.ts` beside the other Shopify routes.
- **ADR-LV-2 (D-2):** Raw body via `@fastify/raw-body` (or `addContentTypeParser` capturing `req.rawBody: Buffer`) registered in core bootstrap BEFORE the webhook route; `config.rawBody:true` already declared. Builder confirms the plugin is wired (currently the flag exists but the plugin is unverified — D-2 says verify).
- **ADR-LV-3 (D-3):** Webhook receiver emits **direct produce** to `dev.collector.event.v1` (the live topic) via a core-owned KafkaJS producer — same durability profile as the backfill's direct produce, no new cross-service network dependency on the collector from core. (Collector `/collect` accept-before-validate is the documented future hardening for 99.95% spool durability; not M1 — keeps core→collector decoupled.)
- **ADR-LV-4 (D-4, CRITICAL — resolved §2):** HMAC-first over raw body, THEN resolve brand from a SECURITY DEFINER shop→connector lookup; `brand_id` from the row, never the header/body; no connector → 401.
- **ADR-LV-5 (D-5):** Webhook registration runs on connect (or enable-live-sync), **env-gated no-op in dev** (`if (APP_ENV !== 'production') { log skip; return }`) because the dev callback URL is non-public; the registration code path + dev stub ship now, real delivery is the public-ingress follow-up.
- **ADR-LV-6 (D-6, CRITICAL — resolved §3):** LIVE event_id = `uuidV5FromOrderLive(brandId, orderId, updatedAtUtcMs)` = sha256(`brand:order:updatedAtMs:order.live.v1`)→UUIDv5-shaped. Webhooks AND re-pull use it. Backfill keeps its own `order.backfill.v1` namespace → no collision. Per-state Bronze rows; insert-if-absent dedup.
- **ADR-LV-7 (D-7, CRITICAL — resolved §4):** Re-pull enumerates via SECURITY DEFINER `list_connectors_for_repull()` (additive `0026`); GUC set after; non-inert no-GUC negative control mandatory.
- **ADR-LV-8 (D-9):** Overlap-lock via `SELECT ... FOR UPDATE SKIP LOCKED` on the `connector_cursor` row for `resource='orders.repull'` at job start (no new table — option (a)). A second concurrent trigger finds the row locked → skips. Lock held for the job's txn-scoped claim; loop work commits cursor per page.
- **ADR-LV-9 (D-10):** Re-pull cursor uses `resource='orders.repull'` (distinct from backfill's `'orders'`), high-water = max `updated_at` seen; `updated_at_min = now-35d`. No cursor collision.
- **ADR-LV-10 (D-11):** Re-pull sets `connector_sync_status.state='syncing'` at start, `'connected' + last_sync_at=NOW()` on completion (mirror `run.ts:485-503`). Webhook receiver touches `last_sync_at=NOW(), state='connected'` on each accepted event (idempotent UPSERT-by-update under the brand GUC).
- **ADR-LV-11 (D-13, CRITICAL — resolved §5):** The live recognition path adds a **reversal writer**: a Bronze order state with `cancelled_at != null` (or fulfillment signalling RTO) produces a NEW negative `rto_reversal` (or `cancellation`) ledger row (append-only); the sale/provisional/finalized rows are untouched; `realized_gmv_as_of` falls. This is NEW code (nothing writes reversals today).
- **ADR-LV-12 (live-lane = generic substrate — D-14):** Webhooks + re-pull both land on `dev.collector.event.v1`. One affirming sentence: *this is the shared streaming substrate every future connector plugs into; Shopify is the first source wired.* A dedicated `dev.collector.order.repull.v1` topic is a documented future scale option (burst-starvation guard) — NOT M1.
- **ADR-LV-13 (D-8 dev-honesty):** Webhook receive path is proven by synthetic HMAC-signed `inject()` tests (the dev substitute — Shopify can't reach localhost); the re-pull (dev_secret against live Boddactive) is the dev freshness proof. Real webhook delivery = public-ingress follow-up, stated honestly in the dev guide.

---

## 2. D-4 RESOLVED — webhook brand resolution (the spoofable-header gap)

**Order of operations (immovable):**
1. **HMAC-first (NN-4):** read `req.rawBody: Buffer`; `ShopifyHmac.validateWebhook(rawBody, header, clientSecret)`. Fail/missing → **401, no processing, no write.** (algorithm already correct, `ShopifyHmac.ts:70`.)
2. **Brand resolution via SECURITY DEFINER lookup, NOT the header-as-authority.** The cross-tenant problem: at webhook time the brand is unknown and `connector_instance` is FORCE-RLS with a two-arg fail-closed policy — a bare `brain_app` SELECT by `shop_domain` with no GUC returns **0 rows** (`current_setting('app.current_brand_id',TRUE)`→NULL→FALSE). So we add **SECURITY DEFINER `resolve_connector_by_shop_domain(p_shop_domain text)`** (additive `0026`): owner = superuser `brain`, `SET search_path=public`, `STABLE`, `GRANT EXECUTE TO brain_app`, returning **dispatch-only** columns `(connector_instance_id uuid, brand_id uuid, shop_domain text, secret_ref text)` filtered `WHERE shop_domain=p_shop_domain AND provider='shopify'`. Because of the `UNIQUE (brand_id, provider)` + a single `shop_domain` per connect, this returns at most ONE row.
3. **`brand_id` = the fn's row** (authority — never the `X-Shopify-Shop-Domain` header, never the body). The header is used **only as the lookup key** after HMAC proves the request came from the holder of the app's `client_secret`. No matching connector → **401, no write.**
4. **GUC-after-resolve:** `set_config('app.current_brand_id', brand_id, true)` (txn-local) BEFORE any brand-scoped write (`connector_sync_status` touch). The Bronze write happens downstream in stream-worker under ITS own GUC from the envelope `brand_id` (asserted, not from Shopify).

**Why it can't leak another brand's connector:** the fn returns ONLY the row whose `shop_domain` matches the HMAC-validated request's shop; no `shop_domain` → empty → 401. The fn exposes no tenant data content beyond dispatch identifiers + `secret_ref` (an ARN, not a secret). **Forged-header test (Success §7):** an attacker who sets `X-Shopify-Shop-Domain` to Brand A's shop but signs with a body/secret that doesn't resolve → either HMAC fails (401) or the lookup resolves to the shop that actually owns the validated request; it can NEVER write to a brand the request isn't for. At M1 (one connector — Boddactive) this is a constant-time single-row check; the architecture is correct for multi-brand.

**This is the 2nd SECURITY DEFINER fn** (alongside the re-pull enumerator) — both in additive migration `0026`.

---

## 3. D-6 RESOLVED — dedup-vs-update (THE make-or-break) with worked example

**Decision: Option (c) — per-state composite live event_id. CONFIRMED.**

- **LIVE event_id** (webhooks + re-pull) = `uuidV5FromOrderLive(brandId, orderId, updatedAtUtcMs)` where `updatedAtUtcMs = new Date(order.updated_at).getTime()`. Input string: `` `${brandId}:${orderId}:${updatedAtUtcMs}:order.live.v1` `` → sha256 → UUIDv5-shaped (same version-nibble/variant trick as `uuid-utils.ts:43-45`, so it passes `CollectorEventV1Schema.event_id.uuid()`).
- **BACKFILL event_id** is unchanged: sha256(`brand:order:order.backfill.v1`) — namespace suffix differs → **provably cannot collide** with the live id space (different input string → different hash).
- **Bronze semantics UNCHANGED (I-ST04):** insert-if-absent on `event_id` (Redis NX + PG PK `ON CONFLICT DO NOTHING`). We do **NOT** touch the locked Bronze upsert contract from `feat-data-plane-ingest-spine` (Option (b) rejected for exactly this reason).
- **Each distinct `updated_at` → a distinct event_id → a distinct Bronze row.** A retry of the SAME state (same `updated_at`) → same id → deduped. A new state (new `updated_at`) → new row → lands.

**Live event_name:** `order.live.v1` (new contract in `@brain/shopify-mapper`/`@brain/contracts`), same `OrderProperties` shape as backfill (adds nothing PII). The live lane's `CollectorEventConsumer`→`ProcessEventUseCase` writes it to Bronze unchanged (flat envelope, all order fields in `properties`) — "same code path, different event_name, same lane."

### Worked example — ONE COD order across all four sources

Brand `B`, Shopify order `O` (`current_total_price=1250.00 INR`, COD).

| t | Source | Shopify state (`updated_at`) | event_id input | Bronze | Ledger effect |
|---|---|---|---|---|---|
| T0 | **Backfill** | snapshot: pending, unfulfilled (`upd=U0`) | `B:O:order.backfill.v1` | **Row #1** (backfill) | `provisional_recognition` +125000 (LedgerWriter) |
| T1 | **Webhook** `orders/updated` | fulfilled (`upd=U1`) | `B:O:U1:order.live.v1` | **Row #2** (live) | no new ledger row (still provisional; finalization horizon not passed) |
| T2 | **Re-pull** (same state retry) | fulfilled (`upd=U1`) | `B:O:U1:order.live.v1` | **dedup → no row** (same id) | none |
| T3 | **Re-pull** (new state) | delivered (`upd=U2`) | `B:O:U2:order.live.v1` | **Row #3** (live) | finalization job later writes `finalization` +125000 (`recognition_label='finalized'`) once horizon passes / delivery signal |
| T4 | **Webhook** `orders/cancelled` (RTO) | cancelled (`upd=U3`, `cancelled_at` set) | `B:O:U3:order.live.v1` | **Row #4** (live) | **NEW `rto_reversal` −125000 row** (ADR-LV-11). Sale/provisional/finalized rows UNTOUCHED. `realized_gmv_as_of` falls by 125000. |

**Key consequences (documented per C-1/C-2):**
- A backfilled order + its first live update are **two Bronze rows** — ACCEPTABLE: the ledger nets them. The backfill provisional and the live finalization/reversal key off the SAME `order_id`; the ledger's `(brand,order,event_type,occurred_at::date)` dedup + signed-sum is what reconciles them (not Bronze).
- There is **no "disagreement"** to resolve between webhook and re-pull for the same state — identical `updated_at` → identical id → dedup. Different `updated_at` → distinct legitimate states, both land. "Server/connector value wins" reduces to "the latest STATE is its own row; the ledger sums signed rows" — effectively-once per state.
- **Ledger idempotency across multiple Bronze rows of the same order:** the LedgerWriter/reversal-writer dedup is `(brand,order,event_type,occurred_at::date)` — so two Bronze rows landing the SAME ledger event_type on the same UTC day collapse to one ledger row; a genuine reversal on a later day is a new row. This is the existing locked dedup (`0018:103-104`).

**Reversal trigger semantics (feeds §5):** a live Bronze order with `cancelled_at != null` → `cancellation`/`rto_reversal` event_type; the reversal `amount_minor` is the negative of the recognized amount for that `order_id`. The reversal `occurred_at` = the order's `updated_at`/`cancelled_at` (the day the reversal economically happened) so it lands as a distinct ledger row, not a same-day dedup of the sale.

---

## 4. D-7 RESOLVED — re-pull enumeration (cross-tenant system job)

Per durable rule `system-job-force-rls-enumeration` (binding). The 35-day re-pull discovers WHICH connectors to re-pull before any brand is known → bare `brain_app` SELECT on `connector_instance` returns 0 rows (inert in prod, masked by dev superuser).

- **SECURITY DEFINER `list_connectors_for_repull()`** (additive `0026`), mirroring `0023` exactly: owner = superuser `brain`, `LANGUAGE sql`, `SECURITY DEFINER`, `STABLE`, `SET search_path=public`, `GRANT EXECUTE TO brain_app`, **dispatch-only columns** `(connector_instance_id uuid, brand_id uuid, shop_domain text, secret_ref text)` for `provider='shopify' AND status='connected'`. Migration-time assertions: `prosecdef=true`, `search_path=public` present, `brain_app` has EXECUTE (copy the three `DO $$` guard blocks from `0023:79-146`).
- **GUC-after-enumerate:** `set_config('app.current_brand_id', brand_id, true)` BEFORE any brand-scoped read/write (`connector_cursor`, `connector_sync_status`). `brand_id` authority = the fn result (MT-1) — never env, never Shopify.
- **Non-inert no-GUC negative control (mandatory):** under `brain_app` (NOT dev superuser), a direct `SELECT FROM connector_instance` with no GUC returns **0 rows** — proves the fix isn't tautological (the rule's bounce criterion).

---

## 5. D-13 RESOLVED — recognition for status changes (the reversal writer)

**Finding (cited):** the ledger schema already permits `rto_reversal`/`cancellation` and `realized_gmv_as_of` subtracts them (`0018:66-78`, `:165-186`), and `revenue-finalization.ts:134-146` already SKIPS finalization when a reversal exists — **but no code path WRITES a reversal row today.** D-13 is therefore NEW code, not a confirmation-only.

**The bound path (Track A, on the live lane):**
1. **New order / provisional:** live Bronze order → `LedgerWriter.writeProvisionalRecognition` (reuse unchanged) → `provisional_recognition` +amount.
2. **Delivered / horizon-passed:** the EXISTING `revenue-finalization.ts` cron writes `finalization` (+amount, `recognition_label='finalized'`) — unchanged. No new finalization math.
3. **RTO / cancelled (the new wire):** a live Bronze order with `cancelled_at != null` (or an RTO fulfillment signal) → **`LedgerWriter.writeReversal()`** (NEW method, same class) writes a NEW `rto_reversal` (or `cancellation`) row: `amount_minor = -recognizedAmount`, `recognition_label='finalized'` (the label CHECK has no 'reversal' value — `0018:88`; the negative `amount_minor` + `event_type='rto_reversal'` IS the reversal, consistent with `realized_gmv_as_of`'s `-` contribution), `occurred_at = order.cancelled_at/updated_at`, `supersedes_ledger_event_id = NULL`, dedup `(brand,order,'rto_reversal',occurred_at::date) DO NOTHING`. **Append-only — the sale/provisional/finalized rows are NEVER edited** (GRANT enforces this; `0018:119-123`).
4. **Wiring point:** the live-lane order consumer (the `order.live.v1` handler — Track A wires it into the live path the same way `BackfillOrderConsumer` wires the backfill lane to `LedgerWriter`). Reuse `extractLedgerOrder` (`BackfillOrderConsumer.ts:177`) generalized to `order.live.v1`; branch on `cancelled_at` → reversal vs provisional.

**Result:** delivered→RTO produces `finalization(+125000)` then `rto_reversal(−125000)` → net realized 0; the sale row stays; the dashboard `realized_gmv_as_of` falls. This is the clawback-by-reversal model the ledger was built for (`0018:32`).

---

## 6. Migrations (additive — `0026`)

**`0026_live_connector_security_definer_fns.sql`** (one migration, two fns; additive, `0006`/`0018` untouched; ROLLBACK = `DROP FUNCTION`):
1. `resolve_connector_by_shop_domain(p_shop_domain text)` — SECURITY DEFINER, dispatch-only `(connector_instance_id, brand_id, shop_domain, secret_ref)`, `provider='shopify'` (D-4).
2. `list_connectors_for_repull()` — SECURITY DEFINER, dispatch-only `(connector_instance_id, brand_id, shop_domain, secret_ref)`, `provider='shopify' AND status='connected'` (D-7).
Both: owner superuser `brain`, `SET search_path=public`, `STABLE`, `GRANT EXECUTE TO brain_app`, + the three `DO $$` migration-time assertion blocks copied from `0023` (prosecdef / search_path / EXECUTE).

**No table changes** — `connector_cursor`/`connector_sync_status`/`realized_revenue_ledger` already have every column needed (`resource='orders.repull'` is just a new value; `rto_reversal` is already an allowed event_type).

---

## 7. Track split + frozen interfaces + commit-per-slice

**Dependency order:** **A0 (mapper package) is the FIRST commit / frozen seam → unblocks B and C.** D-6 (live event_id) ships inside A0. Then A∥B∥C.

### FROZEN interfaces (A produces in A0, before anything else)

**`@brain/shopify-mapper` (packages/shopify-mapper) — the frozen API:**
```
export { mapOrderToEvent }       // (order, saltHex, regionCode, eventName) → { event_name, occurred_at, properties }
export { decimalStringToMinor }  // moved from money-utils.ts (unchanged)
export { uuidV5FromOrderBackfill }// moved (unchanged — backfill keeps using it)
export { uuidV5FromOrderLive }   // NEW: (brandId, orderId, updatedAtUtcMs:number) → UUID string
export { ORDER_LIVE_V1_EVENT_NAME, ORDER_LIVE_V1_TOPIC note } // live contract (event lands on collector.event.v1)
export type { MappedOrderEvent, ShopifyOrderShape }
```
**The live event contract (frozen):** envelope = `CollectorEventV1Schema` (flat), `event_name='order.live.v1'`, `event_id=uuidV5FromOrderLive(...)`, `brand_id` asserted from connector, `occurred_at = updated_at` (the state's economic time), `properties = OrderProperties` (same shape as `order.backfill.v1` incl. `cancelled_at`, `fulfillment_status`, `financial_status`, hashed PII). Backfill migrates its imports to this package (move, not fork) in A0.

### A — @data-engineer (LEAD)
- **A0 (FREEZE, commit first):** create `packages/shopify-mapper`; move `order-mapper.ts`/`money-utils.ts`/`uuid-utils.ts` into it; add `uuidV5FromOrderLive` + `order.live.v1` contract; rewire backfill `run.ts` imports to the package (no behavior change — backfill tests stay green). **Acceptance: builds under `tsc -b`; backfill suite green; both core + stream-worker can import.**
- **A1:** migration `0026` (both SECURITY DEFINER fns + assertion blocks).
- **A2:** the 35-day re-pull job (`apps/stream-worker/src/jobs/shopify-repull/run.ts`, mirror `shopify-backfill/run.ts`): enumerate via `list_connectors_for_repull()`; GUC-after; `FOR UPDATE SKIP LOCKED` overlap-lock on `connector_cursor` (`resource='orders.repull'`); paged client with `updated_at_min=now-35d` + high-water cursor; map via `@brain/shopify-mapper` w/ `uuidV5FromOrderLive`; **direct produce to `dev.collector.event.v1`**; `sync_status` syncing→connected.
- **A3:** the live-lane order recognition wire + **`LedgerWriter.writeReversal()`** (D-13) — `order.live.v1` Bronze → provisional (new) / reversal (cancelled). Generalize `extractLedgerOrder`.
- **A4 (live tests, under `brain_app`):** re-pull lands live lane + cursor advances/resumes; dedup-with-backfill (same order → backfill row + live rows, NOT collapsed wrongly); per-state (two `updated_at` → two Bronze rows); RTO→negative `rto_reversal` row, sale untouched, `realized_gmv_as_of` falls; isolation negative-control (Brand A webhook/re-pull can't touch Brand B); **no-GUC enumeration negative-control (count===0 under brain_app)**; overlap-lock (two triggers → one runs, one skips, non-inert SKIP LOCKED).

### B — @backend-developer (post-A0)
- **B1:** webhook receiver (`shopifyWebhookHandler.ts` rewrite): wire `@fastify/raw-body` (D-2); HMAC-first (D-4 step 1); brand-resolution via `resolve_connector_by_shop_domain` (D-4 steps 2-3); map via `@brain/shopify-mapper` `mapOrderToEvent` + `uuidV5FromOrderLive`; core KafkaJS producer → **direct produce `dev.collector.event.v1`** (D-3); 200 fast-ack; `sync_status` `last_sync_at` touch under brand GUC (D-11/E-4); no connector → 401.
- **B2:** webhook registration on connect/enable-live-sync (orders/create, orders/updated, orders/paid, orders/fulfilled, orders/cancelled) → **env-gated dev no-op stub** (D-5) + the prod registration code path.
- **B3 (tests, `inject()` synthetic HMAC):** HMAC-valid order webhook → ONE Bronze row on the LIVE lane, brand-scoped; HMAC-invalid → 401, zero Bronze; **forged shop-header → resolves to the RIGHT brand or 401, never another brand's connector** (D-4 proof); dedup-with-backfill; no raw PII in Bronze/logs (`hashed_customer_email` is a hash, `customer.email` absent).

### C — @frontend-web-developer (post-A0; backend read already exists)
- **C1:** live-sync indicator on the connector tile (`components/connectors/connectors-list.tsx`): show `syncState` (live/syncing) + a relative-time freshness from `lastSyncAt` (e.g. "Live · updated 12s ago") using the EXISTING BFF `/connectors/status` (`bff.routes.ts:651`) — no new backend.
- **C2:** dashboard Connection Status reflects live/syncing + freshness truthfully; a "live" badge when `state='connected'` and `last_sync_at` is recent.
- **C3:** e2e (Playwright, `apps/web/e2e`): connected tile shows live + freshness; a stale `last_sync_at` shows the honest non-live state.

**Commit-per-slice (the lifecycle lesson):** each slice is its own commit; A0 commits and unblocks before A1. TEST THE LIFECYCLE, not one happy path: webhook + re-pull + dedup-with-backfill + status-change-reversal.

**Deploy-pipeline note:** no new service/deployable (hard rule) — webhook receiver lives in the existing `core` deployable, re-pull job in the existing `stream-worker` deployable (invoked like the backfill job). The existing per-service pipelines (affected-only build + image + canary + auto-rollback) already cover `core` and `stream-worker`; this slice changes no service topology, so no new deploy app is created. Builders MUST ensure the affected-service pipelines (core, stream-worker, web) run on their slices.

---

## 8. Test plan → success criteria mapping (lifecycle, not happy-path)

| Success criterion (§7) | Test | Track |
|---|---|---|
| HMAC-valid webhook → ONE Bronze live-lane row, brand-scoped | B3 inject() synthetic HMAC | B |
| HMAC-invalid → 401, zero Bronze | B3 | B |
| webhook + backfill same state → ONE Bronze row (dedup) | A4/B3 dedup-with-backfill | A/B |
| same order, TWO `updated_at` → TWO Bronze rows | A4 per-state | A |
| 35-day re-pull fetches `updated_at_min=now-35d`, emits live lane, advances cursor | A4 | A |
| late RTO → NEW reversal ledger row, sale untouched, `realized_gmv_as_of` falls | A4 (D-13) | A |
| sync_status syncing during re-pull, connected+last_sync_at on completion | A4 + B1 touch | A/B |
| cross-brand isolation = 0 under `SET ROLE brain_app` | A4 + B3 isolation negative-control | A/B |
| overlap-lock: two triggers → one completes, one skipped (non-inert SKIP LOCKED) | A4 | A |
| brand_id never from body/header — forged-header → right brand or 401 | B3 forged-header | B |
| no raw PII in Bronze/logs | B3 + A4 PII assertions | A/B |
| **no-GUC enumeration negative-control (count===0 under brain_app)** | A4 (durable-rule mandatory) | A |

**Real-network smoke (dev-honesty D-8):** the re-pull runs against the live Boddactive store via `dev_secret` (DEV-TOKEN-REACH) — the dev freshness proof. Webhook receive is proven by synthetic HMAC `inject()` only (Shopify can't reach localhost — stated honestly). All isolation assertions run under `BRAIN_APP_DATABASE_URL` (brain_app pool) with `assertBrainApp()` (dev superuser masks RLS — MEMORY; reuse `chore-connector-lifecycle-regression` dual-pool harness).

---

## 9. Risk / reversibility + alternatives considered

**Alternatives rejected:**
- **Option (b) Bronze upsert-latest** (D-6) — rejected: changes the locked insert-if-absent Bronze contract (I-ST04 from `feat-data-plane-ingest-spine`) for one event type; ripples into every consumer's replay assumptions. Per-state composite key (Option c) keeps Bronze semantics frozen.
- **Header-as-brand-authority** (D-4) — rejected: attacker-controlled; the SECURITY DEFINER shop→connector lookup is the only safe authority.
- **Webhook via collector `/collect`** (D-3) — deferred: adds a core→collector network dependency for marginal spool durability at M1; direct produce matches the proven backfill path. Documented as the durability hardening follow-up.
- **Dedicated re-pull topic** (D-14) — deferred: single-brand M1 volume (hundreds of orders) won't starve the live consumer; documented future scale option.
- **New ledger event_type table for reversals** — rejected: the one-ledger/event_type-discriminator model (`0018`) already has `rto_reversal`; a negative signed row is the design.

**Reversibility:** migration `0026` is two `CREATE FUNCTION` — `DROP FUNCTION` rolls back cleanly (no schema/data change). The mapper-package extraction is a code move (revertible). The live lane is additive (new `event_name` on an existing topic). No new deployable, no new table, ledger is append-only (no destructive writes). Bronze/ledger remain rebuildable from source.

**Cost:** Tier-0 deterministic — **$0/mo model spend**, 0 tokens/day (no LLM/ML/agent calls; pure Kafka produce/consume + Postgres inserts + Shopify Admin HTTP). Cost-routing audit trivially clean.

---

## 10. OUT OF THIS SLICE (hard lines — §8)

- Settlement / net-of-fees / Razorpay (realized stays GMV gross-of-fees, labeled).
- Meta / Google Ads / other connectors (Shopify orders only).
- Full Argo cron orchestration (re-pull is manual/triggered in dev, like the backfill; prod cron = platform follow-up).
- **Public webhook ingress / tunnel** (Shopify can't reach localhost; dev uses synthetic POSTs + the re-pull; real delivery = platform follow-up).
- Webhook via collector `/collect` spool (direct produce now; collector edge = durability follow-up).
- Dedicated re-pull topic (live lane now; dedicated topic = scale follow-up).
- Timestamp-window replay rejection (Bronze event_id dedup is the M1 replay defense; A-3 accepted as M1 tech debt).
- Connector-health detector / DQ A+→D gating (`connector_sync_status` is the M1 freshness signal).
- Product / customer / inventory webhooks (orders only).
- Per-order replay/audit UI; new deployable (forbidden).

---

## In-lane DoD
- [x] All sections filled; paradigm declared+justified (Tier-0, $0/mo); Single-Primitive sweep CLEAN (extend-only).
- [x] Tenant isolation at every layer (webhook GUC, re-pull SECURITY DEFINER + GUC, Bronze envelope brand_id, ledger RLS) + observability (sync_status) + real-network smoke (re-pull vs live store) in the test strategy.
- [x] ≥1 alternative + rejection (Option b, header-authority, collector edge, dedicated topic, reversal table); reversible migration (`0026` DROP FUNCTION); cost estimate (0 tokens/day, $0/mo).
- [x] Every persona must-fix folded into acceptance contracts (A-1/D-4, C-1/D-6, E-1/D-7, D-1/D-13, B-1/D-8, E-2/D-9, E-4 GUC, D-3 PII).
- [x] Every track has slices w/ file:line anchors; deploy-pipeline note (no new service — existing core/stream-worker/web pipelines).
- [x] D-4, D-6, D-7 fully resolved BEFORE build; D-12 (mapper package) is the first commit / frozen seam.
</content>
</invoke>
