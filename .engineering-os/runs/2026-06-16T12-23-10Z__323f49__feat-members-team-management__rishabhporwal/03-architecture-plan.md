# 03 — Architecture Plan (binding)

| Field | Value |
|---|---|
| **req_id** | `feat-members-team-management` |
| **Stage** | 2 (Architect) |
| **Authored** | 2026-06-16 |
| **Lane** | high_stakes (auth · multi_tenancy · outbound_channel · pii · system_of_record_audit) |
| **Cost paradigm** | **Tier 0 — deterministic.** Zero model calls. RBAC hierarchy is array index comparison; revocation is a SQL `UPDATE`; isolation is RLS + an application-layer org assertion. A model call anywhere here would be an anti-blind violation. Estimated spend delta: **0 tokens/day, $0/mo.** |
| **Decision** | **ADVANCE** → Stage 3 build (backend ∥ frontend) |
| **Branch** | `feat/members-team-management` · base `feat/shopify-sync-validation` (HEAD includes `43ea557` — verified `git merge-base --is-ancestor 43ea557 HEAD` → true) |

> **The privilege-escalation fix ships first.** Slice 1 = D-6 + D-7 (`createInvite` / `updateMemberRole` hierarchy bounds) + their negative tests. The live hole closes before any new surface is built.

---

## 0. Single-Primitive sweep + locked-pattern check

- **Extend, do not create.** Suspend reuses the **existing** revoke-in-transaction primitive (`rawPgPool` `BEGIN`/`COMMIT` + post-COMMIT audit) already proven in `updateMemberRole` (`invite.service.ts:418-451`) and `removeMember` (`invite.service.ts:533-568`). No new revocation path, no new audit framework, no new notification path.
- **One hierarchy helper.** `hasMinimumRole` (`domain/membership/entities.ts:37`) / `meetsMinimumRole` (`security/rbac.ts:26`) are the ONE authority comparator. D-6/D-7/D-8 all consume it — no per-route hand-rolled comparisons.
- **One invite email path.** Resend reuses `notification.sendInviteEmail` (`invite.service.ts:114`); the I-ST05 send chokepoint is unchanged (non-goal confirmed).
- **No new service, no new stack layer, no new ADR.** Pure completion+hardening inside `apps/core/workspace-access` + `apps/web`. MFA / OIDC stay deferred (ADR-006 / D0.1). **Clean.**

---

## 1. Bindings D-1 … D-11 (each resolved to file:line + signature/SQL)

### D-6 — Hierarchy bound on invite grant (Slice 1, fixes C-1/P1) — LIVE HOLE

**File:** `invite.service.ts:87-95` (`createInvite`).
Import `ROLE_HIERARCHY` from `../domain/membership/entities.js`. After the existing owner-or-brand_admin gate (line 87-89) and BEFORE the `roleCode === 'owner'` guard (line 93), insert:

```ts
// D-6: grant only roles strictly BELOW your own authority. Owner is exempt.
if (inviterMembership.roleCode !== 'owner' &&
    ROLE_HIERARCHY.indexOf(data.roleCode) >= ROLE_HIERARCHY.indexOf(inviterMembership.roleCode)) {
  throw new InviteError('FORBIDDEN', 'Cannot grant a role at or above your own authority.', 403);
}
```

`ROLE_HIERARCHY = ['analyst','manager','brand_admin','owner']` (higher index = more capable). `indexOf(granted) >= indexOf(actor)` is the violation. Owner (`indexOf=3`) is exempt. A `brand_admin` (idx 2) inviting `brand_admin` (idx 2) now `2>=2` → 403. The existing `owner` block at line 93 is kept (defence in depth; sole-owner protection).

### D-7 — Hierarchy bound on role change (Slice 1, fixes C-2/P2) — LIVE HOLE

**File:** `invite.service.ts:367-371` (`updateMemberRole`, inside the open `BEGIN` txn). After the owner-or-brand_admin gate (line 367-371) and BEFORE the target fetch (line 374), insert (using `requesterMembership.role_code` already in scope):

```ts
// D-7: cannot grant a role at or above your own authority. Owner is exempt.
if (requesterMembership.role_code !== 'owner' &&
    ROLE_HIERARCHY.indexOf(newRoleCode) >= ROLE_HIERARCHY.indexOf(requesterMembership.role_code as RoleCode)) {
  await rawClient.query('ROLLBACK');
  throw new InviteError('FORBIDDEN', 'Cannot grant a role at or above your own authority.', 403);
}
```

`ROLLBACK` before throw (txn is open). Owner exempt. This sits before the sole-owner guard so a forbidden grant never reaches the mutation.

