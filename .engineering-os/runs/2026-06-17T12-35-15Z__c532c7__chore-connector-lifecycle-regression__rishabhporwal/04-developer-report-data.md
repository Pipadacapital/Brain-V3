# Stage 3 — Developer Report (Track A / Data Engineer)
## chore-connector-lifecycle-regression

| Field | Value |
|---|---|
| **req_id** | `chore-connector-lifecycle-regression` |
| **Track** | A — data-engineer (LEAD) |
| **Stage** | 3 |
| **Branch** | `chore/connector-lifecycle-regression` |
| **Paradigm** | Deterministic tier-0 — $0 model spend |
| **Result** | 33 GREEN / 1 SKIPPED (ADR-R3 it.skip) / 0 RED |
| **Product code changes** | NONE (D-9 honored) |

---

## Fixtures Path (B/C alignment)

`apps/stream-worker/src/tests/helpers/connector-lifecycle-fixtures.ts`

Exports (frozen at A0 commit):
- `CONNECTOR_TEST_BRAND_A = 'c07ec701-0a00-4a00-8a00-000000000001'`
- `CONNECTOR_TEST_BRAND_B = 'c07ec702-0b00-4b00-8b00-000000000002'`
- `CONNECTOR_TEST_CI_ID   = 'c07ec7c1-0c00-4c00-8c00-000000000003'`
- `NIL_UUID = '00000000-0000-0000-0000-000000000000'`
- `buildFakeStore(total)` / `buildShopifyFetchStub(store)` — pagination stub
- `seedTestBrand / seedConnectorInstance / seedSyncStatus / cleanupConnectorFixtures`
- `assertBrainApp(appPool)` — D-3 durable rule primitive

NOTE: A2/A3/A4 test files use file-private brand UUIDs (a2000001/a3000001/a4000001 prefixes)
to avoid file-level parallelism conflicts. Track B/C should do the same for their test brands.
The CONNECTOR_TEST_BRAND_A/B/CI_ID constants from the fixtures file are available for
Track B/C to use in THEIR test files without interference.

---

## Commits

| Hash | Slice | Description |
|---|---|---|
| 2772982 | A0 | Freeze connector-lifecycle fixtures + assertBrainApp |
| bba4716 | A1 | Pagination since_id=0 — 600-order 3-page walk + revert-RED |
| 4203726 | A2 | Worker NIL-uuid GUC + cross-brand isolation under brain_app |
| 42864ce | A3 | sync-status→connected + currency mismatch trigger |
| 15b249a | A4 | dev_secret round-trip + ADR-R3 it.skip; fix parallel isolation |

---

## Test Files and Revert-RED Evidence

### A1 — `apps/stream-worker/src/tests/shopify-pagination.integration.test.ts`
Defect: #6 (D-4 / shopify-paged-client.ts:121 `effectiveSinceId = sinceId ?? '0'`)
Tests: 9

| Test | Revert-RED Assertion | Named Revert |
|---|---|---|
| first URL contains since_id=0 | `expect(firstUrl).toContain('since_id=0')` | `?? '0'` → `?? null` → URL has no `since_id=0` → RED |
| since_id parameter present | `expect(params.has('since_id')).toBe(true)` | Same revert → param absent → RED |
| cursor [250, 500, null] | `expect(cursorSequence).toEqual(['250','500',null])` | null sinceId → Shopify default ordering → walk stalls → RED |
| total = 600 | `expect(allOrderIds.length).toBe(600)` | Stalled walk returns < 600 → RED |

### A2 — `apps/stream-worker/src/tests/worker-guc.integration.test.ts`
Defects: #7a NIL-uuid fix + #7b cross-brand isolation (run.ts:270 + FORCE RLS)
Tests: 9

| Test | Revert-RED Assertion | Named Revert |
|---|---|---|
| NIL-uuid positive control | `expect(row).not.toBeNull()` | NIL_UUID → `''` in run.ts:270 → throws 22P02 → RED |
| empty-string raises 22P02 | `expect(pgErrorCode).toBe('22P02')` | (this IS the revert) — proves the fix is load-bearing |
| cross-brand count === 0 | `expect(count).toBe(0)` | DROP FORCE RLS → count > 0 → RED |
| fail-closed no-GUC | 0 rows or 22P02 | RLS off → rows visible → RED |

### A3 — `apps/stream-worker/src/tests/sync-status-currency.integration.test.ts`
Defects: #8a sync-status→connected + #8c currency trigger
Tests: 10

