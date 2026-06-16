# Stage 1 Synthesis — Engineering Advisor
## feat-members-team-management

| Field | Value |
|---|---|
| **req_id** | `feat-members-team-management` |
| **Synthesized at** | 2026-06-16T13:30:00Z |
| **Synthesized by** | Engineering Advisor (cto-advisor), intake hat |
| **Personas synthesized** | 02a-persona-rbac-prober · 02b-persona-isolation-auditor |
| **Decision** | ADVANCE to Stage 2 (Architect) — high_stakes |

---

## 1. Consolidated, Deduped, Severity-Ranked Findings

All findings are pre-existing defects in live code unless marked (prospective). Severity follows CRITICAL > HIGH > MED.

---

### CRITICAL

#### C-1 — Privilege Escalation: createInvite does not bound granted role by actor's role
- **Source:** P1 (RBAC Prober)
- **File:** `apps/core/src/modules/workspace-access/internal/application/invite.service.ts:80-95`
- **Evidence:** Lines 87-89 gate only on actor being `owner-or-brand_admin` (binary). Line 93 blocks `role_code='owner'` specifically. No call to `hasMinimumRole` / `meetsMinimumRole` / `ROLE_HIERARCHY` comparison. A Brand-Admin can POST `/api/v1/invites` with `role_code='brand_admin'` and succeed. Both functions exist in `domain/membership/entities.ts:37` and `security/rbac.ts:26` — neither is imported in `invite.service.ts`.
- **Architect binding:** `createInvite` MUST assert `ROLE_HIERARCHY.indexOf(grantedRole) >= ROLE_HIERARCHY.indexOf(actorRole)` → throw 403. Owner is exempt. This is a must-fix, not a new requirement; it is in the exact code being hardened by this slice.

#### C-2 — Privilege Escalation: updateMemberRole does not bound new role by actor's role
- **Source:** P2 (RBAC Prober)
- **File:** `apps/core/src/modules/workspace-access/internal/application/invite.service.ts:358-416`
- **Evidence:** Lines 358-370 gate on actor being `owner-or-brand_admin` (binary). Lines 389-399 are sole-owner guard only. No assertion that `newRoleCode < actorRole` in the hierarchy. After the gate, line 406-410 executes the UPDATE unconditionally. A Brand-Admin can PATCH `/api/v1/members/:id/role` with `role_code='brand_admin'` and grant their own authority level to any member without Owner approval.
- **Architect binding:** `updateMemberRole` MUST add the same hierarchy-bounded check as C-1 immediately after the role gate. Both fixes are two-line additions reusing existing helpers; they are in-scope for this slice.

#### C-3 — suspendUser is NOT atomic: session revoke and status update are two separate auto-commit operations
- **Source:** F1 (Isolation Auditor), P3 (RBAC Prober)
- **File:** `apps/core/src/modules/workspace-access/internal/application/auth.service.ts:764-799`
- **Evidence:** `this.pool.connect()` is the GUC-wrapped auto-commit pool. `sessionRepo.revokeAllForUser` commits independently; `userRepo.updateStatus` is a second commit. A crash, network error, or Postgres error between the two leaves sessions revoked but `app_user.status = 'active'` — the user can log in again and receive a fresh session. The established defended pattern (`updateMemberRole`, `removeMember`) uses `rawPgPool` + explicit `BEGIN/COMMIT` for both writes in a single transaction.
- **Architect binding:** `suspendUser` MUST be rewritten to use `rawPgPool` with explicit `BEGIN/COMMIT` wrapping both `UPDATE user_session SET revoked_at = NOW()` and `UPDATE app_user SET status = 'suspended'` in a single transaction, matching the pattern at `invite.service.ts:418-431`. Audit appended post-COMMIT per established pattern.

#### C-4 — suspendUser has no actor-authority check: any authenticated actor could suspend an Owner
- **Source:** P3 (RBAC Prober)
- **File:** `apps/core/src/modules/workspace-access/internal/application/auth.service.ts:764-799`
- **Evidence:** `suspendUser(appUserId, actorId, correlationId)` does not look up the actor's membership row, does not look up the target's membership row, and does not assert `actorRole > targetRole` in the hierarchy. If the new member-route guard uses only `requireRole('brand_admin')` without a per-target authority check, a Brand-Admin could suspend an Owner. This is a wiring gap: the check does not exist anywhere in the current path.
- **Architect binding:** `suspendUser` MUST accept `organizationId` and `brandId` parameters (matching `removeMember` signature), look up both actor and target membership rows, assert `ROLE_HIERARCHY.indexOf(actorRole) < ROLE_HIERARCHY.indexOf(targetRole)` (actor outranks target), and explicitly block suspension of any Owner by a non-Owner. The route-level guard is necessary but not sufficient.