### D-8 — `suspendUser` rewrite (Slice 3, fixes C-3/C-4/H-1)

**File:** `auth.service.ts:764-799`. New signature:

```ts
async suspendUser(
  appUserId: string,
  actorId: string,
  organizationId: string,
  brandId: string | null,
  correlationId: string,
): Promise<{ sessionsRevoked: number }>
```

Rewrite body to mirror `removeMember` exactly (`invite.service.ts:485-575`):

1. `if (!this.rawPgPool) throw new AuthError('CONFIGURATION_ERROR', ..., 500);` — **AuthService MUST receive `rawPgPool`.** Verify wiring at `main.ts:304` (already passed as the 5th arg → confirm the constructor stores it as `this.rawPgPool`; if not, add the field). `inviteService` already gets it at `main.ts:307`.
2. `rawClient = await this.rawPgPool.connect(); await rawClient.query('BEGIN');`
3. **Actor authority lookup** (C-4): `SELECT id, organization_id, role_code FROM membership WHERE app_user_id = $1 AND organization_id = $2 AND brand_id IS NULL` for `actorId`. If absent or not owner-or-brand_admin → `ROLLBACK` + `FORBIDDEN` 403.
4. **Target lookup** (C-4 + D-9): `SELECT id, organization_id, app_user_id, role_code FROM membership WHERE app_user_id = $1 AND organization_id = $2 AND brand_id IS NULL`. **D-9 org assertion:** `if (!target || target.organization_id !== organizationId) { ROLLBACK; throw NOT_FOUND 404 }`.
5. **Hierarchy + Owner guard** (C-4): `if (actorRole !== 'owner' && ROLE_HIERARCHY.indexOf(actorRole) <= ROLE_HIERARCHY.indexOf(targetRole)) { ROLLBACK; FORBIDDEN 403 }`. Additionally **explicit**: `if (targetRole === 'owner' && actorRole !== 'owner') { ROLLBACK; FORBIDDEN 403 }`. (An owner suspending an owner is separately blocked by a sole-owner-style check if desired — out of scope; M1 the explicit owner block is sufficient.)
6. **Atomic writes in the open txn (C-3):**
   - `UPDATE user_session SET revoked_at = NOW() WHERE app_user_id = $1 AND revoked_at IS NULL` (capture rowcount via the `WITH revoked AS (...) SELECT COUNT(*)` CTE used at `invite.service.ts:420-428`).
   - `UPDATE app_user SET status = 'suspended', updated_at = NOW() WHERE id = $1`.
   - `COMMIT`.
7. **Audit post-COMMIT (H-1 + M-1):** two `audit.append` calls, **`brand_id: brandId ?? organizationId`** (NOT `appUserId`), `actor_id: actorId`, `actor_role: <actor's looked-up role>`:
   - `action: 'user.suspended'`, `entity_type: 'app_user'`, `entity_id: appUserId`, `payload: { sessions_revoked }`.
   - `action: 'sessions.bulk_revoked'`, `entity_type: 'user_session'`, `entity_id: appUserId`, `payload: { reason: 'user_suspended', count, target_user_id: appUserId }`.
8. `catch → ROLLBACK; finally → rawClient.release()`.

> **suspend uses `app_user.status`, not a membership column** (see §2). `app_user` has RLS **disabled** (`0002_auth.sql:42`) and is user-global — so suspend is a user-global lockout, consistent with the existing `suspendUser` semantics and the requirement ("revokes the target's sessions"). The actor/target authority is enforced via the **membership** row (org-scoped) inside the same txn.

### D-1 — Reactivate is a distinct path (Slice 3)

**New method** `auth.service.ts` `reactivateUser(appUserId, actorId, organizationId, brandId, correlationId)`. **Structurally distinct** from suspend — NOT a shared helper with a flag (D-1). Same authority/org checks (steps 3-5 above). Single write: `UPDATE app_user SET status = 'active', updated_at = NOW() WHERE id = $1` (no session revocation — access restored on next protected action per the requirement). Audit post-COMMIT: `action: 'user.reactivated'`, `brand_id: brandId ?? organizationId`. No `sessions.bulk_revoked` row. (`updateStatus` repo helper at `repositories.ts:111` already accepts `'active'|'suspended'` — but reactivate runs through the rawPgPool path for the authority check + audit-brand correctness, not the auto-commit repo.)

### D-2 — Brand-scope authority from DB, not JWT (Slice 1+3)

