# Security Review — fix-connector-lifecycle-cleanup

| Field | Value |
|-------|-------|
| **req_id** | `fix-connector-lifecycle-cleanup` |
| **Stage** | 4 |
| **Mode** | FULL (retroactive — code live, small diff) |
| **Verdict** | PASS |
| **Reviewer** | Security Reviewer (Sonnet) |
| **Timestamp** | 2026-06-17T18:45:00Z |
| **Branch** | `fix/connector-lifecycle-cleanup` |
| **Files reviewed** | worker-secrets.ts · dev-secret.integration.test.ts · LocalSecretsManager.test.ts (new) · connector-lifecycle-fixtures.ts |

---

## Findings

**CRITICAL:** 0  
**HIGH:** 0  
**MED:** 0  
**LOW:** 0  
**Blocking:** 0

No findings. All checks PASS.

---

## Gate Checklist

### SEC-CLR-MED-01 — Guard mirrors core exactly (PASS)

- **Condition:** `process.env['NODE_ENV'] === 'production'` — identical to `LocalSecretsManager.ts:33`.
- **Throw message:** `[WorkerLocalSecretsManager] FATAL: must not be instantiated in production. Use AwsSecretsManager via buildWorkerSecretsManager().` — structurally equivalent to core's `[LocalSecretsManager] FATAL: ...` pattern. Both throw before any work.
- **Evidence:** `worker-secrets.ts:74-79` (guard) vs `LocalSecretsManager.ts:33-38` (mirror). Condition is identical; message follows the same `[ClassName] FATAL` convention.

### Prod path unaffected — `buildWorkerSecretsManager()` still routes to `AwsSecretsManager` in prod (PASS)

- `worker-secrets.ts:37`: `if (process.env['NODE_ENV'] === 'production') { ... return new AwsSecretsManager(...); }` — factory exits at line 46 before reaching the `WorkerLocalSecretsManager` instantiation at line 50.
- The new constructor guard is belt-and-suspenders only; the factory never reaches it in prod.
- The guard defends a direct-instantiation bypass (e.g. a future test or DI container `new WorkerLocalSecretsManager()`) — correct threat model.

### `export` of `WorkerLocalSecretsManager` — no new attack surface (PASS)

- The class was previously private to the module (unexported). It is now exported to allow the A4-3 test to `import` and verify the prod guard via `await import(...)`.
- Exporting a class does not change its runtime security behavior. The guard fires on construction regardless of import path.
- The `WorkerSecretsManager` interface (already exported) was the only surface callers needed; this export adds only testability.
- No new `require`/`import` path in production code — factory function is the sole composition root.

### No secret / PII in diff (PASS)

- Secret grep on the full diff: one hit — `shpat_test_local_secrets_write_path_xyz789` (LocalSecretsManager.test.ts:20). The `shpat_test_` prefix is the Shopify-documented synthetic test token prefix. No real credential shape (no 32-char alphanumeric without the `test_` infix, no AWS key, no private key material, no production UUID 60d543dc).
- `TEST_ACCESS_TOKEN = 'shpat_test_dev_secret_round_trip_token_abc123'` in dev-secret.integration.test.ts: pre-existing synthetic test value (unchanged from prior PASS review).
- PII check: no email, phone, name, or location data anywhere in the diff.

### Coverage preserved — core write + prod-hard-fail assertions still exist (PASS)

- The A4-2 describe block (core `LocalSecretsManager` prod-hard-fail) was removed from `dev-secret.integration.test.ts` and moved to `apps/core/.../secrets/LocalSecretsManager.test.ts` (new file, 83 lines).
- New file contains:
  - `REVERT-RED: NODE_ENV=production → constructor throws [LocalSecretsManager] FATAL` (line 62-71) — positive assertion, non-inert.
  - `non-production: constructor does NOT throw` (line 73-82) — negative control.
  - `storeShopifyToken persists the token to dev_secret; getShopifyToken reads it back` (lines 36-58) — write path + delete round-trip.
- Coverage is **preserved, not deleted**. The move is in-package (no cross-rootDir import).

### A4-3 test is now active and non-inert (PASS)