#### C-5 — rawPgPool paths bypass RLS: the application-layer org assertion is the ONLY cross-org guard and must be present on every new rawPgPool path
- **Source:** F2 (Isolation Auditor)
- **File:** `db/migrations/0003_workspace.sql:87-89` + `invite.service.ts:353-354, 383, 513`
- **Evidence:** `membership_isolation` RLS policy uses `current_setting('app.current_workspace_id', TRUE)::uuid`. The `rawPgPool` connection carries no GUC middleware; with no GUC set, RLS returns zero rows (fail-closed — this is defended). But the rawPgPool path is used for `updateMemberRole` and `removeMember` because it needs explicit transaction control. These paths enforce org isolation at the application layer (`target.organization_id !== organizationId`). If any new rawPgPool path for suspend/reactivate/pending-list omits this assertion, org isolation relies solely on fail-closed RLS (which is a silent 404, not a caught bug).
- **Architect binding:** Every new rawPgPool code path (suspend, reactivate, any future path) MUST include the application-layer `target.organization_id !== organizationId` assertion at the same position as existing paths (lines 383, 513). This is the agreed pattern; the binding is to enforce it in all new code, not to change the existing pattern.

---

### HIGH

#### H-1 — suspendUser audit logs app_user_id as brand_id: wrong key, breaks the per-org hash chain
- **Source:** F3 (Isolation Auditor)
- **File:** `apps/core/src/modules/workspace-access/internal/application/auth.service.ts:777-795`
- **Evidence:** `audit.append({ brand_id: appUserId, ... })` — the target user's UUID is passed as `brand_id`. The hash chain is keyed by `(brand_id, seq)` per I-S06. Suspend events will appear under the target user's UUID as a "brand", not under the org/brand where the suspension occurred. Chain walks will fail to associate suspend actions with the correct brand.
- **Architect binding:** `suspendUser` signature MUST accept `organizationId: string` and `brandId: string | null`. The audit call MUST use `brand_id: brandId ?? organizationId`, matching the pattern at `invite.service.ts:551` (`removeMember`) and `invite.service.ts:255` (`acceptInvite`).

#### H-2 — acceptInvite raw INSERT has no duplicate membership guard and no partial unique index on pending invites
- **Source:** P5 (RBAC Prober), Isolation Auditor positive-control section
- **File:** `apps/core/src/modules/workspace-access/internal/application/invite.service.ts:236-244`; `db/migrations/0005_invitation.sql:42`
- **Evidence:** The INSERT at line 240-243 has no `ON CONFLICT` clause and no pre-check for an existing active membership row at `(organization_id, brand_id, app_user_id)`. A user who already has an active membership can accept a second invite, creating a duplicate row (no UNIQUE constraint visible at the schema level). Separately, `invite_email_org_idx` on `(email, organization_id)` is a lookup index, not a uniqueness constraint — two concurrent pending invites to the same email in the same org are possible.
- **Architect binding (two parts):**
  1. `acceptInvite` MUST include a pre-check or `ON CONFLICT DO NOTHING / RAISE` guard on existing active membership before INSERT, returning 409 if a duplicate exists.
  2. A partial unique index `UNIQUE (organization_id, email) WHERE status = 'pending'` MUST be added to the `invite` table schema to prevent dual valid tokens for the same invite slot.

#### H-3 — Pending-invites list route must propagate workspaceId (and brandId) in query context or silently returns 0 rows (dev superuser masks this)
- **Source:** F4 (Isolation Auditor)
- **File:** `apps/core/src/modules/workspace-access/internal/application/invite.service.ts` (route does not yet exist — prospective)
- **Evidence:** The invite table has compound RLS (`invite_org_level`: `brand_id IS NULL AND organization_id = current_setting('app.current_workspace_id')::uuid`; `invite_brand_level`: `brand_id IS NOT NULL AND brand_id = current_setting('app.current_brand_id')::uuid`). Both are fail-closed under no-GUC. If the new `listPendingInvites` implementation omits `workspaceId` from the query context, the RLS filter silently returns zero rows in production. Dev tests will not catch this because the superuser `brain` bypasses RLS entirely.
- **Architect binding:** The `listPendingInvites` handler MUST build its `QueryContext` with both `workspaceId: data.organizationId` and (where applicable) `brandId: data.brandId`, matching the pattern at `createInvite:70-74`. The Playwright e2e must verify that pending invites appear after invite creation — a zero-row result is the dev-superuser-masking silent failure mode.

---

### MEDIUM

#### M-1 — Audit write for suspend must occur post-COMMIT (not inside transaction) to match established pattern
- **Source:** F5 (Isolation Auditor)
- **File:** `apps/core/src/modules/workspace-access/internal/application/invite.service.ts:433-451, 550-568` (reference pattern)
- **Evidence:** `updateMemberRole` and `removeMember` both write audit AFTER `COMMIT` — a deliberate design choice documented in code (line 433 comment). If the new suspend implementation places `audit.append` inside the transaction (before COMMIT), an audit write failure will silently roll back the session revocation.
- **Architect binding:** Audit call for suspend MUST be post-COMMIT, matching lines 433-451. The suspend implementation is prospective; the binding prevents the known failure mode.

