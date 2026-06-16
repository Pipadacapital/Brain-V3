# 02 — CTO Advisor Intake Review
## feat-multi-brand — Multi-brand: create additional brands + brand switcher

**req_id:** feat-multi-brand
**reviewed_at:** 2026-06-16T04:38:00Z
**reviewed_by:** cto-advisor (Engineering Advisor, Stage 1)
**decision:** ADVANCE
**lane:** high_stakes
**trigger_surfaces:** auth, multi_tenancy (confirmed by deterministic scan; no silent downgrades)
**paradigm:** Tier-0 deterministic (no model calls — session re-mint is a pure crypto + DB read operation)

---

## 1. Dependency Pre-flight

**Lineage declared in requirement:**
- `feat-m1-app-foundation` (shipped) — status: SHIPPED. No blocker.
- `feat-access-onboarding-flow` (shipped) — status: SHIPPED. No blocker.

Both prerequisite requirements shipped and verified (final-reviewer PASS/GO per live.log). Pipeline may advance.

---

## 2. Design Question Reconciliation

### Q1 — Switch mechanism: new endpoint vs. extend set-org

**Recommendation: NEW endpoint — `POST /api/v1/bff/session/set-brand`.**

Rationale grounded in the shipped code:

`set-org` (`bff.routes.ts:283`) takes `organization_id`, calls `memberRepo.findByUserAndOrg(userId, orgId, null, ...)` (checks org-level membership with `brand_id IS NULL`), then calls `refreshSession(userId, jti, correlationId, organizationId)` which falls through to `resolveActiveContext` → `findActiveByUser` (picks the most-recent brand-level membership by default). This is correct for the org-picker: it sets the active org and auto-selects a brand within it.

The brand switcher has a different contract: the user has an explicit `brand_id` to switch to (within the already-active org). The correct check is `memberRepo.findByUserAndOrg(userId, currentWorkspaceId, brandId, ...)` — the three-argument form — not the org-level null form. Extending `set-org` to handle both cases would require a conditional branch on whether `brand_id` is present, making the endpoint's semantics ambiguous and muddying the CSRF/audit trail (a brand-switch and an org-switch are distinct auditable events).

The client already has `brandApi.switchBrand(id)` → `POST /v1/brands/:id/switch`. That client method exists without a backend route. The correct backend landing is `POST /api/v1/bff/session/set-brand` (body: `{ brand_id }`) — a BFF session endpoint matching the `set-org` shape. An alternative is honoring the client's existing URL shape (`POST /api/v1/bff/brands/:id/switch`) to avoid changing the client, but the BFF convention is body-parameterized session mutations under `/bff/session/`. Either works; the Stakeholder decision below captures this.

The org-picker (set-org) and brand-picker (set-brand) compose as a two-step: if the user switches org, set-org runs first (auto-selects a brand within it); if the user then explicitly picks a different brand within the same org, set-brand runs. The org-level selector is not replaced.

### Q2 — Active-brand model: does the 3-GUC session need a new schema column?

**No schema change required.**

The existing 3-GUC session model (`brand_id` / `workspace_id` / `role` + `jti` in `JwtClaims`) already carries all needed context. The `mintSessionToken` method in `auth.service.ts:545` takes an `ActiveContext` with `brandId | null`, `workspaceId | null`, `role | null`. The re-mint for brand-switch is identical in shape to the org-switch re-mint: resolve the brand-level membership for `(userId, workspaceId, brandId)`, extract role, re-mint with same `jti`.

No "last active brand" persistence table is needed. The active brand is a property of the session JWT (15-min window), and a fresh login auto-resolves the most-recent brand-level membership via `findActiveByUser`. If "remember last active brand across re-logins" is desired (e.g. user logs out and back in and lands on their last-used brand), that is a UX enhancement that belongs in a deferred requirement — it would need a `last_active_brand_id` column on `membership` or `user_session`. It is NOT in scope for this slice.

### Q3 — Brand membership + roles: does the model support per-brand roles, and does the RLS cover "list my brands"?

**Per-brand role support: yes, confirmed — no schema change needed.**

