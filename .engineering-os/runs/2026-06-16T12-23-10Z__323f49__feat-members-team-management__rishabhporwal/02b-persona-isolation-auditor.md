# Persona Review: Isolation & Revocation Auditor
## feat-members-team-management

| Field | Value |
|---|---|
| **Persona** | Isolation & Revocation Auditor |
| **req_id** | `feat-members-team-management` |
| **Reviewed at** | 2026-06-16T13:00:00Z |
| **Decision** | PASS (concerns surfaced — architect must address before implementation) |
| **Concerns surfaced** | 6 |
| **Top finding** | F1:CRITICAL — suspendUser two-phase commit window: session revocation and app_user status update are two separate DB operations with no BEGIN/COMMIT wrapping them |

---

## Journal stub

```
2026-06-16T13:00:00Z — Persona:isolation-auditor — feat-members-team-management
Angle: Revocation atomicity + RLS isolation under brain_app + token/audit chain · Top concern: suspendUser is NOT atomic — two sequential un-transacted writes create a crash window where sessions are revoked but status remains active (or vice versa) · Severity: CRITICAL
```

---

## Finding Summary

| ID | Severity | Title | Verdict |
|---|---|---|---|
| F1 | CRITICAL | suspendUser revoke + status update NOT in a single transaction | GAP |
| F2 | CRITICAL | membership_isolation RLS single-policy cannot filter by brand_id — cross-org member list is possible if workspace_id GUC is wrong | GAP (partial) |
| F3 | HIGH | suspendUser audit brand_id uses app_user_id not org/brand — audit chain NN-6 brand_id mandatory violated | GAP |
| F4 | HIGH | Pending-invites list route does not yet exist — no RLS enforcement to verify; a no-GUC call to the future invite list query leaks all pending invites | GAP (future path) |
| F5 | MED | acceptInvite audit written AFTER COMMIT — audit failure does not roll back membership; but also audit OUTSIDE txn means no brand_id integrity check at write time | DEFENDED (by design, documented) / partial GAP for suspend path |
| F6 | MED | Invite token plaintext returned to email client and also exposed via dev email-token helper — rawToken is safe in transit but the dev helper is a cleartext recovery oracle in dev | DEFENDED in prod / DEV EXPOSURE noted |

---

## Detailed Findings

### F1 — CRITICAL — suspendUser is NOT atomic: two-commit window

**File:** `apps/core/src/modules/workspace-access/internal/application/auth.service.ts:764–799`

**Evidence:**

```typescript
// auth.service.ts:764-799
async suspendUser(appUserId: string, actorId: string, correlationId: string): Promise<void> {
  const ctx: QueryContext = { correlationId, userId: actorId };
  const client = await this.pool.connect();  // <-- GUC-wrapped pool, auto-commit mode
  try {
    const sessionRepo = new UserSessionRepository(client);
    const userRepo = new AppUserRepository(client);

    // Revoke all sessions first.
    const count = await sessionRepo.revokeAllForUser(appUserId, { ...ctx, userId: appUserId });
    // ↑ COMMIT 1: sessions revoked

    // Mark user suspended.
    await userRepo.updateStatus(appUserId, 'suspended', ctx);
    // ↑ COMMIT 2: status written
```

The `pool` used here is the GUC-middleware-wrapped pool (standard auto-commit pool), not a `rawPgPool` with explicit BEGIN/COMMIT. There is **no transaction wrapping these two operations**. They are two sequential auto-commit writes.

**Crash window exploit:**
1. `revokeAllForUser` executes and commits — sessions are revoked.
2. Process crashes / network error / Postgres error before `updateStatus` executes.
3. Result: all sessions are revoked (user is effectively locked out) BUT `app_user.status` remains `'active'`.
4. User can log in again, receives a fresh session, and re-enters — suspend was silently incomplete.

Alternatively, the reverse window is not possible here (status write happens second), but the asymmetric window is still exploitable. A user who knows their session was just revoked (e.g. they received a disconnect) can log in during this window before the status write lands.

**Contrast with the DEFENDED pattern:**
- `updateMemberRole` (invite.service.ts:341): uses `rawPgPool`, explicit `BEGIN`, inline `UPDATE user_session SET revoked_at = NOW()` and `UPDATE membership SET role_code` in the same CTE block, then `COMMIT` (lines 354–431).
- `removeMember` (invite.service.ts:476): identical atomic pattern (lines 485–548).
- `suspendUser` does NOT follow this pattern.

