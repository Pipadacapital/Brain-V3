# 05 — Security Review

| Field | Value |
|---|---|
| **req_id** | `feat-members-team-management` |
| **Stage** | 4 — Security Reviewer |
| **Mode** | FULL (first review of this surface; high_stakes: auth · multi_tenancy · outbound_channel · pii · audit) |
| **Verdict** | **PASS** |
| **Blocking findings** | 0 |
| **CRITICAL/HIGH open** | 0 — all 5 CRITICALs and 3 HIGHs from intake are CLOSED |
| **MED open** | 1 (SEC-V1 — test-quality gap, not runtime risk) |
| **LOW open** | 1 (SEC-V2 — optional-param dead-path) |
| **Reviewed at** | 2026-06-16T20:15:00Z |
| **Reviewer** | Security Reviewer (Sonnet 4.6 — independent full code inspection) |

---

## 1. Scope

Branch `feat/members-team-management` off `feat/shopify-sync-validation`. The diff (`git diff feat/shopify-sync-validation..HEAD`) contains exactly the members work plus the `full-journey.spec.ts` pre-existing file and `onboard.ts` helper fixes.

Files independently inspected (code read, not trusted from reports):

- `apps/core/src/modules/workspace-access/internal/application/invite.service.ts` (807 lines)
- `apps/core/src/modules/workspace-access/internal/application/auth.service.ts` (1077 lines)
- `apps/core/src/modules/workspace-access/internal/infrastructure/repositories.ts` (partial — rotateToken, listPending)
- `apps/core/src/modules/workspace-access/internal/interfaces/rest/member.routes.ts`
- `apps/core/src/modules/workspace-access/tests/member-lifecycle.live.test.ts`
- `apps/core/src/main.ts` (rawPgPool wiring, dev-route gate, global error handler)
- `db/migrations/0014_member_lifecycle.sql`
- `packages/contracts/src/api/member.api.v1.ts`
- `apps/core/src/modules/workspace-access/internal/security/rbac.ts`
- `apps/core/src/modules/workspace-access/internal/domain/membership/entities.ts`
- `apps/web/components/members/members-table.tsx` (hierarchy-gated UI)
- `apps/web/e2e/members-lifecycle.spec.ts`
- `db/migrations/0002_auth.sql` (app_user RLS disabled, user_session RLS)
- `db/migrations/0003_workspace.sql` (membership RLS)
- `db/migrations/0005_invitation.sql` (invite compound RLS)

---

## 2. Security Spine Verification (each was a CRITICAL in intake)

### Check 1 — Privilege escalation closed: createInvite (C-1 / D-6)

**PASS — verified by code inspection.**

`invite.service.ts:97-100` — D-6 bound inserted after owner-or-brand_admin gate, before the sole roleCode=owner block:

```typescript
if (inviterMembership.roleCode !== 'owner' &&
    ROLE_HIERARCHY.indexOf(data.roleCode) >= ROLE_HIERARCHY.indexOf(inviterMembership.roleCode)) {
  throw new InviteError('FORBIDDEN', 'Cannot grant a role at or above your own authority.', 403);
}
```

ROLE_HIERARCHY confirmed as `['analyst','manager','brand_admin','owner']` at `domain/membership/entities.ts:32`. Owner exempt (index comparison skipped when actor is owner). brand_admin (idx 2) granting brand_admin (idx 2): `2 >= 2` → true → 403. brand_admin granting manager (idx 1): `1 >= 2` → false → allowed. Logic is correct.

Actor role resolved from DB (`memberRepo.findByUserAndOrg` at line 82-87), not from JWT. ROLE_HIERARCHY imported from domain entities at line 23.

Unit test UNIT-D6 in `member-lifecycle.live.test.ts:67-165`: confirms brand_admin→brand_admin = 403; brand_admin→manager = no FORBIDDEN.

### Check 2 — Privilege escalation closed: updateMemberRole (C-2 / D-7)

**PASS — verified by code inspection.**

`invite.service.ts:418-424` — D-7 bound inside open transaction (BEGIN at line 401), after requester membership fetch, before target fetch:

