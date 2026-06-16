# 05 — QA Review
## feat-multi-brand — Stage 5 QA

**authored_at:** 2026-06-16T10:26:00Z
**authored_by:** qa-agent (Stage 5)
**req_id:** feat-multi-brand
**mode:** FULL
**verdict:** FAIL (blocking: QA-1 — missing repeatable automated smoke for set-brand wire path)

---

## Required-Test Checklist (§7)

| Check | Status | Evidence |
|---|---|---|
| Typecheck @brain/core | PASS | EXIT 0, no output |
| Typecheck @brain/web | PASS | EXIT 0, no output |
| Backend unit tests (43 total) | PASS | 43 passed, 0 failed |
| expiresIn=3600 assertion green | PASS | critical-paths.test.ts:143 green (was previously failing on 900 vs 3600) |
| Isolation-fuzz AC-7 (11 total) | PASS | 11 passed, 0 failed; NOSUPERUSER NOBYPASSRLS role; negative controls confirmed |
| Real-network smoke (set-brand end-to-end) | EXECUTED-MANUALLY | See §Smoke below — passes on wire but NO automated/repeatable test exists |
| Negative paths (4): archived→400, non-member→403, null-workspace→400, revoked→401 | PARTIAL | archived/non-member/revoked proven on wire; null-workspace only code-confirmed (no auto test) |
| Trace/correlation IDs end-to-end | GAP | correlationId flows through QueryContext but is NOT stored in audit_log rows |
| Playwright E2E (brand-switcher UI) | NOT RUN | No browser env in session; dashboard.spec.ts does not cover brand-switch flow |

---

## Commands Run + Output

### 1. Typecheck @brain/core
```
pnpm --filter @brain/core typecheck
> @brain/core@0.0.0 typecheck
> tsc --noEmit
[EXIT 0 — no output]
```

### 2. Typecheck @brain/web
```
pnpm --filter @brain/web typecheck
> @brain/web@0.0.0 typecheck
> tsc --noEmit
[EXIT 0 — no output]
```

### 3. Backend unit/live tests
```
cd apps/core && DATABASE_URL=postgres://brain:brain@localhost:5432/brain npx vitest run src/modules/workspace-access/tests

RUN  v2.1.9 /Users/rishabhporwal/Desktop/Brain V3/apps/core
 ✓ src/modules/workspace-access/tests/auth.service.test.ts (24 tests) 5ms
 ✓ src/modules/workspace-access/tests/critical-paths.test.ts (16 tests) 5ms
 ✓ src/modules/workspace-access/tests/family-wipe.live.test.ts (3 tests) 31ms
 Test Files  3 passed (3)
      Tests  43 passed (43)
   Start at  10:25:18 / Duration 228ms
```

### 4. Isolation-fuzz AC-7
```
cd tools/isolation-fuzz && PG_USER=brain PG_PASSWORD=brain npx vitest run src/pg.test.ts

 ✓ Postgres RLS — Layer (a) isolation-fuzz (NN-2) > SKIP_IF_NO_PG
 ✓ [positive] brand-A session reads brand-A rows (RLS not over-blocking)
 ✓ [NEGATIVE-CONTROL] brand-A session CANNOT read brand-B rows → 0 rows (I-S01)
 ✓ [NEGATIVE-CONTROL] no GUC set → 0 rows (two-arg current_setting NN-1)
 ✓ [NEGATIVE-CONTROL] cross-brand full-scan returns 0 rows for wrong brand GUC
 ✓ [proof] removing RLS policy EXPOSES cross-brand data — negative control is REAL (EC5)
 ✓ AC-7 > SKIP_IF_NO_PG
 ✓ [positive] brand-B session reads brand-B row from `brand` (brand_self_read not over-blocking)
 ✓ [NEGATIVE-CONTROL] brand-B session CANNOT read brand-A row from `brand` — 0 rows (I-S01, AC-7)
 ✓ [NEGATIVE-CONTROL] no-GUC session returns 0 brands from brand_self_read (NN-1, AC-7)
 ✓ [positive] brand_self_read lists BOTH brand-A and brand-B for the fuzz user (switcher data)
 Tests  11 passed (11)
 
stdout: [isolation-fuzz/pg] Negative-control proof: policy_on=0 rows (expected 0), policy_off=1 rows (expected >0). RLS enforcement is REAL on non-superuser connection (isofuzz_app NOSUPERUSER NOBYPASSRLS).
stdout: [isolation-fuzz/brand-switch] AC-7 isolation proof: brand_B session → connector_instance WHERE brand_id=A → 0 rows (expected 0). brand_isolation (0004) enforces cross-brand connector isolation under NOBYPASSRLS role.
```

