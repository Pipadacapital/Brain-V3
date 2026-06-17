# Stage 2 — Architecture Plan
## chore-connector-lifecycle-regression — Connector lifecycle + real-data regression net

| Field | Value |
|---|---|
| **req_id** | `chore-connector-lifecycle-regression` |
| **Lane** | `high_stakes` |
| **Architect** | architect (Opus 4.8 1M) · 2026-06-17 |
| **Paradigm** | Deterministic, tier-0 — $0/mo model spend. Tests + minimal test-only harness; no model path, no product behavior change. |
| **State** | `dev-parallel` → 3 builders (@data-engineer lead, @backend-developer, @frontend-web-developer) |
| **Binding** | Honors ALL D-1..D-9 from `02-cto-advisor-review.md`. No silent deviation. |

This is a **regression net**, not a feature. The 8 defect classes from `fix/dev-token-reach` are live on master with zero automated guards. This slice pins each one with a test whose assertion goes **RED on the named revert** (non-inert). No product code changes (D-9). Tests seed + clean their OWN brands; never touch `60d543dc-…` (D-5).

---

## 0. Grounding — what the code actually looks like (file:line)

- `apps/core/src/main.ts:463-512` — the generic OAuth callback `GET /api/v1/oauth/callback/:type`. SUCCESS → `reply.redirect(${config.appBaseUrl}/settings/connectors?connected=<type>)` (line 502); error → `?connect_error=<code>` (510); unknown type → `?connect_error=unknown_connector` (496). All 302. **The handler is a closure defined INSIDE `main()`** (the only export is `async function main()` at `main.ts:99`) — it captures `config.appBaseUrl`, `handleCallback`, `auditWriter`. There is **no `buildApp()` factory** that returns the Fastify app. → drives the D-2 decision below.
- `apps/core/src/main.ts:535` — `const instance = found && found.status !== 'disconnected' ? found : null` — the disconnected-tile fix (D-1 revert target).
- `apps/core/src/.../PgConnectorInstanceRepository.ts:128-142` — `save()` is `INSERT … ON CONFLICT (brand_id, provider) DO UPDATE … RETURNING` — the reconnect-UPSERT no-23505 fix (D-1/D-2-instance revert target).
- `apps/core/src/.../PgConnectorSyncStatusRepository.ts:64-72` — `save()` is `INSERT … ON CONFLICT (brand_id, connector_instance_id) DO UPDATE … RETURNING` (depends on migration `0025` UNIQUE). Single-sync-row fix (D-3-instance / D-7.1 revert target).
- `apps/stream-worker/src/jobs/shopify-backfill/shopify-paged-client.ts:121` — `const effectiveSinceId = sinceId ?? '0'` — the since_id=0 pagination fix (D-4 revert target). `fetchOrdersPage(sinceId, createdAtMin)` is the page-walker; `nextSinceId = orders.length === 250 && lastOrder ? String(lastOrder.id) : null` (167-169).
- `apps/stream-worker/src/jobs/shopify-backfill/run.ts:255-296` — `loadConnectorInstance()`: `BEGIN` → `set_config('app.current_brand_id'…,true)` + `set_config('app.current_user_id', NIL_UUID, true)` + workspace NIL → SELECT JOIN brand → `COMMIT`. `NIL_UUID='00000000-0000-0000-0000-000000000000'` (270). The NIL-uuid fix (D-6 revert target). `runBackfillLoop`, `findQueuedJob`, `upsertConnectorCursor` are exported (567).
- `apps/stream-worker/src/jobs/shopify-backfill/run.ts:485-503` — on `recordsProcessed > 0n`, `UPDATE connector_sync_status SET state='connected', last_sync_at=NOW(), last_error=NULL …` under brand GUC. The sync-status→connected fix (D-7.2 revert target). **This block is INLINE in `runBackfillLoop`, not an exported function.** → drives the D-7.2 decision below.
- `apps/stream-worker/src/jobs/shopify-backfill/run.ts:311-317` — `runBackfillLoop(params)` **hard-constructs `new ShopifyBackfillClient(connectorRow.shop_domain, accessToken)` at line 317.** No injection seam exists. → drives the D-4 injection-seam decision below.
- `apps/stream-worker/src/jobs/shopify-backfill/worker-secrets.ts` — `buildWorkerSecretsManager()` (36) routes prod→`AwsSecretsManager`, dev→`WorkerLocalSecretsManager`. **`WorkerLocalSecretsManager` (69) is NOT exported and has NO prod-hard-fail guard** — the class constructor never throws under `NODE_ENV=production`; only `buildWorkerSecretsManager` avoids it by branching. `getShopifyToken` reads `dev_secret` via `BRAIN_APP_DATABASE_URL` pool (83-118). → drives the D-8 prod-hard-fail decision below (a real product-gap surface).
- `apps/core/src/.../LocalSecretsManager.ts:31-39` — constructor **DOES** hard-fail under prod: `throw new Error('[LocalSecretsManager] FATAL …')`. `storeSecret`→`devPersist` INSERT…ON CONFLICT into `dev_secret` (47-52); `deleteSecret`→`devDelete` (65-68); `getShopifyToken`→L1 map ∪ `devRead` (139-144). D-8 round-trip target.
- `db/migrations/0018_realized_revenue_ledger.sql:129-159` — `ledger_currency_matches_brand()` BEFORE INSERT trigger `trg_ledger_currency`: `RAISE EXCEPTION 'currency mismatch …'` when `NEW.currency_code <> brand.currency_code`. D-7.3 revert target.
- `db/migrations/0025_connector_sync_status_unique.sql:24-25` — `ADD CONSTRAINT connector_sync_status_brand_connector_unique` UNIQUE on `(brand_id, connector_instance_id)`. The constraint the sync-row UPSERT depends on.
- `db/migrations/0024_dev_secret.sql:20-35` — `dev_secret(name PK, secret_value, …)`; `GRANT SELECT,INSERT,UPDATE,DELETE … TO brain_app`. NOT RLS-scoped (name-keyed). D-8 table.
- **Harness patterns to mirror:** dual-pool `superPool`/`appPool` + brand seed + `afterAll` cleanup in `apps/stream-worker/src/tests/backfill.e2e.test.ts:57-71,228-278`; brain_app negative-control style (`current_user='brain_app'` + `is_superuser=false` via `pg_roles.rolsuper`) at `apps/core/src/modules/analytics/tests/revenue-metrics.live.test.ts:306-315`; brand seed via `SELECT id FROM organization LIMIT 1` then `INSERT INTO brand (…currency_code,region_code…)` (backfill.e2e:253-264). e2e onboard helper `apps/web/e2e/helpers/onboard.ts` (`onboardToDashboard` → fresh brand per test, inherently isolated); `apps/web/e2e/helpers/db.ts` (superuser DB access for seeding/`markEmailVerified`).
- **Provisional contract test (item 5 / D-5-of-requirement):** `apps/core/src/modules/analytics/tests/revenue-metrics.live.test.ts` already covers the provisional surfaced contract + the brain_app negative control (from the fix-dev-token-reach bounce). **REFERENCE only — do not duplicate.** No gap found; no extension needed.