Every authority check (D-6/D-7/D-8/D-1) resolves the actor's role **from the `membership` table at request time** (the `SELECT ... FROM membership WHERE app_user_id = $1 ...` already does this in `updateMemberRole`/`removeMember`; D-6 reuses `memberRepo.findByUserAndOrg`). The JWT `auth.role` is used ONLY by the route-level `requireRole` coarse gate — never as the authority source for the grant bound. Stale JWT cannot escalate.

### D-3 — Resend invalidates the old token (Slice 2)

**New method** `inviteService.resendInvite(inviteId, requestingUserId, organizationId, correlationId)`. Uses the GUC-wrapped `pool` (RLS-enforced). Authority: actor must be owner-or-brand_admin (reuse `memberRepo.findByUserAndOrg`). Fetch the pending invite (RLS-scoped); 404 if not pending. **UPDATE the existing row** — `generateToken()` for a fresh `{rawToken, tokenHash}`, then `UPDATE invite SET token_hash = $1, expires_at = $2 WHERE id = $3 AND status = 'pending'` (new `InviteRepository.rotateToken` method). Re-send via `notification.sendInviteEmail`. **No second row.** Audit `invite.resent`, `brand_id: invite.brandId ?? organizationId`.

### D-4 — Pending-invite visibility predicate (Slice 2)

`listPendingInvites` predicate by actor role:
- **owner** → all pending invites in the org (RLS already scopes to org; no extra predicate).
- **brand_admin** → all pending in their brand scope (RLS `invite_brand_level`/`invite_org_level` already scopes; no extra predicate beyond the RLS GUCs).
- **manager / analyst** → only invites they created: `AND invited_by_user_id = $actor`. (Managers/Analysts cannot invite per D-6, so this is mostly the empty set, but the predicate is encoded for correctness.)

Encoded in a new `InviteRepository.listPending(organizationId, brandId, actorRole, actorUserId, ctx)` query: base `WHERE status = 'pending' AND expires_at > NOW()`, append `AND invited_by_user_id = $actor` when `actorRole` is `manager`/`analyst`. RLS provides the org/brand isolation layer underneath.

### D-5 — Branch base (verified)

`feat/members-team-management` off `feat/shopify-sync-validation` (HEAD = `43ea557` "fix(web): unwrap remaining BFF response-envelope mismatches"). Verified ancestor. The `membersApi.list` envelope fix (`client.ts:340-348`) is present → members table renders. **If the e2e shows an empty table, the base is wrong — treat as a false negative, not a pass.**

### D-9 — App-layer org assertion on every rawPgPool path (Slice 3)

Every new rawPgPool path (`suspendUser`, `reactivateUser`) MUST include `if (!target || target.organization_id !== organizationId) { ROLLBACK; throw NOT_FOUND }` at the **same position** as `updateMemberRole:383` / `removeMember:513`. The rawPgPool connection carries no GUC → RLS does not filter → this assertion IS the cross-org guard. (Acceptance contract item; tested by NC-1-style fuzz + a unit test that suspends a target in org-B under actor in org-A → expects 404.)

### D-10 — acceptInvite duplicate guard + partial unique index (Slice 1 migration; Slice 2 guard)

**Two parts:**
1. **Migration** (`0014`): partial unique index on `invite`: `CREATE UNIQUE INDEX CONCURRENTLY ... invite_pending_org_email_uniq ON invite (organization_id, email) WHERE status = 'pending'` (see §2). Prevents dual valid tokens for the same invite slot.
2. **acceptInvite guard** (`invite.service.ts:233-244`, inside the open txn before the membership INSERT): pre-check `SELECT 1 FROM membership WHERE organization_id = $1 AND app_user_id = $2 AND (brand_id = $3 OR ($3 IS NULL AND brand_id IS NULL))`. If a row exists → `ROLLBACK` + `throw new InviteError('ALREADY_MEMBER', 'Already a member of this workspace.', 409)`. (Belt-and-braces: the membership table already has `membership_org_user_uniq` / `membership_org_brand_user_uniq` — a raced INSERT would hit the unique constraint; map the PG `23505` to 409 in the catch, do not leak a 500.)

### D-11 — listPendingInvites carries workspaceId/brandId (Slice 2)

`listPendingInvites` builds its `QueryContext` exactly like `createInvite:70-74`:

```ts
const ctx: QueryContext = {
  correlationId,
  workspaceId: data.organizationId,
  ...(data.brandId ? { brandId: data.brandId } : {}),
};
```

Uses the **GUC-wrapped `pool`** (not rawPgPool) so the compound invite RLS (`invite_org_level` / `invite_brand_level`, `0005_invitation.sql:51-64`) activates. Omitting `workspaceId` → zero rows in prod (silently). **The e2e MUST assert non-zero pending rows after creation** (the dev-superuser false-negative guard, §7).