#### M-2 — Dev email-token helper is a cleartext token recovery oracle; must be environment-gated at the route level
- **Source:** F6 (Isolation Auditor)
- **File:** `apps/core/src/modules/workspace-access/internal/application/invite.service.ts:114` + the `/api/v1/dev/last-email-link` route
- **Evidence:** DB stores only `token_hash` (sha256, I-S09 defended). The dev helper exposes `rawToken` in the response — intentional for Playwright e2e. If the dev route is ever reachable in staging or production (misconfigured guard), it becomes a token-harvesting vector.
- **Architect binding:** The `/api/v1/dev/last-email-link` route MUST have an explicit `NODE_ENV === 'development'` environment guard enforced at the route registration level, not by convention. This is a tighten-not-design note; the token-at-rest defense (I-S09) is already clean.

---

## 2. Architect Decision Bindings

The five bindings from the original intake review (D-1 through D-5) are preserved below. Six new bindings (D-6 through D-11) are added by the persona findings.

### From intake (02-cto-advisor-review.md)

| Binding | Statement |
|---|---|
| **D-1** | Reactivate is a PATCH on an existing suspended membership row (status: suspended → active). It is NOT a new invite, NOT a new membership row. The service layer must make these two code paths structurally distinct — not a shared helper with a flag. |
| **D-2** | Brand-scope authority check ("you can only grant brands you manage") resolves the actor's brand set from the DB at request time, not from the JWT. The JWT can be stale; the membership table is authoritative. |
| **D-3** | Resend-invite invalidates the old token (updates `token_hash` and `expires_at` on the existing pending row) rather than creating a second pending row. Dual valid tokens for the same invite slot is a security defect, not a design option. |
| **D-4** | Pending-invite visibility: Brand-Admins see all pending invites within their brand scope. Managers see only invites they personally created. Owners see all. The Architect must encode this in the `listPendingInvites` query predicate and the API contract. |
| **D-5** | Branch base for this feature must include commit `43ea557` (membersApi.list envelope fix from `feat/shopify-sync-validation`). A missing base commit causes a silent empty table in the Playwright e2e — a false negative, not a caught error. |

### Added by persona synthesis

| Binding | Statement |
|---|---|
| **D-6** | Hierarchy bound on invite grant is server-side mandatory in `createInvite`. After asserting actor is `owner-or-brand_admin`, assert `ROLE_HIERARCHY.indexOf(grantedRole) >= ROLE_HIERARCHY.indexOf(actorRole)` → 403. Owner is exempt. Reuse `hasMinimumRole` from `domain/membership/entities.ts:37`. (Fixes C-1 / P1.) |
| **D-7** | Hierarchy bound on role change is server-side mandatory in `updateMemberRole`. After the role gate, assert `ROLE_HIERARCHY.indexOf(newRoleCode) >= ROLE_HIERARCHY.indexOf(actorRole)` → 403. Owner is exempt. Same helper. (Fixes C-2 / P2.) |
| **D-8** | `suspendUser` is rewritten to: (a) accept `organizationId` + `brandId` parameters; (b) look up actor and target membership rows; (c) assert actorRole outranks targetRole in ROLE_HIERARCHY; (d) explicitly block suspension of an Owner by a non-Owner; (e) wrap `UPDATE user_session SET revoked_at` and `UPDATE app_user SET status = 'suspended'` in a single `rawPgPool` BEGIN/COMMIT; (f) append audit post-COMMIT with `brand_id: brandId ?? organizationId`. (Fixes C-3, C-4, H-1.) |
| **D-9** | Every new rawPgPool code path (suspend, reactivate, any future path in this slice) MUST include the application-layer org assertion `target.organization_id !== organizationId` immediately after the target fetch, returning NOT_FOUND on mismatch. This is the cross-org guard for all rawPgPool paths since RLS is bypassed. (Enforces C-5.) |
| **D-10** | `acceptInvite` must include a duplicate-membership guard (pre-check or `ON CONFLICT` on `(organization_id, brand_id, app_user_id)`, returning 409). A partial unique index `UNIQUE (organization_id, email) WHERE status = 'pending'` must be added in the migration for this slice. (Fixes H-2 / P5.) |
| **D-11** | `listPendingInvites` query context MUST carry `workspaceId: organizationId` and (where applicable) `brandId`. The Playwright e2e MUST assert that pending invites are returned (not zero rows) after creation — zero rows is the silent superuser-masking failure mode. (Enforces H-3 / F4.) |

---

## 3. Mandatory Negative-Control Tests

