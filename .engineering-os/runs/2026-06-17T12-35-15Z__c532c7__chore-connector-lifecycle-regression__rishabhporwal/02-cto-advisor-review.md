# Stage 1 — Engineering Advisor Review
## chore-connector-lifecycle-regression

| Field | Value |
|---|---|
| **req_id** | `chore-connector-lifecycle-regression` |
| **Reviewed at** | 2026-06-17T12:50:00Z |
| **Reviewer** | cto-advisor (Sonnet 4.6) |
| **Lane** | `high_stakes` |
| **Trigger surfaces** | `connectors`, `multi_tenancy`, `oauth/secrets`, `pii`, `schema_proto` |
| **Decision** | ADVANCE |
| **Paradigm** | Deterministic — tier-0, $0 model spend. Tests only; no model path added. |

---

## 1. Lane Confirmation

The orchestrator's deterministic scan returned `high_stakes` with surfaces: `connectors`, `multi_tenancy`, `oauth/secrets`, `pii`, `schema_proto`. This is confirmed and not silently downgraded.

No surfaces removed. One surface note added for the architect's awareness: the `schema_proto` surface fires because PgConnectorSyncStatusRepository UPSERT and migration 0025 UNIQUE are load-bearing contract expectations for the sync-row dedup test — any future schema change to `connector_sync_status` will require re-validating DC-3 below.

Persona count: 0 spawned (stress-test personas folded/inhabited inline per high-stakes compressed lane, as confirmed by role prompt). This is a TEST requirement; the primary risk is inert/tautological tests, not product behavior. Stress-test angles are embedded in each binding decision below.

---

## 2. Dependency Pre-flight

All upstream requirements are shipped and on master:

- `feat-connector-marketplace` — PASS (Stage 6 approved 2026-06-17T10:30)
- `feat-connector-backfill` — PASS (Stage 6 approved 2026-06-17T16:10)
- `fix-dev-token-reach` — PASS (Stage 6 approved 2026-06-17T16:30); the 8 fixes this suite guards are live on master
- `system-job-force-rls-enumeration` durable rule — adopted 2026-06-17T09:59

No blocker dependency in `proposed_children[].blocks` is unshipped. Pipeline is NOT blocked.

---

## 3. "Make It Less Dumb First" — Scope Sanity Pass

What can be deleted or deferred?

- The requirement asks for 6 delivery items covering 8-9 named defect classes. This is the right size. The coverage gap is real (8 live fixes with zero automated guards). Do NOT shrink.
- The only over-engineering risk is the pagination stub mechanism (see D-4 below) — keep it as an injected fake client, not a local HTTP fixture server.
- Migration additive-only if truly needed: the requirement already says "prefer none." The architect must confirm whether any test fixture (e.g., seeding a `connector_instance` + `connector_sync_status` for reconnect tests) needs a migration or whether test setup via superuser INSERT suffices. Prefer the latter.
- No new deployable. Period.

---

## 4. Persona Concerns (stress-test angles — inhabited inline)

### Persona A: Test Realist / Feasibility Skeptic

**Concern A-1 (HIGH): The lifecycle e2e cannot drive a real OAuth reconnect. A real reconnect requires the user's browser to hit Shopify's `/admin/oauth/authorize` and return with a code — Playwright cannot automate an external OAuth provider without a live store credential. If the architect tries to make the e2e drive the full reconnect round-trip, the test will either (a) be flaky/non-runnable in CI, (b) depend on a live Shopify test store, or (c) silently skip and give false green coverage.**

Disposition: BINDING. The reconnect leg MUST be split: the e2e covers connect/disconnect/connect-button-state transitions plus the OAuth CALLBACK CONTRACT via route interception/assertion (no real Shopify round-trip); the reconnect-UPSERT + single-sync-row assertions live in a `vitest` integration test at the repository/DB layer (superuser seeds a disconnected connector_instance, calls `PgConnectorInstanceRepository.save()` with a reconnect payload, asserts the UPSERT returned the SAME row id with status=connected and exactly ONE connector_sync_status row). See D-1 and D-2 below.

