# 04 — Developer Report (Backend)

| Field | Value |
|---|---|
| **req_id** | `feat-members-team-management` |
| **Stage** | 3 — Backend (Track A) |
| **Agent** | Backend Engineer |
| **Completed** | 2026-06-16 |
| **Branch** | `feat/members-team-management` |
| **Commits** | d381627 → a525035 → f786c29 → 89095fb (4 slices) |

---

## Files Changed

| File | Purpose |
|---|---|
| `db/migrations/0014_member_lifecycle.sql` | Partial unique indexes for invite deduplication |
| `packages/contracts/src/api/member.api.v1.ts` | MemberSchema += user_email/user_full_name/user_status; 5 new response schemas |
| `packages/contracts/src/index.ts` | Re-exports for new schemas |
| `apps/core/src/modules/workspace-access/internal/application/invite.service.ts` | D-6/D-7 bounds, listPendingInvites, resendInvite, revokeInvite, listMembers return type fix |
| `apps/core/src/modules/workspace-access/internal/application/auth.service.ts` | suspendUser rewrite (D-8) + reactivateUser (D-1) |
| `apps/core/src/modules/workspace-access/internal/infrastructure/repositories.ts` | InviteRepository.listPending + rotateToken; MembershipRepository.listByOrganization user_* fields |
| `apps/core/src/modules/workspace-access/internal/interfaces/rest/member.routes.ts` | 5 new routes + GET /members user_email/user_full_name/user_status + requireRole imports |
| `apps/core/src/main.ts` | Pass rawPgPool to registerMemberRoutes |
| `apps/core/src/modules/workspace-access/tests/member-lifecycle.live.test.ts` | 13 tests: NC-1..6 + unit D-6/7/8/9/1 |

---

## D-binding PASS proofs

### D-6 — Hierarchy bound on createInvite (PASS)
`invite.service.ts:97-100`: `ROLE_HIERARCHY.indexOf(data.roleCode) >= ROLE_HIERARCHY.indexOf(inviterMembership.roleCode)` → 403 when actor is not owner. Unit test UNIT-D6 confirms brand_admin→brand_admin = 403 and brand_admin→manager = allowed.

### D-7 — Hierarchy bound on updateMemberRole (PASS)
`invite.service.ts:420-424`: same hierarchy check inside open txn; ROLLBACK before throw. Unit test UNIT-D7 confirms brand_admin→brand_admin = 403 and ROLLBACK in query sequence.

### D-8 — suspendUser rewrite (PASS)
`auth.service.ts:764-860`: rawPgPool BEGIN/COMMIT wrapping session-revoke + app_user.status in ONE txn. Actor+target membership resolved from DB. Hierarchy + explicit owner guard. Returns `{ sessionsRevoked }`. Unit tests: non-owner→owner = 403; equal-rank = 403; owner→manager = ok.

### D-9 — Org assertion on rawPgPool paths (PASS)
`auth.service.ts:799-802` (suspendUser) + `auth.service.ts:907-910` (reactivateUser): `target.organization_id !== organizationId → 404`. Unit test UNIT-D9: cross-org suspend → 404.

### D-10 — acceptInvite duplicate guard + partial unique indexes (PASS)
- `invite.service.ts:246-265`: duplicate-membership pre-check via `SELECT EXISTS` → 409. Catch block maps PG 23505 → 409.
- `db/migrations/0014_member_lifecycle.sql`: `invite_pending_org_email_uniq` + `invite_pending_brand_email_uniq` partial unique indexes applied to dev PG. Verified with `\di invite*`.

### D-3 — resendInvite rotates token (PASS)
`invite.service.ts:686-741`: `InviteRepository.rotateToken` updates `token_hash + expires_at` on existing row (no second row). Re-sends email via `notification.sendInviteEmail`.

### D-4 / D-11 — listPendingInvites predicate + workspaceId ctx (PASS)
`invite.service.ts:636-678`: QueryContext carries `workspaceId: organizationId` + optional `brandId`. `InviteRepository.listPending` appends `AND invited_by_user_id = $actor` for manager/analyst.

### D-1 — reactivateUser distinct (PASS)
`auth.service.ts:862-944`: separate method, writes `status='active'` only, NO session revocation, NO `sessions.bulk_revoked` audit action. Unit test confirms absence of user_session SQL and sessions.bulk_revoked action.

### D-2 — Authority from DB (PASS)
All authority checks in suspendUser and reactivateUser resolve actor role from `membership` table at request time, not from JWT claims.

### D-5 — Branch base (PASS)
Branch `feat/members-team-management` off `feat/shopify-sync-validation`; commit `43ea557` in ancestry (`fix(web): unwrap remaining BFF response-envelope mismatches`).

### H-1 — audit brand_id = organizationId (PASS)
`auth.service.ts:837-844` and `auth.service.ts:845-852`: both audit.append calls use `brand_id: brandId ?? organizationId`. Unit test D-8 H-1 asserts mock calls have `brand_id = 'org-H1'` not `'target-H1'`.

