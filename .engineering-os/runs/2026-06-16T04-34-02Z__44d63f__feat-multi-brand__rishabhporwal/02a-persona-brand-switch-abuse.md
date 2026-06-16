# 02a — Persona Review: Brand-Switch-Abuse & Isolation Red-teamer
## feat-multi-brand

**persona:** brand-switch-abuse-isolation-redteamer
**reviewed_at:** 2026-06-16T05:10:00Z
**req_id:** feat-multi-brand
**decision:** PASS (with concerns — all require architect response before build)
**severity_max:** CRITICAL

---

## Journal

**2026-06-16T05:10:00Z — Persona:brand-switch-abuse — feat-multi-brand**
**Angle:** Can a user switch to a brand they don't belong to, or carry privilege/data across the isolation boundary?
**Top concern:** `refreshSession` fallback in `resolveActiveContext` can silently grant the wrong brand if `set-brand` delegates to it; the 3-arg membership check must happen at the BFF layer before any re-mint call.
**Severity:** CRITICAL

---

## Attack Surface Inventory

The new surface under attack:

- `POST /api/v1/bff/session/set-brand` — does not exist yet; architecture specifies its contract.
- `findByUserAndOrg(userId, workspaceId, brandId, ctx)` — 3-arg form; the guard that must 403 non-members.
- `resolveActiveContext` / `refreshSession` — the re-mint path; has a known fallback pattern (`SEC-AOF-H1` from `set-org`).
- `brand_self_read` RLS migration 0013 — new SELECT policy on the `brand` table.
- `audit_log` — the `brand.switch` append-only event.
- `membership` + `user_session` revocation chain — mid-session removal.

---

## Concern 1 — CRITICAL: `refreshSession` / `resolveActiveContext` fallback can mint the wrong brand_id

**Attack:** The CTO Advisor review (AC-1) says `set-brand` should call `refreshSession(userId, jti, correlationId)` with a `preferredBrandId` extension OR call `mintSessionToken` directly with a resolved `ActiveContext`. The current `refreshSession` signature is:

```typescript
// auth.service.ts:597
async refreshSession(
  userId: string,
  jti: string,
  correlationId: string,
  preferredWorkspaceId?: string,
): Promise<{ accessToken: string; expiresIn: number; context: ActiveContext }>
```

It calls `resolveActiveContext(userId, correlationId, preferredWorkspaceId)`, which at line 566–571:

```typescript
let m = preferredWorkspaceId
  ? await memberRepo.findByUserAndOrg(userId, preferredWorkspaceId, null, ...)
  : null;

if (!m) {
  m = await memberRepo.findActiveByUser(userId, { correlationId, userId });
}
```

There is NO `preferredBrandId` parameter. If `set-brand` calls `refreshSession` (or a variant) after the BFF-layer membership check, the `resolveActiveContext` fallback path (`findActiveByUser`) will re-auto-select the most-recently-created brand-level membership — not the explicitly requested brand B. This means:

1. If the BFF checks brand-B membership and it passes, then calls `refreshSession(userId, jti, correlationId)` without pinning brand B into the mint, the session may re-mint with brand A (the `findActiveByUser` winner, i.e. the most recent brand).
2. The user gets a JWT where `brand_id` is NOT brand B even though they explicitly switched to B.
3. Isolation fails silently: they think they switched; the GUC is wrong; they see brand A data in a "brand B" session.

This is a **context substitution** defect structurally identical to SEC-AOF-H1. SEC-AOF-H1 was caught for `set-org`; the same trap applies here but at the brand dimension.

**Code targeted:** `auth.service.ts:560–589` (`resolveActiveContext`), `auth.service.ts:597–609` (`refreshSession`), and the not-yet-built `set-brand` BFF handler.