The `membership` table has `(organization_id, brand_id, app_user_id, role_code)`. A user can hold `owner` in Brand A and `analyst` in Brand B under the same org. `findByUserAndOrg(userId, orgId, brandId, ctx)` resolves the brand-level row correctly (the three-arg SQL branch). The `set-brand` re-mint resolves the role from the brand-level membership row — not from the org-level row — so a user's effective role in the JWT matches their grant for that brand. Fail-closed: no brand-level membership → 403.

**RLS policy gap for "list my brands": CONFIRMED GAP.**

The existing RLS policies are:
- `membership_self_read` (0008): lets `brain_app` see `membership` rows where `app_user_id = current_setting('app.current_user_id', TRUE)::uuid`. This covers the user's own membership rows.
- `organization_self_read` (0009): lets `brain_app` see `organization` rows where `id IN (SELECT organization_id FROM membership WHERE app_user_id = current_setting('app.current_user_id', TRUE)::uuid)`. This covers their orgs.

The `brand` table (0004) has only `brand_isolation`:
```sql
CREATE POLICY brand_isolation ON brand
  AS PERMISSIVE FOR ALL TO brain_app
  USING (id = current_setting('app.current_brand_id', TRUE)::uuid);
```

This policy only returns a brand if its `id` matches the GUC-set active brand. Under `brain_app` (NOBYPASSRLS), a query like `SELECT * FROM brand WHERE organization_id = $1` executed without a `brand_id` GUC set returns zero rows — even if the user is an org member. This means the brand switcher UI cannot list all brands the user has access to using a direct `brand` table query without first setting the GUC to each brand_id in turn.

**A `brand_self_read` RLS policy is required** — analogous to `organization_self_read` (0009). The pattern is:

```sql
CREATE POLICY brand_self_read ON brand
  FOR SELECT
  TO brain_app
  USING (
    id IN (
      SELECT m.brand_id
      FROM membership m
      WHERE m.app_user_id = current_setting('app.current_user_id', TRUE)::uuid
        AND m.brand_id IS NOT NULL
    )
  );
```

This is a SELECT-only, PERMISSIVE addition. Combined with `brand_isolation`, a SELECT on `brand` is visible if: (a) it is the currently-active brand (GUC-set), OR (b) the requesting user has a membership row pointing to it. This is the minimum policy needed to power "list my brands" — it does not widen writes, does not expose brands the user has no membership in, and is fail-closed (missing GUC → `current_setting` returns NULL → subquery returns nothing → predicate fails → 0 rows).

This policy MUST ship as migration `0013_brand_self_read.sql` in this slice. Without it, the brand switcher cannot render its list under `brain_app` in production.

**Note on the dashboard `brand-summary` BFF route:** `bff.routes.ts:515` currently does `SELECT ... FROM brand WHERE organization_id = $1` — a workspace-scoped query with no `brand_id` GUC. Under `brain_app`, this returns zero rows for any org where no brand GUC is set. This is a latent production defect in `get /api/v1/dashboard/brand-summary` — currently masked in dev/test because dev connects as the superuser `brain` (BYPASSRLS). The `brand_self_read` policy will incidentally fix this, but the query should also be confirmed to use the user GUC context when run under `brain_app`.

### Q4 — Create-additional-brand authority

**Confirmed: `brand.service.create` already enforces Owner/Brand-Admin.**

`brand.service.ts:68–70`:
```typescript
const membership = await memberRepo.findByUserAndOrg(data.requestingUserId, data.organizationId, null, ctx);
if (!membership || (membership.roleCode !== 'owner' && membership.roleCode !== 'brand_admin')) {
  throw new BrandError('FORBIDDEN', 'Requires owner or brand_admin role to create a brand.', 403);
}
```

This checks org-level membership (`brand_id IS NULL`). Manager/Analyst roles cannot create brands. The created user gets a brand-level `owner` membership (line 88–96). This is exactly the authority model described in the requirement.

One concern: the check is against the org-level membership role, not a brand-level role. This is correct — "who can create a new brand under this org" is an org-level permission. No change needed.

**Additional brand onboarding behavior:** The `advanceOnboardingStatus` call in `brand.service.ts:101–106` advances `onboarding_status` to `'brand_created'` with step=2 on any brand creation. For additional brands (post-onboarding), this call is idempotent (`WHERE onboarding_step < 2`) and will no-op since the first brand creation already advanced past step 2. This is safe — no behavioral change needed for additional brand creation. Confirmed the requirement is correct: "additional brands do NOT re-run the wizard."

