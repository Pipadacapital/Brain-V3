# CTO Advisor Review — feat-shopify-live-connector
**Stage:** 1 — Intake  
**Req ID:** feat-shopify-live-connector  
**Reviewed at:** 2026-06-17T20:00:00Z  
**Reviewer:** Engineering Advisor (cto-advisor, Sonnet tier)  
**Decision:** ADVANCE (with numbered bindings D-1..D-14 — Architect must resolve before implementation begins)

---

## 1. Lane Confirmation

**Lane: HIGH_STAKES — CONFIRMED.**

Deterministic scan triggered: `connectors`, `multi_tenancy`, `money`, `pii`, `schema_proto`, `outbound_channel`, `oauth/secrets`. I add one surface the scan did not explicitly flag: `system_of_record_audit` — the ledger's append-only recognition path is THE MOAT for realized revenue; any order status change flowing through it is a system-of-record mutation. Total confirmed surfaces: **connectors, multi_tenancy, money, pii, schema_proto, outbound_channel, oauth/secrets, system_of_record_audit**.

Rationale: live webhook ingest of order data (PII boundary), real money in the ledger (COD/RTO reversals), cross-tenant isolation of the re-pull job, secrets management for both the HMAC client_secret and the Shopify access token, and the connector_cursor write path all individually qualify for high_stakes. Together they make this the densest surface area of any requirement since feat-connector-backfill.

---

## 2. Dependency Pre-Flight

All stated blockers are `shipped` (stage 8):
- `feat-connector-backfill` (order→event mapper, deterministic event_id, paged Admin client, backfill job pattern) — SHIPPED
- `feat-connector-marketplace` (connect + secret_ref + webhook handler scaffold, ShopifyHmac) — SHIPPED
- `feat-data-plane-ingest-spine` (collector→Redpanda→stream-worker→Bronze LIVE lane) — SHIPPED
- `feat-realized-revenue-ledger` (append-only recognition) — SHIPPED
- `feat-analytics-api-dashboard` (dashboard number) — SHIPPED
- `chore-connector-lifecycle-regression` (regression patterns/fixtures) — SHIPPED
- `fix-connector-lifecycle-cleanup` (WorkerLocalSecretsManager prod guard) — SHIPPED

No blocked dependency. Proceed.

---

## 3. "Make It Less Dumb First"

Three scope reductions are already in the requirement's non-goals. I validate them and add no new deletions — the scope is tight:

- **Full Argo cron: correct deferral.** The re-pull as a manually-triggered or scheduled stream-worker job (mirroring the backfill worker pattern) is sufficient for M1. Argo adds infra complexity with no M1 payoff.
- **Public ingress for dev: correct deferral (and required honesty).** Shopify cannot reach localhost. The synthetic HMAC-signed POST test is the substitute. This MUST be stated honestly in the developer guide.
- **Connector-health detector / DQ gating: correct deferral.** connector_sync_status is the freshness signal for M1.
- **Settlement/Razorpay: hard out.** The realized-revenue ledger stays gross-of-fees. No deviation.

One simplification the Architect should evaluate: whether webhook REGISTRATION should be deferred entirely to the production-infra slice (when the public-ingress URL exists). For M1 dev, registration is a no-op — the callback URL is non-public. The Architect should bind whether registration runs on connect (with a no-op stub in dev) or is a follow-up when the infra URL is available. This is a design bind, not a scope cut.

---

## 4. Domain Check vs. Product Canon