- Previously `it.skip(...)` with a documented discovered-gap comment.
- Now `it(...)` — active test. The test dynamically imports `WorkerLocalSecretsManager`, sets `NODE_ENV=production`, and asserts `toThrow(/WorkerLocalSecretsManager.*FATAL|must not be instantiated in production/i)`.
- **Revert-RED confirmed:** removing the guard at `worker-secrets.ts:74-79` → constructor does not throw → `toThrow()` assertion fails → RED. Test is genuinely non-inert.
- `finally` block restores `NODE_ENV` correctly in all branches (prev !== undefined restore; else delete).

### Worker test raw-SQL dev_secret write uses synthetic test values only (PASS)

- `TEST_ACCESS_TOKEN = 'shpat_test_dev_secret_round_trip_token_abc123'` — synthetic.
- `A4_BRAND_ID = 'a4000001-0a00-4a00-8a00-000000000001'` — test UUID, does not collide with 60d543dc or production data.
- Raw SQL `INSERT INTO dev_secret (name, secret_value) VALUES ($1, $2)` is parameterized — no injection risk.
- `beforeAll` / `afterAll` clean own `A4_BRAND_ID` namespace. `cleanupConnectorFixtures` called in `afterAll`.

### No touch to 60d543dc production brand (PASS)

- `git diff` output grepped for `60d543dc`: zero matches.

### No RLS / grants / isolation regression (PASS)

- Diff touches 0 migrations, 0 RLS policies, 0 GRANT statements, 0 product isolation logic.
- `assertBrainApp` guard in `connector-lifecycle-fixtures.ts` untouched.
- `connector-lifecycle-fixtures.ts` change is a TypeScript type-narrowing fix (`RequestInfo | URL` → `string | URL`, `as unknown as typeof fetch`) — no behavioral change, no new SQL, no isolation impact.

### Verification-validity check (PASS)

- A4-3 test runs under real (non-bypassed) `WorkerLocalSecretsManager` class via dynamic import of the actual module. No mock bypasses the guard.
- A4-1 cross-process read test: `buildWorkerSecretsManager()` is called with real `BRAIN_APP_DATABASE_URL` and `NODE_ENV` in non-production state; `SHOPIFY_ACCESS_TOKEN` override is deleted before the read to prevent path short-circuit. Negative control (after delete → `null`) is a distinct `it(...)` block with a `'NOT_NULL'` sentinel.
- Core `LocalSecretsManager.test.ts` prod-hard-fail: both positive (throws in prod) and negative (does not throw in test) branches present — non-inert pair.

---

## Scanners

**Mode:** FULL (retroactive small diff — no new deps, images, or IaC).

- **Secret scan:** Grep on full diff. One match: `shpat_test_local_secrets_write_path_xyz789` — synthetic test value (Shopify `shpat_test_` prefix). CLEAN.
- **Dependency audit:** No new npm packages introduced. Delta-skip full SCA re-run (no dep changes).
- **SAST (manual):** No injection paths (parameterized SQL throughout), no `eval`, no `innerHTML`, no plaintext secrets, no logging of token values. CLEAN.
- **IaC scan:** No IaC changes in diff. Delta-skip.
- **Container scan:** No Dockerfile or image changes. Delta-skip.
- **60d543dc grep:** Zero matches. CLEAN.

---

## Decision Log

| Finding | Severity | Status | Rationale |
|---------|----------|--------|-----------|
| (none) | — | — | — |

---

## Summary

The branch closes two tracked follow-ups from chore-connector-lifecycle-regression:

1. **SEC-CLR-MED-01 (product):** `WorkerLocalSecretsManager` constructor now throws under `NODE_ENV=production`, mirroring core's `LocalSecretsManager` guard exactly (same condition, same throw-before-any-work pattern). The factory `buildWorkerSecretsManager()` is unaffected — it routes to `AwsSecretsManager` before reaching the constructor. Exporting the class adds no new production surface. No secret or PII in the diff.

2. **QA-CLR-LOW-01 (tests):** Core write + prod-hard-fail assertions moved in-package to `LocalSecretsManager.test.ts` (no cross-rootDir import). Both assertion pairs verified present and non-inert. The A4-3 `it.skip` is now an active, passing, non-inert test. The fetch-stub type fix is a TypeScript-only narrowing change with no behavioral or security impact.

**Verdict: PASS. Blocking: 0.**