---

## 1. Cost paradigm

Deterministic, **tier-0**, $0 model spend. Every assertion is a DB row count, an HTTP status, a header string, a thrown error code, or a recorded argument value. No statistical/ML/model tier is warranted or added. Token budget: 0 tokens/day, $0/mo.

---

## 2. The two architectural decisions the directive flagged (bound here)

### ADR-R1 — D-4 ShopifyBackfillClient injection seam: **test-only harness seam, ADD it.**
`runBackfillLoop` hard-constructs `new ShopifyBackfillClient(…)` at `run.ts:317` — no seam exists. Two options:
- **(a) Test `fetchOrdersPage` directly** against a `ShopifyBackfillClient` instance with a stubbed global `fetch` — tests the client's HTTP/cursor logic in isolation but does NOT exercise the `run.ts` page loop (records-emitted, cursor checkpoint, sync-status→connected all live in `runBackfillLoop`, not the client).
- **(b) Add a minimal optional injection parameter** to `runBackfillLoop` so a test can inject a fake `ShopifyBackfillClient`-shaped object and drive the WHOLE loop.

**Decision: a HYBRID, leaning (b)-as-harness.** D-4's revert-RED (`first fetch call's sinceId === '0'`) lives in `shopify-paged-client.ts:121`, which is INSIDE the client — so **the pagination since_id=0 + 600-order-walk assertions are driven against `ShopifyBackfillClient.fetchOrdersPage` directly with a stubbed `fetch`** (option a — no product change, the seam already exists: `fetch` is global, vi.stubGlobal). The fake "store" is a 600-order in-memory array the stubbed `fetch` pages over by parsing the `since_id` query param. This proves: 3 pages 250/250/100, total 600 walked, first request URL contains `since_id=0` (revert-RED), cursor monotonic.
The **whole-loop** behaviors (records emitted to Kafka, cursor checkpoint, sync-status→connected) are covered by the **existing** `backfill.e2e.test.ts` T-series + the new D-7.2 direct-repository test (below) — NOT by injecting into `runBackfillLoop`. **No injection parameter is added to product code** (keeps D-9 clean). The "injected fake client" of D-4 is realized as a **stubbed `fetch`** behind a real `ShopifyBackfillClient` — deterministic, CI-safe, no port, and it exercises the exact line under test. This satisfies Persona A-2's "injected fake, not a fixture HTTP server" intent without touching `run.ts`.

> If Track A finds that the stubbed-`fetch` approach cannot reach a behavior D-4 requires (e.g. it needs the run.ts loop's emit/checkpoint), that is a **harness limitation → bounce to architect** for a ruling on a test-only seam; do NOT add a product param unilaterally.

### ADR-R2 — D-2/D-4-callback Fastify-inject target: **build a test-local Fastify app that mounts the SAME handler logic, OR refactor is forbidden.**
The callback handler is a closure inside `main()` (`main.ts:463`) with no `buildApp()` export. Adding a `buildApp()` factory = product refactor = **forbidden by D-9**. Three options:
- (a) Refactor `main.ts` to export `buildApp()` — **REJECTED** (product change, D-9 violation).
- (b) Drive the callback over real HTTP against a running core (`:3001`) like the e2e — heavier, needs the server up, and can't easily forge a valid signed `state`/HMAC.
- (c) **Construct a Fastify instance INSIDE the test** that registers a route with the **same handler shape**, wired to the **real** `HandleOAuthCallbackCommand` + real `appBaseUrl` config, and `inject()` against it.

**Decision: (c).** The test (`oauth-callback.integration.test.ts`) builds its own `Fastify()` in `beforeAll`, wires the **real** `HandleOAuthCallbackCommand` (real `ShopifyHmac` + `OAuthStateNonce` + `InProcessOAuthStateStore` + repos against the test DB) and a **fixed** `appBaseUrl='http://localhost:3000'`, and mounts a route whose body mirrors `main.ts:463-512` (dispatch shopify→command; success→302 `?connected=shopify`; `HmacValidationError`→302 `?connect_error=auth_failed`; unknown type→302 `?connect_error=unknown_connector`). It then `inject()`s synthetic GETs.
**Why this is non-inert despite re-stating the handler:** the test wires the **real** HMAC/state/command path, so a forged HMAC genuinely fails HMAC validation (D-2 assertion 4 is real), and the success path genuinely produces the 302+Location the product produces. The revert-RED is preserved at the **contract** level: if the product callback (`main.ts`) were reverted to JSON-200, the e2e route-interception assertion (Track C, below) catches it; the inject test pins the **contract** (302/Location/no-PII/HMAC-first) that the product must keep meeting. Track B documents this honestly: the inject test proves the callback CONTRACT against the real command; the e2e proves the live route still honors it.

> If Track B discovers the handler logic cannot be exercised without `buildApp()` (e.g. the command needs DI only `main()` provides), that is a **product-testability gap → bounce** (a `buildApp()` extraction is a separate refactor requirement), NOT a silent refactor in this PR.

---

## 3. Bound seams — 8 defect classes → test → revert-RED (one-line ADRs)

| # | Defect class | Layer / file (new) | Code-under-test | Assertion | Revert-RED |
|---|---|---|---|---|---|
| **1** | Disconnected tile → Connect | e2e (Track C) `apps/web/e2e/connector-lifecycle.spec.ts` | `main.ts:535` BFF tile | Seed a `status='disconnected'` connector_instance (superuser, `beforeAll`) → load `/settings/connectors` → assert `connector-tile-shopify-connect` is **enabled** and **no** `connector-health-badge-shopify` | Revert `main.ts:535` to `found` → tile renders a Connected/Failing badge → badge-count `toHaveCount(0)` goes RED |
| **2** | Reconnect UPSERT no-23505 | integration (Track B) `apps/core/.../connector-lifecycle.integration.test.ts` | `PgConnectorInstanceRepository.save()` :128 | Seed disconnected instance → call `save()` with connected payload for SAME `(brand,provider)` → assert returned `id === originalId`, `status==='connected'`, no throw | Revert UPSERT→plain INSERT → 2nd `save()` throws `23505` → `expect(saved.id).toBe(originalId)` goes RED |
| **3** | Single sync row | integration (Track B) same file | `PgConnectorSyncStatusRepository.save()` :64 + `0025` UNIQUE | After reconnect, under brain_app+GUC: `SELECT count(*) FROM connector_sync_status WHERE connector_instance_id=$1` **=== 1**, `state !== 'error'` | Revert UPSERT→INSERT → duplicate row (count=2) or 23505 → `count===1` goes RED |
| **4a** | Callback 302 success contract | Fastify inject (Track B) `apps/core/.../oauth-callback.integration.test.ts` | `main.ts:502` (mirrored, real command) | `inject` GET callback w/ valid state+HMAC → status **302**, `Location` starts `http://localhost:3000/settings/connectors?connected=shopify`, Location contains **no** token/secret_ref/PII | Revert to JSON-200 → `statusCode===302` goes RED |
| **4b** | Callback 302 forged-HMAC | Fastify inject (Track B) same file | real `ShopifyHmac` (HMAC-first) | `inject` GET w/ forged HMAC → **302** `Location` contains `connect_error=auth_failed` (never JSON, never 500, never `connected=`) | Remove HMAC check → forged callback 302s to `connected=` → `connect_error` assertion goes RED |
| **5** | Provisional surfaced | **REFERENCE** `revenue-metrics.live.test.ts` (existing) | `get-revenue-metrics.ts` | Already covered by the fix-dev-token-reach bounce contract test + brain_app negative control | n/a — **do NOT duplicate**; cite in plan & PR |
| **6** | Pagination since_id=0 | integration (Track A) `apps/stream-worker/src/tests/shopify-pagination.integration.test.ts` | `ShopifyBackfillClient.fetchOrdersPage` :121 | Stubbed `fetch` over 600-order store → walk all 3 pages (250/250/100), total emitted **=== 600**, cursor seq `['250','500',null]`, **first request URL contains `since_id=0`**; re-run dedups (event_id, extends T1) | Revert `?? '0'`→`?? null` → first request omits/`null`s `since_id` → first-call `since_id=0` assertion goes RED (and walk stalls < 600) |
| **7a** | Worker NIL-uuid GUC | integration **under brain_app** (Track A) `apps/stream-worker/src/tests/worker-guc.integration.test.ts` | `run.ts:255-296` `loadConnectorInstance` | Positive: seed instance → BEGIN + `set_config('app.current_user_id', NIL_UUID, true)` + brand GUC → SELECT returns the row, no error. Assert `current_user='brain_app'` + `is_superuser=false` | Revert NIL_UUID→`''` → SELECT raises `22P02` (`invalid input syntax for type uuid`) → positive-control "returns row" goes RED (revert-RED leg asserts the `22P02` throw explicitly) |
| **7b** | Cross-brand isolation | integration **under brain_app** (Track A) same file | `connector_instance` FORCE RLS | brand_A GUC → 1 row (positive); brand_B GUC reading brand_A's instance → **count === 0**; `current_user='brain_app'`, `is_superuser=false` | RLS policy dropped → brand_B sees brand_A row → `count===0` goes RED |
| **8a** | Sync-status→connected on backfill complete | integration (Track A) `apps/stream-worker/src/tests/sync-status-currency.integration.test.ts` | `run.ts:485-503` (logic mirrored via direct repo/SQL — see note) | Seed sync_status `state='waiting_for_data'` → apply the completion UPDATE under brand GUC → assert `state='connected'`, `last_error IS NULL`, `last_sync_at` set | Skip the UPDATE (revert) → state stays `waiting_for_data` → `state==='connected'` goes RED |
| **8b** | dev_secret round-trip + prod-hard-fail | integration (Track A worker-side + Track B core-side) `apps/stream-worker/src/tests/dev-secret.integration.test.ts` | `LocalSecretsManager` (core) ↔ `WorkerLocalSecretsManager` (worker) + `dev_secret` 0024 | Core `storeSecret` writes token → worker `getShopifyToken(arn)` reads SAME token; `deleteSecret`→worker read returns `null`; **`new LocalSecretsManager()` throws `[LocalSecretsManager] FATAL` under `NODE_ENV=production`** | Remove the LocalSecretsManager prod guard (`:33-38`) → `toThrow('[LocalSecretsManager] FATAL')` goes RED. **Worker prod-hard-fail: see ADR-R3 bounce below** |
| **8c** | Currency-mismatch trigger | integration (Track A) `sync-status-currency.integration.test.ts` | `trg_ledger_currency` (0018:156) | Seed brand `currency_code='INR'` → INSERT `realized_revenue_ledger` row `currency_code='AED'` via superPool → assert `RAISE EXCEPTION 'currency mismatch …'` (catch the throw, assert message/`P0001`-class) | DROP trigger → INSERT succeeds silently → `expect(...).rejects` goes RED |