### Q5 — Isolation: can switching brands leak across brands?

**Structural isolation holds — with one explicit verification requirement.**

The `brand_id` GUC is the sole driver of `brand_isolation` (`USING (id = current_setting('app.current_brand_id', TRUE)::uuid)`) and all other brand-scoped RLS policies. The session re-mint on `set-brand` writes a new `brand_id` into the JWT; the GUC middleware reads it from the JWT on every request and sets `app.current_brand_id` before any query runs. A switch to brand B sets the GUC to brand B's UUID; all subsequent queries return only brand B data.

**The one gap requiring verification under `brain_app`:** The `brand_isolation` policy on the `brand` table currently allows SELECT where `id = GUC`. It does NOT allow SELECT where `organization_id = $x AND GUC is null`. This means that under `brain_app`, without `brand_self_read`, a user with no active brand in the JWT cannot list brands. The `brand_self_read` policy (Q3 above) adds the listing path without breaking isolation (it is still predicated on membership, not on org membership alone).

The isolation-fuzz CI gate (`tools/isolation-fuzz`) MUST include a test for the brand-switch path: after switching to brand B, a query for brand A's data must return zero rows. This is a new test case to be added in this slice.

---

## 3. In-Scope Acceptance List

**AC-1 — New BFF endpoint `POST /api/v1/bff/session/set-brand`:**
- Auth: session cookie + CSRF (matches `set-org` pattern).
- Input: `{ brand_id: string }` in body.
- Check: `memberRepo.findByUserAndOrg(userId, workspaceId, brandId, ctx)` — exact three-arg form — 403 if no membership.
- Re-mint: `refreshSession(userId, jti, correlationId)` with a `preferredBrandId` extension OR direct `mintSessionToken` with a resolved `ActiveContext` carrying the verified brand's `brand_id`, `workspaceId`, and the user's brand-level `role`.
- Sets httpOnly cookie; returns `{ auth: { brand_id, workspace_id, role } }` (same shape as `set-org`).
- Audit: `brand.switch` action logged to `audit_log` (auditable action per INVARIANTS I-S06 — role/permission changes must be logged; brand context switches are in-scope).
- CSRF enforced by the app-wide onRequest hook (not exempt).
- Rate-limit: inherit the BFF protected preHandler pattern; no separate rate limit needed for brand switch (not a brute-force-exploitable surface — the membership check is the guard).

**AC-2 — `brand_self_read` RLS policy (migration `0013_brand_self_read.sql`):**
- `FOR SELECT`, `TO brain_app`, `USING (id IN (SELECT m.brand_id FROM membership m WHERE m.app_user_id = current_setting('app.current_user_id', TRUE)::uuid AND m.brand_id IS NOT NULL))`.
- Must include the NN-1 two-arg negative-control assertion block.
- Ships before or atomically with AC-1 backend implementation.

**AC-3 — Brand switcher UI (dashboard shell):**
- Calls `GET /api/v1/bff/brands` (or the existing `brandApi.list()` → `/v1/brands`) to list the brands the user has membership in.
- Wait: `brandApi.list()` in `client.ts:284` calls `/v1/brands` which calls `brand.service.list()` which does `findByOrganizationId` — this lists ALL brands for the org, not just the ones the user has a membership in. Under `brain_app` with only `brand_isolation` (no `brand_self_read`), this query returns zero rows with no active brand GUC. After `brand_self_read` ships, the query returns only brands the user is a member of (because `brand_isolation` OR `brand_self_read` covers the row). This is the correct behavior.
- Active brand indicated (compare to `auth.brandId` from session).
- Selecting a brand calls `brandApi.switchBrand(id)` → AC-1 endpoint.
- After switch: reload the dashboard shell in the new brand's context (full page reload or session-refresh-then-reload is acceptable; the session cookie is already updated server-side).
- Must handle the edge case where the user has only one brand — switcher either hidden or shows the single brand as non-clickable (UX decision, but must not call `set-brand` if the active brand is already selected).