**Mitigation required:**
The architect MUST NOT call `refreshSession` from `set-brand`. The set-brand BFF handler must:
(a) Perform the 3-arg `findByUserAndOrg(userId, currentWorkspaceId, requestedBrandId)` check → 403 if no row.
(b) Directly construct the `ActiveContext` from the returned membership row (its `brandId`, `organizationId`, `roleCode`).
(c) Call `mintSessionToken(userId, jti, context)` directly — NOT `refreshSession` or `resolveActiveContext`.
This eliminates any fallback path. The resolved context is pinned to exactly the membership row that passed the guard.

---

## Concern 2 — CRITICAL: `workspace_id` used in the 3-arg check must come from the session JWT, not the request body

**Attack:** The request body to `POST /api/v1/bff/session/set-brand` contains `{ brand_id }`. If the implementation naively extracts `workspace_id` or `organization_id` from the body (e.g. `{ brand_id, workspace_id }`), an attacker can craft:

```
POST /api/v1/bff/session/set-brand
{ "brand_id": "brand-uuid-they-own", "workspace_id": "target-org-uuid" }
```

This would pass `findByUserAndOrg(userId, spoofed_org_id, brand_id)` — a cross-org check against an org the attacker belongs to with the spoofed org_id, or could return a false negative that the architect might "fix" by loosening the check. More insidiously, if `workspace_id` is NOT bound from the JWT, the membership check is against the wrong org: an attacker in Org A could switch to any brand_id in Org B if a membership row exists in Org A with the same UUID (UUID collision is negligible, but the structural hole is real).

The `set-org` pattern gets `organization_id` from the body — that is intentional (it IS the input). For `set-brand`, the correct source for `workspaceId` is `auth.workspaceId` (the currently active org from the session JWT), not the body. Only `brand_id` should come from the body.

**Code targeted:** The not-yet-built `set-brand` route; `bff.routes.ts:288` shows the set-org pattern for contrast — `body.organization_id` is the input there, `auth.userId` is pinned from the JWT.

**Mitigation required:**
The `set-brand` handler MUST use `auth.workspaceId` (from `(request as AuthenticatedRequest).auth`) as the `organizationId` argument to `findByUserAndOrg`. Only `brand_id` arrives from the body. If `auth.workspaceId` is null (user has no active org in session), the endpoint must return 400 before attempting any DB check.

---

## Concern 3 — HIGH: Role carry-over — the brand-A role must not mint into the brand-B session

**Attack:** The `refreshSession` path (if used incorrectly) calls `resolveActiveContext`, which calls `findByUserAndOrg(userId, orgId, null, ...)` — the null-brandId form that returns the ORG-LEVEL membership row. The org-level row carries the org-level role (e.g. `owner`). If the architect accidentally uses this path instead of the brand-level 3-arg form, the minted JWT will carry `role: 'owner'` from the org-level row even though the user is only `analyst` in brand B.

A user who is `owner` at org level but `analyst` at brand B level would receive an `owner`-role JWT after switching to brand B. Every role-gated BFF route (`auth.role === 'owner'` checks) would grant them owner privileges within brand B's context, including potentially creating invites, demoting other members, or reading admin-only data.

**Code targeted:** `auth.service.ts:566–567` (`findByUserAndOrg(userId, preferredWorkspaceId, null, ...)`) — the null third arg returns the org-level row, NOT the brand-level row.

**Evidence:** `repositories.ts:810–818` — `findByUserAndOrg` with `brandId = null` executes:
```sql
WHERE app_user_id = $1 AND organization_id = $2 AND brand_id IS NULL
```
This is the org-level row. The brand-level row is obtained with `brandId` set. The 3-arg form is correct; the 2-arg (null) form returns the wrong row for brand-switch purposes.

**Mitigation required:**
The membership row used for the re-mint MUST be the brand-level row returned by `findByUserAndOrg(userId, workspaceId, requestedBrandId)` (non-null third arg). The `roleCode` must be taken from THAT row. No org-level role must flow into the JWT during a brand-switch operation.

---

## Concern 4 — HIGH: `brand_self_read` policy must not expose historically-removed memberships (soft-delete gap)

**Attack:** The proposed `brand_self_read` policy (0013):

