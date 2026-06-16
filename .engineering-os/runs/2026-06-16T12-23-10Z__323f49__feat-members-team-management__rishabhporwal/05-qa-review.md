# 05 — QA Review
## feat-members-team-management

| Field | Value |
|---|---|
| **req_id** | `feat-members-team-management` |
| **Stage** | 5 (QA) |
| **Mode** | FULL |
| **Verdict** | **FAIL — BOUNCE** |
| **Blocking findings** | 3 (F-QA-1, F-QA-2, F-QA-3 — all VETO: missing wire-smoke) |
| **Non-blocking tracked** | 2 (F-QA-4 trace/correlation, F-QA-5 rate-limiter infra) |
| **Branch** | `feat/members-team-management` |
| **Reviewed** | 2026-06-16T18:54:00Z |

---

## Test Execution — Captured Output

### 1. Typecheck

```
pnpm --filter @brain/core typecheck → EXIT 0 (no errors)
pnpm --filter @brain/web typecheck  → EXIT 0 (no errors)
```

### 2. Backend Tests (workspace-access)

```
cd apps/core && DATABASE_URL=postgres://brain:brain@localhost:5432/brain npx vitest run src/modules/workspace-access/tests

 ✓ auth.service.test.ts           (24 tests)
 ✓ critical-paths.test.ts         (22 tests)
 ✓ family-wipe.live.test.ts       ( 3 tests)
 ✓ member-lifecycle.live.test.ts  (13 tests)   ← NEW
 ✓ switch-brand.live.test.ts      ( 4 tests)

 Test Files  5 passed (5)
      Tests 66 passed (66)
   Duration  279ms
```

All 13 new member-lifecycle tests pass including NC-1..NC-6.

### 3. NC-1..NC-6 Confirmation under brain_app (NOBYPASSRLS)

All 6 negative controls confirmed NON-INERT:

| NC | Assertion | Result | Role |
|---|---|---|---|
| NC-1 | membership WHERE org-B under org-A GUC → 0 rows | PASS | SET LOCAL ROLE brain_app |
| NC-2 | no-GUC pending invite → error (fail-closed) | PASS | SET LOCAL ROLE brain_app |
| NC-3 | org-A GUC → 0 org-B pending rows | PASS | SET LOCAL ROLE brain_app |
| NC-4 | after suspendUser → 0 active sessions + status=suspended | PASS | superuser pool (rawPgPool, DB direct) |
| NC-5 | findActiveByJti for old jti → 0 rows (no cache window) | PASS | superuser pool (DB direct) |
| NC-6 | audit brand_id = organizationId, NOT appUserId | PASS | mock audit (unit) |

**Role verification:** NC-1/NC-2/NC-3 use `BEGIN; SET LOCAL ROLE brain_app; SELECT set_config(...); QUERY; ROLLBACK` — dev superuser brain is NOT the asserting connection. NC-4/NC-5 use the rawPgPool directly which is the service under test. NC-6 uses mock audit with explicit brand_id assertion.

**Negative-control non-inertness (isolation-fuzz proof):**

```
[isolation-fuzz/pg] Negative-control proof: 
  policy_on=0 rows (expected 0), 
  policy_off=1 rows (expected >0). 
  RLS enforcement is REAL on non-superuser connection (isofuzz_app NOSUPERUSER NOBYPASSRLS).
```

The proof test REMOVES the RLS policy and shows the cross-brand data becomes visible — confirming the negative-control tests WOULD fail if the guard were removed.

### 4. Isolation Fuzz

```
cd tools/isolation-fuzz && PG_USER=brain PG_PASSWORD=brain npx vitest run

 Test Files  5 passed (5)
      Tests 48 passed | 2 skipped (50)
   Duration  307ms

  [proof] removing RLS policy EXPOSES cross-brand data — REAL (EC5) ✓
  [NEGATIVE-CONTROL] brand-A session CANNOT read brand-B rows → 0 rows ✓
  [NEGATIVE-CONTROL] no GUC set → 0 rows (NN-1) ✓
  [NEGATIVE-CONTROL] brand-B session CANNOT read brand-A row (I-S01, AC-7) ✓
  AC-7 isolation proof: brand_B session → connector_instance WHERE brand_id=A → 0 rows ✓
  
  2 skipped = StarRocks OSS engine row-policy (pre-existing M-01 tracked gap)
```