**Required fix:** Wire `suspendUser` to use `rawPgPool` with explicit `BEGIN/COMMIT`, with both `UPDATE user_session ... WHERE app_user_id = $1 AND revoked_at IS NULL` and `UPDATE app_user SET status = 'suspended' WHERE id = $1` inside the same transaction. Then append audit AFTER commit (matching the established pattern). This is the identical wiring described in CF-01 of the CTO Advisor review — the code confirms it is not yet done.

**Severity: CRITICAL** — A suspended member can log in again during the crash window. This is the gap CF-01 named; the code confirms it is real.

---

### F2 — CRITICAL — membership RLS is workspace-scoped only; a wrong-workspace GUC exposes another org's members

**File:** `db/migrations/0003_workspace.sql:87–89`

```sql
CREATE POLICY membership_isolation ON membership
  AS PERMISSIVE FOR ALL TO brain_app
  USING (organization_id = current_setting('app.current_workspace_id', TRUE)::uuid);
```

**Observation:** The RLS policy on `membership` is correctly fail-closed (two-arg `current_setting(..., TRUE)`): if the GUC is unset, the expression evaluates to `NULL::uuid`, the predicate is false, and zero rows are returned. This is **DEFENDED** for the no-GUC case.

**Partial GAP — wrong GUC, not missing GUC:** If middleware sets `app.current_workspace_id` to the requesting user's authenticated workspace from their JWT, this is correct. However, the `updateMemberRole` and `removeMember` code paths in `invite.service.ts` use `rawPgPool` with **no GUC set at all** (raw client, no GUC middleware). The queries execute as `rawPgPool.connect()` — an unrolled connection that bypasses GUC middleware.

```typescript
// invite.service.ts:353-354 (updateMemberRole)
const rawClient: PoolClient = await this.rawPgPool.connect();
const ctx: QueryContext = { correlationId, workspaceId: organizationId };
// ctx.workspaceId is passed but rawClient is NOT the GUC-middleware pool
```

In the `rawClient` path the organization isolation is enforced at the **application layer** (line 383: `if (!target || target.organization_id !== organizationId)`) rather than at the DB layer under RLS. This is a deliberate architectural choice with a comment, but it means these queries run with no RLS filter — they see ALL membership rows. The only guard is the service-layer assertion.

Under `SET ROLE brain_app` on a raw connection with no GUC set, the `membership_isolation` policy's `current_setting('app.current_workspace_id', TRUE)` returns NULL, so the predicate is false and **zero rows would be returned** — the query `SELECT ... FROM membership WHERE id = $1` on line 374 would return empty, causing a 404. This is actually fail-safe, but means the raw-client path relies on a "happens to be safe because RLS blocks everything" side-effect rather than an intentional positive grant.

**What this means for the new suspend path:** When the architect wires `suspendUser` into the member route using `rawPgPool`, they must be aware that **the GUC will not be set** on the raw client. The membership fetch to confirm the actor's authority (which `updateMemberRole` and `removeMember` do inline with `rawClient.query(...)` directly) bypasses RLS. This is the established pattern but must be documented and must not regress — specifically the application-layer org check `target.organization_id !== organizationId` at line 383 and 513 must be present in any suspend implementation.

**Negative control for QA:** Under `SET ROLE brain_app` with `app.current_workspace_id` set to org-B's ID, a SELECT on `membership WHERE organization_id = org-A-uuid` must return zero rows, not org-A's members.

**Severity: CRITICAL** for any implementation that omits the application-layer org assertion in the rawPgPool path; DEFENDED if the pattern is followed correctly.

---

### F3 — HIGH — suspendUser audit uses app_user_id as brand_id — violates NN-6 (brand_id mandatory)

**File:** `apps/core/src/modules/workspace-access/internal/application/auth.service.ts:777–795`

```typescript
await this.audit.append({
  brand_id: appUserId,  // <-- app_user_id used as brand_id!
  actor_id: actorId,
  actor_role: 'system',
  action: 'user.suspended',
  ...
});
```

**Evidence from existing pattern:** `updateMemberRole` (invite.service.ts:434) correctly uses `brand_id: organizationId`. `removeMember` (invite.service.ts:551) also uses `brand_id: organizationId`. Both the `user.registered` and `user.email_verified` audit rows in auth.service.ts (lines 197, 238) use `brand_id: user.id` as a "pre-brand placeholder" for events that genuinely have no brand context yet.