```typescript
if (requesterMembership.role_code !== 'owner' &&
    ROLE_HIERARCHY.indexOf(newRoleCode) >= ROLE_HIERARCHY.indexOf(requesterMembership.role_code as RoleCode)) {
  await rawClient.query('ROLLBACK');
  throw new InviteError('FORBIDDEN', 'Cannot grant a role at or above your own authority.', 403);
}
```

ROLLBACK before throw is confirmed. Actor role from DB rawClient query (line 404-411), not JWT. Owner exempt.

Unit test UNIT-D7: includes explicit assertion that `queries` array contains `'ROLLBACK'` before the FORBIDDEN throw.

### Check 3 — Suspend atomicity + authority (C-3 / D-8, C-4, H-1)

**PASS — verified by code inspection.**

`auth.service.ts:766-868` — full rewrite confirmed.

**Atomicity (C-3):** rawPgPool.connect() at line 776, BEGIN at line 778. Both `UPDATE user_session SET revoked_at = NOW()` (CTE at lines 823-831) and `UPDATE app_user SET status = 'suspended'` (line 834-836) execute within the same client before COMMIT at line 839. No intermediate release, no intermediate commit. The two-commit window is eliminated.

**Authority (C-4):**
- Actor membership resolved from DB at lines 781-792: `SELECT ... FROM membership WHERE app_user_id = $1 AND organization_id = $2 AND brand_id IS NULL`. Not JWT.
- Target membership resolved at lines 796-808.
- Explicit owner block at line 813-816: `if (target.role_code === 'owner' && actor.role_code !== 'owner')` → ROLLBACK + 403.
- Hierarchy check at line 817-820: `if (actor.role_code !== 'owner' && actorIdx <= targetIdx)` → ROLLBACK + 403.
- Both checks issue ROLLBACK before throw.

**Audit (H-1 + M-1):** audit.append calls at lines 842-850 and 851-859, both after COMMIT at line 839. Both use `brand_id: brandId ?? organizationId` — never `appUserId`. Two audit rows: `user.suspended` and `sessions.bulk_revoked`. actor_role is `actor.role_code` (from DB) at line 845/854, not hardcoded 'system'.

Unit test UNIT-D8 H-1 asserts both audit.append calls carry `brand_id = 'org-H1'` and `brand_id !== 'target-H1'`.

rawPgPool wiring: `main.ts:304` — `new AuthService(pool, auditWriter, notificationService, authServiceConfig, rawPgPool)`. Fifth positional arg is rawPgPool. AuthService constructor at `auth.service.ts:138` accepts it as `private readonly rawPgPool?: Pool`. Confirmed.

### Check 4 — rawPgPool RLS bypass guard (C-5 / D-9)

**PASS — verified by code inspection.**

`auth.service.ts:804-808` (suspendUser): `if (!target || target.organization_id !== organizationId) { ROLLBACK; throw NOT_FOUND 404 }` — present at the correct position (after target fetch, before hierarchy check).

`auth.service.ts:912-916` (reactivateUser): identical assertion at the same structural position.

Pattern matches existing defended code at `invite.service.ts:436` (updateMemberRole) and `invite.service.ts:513` (removeMember — existing pre-slice code).

Unit test UNIT-D9: cross-org suspend (actor org-A, target returned with `organization_id: 'org-002'`, call passes `organizationId: 'org-001'`) → rejects with `{ statusCode: 404 }`.

### Check 5 — Isolation under SET ROLE brain_app (6 NC tests)

**PASS for NC-1/NC-2/NC-3 (run under SET LOCAL ROLE brain_app — full RLS semantics). PASS-with-qualification for NC-4/NC-5/NC-6.**

NC-1 (`line 476`): `SET LOCAL ROLE brain_app; SET app.current_workspace_id='<org-A>'; SELECT * FROM membership WHERE organization_id='<org-B>'` → 0 rows. Real RLS negative control. PASS.

NC-2 (`line 501`): `SET LOCAL ROLE brain_app;` (no GUCs) `SELECT * FROM invite WHERE status='pending'` — expects uuid-cast error or 0 rows (both are fail-closed). PASS. The two-arg `current_setting('app.current_workspace_id', TRUE)` returns empty string when GUC unset, causing `::uuid` cast failure — fail-closed confirmed by migration assertion DO block.