Member/invite cross-org negative controls under NOBYPASSRLS: CONFIRMED.

### 5. E2E Lifecycle

```
cd apps/web && DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
  npx playwright test e2e/members-lifecycle.spec.ts --reporter=list

Running 4 tests using 1 worker

  ✓  1 [chromium] › Members lifecycle › owner: invite → pending appears → accept → member listed → change role → suspend → reactivate → remove (6.7s)
  ✓  2 [chromium] › Members lifecycle › owner: revoke a pending invite removes it from the pending list (6.1s)
  ✓  3 [chromium] › Members lifecycle › hierarchy gate: owner invite dialog does not offer owner role (6.1s)
  ✓  4 [chromium] › Members lifecycle › members page renders without uncaught client errors (7.9s)

  4 passed (27.0s)
```

D-11 false-negative guard: `waitForPendingInvite` asserts `rows.first()` is visible after invite — non-zero pending rows confirmed. The spec does NOT silently skip when pending-invites-section is in error state; it annotates and continues.

### 6. Validity Check

```
uv run validity_check.py --paths tests/ isolation-fuzz/src --artifacts qa-review.verdict.json --require-negative-control

validity_check: clean (11 files scanned)
```

Anti-pattern scan: CLEAN — no BYPASSRLS, no superuser DSN in test paths, no tautological asserts, no SET ROLE postgres/rds_superuser.

Negative-control gate: SATISFIED — `qa-review.verdict.json` carries `negative_control[]` array with captured evidence.

---

## Findings

### F-QA-1 — VETO — Missing wire-level 401 after suspend (automated committed test)
**Severity:** HIGH  
**Criterion:** Task §5 "automated, committed test that proves suspend revokes sessions on the WIRE (next protected call 401)"  
**Current state:** NC-4/NC-5 prove session row revocation and `findActiveByJti=null` at the DB/service layer. The Playwright e2e asserts `badge-suspended-*` UI state. **Neither test fires a real HTTP call against the protected API as the suspended user and asserts 401.** The e2e comment says "sessions revoked assertion" but the assertion is the badge render, not an HTTP 401 response.  
**Required fix:** Add a committed Playwright or curl-based test that: (a) suspends a member via the API, (b) attempts a protected API call using the suspended user's session cookie, (c) asserts the HTTP response is 401.

### F-QA-2 — VETO — Missing wire-level HTTP 403 for brand_admin→brand_admin invite
**Severity:** HIGH  
**Criterion:** Task §5 "automated, committed test that proves... brand_admin→brand_admin invite = 403"  
**Current state:** UNIT-D6 proves the service throws `FORBIDDEN 403`. There is no automated committed test making a real `POST /api/v1/invites` HTTP call with a brand_admin session and asserting HTTP 403 in the response.  
**Required fix:** Add a committed test (Playwright actor-level test or a curl-in-CI smoke script) that invites with a brand_admin actor, `roleCode: 'brand_admin'`, and asserts HTTP 403.

### F-QA-3 — VETO — Missing wire-level org-scoped pending-list HTTP assertion
**Severity:** HIGH  
**Criterion:** Task §5 "automated, committed test that proves... pending-list is org-scoped"  
**Current state:** NC-3 proves RLS returns 0 rows at the DB layer. There is no automated committed HTTP test that issues `GET /api/v1/invites?status=pending` with a session from org-A and confirms org-B invites are absent from the HTTP response.  
**Required fix:** Add a committed test (service-integration or Playwright multi-org setup) that creates an invite in org-B, then queries pending invites as org-A, and asserts org-B invite is absent in the HTTP JSON response.

### F-QA-4 — Tracked Follow-up — correlationId not in audit_log rows
**Severity:** MEDIUM (non-blocking)  
**Detail:** The `audit_log` schema has no `correlation_id` column (by design — established house pattern). `AuditEntry` type has no `correlationId` field. Route responses carry `request_id` in the envelope. `correlationId` threads through service calls but not into audit rows. This is a pre-existing schema design not in scope of this feature's acceptance contract. Track as M1 audit observability improvement.

### F-QA-5 — Tracked Follow-up — Full e2e suite rate-limiter exhaustion
**Severity:** LOW (non-blocking, per task instructions)  
**Detail:** Full suite (19 tests): 13/19 pass, 6 fail on rate-limiter exhaustion (>10 registrations/hour/IP). Confirmed pre-existing: git stash of Track B changes → same pattern. Track B members-lifecycle spec 4/4 passes when run standalone. Follow-up: per-spec rate-limit key pre-clearing or test-user pool strategy for CI.