### M-1 — Audit post-COMMIT (PASS)
Audit appended after `COMMIT` in both suspendUser and reactivateUser, matching the established `removeMember` pattern.

### M-2 — Dev helper environment-gated (PASS)
`main.ts:316-319` gate: `/api/v1/dev/last-email-link` only registered when `config.nodeEnv !== 'production'`. Not regressed.

---

## Contract for Frontend

### New routes (all require valid session cookie):

| Method + Path | RBAC gate | Response |
|---|---|---|
| `GET /api/v1/invites?status=pending` | manager or higher | `{ request_id, invites: InviteResponse[], next_cursor, has_more }` |
| `POST /api/v1/invites/:id/resend` | brand_admin or higher + Idempotency-Key | `{ request_id, invite: InviteResponse }` |
| `POST /api/v1/invites/:id/revoke` | brand_admin or higher + Idempotency-Key | 204 No Content |
| `POST /api/v1/members/:id/suspend` | brand_admin or higher + Idempotency-Key | `{ request_id, member: MemberResponse }` (user_status: 'suspended') |
| `POST /api/v1/members/:id/reactivate` | brand_admin or higher + Idempotency-Key | `{ request_id, member: MemberResponse }` (user_status: 'active') |

### GET /members: new fields in each member object
```
user_email: string      // same as email (from app_user JOIN)
user_full_name: string  // same as email (no name column in app_user; placeholder)
user_status: 'active' | 'suspended'  // from app_user.status
```

### InviteResponse shape
```
{ id, organization_id, brand_id, email, role_code, status, expires_at, created_at }
```

### Envelope unwrap pattern (client.ts)
```ts
// listPendingInvites
const res = await ...; return { data: res.invites, next_cursor: res.next_cursor, has_more: res.has_more }
// resendInvite
const res = await ...; return res.invite
// suspendMember / reactivateMember
const res = await ...; return res.member
```

---

## Verification Output

### Typecheck
```
pnpm --filter @brain/core typecheck → EXIT 0 (no errors)
```

### Tests
```
pnpm --filter @brain/core test:unit
  Test Files  10 passed (10)
        Tests  99 passed (99)  [13 new in member-lifecycle.live.test.ts]
```

### Migration 0014 applied
```
\di invite*
 invite_pending_org_email_uniq   | unique index | invite
 invite_pending_brand_email_uniq | unique index | invite
 invite_status_org_idx           | index        | invite
```

### Negative Controls (NC-1..6)
All 6 run live under SET ROLE brain_app (NOBYPASSRLS):
- NC-1: cross-org membership = 0 rows — PASS
- NC-2: no-GUC invite → uuid cast error (fail-closed) — PASS
- NC-3: org-A GUC → org-B pending = 0 rows — PASS
- NC-4/5/6 combined: suspendUser revokes sessions; status=suspended; jti=null; audit brand_id=orgId — PASS

---

---

## BOUNCE r1 — 2026-06-16T19:10:00Z

QA vetoed on three missing HTTP wire-smoke tests (F-QA-1/F-QA-2/F-QA-3). Security had already passed. Added `apps/core/src/modules/workspace-access/tests/member-wire-smoke.live.test.ts` — 3 new tests via Fastify `app.inject()` against live PG: WIRE-1 proves suspend→SESSION_REVOKED 401 on the wire (not just a DB row); WIRE-2 proves brand_admin→brand_admin invite returns HTTP 403 and an owner control returns HTTP 201 (non-tautological); WIRE-3 proves GET /api/v1/invites?status=pending with an org-A session returns only org-A invite IDs with zero org-B IDs in the JSON response. All three would fail if the respective guard/RLS were removed. Typecheck EXIT 0; 6 test files, 69 tests all pass.

---

## Backend Journal Entry

```
## 2026-06-16T18:10:00Z — Backend Engineer — feat-members-team-management
**Stage:** 3 · **Service:** core (workspace-access) · **Verification:** typecheck EXIT 0 / 99 tests pass / migration applied
**Self-review vs gates:** PASS — all 16 acceptance contract items addressed
  D-6/D-7: hierarchy bounds (CRITICAL escalation fix)
  D-8/C-3: suspendUser atomic rawPgPool BEGIN/COMMIT
  D-8/C-4: actor+target authority from DB (not JWT)
  D-8/H-1: audit brand_id = organizationId (not appUserId)
  D-1: reactivateUser distinct, no session revoke
  D-9: cross-org org assertion on every rawPgPool path
  D-10: partial unique indexes + duplicate membership 409
  D-3/D-4/D-11: resend/revoke/list with GUC ctx
  5 new routes: pending list, resend, revoke, suspend, reactivate
  GET /members: user_email/user_full_name/user_status added
  All 6 NC tests pass under brain_app role (NOBYPASSRLS)
  4 WIP commits (one per slice), no force pushes
**Next:** READY-FOR-SECURITY
```