NC-3 (`line 534`): `SET LOCAL ROLE brain_app; SET app.current_workspace_id='<org-A>'; SELECT * FROM invite WHERE status='pending' AND organization_id='<org-B>'` → 0 rows. PASS.

NC-4/NC-5 (`line 558`): suspendUser invoked via rawPgPool. Assertion queries (lines 585-606) execute under the superuser `pool`. This is the SEC-V1 qualification — functional correctness is verified (0 active sessions; app_user.status='suspended') but the assertion queries don't run under SET ROLE brain_app. This is acceptable because: (a) `app_user` has RLS DISABLED (`0002_auth.sql:42: ALTER TABLE app_user DISABLE ROW LEVEL SECURITY`) — confirmed by inspection; (b) `user_session` RLS is scoped by `app.current_user_id`, not org, and the functional fact (revoked_at IS NOT NULL) is unaffected by RLS role. The critical isolation property — cross-org reads — is verified by NC-1/NC-2/NC-3. SEC-V1 is a test-quality gap, not a runtime risk.

NC-6 (`line 608-621`): audit brand_id checked via mock audit writer. `suspendCalls` asserted to have `brand_id = ORG_A_ID` and `brand_id !== USER_A_ID`. Correct, non-bypassable.

### Check 6 — Migration 0014 (additive, dual partial unique indexes)

**PASS — verified by code inspection.**

`db/migrations/0014_member_lifecycle.sql`: additive only — 3 CREATE INDEX IF NOT EXISTS statements, zero column changes, zero data moves (I-E02 compliant).

Two partial unique indexes mirror the NN-7 compound-RLS shape:
- `invite_pending_org_email_uniq ON invite (organization_id, email) WHERE status = 'pending' AND brand_id IS NULL` — org-level scope.
- `invite_pending_brand_email_uniq ON invite (brand_id, email) WHERE status = 'pending' AND brand_id IS NOT NULL` — brand-level scope.

This correctly permits the same email to receive invites to different brands within the same org (an expected scenario), while preventing duplicate pending tokens for the same slot. Single-index approach was explicitly rejected in the architecture plan for this reason.

Pre-flight DO blocks raise EXCEPTION on existing duplicates before index creation — fails loud, not silently. `IF NOT EXISTS` prevents re-run failures.

No `CONCURRENTLY` — correct (node-pg-migrate wraps migrations in a txn; CONCURRENTLY cannot run in a txn).

Rollback: `DROP INDEX IF EXISTS invite_pending_org_email_uniq, invite_pending_brand_email_uniq, invite_status_org_idx;` — pure index drops, zero data impact.

### Check 7 — Invite token at rest + revoke semantics + dup-membership guard (I-S09 / D-10)

**PASS — verified by code inspection.**

Token generation: `generateToken()` at `invite.service.ts:38-42` — `randomBytes(32)` → `sha256` hex. Only `tokenHash` is written to DB. `rawToken` goes to `notification.sendInviteEmail` in memory.

Accept lookup: `acceptInvite` at line 183 — `WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW()`. A revoked invite returns no row → 400 INVALID_TOKEN. The status check is in the query predicate (cannot be bypassed at application layer).

Resend (D-3): `InviteRepository.rotateToken` at `repositories.ts:1050` — `UPDATE invite SET token_hash = $1, expires_at = $2 WHERE id = $3 AND status = 'pending'`. Update only works on pending rows. No second row created.

Duplicate-membership guard (D-10): `acceptInvite:248-265` — `SELECT EXISTS` pre-check before INSERT; ROLLBACK + 409 if active membership exists. PG `23505` catch at line 284-287 maps constraint violation to 409 (belt-and-braces for race window). Both guards confirmed.

### Check 8 — Audit append-only hash-chain + brand_id mandatory (NN-6 / I-S06)

**PASS — verified by code inspection.**

All new audit.append calls carry explicit `brand_id`:
- `createInvite`: line 127 — `brand_id: data.brandId ?? data.organizationId`
- `acceptInvite`: line 301 — `brand_id: inviteRow.brand_id ?? inviteRow.organization_id`
- `resendInvite`: line 728 — `brand_id: updatedInvite.brandId ?? organizationId`
- `revokeInvite`: line 795 — `brand_id: inviteRow.brand_id ?? organizationId`
- `suspendUser`: lines 843, 852 — `brand_id: brandId ?? organizationId` (NOT appUserId — H-1 fixed)
- `reactivateUser`: line 940 — `brand_id: brandId ?? organizationId`