- **Multi-tenancy invariant (THE ONE INVARIANT):** brand_id must be asserted from the connector mapping, never from the webhook body or the X-Shopify-Shop-Domain header (which is attacker-controlled). The existing scaffold (`shopifyWebhookHandler.ts`) currently does NOT do this — Step 2 reads `shopDomain` from the header and emits it into the event. This is a CRITICAL gap the Architect must close in D-4.
- **Money / COD path:** append-only ledger for RTO reversals is correctly scoped. COD 35-day window is correctly motivated — an RTO can arrive weeks after order placement. Recognition of a late reversal as a NEW negative signed row (not an edit) is correctly stated.
- **Minor-units / no-float:** the backfill's `decimalStringToMinor` (integer arithmetic) must be reused in the webhook mapper. No parseFloat.
- **PII at the boundary:** the backfill's `order-mapper.ts` hashes PII before emitting. The webhook mapper must do the same. No raw email/phone in events/Bronze/logs.
- **Audit log / THE MOAT:** ledger rows are immutable by GRANT (not convention) — confirmed from the feat-realized-revenue-ledger final review. Status changes must create NEW rows, never edits.
- **Isolation / RLS:** both the webhook receiver (request-scoped, brand from connector mapping) and the re-pull (cross-tenant enumerator — must use the adopted system-job-force-rls-enumeration rule). See D-7.

---

## 5. Persona Concerns — Stress-Test Results

### Persona A: Security / Webhook Skeptic

**Concern A-1 (CRITICAL): The webhook HMAC is validated but the brand resolution is broken.**
`shopifyWebhookHandler.ts` Step 2 reads `shopDomain` from the `x-shopify-shop-domain` header — this header is attacker-controlled. An attacker who can construct a valid HMAC (which requires the client_secret) could forge the shop domain header to point to Brand A's shop while actually being Brand B's connector. But the more realistic attack: the current scaffold emits `shop_domain` from the unverified header into the downstream event payload. Whatever downstream logic resolves `shop_domain → brand_id` is operating on attacker data unless it validates the mapping server-side under RLS.

**Bind required (D-4):** After HMAC validation, the shop domain must be resolved to a `connector_instance` row via a DB lookup (`SELECT brand_id FROM connector_instance WHERE shop_domain = $1 AND provider = 'shopify'`) under `brain_app` with the brand GUC set. The `brand_id` comes from this row — never from the header. If no connector_instance matches the shop_domain, return 401 (no write). This is the same pattern as the backfill's `loadConnectorInstance` (run.ts:255).

**Concern A-2 (HIGH): The HMAC secret is a single shared client_secret — not a per-connector webhook secret.**
`ISecretsManager.getShopifyClientSecret()` returns one app-level secret. Shopify webhook signatures use the same client_secret as OAuth. This is correct for Shopify's model — the client_secret IS the webhook HMAC secret. There is no per-connector webhook secret rotation path. The existing `ShopifyHmac.validateWebhook()` correctly uses HMAC-SHA256 over the raw body bytes with the client_secret and timing-safe comparison. This is confirmed correct. No action needed on the algorithm; the algorithm IS correct and covers the webhook case (not just OAuth).

**Concern A-3 (MEDIUM): Replay attack surface.**
Shopify does not embed a nonce in the webhook body. The only replay defense is the Bronze `ON CONFLICT DO NOTHING` on event_id — which only helps if the event_id is deterministic (it is, per D-5/D-6). A retried webhook for the same order state will produce the same event_id and be deduped at Bronze. This is acceptable for M1. Timestamp-window replay rejection is a Phase-2 hardening.

**Disposition:** A-1 is a CRITICAL architecture bind for D-4. A-2 is resolved (confirmed correct). A-3 is accepted as M1 tech debt.

---

### Persona B: Dev-Reality Skeptic

**Concern B-1 (HIGH): Shopify cannot deliver webhooks to localhost — the requirement must be honest about this.**
In dev, the webhook receiver endpoint at `POST /api/v1/webhooks/shopify/:topic` will never receive a real Shopify webhook. The only testable path in dev is synthetic HMAC-signed POST requests (constructed with the known client_secret). Webhook REGISTRATION (`PUT /admin/api/2025-07/webhooks.json`) requires a public callback URL. In dev this URL is non-public — registration will either fail or register a URL Shopify can never reach.

**Bind required (D-8):** Webhook registration in dev must be explicitly stubbed (no-op / skip) or the registration URL is documented as a no-op-until-public-ingress. The developer guide must be honest: "In dev, real Shopify webhooks are not delivered. Use the synthetic-webhook test harness (HMAC-signed POST) to validate the receive path. The 35-day re-pull (which CAN run against the live Boddactive store in dev via the same DEV-TOKEN-REACH path as the backfill) is what keeps dev data fresh." This is the exact same honesty contract the backfill requirement established for real OAuth.

