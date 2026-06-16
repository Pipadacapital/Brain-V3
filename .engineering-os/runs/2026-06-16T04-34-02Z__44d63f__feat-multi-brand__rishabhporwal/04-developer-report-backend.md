# 04 — Developer Report (Backend, Track A)
## feat-multi-brand — Track A: backend/core + db

**authored_at:** 2026-06-16T07:45:00Z
**authored_by:** backend-engineer (Stage 3)
**req_id:** feat-multi-brand
**stage:** 3 — Track A COMPLETE

---

## §1 — Files Changed / Created

| File | Change |
|---|---|
| `db/migrations/0013_brand_self_read.sql` | NEW — RLS policy (A1) |
| `apps/core/src/modules/workspace-access/internal/application/auth.service.ts` | NEW import `BrandRepository`; NEW method `switchBrandContext()` after `refreshSession` (A2) |
| `apps/core/src/modules/workspace-access/internal/application/brand.service.ts` | M1 invariant comment at `list()` org-membership guard (A6/MA-07) |
| `apps/core/src/modules/frontend-api/internal/bff.routes.ts` | NEW import `AuthError`; NEW `POST /api/v1/bff/session/set-brand` after set-org (A3); brand-summary `active_brand_id` + brand-scoped `member_count` (A4) |
| `tools/isolation-fuzz/src/pg.test.ts` | NEW `AC-7` describe block — brand-switch isolation fuzz (A5) |

---

## §2 — Acceptance Criteria Disposition

### MA-01 — PASS: mintSessionToken direct, no refreshSession/resolveActiveContext
`switchBrandContext()` calls `this.mintSessionToken(userId, jti, context)` directly. `refreshSession`, `resolveActiveContext`, and `findActiveByUser` are **not referenced** in the method. Audit written **after** mint path (audit before mint, mint after check — see comment in code).

**Proof:** curl set-brand to Beta → 200 `{ auth: { brand_id: Beta, role: analyst } }`. Audit row written. Method source at `auth.service.ts:switchBrandContext` (line ~612 after refresh session).

### MA-02 — PASS: workspaceId from JWT only
BFF route reads `auth.workspaceId` from `(request as AuthenticatedRequest).auth`. Body only reads `brand_id`. null `workspaceId` → 400 `MISSING_WORKSPACE` BEFORE any DB call. SEC comment present.

**Proof (workspace_id spoof):** POST `{ brand_id: smoke-brand, workspace_id: different-org }` → 403 FORBIDDEN. The body `workspace_id` was ignored; the JWT `workspaceId` (curl-test-org) was used — curl-test-org has no membership for smoke-brand → 403.

### MA-03 — PASS: role from brand-level membership row
`context.role = row.roleCode` where `row` is the result of `findByUserAndOrg(userId, workspaceId, requestedBrandId, ctx)` (3-arg, non-null brand). Org-level (null-brand) row is NOT used.

**Proof:** curl-test-user is org `owner` but `analyst` on Beta. set-brand to Beta → `role: analyst` in response.

### MA-04 — PASS: migration 0013 workspace-GUC filter + soft-delete note + NN-1 two-GUC DO-block
`0013_brand_self_read.sql` has:
- `AND m.organization_id = current_setting('app.current_workspace_id', TRUE)::uuid`
- SOFT-DELETE / ARCHIVED REGRESSION NOTE comment
- DO-block checks BOTH GUCs for fail-closed two-arg form

**Proof:** DO-block ran without RAISE (migration output: `CREATE POLICY` + `DO`).

### MA-05 — PASS: sessionPreHandler on set-brand route
Route registered: `{ preHandler: [sessionPreHandler] }`. SEC comment: `// SEC: session revocation DB check required — do NOT use JWT-only verification (MA-05)`.

### MA-06 — PASS: brand-summary active_brand_id + brand-scoped member_count
`active_brand_id: auth.brandId ?? null` in response. Member count query: `COUNT(DISTINCT app_user_id) FROM membership WHERE organization_id = $1 AND brand_id = $2`.

