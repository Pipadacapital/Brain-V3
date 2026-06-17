# Stage 4 — Security Review
## chore-connector-lifecycle-regression

| Field | Value |
|---|---|
| **req_id** | `chore-connector-lifecycle-regression` |
| **Reviewed at** | 2026-06-17T18:00:00Z |
| **Reviewer** | security-reviewer (Sonnet 4.6) |
| **Mode** | FULL (first review, high_stakes lane) |
| **Branch** | `chore/connector-lifecycle-regression` |
| **Verdict** | **PASS** |
| **Findings** | 0 CRIT / 0 HIGH / 1 MED (ADR-R3 tracked) / 0 LOW |
| **Blocking** | 0 |

---

## 1. Scope

Tests-only regression suite (D-9). No product code changed. Security focus:
1. Non-inert isolation/negative-control tests (assertBrainApp discipline)
2. No secrets/PII in fixtures
3. Data-safety: never mutate Boddactive brand 60d543dc
4. No product code change
5. ADR-R3 severity and follow-up

---

## 2. D-9 Verification: No Product Code Change

**CONFIRMED.** The diff (8 changed `apps/` files) is confined exclusively to:
- `apps/core/src/modules/connector/tests/connector-lifecycle.integration.test.ts` (new)
- `apps/core/src/modules/connector/tests/oauth-callback.integration.test.ts` (new)
- `apps/stream-worker/src/tests/dev-secret.integration.test.ts` (new)
- `apps/stream-worker/src/tests/helpers/connector-lifecycle-fixtures.ts` (new)
- `apps/stream-worker/src/tests/shopify-pagination.integration.test.ts` (new)
- `apps/stream-worker/src/tests/sync-status-currency.integration.test.ts` (new)
- `apps/stream-worker/src/tests/worker-guc.integration.test.ts` (new)
- `apps/web/e2e/connector-lifecycle.spec.ts` (new)

No `db/migrations/`, no `packages/`, no product `src/` files outside `tests/` and `e2e/` changed. PASS.

---

## 3. Non-Inert Negative Control Verification (The #1 Risk)

### 3.1 assertBrainApp Primitive

The `assertBrainApp` helper in `apps/stream-worker/src/tests/helpers/connector-lifecycle-fixtures.ts:271-278` executes:
```sql
SELECT current_user,
       (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser
```
And asserts `current_user === 'brain_app'` AND `is_superuser === false`. This is the exact pattern from `revenue-metrics.live.test.ts:306-315`.

### 3.2 Coverage of Every Isolation Assertion

| Test file | Pool used for isolation assertions | assertBrainApp called? | Isolation assertions |
|---|---|---|---|
| `worker-guc.integration.test.ts` | `appPool` = `BRAIN_APP_DATABASE_URL` | YES — every `describe` block (A2-0, A2-1, A2-2, A2-3) | NIL-uuid positive, empty-string 22P02 revert-RED, cross-brand count===0, no-GUC fail-closed |
| `sync-status-currency.integration.test.ts` | `appPool` = `BRAIN_APP_DATABASE_URL` | YES — A3-1 top + cross-brand block | sync-status UPDATE under brain_app+GUC; cross-brand count===0 |
| `connector-lifecycle.integration.test.ts` (B1) | `appPool` = `BRAIN_APP_DATABASE_URL` | YES — before count===1 isolation assertion | single-sync-row count under brain_app+GUC |

**Seed/teardown only uses `superPool` = `DATABASE_URL` (brain superuser). Isolation assertions use `appPool` = `BRAIN_APP_DATABASE_URL` exclusively.** CONFIRMED — no isolation test runs under the dev superuser `brain`.

### 3.3 Revert-RED Non-Inertia Spot-Check

**Cross-brand isolation (A2-3):** `apps/stream-worker/src/tests/worker-guc.integration.test.ts:232-266` — Brand B GUC queries Brand A's `connector_instance`, expects `count === 0`. Revert: DROP FORCE RLS policy → count > 0 → RED. Test uses `appPool` (brain_app NOBYPASSRLS). GENUINELY NON-INERT.

**NIL-uuid revert-RED (A2-2):** `worker-guc.integration.test.ts:155-197` — Sets `current_user_id=''` (empty string), executes the same SELECT, asserts `pgErrorCode === '22P02'`. This is the explicit revert simulation. Runs under `appPool`. GENUINELY NON-INERT.

**No-GUC fail-closed (A2-3, last test):** `worker-guc.integration.test.ts:269-304` — no GUC set; asserts `count === 0` OR `22P02`. Catches both valid fail-closed outcomes. Runs under `appPool`. GENUINELY NON-INERT.

---

## 4. No Secrets/PII in Fixtures

### 4.1 HMAC Client Secret (OAuth Callback Test — Critical Check)

`apps/core/src/modules/connector/tests/oauth-callback.integration.test.ts:70`:
```typescript
const TEST_CLIENT_SECRET = 'test-shopify-client-secret-b2';
```

This is a **synthetic test value** (`test-shopify-client-secret-b2`), NOT a real Shopify client secret. The test sets `process.env['SHOPIFY_CLIENT_SECRET'] = TEST_CLIENT_SECRET` in `beforeAll` and deletes it in `afterAll`. The HMAC is computed with this synthetic value — no real secret committed. PASS.

### 4.2 Shopify Access Token

`apps/stream-worker/src/tests/dev-secret.integration.test.ts:58`:
```typescript
const TEST_ACCESS_TOKEN = 'shpat_test_dev_secret_round_trip_token_abc123';
```

The pattern `shpat_test_` is unmistakably synthetic (real Shopify tokens are `shpat_` followed by 64 hex characters; this is 36 non-hex chars). Not a real credential. PASS.