**Concern B-2 (MEDIUM): The 35-day re-pull's dev freshness story is actually stronger than the webhook path in dev.**
The re-pull reuses `ShopifyBackfillClient` + `worker-secrets.ts` + `dev_secret` (0024) — a path that was proven live against the real Boddactive store in `fix-dev-token-reach`. The re-pull CAN run in dev against the live store. This should be stated clearly: in dev, the re-pull is the primary freshness mechanism, not a fallback.

**Disposition:** B-1 requires the dev-honesty binding D-8 (no silent omission). B-2 is a documentation note — no code impact.

---

### Persona C: Dedup / Correctness Skeptic (THE CRITICAL TRAP)

**Concern C-1 (CRITICAL): sha256(brand_id:order_id) → ONE event_id per order BREAKS live sync for status changes.**

This is the make-or-break semantic question for this entire feature.

The backfill uses `uuidV5FromOrderBackfill(brandId, shopifyOrderId)` with input `${brandId}:${shopifyOrderId}:order.backfill.v1`. This produces ONE deterministic ID per (brand, order). Bronze inserts with `ON CONFLICT DO NOTHING` on event_id. This is correct for the backfill's purpose: re-running the backfill for the same order is idempotent.

But for live sync, consider the lifecycle of a COD order:
1. Order placed (financial_status=pending, fulfillment_status=null) → Bronze row A
2. 3 days later: Order shipped (fulfillment_status=fulfilled) → webhook arrives → same event_id → ON CONFLICT DO NOTHING → **row A is NOT updated** → the dashboard still shows the order as unshipped
3. 15 days later: Order delivered → another webhook → same event_id → deduped again → **never lands**
4. 30 days later: RTO → yet another webhook → same event_id → **deduped** → **the RTO reversal never creates a ledger row**

This means the entire live sync purpose — keeping data fresh as order STATUS CHANGES — is broken if the dedup key is purely `sha256(brand:order_id)`.

**The three options the Architect must choose between:**

**Option (a): Per-state event_id — include a state discriminant.**
event_id = sha256(brand_id:order_id:financial_status:fulfillment_status:updated_at) or similar. Each distinct order state produces a different Bronze row. Dedup-with-backfill works IF the backfill uses the same state-keyed ID (but the current backfill snapshots the current state, so a backfill at time T and a webhook for the same state at time T would dedup correctly). Risk: if two webhooks arrive for the same order with identical status (retry), they dedup. The ledger's recognition logic must sum across multiple Bronze rows for the same order to compute the net.

**Option (b): Bronze upsert-latest-by-order_id instead of insert-if-absent.**
Keep event_id deterministic as sha256(brand:order_id) for dedup-with-backfill, but change the Bronze write to `ON CONFLICT (event_id) DO UPDATE SET properties = EXCLUDED.properties WHERE EXCLUDED.occurred_at > bronze_events.occurred_at`. This means the LATEST state wins. The ledger recognition re-fires on the updated row. Risk: this changes the Bronze insert semantics that have been locked since feat-data-plane-ingest-spine (which declared insert-if-absent as I-ST04). Changing the conflict behavior for this one event type requires a careful architecture decision.

**Option (c): The ledger (not Bronze) handles the recognition delta — Bronze accumulates all states as separate rows using a composite key.**
Use a composite event_id that includes updated_at, so every order state change creates a new Bronze row. The ledger's recognition logic (the two-pass recognition in the realized-revenue-ledger) already handles clawback-by-reversal via the dual-date / append-only model. A delivered→RTO transition would produce: (1) a finalized ledger row from the delivered state, (2) a reversal row from the RTO state. This is how the backfill's LedgerWriter already handles provisional→finalized recognition. The key insight: the LEDGER is already built for this; the Bronze row just needs to deliver the current state accurately.