```sql
USING (
  id IN (
    SELECT m.brand_id
    FROM membership m
    WHERE m.app_user_id = current_setting('app.current_user_id', TRUE)::uuid
      AND m.brand_id IS NOT NULL
  )
)
```

The `membership` table has no `status` or `deleted_at` column (confirmed — `repositories.ts:786–797` shows INSERT with only `organization_id, brand_id, app_user_id, role_code` columns; the only lifecycle operation is a hard DELETE in `removeMember`). Since `removeMember` hard-DELETEs the membership row, a removed user's row will not appear in the subquery — so the policy is correct for the current schema.

However, the concern is: if any future migration adds soft-delete (`deleted_at` or `status='removed'`) to `membership` WITHOUT updating this policy, previously-removed members would again appear in the brand list. This is a silent regression trap.

Additionally, the policy subquery reads ALL membership rows for the user (unconstrained beyond `app_user_id`). Under `brain_app`, the `membership_self_read` policy (0008) already governs what `membership` rows are visible in this subquery. So the subquery operates under RLS. But: the `membership_self_read` policy does NOT filter by org. A user who has ever had memberships across multiple orgs will see brand rows for all their brands across all orgs — which is intentional behavior for the switcher. This is correct. But the policy should be explicitly reviewed: it exposes brands in ALL orgs the user has membership in, not just the active org. The switcher UI must filter by the active org (`auth.workspaceId`) to avoid showing cross-org brands.

**Code targeted:** Migration 0013 (not yet written); `brand_self_read` policy design.

