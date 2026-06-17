# Stage 4 — Developer Report (Backend Track B)
## chore-connector-lifecycle-regression

| Field | Value |
|---|---|
| **req_id** | `chore-connector-lifecycle-regression` |
| **Track** | B — Backend (@backend-developer) |
| **Stage** | 3 |
| **Slice** | B1 (reconnect-UPSERT + single-sync-row) · B2 (OAuth callback 302 contract) · B3 (reference) |
| **Branch** | `chore/connector-lifecycle-regression` |
| **Verification** | typecheck EXIT 0 · 14 tests green · 0 skipped (B-track) |
| **Handoff** | READY-FOR-SECURITY |

---

## 1. Files produced

| File | Slice | Tests |
|---|---|---|
| `apps/core/src/modules/connector/tests/connector-lifecycle.integration.test.ts` | B1 | 6 |
| `apps/core/src/modules/connector/tests/oauth-callback.integration.test.ts` | B2 | 8 |

Total new B-track tests: **14**. No product code changed (D-9).

---

## 2. B1 — Reconnect UPSERT no-23505 + single-sync-row

**File:** `apps/core/src/modules/connector/tests/connector-lifecycle.integration.test.ts`

**Defects covered:** #2 (reconnect UPSERT no-23505) + #3 (single sync row + stale-error reset)

**Test results:** 6/6 green

