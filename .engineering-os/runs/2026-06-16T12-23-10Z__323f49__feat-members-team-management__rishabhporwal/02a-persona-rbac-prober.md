# Persona Review — RBAC Boundary Prober
## feat-members-team-management | Stage 1

| Field | Value |
|---|---|
| **Persona** | RBAC Boundary Prober (privilege-escalation abuser) |
| **Angle** | Server-side authority enforcement — can a lower-privileged actor escalate via crafted HTTP? |
| **Reviewed at** | 2026-06-16T12:35:00Z |
| **Decision** | PASS (concerns surfaced — architect must address before Stage 3) |
| **Concerns surfaced** | 6 |
| **Top finding** | P1-CRITICAL: Brand-Admin can PATCH /members/:id/role to grant 'brand_admin' or any role equal to their own — no downward-bounded hierarchy check on the new role code |

---

## Sharpest Exploit Narrative

**Attack: Brand-Admin grants Brand-Admin to an arbitrary user via role-change endpoint**

A Brand-Admin actor (JWT role=brand\_admin) authenticates and sends:

```
PATCH /api/v1/members/<victim_membership_id>/role
Authorization: Bearer <brand_admin_jwt>
Body: { "role_code": "brand_admin" }
```

The `updateMemberRole` handler at `invite.service.ts:358-370` checks:

```typescript
if (!requesterMembership ||
    (requesterMembership.role_code !== 'owner' && requesterMembership.role_code !== 'brand_admin')) {
  throw new InviteError('FORBIDDEN', 'Requires owner or brand_admin role.', 403);
}
```

This check only gates whether the actor is owner-or-brand\_admin. It does NOT assert that the `newRoleCode` is BELOW the actor's own authority level. A Brand-Admin passes this gate and the service proceeds to `UPDATE membership SET role_code = $1` (line 407) with no further hierarchy assertion. There is no call to `meetsMinimumRole`, `hasMinimumRole`, or any comparable function in this path.

**Consequence:** A Brand-Admin can:
1. Elevate any Manager or Analyst to Brand-Admin (lateral power expansion).
2. Elevate themselves by changing a second membership row they control (if the data model permits a user to have two membership rows — a schema-level question, but the service does not prevent it).
3. Elevate any Manager/Analyst to Brand-Admin, then that elevated user performs additional operations.

The same gap exists in `createInvite` for the Brand-Admin path, though there it is partially mitigated because the code blocks `role_code='owner'` (line 93). But a Brand-Admin can still invite a `brand_admin` — the check at line 87-89 only verifies "is actor owner-or-brand\_admin?" not "is granted role below actor's authority?"

The requirement states: "grant only roles at/below your authority — Owner > Brand Admin > Manager > Analyst." The ROLE\_HIERARCHY array exists at `domain/membership/entities.ts:32` and `meetsMinimumRole`/`hasMinimumRole` both exist but are never called in either `createInvite` or `updateMemberRole`.

---

## Findings Table