**Mitigation required:**
1. The 0013 migration must include a comment that the policy is soft-delete-incompatible and must be revised if `membership` ever gains a `deleted_at` or `status` column.
2. The `brand_self_read` subquery SHOULD add an `AND m.organization_id = current_setting('app.current_workspace_id', TRUE)::uuid` filter — but ONLY IF the workspace GUC is always set by the time the brand list is queried (it is, for the switcher — the user has an active session with `workspaceId`). If added, this pins the policy to the active org, which is the correct UX (show brands in my current org). Without this filter, the policy is broader than needed (brands in any org I've ever been in). The Advisor should decide: multi-org cross-listing is fine (user picks org first), or add the workspace filter.
3. The NN-1 two-arg assertion block must be included in 0013 (as in 0008 and 0009).

---

## Concern 5 — HIGH: Mid-session removal race — the JWT window is a 1-hour stale-session hole

**Attack scenario:** Admin removes user from brand B at T=0. The user's session (JWT) is revoked atomically via `removeMember` → `revokeAllForUser` (confirmed in `invite.service.ts:536–546`). However, the `validateSession` preHandler (`auth.service.ts:777–791`) checks `user_session.revoked_at IS NULL` — this check WILL catch the revoked session and reject subsequent requests. This part is correct.

The residual risk is: the JWT itself is a bearer token with a 1-hour expiry. If ANY route does NOT run `validateSession` (i.e. does not use `bffProtectedPreHandler` or `sessionPreHandler`), a revoked user with a cached JWT can still call it within the 1-hour window.

Reviewing `bff.routes.ts`: every protected route uses either `bffProtectedPreHandler` (which delegates to `sessionPreHandler`) or `sessionPreHandler` directly. The `POST /api/v1/bff/session/refresh` route at line 222 uses only `{ preHandler: [sessionPreHandler] }` — this is correct. The session endpoints are consistent.

The remaining gap: the `set-brand` route does NOT exist yet. If it is registered with only `sessionPreHandler` (which validates the JWT but calls `authService.validateSession` to check revocation in DB), the revocation check IS present. But if it is accidentally registered with no preHandler (matching `session/refresh` but without the session revocation DB check), a revoked user could call `set-brand` and mint a new brand context.

Reviewing `sessionPreHandler` (`auth.routes.ts` — imported by `bff.routes.ts` line 43): `validateSessionPreHandler` calls `authService.validateSession(userId, jti, correlationId)` which does `findActiveByJti(jti, ctx)` — a live DB read checking `revoked_at IS NULL`. So as long as `set-brand` uses `sessionPreHandler` (NOT just JWT verification), revoked sessions are blocked.

**Mitigation required:**
The `set-brand` route MUST use `{ preHandler: [sessionPreHandler] }` (or `bffProtectedPreHandler`), matching the `set-org` pattern exactly. The preHandler must run `authService.validateSession` (DB revocation check), NOT merely parse the JWT. The implementation review MUST explicitly verify the preHandler assignment is present. Add a comment: `// SEC: session revocation DB check required — do NOT use JWT-only verification`.

**Race condition sub-concern:** If removeMember and set-brand execute in the same millisecond:
- `removeMember` starts BEGIN, deletes membership, revokes sessions, COMMITs at T=X.
- `set-brand` starts its `findByUserAndOrg` check at T=X-1ms (before the COMMIT).

If `set-brand` reads the membership row before `removeMember` COMMITs the DELETE, the 3-arg check returns a membership row, the preHandler validates the (not-yet-revoked) session, and the re-mint proceeds. After the COMMIT, the user holds a new JWT for brand B with no membership row. For 1 hour, this JWT can drive brand-B reads. RLS will NOT block this: the `brand_isolation` policy uses the GUC-set `brand_id`, not membership existence. The `brand_self_read` policy uses the `membership` subquery — but the JWT's brand GUC is already set to brand B; subsequent queries use `brand_isolation` (not `brand_self_read`) for data reads.

This is a short TOCTOU window, not a persistent hole. Severity: MED-HIGH. Mitigation: acceptable for M1 (the window is milliseconds; revocation covers normal flows). But the architect must document this gap and note it for future brand-scoped session tables.

---

## Concern 6 — HIGH: `brand-summary` BFF query is unscoped and will silently return wrong data post-switch

**Attack / defect:** `bff.routes.ts:515–519` queries:

```sql
SELECT id, display_name, domain, status
FROM brand
WHERE organization_id = $1
ORDER BY created_at DESC LIMIT 20
```

Under `brain_app` with no active brand GUC set (null), `brand_isolation` (`id = current_setting('app.current_brand_id', TRUE)::uuid`) evaluates `id = NULL::uuid` which is always false → 0 rows. The CTO Advisor notes this is a latent defect masked in dev.

Post `brand_self_read` (0013), the `brand` table becomes readable via the new policy when the user's membership subquery matches. This means `SELECT * FROM brand WHERE organization_id = $1` will return ALL brands in that org that the user has membership in — not just the active brand. The dashboard SD-2 stakeholder decision is "active-brand-first." But the query at line 515 returns ALL brands for the org, not filtered to the active brand.

The real issue: after the user switches to brand B and the session JWT carries `brand_id = brand-B-uuid`, the `brand_isolation` policy (`id = GUC`) means ONLY brand B's row is accessible when `brand_id` GUC is set. But `brand_self_read` (0013) also adds SELECT access via membership subquery. Under `brain_app`, both policies are PERMISSIVE and are OR'd: a row is visible if (a) `id = GUC` OR (b) `id IN (membership subquery)`. Result: `SELECT ... FROM brand WHERE organization_id = $1` returns ALL brands the user is a member of in that org, not just the active brand. This is correct for the switcher (list-my-brands query), but WRONG for the active-brand-first dashboard (which should show only the active brand's data).

The `brand-summary` endpoint must be changed to filter by `auth.brandId` to comply with SD-2.

**Mitigation required:**
The `brand-summary` BFF handler must add `active_brand_id` and `active_brand_name` derived from `auth.brandId`. The member count query must filter by `brand_id = $activeBrandId`, not `organization_id = $orgId`. The existing broad query should be retained only for the switcher list endpoint (separate from dashboard summary).

---

## Concern 7 — MED: `audit_log` for `brand.switch` — the outgoing brand_id must be captured

**Attack / compliance:** The `audit_log` append-only constraint (I-S06) is satisfied by the existing `audit.append` pattern. The `brand.switch` event is specified as the required audit action for `set-brand`. However, the current `audit.append` signature used throughout the codebase carries `brand_id` as the CURRENT brand (the context of the event). For `brand.switch`, the "current brand" at the time of the event is the OUTGOING brand (the one the user is leaving). The incoming brand is the brand_id being switched to.

If the architect logs `brand.switch` with only the incoming `brand_id` (the one being switched to), the audit log does not capture where the user switched FROM. An attacker who switches rapidly between brands has an incomplete audit trail — forensics cannot reconstruct the session brand timeline.

**Code targeted:** `audit.service.ts` / `audit.append` call pattern; the not-yet-built `set-brand` handler.

**Mitigation required:**
The `brand.switch` audit event MUST include in its payload:
```json
{
  "from_brand_id": "auth.brandId",  // the outgoing brand (from JWT before re-mint)
  "to_brand_id": "requestedBrandId",  // the incoming brand
  "workspace_id": "auth.workspaceId",
  "role_granted": "brand-level roleCode"
}
```
The `brand_id` field in `audit_log` (the context column) should be the INCOMING brand (the new context), matching the event's effect. The `from_brand_id` is in the payload. This is consistent with other audit patterns (e.g. `session.rotated` carries `old_jti` in payload).

Additionally: the audit event must not be skippable or conditional. It must be synchronous-enough that a re-mint failure after a successful audit write is handled (i.e., audit first or handle partial failure). The existing pattern is audit-after-action (after mint); this is acceptable but should be documented.

---

## Concern 8 — MED: `brand_self_read` exposes archived brands to the switcher

**Attack:** The proposed `brand_self_read` subquery has no filter on `brand.status`. If a brand is archived (`status = 'archived'`), it still has a `membership` row for the user (assuming membership rows survive archival — no brand archival logic exists yet, per the deferred list). The `brand_self_read` policy will return archived brand rows to the switcher list.

The switcher UI might display an archived brand as switchable. If a user switches to an archived brand, all their queries succeed (the GUC is set, the `brand_isolation` policy lets them in), but the brand is logically inactive. The system has no guard at the `set-brand` endpoint against switching to an archived brand.

**Mitigation required:**
The `set-brand` endpoint's guard should add `AND brand.status = 'active'` to its context resolution (or the `findByUserAndOrg` check should be followed by a brand status check: verify `brand.status = 'active'` before minting). Alternatively, `brand_self_read` can add `AND EXISTS (SELECT 1 FROM brand b2 WHERE b2.id = m.brand_id AND b2.status = 'active')` — but this is a cross-table join in an RLS policy, which has performance implications. Recommend: add a brand status check in the `set-brand` service handler as an explicit guard, not in the RLS policy.

---

## Concern 9 — MED: GUC middleware must set `app.current_brand_id` from the JWT on every brand-scoped request post-switch

**Attack:** The isolation chain relies on the GUC middleware reading `auth.brandId` from the JWT and calling `SET LOCAL app.current_brand_id = $brandId` before every query. If the GUC middleware does not do this for the new `set-brand` path or for any subsequent dashboard request after the cookie update, brand-A data will leak into a brand-B session.

This is not a gap in the shipped code (the GUC middleware already handles `brandId` from the JWT, as evidenced by `connection-status` at line 579 using `ctx = { brandId: auth.brandId, ... }`). But the risk is: the `set-brand` handler itself will acquire a DB connection during the membership check. The membership check uses `auth.userId` (from the pre-switch session). The GUC context for this check must NOT set `brand_id` to the current (pre-switch) brand — it should have no `brandId` in ctx (or use a system context) since it is checking the TARGET brand's membership, not reading target-brand data.

If the architect passes `{ brandId: requestedBrandId }` in the `ctx` argument to `findByUserAndOrg`, the GUC middleware will SET `app.current_brand_id = requestedBrandId` for that connection BEFORE the membership row exists to authorize the read. This would make the `membership_self_read` policy (0008) the governing policy for the check (correct — it uses `app.current_user_id`), but it sets a brand GUC that could bleed into subsequent queries on the same pooled connection if connection cleanup is not transactional.

**Code targeted:** The not-yet-built `set-brand` handler's `ctx` argument construction; GUC middleware connection lifecycle.

**Mitigation required:**
The `ctx` passed to `findByUserAndOrg` in `set-brand` must NOT include `brandId`. It should be `{ correlationId, userId: auth.userId, workspaceId: auth.workspaceId }` — identical to the `set-org` pattern (`bff.routes.ts:313`). The GUC middleware will then only set `app.current_user_id` and `app.current_workspace_id` for the membership check, not `app.current_brand_id`. This prevents premature brand GUC contamination during the auth check.

---

## Concern 10 — LOW: `findActiveByUser` on login for multi-brand users picks the most-recent brand; user is not warned

**Observation (low severity):** `repositories.ts:924–933` shows `findActiveByUser` selects `ORDER BY (brand_id IS NOT NULL) DESC, created_at DESC LIMIT 1`. For a user in brands A (created Jan), B (created Feb), C (created March), the login auto-resolves to brand C. After using the switcher to go to brand A, a re-login will again resolve to brand C. Users with muscle memory expecting to land on brand A will be surprised.

This is not a security concern but a UX-correctness concern with a possible audit implication: if a user intends to act in brand A but the session boots in brand C, any audit log entries before they switch will carry the wrong `brand_id` in context.

**Mitigation:** Low priority for this slice. Document the behavior. For future deferred requirement "remember last active brand," add `last_active_brand_id` to the session-persistence layer. The `brand.switch` audit event (Concern 7) provides the trail to reconstruct intended context.

---

## Summary Table

| # | Concern | Surface | Severity | Required action |
|---|---|---|---|---|
| C1 | `refreshSession` fallback mints wrong brand; context substitution attack | `auth.service.ts:560–609`; set-brand route (not built) | CRITICAL | Never call `refreshSession` from `set-brand`; use `mintSessionToken` with explicitly resolved context |
| C2 | `workspace_id` in 3-arg check must come from JWT, not request body | set-brand route (not built) | CRITICAL | Pin `auth.workspaceId` from JWT; only `brand_id` from body |
| C3 | Role carry-over: org-level `owner` role minted into brand-analyst session | `auth.service.ts:566–567`; set-brand route | HIGH | Use brand-level membership row for role resolution; NEVER the org-level (null brand_id) row |
| C4 | `brand_self_read` exposes all-orgs brands; soft-delete regression trap | Migration 0013 (not written) | HIGH | Add workspace-GUC filter; add soft-delete warning comment; include NN-1 assertion block |
| C5 | Mid-session removal TOCTOU + preHandler must be `sessionPreHandler` not JWT-only | `invite.service.ts:536`; set-brand route | HIGH | Mandate `sessionPreHandler` for set-brand; document TOCTOU gap |
| C6 | `brand-summary` returns all-org brands post-0013; violates SD-2 active-brand-first | `bff.routes.ts:515–519` | HIGH | Filter by `auth.brandId`; separate list vs. summary queries |
| C7 | `brand.switch` audit missing `from_brand_id` | set-brand route; audit.append call | MED | Payload must include `from_brand_id`, `to_brand_id`, `role_granted` |
| C8 | `brand_self_read` exposes archived brands to switcher and set-brand | Migration 0013; set-brand route | MED | Add `brand.status = 'active'` check in set-brand handler |
| C9 | GUC ctx in set-brand membership check must not include `brandId` | set-brand route; GUC middleware | MED | `ctx = { correlationId, userId, workspaceId }` only; no `brandId` in membership check ctx |
| C10 | Login auto-resolves wrong brand for multi-brand users | `repositories.ts:924` | LOW | Document; defer "remember last brand" to next requirement |