**AC-4 — Create additional brand UI (post-onboarding):**
- A "Create brand" action visible to Owner/Brand-Admin roles in the org (client should check `auth.role` for conditional rendering; backend is the source of truth for enforcement).
- Calls existing `POST /api/v1/v1/brands` (or equivalent) via `brandApi.create()` — same endpoint used in onboarding Step 2.
- Fields: `display_name`, `currency_code`, `timezone`, `revenue_definition` (same validation as onboarding).
- Currency/timezone validation happens in `brand.service.create` (existing).
- After creation: the new brand has a brand-level owner membership for the creator. The UI should optionally offer to switch to the new brand (call AC-1).
- Does NOT redirect to the onboarding wizard (the wizard's onboarding steps advance is idempotent and will no-op; the wizard pages themselves should not be shown for additional brands).

**AC-5 — Dashboard brand-summary reflects active brand:**
- `GET /api/v1/dashboard/brand-summary` should surface the active brand's name and data (currently it shows org-level brand_count; post this slice it should show the active brand's name prominently).
- Minimal change: add `active_brand_id` and `active_brand_name` fields to the response using `auth.brandId` from the session JWT.
- Under `brain_app` with `brand_self_read` shipped, the existing query `SELECT ... FROM brand WHERE organization_id = $1` will now work correctly (returns all brands the user has membership in).

**AC-6 — `findActiveByUser` handles multi-brand user correctly on login:**
- The current `findActiveByUser` query in `repositories.ts:924` selects `ORDER BY (brand_id IS NOT NULL) DESC, created_at DESC LIMIT 1` — this returns the most-recently-created brand-level membership. For a user with multiple brands, it auto-selects the last created brand on login. This is acceptable behavior (the user can then use the switcher). No change required; document this behavior so UX shows the switcher even after fresh login.

**AC-7 — Isolation fuzz: brand-switch test case:**
- Add to the isolation-fuzz suite: after `set-brand` to brand B, a direct query for brand A's `connector_instance` / `brand` rows must return zero results under `brain_app`.
- This test must not be skipped.

---

## 4. Deferred List

These items are explicitly out of scope for this slice:

| Item | Reason deferred |
|---|---|
| Cross-org brand moves | Requires org-transfer logic + cross-org membership reconciliation; separate requirement |
| Brand deletion / archival lifecycle | `status='archived'` field exists; the soft-delete flow, UI, and downstream data suppression is a separate requirement |
| Per-brand billing | Billing meter + invoicing is a separate M-milestone requirement |
| Brand-level theming / branding | UI + CDN work; separate requirement |
| "Remember last active brand" across re-logins | Needs `last_active_brand_id` persistence; separate UX requirement |
| MFA / Authentik / Google one-tap | Still deferred from feat-access-onboarding-flow (SD-1 Stakeholder decision stands) |
| Brand-level invite flow (invite member to specific brand) | The existing invite flow is org-scoped; brand-level invites with per-brand role grants are post-M1 |
| Per-brand member management UI | Showing members per brand (vs. per org) is a separate surface |

---

## 5. Canon Verification

**No Canon amendment required.**

- STACK.md: no new primitive, no new ADR.
- INVARIANTS.md: I-S01 (brand isolation absolute) holds; the `brand_self_read` policy is a SELECT-only self-read addition, not a cross-tenant read.
- TRIGGER-SURFACES.md: multi_tenancy + auth surfaces correctly assigned. The `brand_self_read` migration touches the multi_tenancy isolation boundary — this is already covered by the high_stakes lane trigger.
- METRICS.md: no metric change; per-brand currency is already the model (each brand has its own `currency_code`).
- Cost paradigm: Tier-0 deterministic. Session re-mint = DB read (one query) + JWT sign (CPU). Zero model calls. No cost-routing audit section required.

---

## 6. Lane Validation

**Lane: high_stakes — CONFIRMED.**

Surfaces touched:
- `auth`: session re-mint (JWT brand_id/role update), CSRF enforcement, revocation-preserving jti reuse.
- `multi_tenancy`: new RLS policy (`brand_self_read`), brand-switch as isolation boundary event.

The orchestrator's scan flagged `[auth, multi_tenancy]`. Both are correct. I am adding no additional surface that was not already flagged — the `brand_self_read` migration is already within the `multi_tenancy` surface.

Build tracks: backend-developer (AC-1 endpoint + AC-2 migration + AC-7 isolation test) + frontend-web-developer (AC-3 UI + AC-4 UI + AC-5 dashboard update). Both tracks in parallel after migration lands.