**My recommendation (for the Architect to confirm or reject with justification):** Option (c) — per-state composite key — aligns most naturally with the existing recognition model and avoids changing the Bronze upsert contract. The event_id for a LIVE event should be `sha256(brand_id:order_id:updated_at_utc_ms)` where `updated_at` is the Shopify order's `updated_at` field. This means each order state change at a new `updated_at` is a distinct Bronze row, the recognition engine processes each row independently, and late RTOs and reversals are new rows that generate new ledger entries. Dedup with the backfill: the backfill's event_id uses the suffix `:order.backfill.v1` which prevents collision with the live event_id space. Near-duplicate states (same updated_at retried twice) are deduped correctly. The Architect must confirm this binding.

**CRITICAL: This is the Architect's highest-priority binding decision. Getting this wrong silently breaks the entire live sync purpose.**

**Concern C-2 (HIGH): "Server/connector value wins on disagreement" — clarify what this means under per-state semantics.**
Under option (c), there is no "disagreement" between a webhook and a re-pull for the same order state at the same updated_at — they produce the same event_id and dedup correctly. But a webhook at T=0 vs a re-pull at T=1 (which has a later updated_at reflecting a new status) are distinct events and both land. This is correct behavior. The Architect must document this explicitly.

**Disposition:** C-1 is CRITICAL — must be resolved in D-6 before the Architect writes a single line of implementation. C-2 follows from C-1's resolution.

---

### Persona D: Money / COD Skeptic

**Concern D-1 (HIGH): RTO reversal as a new negative ledger row — confirm the recognition path handles it.**
From reading `feat-realized-revenue-ledger` (shipped): the ledger is append-only by GRANT (SELECT+INSERT only for brain_app — no UPDATE/DELETE). The `realized_gmv_as_of` function uses the dual-date model and the `clawback-by-reversal` approach where a new negative row with `recognition_label='reversal'` brings the realized number down. This is confirmed correct.

What needs confirmation: when a webhook delivers an order with `cancelled_at != null` or a fulfillment_status change that signals RTO (in the Indian COD context, this may come from tags or a custom fulfillment status), the recognition pipeline must treat it as a reversal row, not an update to the original sale row. The `order-mapper.ts` already maps `cancelled_at` and `fulfillment_status`. The LedgerWriter's two-pass recognition logic must generate the reversal. The Architect must confirm the LedgerWriter path handles the delivered→RTO case as a reversal, not a no-op.

**Concern D-2 (MEDIUM): The 35-day window is the correct catch-up horizon for Indian COD.**
Confirmed. Shopify's `updated_at_min` filter returns orders updated in the trailing window. The cursor advances to the latest `updated_at` seen, so the window slides forward with each re-pull. The cursor is never "final" inside the 35-day window — this is correct and documented.

**Concern D-3 (LOW): Minor-units arithmetic must use `decimalStringToMinor` from the backfill.**
The webhook mapper must reuse `money-utils.ts`'s `decimalStringToMinor`. No parseFloat. Confirmed as a code-reuse constraint.

**Disposition:** D-1 requires Architect confirmation of the RTO→reversal path in LedgerWriter. D-2 and D-3 are confirmed correct/simple.

---

### Persona E: Isolation / System-Job Skeptic

**Concern E-1 (CRITICAL): The 35-day re-pull is a cross-tenant system job — the durable rule applies.**
The adopted durable rule `system-job-force-rls-enumeration` (2026-06-17T09:59:08Z) is binding. The re-pull job must use the SECURITY DEFINER enumeration function (mirroring `list_queued_backfill_jobs()` in 0023) to discover which connectors need re-pulling. A bare `brain_app` SELECT on `connector_instance` or `connector_cursor` without a GUC set at enumeration time returns 0 rows — the job is structurally inert in production.

The backfill worker (`run.ts`) already implements this correctly (SEC-BF-H1 fix via 0023). The re-pull job MUST mirror this exact pattern. If the re-pull's enumeration function is `list_connectors_for_repull()` (or similar), it must be SECURITY DEFINER, pinned search_path, return-dispatch-columns-only, and carry the same migration-time assertions.