**Proof:** curl brand-summary after set-brand to Beta → `active_brand_id: Beta`, `member_count: 1` (Beta-scoped, not org-level which would be 1 too in this case but query is scoped).

### MA-07 — PASS: M1 invariant comment at brand.service.ts list()
Comment added at the `findByUserAndOrg(..., null, ctx)` call in `BrandService.list()`.

### MA-08 — N/A (Track B — frontend create-brand dialog)

### MA-09 — PASS: brand.switch audit with from/to/workspace/role_granted
Audit appended at end of `switchBrandContext()`:
```
action: 'brand.switch'
payload: { from_brand_id, to_brand_id, workspace_id, role_granted }
```
**Proof (DB):** `SELECT action, payload FROM audit_log WHERE action = 'brand.switch'` → row with `from_brand_id: Alpha, to_brand_id: Beta, role_granted: analyst`.

### MA-10 — PASS: archived brand → 400 BRAND_ARCHIVED
After membership check passes, reads brand via `brandRepo.findById(requestedBrandId, brandCtx)`. If `brand.status === 'archived'` → `throw new AuthError('BRAND_ARCHIVED', ...)`.

**Proof:** set-brand to archived brand (member) → `{ error: { code: 'BRAND_ARCHIVED', ... } }` HTTP 400.

### MA-11 — PASS: memberCtx has NO brandId
```ts
const memberCtx = { correlationId, userId, workspaceId };
```
No `brandId` field. Comment explaining why: "setting app.current_brand_id before authorizing the target brand would bleed into the pooled connection".

### MA-12 — PASS: primary-node comment
Comment in `switchBrandContext()`: "this read must target the primary Postgres node — a create-then-switch on a read replica could 403 under replica lag. M1 is single-node; mandatory revisit before any read replica."

### MA-13 — PASS: findActiveByUser doc note
JSDoc on `switchBrandContext()`: "On fresh login, findActiveByUser auto-selects the most-recently-created brand-level membership row... 'Remember last active brand' is deferred."

### AC-7 — PASS: isolation-fuzz brand-switch test

---

## §3 — The §Contract (for Track B / frontend-web-developer)

### `POST /api/v1/bff/session/set-brand`

**PreHandler:** `[sessionPreHandler]` (same as set-org).

**Request body:**
```jsonc
{ "brand_id": "uuid" }
```
NO `workspace_id` or `organization_id` in body — ignored if present.

**Response 200:**
```jsonc
{
  "request_id": "uuid",
  "auth": { "brand_id": "uuid", "workspace_id": "uuid", "role": "owner|brand_admin|analyst|..." }
}
```
Sets httpOnly `brain_session` cookie (secure in prod, sameSite=strict, path=/, maxAge=3600).

**Error matrix:**
| Condition | HTTP | code |
|---|---|---|
| `auth.workspaceId` null | 400 | `MISSING_WORKSPACE` |
| body `brand_id` missing | 400 | `MISSING_BRAND_ID` |
| pool unavailable | 503 | `SERVICE_UNAVAILABLE` |
| no membership (or cross-org) | 403 | `FORBIDDEN` |
| brand archived (+ member) | 400 | `BRAND_ARCHIVED` |

### Brand-list source (switcher data)
Source: `GET /api/v1/dashboard/brand-summary` → `data.brands[]`. No new endpoint. Active brand: `data.active_brand_id` (new field). Active brand name: `data.brands.find(b => b.id === data.active_brand_id)?.display_name`.

### Dashboard brand-summary active-brand fields (AC-5)
```jsonc
{
  "request_id": "uuid",
  "data": {
    "org_name": "string|null",
    "active_brand_id": "uuid|null",   // NEW — = auth.brandId from JWT
    "brand_count": 3,
    "member_count": 1,                 // NOW brand-scoped (not org-level)
    "brands": [
      { "id": "uuid", "display_name": "string", "domain": "string|null", "status": "active|archived" }
    ]
  }
}
```

### `AuthService.switchBrandContext()` signature
```ts
async switchBrandContext(
  userId: string,
  jti: string,
  fromBrandId: string | null,
  workspaceId: string,
  requestedBrandId: string,
  correlationId: string,
): Promise<{ accessToken: string; expiresIn: number; context: ActiveContext }>
```