---

## 2. Data-model delta — migration `0014_member_lifecycle.sql`

**Decision: no new `membership.status` column.** Suspend is `app_user.status='suspended'` (already exists, `0002_auth.sql:28-29`, user-global, RLS-disabled). Membership lifecycle "Suspended" is the **derived view**: a member row whose `app_user.status='suspended'`. Adding a membership status column would create a second source of truth for suspension and a Single-Primitive violation (two suspend mechanisms). **Bound: suspend/reactivate write `app_user.status` only.** "Removed" remains a membership `DELETE` (existing `removeMember`); decision history survives in the append-only `audit_log` (I-S06) — re-inviting a removed email creates a NEW membership on accept (existing INSERT path, no resurrection).

**One migration, additive only (honors I-E02 — no destructive/irreversible op):**

```sql
-- 0014_member_lifecycle.sql
-- D-10: prevent dual valid tokens for the same invite slot (org-level + brand-level).
-- Partial unique on pending invites. Additive; no column drop, no data loss.
-- NOTE: brand-level invites share email across brands — scope must include brand_id.
--       Two indexes mirror the compound-RLS split (NN-7): org-level (brand_id IS NULL)
--       and brand-level (brand_id IS NOT NULL).
CREATE UNIQUE INDEX IF NOT EXISTS invite_pending_org_email_uniq
  ON invite (organization_id, email)
  WHERE status = 'pending' AND brand_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS invite_pending_brand_email_uniq
  ON invite (brand_id, email)
  WHERE status = 'pending' AND brand_id IS NOT NULL;

-- Supporting index for the pending-list query (status + org, keyset by id).
CREATE INDEX IF NOT EXISTS invite_status_org_idx
  ON invite (organization_id, status) WHERE status = 'pending';
```

- **No RLS change** — `invite` compound RLS (`0005:51-64`) and `membership` RLS (`0003:87-89`) are unchanged and already fail-closed two-arg. The migration adds **indexes only**.
- **Rollback:** `DROP INDEX IF EXISTS invite_pending_org_email_uniq, invite_pending_brand_email_uniq, invite_status_org_idx;` — pure index drops, zero data impact. Provide as the `down` (node-pg-migrate sequential file `0014`).
- **Index build caveat:** `CREATE UNIQUE INDEX` (without `CONCURRENTLY`, since node-pg-migrate runs each migration in a txn) will fail if duplicate pending rows already exist. **Pre-flight in the migration:** a `DO` block that `RAISE EXCEPTION` if `SELECT (organization_id, email) ... GROUP BY ... HAVING count(*) > 1 WHERE status='pending'` returns rows — fail loud with a remediation message rather than silently. (Backend track: add the guard block; M1 dev data has no dupes.)
- **NN-1 assertion block:** not required (no new policy), but keep the migration header doc-ref style consistent with `0013`.

---

## 3. API-contract delta

### Response envelope — ONE consistent wrapping (kills the recurring mismatch class)

**Bound for ALL new routes:** the BFF/core success envelope is `{ request_id, <key>: <payload> }` (the existing house style — `invite`, `member`, `members`). The **frontend client unwraps `<key>`** in `client.ts` (mirroring `membersApi.list` at `client.ts:340-348` and `brandsApi.get` at `client.ts:307-310`). New keys:

| Route | Core success envelope | `client.ts` unwrap → returns |
|---|---|---|
| `GET /api/v1/invites?status=pending` | `{ request_id, invites: InviteResponse[], next_cursor, has_more }` | `membersApi.listPendingInvites()` → `PaginatedResponse<InviteResponse>` (`{ data: res.invites, next_cursor, has_more }`) |
| `POST /api/v1/invites/:id/resend` | `{ request_id, invite: InviteResponse }` | `membersApi.resendInvite(id)` → `res.invite` |
| `POST /api/v1/invites/:id/revoke` | `204 No Content` | `membersApi.revokeInvite(id)` → void |
| `POST /api/v1/members/:id/suspend` | `{ request_id, member: { ..., user_status: 'suspended' } }` | `membersApi.suspendMember(id)` → `res.member` |
| `POST /api/v1/members/:id/reactivate` | `{ request_id, member: { ..., user_status: 'active' } }` | `membersApi.reactivateMember(id)` → `res.member` |