**Concern E-2 (HIGH): Overlap-lock per (connector, brand) for the re-pull.**
The backfill uses `FOR UPDATE SKIP LOCKED` on the `backfill_job` table. The re-pull does not have a job table — it uses `connector_cursor`. The overlap-lock must be implemented differently: either a `FOR UPDATE SKIP LOCKED` on `connector_cursor` (acquire a row lock on the cursor row before starting a re-pull, skip if already locked by another worker), or a separate re-pull job table with the same claim/SKIP-LOCKED pattern. The Architect must bind this.

**Concern E-3 (HIGH): The re-pull emits to the LIVE lane, not the backfill lane.**
This is stated in the requirement and is correct — the re-pull's updated orders should flow through the live consumer (`dev.collector.event.v1` / `stream-worker-live`) so they appear in near-real-time. But the Architect must confirm: does the re-pull emit direct to Redpanda (like the backfill did, bypassing the collector HTTP edge) or via the collector `/collect` edge? The requirement allows either. Direct Redpanda is faster but bypasses the spool durability guarantee. Via `/collect` is slower but gives the 99.95% accept-before-validate spool. Bind it.

**Concern E-4 (MEDIUM): The webhook receiver's brand resolution must also set the brand GUC before any DB write.**
The connector_sync_status UPDATE and the Bronze emit path touch tables under FORCE RLS. The brand GUC must be set (txn-local) before these writes. This is request-scoped, so no SECURITY DEFINER fn is needed — but the GUC must be set explicitly before any DB write.

**Disposition:** E-1 is CRITICAL (durable rule violation if not implemented). E-2 and E-3 are HIGH binds for the Architect. E-4 is a HIGH implementation requirement.

---

### Persona F: Scale / Lane Skeptic

**Concern F-1 (MEDIUM): The re-pull burst must not starve real-time webhooks on the live lane.**
The live lane is `dev.collector.event.v1` / `stream-worker-live`. If the re-pull emits thousands of orders in a burst to the same topic, and the consumer group is shared, the live consumer's lag increases. The backfill solved this by using a SEPARATE topic (`dev.collector.order.backfill.v1`). 

For the re-pull, the question is: does the re-pull use the LIVE lane topic (same as webhooks) or a dedicated re-pull topic? The requirement says the re-pull lands on the LIVE lane. For M1, a single brand's 35-day window is probably hundreds of orders (not millions), so burst starvation is a minor concern. But the Architect should confirm: if the re-pull emits to the same live topic, is the consumer group's partition count sufficient to absorb the burst? An alternative is a dedicated re-pull topic (`dev.collector.order.repull.v1`) with its own consumer group — this is cleaner but adds infra surface area. Bind the Architect's decision.

**Concern F-2 (LOW): The 35-day re-pull schedule — M1 uses a simple trigger, not Argo.**
The non-goal correctly defers Argo cron. In dev, the re-pull is manually triggered. In prod, the schedule is a "platform follow-up." This is acceptable for M1. The overlap-lock (E-2) ensures that a manual re-trigger during an in-progress run is safe.

**Disposition:** F-1 is a MEDIUM architectural decision for the Architect. F-2 is low-risk.

---

## 6. Numbered Binding Decisions D-1..D-14

These are the Architect's contract. Implementation cannot begin until all are resolved.

**D-1: Webhook receiver placement — core (existing scaffold) or collector.**
The existing scaffold (`shopifyWebhookHandler.ts`) is in `apps/core`. The `/collect` edge is in `apps/collector`. The webhook receiver belongs in `apps/core` (the existing scaffold is the right location). It emits to the LIVE Redpanda topic either directly or via the collector. Bind: webhook receiver stays in `apps/core`; the emission path (direct or via `/collect`) is D-3.