| Test | Revert-RED Assertion | Named Revert |
|---|---|---|
| state = 'connected' after UPDATE | `expect(row.state).toBe('connected')` | Remove completion UPDATE from run.ts:485-503 → stays 'waiting_for_data' → RED |
| last_sync_at set | `expect(row.last_sync_at).not.toBeNull()` | Same revert → null → RED |
| INR into AED brand → trigger | `expect(insertPromise).rejects.toThrow(/currency mismatch/i)` | DROP trigger → INSERT succeeds silently → RED |
| error code P0001 | `expect(errorCode).toBe('P0001')` | DROP trigger → no error → RED |
| AED into AED → succeeds | `resolves.toBeDefined()` | (positive control — confirms trigger is scoped) |

### A4 — `apps/stream-worker/src/tests/dev-secret.integration.test.ts`
Defect: #8b dev_secret round-trip + prod-hard-fail
Tests: 5 + 1 skipped (ADR-R3)

| Test | Revert-RED Assertion | Named Revert |
|---|---|---|
| storeShopifyToken → dev_secret row | `expect(row.secret_value).toBe(TEST_ACCESS_TOKEN)` | Remove devPersist() → no row → worker reads null → RED |
| worker reads same token | `expect(token).toBe(TEST_ACCESS_TOKEN)` | Remove devPersist() → token=null → RED |
| delete → worker returns null | `expect(token).toBeNull()` | Remove devDelete() → row persists → worker reads old token → RED |
| prod hard-fail (core) | `expect(() => new LocalSecretsManager()).toThrow('[LocalSecretsManager] FATAL')` | Remove guard at :33-38 → no throw → RED |

---

## Test Results (green evidence)

```
Test Files  4 passed (4)
     Tests  33 passed | 1 skipped (34)
  Start at  17:02:09
  Duration  217ms
```

Run command:
```
cd apps/stream-worker && \
BRAIN_APP_DATABASE_URL=postgres://brain_app:brain_app@localhost:5432/brain \
DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
pnpm vitest run \
  src/tests/shopify-pagination.integration.test.ts \
  src/tests/worker-guc.integration.test.ts \
  src/tests/sync-status-currency.integration.test.ts \
  src/tests/dev-secret.integration.test.ts
```

---

## ADR-R3 Discovered Gap (BOUNCE)

**It.skip location:** `apps/stream-worker/src/tests/dev-secret.integration.test.ts`
**Describe block:** `A4-3: WorkerLocalSecretsManager prod-hard-fail — ADR-R3 discovered gap`

**Gap summary:**
`WorkerLocalSecretsManager` (worker-secrets.ts:69) has NO `NODE_ENV=production` constructor guard.
`buildWorkerSecretsManager()` (line 37) branches away from it in prod, but the class itself
is instantiable in production without throwing. This violates D-8 ("both managers throw under
NODE_ENV=production").

`LocalSecretsManager` (core) DOES have the guard at LocalSecretsManager.ts:33-38.

**Required fix (separate PR):** Add to `WorkerLocalSecretsManager` constructor:
```typescript
if (process.env['NODE_ENV'] === 'production') {
  throw new Error('[WorkerLocalSecretsManager] FATAL: must not be instantiated in production. Use buildWorkerSecretsManager() which routes to AwsSecretsManager.');
}
```

**Status:** it.skip with comment in A4. NOT fixed in this PR. Surface as a separate requirement.

---

## D-3 Compliance (assertBrainApp coverage)

Every isolation assertion (A2, A3) calls `assertBrainApp(appPool)` at the top of the describe block:
- Asserts `current_user = 'brain_app'`
- Asserts `is_superuser = false`

This follows the exact pattern from revenue-metrics.live.test.ts:306-315.
All GUC/isolation/cross-brand reads use BRAIN_APP_DATABASE_URL (appPool).
superPool (DATABASE_URL, role=brain) is used ONLY for seed/teardown.

---

## D-5 Compliance (never 60d543dc)

Zero references to `60d543dc` in any A-track test file. Verified:
```
grep -r '60d543dc' apps/stream-worker/src/tests/
(no output)
```

All brands use:
- A0 shared: c07ec701/c07ec702/c07ec7c1
- A2-private: a2000001/a2000002/a2000003
- A3-private: a3000001/a3000002/a3000003 + c07ec703 (AED)
- A4-private: a4000001
- All are valid hex-only UUIDs (no `n` or non-hex chars — the original c0nec701 plan constant contained `n` and was rejected by DB; corrected to c07ec701 in A0 fixture + all test files)

---

## Data-Safety Note (afterAll cleanup)

Each test file has a scoped `afterAll` that deletes:
- realized_revenue_ledger rows (WHERE brand_id IN ...)
- connector_sync_status rows
- connector_cursor rows
- connector_instance rows
- dev_secret rows (WHERE name LIKE 'brain/connector/shopify/<brandId>%')
- brand rows

All via superPool. Never touches 60d543dc (D-5).