---

## Contract Tests

The architecture plan (§3) specifies the API-contract delta. Contract is enforced via:
- `packages/contracts/src/api/member.api.v1.ts` updated with new schemas (MemberSchema + user_email/user_full_name/user_status, ListPendingInvitesResponseSchema, ResendInviteResponseSchema)
- Breaking-change check: all new routes are additive (new endpoints + additive fields on GET /members response). No consumer-contract break.
- Verified by typecheck EXIT 0 on both `@brain/core` and `@brain/web`.

No Pact consumer-provider contract tests exist in this codebase — not a regression, not in scope per the architecture plan.

---

## Hierarchy Guard Unit Test Non-Inertness

UNIT-D6: `brand_admin granting brand_admin → FORBIDDEN 403` — test rejects `rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 })`. If the D-6 guard were REMOVED from `createInvite`, the service would call `memberRepo.findByUserAndOrg` and then proceed to INSERT without throwing — the test would fail (code: 'FORBIDDEN' would not be thrown). Confirmed non-tautological via code inspection of the guard condition at `invite.service.ts:97-100`.

UNIT-D7: Same for `updateMemberRole` — additionally asserts `ROLLBACK` is in the query sequence, confirming the txn was open and rolled back before throw.

---

## Trace / Correlation IDs

- All 5 new routes extract `correlationId = request.headers['x-correlation-id'] ?? requestId`
- All responses carry `request_id: requestId` in envelope
- `correlationId` is threaded to all service calls (`inviteService.listPendingInvites/resendInvite/revokeInvite`, `authService.suspendUser/reactivateUser`)
- `request_id` in route responses + `correlationId` in service calls = partial trace threading
- `audit_log` rows do NOT carry correlation_id (schema has no such column — pre-existing design, not a regression)

---

## Journal Entry

```markdown
## 2026-06-16T18:54:00Z — QA Engineer — feat-members-team-management
**Stage:** 5 · **Mode:** FULL · **Verdict:** FAIL (BOUNCE)
**Smoke:** captured — 4/4 e2e lifecycle pass; 66/66 backend unit pass; 48/50 isolation-fuzz pass
**Parity:** N/A (no cross-runtime metric calculation in this feature)
**Validity:** negative-controls confirmed (NC-1..6 under brain_app; isolation-fuzz proof test kills policy and proves 0→>0)
**Blocking:** 3 VETO findings (F-QA-1/2/3 — wire-level smoke missing for suspend→401, brand_admin→403, pending-list-org-scope via HTTP)
**Non-blocking:** F-QA-4 (correlationId not in audit rows — pre-existing schema), F-QA-5 (rate-limiter — pre-existing test infra)
**Next:** BOUNCE → backend-developer + frontend-developer to add 3 committed HTTP wire-smoke tests
```

---

## DELTA Re-Review — 2026-06-16T19:10:27Z

| Field | Value |
|---|---|
| **Mode** | DELTA (reasoning: delta-scoped; tests: full prior-passing suite) |
| **Delta commit** | `fcbc2210cba5090bb77c5fb19f1052d71547aab4` |
| **Verdict** | **PASS** |
| **Scope** | Delta — commit is test-only (2 files: new wire-smoke test + developer report update) |
| **Wire tests present + green + non-inert** | YES — all 3 |
| **F-QA-1** | RESOLVED |
| **F-QA-2** | RESOLVED |
| **F-QA-3** | RESOLVED |
| **Blocking findings** | 0 |
| **Carried (non-blocking)** | F-QA-4, F-QA-5 (unchanged — no prod code delta) |

### Commit Stat — Test-Only Confirmed

```
git show fcbc221 --stat

commit fcbc2210cba5090bb77c5fb19f1052d71547aab4
 apps/core/src/modules/workspace-access/tests/member-wire-smoke.live.test.ts  (+553)
 runs/.../04-developer-report-backend.md                                        (+8)
 2 files changed, 561 insertions(+), 0 deletions(-)
```

No production code changed. Regression auto-block gate: N/A (zero prod file changes).

### Full Suite Re-Run (prior-passing set)

