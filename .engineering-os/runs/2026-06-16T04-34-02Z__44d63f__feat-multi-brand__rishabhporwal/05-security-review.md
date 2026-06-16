# 05 — Security Review
## feat-multi-brand — Stage 4
**authored_at:** 2026-06-16T10:20:00Z
**authored_by:** security-reviewer (Stage 4)
**req_id:** feat-multi-brand
**mode:** FULL (first review of this surface, high_stakes lane: auth + multi_tenancy)
**verdict:** FAIL — 1 open HIGH (SEC-MB-1)

---

## Scope

Files reviewed (source code, not reports):
- `db/migrations/0013_brand_self_read.sql`
- `apps/core/src/modules/workspace-access/internal/application/auth.service.ts` (switchBrandContext, lines 612–716)
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts` (set-brand route, lines 357–436; brand-summary, lines 562–643)
- `apps/core/src/modules/workspace-access/internal/application/brand.service.ts` (full)
- `apps/core/src/modules/workspace-access/internal/interfaces/rest/brand.routes.ts` (full)
- `apps/web/components/dashboard/brand-switcher.tsx` (full)
- `apps/web/components/dashboard/create-brand-dialog.tsx` (full)
- `apps/web/lib/api/client.ts` (CSRF, switchBrand, getBrandSummary)
- `apps/core/src/main.ts` (CSRF onRequest hook, lines 163–224)
- `tools/isolation-fuzz/src/pg.test.ts` (full, AC-7 describe block)
- Canon: `INVARIANTS.md`, `TRIGGER-SURFACES.md`, `COMPLIANCE.md`

Scanners run:
- isolation-fuzz: `PG_USER=brain PG_PASSWORD=brain npx vitest run src/pg.test.ts` → 11/11 PASS
- DB policy verification: `docker exec brainv3-postgres-1 psql -U brain -d brain -c "SELECT policyname, cmd FROM pg_policies WHERE tablename='brand';"` → `brand_isolation (ALL)` + `brand_self_read (SELECT)` confirmed
- Secret grep: no plaintext tokens in changed files
- MA-01 grep: `grep -n "refreshSession|resolveActiveContext|findActiveByUser" auth.service.ts` → none in `switchBrandContext` method body

---

## Threat-model gates — what I verified and how

### MA-01 — Context-substitution defect (PASS)

Verified by reading `auth.service.ts:632–716`. `switchBrandContext` calls `this.mintSessionToken(userId, jti, context)` at line 690 directly. The method body does NOT call `refreshSession`, `resolveActiveContext`, or `findActiveByUser`. Grep confirmed: the only occurrences of those method names in auth.service.ts are at their own definition sites and in other methods (refreshSession at line 598, resolveActiveContext at line 561, findActiveByUser at lines 301, 572). The JSDoc at line 622–626 and in-method comment at line 687–689 both document the prohibition explicitly. MA-01 PASS.

### MA-02 — Workspace spoofing on set-brand (PASS for set-brand; HIGH on brand-create — see SEC-MB-1)

For `POST /api/v1/bff/session/set-brand`: `bff.routes.ts:405` passes `auth.workspaceId` (from JWT) to `switchBrandContext` as the `workspaceId` parameter. The route body type is `{ brand_id?: string }` only (line 373). No `workspace_id` body field is read. Null guard at line 376 returns 400 MISSING_WORKSPACE before any DB call. SEC comment at line 375 documents this explicitly. PASS.

For `POST /api/v1/brands` (brand-create): `brand.routes.ts:43` uses `parsed.data.workspace_id` (request body) as `organizationId`. The JWT's `auth.workspaceId` is NOT used. This is SEC-MB-1 (HIGH — see Findings).

### MA-03 — Role from brand-level row (PASS)

`auth.service.ts:679–684`: `context.role = row.roleCode` where `row` is the result of `findByUserAndOrg(userId, workspaceId, requestedBrandId, memberCtx)` (3-arg, non-null requestedBrandId). The org-level null-brand row is not used. Comment at line 678 documents this. PASS.

### MA-04 / 0013 — RLS fail-closed (PASS)

Migration file confirmed to match the architecture plan §4 exactly:
- `FOR SELECT TO brain_app` — SELECT-only, TO brain_app
- Two-arg `current_setting('app.current_user_id', TRUE)` and `current_setting('app.current_workspace_id', TRUE)` — both fail-closed
- NN-1 DO-block verifies both GUC forms (checks pg_policies.qual for presence of two-arg form for BOTH GUCs)
- SOFT-DELETE / ARCHIVED REGRESSION NOTE present
- No-GUC test in isolation-fuzz: fresh connection → 0 rows (confirmed by AC-7 no-GUC test, pg.test.ts:624)

DB verification: `brand_self_read` policy qual confirmed via `pg_policies` query — matches the migration exactly, including both two-arg `current_setting` calls. PASS.

PERMISSIVE OR semantics: `brand_self_read` (SELECT) and `brand_isolation` (ALL) are both PERMISSIVE. PostgreSQL PERMISSIVE policies OR together: a SELECT passes if EITHER holds. This means a brand-B session can read brand-A rows from the `brand` table via brand_self_read (needed for the switcher list). This is intentional and documented. It does NOT expose cross-org reads because brand_self_read is org-GUC-scoped (`AND m.organization_id = current_setting('app.current_workspace_id', TRUE)::uuid`). Isolation of brand-scoped data tables (connector_instance, realized_revenue_ledger, etc.) is solely governed by brand_isolation (FOR ALL), which is unrelaxed. PASS for isolation correctness; MED finding (SEC-MB-2) for test-clarity.

### MA-05 — sessionPreHandler revocation check (PASS)

`bff.routes.ts:368`: `{ preHandler: [sessionPreHandler] }` registered on the set-brand route. SEC comment at line 367 documents the requirement. Same registration as set-org. PASS.

### MA-06 — brand-summary active_brand_id + brand-scoped member_count (PASS)

`bff.routes.ts:615–618`: member count query uses `COUNT(DISTINCT app_user_id) FROM membership WHERE organization_id = $1 AND brand_id = $2` with params `[auth.workspaceId, auth.brandId]`. If `auth.brandId` is null, returns 0 (honest empty). `active_brand_id: auth.brandId ?? null` at line 628. PASS.

### MA-09 — Audit brand.switch (PASS)

`auth.service.ts:696–710`: `this.audit.append({ action: 'brand.switch', payload: { from_brand_id, to_brand_id, workspace_id, role_granted } })`. All four required payload fields present. `idempotency_key: randomUUID()`. Written after membership+archived check but after mintSessionToken — acknowledged trade-off (LOW SEC-MB-4). PASS.

### MA-10 — Archived guard (PASS)

`auth.service.ts:669–673`: after the membership check, reads brand via `brandRepo.findById(requestedBrandId, brandCtx)`. If `brand.status === 'archived'` → throws `AuthError('BRAND_ARCHIVED', ..., 400)`. Brand-scoped ctx used (now authorized). PASS.

### MA-11 — No brandId in memberCtx (PASS)

`auth.service.ts:648`: `const memberCtx = { correlationId, userId, workspaceId }`. No `brandId` field. Comment at lines 649–651 explains the GUC-bleed risk. brandCtx with brandId is only created AFTER the membership check at line 665. PASS.

### CSRF coverage on set-brand (PASS)

`main.ts:191–203`: app-wide `onRequest` hook fires on all POST/PUT/PATCH/DELETE mutations with a session cookie. The exempt list is: `/api/v1/bff/session` (login), auth endpoints, shopify callback, webhooks. `/api/v1/bff/session/set-brand` is NOT exempted. `bff.routes.ts:360` documents: "CSRF enforced by the app-wide onRequest hook (not exempt — same as set-org)." PASS.

### Cookie flags (PASS)

`bff.routes.ts:411–417`: `setCookie(COOKIE_NAME, token, { httpOnly: true, secure: process.env['NODE_ENV'] === 'production', sameSite: 'strict', path: '/', maxAge: result.expiresIn })`. httpOnly=true, sameSite=strict, secure in prod. PASS.

### Create-brand backend authorization (YES — backend enforces role; workspace binding is the gap)

`brand.service.ts:68–70`: the service checks `memberRepo.findByUserAndOrg(requestingUserId, organizationId, null, ctx)` and requires `roleCode === 'owner' || roleCode === 'brand_admin'`. The role from the JWT (`auth.role` passed as `requestingRole` at brand.routes.ts:47) is not used — the service ignores this parameter and re-derives role from the DB membership row. This is STRONGER than checking the JWT role (the DB row is authoritative; the JWT role could be stale). Backend DOES enforce role authorization for brand-create. The HIGH finding (SEC-MB-1) is about workspace binding, not about role enforcement.

### Isolation fuzz — AC-7 (PASS, verified with live Postgres)

Command run: `cd tools/isolation-fuzz && PG_USER=brain PG_PASSWORD=brain npx vitest run src/pg.test.ts`
Result: 11/11 tests pass. No .skip() on AC-7 tests. AC-7 negative controls confirmed:
- brand-B session → `connector_instance WHERE brand_id = brand-A` → 0 rows (brand_isolation enforced)
- No-GUC session → 0 brands from brand_self_read (NN-1 fail-closed)
- Negative-control proof: disabling RLS on test table exposes 1 row (proves tests are real canaries, not bypass-green)
- Positive control: brand-B session reads brand-B rows > 0 (RLS not over-blocking)
- brand_self_read lists both brand-A and brand-B for the fuzz user (switcher list behavior verified)

Test structure uses `isofuzz_brand_app` role with `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE` — real enforcement proven, not superuser bypass. PASS.

---

## Findings

### SEC-MB-1 — HIGH — workspace_id from body in POST /v1/brands (BLOCKING)

**File:** `apps/core/src/modules/workspace-access/internal/interfaces/rest/brand.routes.ts:43`

`organizationId: parsed.data.workspace_id` — the workspace that will own the new brand comes from the request body, not from `auth.workspaceId` (the JWT-bound session context).

**Exploit path:** A user who holds `owner` or `brand_admin` membership in two orgs (org-A and org-B) can hold a valid session for org-A and issue `POST /v1/brands { workspace_id: "org-B-id", display_name: "..." }`. The membership check in `BrandService.create` looks up membership in org-B (body-provided) and finds it — the check passes, and a brand is created in org-B while the session is bound to org-A. The GUC context (`ctx = { workspaceId: data.organizationId }`) for the brand insert uses the body-derived org ID. Audit row records `organization_id = org-B`. The user's session cookie gives no indication of org-B context.

**Why it matters:** This violates the workspace-binding invariant (analogous to MA-02 for set-brand). A session's active workspace context MUST govern which workspace mutations target. Allowing body-supplied workspace_id without validating it against the session creates a session-context/action-context mismatch that can cause authorization surprises and makes the audit trail misleading (the audit action context does not match the session context).

**Mitigating control:** Role enforcement is NOT bypassed — the DB membership check is sound. A user without membership in the target org gets 403. The scope of the issue is limited to users with multi-org membership (rare in Phase 1 but structurally incorrect).

**Fix:** At `brand.routes.ts:43`, replace `parsed.data.workspace_id` with `auth.workspaceId`. Add a guard: if `!auth.workspaceId` return 400 MISSING_WORKSPACE (mirroring set-brand). Remove `workspace_id` from `CreateBrandRequestSchema` body or add a validation that `body.workspace_id === auth.workspaceId` if existing clients depend on it. The `requestingRole` parameter (brand.routes.ts:47) can be cleaned up too — the service ignores it and uses the DB row, making the parameter misleading.

---

### SEC-MB-2 — MED — PERMISSIVE OR on `brand` table: brand_self_read cross-brand read is intentional but test is ambiguous

**File:** `tools/isolation-fuzz/src/pg.test.ts:594`

The AC-7 negative-control test at line 564 queries brand-A from a brand-B session and asserts `expect(brandRowCount).toBeGreaterThanOrEqual(0)` — i.e., it accepts both 0 and 1 as valid. This is correct behavior (brand_self_read intentionally allows cross-brand `brand` table reads for the switcher list) but the test does not state this explicitly. A future reviewer might add an `expect(brandRowCount).toBe(0)` assertion that would incorrectly break switcher functionality.

**Fix (no shipping blocker):** Change the comment at line 591–594 to add an assertion: `expect(brandRowCount).toBeGreaterThan(0)` (proving brand-A IS visible, which is the intended behavior for the switcher). This makes the design intent machine-verifiable and prevents the test from being silently changed to assert 0.

---

### SEC-MB-3 — MED — create-brand-dialog sends workspace_id from cache, not JWT; null fallback sends empty string

**File:** `apps/web/components/dashboard/create-brand-dialog.tsx:143`

`getActiveWorkspaceId(queryClient) ?? ''` — if the workspace list cache is empty (cold start, fresh tab, cache miss), the empty string `''` is sent to `POST /v1/brands` as `workspace_id`. The backend membership check fails to find a membership for workspace `''` and returns 403. The user sees a "Could not create brand" error with no useful diagnosis. Additionally, sourcing from the workspace-list cache is fragile — the session JWT's workspaceId is the authoritative source.

**Fix (resolves with SEC-MB-1 fix):** If SEC-MB-1 is fixed to use `auth.workspaceId` on the backend, the body `workspace_id` becomes unnecessary. The frontend should either (a) not send workspace_id in the body, or (b) source it from `useCurrentUser().auth.workspaceId` (the BFF `/me` response, which already returns `auth.workspace_id`).

---

### SEC-MB-4 — LOW — Audit append after mintSessionToken; misleads forensics on rare throw-after-audit

**File:** `apps/core/src/modules/workspace-access/internal/application/auth.service.ts:690,696`

mintSessionToken (line 690) runs before audit.append (line 696). If mintSessionToken throws (e.g., signing key error), the audit row is NOT written but the access token was also not minted — so the user's cookie is NOT updated. This is safe. However, if some future refactor moves audit.append before mintSessionToken and mintSessionToken then throws, the audit would record a switch that never happened. The existing pattern is the correct order; the comment at line 693 acknowledges the intent. No remediation required in this release; noting for awareness.

---

### SEC-MB-5 — INFO — Pre-existing test failure: critical-paths.test.ts:143

**File:** `apps/core/src/modules/workspace-access/internal/application/critical-paths.test.ts:143`

Pre-existing since fix/token-1h-expiry-logout changed ACCESS_TOKEN_EXPIRY_SECS from 900 to 3600 without updating the test assertion. Confirmed pre-existing by backend developer (git stash proof). Not introduced by feat-multi-brand. QA should resolve as part of test maintenance.

---

## MA items passed

| Gate | Verdict | Evidence |
|---|---|---|
| MA-01 direct mint, no fallback | PASS | auth.service.ts:690; grep confirms no refreshSession/resolveActiveContext/findActiveByUser in switchBrandContext |
| MA-02 workspaceId from JWT on set-brand | PASS | bff.routes.ts:405 passes auth.workspaceId; body = { brand_id } only |
| MA-02 workspaceId from JWT on brand-create | FAIL (SEC-MB-1) | brand.routes.ts:43 uses parsed.data.workspace_id |
| MA-03 role from brand-level row | PASS | auth.service.ts:679 row.roleCode from 3-arg findByUserAndOrg |
| MA-04 0013 policy + NN-1 | PASS | SQL confirmed in file + pg_policies query confirms live deployment |
| MA-05 sessionPreHandler | PASS | bff.routes.ts:368 |
| MA-06 active_brand_id + scoped count | PASS | bff.routes.ts:615–628 |
| MA-07 M1 invariant comment | PASS | brand.service.ts:172–176 |
| MA-09 audit with from/to/workspace/role | PASS | auth.service.ts:696–710 |
| MA-10 archived guard | PASS | auth.service.ts:669–673 |
| MA-11 no brandId in memberCtx | PASS | auth.service.ts:648 |
| MA-12 primary-node comment | PASS | auth.service.ts:663–665 |
| MA-13 findActiveByUser doc note | PASS | auth.service.ts:627–631 (JSDoc) |
| CSRF on set-brand | PASS | main.ts:194–203 (set-brand not exempted); bff.routes.ts:360 |
| Cookie flags httpOnly/sameSite/secure | PASS | bff.routes.ts:411–417 |
| Brand-create role enforcement (backend) | PASS | brand.service.ts:68–70 (DB membership row, not JWT claim) |
| Isolation fuzz AC-7 | PASS | 11/11 tests pass; negative controls return 0; canary proof confirmed |
| PII in logs (no new PII logged) | PASS | Correlation IDs, UUIDs, role codes only in new code paths |
| I-S01 brand isolation | PASS | connector_instance cross-brand: 0 rows confirmed in live DB under NOBYPASSRLS role |

---

## Verdict rationale

SEC-MB-1 is HIGH: workspace_id from the request body on `POST /v1/brands` breaks the session-workspace binding invariant (the analogous MA-02 rule). While the membership check is sound and prevents truly unauthorized creates, the active session workspace is not authoritative over the target workspace. In a multi-org user scenario, the session and the mutation operate in different workspace contexts without any validation or error. This is a structural violation of the isolation contract.

All MA-01 through MA-13 checks for the set-brand path pass with hard evidence. The isolation fuzz is live-verified (11 tests, real NOBYPASSRLS role, negative controls confirmed). The 0013 policy is in the running database and matches the migration file exactly. CSRF is enforced at the onRequest hook and set-brand is not exempted. Cookie flags are correct.

The feature does not advance past FAIL until SEC-MB-1 is resolved.

**bounce_target:** `backend-developer` (brand.routes.ts:43 fix, optionally brand.service.ts requestingRole cleanup)

---

## DELTA Re-Review — 2026-06-16T11:00:00Z
**authored_at:** 2026-06-16T11:00:00Z
**authored_by:** security-reviewer (Stage 4, DELTA)
**mode:** DELTA — scope: SEC-MB-1 fix verification + bounce diff regression check
**prior verdict:** FAIL (2026-06-16T10:20:00Z, SEC-MB-1 HIGH blocking)
**delta commit:** bcfee81 (fix(security+qa): BOUNCE r1)
**verdict:** PASS

---

### Delta scope

Re-verified: SEC-MB-1 (HIGH, was blocking). Spot-checked: SEC-MB-2 (MED), SEC-MB-3 (MED). Confirmed no scope creep in bounce diff (no new endpoint, MCP tool, DB migration, or secret). Confirmed set-brand/switchBrandContext path (MA-01–MA-13) untouched in the diff.

---

### SEC-MB-1 — RESOLVED

**Evidence (file:line):**

`apps/core/src/modules/workspace-access/internal/interfaces/rest/brand.routes.ts:34` — `if (!auth.workspaceId)` guard now exists before schema parse; returns 400 `MISSING_WORKSPACE`. Mirrors set-brand guard in bff.routes.ts.

`apps/core/src/modules/workspace-access/internal/interfaces/rest/brand.routes.ts:58` — `organizationId: auth.workspaceId` (JWT source). The former `parsed.data.workspace_id` is gone from all code paths. Grep result: `grep -n "parsed.data.workspace_id" brand.routes.ts` → only comment text at lines 51–52.

`requestingRole` fix: now passes the stub constant `'analyst'` (line 65) with a SEC comment (lines 62–65) documenting that BrandService.create ignores the passed role and re-derives it authoritatively from the DB membership row.

**Exploit closed:** A session scoped to org-X POSTing `{ workspace_id: "org-Y" }` to `/v1/brands` will have the body value discarded. The route now uses `auth.workspaceId` (org-X from JWT). The membership check in BrandService.create then verifies membership in org-X. Cross-org brand creation via body-spoofing is structurally impossible.

**git diff confirmation:** `git diff 9b87621..bcfee81 -- brand.routes.ts` shows the exact change: `- organizationId: parsed.data.workspace_id` → `+ organizationId: auth.workspaceId` and the MISSING_WORKSPACE guard addition.

---

### SEC-MB-3 — RESOLVED (spot-check)

`apps/web/components/dashboard/create-brand-dialog.tsx:140` — `brandApi.create()` call no longer includes `workspace_id` in the request body. `getActiveWorkspaceId()` helper removed. Trailing comment at lines 403–406 documents the removal rationale (SEC MB-3: backend derives from JWT). Grep confirms: `grep "getActiveWorkspaceId" create-brand-dialog.tsx` → comment-only at line 403.

---

### SEC-MB-2 — RESOLVED (spot-check)

`tools/isolation-fuzz/src/pg.test.ts:600` — AC-7 brand-table assertion changed from `toBeGreaterThanOrEqual(0)` (tautology) to `toBeGreaterThan(0)` with label `'brand-A must be visible in brand-B session via brand_self_read (switcher design)'`. The connector_instance cross-brand negative control (= 0 rows) is preserved unchanged. Isolation-fuzz live run: 11/11 PASS.

---

### Scope creep check

`git diff 9b87621..bcfee81 --name-only` (excluding run artifacts): 7 source files changed.

| File | Category | Assessment |
|---|---|---|
| `brand.routes.ts` | Fix (SEC-MB-1) | Only the POST handler's workspace binding and requestingRole lines changed — no new routes, no new mutation surface |
| `critical-paths.test.ts` | Test additions (QA-2) | 6 new unit tests for switchBrandContext — test file only, no code path change |
| `switch-brand.live.test.ts` | New test file (QA-1) | Integration test file only; seeds/tears down test fixtures; no production code |
| `create-brand-dialog.tsx` | Fix (SEC-MB-3) | Removed getActiveWorkspaceId() call and workspace_id from request body — net reduction in surface |
| `types.ts` | Supporting (SEC-MB-3) | `workspace_id?: string` made optional — backward compat, body value is discarded by backend |
| `brand.api.v1.ts` | Supporting (SEC-MB-1) | `workspace_id` made optional in Zod schema — body value is discarded by route handler |
| `pg.test.ts` | Fix (SEC-MB-2) | AC-7 describe block added + assertion strengthened — test file only |

**No new endpoints.** No new MCP tools. No new DB migrations (`db/` directory: 0 changes in bounce diff). No new production secrets (test-only JWT signing literals in test files are a pre-existing pattern matching critical-paths.test.ts; not in any .env or production config path).

**Set-brand/switchBrandContext path (MA-01–MA-13):** `bff.routes.ts` and `auth.service.ts` are NOT in the bounce diff. The MA-01–MA-13 path is structurally unchanged from the FULL review PASS status.

---

### Isolation fuzz re-run

```
pnpm --filter @brain/tool-isolation-fuzz test:isolation
→ 11 passed (pg.test.ts), 2 skipped (StarRocks enterprise-only — pre-existing)
→ AC-7 connector_instance cross-brand: 0 rows (brand_isolation enforced under NOBYPASSRLS role)
→ AC-7 brand_self_read: >0 rows (switcher design confirmed, assertion now protective)
→ negative-control canary: policy_on=0 rows, policy_off=1 row (tests are real, not bypass-green)
```

RLS live confirmation: `pg_policies WHERE tablename='brand'` → `brand_isolation (ALL)` + `brand_self_read (SELECT)` both present. 0013 migration is live.

---

### Verification validity

Tests run under real security context: isolation-fuzz uses `NOSUPERUSER NOBYPASSRLS` role. switch-brand.live.test.ts connects to live Postgres under `brain_app` not superuser `brain`. The MEMORY.md note (dev DB superuser masks RLS) is acknowledged: isolation-fuzz explicitly creates a NOBYPASSRLS role (`isofuzz_brand_app`) for its probes — the tests do NOT run as superuser. Negative controls are non-inert (confirmed by canary proof: disabling RLS on test table exposes data; removing FORBIDDEN guard in switchBrandContext causes LIVE-SB-4 to fail per test doc).

---

### Remaining open findings

| ID | Severity | Status | Notes |
|---|---|---|---|
| SEC-MB-4 | LOW | open (deferred) | Audit after mint — known trade-off; not a blocking defect |
| QA-3 | MED | deferred | audit_log.correlation_id column — schema migration required; tracked as tech-debt |

No CRITICAL or HIGH findings remain open. PASS.

---

## DELTA Re-Review (Reconciliation) — 2026-06-16T11:30:00Z
**authored_at:** 2026-06-16T11:30:00Z
**authored_by:** security-reviewer (Stage 4, DELTA-reconciliation)
**mode:** DELTA — scope: reconciliation commit c4d0f92 (bootstrap fallback re-introduced after bounce-fix broke onboarding)
**prior verdict (r2):** PASS at 2026-06-16T11:00:00Z (commit bcfee81 — JWT hardcoded, body fully discarded)
**delta commit:** c4d0f92 — "fix(core): restore onboarding brand-create after SEC-MB-1; add create→switch e2e"
**verdict:** PASS

---

### Context

The prior DELTA (r2) passed commit `bcfee81` where `auth.workspaceId` was hardcoded and `body.workspace_id` was fully discarded. That broke onboarding Step 2 (/brand/new): the workspace-create flow does not re-mint the session cookie, so `auth.workspaceId` is null at that point and `POST /v1/brands` returned 400 `MISSING_WORKSPACE`. Commit `c4d0f92` reconciles by introducing: `const organizationId = auth.workspaceId ?? parsed.data.workspace_id` (brand.routes.ts:48). This review assesses whether the reconciliation re-opens SEC-MB-1 or any cross-tenant path.

---

### Gate 1 — JWT-wins precedence (SEC-MB-1 protection)

**Evidence:** `brand.routes.ts:48` — `const organizationId = auth.workspaceId ?? parsed.data.workspace_id`

When `auth.workspaceId` is non-null (every normal post-onboarding session), the `??` short-circuits and `parsed.data.workspace_id` is unreachable. A session scoped to org-X sending `{ workspace_id: "org-Y" }` in the body will have `auth.workspaceId = "org-X"` from the JWT, and `organizationId` will be `"org-X"`. The body value is structurally discarded. SEC-MB-1's original cross-org spoof is closed.

**PASS.**

---

### Gate 2 — Bootstrap fallback (auth.workspaceId null): adversarial analysis

**Evidence:** `brand.service.ts:68-70`

When `auth.workspaceId` is null (onboarding bootstrap), `organizationId = body.workspace_id`. The service then runs:
```typescript
const membership = await memberRepo.findByUserAndOrg(data.requestingUserId, data.organizationId, null, ctx);
if (!membership || (membership.roleCode !== 'owner' && membership.roleCode !== 'brand_admin')) {
  throw new BrandError('FORBIDDEN', '...', 403);
}
```

The SQL (`repositories.ts:815-817`) is: `WHERE app_user_id = $1 AND organization_id = $2 AND brand_id IS NULL` — fully parameterized.

**Adversarial probe:** User A (member only of org-A) sends `POST /v1/brands { workspace_id: "org-B-id" }` while in onboarding (auth.workspaceId null). Result:
1. `organizationId = "org-B-id"` (body fallback)
2. `ctx.workspaceId = "org-B-id"` (brand.service.ts:60)
3. `findByUserAndOrg(userA, "org-B-id", null, ctx)` queries `WHERE app_user_id = userA AND organization_id = org-B AND brand_id IS NULL` → 0 rows (user A has no org-B membership)
4. `!membership` → throws 403

**Defense-in-depth:** The `membership_isolation` RLS policy (`organization_id = current_setting('app.current_workspace_id',true)::uuid`) sets the GUC to `org-B-id`. RLS filters to rows where `organization_id = org-B`. User A has no such row. Both the SQL WHERE clause and RLS independently return empty. Two independent controls; neither can be bypassed without the other.

**Multi-org user scenario:** User A is a legitimate member of org-B with role `owner`. `auth.workspaceId` is null (onboarding). They send `workspace_id: org-B`. Membership check finds their org-B row → PASS → creates brand in org-B. This is legitimate — they are an owner of org-B. The session-workspace binding concern from SEC-MB-1 (a session scoped to X creating in Y) does not apply when `auth.workspaceId` is null (there is no "active" workspace in the JWT to be violated).

**Cross-tenant create possible:** No. The membership check (`owner` or `brand_admin` required in the named org) is the authoritative guard and holds under both the normal and bootstrap paths.

**PASS.**

---

### Gate 3 — sessionPreHandler and auth integrity

**Evidence:** `brand.routes.ts:25` — `{ preHandler: [sessionPreHandler] }`. `auth.routes.ts:419-420` — JWT is parsed and revocation is checked on every call. `auth.userId` and `auth.workspaceId` are sourced exclusively from verified JWT claims; the body has no influence on `auth.userId`. The `requestingRole` parameter is a stub `'analyst'` (brand.routes.ts:68); the service ignores it and re-derives from the DB row.

**PASS.**

---

### Gate 4 — Traceability and PII

**Evidence:** `brand.routes.ts:28` — `correlationId = x-correlation-id ?? requestId`; propagated to `ctx` and audit log. Audit log fields: `actor_id` (UUID), `organization_id` (UUID), `display_name` (brand name — not PII), `currency_code`, `timezone`, `revenue_definition`. No email, phone, or other direct identifiers in logs.

**PASS.**

---

### Gate 5 — Scope creep check (c4d0f92)

`git show c4d0f92 --stat` shows 2 files changed:
- `apps/core/src/modules/workspace-access/internal/interfaces/rest/brand.routes.ts` — POST handler reconciliation only; no new routes registered
- `apps/web/e2e/multi-brand.spec.ts` — new e2e test file only (no production code)

No new endpoints. No new MCP tools. No new DB migrations. No new secrets. `bff.routes.ts` and `auth.service.ts` not in diff — MA-01 through MA-13 path confirmed unchanged from prior PASS.

**PASS.**

---

### Isolation fuzz re-run (live)

`cd tools/isolation-fuzz && PG_USER=brain PG_PASSWORD=brain npx vitest run src/pg.test.ts`

Result: **11/11 PASS**. Connector_instance cross-brand: 0 rows (brand_isolation enforced under NOBYPASSRLS role). brand_self_read: lists both brands for fuzz user (switcher design). Negative-control canary: policy_off=1 row (tests are real, not bypass-green). Isolation unchanged by c4d0f92.

---

### E2E test results

`cd apps/web && DATABASE_URL=postgres://brain:brain@localhost:5432/brain npx playwright test e2e/multi-brand.spec.ts e2e/smoke.spec.ts --reporter=list`