However, **the suspend action is a membership lifecycle event performed by an actor in an org context**. The caller (the new member-suspend route) will have the `organizationId` (and potentially `brandId`) in context. Passing `appUserId` as `brand_id` means:
1. The audit row does not participate in the correct brand's hash chain (the chain is keyed by `(brand_id, seq)` per INVARIANTS I-S06 and COMPLIANCE audit-trail section).
2. A future chain-walk will show a suspend event under the target user's "brand" (their user ID), not under the org/brand where the suspension was acted upon.
3. NN-6 (brand_id mandatory) is not technically violated by passing a UUID — but the semantic meaning is wrong, and the chain is fragmented across user-scoped rows instead of brand-scoped rows.

**Required fix:** When the new member-suspend route calls `suspendUser`, it must pass the `organizationId` (and `brandId` if applicable) so the audit entry uses the correct brand context. The simplest fix is to add `organizationId: string` and `brandId: string | null` parameters to `suspendUser`, matching the signature of `removeMember`.

**Severity: HIGH** — Audit chain integrity (I-S06) is compromised for suspend events; chain walks will fail to associate suspend actions with the correct brand.

---

### F4 — HIGH — Pending-invites list route does not yet exist; RLS exposure is unverifiable but the failure mode is a cross-org leak

**Files:** `apps/core/src/modules/workspace-access/internal/application/invite.service.ts` (no `listPendingInvites` method exists), `db/migrations/0005_invitation.sql:51–64`

The invite table has compound RLS (NN-7, two PERMISSIVE policies):
- `invite_org_level`: `brand_id IS NULL AND organization_id = current_setting('app.current_workspace_id', TRUE)::uuid`
- `invite_brand_level`: `brand_id IS NOT NULL AND brand_id = current_setting('app.current_brand_id', TRUE)::uuid`

Both use fail-closed two-arg `current_setting`. Under `SET ROLE brain_app` with no GUCs set, a SELECT on `invite` returns zero rows — **this is DEFENDED at the DB layer**.

**The GAP is in the new route implementation that does not yet exist:**

When the architect implements `listPendingInvites`, the query context (`ctx`) must carry both `workspaceId` AND `brandId` (if the request is brand-scoped) to activate the correct policy. The current `createInvite` implementation at line 70–74 shows how the ctx is built:

```typescript
const ctx: QueryContext = {
  correlationId,
  workspaceId: data.organizationId,
  ...(data.brandId ? { brandId: data.brandId } : {}),
};
```

If the new `listPendingInvites` handler omits `workspaceId` from the ctx (common mistake — a developer passes only `brandId` for a brand-level route), the `invite_org_level` policy will not activate, but neither will `invite_brand_level` match brand-level invites without `brandId`. The result would be zero rows (fail-safe) — but only because RLS returns nothing when GUCs are absent.

**The real risk is the converse: if the GUC middleware sets `app.current_workspace_id` correctly but the developer does NOT scope the query to the current org** (e.g., a query `WHERE status = 'pending'` with no `organization_id` filter), and the GUC is set, RLS activates and the user sees only their org's invites. This is correct.

**The failure mode to test:** Under `SET ROLE brain_app` with `app.current_workspace_id` = org-A, a `SELECT * FROM invite WHERE status = 'pending'` must NOT return org-B's pending invites. This is the negative control the QA/security stage must run.

**Severity: HIGH** — The route does not yet exist, so the finding is prospective. But if the implementation forgets to pass `workspaceId` in ctx or queries the wrong pool, the RLS safety net is the only protection — and the dev superuser trap means dev tests would not catch this.

---

### F5 — MED — Audit writes outside the commit transaction for updateMemberRole / removeMember; suspend path will inherit the same pattern

**File:** `apps/core/src/modules/workspace-access/internal/application/invite.service.ts:433–451` (updateMemberRole), `550–568` (removeMember)

Both methods write audit AFTER `COMMIT`:

```typescript
await rawClient.query('COMMIT');  // line 431

// (c) Audit — after commit so audit failures don't roll back membership.
await this.audit.append({...});   // lines 434, 443
```

The comment explicitly documents this as a deliberate choice: audit failure should not roll back the membership change.

**Defended aspect:** This matches the pattern used for `session.rotated` audit in auth.service.ts:519 (also post-commit). The semantics are consistent and intentional.

**Partial GAP for the upcoming suspend route:** The new suspend implementation must follow the same post-commit audit pattern. If a developer wires the audit INSIDE the transaction (before COMMIT), an audit write failure will roll back the session revocation — leaving the user's sessions un-revoked with no error visible to the caller. This would be a silent revocation failure.

Additionally: the `acceptInvite` method (invite.service.ts:255–267) writes audit AFTER COMMIT but uses `this.audit.append` with `brand_id: inviteRow.brand_id ?? inviteRow.organization_id`. This is the correct brand_id fallback pattern. The new suspend audit must use the same fallback.