All suspend/reactivate audit calls are post-COMMIT (M-1 confirmed: COMMIT at line 839/936 precedes audit.append at 842/939).

email_masked (maskEmail()) used in all audit payloads where email appears — PII not in cleartext in audit.

### Check 9 — No new ADR/stack + no secrets in code + dev routes gated (M-2)

**PASS — verified by code inspection.**

No new service, no new stack layer, no new ADR. All new code reuses: rawPgPool pattern (identical to updateMemberRole/removeMember), rbac.ts helpers, existing audit writer, existing notification service.

Secret scan: `rawToken` never written to DB or log. Test mock uses `jwtSigningSecret: 'test-secret'` which appears only in unit test context. No API keys, credentials, or tokens in new production code paths. `grep` of diff for `password=`, `apiKey`, `secret=` in non-test code is clean.

Dev route gate: `main.ts:319` — `if (nodeEnv !== 'production')` wraps the `/api/v1/dev/last-email-link` registration. Confirmed unchanged. Note: this gate permits the dev endpoint in staging environments; the architecture plan acknowledged this as acceptable since the endpoint surfaces `rawToken` from an in-memory dev capture mechanism (not from the DB, which stores only token_hash). Token at rest remains sha256-only (I-S09 clean).

---

## 3. Route-Level Security Gates

All 5 new routes confirmed to have `[sessionPreHandler, requireRole(...)]` in `preHandler` arrays:

| Route | Guard |
|---|---|
| `GET /api/v1/invites` | `sessionPreHandler, requireRole('manager')` |
| `POST /api/v1/invites/:id/resend` | `sessionPreHandler, requireRole('brand_admin')` + Idempotency-Key (I-ST04) |
| `POST /api/v1/invites/:id/revoke` | `sessionPreHandler, requireRole('brand_admin')` + Idempotency-Key (I-ST04) |
| `POST /api/v1/members/:id/suspend` | `sessionPreHandler, requireRole('brand_admin')` + Idempotency-Key (I-ST04) |
| `POST /api/v1/members/:id/reactivate` | `sessionPreHandler, requireRole('brand_admin')` + Idempotency-Key (I-ST04) |

`requireRole` reads `auth.role` from the session object (set by `validateSessionPreHandler`), not from request body/query. Confirmed in `rbac.ts:44`.

organization_id mismatch guard: all routes that accept `organization_id` query param check `query.organization_id !== auth.workspaceId` → 403 at lines 147-151, 208-212, 262-265, 305-308. This is defence-in-depth for MA-06.

Route guard is correctly noted as necessary-not-sufficient; the fine-grained hierarchy + org assertion lives in-service (C-4 + D-9).

Global error handler: `main.ts:233-250` — strips stack traces in production (`nodeEnv !== 'production'` gate at line 239), returns generic 'Internal server error' for 5xx. No PII or stack traces leak to clients in prod.

---

## 4. Tenant Isolation (Four-Layer Verification)

| Layer | Status | Evidence |
|---|---|---|
| L1 — Entry (schema validation) | PASS | Zod schemas on all request bodies; `RoleCodeSchema` constrains roleCode to the 4-value enum; `CreateInviteRequestSchema` used at `member.routes.ts:49`. |
| L2 — Business logic | PASS | Every rawPgPool path: actor fetch + target fetch + `target.organization_id !== organizationId` + hierarchy check. Actor role from DB not JWT (D-2). |
| L3 — Environment (RLS) | PASS | GUC-wrapped pool paths carry `workspaceId+brandId` in ctx (D-11, listPendingInvites, revokeInvite, resendInvite); rawPgPool paths carry app-layer org assertion (D-9) as the structural guard since RLS is bypassed on rawPgPool. `resolveMembership` at route level adds defence-in-depth lookup with `WHERE id = $1 AND organization_id = $2`. |
| L4 — Audit | PASS | Every lifecycle event logged (invite.created, invite.accepted, invite.resent, invite.revoked, membership.role_changed, sessions.bulk_revoked, user.suspended, user.reactivated); brand_id correct on all calls; post-COMMIT for atomic paths. |

