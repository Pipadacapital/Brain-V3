# Architecture — feat-connector-sync-now

**req_id:** `feat-connector-sync-now` · **Lane:** high_stakes (connectors, multi_tenancy) · **Stage 2 (Architect)**
**Paradigm:** deterministic logic only — **0 LLM tokens/day, $0/mo incremental model spend.** A button that enqueues a request row + a worker that runs an existing job. No model, no statistics. (cheapest-sufficient-effort PASS.)

---

## 1. Decision in one paragraph

"Sync now" is a **trigger over the EXISTING per-source trailing-window re-pull jobs** (`apps/stream-worker/src/jobs/{shopify-repull,razorpay-settlement-repull,meta-spend-repull,google-ads-spend-repull}/run.ts`). It introduces **no new deployable, no new Kafka topic, no new event envelope, and no migration.** The "Sync now" command writes a one-shot **sync-request signal into the existing `connector_cursor` table** (sentinel `resource='<provider-resource>.request'`, `cursor_value` = request ISO timestamp) under the brand's RLS scope; a lightweight **in-worker request-claimer** (added to the already-running `stream-worker/src/main.ts`, NOT a new process) claims pending requests with `FOR UPDATE SKIP LOCKED` and invokes the **same `run(connectorInstanceId)`** the scheduler invokes. The repull job's own internal `FOR UPDATE SKIP LOCKED` overlap-lock on the live cursor row (`resource='orders.repull'` / `'meta.insights'` / `'google_ads.spend'` / `'razorpay.settlement'`) guarantees a manual click **cannot** run concurrently with a scheduled run or a second click — the second invocation finds the lock held and exits without a duplicate run, and `connector_sync_status.state='syncing'` is the "already syncing" signal surfaced to the UI. **Same code path** as the scheduler: live and manual sync are byte-identical from `run()` onward.

> **ASSUMPTION:** the scheduler invokes `run(connectorInstanceId)` as an Argo one-shot/CronWorkflow inside the stream-worker deployable (no Argo CronWorkflow manifest is committed in this repo today; the repull `run()` entrypoints are the same-code-path the requirement references). The manual path reuses that exact `run()` rather than re-submitting an Argo workflow, because (a) core has **no** Argo/k8s submit client today and adding one is a heavier, less-reversible dependency, and (b) the request-row + in-worker-claimer reuses the **already-proven** backfill dispatch shape (`backfill_job` queued → worker `claimQueued` FOR UPDATE SKIP LOCKED) with zero migration.

---

## 2. No migration required (CONFIRMED)

**No DDL.** Every primitive already exists with FORCE RLS under `brain_app`:

- `connector_cursor` (`db/migrations/0006_connector.sql:82-103`) — `UNIQUE (brand_id, connector_instance_id, resource)`, `cursor_value TEXT NULL`, RLS FORCE, `GRANT SELECT, INSERT, UPDATE TO brain_app`. The sync-request signal is a **row with a sentinel `resource`** (e.g. `orders.repull.request`); the upsert key already supports it; `cursor_value` holds the request timestamp. Reversible by deleting the sentinel rows.
- `connector_sync_status` (`0006_connector.sql:53-77`) — `state ∈ {connected, syncing, waiting_for_data, error}`, `last_sync_at`, `last_error`, RLS FORCE. **No new state needed:** `syncing` IS the in-flight signal; `error` + `last_error` carry the honest failure (TOKEN_EXPIRED → reconnect). The CHECK constraint is NOT touched (so no migration).
- SECURITY DEFINER enumeration fns already exist per source (`list_connectors_for_repull()` `0026`, `list_razorpay_connectors_for_settlement_repull()` `0027`, `list_ad_connectors_for_spend_repull()` `0029`).