### 5. Real-network smoke (QA-executed, manually, against live :3001 server)

Server: localhost:3001 (confirmed UP: `{"status":"ok","version":"0.1.0","timestamp":"2026-06-16T06:14:43.200Z"}`)
Postgres: Docker brainv3-postgres-1 (UP, healthy)

Setup: registered qa-smoke-brand@example.com, created 2 brands (Brand Alpha + Brand Beta), inserted org+brand memberships via psql.

**set-brand to Brand A (owner):**
```
POST /api/v1/bff/session/set-brand {"brand_id":"ba000001-0001-0001-0001-000000000001"}
→ HTTP 200 {"request_id":"...","auth":{"brand_id":"ba000001-0001-0001-0001-000000000001","workspace_id":"f211262c-20a9-42cb-b52c-c323038adce6","role":"owner"}}
```

**set-brand to Brand B (analyst, from Brand A session):**
```
POST /api/v1/bff/session/set-brand {"brand_id":"bb000002-0002-0002-0002-000000000002"}
→ HTTP 200 {"request_id":"835c4ce6-...","auth":{"brand_id":"bb000002-0002-0002-0002-000000000002","workspace_id":"f211262c-20a9-42cb-b52c-c323038adce6","role":"analyst"}}
PASS: brand_id=BRAND_B in JWT. PASS: role=analyst (brand-level row, not org-level owner — MA-03 confirmed)
```

**brand-summary with Brand B session:**
```
GET /api/v1/dashboard/brand-summary
→ {"data":{"org_name":"QA Smoke Workspace","active_brand_id":"bb000002-0002-0002-0002-000000000002","brand_count":2,"member_count":1,"brands":[{"id":"ba000001...","display_name":"QA Brand Alpha","status":"active"},{"id":"bb000002...","display_name":"QA Brand Beta","status":"active"}]}}
PASS: active_brand_id=BRAND_B. brand-scoped member_count=1.
```

**Audit row in DB:**
```sql
SELECT action, actor_id, payload FROM audit_log WHERE action = 'brand.switch' ORDER BY created_at DESC LIMIT 2;
→ brand.switch | cddd0300... | {"to_brand_id": "bb000002...", "role_granted": "analyst", "workspace_id": "f211262c...", "from_brand_id": "ba000001..."}
→ brand.switch | cddd0300... | {"to_brand_id": "ba000001...", "role_granted": "owner", "workspace_id": "f211262c...", "from_brand_id": null}
```

### 6. Negative paths (live wire)

**archived → 400 BRAND_ARCHIVED:**
```
POST /api/v1/bff/session/set-brand {"brand_id":"bc000003..."}
→ HTTP 400 {"error":{"code":"BRAND_ARCHIVED","message":"Cannot switch to an archived brand."}}
PASS
```

**non-member → 403 FORBIDDEN:**
```
POST /api/v1/bff/session/set-brand {"brand_id":"de000000..."}
→ HTTP 403 {"error":{"code":"FORBIDDEN","message":"Not a member of the requested brand."}}
PASS
```

**revoked session → 401 SESSION_REVOKED:**
```
[revoked JTI via DB] POST /api/v1/bff/session/set-brand (revoked session cookie)
→ HTTP 401 {"error":{"code":"SESSION_REVOKED","message":"Session has been revoked."}}
PASS
```

**null workspace → 400 MISSING_WORKSPACE (code-confirmed only):**
Not exercised by live wire. Login JWTs always have workspace_id because findActiveByUser resolves it. Code at bff.routes.ts:376 is present and correct. No automated unit test covers this guard on the new set-brand route.

---

## Findings

### QA-1 (HIGH) — Missing repeatable automated smoke for set-brand wire path
Architecture plan §7 mandates "an integration test against a live brain_app-role Postgres." The developer report shows one-off curl proofs only. No test file in the repository exercises the end-to-end set-brand wire path repeatably in CI. VETO: this is an explicit QA VETO criterion per role definition.