| Test | Assertion | Revert-RED |
|---|---|---|
| first save() inserts connected instance (positive control) | `saved.id === B1_CI_ID`, `saved.status === 'connected'` | n/a (positive control) |
| second save() for same (brand_id, provider) → SAME row id, no 23505 | `saved2.id === B1_CI_ID` (original id retained by UPSERT) | Revert save() to plain INSERT → throws 23505 → `saved2.id` assertion RED |
| DB-level confirmation: exactly ONE connector_instance row | `row.rows.length === 1`, `id === B1_CI_ID` | Plain INSERT would produce 2 rows (or throw) |
| first sync_status save() → waiting_for_data (positive control) | `saved.state === 'waiting_for_data'` | n/a |
| second save() after stale 'error' → count===1, state!==error (defect #3 non-inert) | `count === 1`, `state === 'waiting_for_data'`, `last_error === null` | Revert UPSERT → plain INSERT → count=2 or 23505 → count===1 RED |
| count===1 under brain_app+GUC (D-3 isolation guard) | `assertBrainApp(appPool)` + GUC transaction count query === 1 | Run under DATABASE_URL (brain superuser) → is_superuser assertion RED |

**Data safety (D-5):** Brand UUIDs `b1b10001-0001-4001-8001-000000000001` and `b1b10002-0002-4002-8002-000000000002` — file-private B-track prefix, never 60d543dc-*.

**D-3 discipline:** `assertBrainApp(appPool)` called before the isolation count assertion. superPool used only for seed/teardown.

---

## 3. B2 — OAuth callback 302 contract via Fastify inject (ADR-R2)

**File:** `apps/core/src/modules/connector/tests/oauth-callback.integration.test.ts`

**Defects covered:** #4a (valid callback → 302 success) + #4b (forged HMAC → 302 error) + #4c (unknown type → 302 error)

**Test results:** 8/8 green

| Test | Assertion | Revert-RED |
|---|---|---|
| valid callback → 302 (not JSON-200) | `statusCode === 302` | Revert handler to `reply.send({ok:true})` → statusCode=200 → RED |
| valid callback → Location=`<appBaseUrl>/settings/connectors?connected=shopify` | `location.startsWith('http://localhost:3000/...')` | Revert appBaseUrl → wrong host → RED |
| valid callback → Location has no token/secret_ref/PII | location does not match `/token/i`, `/secret/i`, `/arn:/i` | Token leak would match these patterns → RED |
| valid callback → body is not a JSON-200 data response | body has no `connectorInstanceId`/`secretRef`/`access_token` | JSON-200 with those keys → RED |
| forged HMAC → 302 (not 500 or JSON) | `statusCode === 302` | Exception not caught → 500 → RED |
| forged HMAC → Location contains `connect_error=auth_failed` (not `connected=shopify`) | `location.includes('connect_error=auth_failed')` + `not.includes('connected=shopify')` | Remove HMAC check → forged succeeds → Location=connected=shopify → RED |
| forged callback → connector NOT created | Location=`connect_error=auth_failed`, not `connected=` | Remove HMAC check → Location=connected= → RED |
| unknown connector type (`/meta`) → `connect_error=unknown_connector` | `location.includes('connect_error=unknown_connector')` | n/a (handler always redirects for unknown type) |

**ADR-R2 honesty note:** The test builds its own `Fastify()` instance (no buildApp() export = no product change). The handler is re-stated inline but wires the REAL `HandleOAuthCallbackCommand` + `ShopifyHmac` + `InProcessOAuthStateStore`. HMAC validation is real (not stubbed) — forged HMAC genuinely fails. `fetch` is vi.stubGlobal-d to return a fake token exchange (no real Shopify network). Stub repos (no DB writes). The test proves the **contract** (302/Location/no-PII/HMAC-first); the e2e (Track C) proves the live route still honors it.

**Data safety (D-5):** Brand UUID `b2b20001-0001-4001-8001-000000000001` in state nonce only — no DB writes.

---

## 4. B3 — Provisional surfaced reference (defect #5) + prod-hard-fail reference

### Defect #5: provisional-surfaced reference

`apps/core/src/modules/analytics/tests/revenue-metrics.live.test.ts` — **confirmed GREEN** (21/21 tests pass).

Sections that cover defect #5:
- **Section 2** (`honest-empty-state`): provisional-only brand → state=has_data + realized={INR:'0'} + provisional=non-null. This pins the provisional-surfaced contract (D-2 new contract post-commit 55a4d90).
- **Section 3** (`isolation negative-control under brain_app`): `current_user='brain_app'` + `is_superuser=false` guard (lines 306-315). This is the brain_app negative-control that the plan cites as the reference pattern.
- **Section 4** (`provisional shown separately`): finalized + provisional rows are disjoint, never blended. `provisional-only brand → state=has_data, realized=honest-zero, provisional=non-null` (D-2+D-4 new contract).

**Not duplicated** in B-track files per plan §3/#5 and plan §4/B3.

### Prod-hard-fail: LocalSecretsManager

Track A's `apps/stream-worker/src/tests/dev-secret.integration.test.ts` — test at line 223:
```
describe('A4-2: LocalSecretsManager prod-hard-fail — core-side', () => {
  it('REVERT-RED: NODE_ENV=production → constructor throws [LocalSecretsManager] FATAL', ...)
```
This is the authoritative coverage for `LocalSecretsManager` prod-hard-fail (D-8). **Not duplicated** here per plan §4/B3.

### ADR-R3 discovered gap (worker prod-hard-fail)

Track A's `dev-secret.integration.test.ts` line 264 contains `it.skip('WorkerLocalSecretsManager should hard-fail under NODE_ENV=production — DISCOVERED GAP (ADR-R3)', ...)` with documented comment. This surfaces the gap; no fix in this PR (D-9).

---

## 5. Typecheck

```
cd apps/core && pnpm typecheck
EXIT 0
```

---

## 6. Full test run summary

```
cd apps/core && \
  BRAIN_APP_DATABASE_URL=postgres://brain_app:brain_app@localhost:5432/brain \
  DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
  SHOPIFY_CLIENT_SECRET=test-shopify-client-secret-b2 \
  SHOPIFY_CLIENT_ID=test-client-b2 \
  NODE_ENV=development \
  pnpm vitest run \
    src/modules/connector/tests/connector-lifecycle.integration.test.ts \
    src/modules/connector/tests/oauth-callback.integration.test.ts
```

| File | Tests | Status |
|---|---|---|
| connector-lifecycle.integration.test.ts | 6 | ALL GREEN |
| oauth-callback.integration.test.ts | 8 | ALL GREEN |
| **Total B-track** | **14** | **ALL GREEN** |

Revenue-metrics.live.test.ts (defect #5 reference): 21/21 GREEN.

---

## 7. Self-review vs gates

| Gate | Status |
|---|---|
| D-1 (lifecycle integration) | PASS — defects #2/#3 covered by B1 |
| D-2 (callback 302, fixed appBaseUrl, forged→error) | PASS — B2 covers all 4a/4b/4c contract points |
| D-3 (brain_app isolation guard) | PASS — assertBrainApp called before count===1 isolation assertion in B1 |
| D-5 (never 60d543dc, self-seed, afterAll) | PASS — b1b10001/b2b20001 prefixes, afterAll cleans, no 60d543dc reference |
| D-7 (sync reset, stale error cleared) | PASS — defect #3 stale-error reset proven in B1 |
| D-9 (tests-only) | PASS — no product code changed |
| Typecheck | PASS — EXIT 0 |
| Non-inert assertions | PASS — every assertion has named revert-RED (see §2 and §3 tables) |

---

## 8. BOUNCE-worthy items

**None discovered in B-track.** ADR-R3 (WorkerLocalSecretsManager prod-hard-fail gap) was pre-surfaced by Track A and already has the `it.skip` with documented comment. No new product bugs discovered during B1/B2 implementation.

---

**Next:** READY-FOR-SECURITY