**D-2: Raw-body capture — confirm @fastify/rawbody plugin is wired.**
`shopifyWebhookHandler.ts` declares `config: { rawBody: true }` and reads `(req as FastifyRequest & { rawBody?: Buffer }).rawBody`. The raw-body plugin must be registered in the Fastify instance before this route. Verify and document which plugin (`@fastify/rawbody` or equivalent) is configured in the core app bootstrap.

**D-3: Webhook emission path — direct Redpanda produce or via `/collect` HTTP edge.**
Options: (a) Direct produce to `dev.collector.event.v1` from the webhook handler (same as the backfill but on the live topic). (b) POST to `/collect` (collector service) — adds the spool durability guarantee but adds a network hop and requires the collector to be reachable from core. For M1, the backfill chose direct produce for the backfill topic. For webhooks, the requirement says "collector → Redpanda → stream-worker → Bronze" but the backfill used direct produce and the requirement also acknowledges both paths. Architect must bind: direct or via collector. Recommendation: direct produce to the live topic from the webhook handler, with the same durability properties as the backfill lane (at-least-once, Bronze ON CONFLICT idempotent). This avoids the network dependency on the collector service from within core.

**D-4 (CRITICAL): Brand resolution in the webhook handler — close the HMAC-valid-but-shop-header-spoofable gap.**
After HMAC validation: resolve `connector_instance` by `shop_domain` (from the VERIFIED header, noting the domain is now trusted because the HMAC proves the request came from the party holding the client_secret for that shop) → retrieve `brand_id` from the connector row. Set the brand GUC before any downstream write. If no connector_instance is found for the shop_domain, return 401. The `brand_id` NEVER comes from the webhook body. Document: the X-Shopify-Shop-Domain header is used ONLY as a lookup key after HMAC validation — it is not blindly trusted as the brand authority. The HMAC is over the raw body using the shared client_secret; the shop_domain lookup ties the validated shop to the registered connector. 

Note: at M1 with one connected brand (Boddactive), there is exactly one connector_instance row. The lookup is a constant-time single-row check. But the architecture must be correct for the multi-brand future.

**D-5: Webhook registration — stub/no-op in dev, bind the public-ingress follow-up.**
Webhook registration (`POST /admin/api/2025-07/webhooks/{id}.json`) requires a public callback URL. In dev, the callback URL is not public. The Architect must bind: either (a) registration is skipped/stubbed in dev (env-gated: `if (env !== 'production') skip`) with a log entry, or (b) registration is a separate "enable webhooks" step that is documented as requiring a public URL. The test harness for dev is synthetic HMAC-signed POST requests. The real Shopify webhook delivery in production requires public ingress — this is a platform follow-up slice.

**D-6 (CRITICAL): Dedup-vs-update semantics — event_id for live order events.**
The Architect must choose among the three options in Persona C's analysis. The recommended resolution: use a per-state composite key for live events: `uuidV5FromOrderLive(brandId, shopifyOrderId, updatedAtUtcMs)` where `updatedAtUtcMs` is the Shopify order's `updated_at` timestamp as milliseconds. Each distinct order state (new `updated_at`) produces a different event_id → a different Bronze row → the recognition engine generates the appropriate ledger delta. Dedup across re-pulls is guaranteed because two re-pulls of the same order state at the same `updated_at` produce the same event_id. Dedup-with-backfill: the backfill's event_id includes `:order.backfill.v1` suffix and uses only `(brand_id, order_id)` — it CANNOT collide with the live event_id (which includes `updated_at`). This means the SAME order will have: one backfill Bronze row (point-in-time at backfill) AND potentially multiple live Bronze rows (one per state change). The ledger recognition engine must handle this correctly — the backfill's provisional row becomes finalized when the live event's state progresses. Document this explicitly.

**D-7 (CRITICAL): Re-pull job enumeration — SECURITY DEFINER function required (durable rule).**
The 35-day re-pull is a cross-tenant system job. It must enumerate `connector_instance` (FORCE RLS under brain_app) to find which connectors to re-pull. A bare brain_app SELECT returns 0 rows (no GUC set at enumeration time). The Architect must define a `list_connectors_for_repull()` SECURITY DEFINER function (migration, owner = brain superuser, pinned search_path, dispatch-only columns: connector_instance_id + brand_id + shop_domain + secret_ref + cursor_value, GRANT EXECUTE TO brain_app, migration-time assertions for prosecdef=true + search_path + execute grant). After enumeration, set `app.current_brand_id` GUC before any brand-scoped read/write. Non-inert negative control test required: brain_app direct SELECT on connector_instance without GUC = 0 rows.