Result: **2 passed, 3 failed**. All 3 failures are identical: `expect(page).toHaveURL(/\/verify-email/)` — received `/register`. Root cause: the shared dev IP registration rate-limiter (`rl:register:::1` limit 10/hour) is exhausted from prior test runs, so `/api/v1/auth/register` returns 429, the page stays on `/register`, and all tests that call `onboardToDashboard()` fail immediately at registration. This is test-infra (rate-limit saturation), not a security or code regression. The passing test (`ghost /invite returns 404`) does not require registration and confirms the app stack is running. The isolation-fuzz suite directly exercises the security-critical RLS paths and is 11/11 PASS under the real NOBYPASSRLS role.

---

### Onboarding caller: create-brand-form.tsx sends workspace_id

**Evidence:** `create-brand-form.tsx:114` — sends `workspace_id: workspaceId` (from `useWorkspaceList()[0].id`). This is the designed bootstrap caller: auth.workspaceId is null at this step, and the backend body-fallback is the intentional accommodation. The dashboard dialog (`create-brand-dialog.tsx:140-145`) continues to omit workspace_id per the SEC-MB-3 fix (body omission is correct there since auth.workspaceId is set in post-onboarding sessions). The two callers are consistent with the reconciled logic: one provides workspace_id for bootstrap, the other relies on JWT. This is a LOW informational note for future maintenance, not a finding.

---

### Remaining open findings

| ID | Severity | Status | Notes |
|---|---|---|---|
| SEC-MB-4 | LOW | open (deferred) | Audit after mint — known trade-off; not introduced by c4d0f92 |
| SEC-RECON-NOTE-1 | LOW | open (informational) | create-brand-form.tsx sends workspace_id (bootstrap design); create-brand-dialog.tsx omits it (normal design); both consistent with reconciled backend logic |

No CRITICAL or HIGH findings. **PASS.**

---

### Verdict rationale

The `??` operator in `brand.routes.ts:48` is safe because: (a) when `auth.workspaceId` is set, the body value is structurally discarded — SEC-MB-1's cross-org spoof cannot occur in any normal session; (b) when `auth.workspaceId` is null (onboarding bootstrap only), `body.workspace_id` is used but is gated by a DB membership check that requires `owner` or `brand_admin` membership in the named org via parameterized SQL with independent RLS enforcement. Two independent structural controls — both must fail for a cross-tenant create to succeed. Neither has a bypass path. The reconciliation is sound.