**Concern A-2 (HIGH): The pagination walk needs a mock Shopify. Two options exist: (a) inject a fake `ShopifyBackfillClient` implementation into `runBackfillLoop` (controlled by constructor parameter / dependency injection), or (b) spin up a local HTTP fixture server (e.g., a tiny `http.createServer` in `beforeAll`). Option (a) is cheaper, faster, deterministic, and does not require binding a port. Option (b) tests the HTTP layer of `ShopifyBackfillClient` itself but is heavier. The requirement says "no real network"; option (b) is still no-real-network but introduces process/port management complexity. For a >500-order correctness test, option (a) is the right call.**

Disposition: BINDING. Mock Shopify = injected fake client (option a). The `runBackfillLoop` (or a thin adapter) must accept a `ShopifyBackfillClient`-shaped interface parameter; the test injects a fake that returns configurable pages. This is deterministic, CI-safe, and cheap. See D-4.

### Persona B: Isolation / RLS Skeptic

**Concern B-1 (CRITICAL): The worker GUC negative control and cross-brand isolation tests MUST assert `current_user='brain_app'` AND `is_superuser=false`. The dev superuser `brain` bypasses RLS and will silently pass any isolation assertion. Every prior run that hit this pattern was a false-pass — it is the MOST COMMON root cause in this codebase (3 occurrences, now a durable rule). A test seeded and read under `brain` (even inadvertently, e.g., by using `DATABASE_URL` instead of `BRAIN_APP_DATABASE_URL`) is structurally inert.**

Disposition: BINDING. All isolation assertions use `BRAIN_APP_DATABASE_URL` (the `brain_app` pool). Each test that asserts a zero-row negative control MUST also assert `current_user='brain_app'` AND query `pg_roles` for `is_superuser=false`. See D-3.