| ID | Attack Path | Verdict | Severity | Evidence |
|---|---|---|---|---|
| P1 | Role-grant escalation: Brand-Admin invites as brand\_admin | **GAP** | CRITICAL | `invite.service.ts:87-89` blocks manager/analyst from inviting but does NOT assert `actorRole > grantedRole`. ROLE\_HIERARCHY exists but is never called. A brand\_admin can POST /invites with role\_code='brand\_admin'. |
| P2 | Role-change escalation: Brand-Admin PATCH /members/:id/role to brand\_admin | **GAP** | CRITICAL | `invite.service.ts:358-370` only asserts actor is owner-or-brand\_admin. No assertion `newRoleCode < actorRole`. `hasMinimumRole`/`meetsMinimumRole` never called in this path. Brand-Admin can elevate anyone including themselves. |
| P3 | Suspend/remove authority: who may suspend whom, can Manager suspend Owner | **GAP (future)** | HIGH | `AuthService.suspendUser` (`auth.service.ts:764-798`) has NO actor-authority check at all — no membership lookup, no hierarchy assertion. The method takes `(appUserId, actorId)` and accepts any actorId without verifying actorId has authority over appUserId's role. When wired into a member route, ANY authenticated actor who reaches the route could suspend ANYONE, including an Owner, if the route-level RBAC guard is insufficient. Additionally `suspendUser` uses sequential non-transactional calls (pool.connect, revokeAllForUser, updateStatus) — NOT a raw-client BEGIN/COMMIT — so session revocation and status update are in separate implicit auto-commit transactions (two-phase window). |
| P4 | Revoked-invite replay: can expired/revoked token be accepted | **DEFENDED** | — | `acceptInvite` at `invite.service.ts:171-175` SQL: `WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW()`. Status check is in the query predicate — a revoked invite (status='revoked') returns no row and throws INVALID\_TOKEN. This path is correctly closed. |
| P5 | Re-invite resurrection: removed email creates new vs resurrects old | **PARTIAL GAP** | HIGH | `createInvite` does not check for an existing active membership row for the invited email. It goes directly to `inviteRepo.insert` (line 100). If a user was removed (their membership row deleted), `createInvite` will issue a new invite — correct. BUT: if the user is merely suspended (status on app\_user, not on membership), the code still inserts a new invite without checking current membership status. More critically: there is no check for an already-active membership — a Brand-Admin can invite an email that already has an active membership in the same org/brand, creating a duplicate membership row on accept (no UNIQUE constraint visible on `(organization_id, brand_id, app_user_id)` or `(organization_id, brand_id, email, status='active')`). The `acceptInvite` path does a raw INSERT with no conflict guard. |
| P6 | Cross-actor IDOR: act on :id belonging to different brand/org | **DEFENDED (partial)** | — | `updateMemberRole` at `invite.service.ts:382-386`: after fetching target by `id`, checks `target.organization_id !== organizationId` (line 383) and throws NOT\_FOUND. Same pattern in `removeMember` (line 512-515). The org-scoping check is in-service, not via RLS on this raw-client path, but the application-layer check is present and correct for org isolation. Brand-level isolation within an org (brand\_id scoping) is NOT checked — a Brand-Admin for brand A could potentially act on a member of brand B within the same org. However this is bounded by the org-match check. |
| P7 | Self-targeting: last Owner demotes/removes themselves | **DEFENDED** | — | Sole-owner guard in `updateMemberRole` (`invite.service.ts:389-399`): counts owners before demoting; throws SOLE\_OWNER if count <= 1. Same in `removeMember` (`invite.service.ts:519-529`). Both guards are pre-mutation within the same transaction. Guard is correct. |

---

## Detailed Gap Analysis

### P1 — CRITICAL: createInvite does not bound grantedRole by actorRole

**File:** `apps/core/src/modules/workspace-access/internal/application/invite.service.ts`
**Lines:** 80-95

The current logic:
- Line 87-89: Gates on actor being owner-or-brand\_admin (binary gate, not hierarchy).
- Line 93-95: Blocks role\_code='owner' specifically.

Missing: `if (ROLE_HIERARCHY.indexOf(data.roleCode) >= ROLE_HIERARCHY.indexOf(inviterMembership.roleCode)) { throw FORBIDDEN }` — or equivalently, call `hasMinimumRole(data.roleCode, inviterMembership.roleCode)` and reject if true.

**Exploit:** Brand-Admin (ROLE\_HIERARCHY index=2) sends POST /api/v1/invites with role\_code='brand\_admin' (index=2). Line 87 passes (actor is brand\_admin). Line 93 passes (role is not 'owner'). Invite row is written with role\_code='brand\_admin'. Target accepts — now two Brand-Admins exist where the original Brand-Admin created a peer with equal authority without Owner approval.

The `ROLE_HIERARCHY` and `hasMinimumRole` exist in `domain/membership/entities.ts:32,37` and `meetsMinimumRole` in `security/rbac.ts:26` — neither is imported or called in invite.service.ts.

### P2 — CRITICAL: updateMemberRole does not bound newRoleCode by actorRole

**File:** `apps/core/src/modules/workspace-access/internal/application/invite.service.ts`
**Lines:** 358-416

The current logic:
- Lines 358-370: Gates on actor being owner-or-brand\_admin (binary gate).
- Lines 389-399: Sole-owner guard (prevents demoting last owner).

Missing: any assertion that `newRoleCode` is strictly below the actor's `role_code` in the hierarchy. After the gate, line 406-410 executes the UPDATE unconditionally.

**Exploit:** Brand-Admin sends PATCH /api/v1/members/<target_id>/role with body `{ "role_code": "brand_admin" }`. Gate at line 368 passes. No hierarchy check follows. UPDATE executes. Target is now Brand-Admin. The actor has granted their own authority level to an arbitrary member without Owner involvement.