Required fix: Add a live integration test (like family-wipe.live.test.ts pattern) under `apps/core/src/modules/workspace-access/tests/switch-brand.live.test.ts` that: creates a 2-brand user → calls switchBrandContext() → asserts returned context has brandId=B and role=analyst → confirms audit row written. Can skip gracefully if DATABASE_URL unreachable.

### QA-2 (MED) — switchBrandContext has 0% unit test coverage
No unit test invokes switchBrandContext() or stubs its dependencies. The method enforces MA-01/02/03/09/10/11 and is a high-stakes auth path. Coverage target for critical auth paths is >95%.

Required fix: Add at minimum: (a) non-member → throws FORBIDDEN, (b) archived → throws BRAND_ARCHIVED, (c) MA-03 role-from-brand-row vs org-row, (d) MA-01 direct mint not refreshSession, (e) MA-09 audit written after successful switch.

### QA-3 (MED) — correlationId not stored in audit_log rows
`audit_log` has no correlation_id column. The AuditEntry interface does not include it. Brand.switch audit rows cannot be correlated to a specific request in the system-of-record. The §7 trace-ID threading claim holds only at the GUC/logging level, not in the append-only audit trail.

Not a blocking VETO since the system-of-record doesn't structurally require correlationId in audit rows per the current schema, and the request_id appears in the HTTP response. But noted as a gap for future incident reconstruction.

### QA-4 (LOW) — AC-7 brand-table assertion is non-assertive (expect >=0)
`expect(brandRowCount).toBeGreaterThanOrEqual(0)` is a tautology on an unsigned count. The design intent is correct (brand_self_read ORs, brand rows ARE readable in switcher), but the assertion form provides zero protection. The real isolation assertion on connector_instance is correct.

### QA-5 (INFO) — Frontend Playwright E2E not run
brand-switcher.tsx and create-brand-dialog.tsx not exercised by any test. data-testid attributes are present and documented. Orchestrator Playwright suite is the contracted gate.

---

## Acceptance Criteria Disposition

| MA | Status | Verified by |
|---|---|---|
| MA-01: direct mint, no refreshSession | PASS | grep proof + live wire MA-03 role check |
| MA-02: workspaceId from JWT | PASS | code review bff.routes.ts:376-380 |
| MA-03: role from brand-level row | PASS | live smoke: org owner + brand analyst → returns analyst |
| MA-04: 0013 migration | PASS | isolation-fuzz AC-7 passes against live DB |
| MA-05: sessionPreHandler on set-brand | PASS | revoked session → 401 on wire |
| MA-06: active_brand_id in brand-summary | PASS | live smoke GET brand-summary → active_brand_id=B |
| MA-07: M1 invariant comment | PASS | code review (developer report §2) |
| MA-09: brand.switch audit | PASS | live DB SELECT audit_log |
| MA-10: archived → 400 | PASS | live wire |
| MA-11: no brandId in memberCtx | PASS | code review auth.service.ts:648 |
| MA-12: primary-node comment | PASS | code review |
| MA-13: findActiveByUser doc | PASS | code review |
| AC-7: isolation-fuzz passes | PASS | 11 tests green, negative controls confirmed |

---

## Verdict: FAIL

Blocking finding: QA-1 (HIGH) — The §7 mandatory real-network smoke requirement specifies an automated/repeatable integration test. Only manual one-off curl proofs exist in the developer report, and no automated test file in the repo covers the set-brand end-to-end wire path. This is an explicit VETO criterion.

Secondary blocking consideration: QA-2 (MED) — 0% unit coverage on a high-stakes auth method (switchBrandContext) is below the >95% critical-path target. Non-blocking alone but reinforces the bounce.

Non-blocking findings: QA-3 (MED, deferred — audit schema change is a separate migration concern), QA-4 (LOW), QA-5 (INFO).

**Bounce target: backend-engineer (Track A)** — Add switch-brand.live.test.ts + switchBrandContext unit tests before re-handoff to QA.

---

## DELTA Re-review — 2026-06-16T10:47:00Z (QA Engineer, Stage 5, Bounce r1)
**scope:** delta (reasoning) — full prior-passing test set re-run (tests not scoped)
**verdict:** PASS
**commit under review:** bcfee81