> **ASSUMPTION:** the sentinel-`resource` row in `connector_cursor` is acceptable as the request queue (no separate `connector_sync_request` table). If a reviewer rejects co-locating request signals with high-water cursors in one table, the fallback is **one additive migration** `0030_connector_sync_request.sql` (a 4-column queue table mirroring `backfill_job`'s shape + RLS FORCE). Default = no migration; escalate to Architect only if the persona review flags the sentinel.

---

## 3. The on-demand sync trigger command (authz · brand-from-session · overlap-lock reuse · same event)

**Endpoint:** `POST /api/v1/connectors/:id/sync` → `202 { request_id, data: { connector_instance_id, status: 'syncing' } }`
Mirrors the backfill trigger (`apps/core/src/main.ts:1054-1119`) step-for-step.

1. **Authz — `requireRole('brand_admin')`** (Owner + Brand-Admin pass; Manager + Analyst → `403 FORBIDDEN`). This **mirrors `BackfillControl` exactly** (`main.ts:1052`) and reconciles the requirement's two authz statements: deliverable-2's "hidden for manager/analyst" is the binding UI rule, so the server gate is `brand_admin+`. The button is **hidden** for manager/analyst (not just 403'd), matching backfill.
   > **ASSUMPTION:** "connect/sync = Owner/Brand-Admin/Manager" in deliverable-1 is superseded by deliverable-2's "hidden for manager/analyst" + the BackfillControl precedent (`brand_admin+`). If Stakeholder insists Manager may trigger sync, change ONE line (`requireRole('manager')`) + the UI `canTrigger` predicate; no other change. Flagged for persona review.
2. **brand_id from session** via `getBrandId(req)` — **never** from the body (MT-1). Runs under the brand's RLS GUC (the pool's RLS middleware sets `app.current_brand_id`).
3. **Load connector_instance** brand-scoped (`connectorRepo.findById(id, brandId)`) → `404 CONNECTOR_NOT_FOUND` if absent.
4. **Token presence check** — `connectorSecretsManager.getSecret(secret_ref)` → `null` ⇒ `409 RECONNECT_REQUIRED` ("Your connection has expired. Please reconnect…"). NO token value logged/returned (I-S09). (Same as backfill `main.ts:1072-1081`.)
5. **Overlap-lock — reuse, do not reinvent.** Two guards, both DB-level `FOR UPDATE SKIP LOCKED` (no in-process lock):
   - **(a) Request-dedup:** `SELECT … FOR UPDATE SKIP LOCKED` on the sentinel `connector_cursor` request row → if a pending request already exists, return `409 SYNC_ALREADY_REQUESTED` ("A sync is already queued for this connector.").
   - **(b) In-flight check:** read `connector_sync_status.state` → if `'syncing'`, return `409 SYNC_ALREADY_RUNNING` ("This connector is already syncing.") — the honest "already syncing, not a duplicate run" response. **The authoritative lock is inside `run()`** (the repull's `FOR UPDATE SKIP LOCKED` on the live cursor row); (a)+(b) are fast UX pre-checks. Even if both pre-checks pass and a scheduled run starts a microsecond later, `run()`'s own lock makes the late manual run a no-op skip — **structurally impossible to double-run.**
6. **Enqueue the request** — upsert `connector_cursor (resource='<provider-resource>.request', cursor_value=now_iso)` under GUC (NN-1). This is the "emit the same sync command the scheduler emits": the claimer turns it into the identical `run(connectorInstanceId)` call.
7. **Audit** `connector.sync.requested` via the existing `auditWriter.append` (actor_id, actor_role, brand_id, connector_instance_id) — **NO secret_ref / token** (I-S09). Mirrors `connector.backfill.requested` (`main.ts:1100-1112`).
8. **202** `{ request_id, data: { connector_instance_id, status: 'syncing' } }`.

**Provider→resource map** (deterministic, in the command): `shopify→orders.repull`, `razorpay→razorpay.settlement`, `meta→meta.insights`, `google_ads→google_ads.spend`. The claimer dispatches to the matching `run()`.

---

## 4. Surfacing sync_status to the BFF (idle/syncing/synced/failed + last-synced)

**Reuse the existing read path** — `GET /api/v1/connectors/:id/status` (`main.ts:784-788`, `analyst+`) already returns, via `GetConnectorStatusQuery` (`…/queries/GetConnectorStatusQuery.ts`):
`{ syncState: 'connected'|'syncing'|'waiting_for_data'|'error', lastSyncAt, lastError }` straight from `connector_sync_status` (the REAL row, never simulated). **No new endpoint.**

BFF/UI state mapping (deterministic, in the hook): `waiting_for_data|connected→idle/synced`, `syncing→syncing`, `error→failed` (+ `lastError` parsed for `TOKEN_EXPIRED`/401 → reconnect hint), `lastSyncAt→last-synced timestamp`. The repull `run()` already writes `state='syncing'` before any fetch, `state='connected' + last_sync_at=NOW()` on success, `state='error' + last_error` on failure (`shopify-repull/run.ts:setSyncState`) — so the surface is already truthful end-to-end. The UI **polls** `…/status` while `syncing` (3s, like `useBackfillProgress`), stops on terminal.

> **ASSUMPTION:** `GetConnectorStatusQuery` today resolves Shopify by `findByBrandAndProvider(brandId,'shopify')`. For per-connector multi-provider status, Track A extends it (or adds a thin `findById`-based variant) to resolve by `connector_instance_id` so the status surfaces for Razorpay/Meta/Google connectors too. Additive, same shape.

---

## 5. The "Sync now" button UI (mirrors BackfillControl)

New `apps/web/components/connectors/sync-now-control.tsx` cloned from `backfill-control.tsx`:
- **Trigger button** "Sync now" (icon: `RefreshCw`), mounted in `connectors-list.tsx` next to `<BackfillControl>` (`connectors-list.tsx:147-152`), inside the `isConnected` block.
- **Authz-hidden** for manager/analyst via `useSessionRole()` (`meetsMinimumRole(role,'brand_admin')` → render button; else render only the read-only status widget) — identical to BackfillControl's D-15 rule.
- **Live status badge** — icon+text, never colour-only: `idle`/`synced` (CheckCircle + last-synced date), `syncing` (Loader2 spin + "Syncing…"), `failed` (XCircle + reason). `aria-live="polite"` region + `role="status"`.
- **Disabled + hint** while `syncing`: button disabled, `title`/`aria` "Already syncing — please wait."
- **Honest error** → on `state='error'` with TOKEN_EXPIRED/401 in `lastError`, render a reconnect prompt (`data-testid="sync-reconnect-required"`) reusing the connector health states; on `409 SYNC_ALREADY_RUNNING/REQUESTED` show the "already syncing" inline state (no duplicate trigger).
- **Last-synced** from `lastSyncAt` (`Intl` `en-IN` medium date), `data-testid="sync-last-synced"`.

Hook `apps/web/lib/hooks/use-sync-now.ts` clones `use-backfill.ts`: `useTriggerSync(connectorId)` (POST → invalidate status query) + reuse/extend the status query to poll while `syncing`. Client methods `syncApi.triggerSync` / status read added to `apps/web/lib/api/client.ts`, cloning `triggerBackfill` (`client.ts:742-768`) incl. CSRF + `{request_id,data}` unwrap.

---

## 6. Two tracks — exact file targets

### Track A — @backend-developer (trigger command + worker claimer + status surfacing)
- `apps/core/src/main.ts` — register `POST /api/v1/connectors/:id/sync` inside a `requireRole('brand_admin')` scope (clone the backfill scope `:1050-1119`); brand-from-session; token check → 409 RECONNECT_REQUIRED; overlap pre-checks (5a/5b) → 409 SYNC_ALREADY_RUNNING/REQUESTED; enqueue request row; audit `connector.sync.requested`; 202.
- **NEW** `apps/core/src/modules/connector/sync/application/commands/RequestConnectorSyncCommand.ts` — orchestrates steps 3–8 (DDD: thin route → command).
- **NEW** `apps/core/src/modules/connector/sync/infrastructure/PgSyncRequestRepository.ts` — `checkPendingRequest` (FOR UPDATE SKIP LOCKED on sentinel `connector_cursor` row), `enqueueRequest` (upsert sentinel), `readSyncState` (from `connector_sync_status`). Uses `@brain/db` `DbPool`+`QueryContext` (GUC RLS), mirrors `PgBackfillJobRepository`.
- `apps/core/src/modules/connector/sources/storefront/shopify/application/queries/GetConnectorStatusQuery.ts` — extend to resolve per `connector_instance_id` (additive) so all providers surface status.
- **NEW** `apps/stream-worker/src/jobs/sync-request-claimer/run.ts` — interval claimer (default 5s) added to `apps/stream-worker/src/main.ts` (NOT a new deployable): claims pending sentinel rows with `FOR UPDATE SKIP LOCKED` (SECURITY DEFINER enumerate → GUC-after-enumerate, MT-1), maps `resource→run()`, invokes the matching existing `run(connectorInstanceId)`, deletes the sentinel on dispatch. Reuses the GUC + lock conventions from `shopify-repull/run.ts:acquireRepullLock`.
- `apps/stream-worker/src/main.ts` — wire the claimer into startup + graceful `shutdown` (clone the consumer wiring/teardown block).
- `packages/contracts/src/api/connector.api.v1.ts` — add `SyncTriggerResponse` + reuse `ConnectorSyncStatusSchema` (already present `:97-105`). No new event schema (`connector.sync_started` already exists `m1.events.v1.ts:152-167` if a domain event is desired — reuse, do not add).
- **Deploy/test:** no new image/app (reuses core + stream-worker pipelines). Tests: `apps/core/src/modules/connector/sync/tests/sync-trigger.live.test.ts` (authz 403 manager/analyst; brand-from-session; 409 already-syncing; 409 reconnect; audit row) **under `brain_app`** (superuser `brain` bypasses RLS → isolation check INERT — assert via `assertBrainApp`); worker overlap test cloning `live-connector.e2e.test.ts` (two concurrent triggers → second skips, ONE run). Reuse `connector-lifecycle-fixtures.ts` (`seedConnectorInstance`, `seedSyncStatus`, `cleanupConnectorFixtures`).

### Track B — @frontend-web-developer (Sync now button + live status, mirrors BackfillControl)
- **NEW** `apps/web/components/connectors/sync-now-control.tsx` — clone `backfill-control.tsx` (authz-hidden manager/analyst, icon+text badge, aria-live, disabled+hint while syncing, reconnect prompt on TOKEN_EXPIRED, last-synced).
- `apps/web/components/connectors/connectors-list.tsx` — mount `<SyncNowControl connectorId={item.instance.id} />` beside `<BackfillControl>` in the `isConnected` block (`:147-152`).
- **NEW** `apps/web/lib/hooks/use-sync-now.ts` — clone `use-backfill.ts` (`useTriggerSync` + status poll while `syncing`).
- `apps/web/lib/api/client.ts` — add `syncApi.triggerSync` (clone `triggerBackfill` `:742-768`, CSRF + `{request_id,data}` unwrap) + status read; types in `apps/web/lib/api/types.ts`.
- **E2E:** `apps/web/e2e/live-sync.spec.ts` (already present — extend): connected card → Sync now → syncing badge → synced + last-synced; manager/analyst → button hidden; in-flight → disabled+hint; TOKEN_EXPIRED → reconnect prompt.

---

## 7. Alternative considered + rejected

**(Rejected) Core submits the Argo one-shot workflow directly (true "same command the scheduler emits").** Honest match to the scheduler, but adds an Argo/k8s submit client + RBAC + manifests to core — a **heavier, less-reversible** dependency with no precedent in core, for a button. The request-row + in-worker-claimer reuses the already-proven backfill dispatch shape with **zero migration and zero new infra**, and `run()`'s internal lock still guarantees no double-run. Reversible by deleting one route + one claimer + sentinel rows.

**(Rejected) New `connector_sync_request` table + migration.** Cleaner separation but violates "no migration if avoidable"; the sentinel `connector_cursor` row achieves the same with the existing RLS-protected table. Kept as the documented fallback (§2) if a reviewer rejects the sentinel.

---

## 8. Invariants honored
Tenant-isolation at every layer (brand-from-session; GUC-before-write; FORCE RLS; verified under `brain_app`). Same-code-path (`run()` identical for live/manual). Idempotent + spam-safe (DB overlap-lock; sentinel dedup). No secret/token in logs or responses (I-S09). Dev-honest failure (real `state='error' + last_error`, never fake "synced"). Every slice ships stakeholder-visible UI (Track B mandatory). No new deployable/topic/envelope/migration.
</content>
</invoke>