> **Existing field-name mismatch to fix while here (latent bug, no regression):** `member.routes.ts` `GET /members` returns `email` (`member.routes.ts:157`), but `MemberResponse` (`types.ts:160-169`) + `members-table.tsx:131-132` read `user_email`/`user_full_name`. Backend MUST add `user_email` (alias of the joined `u.email`) and `user_status` (from `app_user.status`) to the `GET /members` row, and a `user_full_name` (use `u.email` as a placeholder if `app_user` has no name column — **verify**; do not invent a column). The frontend suspend badge depends on `user_status`. **Contract-first (I-E01):** update `packages/contracts/src/api/member.api.v1.ts` `MemberSchema` (add `user_email`, `user_full_name`, `user_status: z.enum(['active','suspended'])`) + add `ListPendingInvitesResponseSchema`, `ResendInviteResponseSchema` BEFORE backend code (CODEOWNERS gate).

### New routes (all `apps/core/.../member.routes.ts`, all behind `sessionPreHandler`)

| Method + path | RBAC guard (route) | Service call | Notes |
|---|---|---|---|
| `GET /api/v1/invites?status=pending` | `requireRole('manager')` then service-level D-4 predicate | `inviteService.listPendingInvites({ organizationId, brandId, requestingUserId }, cid)` | org = `auth.workspaceId` (reject query-param mismatch, mirror `member.routes.ts:131-136`). Keyset cursor, no OFFSET (I-ST04/contract rule). |
| `POST /api/v1/invites/:id/resend` | `requireRole('brand_admin')` | `inviteService.resendInvite(id, auth.userId, org, cid)` | Idempotency-Key required (I-ST04). |
| `POST /api/v1/invites/:id/revoke` | `requireRole('brand_admin')` | `inviteService.revokeInvite(id, auth.userId, org, cid)` → `UPDATE invite SET status='revoked' WHERE id=$1 AND status='pending'` (GUC pool, RLS) + audit `invite.revoked` | 204. |
| `POST /api/v1/members/:id/suspend` | `requireRole('brand_admin')` + **service authority check (D-8) is the real guard** | resolve target `app_user_id` + `brand_id` from `:id` membership, then `authService.suspendUser(targetAppUserId, auth.userId, org, brandId, cid)` | route guard necessary-not-sufficient (C-4). |
| `POST /api/v1/members/:id/reactivate` | `requireRole('brand_admin')` + service authority check | `authService.reactivateUser(targetAppUserId, auth.userId, org, brandId, cid)` | access restored on next protected action. |

> **`:id` is the membership id** (the table renders membership ids). suspend/reactivate routes resolve `membership.app_user_id` (and `brand_id`) from `:id` before calling the auth service — the route handler does the membership→app_user lookup (or passes membership-id and lets `suspendUser` resolve; bind: the **route** resolves membership row via a GUC-pool read so RLS scopes it, then passes `app_user_id` + `brand_id` to the rawPgPool service path which re-asserts org via D-9). The double lookup (RLS read at route + app-layer assert in service) is the defence-in-depth.

> **`member.routes.ts` currently imports neither `requireRole` nor a per-route role guard** — it relies only on `sessionPreHandler`. Add `requireRole` from `../../security/rbac.js` to the new routes' `preHandler` arrays. Existing routes' guards stay as-is (in-service authority checks already present); do NOT change PATCH/DELETE behaviour beyond D-7.

### Changed surfaces (no signature break beyond additive fields)

- `createInvite` (D-6), `updateMemberRole` (D-7): internal logic only; route + contract unchanged.
- `suspendUser` (D-8): **signature change** — adds `organizationId`, `brandId` params. Only caller today is... none (no route). New route is the sole caller → not a public-surface break (no Engineering-Advisor sign-off needed). The journal notes this.

---

## 4. Slices (smallest safe increments — security first)

### Slice 1 — LIVE privilege-escalation fix + index (ships first, independently deployable)
- `createInvite` D-6 bound + import `ROLE_HIERARCHY` (`invite.service.ts:87-95`).
- `updateMemberRole` D-7 bound (`invite.service.ts:367-371`).
- Migration `0014_member_lifecycle.sql` (the two partial unique indexes + support index + duplicate pre-flight guard).
- Unit tests: NC-style hierarchy tests (brand_admin grants brand_admin → 403 on both paths; owner grants any → 200; brand_admin grants manager → 200).
- **Acceptance:** the live hole is closed and verifiable by a red→green test before any new route exists.