An Owner can grant any role including brand\_admin (correct). A Brand-Admin should be bounded to granting manager or analyst only (the spec hierarchy: "Owner > Brand Admin > Manager > Analyst; Brand Admin invites Manager/Analyst"). This is entirely absent from the role-change path.

### P3 — HIGH: suspendUser has no actor-authority check and is non-atomic

**File:** `apps/core/src/modules/workspace-access/internal/application/auth.service.ts`
**Lines:** 764-798

`suspendUser(appUserId, actorId, correlationId)` does NOT:
1. Look up actorId's membership row to verify they have authority over appUserId.
2. Check whether target appUserId is an Owner (a Manager or even a Brand-Admin should not be able to suspend an Owner).
3. Verify actor's role >= target's role in the hierarchy.

When this is wired into a member route for the suspend feature (per the requirement), the route-level guard will need to enforce this entirely. If the route uses only `requireRole('manager')` or even `requireRole('brand_admin')` without a per-target authority check in the service, a Brand-Admin or Manager could call the suspend endpoint with an Owner's `appUserId` and succeed.

Additionally: `suspendUser` is NOT transactional. It calls `sessionRepo.revokeAllForUser` (line 772) and then `userRepo.updateStatus` (line 775) on the SAME `pool` (GUC-wrapped, auto-commit) connection — NOT inside a `BEGIN/COMMIT` block with a `rawPgPool`. If `revokeAllForUser` succeeds but `updateStatus` throws (DB error, constraint, anything), sessions are revoked but the user is not suspended — the membership is in an inconsistent state. Contrast with `removeMember`/`updateMemberRole` which both use `rawPgPool.connect()` + `BEGIN`/`COMMIT`.

### P5 — HIGH: No duplicate-membership guard on acceptInvite

**File:** `apps/core/src/modules/workspace-access/internal/application/invite.service.ts`
**Lines:** 236-244`

The INSERT on line 240-243:
```sql
INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
VALUES ($1, $2, $3, $4)
RETURNING ...
```

There is no `ON CONFLICT DO NOTHING` or pre-check for existing active membership. If a user already has an active membership row for the same (organization\_id, brand\_id), this INSERT will either (a) create a duplicate row if no UNIQUE constraint exists at the DB schema level, or (b) throw an unhandled constraint violation if the schema has a UNIQUE constraint — but the error would bubble as a 500, not a clean 409.

The `createInvite` path also does not check whether the invited email already has an active membership. An Owner could spam-invite an email that already joined, flooding the invite table and sending unwanted emails to an active member.

---

## Mitigations Required (Architect Must Bind)

1. **P1+P2 — Hierarchy-bounded grant:** In both `createInvite` and `updateMemberRole`, after asserting actor is owner-or-brand\_admin, add: `if (ROLE_HIERARCHY.indexOf(newRoleCode) >= ROLE_HIERARCHY.indexOf(actorRole)) { throw FORBIDDEN }`. Owner is exempt from this bound (can grant any role). Brand-Admin is bounded to granting manager/analyst only. The existing `hasMinimumRole` function in `domain/membership/entities.ts:37` can be used directly.

2. **P3 — suspendUser authority check:** Before revoking/suspending, `suspendUser` must (a) look up actor's membership row, (b) look up target's membership row, (c) assert `actorRole > targetRole` in ROLE\_HIERARCHY, (d) explicitly block any actor from suspending an Owner. Separately, the method must be rewritten to use `rawPgPool` + `BEGIN/COMMIT` so that revocation and status-update are atomic.

3. **P5 — Duplicate-membership guard:** `acceptInvite` should check for an existing membership row for (organization\_id, brand\_id, app\_user\_id) before INSERT, and throw CONFLICT (409) if one exists. Alternatively, add a DB-level UNIQUE constraint on (organization\_id, brand\_id, app\_user\_id) and handle the constraint violation as 409. `createInvite` should similarly check for existing active membership before issuing an invite (not a security gap per se, but an operational correctness issue).

---

## Journal Stub

```
## 2026-06-16T12:35:00Z — Persona:RBAC-Boundary-Prober — feat-members-team-management
**Angle:** Server-side hierarchy enforcement on role grant and role change · **Top concern:** Brand-Admin can grant brand_admin role via createInvite or updateMemberRole — no downward-bound check · **Severity:** CRITICAL
```