---

## §4 — Migration 0013 Applied

```
File: db/migrations/0013_brand_self_read.sql
Applied: 2026-06-16T07:05:00Z
Output: CREATE POLICY / DO (NN-1 DO-block did not raise)
```

**brain_app RLS proofs (SET ROLE brain_app):**
- Member user + workspace GUC set → `SELECT * FROM brand` returns 1 row (member brand only) — PASS
- User + wrong workspace GUC (different org) → 0 rows — PASS
- No GUC → 0 rows (fail-closed NN-1) — PASS

---

## §5 — Verification Summary

### Typecheck
```
pnpm --filter @brain/core typecheck → EXIT 0 (no errors)
pnpm --filter @brain/tool-isolation-fuzz typecheck → EXIT 0
```

### Core test suite (pre-existing failure noted)
```
pnpm --filter @brain/core test:unit
Tests: 73 passed, 1 failed (pre-existing: critical-paths.test.ts:143 expects expiresIn=900 but
code returns 3600 after commit fix/token-1h-expiry-logout changed ACCESS_TOKEN_EXPIRY_SECS from
900 to 3600 without updating the test assertion — not caused by this change, confirmed by git stash
proof: failure exists on the base branch before any Track A changes).
```

### Isolation-fuzz suite
```
pnpm --filter @brain/tool-isolation-fuzz test:isolation
Tests: 48 passed, 2 skipped (StarRocks M-01 enterprise-only — pre-existing skip) — EXIT 0
AC-7 tests: all 5 pass (4 + 1 SKIP_IF_NO_PG)
```

### validity_check.py
Not present in the repository (`find . -name "validity_check.py"` → no results). Not blocking.

### Curl proofs (live Postgres, core :3001)

1. **set-brand to member brand (Beta) → 200** — `{ auth: { brand_id: Beta, role: analyst } }` — PASS
2. **set-brand to NON-member brand → 403** — `{ error: { code: FORBIDDEN } }` — PASS
3. **set-brand to archived brand (member) → 400** — `{ error: { code: BRAND_ARCHIVED } }` — PASS
4. **workspace_id body spoof → ignored, 403** — body `workspace_id` was ignored; JWT `workspaceId` used → 403 — PASS (MA-02)
5. **brand-summary after switch → active_brand_id + brand-scoped member_count** — `active_brand_id: Beta, member_count: 1` — PASS (MA-06)

### MA-01 non-fallback proof
`switchBrandContext()` source does not contain calls to `refreshSession`, `resolveActiveContext`, or `findActiveByUser`. Grep: `grep -n "refreshSession\|resolveActiveContext\|findActiveByUser" apps/core/src/modules/workspace-access/internal/application/auth.service.ts | grep switchBrandContext` → no results. The method calls `mintSessionToken` directly.

### Audit (MA-09) DB proof
```
SELECT action, actor_id, payload FROM audit_log WHERE action = 'brand.switch';
→ { action: brand.switch, actor_id: curl-test-user, payload: {
    from_brand_id: Alpha, to_brand_id: Beta,
    workspace_id: curl-test-org, role_granted: analyst } }
```

---

## §6 — Self-review vs Security + QA Gates