**Concern B-2 (HIGH): The NIL-uuid GUC test (the worker's `loadConnectorInstance` fix in `run.ts`) must prove that the empty-string user/workspace GUC stale case is handled. The fix sets `app.current_user_id` and `app.current_workspace_id` to the NIL UUID (`00000000-0000-0000-0000-000000000000`) within a BEGIN/COMMIT transaction. The test must confirm this path succeeds (positive control) AND that an empty-string GUC without the fix would fail the `::uuid` cast (negative control / revert-RED). The revert-RED assertion: pass `''` as the user_id GUC and assert the connector_instance query raises or returns null, proving the NIL-uuid substitution is load-bearing.**

Disposition: BINDING. See D-6 (NIL-uuid negative control). The integration test must explicitly test the empty-string-GUC failure path to prove the fix is non-inert.

### Persona C: Non-Inert / Anti-Tautology Skeptic

**Concern C-1 (HIGH): The requirement lists 8 defect classes. If any test assertion is trivially green regardless of whether the fix is in place, the test provides zero regression protection. Every assertion must be specified such that a reviewer can say "if I revert commit X, this assertion goes RED." Generic assertions like `expect(count).toBeGreaterThan(0)` or `expect(status).not.toBe('error')` are tautology risks. Each defect class needs a SPECIFIC revert-RED assertion.**

Disposition: BINDING. See the non-inert assertion column in D-1 through D-8.

### Persona D: Data-Safety Skeptic

**Concern D-1 (CRITICAL): The requirement explicitly calls out the real Boddactive brand (`60d543dc-...`, ~19.5k live ledger rows). Any test that seeds or reads data from this brand is a data-integrity threat — even a read that happens to assert zero rows could be masking a real data problem. The integration tests MUST seed their OWN brands (fixed UUID constants not matching any live brand) and clean up in `afterAll`.**

Disposition: BINDING. Tests must never touch `60d543dc-...`. All test fixtures use purpose-built UUID constants with recognizable prefixes (e.g., `cc0nect01-...`). See D-5.

### Persona E: Scope / Cost Realist

**Concern E-1 (HIGH): A discovered product bug during test implementation is NOT in scope. If writing the reconnect-UPSERT integration test reveals that `PgConnectorInstanceRepository.save()` has an edge case not covered by the fix, the correct action is BOUNCE (surface it as a new defect, open a separate requirement) — NOT silently fix it in this PR. Test-only means test-only.**

Disposition: BINDING. See D-9.

**Concern E-2 (MEDIUM): The pagination walk test needs >500 orders to prove the since_id=0 fix. 600 is sufficient. 10,000 is unnecessary (the bug was algorithmic, not about volume). Keep the fixture at 600–2,000 orders in 3–8 pages of 250 each. A perf/throughput test is out of scope.**

Disposition: BINDING. Fixture size: 3–8 pages, 250 orders/page max, total 600–2,000 orders. See D-4.

### Persona F: Honesty Skeptic

**Concern F-1 (HIGH): The e2e cannot fully prove the reconnect-UPSERT or the single-sync-row invariant through the browser. A Playwright test that clicks "Connect" will hit the POST /api/bff/v1/connectors endpoint and get redirected to Shopify — it cannot complete the OAuth flow. If the architect tries to cover the reconnect-UPSERT via e2e, the test will either intercept the network response (not proving the DB state) or be fake/inert. This coverage level must be documented honestly: the e2e proves UI state transitions (tile shows "Connect" after disconnect; no "Failing" tile for disconnected status), not the DB UPSERT mechanics.**

Disposition: BINDING. Coverage is explicitly split and documented in D-1 and D-2. The e2e asserts UI/BFF contract; the integration test asserts DB/repo mechanics.

---

## 5. Binding Decisions (D-1 through D-9)

The Architect MUST honor all of these. No silent deviation.

---

### D-1: Lifecycle Coverage Split (e2e vs integration)

**Binding:** The connect→disconnect→reconnect lifecycle is split across TWO test layers:

**E2E layer (Playwright, `apps/web/e2e/connector-lifecycle.spec.ts`, new file extending marketplace.spec.ts pattern):**
- Connect: onboard brand → go to `/settings/connectors` → enter shop domain → assert POST `/api/bff/v1/connectors` fires with `{type:'shopify',shop_domain}` → intercept the response (will be a redirect to Shopify OAuth; catch the request, don't follow) → assert tile now shows "Connected" state via a mocked GET `/api/v1/connectors` response OR by seeding a connected `connector_instance` via the superuser pool in `beforeAll` and reloading the page
- Disconnect: seed a connected `connector_instance` (superuser `beforeAll`) → load `/settings/connectors` → assert tile shows Connected badge (`connector-health-badge-shopify`) → click disconnect → assert DELETE `/api/v1/connectors/:id` fires → assert tile returns to "Connect" state (no "Failing" badge), `connector-tile-shopify-connect` button is enabled — this is the **disconnected-tile-as-failing fix assertion**
- Callback contract: see D-2

**Integration layer (`apps/core/src/modules/connector/tests/connector-lifecycle.integration.test.ts`, new file, vitest, dual-pool pattern from `revenue-metrics.live.test.ts`):**
- Reconnect-UPSERT: superuser seeds a `connector_instance` with `status='disconnected'` for a test brand → call `PgConnectorInstanceRepository.save()` with a new connected payload → assert RETURNING row has the SAME `id` (same row reactivated, not a new row) → assert `status='connected'` → assert `connector_sync_status` count = 1 exactly (not 2; UPSERT dedups the stale row)
- Single-sync-row: same test, assert via direct DB query under brain_app GUC that `SELECT count(*) FROM connector_sync_status WHERE connector_instance_id = $1` = 1

**Revert-RED assertions:**
- Disconnected-tile fix: if `main.ts` line `const instance = found && found.status !== 'disconnected' ? found : null` is reverted, the tile would show a Connected/Failing badge for a disconnected instance; assert goes RED on the badge presence check
- Reconnect-UPSERT: if `PgConnectorInstanceRepository.save()` reverts from UPSERT to INSERT, the second `save()` call throws `23505`; test catches the throw — goes RED on `expect(savedRow.id).toBe(originalId)` (the SAME id assertion fails if a new row was inserted or an error thrown)

---

### D-2: OAuth Callback Contract

**Binding:** Tested as an integration/API-layer test (NOT full browser e2e, because the callback is a `GET` against core's `/api/v1/oauth/callback/:type` which only Shopify can invoke in prod):

**Test file:** `apps/core/src/modules/connector/tests/oauth-callback.integration.test.ts` (or extend the lifecycle integration test above, same file).

**Mechanism:** Use `supertest` or Fastify's `inject()` to fire a synthetic `GET /api/v1/oauth/callback/shopify?code=fake&state=<valid_signed_state>&hmac=<valid_hmac>` directly against the Fastify app instance. Verify:
1. Response is a `302` redirect (not `200` with JSON body)
2. `Location` header starts with `http://localhost:3000/settings/connectors?connected=shopify` (the fixed `appBaseUrl` — no open-redirect to a different host)
3. Location header does NOT contain a token, secret_ref, or PII
4. A forged callback (invalid HMAC) returns `302` to `?connect_error=<code>` (not raw JSON, not a 500)
5. An unknown connector type returns `302` to `?connect_error=unknown_connector`

**Revert-RED assertions:**
- If the callback reverts to returning raw JSON on success, assertion (1) fails (302 check goes RED)
- If `appBaseUrl` is removed from the redirect target, assertion (2) fails
- If HMAC check is removed, the forged-callback test would get a 302-success instead of 302-error — assertion (4) goes RED

---

### D-3: All Isolation/Negative Controls Under brain_app (MANDATORY — durable rule)

**Binding:** Every integration test that asserts isolation, cross-brand visibility, or GUC behavior MUST:
1. Use `BRAIN_APP_DATABASE_URL` for the `appPool`
2. At the start of each isolation assertion, query: `SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser` via `appPool` and assert `current_user='brain_app'` AND `is_superuser=false`
3. Never use `DATABASE_URL` (the superuser `brain`) for isolation assertions — only for setup/teardown

This mirrors the exact pattern in `revenue-metrics.live.test.ts:306-315` and `backfill.e2e.test.ts:300-312`. The pattern is non-negotiable per durable rule `system-job-force-rls-enumeration`.

The worker brand-GUC cross-brand negative control (requirement item 4) must assert:
- `brain_app` direct SELECT on `connector_instance` without GUC = 0 rows (proves FORCE RLS is active; revert-RED: if RLS is disabled this returns > 0)
- `brain_app` SELECT on `connector_instance` with brand_A GUC = 1 row (positive control)
- `brain_app` SELECT on `connector_instance` with brand_B GUC = 0 rows for brand_A's row (cross-brand isolation; revert-RED: if RLS policy drops this returns > 0)

---

### D-4: Mock Shopify Mechanism for Pagination Walk

**Binding:** The pagination walk test uses an **injected fake `ShopifyBackfillClient`**. The architect must ensure `runBackfillLoop` (or the lowest-level page-walking function) accepts a `ShopifyBackfillClient`-shaped interface as a parameter (or the test stubs the class via dependency injection). No local HTTP fixture server.

**Fake client behavior:**
- `countOrders()` returns a fixed integer (e.g., 600)
- `fetchOrdersPage(sinceId, createdAtMin)`: returns pages deterministically based on `sinceId`
  - Page 1: `sinceId=null` or `'0'` → 250 orders with IDs 1–250, `nextSinceId='250'`
  - Page 2: `sinceId='250'` → 250 orders with IDs 251–500, `nextSinceId='500'`
  - Page 3: `sinceId='500'` → 100 orders with IDs 501–600, `nextSinceId=null` (last page)
  - Any other `sinceId` → throws (detects an invalid cursor advance)

**Assertions (non-inert):**
- Total orders emitted = 600
- Cursor values after each page = `['250', '500', null]` (monotonically increasing IDs)
- First call MUST have `sinceId='0'` (not `null` / omitted) — **revert-RED for the since_id=0 fix**: if `shopify-paged-client.ts` line `const effectiveSinceId = sinceId ?? '0'` is reverted to `sinceId ?? null`, the first page call gets `sinceId=null` which the fake client translates differently OR the test explicitly checks the recorded `sinceId` arguments and fails on `null` vs `'0'`
- A re-run of the same page loop with the same orders does not insert new Bronze rows (event_id dedup — extends the existing T1 pattern)

**Fixture size: 3 pages, 600 total orders.** Not a performance test.

---

### D-5: Test Data Isolation — Never Touch 60d543dc

**Binding:** Every integration test that seeds DB data MUST:
1. Use purpose-built UUID constants (e.g., `CONNECTOR_TEST_BRAND_A = 'c0nect01a-0000-0000-0000-000000000001'` — valid UUIDv4 shape, distinct from all live brand IDs)
2. Seed these brands in `beforeAll` using the `superPool` (INSERT OR ON CONFLICT DO NOTHING)
3. Clean up ALL seeded rows in `afterAll` via the `superPool` (DELETE FROM connector_instance WHERE brand_id IN (...), DELETE FROM connector_sync_status WHERE ..., DELETE FROM brand WHERE id IN (...))
4. NEVER reference or query `60d543dc-...` or any production brand UUID
5. The Playwright e2e uses `onboardToDashboard()` which creates fresh brands per test via the registration flow — inherently isolated, no cleanup concern

This mirrors the exact pattern in `backfill.e2e.test.ts:BRAND_A/BRAND_B` constants and `beforeAll/afterAll` cleanup.

---

### D-6: NIL-uuid GUC Negative Control (SEC-DTR-L1 — non-inert)

**Binding:** The integration test for `loadConnectorInstance` (worker's NIL-uuid fix) MUST include:

1. **Positive control (fix in place):** seed a `connector_instance` for test brand → call `loadConnectorInstance(pool, ciId, brandId)` (the exported/importable function or an equivalent integration via the DB) → assert it returns the row (status='connected'), no error
2. **NIL-uuid user/workspace GUC test:** verify that setting `app.current_user_id='00000000-0000-0000-0000-000000000000'` and `app.current_workspace_id='00000000-0000-0000-0000-000000000000'` within a BEGIN/COMMIT transaction BEFORE the connector_instance SELECT does NOT cause a `::uuid` cast error and DOES return the row (proves NIL-uuid is the correct sentinel)
3. **Revert-RED (empty-string GUC):** set `app.current_user_id=''` and `app.current_workspace_id=''` (the OLD behavior before the fix) within a BEGIN/COMMIT → execute the connector_instance SELECT → assert this either throws or returns 0 rows. If the DB raises `invalid input syntax for type uuid`, catch it and assert the error code/message. This is the assertion that goes RED if the NIL-uuid substitution is reverted.

**Implementation note:** `run.ts` uses `client.query('BEGIN')` then the triple `set_config(...)` then the SELECT then `COMMIT`. The test can replicate this exact pattern using `appPool.connect()` with explicit transaction management, same as `T11` in `backfill.e2e.test.ts`.

---

### D-7: Sync-Status + Currency Edges

**Binding:** Three sub-tests:

1. **Reconnect resets sync_status (no stale 'error'):** after seeding a `connector_sync_status` row with `state='error'` for a disconnected connector_instance, call `PgConnectorSyncStatusRepository.save()` with a new `state='waiting_for_data'` payload → assert `SELECT count(*) FROM connector_sync_status WHERE connector_instance_id=$1` = 1 (not 2), and `state='waiting_for_data'` (not 'error'). **Revert-RED:** if the UPSERT in `PgConnectorSyncStatusRepository.save()` reverts to INSERT, this INSERT would fail with 23505 (unique constraint on `(brand_id, connector_instance_id)`), or succeed (leaving 2 rows) — both cases fail `count=1` assertion.

2. **Backfill completes → sync_status='connected':** seed a `connector_sync_status` row with `state='waiting_for_data'` → invoke the run.ts logic that sets sync_status on job completion (either via the exported function or via a direct repository call mirroring the code path) → assert `state='connected'`. **Revert-RED:** if `run.ts` never updates sync_status on completion, this stays at 'waiting_for_data' and the assertion fails.

3. **Currency mismatch trigger:** seed a `brand` with `currency_code='INR'` → attempt to INSERT a `realized_revenue_ledger` row with `currency_code='AED'` for that brand via the `superPool` → assert the trigger raises (PG error with code `P0001` or similar). This is a structural invariant test. **Revert-RED:** if the trigger `ledger_currency_matches_brand` is dropped, the INSERT succeeds without error and the assertion fails. Note: this test is PURELY a DB-layer assertion, no application code involved, no risk of behavior change.

---

### D-8: dev_secret Cross-Process Round-Trip

**Binding:** Integration test in `apps/core/src/modules/connector/tests/dev-secret.integration.test.ts` (or `apps/stream-worker/src/tests/dev-secret.integration.test.ts`):

1. **Round-trip:** instantiate `LocalSecretsManager(pool)` (where `pool` is a `pg.Pool` connected to the test DB via `DATABASE_URL`; the `LocalSecretsManager` constructor allows a pool) → call `storeSecret(testBrandId, {connectorType:'shopify'}, {access_token:'test-token-abc'})` → instantiate `WorkerLocalSecretsManager` → call `getShopifyToken(resultArn)` → assert the returned token equals `'test-token-abc'` (same value, cross-process simulated by two different manager instances sharing the DB)
2. **Disconnect deletes:** call `LocalSecretsManager.deleteSecret(arn)` → call `WorkerLocalSecretsManager.getShopifyToken(arn)` → assert `null`
3. **Prod hard-fail:** `expect(() => new LocalSecretsManager()).toThrow('[LocalSecretsManager] FATAL')` with `process.env.NODE_ENV='production'`. **Revert-RED:** if the constructor guard is removed, this `toThrow` assertion fails.

**Note on environment:** This test requires the `dev_secret` table (migration 0024) to exist. The test uses a fixed test secret name prefixed to avoid collision with any live secret. Cleanup in `afterAll` via `DELETE FROM dev_secret WHERE name LIKE 'brain/connector/shopify/<test-brand-prefix>%'`.

---

### D-9: Tests-Only — Discovered Product Bug = Bounce, Not Silent Fix

**Binding:** If writing any test reveals a PRODUCT BUG (a defect in application code beyond the 8 already-fixed classes), the builder MUST:
1. STOP implementing the test for that surface
2. Document the discovered bug in a comment: `// DISCOVERED BUG: <description> — NOT fixed in this PR`
3. Surface it to the engineering advisor (via a comment or a separate ticket) as a separate requirement
4. Ship the test suite WITHOUT the fix — the test may be `test.skip()`-d with an explanatory message until the bug is fixed in a separate PR

This is a hard scope constraint. This PR is a TEST/REGRESSION suite, not a product-change PR. No product behavior changes.

---

## 6. Success Criteria (for Stage 4/5 reviewers)

A reviewer checking this PR passes it if and only if ALL of the following are true:

1. **D-1 SATISFIED:** `connector-lifecycle.spec.ts` (e2e) covers connect UI + disconnect UI + tile state transitions. `connector-lifecycle.integration.test.ts` covers reconnect-UPSERT (same-id assertion) + single-sync-row count assertion.
2. **D-2 SATISFIED:** OAuth callback contract tested via Fastify inject / supertest — 302 on success, 302 on error (not JSON), fixed appBaseUrl in Location header, forged-HMAC 302-to-error.
3. **D-3 SATISFIED:** Every isolation assertion has `current_user='brain_app'` + `is_superuser=false` verification. No isolation test uses `DATABASE_URL` for assertions.
4. **D-4 SATISFIED:** Pagination walk uses injected fake client returning 3 pages / 600 total orders. First page call recorded with `sinceId='0'` (not null). Total emitted count assertion = 600.
5. **D-5 SATISFIED:** No reference to `60d543dc-...` anywhere in the test files. All brands are test-specific UUIDs. `afterAll` cleans up.
6. **D-6 SATISFIED:** NIL-uuid positive control + empty-string revert-RED test both present and non-inert.
7. **D-7 SATISFIED:** All three sub-tests present (sync-status reset, backfill-connected transition, currency-mismatch trigger fire).
8. **D-8 SATISFIED:** dev_secret round-trip + disconnect delete + prod-hard-fail all present.
9. **D-9 HONORED:** No product-code changes in the diff. Any `test.skip()` has a documented discovered-bug comment.
10. **All tests GREEN on current master** and would go RED on the named revert (reviewer spot-checks one revert-RED per defect class).
11. **No new deployable** (diff confined to `apps/web/e2e/`, `apps/core/src/modules/connector/tests/`, `apps/stream-worker/src/tests/`; possible new test file in each).

---

## 7. Scope Cuts (Confirmed Non-Goals)

- No load/perf test (10k orders, throughput benchmarks)
- No live Shopify network call
- No full browser OAuth reconnect round-trip (split per D-1)
- No re-testing of already-covered surfaces (metric-engine parity, ledger closed-sum, identity merge)
- No new connector features or behavior changes
- No new migration unless strictly required for a test fixture (architect must justify; default is no)

---

## 8. Audit Trail

Decision log line:
```json
{"ts":"2026-06-17T12:50:00Z","actor":"cto-advisor","type":"intake-review","req_id":"chore-connector-lifecycle-regression","stage":1,"lane":"high_stakes"}
```