### 4.3 ARN Patterns

Seed functions use `arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopify/...` — account ID is `000000000000` (obviously synthetic). PASS.

### 4.4 PII Check

No real customer data, real emails, real phone numbers, or real order data in any fixture. The 600-order fake store contains:
- `customer: null`
- `financial_status: 'paid'`
- `gateway: 'razorpay'`
- Synthetic price `'1000.00'`

No PII fields populated. PASS.

---

## 5. Data Safety: Never Touch 60d543dc

**Grep result:** All 7 occurrences of `60d543dc` in the diff are comments explicitly stating "NEVER 60d543dc-*" — the UUID appears zero times in SQL WHERE clauses, seed calls, or query parameters. PASS.

**Seed brand UUIDs used:**
- A-track shared: `c07ec701-...`, `c07ec702-...`, `c07ec7c1-...`
- A2-private: `a2000001-...`, `a2000002-...`, `a2000003-...`
- A3-private: `a3000001-...`, `a3000002-...`, `a3000003-...`, `c07ec703-...`
- A4-private: `a4000001-...`
- B1-private: `b1b10001-...`, `b1b10002-...`, `b1b1c001-...`
- B2-state-only: `b2b20001-...` (no DB writes in B2)
- C-track: fresh ephemeral brand from `onboardToDashboard()`

All `afterAll` cleanup confirmed in every test file. PASS.

---

## 6. ADR-R3 Severity Assessment: WorkerLocalSecretsManager Missing Prod Guard

**Finding:** `WorkerLocalSecretsManager` (`apps/stream-worker/src/jobs/shopify-backfill/worker-secrets.ts:69`) has no `NODE_ENV=production` constructor guard. `buildWorkerSecretsManager()` (line 37) correctly routes to `AwsSecretsManager` in prod — but the class itself is directly instantiable without throwing.

**Severity: MED (not blocking this suite)**

Rationale:
1. `buildWorkerSecretsManager()` is the only production path — it branches to `AwsSecretsManager` in prod. No production code directly instantiates `WorkerLocalSecretsManager`.
2. The class is today only directly-instantiable in tests (the test suite itself proves this by importing it for the `it.skip`).
3. A future refactor or DI container wiring could instantiate it directly in prod — that is the real risk.
4. `LocalSecretsManager` (core) DOES have the guard — this is an asymmetry, not a production path gap today.
5. D-9 correctly blocks fixing it here; the `it.skip` at `dev-secret.integration.test.ts:265-308` is honest with a complete documented bug comment and a ready-to-use assertion.

**This does NOT block this tests-only suite.** The real prod-safety guard (the `buildWorkerSecretsManager` factory branching) is present and tested. The gap is a latent risk for a future refactor.

**Recommendation:** File as a separate product requirement immediately after this suite ships. The fix is:
```typescript
// in WorkerLocalSecretsManager constructor (worker-secrets.ts:69)
if (process.env['NODE_ENV'] === 'production') {
  throw new Error('[WorkerLocalSecretsManager] FATAL: must not be instantiated in production. Use buildWorkerSecretsManager().');
}
```
The `it.skip` in A4 already contains the test assertion — the fix unlocks it in one line.

**Tracked as:** SEC-CLR-MED-01 (open, follow-up product PR required).

---

## 7. Findings Summary

| ID | Severity | Finding | Status | Blocking |
|---|---|---|---|---|
| SEC-CLR-MED-01 | MED | WorkerLocalSecretsManager lacks NODE_ENV=production guard; class directly instantiable in prod without throwing (latent risk; factory branching is the real prod-safety gate today) | Open, follow-up PR; it.skip in suite is honest | No |

**CRITICAL: 0 | HIGH: 0 | MED: 1 (tracked, non-blocking) | LOW: 0**

---

## 8. Verification Gates

| Gate | Result | Evidence |
|---|---|---|
| D-3: all isolation under brain_app + assertBrainApp | PASS | Every isolation describe block calls assertBrainApp first; appPool = BRAIN_APP_DATABASE_URL; superPool only for seed/teardown |
| D-5: no 60d543dc reference | PASS | grep: 0 hits in SQL/seed calls; all 7 occurrences are "NEVER" comments |
| D-9: no product code change | PASS | All 8 changed apps/ files are test/e2e/fixtures paths; 0 migrations, 0 product src/ changes |
| ADR-R3: it.skip honest | PASS | it.skip with documented bug comment at dev-secret.integration.test.ts:265; no fix attempted |
| No real secrets in fixtures | PASS | TEST_CLIENT_SECRET='test-shopify-client-secret-b2' (synthetic); TEST_ACCESS_TOKEN='shpat_test_...' (synthetic); all ARNs use account 000000000000 |
| No PII in fixtures | PASS | customer:null; no emails, phones, addresses in fake orders |
| afterAll cleanup present | PASS | Every test file has afterAll that deletes seeded rows via superPool |
| HMAC reads secret from env | PASS | process.env['SHOPIFY_CLIENT_SECRET'] set in beforeAll, deleted in afterAll; synthetic value only |
| Verification-validity: negative controls are real | PASS | Empty-string 22P02 revert-RED proven explicit; cross-brand count===0 runs under brain_app NOBYPASSRLS; no bypass-green inert probe |

---

## 9. Verdict

**PASS.** No CRITICAL, no HIGH, no compliance violation. The one MED finding (ADR-R3) is a latent product gap correctly handled per D-9 with an honest `it.skip` and a documented follow-up requirement. The isolation/negative-control discipline (assertBrainApp) is correctly applied to every isolation assertion. No real secrets, no real PII, no production brand touched, no product code changed.