### Slice 2 — Pending-invite visibility + resend + revoke (D-3/D-4/D-11/D-10-index-dependent)
- `InviteRepository.listPending` (D-4 predicate), `InviteRepository.rotateToken` (D-3).
- `inviteService.listPendingInvites` (D-11 ctx), `resendInvite` (D-3), `revokeInvite`.
- `acceptInvite` duplicate guard (D-10 part 2, `invite.service.ts:233-244`) + `23505`→409 mapping.
- Routes: `GET /invites?status=pending`, `POST /invites/:id/resend`, `POST /invites/:id/revoke`.
- Contract: `member.api.v1.ts` additions (pending list + resend response + `InviteResponse` already exists).

### Slice 3 — Suspend / reactivate lifecycle + immediate revocation (D-1/D-8/D-9 + H-1/M-1)
- `auth.service.ts`: rewrite `suspendUser` (D-8), add `reactivateUser` (D-1). Confirm/ensure `AuthService` stores `rawPgPool`.
- `GET /members` row: add `user_email`, `user_full_name`, `user_status` (field-mismatch fix).
- Routes: `POST /members/:id/suspend`, `POST /members/:id/reactivate`.
- Contract: `MemberSchema` + member.routes envelope.

### Slice 4 — Frontend lifecycle UI + e2e
- members-table: suspend/reactivate actions (gated by `user_status` + hierarchy), role-change select hierarchy gating, pending-invites section, resend/revoke.
- `client.ts` + `use-members.ts` new hooks. Playwright lifecycle e2e (§7).

> Slices 1-3 are backend, deployable in order. Slice 4 (frontend) depends on Slice 2+3 contracts. Slice 1 is the security gate and merges first.

---

## 5. Build tracks + acceptance contracts

### `@backend-developer` — routes / service / migration / RLS / tests (Slices 1-3)

**Scope:** `invite.service.ts`, `auth.service.ts`, `member.routes.ts`, `repositories.ts` (InviteRepository), `db/migrations/0014_member_lifecycle.sql`, `packages/contracts/src/api/member.api.v1.ts`, core tests.

**Acceptance contract (every item REQUIRED pass-1 — folds in all persona must-fix):**
1. **[D-6 / C-1]** `createInvite`: brand_admin granting `brand_admin` (or `owner`) → 403; owner granting any → ok; brand_admin granting `manager`/`analyst` → ok. `ROLLBACK`-free (GUC pool path). Test red→green.
2. **[D-7 / C-2]** `updateMemberRole`: same matrix; `ROLLBACK` before throw (open txn). Owner exempt. Test red→green.
3. **[D-8 / C-3]** `suspendUser` rewritten on `rawPgPool` `BEGIN/COMMIT`: session revoke + `app_user.status='suspended'` in ONE txn. **No two-commit window.** Verify `AuthService` has `rawPgPool` wired (`main.ts:304`).
4. **[D-8 / C-4]** `suspendUser` looks up actor + target membership, asserts actor outranks target, **explicitly blocks a non-owner suspending an owner** → 403. Route guard alone is insufficient (must be in service).
5. **[D-8 / H-1 + M-1]** suspend audit is **post-COMMIT**, `brand_id: brandId ?? organizationId` (NEVER `appUserId`), two rows (`user.suspended` + `sessions.bulk_revoked`).
6. **[D-1]** `reactivateUser` is a **separate method** (not a flag on suspend), writes `status='active'`, NO session revoke, audit `user.reactivated` with correct `brand_id`.
7. **[D-9]** every rawPgPool path (suspend, reactivate) has `target.organization_id !== organizationId → 404` at the same position as `removeMember:513`. Cross-org suspend (actor org-A, target org-B) → 404.
8. **[D-10]** migration `0014` adds the two partial unique indexes (org-level + brand-level) + support index + duplicate pre-flight `RAISE`. `acceptInvite` has the active-membership pre-check → 409 and maps PG `23505` → 409 (no 500 leak).
9. **[D-3]** `resendInvite` rotates token_hash + expires_at on the **existing** row (no second row); re-sends email; audit `invite.resent`.
10. **[D-4 / D-11]** `listPendingInvites` ctx carries `workspaceId` (+brandId); predicate adds `invited_by_user_id = $actor` for manager/analyst; uses GUC pool (RLS active).
11. **[D-5]** branch off `feat/shopify-sync-validation`; confirm `43ea557` present.
12. **[contract / I-E01]** `member.api.v1.ts` updated + codegen committed BEFORE service code; `MemberSchema` gains `user_email`, `user_full_name`, `user_status`; new pending-list + resend response schemas.
13. **[envelope]** all new routes use `{ request_id, <key>: ... }`; suspend/reactivate return `member` with `user_status`.
14. **[M-2]** confirm `/api/v1/dev/last-email-link` registration stays gated by `nodeEnv !== 'production'` (`main.ts:319`) — do not regress; no plaintext token column anywhere (I-S09 clean).
15. **[deploy]** migration runs ahead of core deploy; rollback `down` provided (§8).
16. **The 6 negative-control tests (§7) pass under `SET ROLE brain_app`** — run live-PG, not as superuser `brain`.