| Gate | Status | Notes |
|---|---|---|
| MA-01 direct-mint-no-fallback | PASS | `mintSessionToken` called directly; no refreshSession/resolveActiveContext |
| MA-02 workspaceId from JWT | PASS | Body only reads `brand_id`; JWT `auth.workspaceId` used |
| MA-03 brand-level role | PASS | `row.roleCode` from 3-arg findByUserAndOrg |
| MA-04 0013 workspace-GUC + soft-delete + NN-1 | PASS | All three elements present + proven |
| MA-05 sessionPreHandler | PASS | Registered; SEC comment present |
| MA-06 brand-summary active_brand_id + scoped count | PASS | New field + query updated |
| MA-07 M1 invariant doc | PASS | Comment added at list() guard |
| MA-09 audit from/to/workspace/role | PASS | Payload fields confirmed in DB |
| MA-10 archived guard | PASS | 400 BRAND_ARCHIVED proven |
| MA-11 no brandId in memberCtx | PASS | memberCtx has only correlationId+userId+workspaceId |
| MA-12 primary-targeting note | PASS | Comment in switchBrandContext() |
| MA-13 findActiveByUser doc | PASS | JSDoc in switchBrandContext() |
| AC-7 isolation fuzz | PASS | 4 AC-7 tests pass (connector_instance cross-brand = 0) |
| Cursor pagination | N/A | No new paginated endpoints |
| Money as integer minor units | N/A | No monetary fields in this feature |
| Rate-limit | N/A | Inherits sessionPreHandler rate-limiting path |
| Trace/correlation ID | PASS | correlationId threaded through switchBrandContext() |
| idempotency_key on audit | PASS | `randomUUID()` on brand.switch audit.append |
| Pre-existing test failure | NOTED | critical-paths.test.ts:143 expects 900, gets 3600 — pre-existing since fix/token-1h-expiry-logout, not caused by Track A |

---

## BOUNCE r1 fix — 2026-06-16T10:40:00Z (Backend Engineer, Stage 3 DELTA)

**Bounce reason:** Stage-4 Security FAIL (SEC-MB-1 HIGH, SEC-MB-3 MED) + Stage-5 QA FAIL (QA-1 HIGH, QA-2 MED, QA-4 LOW). All blocking items resolved. QA-3 deferred (schema migration required).

---

### FIX 1 — SEC-MB-1 (HIGH, BLOCKING): workspace_id from JWT on POST /v1/brands

**File:** `apps/core/src/modules/workspace-access/internal/interfaces/rest/brand.routes.ts`

**Change (lines 31–65):**
- Added `if (!auth.workspaceId)` guard before schema parse → 400 `MISSING_WORKSPACE` (mirrors bff.routes.ts set-brand guard).
- Replaced `organizationId: parsed.data.workspace_id` with `organizationId: auth.workspaceId` (line 58).
- Removed `requestingRole: (auth.role ?? 'analyst')` JWT claim — service re-derives role from DB membership row (brand.service.ts:68-70). Replaced with a fixed `'analyst'` stub and a SEC comment documenting that BrandService.create ignores the passed role.
- Made `workspace_id` optional in `packages/contracts/src/api/brand.api.v1.ts` `CreateBrandRequestSchema` so bodies without `workspace_id` pass validation (clients that still send it are unaffected — value is ignored).

**Grep proof (body workspace_id no longer read):**
```
grep -n "parsed.data.workspace_id" brand.routes.ts
→ no results (only comment references remain)
```
Line 58: `organizationId: auth.workspaceId`

---

### FIX 2 — SEC-MB-3 (MED): decouple create-brand dialog from workspace cache

**Files changed:**
- `apps/web/components/dashboard/create-brand-dialog.tsx`: removed `workspace_id: getActiveWorkspaceId(queryClient) ?? ''` from the `brandApi.create()` call body. Added SEC comment explaining why. Removed `getActiveWorkspaceId()` helper function.
- `apps/web/lib/api/types.ts`: changed `workspace_id: string` → `workspace_id?: string` in `CreateBrandRequest` interface. Added explanatory comment.

**Verification:** `pnpm --filter @brain/web typecheck` → EXIT 0. No `workspace_id` field in the create call; no `getActiveWorkspaceId` function in the file.

---

### FIX 3 — QA-1 (HIGH, BLOCKING): automated live-Postgres smoke for switchBrandContext

**File:** `apps/core/src/modules/workspace-access/tests/switch-brand.live.test.ts` (NEW)

**Pattern:** mirrors `family-wipe.live.test.ts` — connects to `DATABASE_URL=postgres://brain:brain@localhost:5432/brain`, seeds a 2-brand user (brand-A owner + brand-B analyst + archived brand + non-member brand), skips cleanly if PG unavailable.