**D-8: Dev-honesty boundary — document and implement synthetic webhook test path.**
The test harness must provide: (a) a utility to construct a synthetic HMAC-valid Shopify webhook POST (raw body + X-Shopify-Hmac-Sha256 header computed from the client_secret); (b) a test that fires a synthetic order webhook → confirms Bronze row lands on the LIVE lane; (c) a test that fires an HMAC-invalid webhook → 401, no Bronze row. The integration test for webhooks uses Fastify `inject()` (same pattern as `HandleOAuthCallbackCommand` tests in the lifecycle regression). Real Shopify webhook delivery in dev is explicitly NOT claimed.

**D-9: Re-pull job overlap-lock — bind the implementation.**
The overlap-lock must prevent two simultaneous re-pull workers from processing the same connector. Implementation: either (a) `SELECT FOR UPDATE SKIP LOCKED` on the `connector_cursor` row for resource='orders' at job start (acquires a row-level lock, skips if already locked), with the lock released on completion; or (b) a dedicated `connector_repull_job` table with the same `queued → running → completed` state machine and `FOR UPDATE SKIP LOCKED` as the backfill. Option (a) is simpler (no new table) but ties the lock lifetime to a DB transaction; option (b) matches the backfill pattern and allows progress tracking. Architect binds which.

**D-10: Re-pull cursor — updated_at high-water mark, not since_id.**
Unlike the backfill (which uses since_id for page-stable pagination), the re-pull uses `updated_at_min = now - 35d` with a sliding window cursor tracking the latest `updated_at` seen. The cursor in `connector_cursor` for resource='orders' is currently used by the backfill for `since_id`. The re-pull needs either a different resource key (`resource='orders.repull'`) or a separate cursor mechanism. Architect binds this to prevent cursor collision.