---

## 5. PII and Logging

No PII in new log statements. `maskEmail()` used in all audit payload email fields. `rawToken` never reaches a log statement. Global error handler redacts stack traces in production. No new `console.log` statements in production routes.

---

## 6. Verification-Validity Assessment

NC-1, NC-2, NC-3: run under `SET LOCAL ROLE brain_app` within a transaction — valid negative controls with full production RLS semantics. Not inert; NC-2 accepts either 0-rows or a uuid-cast error as fail-closed (both prevent data leak).

NC-4, NC-5: functional correctness verified (0 active sessions; status=suspended). Assertion queries run as superuser. Valid for functional correctness; insufficient for the full RLS negative-control mandate since user_session has RLS. See SEC-V1.

NC-6: audit brand_id checked via mock audit writer — self-contained, correct, not bypassable.

Unit tests (D-6/D-7/D-8/D-9/D-1): all include a meaningful negative-control case. UNIT-D7 asserts ROLLBACK is present before the FORBIDDEN throw. Tests are non-inert — each can fail for the real reason.

Playwright e2e: `waitForPendingInvite` at line 70 asserts `.first()` is visible → non-zero pending rows assertion present (D-11 false-negative guard active). 4/4 pass standalone; full-suite 6 failures are rate-limiter-caused and pre-exist Track B (confirmed by pre-Track-B stash run referenced in developer report).

---

## 7. Additional Independent Observations

**resolveMembership (member.routes.ts:612-650):** The route-level `resolveMembership` helper uses `rawPgPool` with an explicit `WHERE id = $1 AND organization_id = $2` clause — org isolation is enforced at the query level here too (not just via RLS or D-9 in the service). This is defence-in-depth. The `pgPool` optional parameter fallback (returns null) is unreachable in production since `main.ts:313` passes rawPgPool unconditionally. SEC-V2 noted.

**revokeInvite isolation:** The `revokeInvite` service uses the GUC-wrapped pool with `ctx.workspaceId` set, so compound invite RLS is active. An actor in org-A cannot revoke org-B invites even if they guess the invite ID — RLS filters the SELECT to the current workspace. Belt-and-braces status check (`inviteRow.status !== 'pending'` at line 788) prevents revocation of non-pending invites.

**token_hash not in responses:** Neither the resendInvite route response nor any other new route response surfaces `token_hash`. The resendInvite response at `member.routes.ts:391-403` returns only `{ id, organization_id, brand_id, email, role_code, status, expires_at, created_at }` — confirmed.

---

## 8. Findings Summary

| ID | Severity | Title | File | Status |
|---|---|---|---|---|
| SEC-V1 | MED | NC-4/NC-5 assertion queries run under superuser pool, not SET ROLE brain_app — diminished RLS verification signal | `tests/member-lifecycle.live.test.ts:585-606` | OPEN-DEFERRED |
| SEC-V2 | LOW | resolveMembership accepts rawPgPool as optional; null fallback is safe but silently loses route-layer defence-in-depth on misconfiguration | `member.routes.ts:625-628` | OPEN-DEFERRED |

**No CRITICAL or HIGH open findings. PASS.**

All 5 CRITICAL bindings from intake (C-1 through C-5) closed. All 3 HIGH bindings (H-1, H-2, H-3) closed. All 2 MED bindings (M-1, M-2) closed.

---

## Verdict

**PASS.** No open CRITICAL or HIGH findings. The implementation correctly closes all five CRITICALs identified in intake. The security spine is sound: privilege escalation paths are hierarchy-bounded in-service from DB authority; suspend is atomic in one rawPgPool transaction; rawPgPool paths carry application-layer org assertions; partial unique indexes prevent dual pending tokens; token is sha256-only at rest; audit brand_id is correct on all new paths; dev routes remain NODE_ENV-gated.

The two open findings (SEC-V1 MED, SEC-V2 LOW) are test-quality and dead-path concerns with no runtime exploitation path. They are deferred to the backlog.