### `@frontend-web-developer` — members table lifecycle + pending section + e2e (Slice 4)

**Scope:** `apps/web/components/members/members-table.tsx`, `invite-member-dialog.tsx`, a new pending-invites section, `lib/hooks/use-members.ts`, `lib/api/client.ts` (`membersApi`), `lib/api/types.ts`, `app/(dashboard)/settings/members/page.tsx`, `e2e/members-lifecycle.spec.ts`.

**Acceptance contract (every item REQUIRED pass-1):**
1. **[D-5]** verify the table renders (base includes `43ea557`); `membersApi.list` unwrap intact.
2. members-table: **Suspend** action when `member.user_status === 'active'` and target outranked by current user; **Reactivate** when `user_status === 'suspended'`. A suspended row is visually distinct (Badge). Owner row: no suspend/remove (existing pattern, `members-table.tsx:143`).
3. **Role-change select hierarchy gating** (D-6/D-7 mirrored client-side): the role dropdown (`members-table.tsx:195`) offers only roles **strictly below** the current user's role (owner sees all-but-owner; brand_admin sees manager/analyst only). Client gating is UX only — server is authoritative; a 403 from the server surfaces a toast, never a silent failure.
4. **Pending-invites section**: lists `GET /invites?status=pending` (empty/loading/error states), each row with **Resend** + **Revoke** actions. New `usePendingInvites`, `useResendInvite`, `useRevokeInvite` hooks + `membersApi.listPendingInvites/resendInvite/revokeInvite`.
5. **[envelope]** client unwraps `<key>` for every new call (`res.invites`, `res.invite`, `res.member`) — no raw envelope leaks to components.
6. `MemberResponse` type gains `user_status: 'active'|'suspended'`; `InviteResponse` type added (status, email, role_code, expires_at).
7. **[e2e / D-11 guard]** Playwright `members-lifecycle.spec.ts` (§7): full lifecycle + **asserts non-zero pending rows after invite** (the dev-superuser false-negative guard) + asserts suspended member cannot proceed (session revoked).
8. mobile-responsive table actions; all dialogs keep the existing a11y pattern (aria-labelledby/describedby).

---

## 6. Alternatives considered + rejection

| Alternative | Rejected because |
|---|---|
| **Add `membership.status` column for suspend** | Two sources of truth for suspension (`app_user.status` + `membership.status`) → Single-Primitive violation + a migration touching a core table. `app_user.status` already exists and is the user-global lockout the requirement describes. **Rejected.** |
| **Shared `setUserStatus(status)` helper for suspend+reactivate** | D-1 explicitly forbids a shared-helper-with-flag; the two paths differ (suspend revokes sessions, reactivate does not; different audit actions). Distinct methods keep the revocation-on-suspend invariant un-flaggable. **Rejected.** |
| **Hierarchy bound only at the route guard (`requireRole`)** | `requireRole` checks the JWT role coarsely; it cannot bound *granted* role vs *actor* role, and the JWT is stale (D-2). The bound MUST be in-service against the DB membership row. **Rejected** (this is exactly C-1/C-2/C-4). |
| **suspendUser stays on the auto-commit `pool` with two writes** | The two-commit crash window (C-3/F1) lets a suspended user re-login. **Rejected** — must be one rawPgPool txn. |
| **Single partial unique index `(organization_id, email) WHERE status='pending'`** | Misses brand-level invites (same email across brands in one org is legitimate). Split into org-level + brand-level mirrors the NN-7 compound-RLS shape. **Rejected the single-index form.** |

---

## 7. Test strategy

### 7.1 — The 6 mandatory negative-controls (live-PG, `SET ROLE brain_app` + 3-GUC; isolation-fuzz style)
Model on `family-wipe.live.test.ts` (the canonical pattern: `tryConnect`, skip-if-no-DB, `SET ROLE brain_app`, `set_config('app.current_*_id', ...)`). New file `apps/core/src/modules/workspace-access/tests/member-lifecycle.live.test.ts`:

| NC | Assertion (under `SET ROLE brain_app`) |
|---|---|
| NC-1 | `SET app.current_workspace_id='<org-A>'; SELECT * FROM membership WHERE organization_id='<org-B>'` → 0 rows |
| NC-2 | no GUCs; `SELECT * FROM invite WHERE status='pending'` → 0 rows (fail-closed) |
| NC-3 | `SET app.current_workspace_id='<org-A>'` only; `SELECT * FROM invite WHERE status='pending'` → only org-A org-level, 0 org-B rows |
| NC-4 | after `suspendUser`: `SELECT * FROM user_session WHERE app_user_id='<target>' AND revoked_at IS NULL AND expires_at>NOW()` → 0; `app_user.status='suspended'` |
| NC-5 | after suspend: `findActiveByJti(<target jti>)` → null (no cache window; DB hit every call — DEFENDED, confirm) |
| NC-6 | after suspend: `SELECT brand_id, action FROM audit_log WHERE action IN ('user.suspended','sessions.bulk_revoked')` → `brand_id = organizationId`, NOT `appUserId` (requires D-8) |

### 7.2 — Unit tests (live-PG)
- Hierarchy bounds (D-6/D-7) full matrix — red without the bound, green with it (non-inert negative control).
- Suspend atomicity (D-8): assert single-txn (e.g. inject a failure after session-revoke → status must NOT be `suspended` and sessions NOT revoked, i.e. rolled back together).
- D-9 cross-org: actor org-A suspends target org-B → 404.
- D-10: second `acceptInvite` for an already-active membership → 409 (not 500); concurrent dup pending invite → unique-violation surfaces cleanly.

### 7.3 — Playwright lifecycle e2e (`apps/web/e2e/members-lifecycle.spec.ts`)
Uses the dev email-token helper (`GET /api/v1/dev/last-email-link?email=`) to accept in-browser. Flow: invite → **assert pending row appears (non-zero — D-11 false-negative guard)** → accept (via captured token) → member listed → change role (hierarchy-gated dropdown) → suspend (assert the suspended member's next protected action is rejected — session revoked) → reactivate → remove; separately revoke a pending invite (assert it leaves the pending list). Reuse `e2e/helpers/db.ts` + `onboard.ts`. **A green run with an empty members table = the D-5 base is wrong (false negative) — fail the run.**

> **Dev-superuser caveat (durable rule):** the live tests connect as `brain_app` explicitly, never rely on the dev superuser `brain` (which bypasses RLS). NC-2/NC-3 are meaningless as superuser.

---

## 8. Deploy track (affected-only; migration → core → web; rollback handles)

| Step | Action | Rollback handle |
|---|---|---|
| 1 | **Migration `0014`** via node-pg-migrate (`pnpm --filter @brain/db migrate up`). Additive indexes only. | `migrate down` → `DROP INDEX IF EXISTS invite_pending_org_email_uniq, invite_pending_brand_email_uniq, invite_status_org_idx;` (zero data impact). |
| 2 | **Deploy `apps/core`** (affected-only build → image → per-service deploy app → canary → auto-rollback on 5xx/error-rate alarm). Slice 1 (escalation fix) deployable independently before Slices 2-3. | Re-deploy previous core image; the migration is forward-compatible with old code (indexes don't break old INSERTs unless a true dup-pending exists — pre-flight guard catches that pre-deploy). |
| 3 | **Deploy `apps/web`** after core contracts live (new routes + fields). | Re-deploy previous web image; new UI degrades gracefully (suspend/pending sections absent). |

- **Ordering invariant:** migration before core (new `acceptInvite` 409 path + pending-list query depend on the indexes); core before web (web calls the new routes/fields).
- **Contract gate (I-E01):** `member.api.v1.ts` change + codegen committed in Slice's first commit; CODEOWNERS approval required.
- **No deploy-all** — affected-only (`turbo --affected`).

---

## In-lane DoD (self-check)

- [x] All sections filled; no `{{TBD}}`. Cost paradigm Tier 0 declared + justified. Single-Primitive sweep clean.
- [x] Tenant isolation at every layer (RLS + D-9 app-layer org assert on rawPgPool) + observability (audit rows) + real-network smoke (live-PG NC tests + Playwright) in test strategy.
- [x] ≥1 alternative + rejection (§6). Reversible migration (index-only `down`). Cost estimate (0 tokens/day, $0/mo).
- [x] Every persona must-fix (C-1..C-5, H-1..H-3, M-1, M-2 / P1..P7, F1..F6) folded into the backend acceptance contract as REQUIRED pass-1 items.
- [x] Tracks have file:line tasks; security slice first; deploy track present.
- [x] Over-engineering self-check: PASS — no new column, no new service, no new ADR, reuses existing revocation primitive.

---

**HANDOFF below in the agent message.**
</content>