**D-11: connector_sync_status during re-pull.**
The re-pull should update `connector_sync_status.state = 'syncing'` at start and `'connected' + last_sync_at = NOW()` on completion (mirrors the backfill's logic in run.ts:485-503). The webhook handler should similarly update `last_sync_at` and `state = 'connected'` on a successful receipt. The dashboard Connection Status reads this table.

**D-12: Webhook mapper — reuse `order-mapper.ts` exactly.**
The webhook handler must reuse the existing `mapOrderToBackfillEvent()` function from `apps/stream-worker/src/jobs/shopify-backfill/order-mapper.ts`. This is a cross-app import (core → stream-worker) which is architecturally awkward. Options: (a) move the mapper to a shared package (`packages/shopify-connector` or `packages/connector-utils`); (b) duplicate the mapper in core (violates DRY); (c) the webhook handler lives in stream-worker instead of core (changes D-1). The Architect must resolve this dependency direction. Recommendation: option (a) — a thin `packages/shopify-mapper` package holding the order mapper, money-utils, and uuid-utils, imported by both stream-worker and core.

**D-13: Recognition path for status changes — confirm LedgerWriter handles RTO as reversal.**
The existing `BackfillOrderConsumer` → `LedgerWriter` path creates provisional recognition rows. For live events, the same LedgerWriter must handle: (a) a new order → provisional row; (b) an order reaching `delivered` state (for prepaid: horizon-finalized; for COD: finalized at delivery signal) → finalized row; (c) an order reaching `RTO/cancelled` state after delivery → reversal row (new negative row, sale row untouched). The Architect must confirm the LedgerWriter's state machine covers this lifecycle before implementation begins.

**D-14: The LIVE lane topic for re-pull vs. webhook — same or separate.**
The re-pull emits to the live topic (`dev.collector.event.v1`). Webhooks also emit to the live topic. This is correct for M1 (single brand, small volume). The Architect should document that a future scale concern (burst starvation) would be resolved by a dedicated `dev.collector.order.repull.v1` topic, but this is not needed for M1.

---

## 7. Success Criteria (Binding)

- [ ] A synthetic HMAC-valid order webhook POSTed to `POST /api/v1/webhooks/shopify/:topic` lands as ONE Bronze row on the live lane (verified by reading `bronze_events` under `brain_app` with correct GUC)
- [ ] An HMAC-invalid webhook returns 401 and produces zero Bronze rows
- [ ] A webhook and a backfill of the same order state produce ONE Bronze row (event_id dedup) — verified by sending both and confirming `ON CONFLICT DO NOTHING` deduplication
- [ ] A webhook for the same order at TWO different updated_at values produces TWO Bronze rows (status change captured, not deduped)
- [ ] The 35-day re-pull: fetches orders `updated_at_min = now-35d`, emits to the live lane, advances the connector_cursor
- [ ] A late RTO/cancellation produces a NEW reversal ledger row (the original sale row is untouched, `realized_gmv_as_of` falls)
- [ ] connector_sync_status reflects `syncing` during re-pull, `connected + last_sync_at` on completion
- [ ] Cross-brand isolation: under `SET ROLE brain_app`, a webhook for Brand A cannot affect Brand B's Bronze rows or ledger (verified by the isolation pattern from chore-connector-lifecycle-regression fixtures)
- [ ] Overlap-lock: two concurrent re-pull triggers for the same connector result in one completing and the other being skipped (non-inert test with SKIP LOCKED)
- [ ] brand_id never comes from the webhook body or shop-domain header — verified by a forged-header test where the shop_domain header points to a different brand's connector but is rejected by the connector lookup (returns 401)
- [ ] No raw PII in Bronze rows or logs — verified by asserting `hashed_customer_email` is a hash, `customer.email` is absent

---

## 8. Scope Cuts — Hard Lines

The following are NOT in scope for this requirement. The Architect and builders must enforce these as hard lines:

- Settlement / net-of-fees / Razorpay finalization — separate requirement
- Meta / Google Ads connectors — separate requirement
- Full Argo cron orchestration — platform follow-up
- Public webhook ingress URL / tunnel setup — platform follow-up (blocks real production webhook delivery; M1 dev uses synthetic POSTs)
- Connector health detector / DQ A+→D gating — later slice
- Product / customer / inventory webhooks — orders only
- Per-order replay/audit UI — not part of this slice
- New deployable — forbidden; webhook receiver in existing core, re-pull in existing stream-worker job pattern

---

## 9. Paradigm

**Tier-0 deterministic.** $0/month model spend. All ingestion is pure data-pipeline processing (Kafka produce/consume, Postgres inserts, HTTP calls to Shopify Admin API). No model calls, no ML, no LLM gateway. The cost-routing audit is trivially clean.

---

## 10. Tracks

- **@backend-developer:** webhook receiver wiring (D-1..D-5, D-8, D-11) + HMAC validation + brand resolution + webhook registration stub + sync_status updates
- **@data-engineer:** 35-day re-pull job (D-7, D-9, D-10, D-14) + SECURITY DEFINER enumeration fn + overlap-lock + cursor management + LedgerWriter status-change path (D-13) + live-lane emission (D-3, D-14)
- **@frontend-web-developer:** connector tile freshness indicator (live-sync state from connector_sync_status) + dashboard real-time update
- **Shared prerequisite before parallel tracks:** mapper package extraction (D-12) — this unblocks both backend and data tracks

Order dependency: D-12 (mapper package) → tracks in parallel → D-6 (dedup semantics, resolved at design) is the risk gate.

---

**Decision: ADVANCE** — to Architect (Stage 2). All D-1..D-14 bindings are the Architect's contract. The CRITICAL decisions (D-4 brand-from-mapping, D-6 dedup-vs-update, D-7 SECURITY DEFINER enumeration) must be resolved and documented BEFORE any implementation file is written.