**Note on 8a (sync-status→connected):** the completion logic is INLINE in `runBackfillLoop` (`run.ts:485-503`), not an exported function. Track A reproduces the **exact SQL** (`UPDATE connector_sync_status SET state='connected', last_sync_at=NOW(), last_error=NULL, updated_at=NOW() WHERE brand_id=$1 AND connector_instance_id=$2` under brand GUC) as a direct DB assertion — this pins the **contract** (the dashboard reads this row; completion must flip it). Honest scope: this proves the SQL contract, not the run.ts orchestration wiring (which the existing backfill.e2e T-series exercises end-to-end). If Track A judges the inline SQL un-reachable without invoking the full `runBackfillLoop` (Kafka+producer needed), it MAY drive the real loop with the stubbed-fetch fake from D-4 and assert the resulting `state='connected'` — preferred if cheap, but the direct-SQL contract assertion is the floor.

### ADR-R3 — D-8 worker prod-hard-fail is a PRODUCT GAP → **BOUNCE (D-9), test it `.skip` with a documented discovered-bug comment.**
D-8 requires "**both** managers throw under `NODE_ENV=production`." `LocalSecretsManager` (core) does (`:33-38`). **`WorkerLocalSecretsManager` (worker) does NOT** — the class has no constructor guard; only `buildWorkerSecretsManager()` branches away from it in prod. Asserting `new WorkerLocalSecretsManager()` throws would be **RED on current master** — but the fix is a **product change forbidden by D-9**. Per D-9, Track A MUST:
1. Write the core-side prod-hard-fail assertion (passes — real guard exists).
2. For the worker side, write `it.skip('WorkerLocalSecretsManager should hard-fail in production — DISCOVERED GAP', …)` with comment: `// DISCOVERED BUG: WorkerLocalSecretsManager has no NODE_ENV=production guard (worker-secrets.ts:69); buildWorkerSecretsManager branches to AwsSecretsManager but the class itself is instantiable in prod. NOT fixed in this PR (tests-only). Surface as a separate requirement.`
3. Surface it in the HANDOFF residuals. **Do NOT add the guard in this PR.**
This is the D-9 mechanism working as designed: the regression net discovered a real gap; we pin the half that's real and bounce the half that needs a product fix.