---

## 7. Stakeholder Decisions Required

**SD-1 — Backend route URL for brand switch:**
The client has `brandApi.switchBrand(id)` → `POST /v1/brands/:id/switch`. The backend recommendation is `POST /api/v1/bff/session/set-brand` with `{ brand_id }` in the body (matching the `set-org` shape). Two options:

- **Option A (recommended):** Honor the BFF session convention — `POST /api/v1/bff/session/set-brand` with `{ brand_id }`. Update the client's `brandApi.switchBrand` to call this route. Clean separation: session mutations live under `/bff/session/`.
- **Option B:** Honor the existing client route — route `POST /api/v1/bff/brands/:id/switch` as an alias. Slightly simpler client change (none needed), but mixes session mutation into the brands resource namespace.

Recommendation: Option A. Decision needed before backend builds the endpoint.

**SD-2 — Brand-summary dashboard: active-brand-first vs. list view:**
Post-switch, the dashboard should show the active brand's data. The current `/api/v1/dashboard/brand-summary` returns an org-level summary (brand count, member count, all brands). Should it be changed to return the active brand's summary (name, member count for that brand specifically), or should both org-level and active-brand-level summaries be returned?

Recommendation: return active-brand-focused summary (active brand name + member count for that brand) as the primary surface; org-level counts as secondary. The member count query should be filtered to `brand_id = $activeBrandId` for the active brand, not `organization_id = $orgId` for the org. This matches the product principle "brand = workspace = unit of everything."

No Canon amendment required regardless of which option is chosen.

---

## 8. Persons — needs_personas

Two personas, spawned in parallel, must each surface at least one concern:

**Persona 1 — Brand-Switch Abuse and Isolation Red-teamer (:sonnet)**
Focus: Can a user switch to a brand they are not a member of? Can a spoofed or replayed request elevate context? Does the brand_self_read policy inadvertently expose a brand the user has a historical (removed/revoked) membership in? Does the audit log record both the outgoing and incoming brand_id on a switch? Does the isolation-fuzz test cover cross-brand reads post-switch? What happens if a user's membership is removed mid-session (they hold a valid JWT with brand_id=B but no longer have a membership row in B)?

**Persona 2 — Scope and Product-Realism Skeptic (:sonnet)**
Focus: Is AC-3 (list brands for the switcher) actually achievable with the existing `brandApi.list()` endpoint and the new `brand_self_read` policy, or does it silently return only org-level brands (not per-membership)? Is the "active brand" indicator in the switcher using the session JWT's `brand_id` or a separate API call? What is the UX when the session's `brand_id` is stale (user was removed from their active brand while logged in)? Is the "create brand" flow complete without an explicit "switch to new brand" step? Is there a race condition between creating a brand and then calling `set-brand` before the membership row is visible (RLS read-your-writes)?

---

## 9. Summary of Key Findings

| # | Finding | Severity | Action |
|---|---|---|---|
| F-1 | `brand_self_read` RLS policy is MISSING | P0 — blocks the entire brand list and switcher under `brain_app` | MUST ship as migration 0013 in this slice |
| F-2 | `brand-summary` BFF query returns 0 rows under `brain_app` without active brand GUC | HIGH — latent production defect (masked by superuser in dev) | Fixed by F-1; verify in isolation test |
| F-3 | `set-brand` backend route does not exist (client calls `/v1/brands/:id/switch`) | P0 — the entire feature is blocked | AC-1 in this slice |
| F-4 | `brandApi.switchBrand` calls a non-existent URL — no 404 is visible in dev because dev might not exercise this path | HIGH — silent failure | Fixed by AC-1 |
| F-5 | Isolation fuzz has no post-brand-switch cross-brand test case | MEDIUM — isolation could regress silently | AC-7 in this slice |
| F-6 | `findActiveByUser` auto-selects most-recent brand on login for multi-brand user — UX may surprise users | LOW — acceptable behavior; document it | Document in handoff; no code change |
| F-7 | `brand.service.create` advances `onboarding_status` on additional brand creation — this is idempotent (no-op) but may confuse observability | LOW — audit log entry says `brand.created`; status stays at `complete` | Acceptable; no change needed |