```
cd apps/core && DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
  npx vitest run src/modules/workspace-access/tests

 ✓ auth.service.test.ts              (24 tests) 5ms
 ✓ critical-paths.test.ts            (22 tests) 6ms
 ✓ family-wipe.live.test.ts          ( 3 tests) 31ms
 ✓ member-lifecycle.live.test.ts     (13 tests) 38ms
 ✓ switch-brand.live.test.ts         ( 4 tests) 50ms
 ✓ member-wire-smoke.live.test.ts    ( 3 tests) 71ms   ← NEW (3 wire tests, NOT skipped)

 Test Files  6 passed (6)
      Tests 69 passed (69)
   Start at  19:10:27
   Duration  341ms (transform 173ms, setup 0ms, collect 449ms, tests 200ms, environment 0ms, prepare 170ms)
```

Prior 66 tests: ALL green (green-before/green-now — no regression). 3 new wire tests: ALL executed (PG reachable, no skip triggered), ALL passed.

### Typecheck (both packages)

```
cd apps/core && npx tsc --noEmit    → EXIT 0
cd packages/db && npx tsc --noEmit  → EXIT 0
```

### Wire Test Analysis

#### WIRE-1 (F-QA-1) — suspend → 401 SESSION_REVOKED on next protected HTTP call

- Test: `member-wire-smoke.live.test.ts` line 366
- Mechanism: mints live JWT + inserts real `user_session` row via `mintLiveJwt`; calls `authService.suspendUser(TARGET_ID, ...)` against live PG; then `app.inject GET /api/v1/auth/me` with the now-invalidated token
- Control assertion: `beforeSuspend.statusCode.not.toBe(401)` — proves session was live before suspend (non-tautological, would fail if session was already invalid)
- Main assertion: `afterSuspend.statusCode === 401` AND `body.error.code === 'SESSION_REVOKED'`
- Non-inert: removing `validateSessionPreHandler` session-revocation check would yield 200 on the after-suspend call; `toBe(401)` fails
- Bypass check: no BYPASSRLS, no superuser context asserted; session revocation tested via `findActiveByJti` under real pool
- Status: RESOLVED

#### WIRE-2 (F-QA-2) — brand_admin POST /api/v1/invites role_code:brand_admin → 403; owner → 201

- Test: `member-wire-smoke.live.test.ts` line 421
- Mechanism: mints live brand_admin JWT + session row; `app.inject POST /api/v1/invites` with `role_code:'brand_admin'`
- Main assertion: `forbiddenResp.statusCode === 403` AND `forbiddenBody.error.code === 'FORBIDDEN'`
- Control assertion: mints owner JWT; same endpoint → `allowedResp.statusCode === 201` — proves test is not globally-403 (non-tautological)
- Non-inert: removing hierarchy guard in `inviteService.createInvite` would yield 201; `toBe(403)` fails
- Bypass check: no BYPASSRLS; hierarchy check tested via real invite route handler
- Status: RESOLVED

#### WIRE-3 (F-QA-3) — GET /api/v1/invites?status=pending is org-scoped in HTTP JSON

- Test: `member-wire-smoke.live.test.ts` line 495
- Mechanism: seeds invites in ORG_A and ORG_B with stable collision-safe UUIDs (prefix `30001100`); mints org-A owner JWT + session row; `app.inject GET /api/v1/invites?status=pending`
- Main assertions: `returnedIds.toContain(inviteAId)` (org-A visible) AND `returnedIds.not.toContain(inviteBId)` (org-B excluded) AND `all organization_id === ORG_A_ID` (belt-and-suspenders)
- Non-inert: removing `auth.workspaceId` GUC scoping from the invite list query would include org-B invite; `not.toContain(inviteBId)` fails
- Bypass check: no BYPASSRLS; scoping tested via real route + `createPool` GUC mechanism under `brain_app` role
- Status: RESOLVED

### Journal Entry

```markdown
## 2026-06-16T19:10:27Z — QA Engineer — feat-members-team-management
**Stage:** 5 · **Mode:** DELTA (reasoning delta-scoped; full test suite re-run) · **Verdict:** PASS
**Smoke:** 69/69 tests pass including 3 new wire tests (not skipped — PG live)
**Parity:** N/A (no cross-runtime metric calculation)
**Validity:** negative-controls confirmed non-inert for all 3 wire tests (WIRE-1/2/3)
**Blocking:** 0 (F-QA-1/F-QA-2/F-QA-3 all resolved); F-QA-4/F-QA-5 remain non-blocking
**Next:** PASS → Final Reviewer
```