---

## 4. The A | B | C split + commit-per-slice

**Three parallel tracks. COMMIT PER SLICE** (prior builders lost uncommitted work to infra timeouts — only committed work survives). Track A produces the FROZEN shared fixtures FIRST (slice A0) so B and C align; B and C may start their non-fixture slices immediately (they share little fixture surface, but the brand-seed helper + UUID constants are A0-owned).

### Track A — @data-engineer (LEAD; owns frozen fixtures) — stream-worker integration
- **A0 (FREEZE FIRST → commit):** the shared fixtures module `apps/stream-worker/src/tests/fixtures/connector-lifecycle-fixtures.ts` (see §5). Commit unblocks any B/C dependency on the constants. (2–3 min)
- **A1 (commit):** `shopify-pagination.integration.test.ts` — defect #6. Build a 600-order in-memory store; `vi.stubGlobal('fetch', …)` that parses `since_id` from the request URL and returns the matching 250/250/100 slice + sets `nextSinceId` via the real client's logic; record every request URL. Assert total=600, cursor seq, **first URL contains `since_id=0`** (revert-RED), re-run dedup. (4–5 min)
- **A2 (commit):** `worker-guc.integration.test.ts` — defects #7a/#7b, **under brain_app** (`appPool` = `BRAIN_APP_DATABASE_URL`). Mirror `run.ts:271-289` BEGIN/set_config(NIL_UUID)/SELECT/COMMIT via `appPool.connect()`. Positive control + NIL-uuid leg + empty-string `''` revert-RED leg (assert `22P02`) + cross-brand count===0. **Each isolation assertion first asserts `current_user='brain_app'` + `is_superuser=false`** (mirror revenue-metrics.live.test.ts:306-315). (4–5 min)
- **A3 (commit):** `sync-status-currency.integration.test.ts` — defects #8a (sync-status→connected, direct-SQL contract) + #8c (currency-mismatch trigger fires, AED-into-INR-brand). (3–4 min)
- **A4 (commit):** `dev-secret.integration.test.ts` (worker-side) — defect #8b round-trip (core `LocalSecretsManager`→`dev_secret`→worker `WorkerLocalSecretsManager.getShopifyToken`), disconnect-deletes, **core** prod-hard-fail PASS, **worker** prod-hard-fail `it.skip` + discovered-bug comment (ADR-R3). (3–4 min)