**Severity: MED** — The existing pattern is safe by design; the risk is the new implementation failing to follow it.

---

### F6 — MED — Dev email-token helper is a cleartext token recovery oracle

**File:** `apps/core/src/modules/workspace-access/internal/application/invite.service.ts:114`

```typescript
await this.notification.sendInviteEmail(data.email, rawToken, correlationId);
```

The `rawToken` (64-char hex, 256 bits of entropy) is passed to the notification service, which in dev mode delivers it via `GET /api/v1/dev/last-email-link`. The DB stores only `tokenHash` (sha256 of rawToken) — **DEFENDED per I-S09**.

**Dev exposure:** The `/dev/last-email-link` endpoint exists specifically to expose the rawToken in dev. This is documented and intentional for the Playwright e2e. However:
1. If this endpoint is ever reachable in staging or production (misconfigured route guard), it becomes a token-harvesting vector.
2. The endpoint should have an environment guard (`NODE_ENV === 'development'` or equivalent) enforced at the route level, not just by convention.

**Token at rest is DEFENDED:** `db/migrations/0005_invitation.sql:35` — `token_hash TEXT NOT NULL` — no plaintext column. The `invite_token_hash_unique` UNIQUE constraint on `token_hash` (line 36) prevents hash collision reuse. I-S09 is met.

**Severity: MED** — Only a concern if the dev route leaks to non-dev. The primary finding (DB stores hash, not plaintext) is clean.

---

## RLS Negative-Control Tests Required Under SET ROLE brain_app

The QA and Security review stages MUST run the following tests under `SET ROLE brain_app` (not as the superuser `brain`). Dev DB connects as superuser `brain` which BYPASSES RLS — none of these tests are meaningful unless run as `brain_app` with the three-GUC tenant context.

### NC-1: membership table — no cross-org leak

```sql
-- Setup: org-A and org-B exist with members
SET ROLE brain_app;
SET app.current_workspace_id = '<org-A-uuid>';
SET app.current_user_id = '<user-in-org-A-uuid>';
SET app.current_brand_id = '<brand-in-org-A-uuid>';

-- Must return ONLY org-A members, zero org-B rows
SELECT * FROM membership;  -- must not include org-B rows

-- Must return zero rows
SELECT * FROM membership WHERE organization_id = '<org-B-uuid>';
```

### NC-2: invite table — no-GUC returns zero rows

```sql
SET ROLE brain_app;
-- No GUCs set
SELECT * FROM invite;  -- must return 0 rows (fail-closed)
SELECT * FROM invite WHERE status = 'pending';  -- must return 0 rows
```

### NC-3: invite table — org-scoped pending list does not leak other org

```sql
SET ROLE brain_app;
SET app.current_workspace_id = '<org-A-uuid>';
SET app.current_user_id = '<user-in-org-A-uuid>';
-- brand_id GUC NOT set (org-level invite list)

-- Must return ONLY org-A's org-level (brand_id IS NULL) pending invites
SELECT * FROM invite WHERE status = 'pending';
-- Must NOT include org-B's pending invites
```

### NC-4: user_session revocation — verified immediately after suspend

```sql
-- After suspendUser(target_user_id) completes:
SET ROLE brain_app;
SET app.current_user_id = '<target-user-uuid>';

-- Must return 0 active sessions
SELECT * FROM user_session WHERE revoked_at IS NULL AND expires_at > NOW();

-- Must return 'suspended' status
-- (checked via service layer, not direct app_user query — app_user has no RLS)
```

### NC-5: validateSession rejects revoked session on next request

After `suspendUser` or `removeMember` completes, the target user's `jti` must be rejected by `validateSession` on the very next call. This is DEFENDED: `UserSessionRepository.findActiveByJti` (repositories.ts:195–213) queries `WHERE jti = $1 AND revoked_at IS NULL AND expires_at > NOW()` — the revoked session will return null immediately.

**No caching layer is in the session validation path.** `validateSession` (auth.service.ts:884–898) hits the DB on every call via `sessionRepo.findActiveByJti(jti, ctx)`. There is no in-memory cache, no Redis TTL window. Revocation is effective on the next request. **This is DEFENDED.**

### NC-6: audit chain brand_id integrity for suspend events

```sql
-- After suspend action:
SELECT brand_id, action, entity_id FROM audit_log
WHERE action IN ('user.suspended', 'sessions.bulk_revoked')
ORDER BY seq DESC LIMIT 5;

-- Must show brand_id = organizationId, NOT appUserId
-- (once F3 fix is applied — current code uses appUserId)
```