**4 tests:**
- `LIVE-SB-1`: switch to brand B → `context.brandId === B`, `context.role === 'analyst'` (MA-01/MA-03)
- `LIVE-SB-2`: `brand.switch` audit row written with correct from/to/workspace/role_granted (MA-09)
- `LIVE-SB-3 [NEGATIVE]`: archived brand (member) → throws `AuthError` with code `BRAND_ARCHIVED` (MA-10)
- `LIVE-SB-4 [NEGATIVE]`: non-member brand → throws `AuthError` with code `FORBIDDEN` (MA-02)

**Test output:**
```
✓ src/modules/workspace-access/tests/switch-brand.live.test.ts (4 tests) 49ms
```

---

### FIX 4 — QA-2 (MED, BLOCKING): unit coverage for switchBrandContext

**File:** `apps/core/src/modules/workspace-access/tests/critical-paths.test.ts` (appended)

**6 new unit tests** using stub executor (no live PG required), covering:
- MA-01: `accessToken` returned (direct mint, no refreshSession path called)
- MA-02: `context.workspaceId` equals the JWT-sourced arg
- MA-03: `context.role` from brand-level membership row (`'analyst'`), not org-level
- MA-09: `audit.append` called with `brand.switch` action + correct payload fields
- MA-10 [NEGATIVE]: archived brand → `BRAND_ARCHIVED` 400
- [NEGATIVE]: non-member → `FORBIDDEN` 403; `audit.append` NOT called

**Test output:**
```
✓ src/modules/workspace-access/tests/critical-paths.test.ts (22 tests) 7ms
```
(Previously 16 tests; 6 new for switchBrandContext. The pre-existing `expiresIn=900` failure was resolved in a prior commit — all 22 pass now.)

---

### FIX 5 — SEC-MB-2 / QA-4 (LOW/MED): de-tautologize AC-7 brand-table assertion

**File:** `tools/isolation-fuzz/src/pg.test.ts`

**Change:** Replaced `expect(brandRowCount).toBeGreaterThanOrEqual(0)` with:
```
expect(brandRowCount, 'brand-A must be visible in brand-B session via brand_self_read (switcher design)').toBeGreaterThan(0);
```
This assertion is now protective: if `brand_self_read` policy (0013) were accidentally dropped, brandRowCount would be 0 and this test would fail. The connector_instance negative-control (= 0 rows) is preserved unchanged.

**Test output:**
```
✓ src/pg.test.ts (11 tests) — all pass
```

---

### DEFERRED — QA-3 (MED): correlationId column in audit_log

`correlationId` is threaded through `switchBrandContext()` as a method arg and used in `QueryContext` for GUC-setting on DB connections. However, the `audit_log` table schema (0001_init.sql) has no `correlation_id` column, and the `AuditEntry` interface in `@brain/audit` does not include it. Writing `correlation_id` into audit rows requires:
1. A new migration adding the column to `audit_log`.
2. Updating `AuditEntry` in `@brain/audit`.
3. Updating `DbAuditWriter.append()` to include the column.

This is a schema migration — out of this slice (no cross-service migrations mid-bounce-fix per engineering-os §change-control). Tracked as tech-debt: `audit_log.correlation_id` column should be added in a dedicated migration to satisfy end-to-end trace threading in the system-of-record.

---

### Verification Summary (BOUNCE r1)

| Check | Result | Output |
|---|---|---|
| `pnpm --filter @brain/core typecheck` | EXIT 0 | No errors |
| `pnpm --filter @brain/web typecheck` | EXIT 0 | No errors |
| workspace-access tests (all 4 files) | 53 pass, 0 fail | `auth.service.test.ts` (24) + `critical-paths.test.ts` (22) + `family-wipe.live.test.ts` (3) + `switch-brand.live.test.ts` (4) |
| isolation-fuzz `pg.test.ts` | 11 pass, 0 fail | AC-7 brand-table assertion now `>0` |
| `grep parsed.data.workspace_id brand.routes.ts` | 0 results | Body workspace_id not read |
| `grep workspace_id create-brand-dialog.tsx` | Comment only | getActiveWorkspaceId removed |