### Tests Re-Run (FULL prior-passing set + new tests)

| Command | Result | Tests |
|---|---|---|
| `DATABASE_URL=... npx vitest run src/modules/workspace-access/tests/switch-brand.live.test.ts --reporter=verbose` | PASS | 4/4 |
| `DATABASE_URL=... npx vitest run src/modules/workspace-access/tests` | PASS | 53/53 |
| `PG_USER=brain PG_PASSWORD=brain npx vitest run src/pg.test.ts` | PASS | 11/11 |
| `pnpm --filter @brain/core typecheck` | EXIT 0 | — |
| `pnpm --filter @brain/web typecheck` | EXIT 0 | — |

No regressions: all previously-green tests remain green. No test was green-before / red-now.

### QA-1 — RESOLVED (HIGH)

`switch-brand.live.test.ts` exists, runs against real Postgres (`postgres://brain:brain@localhost:5432/brain`), and all 4 tests executed without silent skip. Verbose output shows all 4 named tests ran: LIVE-SB-1, LIVE-SB-2, [NEGATIVE] LIVE-SB-3, [NEGATIVE] LIVE-SB-4. No `[SKIP]` console.warn emitted — Postgres was available and assertions actually ran.

**Non-inert confirmation:** The SKIP_IF_NO_PG guard (early-return pattern inside each `it()` when `!rawPool || !authService`) did not fire. Duration 48ms confirms real DB round-trips.

**Negative controls confirmed:**
- LIVE-SB-3 asserts `error.code === 'BRAND_ARCHIVED'` — removing the archived guard would cause this test to fail (no error thrown → expect().toBeDefined() fails).
- LIVE-SB-4 asserts `error.code === 'FORBIDDEN'` — removing the membership guard would cause this test to fail (method proceeds to mint token instead of throwing).

### QA-2 — RESOLVED (MED)

6 new `switchBrandContext` unit tests in `critical-paths.test.ts` under `QA-2: switchBrandContext — unit coverage` describe block. All are non-tautological:
- MA-01: asserts `accessToken` is truthy AND that no `user_session`/`family_id` SQL query was issued (proving direct mint, not refreshSession).
- MA-02: asserts `context.workspaceId === ORG_ID` (the arg, not a re-read).
- MA-03: asserts `context.role === 'analyst'` from the brand-level membership row stub.
- MA-09: asserts `audit.append` called once, `action==='brand.switch'`, and exact payload fields `from_brand_id/to_brand_id/workspace_id/role_granted` match spec values.
- MA-10 [NEGATIVE]: archived brand stub → asserts `AuthError` with `code==='BRAND_ARCHIVED'` and `statusCode===400`.
- non-member [NEGATIVE]: 0 membership rows → asserts `AuthError` with `code==='FORBIDDEN'` and `statusCode===403`; additionally asserts `audit.append` was NOT called.

Total suite: 53 passed (53), 0 failed. The prior failure at critical-paths.test.ts:143 (expiresIn=900 vs 3600) is confirmed resolved — all 22 critical-paths tests pass.

### QA-4 — RESOLVED (LOW)

`pg.test.ts` line 600: `expect(brandRowCount, '...').toBeGreaterThan(0)` — confirmed by grep. Tautological `toBeGreaterThanOrEqual(0)` is gone. Assertion is now protective: if `brand_self_read` policy (0013) were dropped, `brandRowCount` would be 0 and the test would fail. 11/11 isolation-fuzz tests pass.

### QA-3 — Confirmed Deferred (MED)

`correlationId` not stored in `audit_log` rows. Requires a schema migration (`audit_log.correlation_id` column), `AuditEntry` interface update, and `DbAuditWriter.append()` update. Deferred out of this slice per engineering-os change-control. Tracked as tech-debt. Not blocking.

### Findings Summary

| ID | Severity | Status |
|---|---|---|
| QA-1 | HIGH | RESOLVED |
| QA-2 | MED | RESOLVED |
| QA-3 | MED | DEFERRED (tech-debt, not blocking) |
| QA-4 | LOW | RESOLVED |
| QA-5 | INFO | OPEN (no browser env — not blocking) |

**Blocking findings: 0**

### Verdict: PASS

All three blocking items from the original FAIL are resolved and verified by running the actual commands and capturing output. No regressions detected.