All 6 tests below MUST run under `SET ROLE brain_app` with the three-GUC tenant context (`app.current_workspace_id`, `app.current_user_id`, `app.current_brand_id`). Running as superuser `brain` bypasses RLS and makes every one of these tests meaningless.

| NC | What is tested | Pass condition |
|---|---|---|
| **NC-1** | membership table — no cross-org leak | `SET ROLE brain_app; SET app.current_workspace_id = '<org-A>'; SELECT * FROM membership WHERE organization_id = '<org-B>';` → 0 rows |
| **NC-2** | invite table — no-GUC returns zero rows | `SET ROLE brain_app;` (no GUCs) `SELECT * FROM invite WHERE status = 'pending';` → 0 rows |
| **NC-3** | invite table — org-scoped pending list does not leak other org | `SET ROLE brain_app; SET app.current_workspace_id = '<org-A>';` (no brand GUC) `SELECT * FROM invite WHERE status = 'pending';` → only org-A org-level invites, zero org-B rows |
| **NC-4** | user_session revocation verified immediately after suspend | After `suspendUser` completes: `SELECT * FROM user_session WHERE app_user_id = '<target>' AND revoked_at IS NULL AND expires_at > NOW();` → 0 rows; `SELECT status FROM app_user WHERE id = '<target>';` → 'suspended' |
| **NC-5** | validateSession rejects revoked session on next request | After suspend/remove, target's JWT jti passed to `validateSession` → null (findActiveByJti returns null because `revoked_at IS NOT NULL`). No cache window exists (DB hit on every call — DEFENDED); test confirms. |
| **NC-6** | audit chain brand_id integrity for suspend events | After suspend: `SELECT brand_id, action FROM audit_log WHERE action IN ('user.suspended', 'sessions.bulk_revoked') ORDER BY seq DESC LIMIT 5;` → `brand_id` equals `organizationId`, NOT `appUserId`. (Requires D-8 fix to pass.) |

Total mandatory negative-control tests: **6**, all under `SET ROLE brain_app`.

---

## 4. Scope Confirmation: Must-Fix Pre-Existing Defects

The following are NOT new risks introduced by this slice — they are pre-existing defects in the exact code being hardened. They are IN SCOPE for this requirement and must be fixed before the Architect's spec is locked.

| Tag | Finding | Status in code today |
|---|---|---|
| **P1** | `createInvite` — no hierarchy bound on grantedRole → Brand-Admin can grant Brand-Admin | DEFECT IN LIVE CODE (C-1) |
| **P2** | `updateMemberRole` — no hierarchy bound on newRoleCode → Brand-Admin can promote to Brand-Admin | DEFECT IN LIVE CODE (C-2) |
| **F1** | `suspendUser` — two-commit auto-commit window (sessions revoked, status write separate) | DEFECT IN LIVE CODE (C-3) |
| **F3** | `suspendUser` — audit `brand_id: appUserId` wrong key, breaks hash-chain | DEFECT IN LIVE CODE (H-1) |
| **P5** | `acceptInvite` — no duplicate-membership guard, no partial unique index on pending invites | PARTIAL DEFECT IN LIVE CODE (H-2) |
| **F4** | `listPendingInvites` — prospective: route must propagate workspaceId/brandId or returns zero rows in prod | PROSPECTIVE (new route) (H-3) |

P1 and P2 are the most urgent: they represent a live privilege-escalation path that any Brand-Admin can exploit today via direct HTTP. The fixes are two-line additions each. The Architect must prioritize these in Slice 1.

---

## 5. Final Intake Decision

**ADVANCE to Stage 2 (Architect) — high_stakes.**

Rationale:
- Requirement has a clear problem statement (lifecycle gap), a named user (Owner / Brand Admin), and a concrete success metric (green Playwright e2e, zero cross-brand leak). Nothing in the scope is vague.
- All challenge findings are implementation-level. The design approach is sound: reuse `rawPgPool BEGIN/COMMIT`, reuse `rbac.ts` hierarchy helpers, wire `suspendUser` into the same pattern as `removeMember`. No new infrastructure required.
- The pre-existing defects (P1, P2, F1, F3) are all in the exact service file this slice touches. Fixing them is additive hardening, not scope expansion.
- Cost paradigm: Tier 0 (deterministic). No model calls anywhere in this slice.
- Anti-blind triggers: clean. No Single-Primitive violation, no large-model-for-small-problem, no region assumption, no compliance ambiguity requiring escalation.
- No KILL or CHALLENGE-BACK triggers are met. The sole escalation risk — the audit hash-chain integrity (I-S06) — is defended (L-02 closed in feat-m1-app-foundation); the new binding (D-8) ensures new audit writes use the correct key.

The architect must not begin the spec without confirming the D-6/D-7 hierarchy-bound fixes are included in Slice 1.