### NC-7: invite token is single-use after accept

```sql
-- After accept:
SELECT status FROM invite WHERE token_hash = sha256('<raw-token>'::bytea)::text;
-- Must return 'accepted', not 'pending'

-- A second accept attempt must return INVALID_TOKEN (invite.service.ts:171-180 checks status = 'pending')
```

---

## Positive-Control Verification (Architect must confirm)

1. **Token at rest (I-S09):** DEFENDED. `generateToken()` in invite.service.ts:37–42 returns `{ rawToken, tokenHash }` where `tokenHash = sha256(rawToken)`. Only `tokenHash` is stored (invite.service.ts:108 passes `tokenHash` to `inviteRepo.insert`). DB column is `token_hash TEXT` (0005_invitation.sql:34). The `acceptInvite` path hashes the incoming raw token before lookup (invite.service.ts:153: `const tokenHash = createHash('sha256').update(rawToken).digest('hex')`). I-S09 fully met.

2. **validateSession latency (NN-3):** DEFENDED with zero cache window. Every protected request hits the DB via `findActiveByJti`. Revocation is instantaneous for subsequent requests. Cite: auth.service.ts:884–898, repositories.ts:195–213.

3. **Revoke-in-txn for updateMemberRole:** DEFENDED. invite.service.ts:418–431 — single CTE `UPDATE user_session SET revoked_at = NOW()` and `UPDATE membership SET role_code` both inside BEGIN/COMMIT on rawPgPool. No separate commits.

4. **Revoke-in-txn for removeMember:** DEFENDED. invite.service.ts:533–548 — identical pattern.

5. **Invite RLS fail-closed:** DEFENDED. 0005_invitation.sql:51–64 — both policies use two-arg `current_setting(..., TRUE)`. The DO block at lines 69–97 asserts no one-arg form at migration time.

6. **Membership RLS fail-closed:** DEFENDED. 0003_workspace.sql:87–89 — two-arg form. DO block asserts at lines 95–123.

7. **Re-invite creates new row:** DEFENDED structurally. `inviteRepo.insert` always INSERTs (repositories.ts:978 — `INSERT INTO invite (...)`). There is no UPDATE-existing path in createInvite. The `UNIQUE (token_hash)` constraint (0005_invitation.sql:36) ensures no hash collision. However, there is NO unique constraint on `(organization_id, email, status='pending')` — two simultaneous pending invites to the same email in the same org are possible if createInvite is called twice without checking. The `invite_email_org_idx` on `(email, organization_id)` (line 42) is a lookup index, not a uniqueness constraint. The architect should add a partial unique index: `UNIQUE (organization_id, email) WHERE status = 'pending'` to prevent duplicate pending invites.

---

## Summary: Defended vs Gap

| Check | Verdict | Evidence |
|---|---|---|
| Revocation atomicity — updateMemberRole | DEFENDED | invite.service.ts:418–431, BEGIN/COMMIT wraps both |
| Revocation atomicity — removeMember | DEFENDED | invite.service.ts:533–548, BEGIN/COMMIT wraps both |
| Revocation atomicity — suspendUser | **GAP:CRITICAL** | auth.service.ts:764–799, auto-commit pool, no txn |
| validateSession latency (no cache window) | DEFENDED | auth.service.ts:884–898, DB hit on every call |
| Invite token stored as hash | DEFENDED | 0005_invitation.sql:34, invite.service.ts:41,108,153 |
| Invite token status-check on accept | DEFENDED | invite.service.ts:171–180, WHERE status = 'pending' |
| Membership RLS fail-closed (NN-1) | DEFENDED | 0003_workspace.sql:87–89, two-arg form |
| Invite RLS compound (NN-7) | DEFENDED | 0005_invitation.sql:51–64, two policies, two-arg form |
| Pending-invites RLS (new route) | **GAP:HIGH** | Route does not exist; GUC propagation not verified |
| suspendUser audit brand_id correct | **GAP:HIGH** | auth.service.ts:778, uses appUserId not orgId |
| Re-invite inserts new row (not resurface) | DEFENDED | repositories.ts:978, INSERT always |
| Duplicate pending invite guard | **GAP:MED** | No partial unique on (org, email) WHERE pending |
| Dev token helper exposure | MED (dev only) | notification.sendInviteEmail exposes rawToken in dev |
| Audit outside txn (by design) | DEFENDED | invite.service.ts:433 comment, post-COMMIT audit |