### Track B — @backend-developer — core integration + Fastify-inject
- **B1 (commit):** `connector-lifecycle.integration.test.ts` — defects #2 (reconnect-UPSERT no-23505, same-id) + #3 (single-sync-row count===1). Dual-pool: superPool seeds + cleans; assertions under brain_app+GUC. Uses A0 brand constants. (4–5 min)
- **B2 (commit):** `oauth-callback.integration.test.ts` — defects #4a/#4b via the ADR-R2 test-local Fastify `inject()` against the real `HandleOAuthCallbackCommand`. 302-success, Location=fixed appBaseUrl, no-PII, forged-HMAC→302-error, unknown-type→302-error. (4–5 min)
- **B3 (no new test — REFERENCE):** confirm `revenue-metrics.live.test.ts` already covers the provisional-surfaced contract (defect #5). Add a one-line pointer comment in `connector-lifecycle.integration.test.ts` header citing it. **Do not duplicate.** (1 min)

### Track C — @frontend-web-developer — Playwright lifecycle e2e
- **C1 (commit):** `apps/web/e2e/connector-lifecycle.spec.ts` (new file, extends `marketplace.spec.ts` pattern + `onboardToDashboard` + `global-setup.ts`). Two tests:
  - **Disconnected-tile → Connect (defect #1):** onboard → seed a `status='disconnected'` connector_instance for the onboarded brand via the superuser DB helper (`helpers/db.ts`) → reload `/settings/connectors` → assert `connector-tile-shopify-connect` **enabled** + `connector-health-badge-shopify` `toHaveCount(0)` (revert-RED).
  - **Callback-contract honesty (defect #4, UI leg):** intercept the BFF response on the connectors page; assert the live route still 302-redirects (not JSON). Honest doc: the e2e proves the **live route** honors the 302 contract; the inject test (Track B) proves the contract against the real command. The e2e does NOT drive a real Shopify OAuth round-trip (Persona A-1/F-1 — documented limitation in the spec header).
- **C2 (no new test — REFERENCE):** the connect-tile + POST-`/connectors` UI is already covered by `marketplace.spec.ts:143-179`. Cite it; do not duplicate. C1's NEW value is the **disconnected→Connect** transition + callback-302 honesty.

> Track C honesty banner (Persona F-1, BINDING): the e2e covers **UI state transitions + the live route's 302 contract**, NOT the reconnect-UPSERT or single-sync-row DB mechanics (those are Track B integration). The reconnect-UPSERT cannot be driven through the browser without a real Shopify authorize. State this in the spec header.

---

## 5. FROZEN shared fixtures (A0 produces FIRST)

`apps/stream-worker/src/tests/fixtures/connector-lifecycle-fixtures.ts` — frozen at A0 commit; B and C import the constants they need (Track B re-declares core-side equivalents only if a cross-package import is undesirable — prefer copying the 3 UUID constants over a cross-app import).

```
// FROZEN — do not change after A0 commit without architect sign-off.

// Test brands — recognizable prefix, valid UUIDv4, distinct from ALL live brands.
// NEVER 60d543dc-… (D-5).
export const CONNECTOR_TEST_BRAND_A = 'c0nec701-0a00-4a00-8a00-000000000001';
export const CONNECTOR_TEST_BRAND_B = 'c0nec702-0b00-4b00-8b00-000000000002';
export const CONNECTOR_TEST_CI_ID   = 'c0nec7c1-0c00-4c00-8c00-000000000003';
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// Fake Shopify store shape for the pagination walk (D-4): 600 orders, 3 pages.
// The stubbed fetch pages this by since_id: page1 ids 1..250 (since_id=0),
// page2 ids 251..500 (since_id=250), page3 ids 501..600 (since_id=500, last).
export interface FakeShopifyOrder { id: number; /* + the ShopifyBackfillOrder shape fields */ }
export function buildFakeStore(total = 600): FakeShopifyOrder[]; // ascending ids 1..total
export function buildShopifyFetchStub(store: FakeShopifyOrder[]): {
  fetchImpl: typeof fetch;          // parses since_id + limit from URL, returns the slice
  recordedRequests: string[];       // every request URL, in order — for the since_id=0 assertion
};

// Brand-seed + cleanup helper (mirrors backfill.e2e:253-278). superPool only.
export async function seedTestBrand(superPool, brandId, currency = 'INR'): Promise<void>;
export async function seedConnectorInstance(superPool, { brandId, ciId, status, secretRef? }): Promise<void>;
export async function seedSyncStatus(superPool, { brandId, ciId, state }): Promise<void>;
export async function cleanupConnectorFixtures(superPool, brandIds: string[]): Promise<void>;
  // DELETE connector_sync_status, connector_cursor, connector_instance, dev_secret(name LIKE prefix),
  // realized_revenue_ledger, then brand — all WHERE id/brand_id IN brandIds. NEVER 60d543dc.

// brain_app discipline guard — call at the top of every isolation assertion (D-3).
export async function assertBrainApp(appPool): Promise<void>;
  // SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS is_superuser
  // expect current_user==='brain_app' && is_superuser===false
```

The `assertBrainApp` helper is the Single-Primitive for the durable rule — every isolation test calls it, no per-test re-implementation. The `dev_secret` cleanup uses `name LIKE 'brain/connector/shopify/' || brandId || '%'` to avoid touching live secrets.

---

## 6. Data-safety & isolation discipline (D-3 + D-5, BINDING)

- **brain_app at every isolation assertion (D-3):** all GUC/isolation/cross-brand reads use `appPool` = `BRAIN_APP_DATABASE_URL`. Each such assertion **first** calls `assertBrainApp(appPool)` → `current_user='brain_app'` + `is_superuser=false`. `DATABASE_URL` (superuser `brain`) is used **only** for seed/teardown via `superPool`. The dev superuser masks RLS (MEMORY: dev-db-superuser-masks-rls) — an isolation test under `brain` is structurally inert.
- **Never 60d543dc (D-5):** all brands are the A0 UUID constants. `beforeAll` seeds via superPool `ON CONFLICT DO NOTHING`; `afterAll` runs `cleanupConnectorFixtures`. No test references any production brand UUID. The Playwright e2e uses `onboardToDashboard` (fresh brand per test, inherently isolated) — for the disconnected-tile seed it reads the just-onboarded brand id and seeds against THAT, cleaned by the ephemeral nature of e2e brands (no shared-fixture mutation).
- **No new migration.** Confirmed: every fixture seeds via superuser INSERT into existing tables (brand, connector_instance, connector_sync_status, dev_secret, realized_revenue_ledger). `0024`/`0025`/`0018` already exist on master. Default is **no migration** (intake §3, D-5) — honored.

---

## 7. Test-plan → success-criteria map (Stage 4/5 reviewers, from D-review §6)

| Success criterion (D-review §6) | Satisfied by | Revert-RED spot-check |
|---|---|---|
| D-1 (lifecycle e2e + integration) | C1 (e2e tile transitions) + B1 (reconnect-UPSERT same-id, single-row count) | revert `main.ts:535`; revert repo INSERT |
| D-2 (callback 302, not JSON, fixed appBaseUrl, forged→error) | B2 (Fastify inject, real command) | revert to JSON-200; remove HMAC check |
| D-3 (all isolation under brain_app + assert) | A2 + B1 + every isolation assertion via `assertBrainApp` | run under `DATABASE_URL` → `is_superuser` assert RED |
| D-4 (injected fake, 600/3 pages, first since_id=0) | A1 (stubbed fetch over 600-order store) | revert `?? '0'`→`?? null` |
| D-5 (never 60d543dc, self-seed, afterAll) | A0 fixtures + every track's seed/clean | grep test files for `60d543dc` → 0 hits |
| D-6 (NIL-uuid positive + empty-string revert-RED) | A2 (positive + NIL leg + `''`→22P02 leg) | revert NIL_UUID→`''` |
| D-7 (sync reset, backfill→connected, currency trigger) | B1 (#3 reset) + A3 (#8a connected, #8c currency) | revert sync UPSERT; skip completion UPDATE; DROP trigger |
| D-8 (dev_secret round-trip + prod hard-fail) | A4 (round-trip, disconnect-delete, core prod-fail) + ADR-R3 bounce (worker prod-fail `.skip`) | remove LocalSecretsManager guard |
| D-9 (tests-only; discovered bug = bounce) | ADR-R3 worker-guard bounce; no product diff | diff confined to test dirs |

---

## 8. OUT OF THIS SLICE (explicit non-goals)

- **No product code changes (D-9).** No `buildApp()` refactor in `main.ts`; no injection param in `runBackfillLoop`; no `WorkerLocalSecretsManager` prod-guard (that's ADR-R3's bounce, a SEPARATE requirement).
- **No new migration** (fixtures seed via superuser into existing tables).
- **No new deployable.** Diff confined to `apps/web/e2e/`, `apps/core/src/modules/connector/tests/`, `apps/stream-worker/src/tests/`.
- **No real Shopify network** — pagination uses a stubbed `fetch` over an in-memory store (ADR-R1).
- **No full browser OAuth reconnect round-trip** — split per D-1 (e2e = UI transitions + 302 contract; integration = DB mechanics).
- **No re-test of already-covered surfaces** — provisional/metric-engine parity, ledger closed-sum, identity merge (their own suites). Defect #5 (provisional) is **referenced**, not duplicated.
- **No load/perf test** — 600 orders proves the algorithmic since_id=0 fix; not a 10k throughput benchmark (E-2).
- **No connector-health detector / live-sync test** — those slices aren't built.

---

## 9. Single-Primitive sweep

**CLEAN — extend-only, no forks.** ONE brand-seed/cleanup helper (A0, consumed by all tracks); ONE `assertBrainApp` guard (the durable-rule primitive, not per-test); ONE fake-store/fetch-stub (A0, consumed by the pagination test); reuses the existing dual-pool harness, `onboardToDashboard`, `helpers/db.ts`, `marketplace.spec.ts` pattern, the existing backfill.e2e brand-seed shape, and the existing provisional contract test (reference). No new harness, no new fixture server, no new deployable, no new migration, no new ADR beyond the three test-scope ADRs (R1/R2/R3) which are all test-only/bounce decisions.

---

## 10. Over-engineering self-check: PASS
Tier-0 deterministic; no model path; no product change; no new infra. The only "mechanism" is a stubbed `fetch` (cheaper than a fixture HTTP server, per Persona A-2/E-1). Plan length matches the high-stakes band (8 defect classes × non-inert assertions × 3 isolation/data-safety constraints warrant the detail). Three discovered-gap/decision ADRs are surfaced rather than silently absorbed.
