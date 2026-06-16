# 02c — Intake Synthesis: Architect-Ready Brief
## feat-multi-brand — Multi-brand: create additional brands + brand switcher

**req_id:** feat-multi-brand
**synthesized_at:** 2026-06-16T05:20:00Z
**synthesized_by:** cto-advisor (Engineering Advisor, Stage 1 — synthesis pass)
**decision:** ADVANCE
**lane:** high_stakes
**trigger_surfaces:** auth, multi_tenancy
**paradigm:** Tier-0 deterministic (zero model calls — session re-mint = DB read + JWT sign)
**build_tracks:** backend-developer, frontend-web-developer
**canon_amendment_needed:** no

**Sources folded:**
- `02-cto-advisor-review.md` — 7 ACs, 7 findings, 2 Stakeholder decisions
- `01b-stakeholder-scope-decisions.json` — SD-1 confirmed (new `POST /api/v1/bff/session/set-brand`); SD-2 confirmed (active-brand-first)
- `02a-persona-brand-switch-abuse.md` — 10 concerns (2 CRITICAL, 4 HIGH, 3 MED, 1 LOW)
- `02b-persona-scope-realism.md` — 7 concerns (3 HIGH, 2 MED, 2 LOW)

---

## Part 1 — Ranked "Architect Must-Address" List

All CRITICAL and HIGH concerns from both personas are captured here. No concern is dropped. Each item maps to the AC(s) it modifies and identifies the specific file(s) the Architect must touch.

### CRITICAL

**MA-01 [C1-abuse / C3-realism] — `set-brand` MUST call `mintSessionToken` directly; NEVER `refreshSession` or `resolveActiveContext`**
- **AC modified:** AC-1
- **Severity:** CRITICAL (context-substitution attack; SEC-AOF-H1 class)
- **Problem:** `refreshSession` delegates to `resolveActiveContext` which has no `preferredBrandId` parameter. Its fallback (`findActiveByUser`) picks the most-recently-created brand-level membership row, NOT the explicitly requested brand. Result: a user who requests a switch to brand B receives a JWT pinned to brand A. Isolation fails silently.
- **Required implementation:** The `set-brand` BFF handler MUST:
  1. Run the 3-arg guard: `findByUserAndOrg(userId, auth.workspaceId, requestedBrandId, ctx)` — 403 if no row.
  2. Construct `ActiveContext` directly from the returned membership row: `{ brandId: row.brandId, workspaceId: row.organizationId, role: row.roleCode }`.
  3. Call `mintSessionToken(userId, jti, activeContext)` directly.
  4. NEVER call `refreshSession`, `resolveActiveContext`, or `findActiveByUser` from this handler.
- **Files:** `auth.service.ts:560–609` (understand only; do not touch `refreshSession` path for set-brand), `bff.routes.ts` (new set-brand handler).

**MA-02 [C2-abuse] — `workspace_id` for the 3-arg check MUST come from the JWT (`auth.workspaceId`); only `brand_id` comes from the request body**
- **AC modified:** AC-1
- **Severity:** CRITICAL (cross-org membership spoofing)
- **Problem:** If the handler extracts `workspace_id` or `organization_id` from the request body, an attacker can craft `{ brand_id: brand-in-org-A, workspace_id: org-B-uuid }` to execute a membership check against the wrong org, potentially bypassing isolation.
- **Required implementation:**
  - Input from body: `{ brand_id: string }` only.
  - `workspaceId` for `findByUserAndOrg`: `(request as AuthenticatedRequest).auth.workspaceId` only.
  - If `auth.workspaceId` is null (no active org in session), return 400 immediately — do NOT attempt any DB check.
  - Add inline comment: `// SEC: workspaceId must come from JWT, not body — prevents cross-org membership spoofing`
- **Files:** `bff.routes.ts` (new set-brand handler).

### HIGH

**MA-03 [C3-abuse] — Brand-level role MUST come from the brand-level membership row; the org-level row MUST NOT be used**
- **AC modified:** AC-1
- **Severity:** HIGH (privilege carry-over — org-owner role minted into brand-analyst session)
- **Problem:** `findByUserAndOrg(userId, workspaceId, null, ctx)` (null third arg) returns the org-level membership row with the org-level role (e.g., `owner`). If the handler accidentally resolves the role from this row instead of the brand-level row, a user who is `owner` at org level but `analyst` at brand B level receives an `owner`-role JWT after switching to brand B.
- **Required implementation:** The `roleCode` placed in `ActiveContext` MUST be taken from the row returned by `findByUserAndOrg(userId, workspaceId, requestedBrandId)` (non-null third arg). The null-third-arg form is explicitly forbidden in the set-brand handler.
- **Files:** `bff.routes.ts` (new set-brand handler); `repositories.ts:810–818` (reference — confirm the 3-arg vs 2-arg SQL branches).

**MA-04 [C4-abuse] — Migration `0013_brand_self_read` must include: (a) workspace-GUC org filter, (b) soft-delete warning comment, (c) NN-1 two-arg negative-control assertion block**
- **AC modified:** AC-2
- **Severity:** HIGH (soft-delete regression trap; over-broad brand exposure across all user orgs)
- **Problem (a):** Without an `AND m.organization_id = current_setting('app.current_workspace_id', TRUE)::uuid` filter on the subquery, the policy exposes brands across ALL orgs the user has ever been a member of. For the switcher (brands within current org), this is over-broad. The workspace GUC IS always set by the time a protected BFF request executes. Add the filter to scope the policy to the active org.
- **Problem (b):** The policy subquery uses only `m.brand_id IS NOT NULL` — if `membership` ever gains a soft-delete column (`deleted_at` or `status`), revoked-then-soft-deleted members will re-appear in the brand list. This is a silent future regression trap.
- **Problem (c):** NN-1 two-arg assertion block (as in migrations 0008 and 0009) must be included for fail-closed verification.
- **Required implementation:**
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
          -- Scope to active org only; workspace GUC is always set by sessionPreHandler
          AND m.organization_id = current_setting('app.current_workspace_id', TRUE)::uuid
          -- SOFT-DELETE NOTE: if membership gains deleted_at/status, add AND m.deleted_at IS NULL
          -- Failing to update this policy on soft-delete migration = silent re-exposure of removed users
      )
    );
  ```
  Include the NN-1 assertion block as per the 0008/0009 pattern.
- **Files:** new `0013_brand_self_read.sql`.

**MA-05 [C5-abuse] — `set-brand` route MUST use `sessionPreHandler` (DB revocation check); JWT-only verification is insufficient**
- **AC modified:** AC-1
- **Severity:** HIGH (mid-session removal bypass)
- **Problem:** `sessionPreHandler` calls `authService.validateSession(userId, jti, correlationId)` which performs a live DB check (`findActiveByJti` — confirms `revoked_at IS NULL`). If `set-brand` is accidentally registered with only JWT signature verification (no DB revocation check), a user whose session was revoked by `removeMember` within the 1-hour JWT window can still call `set-brand` and mint a new brand context.
- **Required implementation:**
  - Register the route: `{ preHandler: [sessionPreHandler] }` — identical to the `set-org` pattern at `bff.routes.ts:283`.
  - Add inline comment: `// SEC: session revocation DB check required — do NOT use JWT-only verification`
  - Document the TOCTOU gap (remove+set-brand executing in the same millisecond): the window is sub-millisecond, acceptable for M1, but must be noted in the implementation for future brand-scoped session audit.
- **Files:** `bff.routes.ts` (new set-brand route registration).

**MA-06 [C6-abuse / C1-realism] — `brand-summary` BFF handler must filter by `auth.brandId`; member count must be brand-scoped; BFF adapter must pick active brand by ID not array index**
- **AC modified:** AC-5
- **Severity:** HIGH (breaks SD-2 active-brand-first; post-switch dashboard shows wrong brand name and wrong member count for up to 60 seconds)
- **Problem (BFF):** `bff.routes.ts:524–526` member count uses `COUNT ... WHERE organization_id = $1` (org-level). The dashboard is required to show the active brand's member count (SD-2). Additionally, `brand_self_read` (0013) will make `SELECT ... FROM brand WHERE organization_id = $1` return all brands the user is a member of — not just the active brand. The summary endpoint must be scoped to `auth.brandId`.
- **Problem (adapter):** `client.ts:568` picks `brands[0].display_name` — array index, not session-active brand. After a switch, the BFF response must expose `active_brand_id` and the adapter must key off it.
- **Problem (cache):** `use-dashboard.ts` `staleTime: 60_000` with no invalidation on brand switch. If a hard page reload is used post-switch, the cache clears naturally. But if the implementation uses soft navigation, `queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY })` must be called immediately after `set-brand` succeeds.
- **Required implementation (three changes):**
  1. `bff.routes.ts` brand-summary handler: add `auth.brandId` as `$2`; filter `AND brand.id = $activeBrandId`; filter member count `AND brand_id = $activeBrandId`; include `active_brand_id` in response payload.
  2. `client.ts:getBrandSummary`: match active brand by `response.active_brand_id` not `brands[0]`.
  3. The set-brand success path (AC-3 client handler): call `queryClient.invalidateQueries({ queryKey: ['dashboard'] })` before or immediately after the page transition. Do NOT rely solely on hard-reload to clear the cache.
- **Files:** `bff.routes.ts:506–547`, `apps/web/lib/api/client.ts:561–570`, `apps/web/lib/hooks/use-dashboard.ts`.

**MA-07 [C3-realism] — `brand.service.list()` org-level authority guard 403s brand-only members: document M1 invariant**
- **AC modified:** AC-3
- **Severity:** HIGH (403 for brand-only members without org-level row; M1 assumption must be explicit)
- **Problem:** `brand.service.ts:172` checks `findByUserAndOrg(..., null, ctx)` — org-level membership. A user with only a brand-level membership row (no org-level row) will receive 403 before the RLS-filtered query runs. For M1, the assumption is that every brand-member also holds an org-level membership row (the org-level row is created on org creation; brand-level rows are added on brand creation or invite). This assumption MUST be documented explicitly so the future brand-invite feature does not break this guard.
- **Required implementation:** Add a comment in `brand.service.ts:170–177`:
  ```typescript
  // M1 INVARIANT: every brand-member holds a corresponding org-level membership row
  // (brand_id IS NULL) created at org-creation or org-invite time. Brand-invite (post-M1)
  // must also create an org-level row or this guard must be updated to accept brand-only members.
  ```
  No code change required for M1.
- **Files:** `apps/core/src/modules/workspace-access/internal/application/brand.service.ts:170–177`.

**MA-08 [C4-realism] — AC-4 create-brand dashboard action MUST NOT reuse `CreateBrandForm` with its current `onSuccess` handler**
- **AC modified:** AC-4
- **Severity:** HIGH (post-create routing violation — second-brand creator is deposited at the onboarding flow)
- **Problem:** `create-brand-form.tsx:127–133` `onSuccess` calls `router.push(resolveOnboardingRoute(session.onboarding_status))`. For a second brand, `onboarding_status` stays at `'complete'`; the routing target of `resolveOnboardingRoute('complete')` may be `/onboarding/done` — depositing the user at the onboarding wizard. Even if it routes to `/dashboard`, the behavior is implicit and fragile.
- **Required implementation:** The dashboard "Create brand" action must NOT import `CreateBrandForm` directly. Two acceptable patterns:
  - **Option A (recommended):** Extract form fields into a shared headless component. Build a new `DashboardCreateBrandDialog` with its own explicit `onSuccess`: call `queryClient.invalidateQueries` on the brands query, optionally call `brandApi.switchBrand(newBrand.id)` (AC-1), then stay on `/dashboard`.
  - **Option B:** Add an `afterCreate?: (brand: Brand) => void` prop to `CreateBrandForm` that overrides the default routing. Dashboard usage passes an explicit `afterCreate` that does not call `resolveOnboardingRoute`.
  Option A is cleaner and avoids coupling the dashboard flow to the onboarding form's internal routing logic.
- **Files:** `apps/web/components/onboarding/create-brand-form.tsx`, new `apps/web/components/dashboard/create-brand-dialog.tsx` (or equivalent).

### MED

**MA-09 [C7-abuse] — `brand.switch` audit payload MUST capture `from_brand_id`, `to_brand_id`, and `role_granted`**
- **AC modified:** AC-1
- **Severity:** MED (incomplete audit trail; cannot reconstruct brand timeline from audit log alone)
- **Required implementation:**
  ```typescript
  await audit.append({
    action: 'brand.switch',
    actorId: auth.userId,
    brand_id: requestedBrandId,          // context column = the NEW brand (effect of the event)
    payload: {
      from_brand_id: auth.brandId,       // outgoing brand (from JWT before re-mint)
      to_brand_id: requestedBrandId,
      workspace_id: auth.workspaceId,
      role_granted: resolvedMembershipRow.roleCode,
    },
  });
  ```
  Audit must be called after a successful membership check but the response shape (audit-before or audit-after mint) must handle partial failure — if `mintSessionToken` fails after a successful audit write, the audit entry stands (acceptable per existing pattern; document this).

**MA-10 [C8-abuse] — `set-brand` endpoint MUST reject archived brands; add `brand.status = 'active'` guard**
- **AC modified:** AC-1
- **Severity:** MED (archived brand can be switched to; queries succeed under RLS but brand is logically inactive)
- **Required implementation:** After the 3-arg membership check passes, verify `brand.status` from the resolved brand row (or a separate `SELECT status FROM brand WHERE id = $brandId` under the verified GUC context). If `status = 'archived'`, return 400 with a clear error code (e.g. `BRAND_ARCHIVED`). Do NOT add the archived guard to the RLS policy itself (cross-table join in RLS = performance risk; application-layer guard is correct here).

**MA-11 [C9-abuse] — GUC context in `set-brand` membership check must NOT include `brandId`**
- **AC modified:** AC-1
- **Severity:** MED (premature brand GUC contamination on the connection used for the auth check)
- **Required implementation:** The `ctx` argument passed to `findByUserAndOrg` in the set-brand handler must be:
  ```typescript
  const ctx = { correlationId, userId: auth.userId, workspaceId: auth.workspaceId };
  // NO brandId here — identical to set-org pattern at bff.routes.ts:313
  // brandId in ctx sets app.current_brand_id on the pooled connection before we have
  // authorized access to the target brand; this would bleed into subsequent queries.
  ```
  Pattern reference: `bff.routes.ts:313` (the `set-org` ctx construction is the model).

**MA-12 [C5-realism] — Document create-then-switch primary-targeting requirement**
- **AC modified:** AC-1, AC-4
- **Severity:** MED (create-then-switch race under replica lag)
- **Required implementation note only:** The `set-brand` membership check must always target the primary Postgres node. Add a comment in the handler: `// IMPORTANT: membership check must use a primary-targeted connection; do not route to read replica. Brand creation commits synchronously before this call but replica lag can cause 403 on same-request-cycle switch.` No code change required for M1 (single-node Postgres); mandatory revisit before any read replica is introduced.

### LOW

**MA-13 [C10-abuse] — Document `findActiveByUser` auto-select behavior for multi-brand users**
- **AC modified:** AC-6 (existing)
- **Severity:** LOW (UX surprise; no security impact)
- **Required implementation note:** In the implementation handoff, document: "On fresh login, `findActiveByUser` resolves the most-recently-created brand-level membership (`ORDER BY (brand_id IS NOT NULL) DESC, created_at DESC LIMIT 1`). For a multi-brand user, this is always the last-created brand, not the last-used brand. The `brand.switch` audit trail (MA-09) provides retroactive reconstruction. 'Remember last active brand' is deferred to the next requirement."

**MA-14 [C6-realism] — Switcher scope: brands within current org only for M1**
- **AC modified:** AC-3
- **Severity:** LOW (scope clarification)
- **Required implementation note:** The brand switcher lists only brands within `auth.workspaceId` (the current org). Cross-org brand switching follows the existing two-step: `set-org` first (existing), then `set-brand`. The switcher does not need to handle cross-org cases. With the workspace-GUC filter added to `brand_self_read` (MA-04), the `GET /api/v1/bff/brands` response is already org-scoped.

**MA-15 [C7-realism] — Switcher UX: always show switcher + "+ Create brand" CTA even for single-brand users**
- **AC modified:** AC-3, AC-4
- **Severity:** LOW (product-realism / discoverability)
- **Recommendation:** For Owner/Brand-Admin users with a single brand, show the switcher with the single active brand AND a "+ Create brand" option. Hidden switcher = users never discover multi-brand capability. Non-actionable choice (single brand, no switch option) is acceptable UX for non-Owner roles.

---

## Part 2 — Finalized Acceptance Criteria (incorporating all persona modifications)

**AC-1 — New BFF endpoint `POST /api/v1/bff/session/set-brand` (modified by MA-01, MA-02, MA-03, MA-05, MA-09, MA-10, MA-11)**

Contract:
- Route: `POST /api/v1/bff/session/set-brand`
- PreHandler: `sessionPreHandler` (DB revocation check — not JWT-only) [MA-05]
- CSRF: enforced by app-wide onRequest hook (not exempt)
- Input: `{ brand_id: string }` from body only. `workspaceId` from `auth.workspaceId` (JWT). If `auth.workspaceId` is null → 400. [MA-02]
- Step 1: `ctx = { correlationId, userId: auth.userId, workspaceId: auth.workspaceId }` — NO `brandId` in ctx [MA-11]
- Step 2: `row = await memberRepo.findByUserAndOrg(auth.userId, auth.workspaceId, body.brand_id, ctx)` — three-arg form, non-null third arg [MA-01, MA-03]
- Step 3: If no row → 403. [MA-01]
- Step 4: Verify `brand.status === 'active'` (check from brand row or secondary query) — if `archived` → 400 `BRAND_ARCHIVED` [MA-10]
- Step 5: `activeContext = { brandId: row.brandId, workspaceId: row.organizationId, role: row.roleCode }` — role from BRAND-LEVEL row [MA-03]
- Step 6: `{ accessToken, expiresIn } = await authService.mintSessionToken(auth.userId, auth.jti, activeContext)` — NEVER `refreshSession` or `resolveActiveContext` [MA-01]
- Step 7: `await audit.append({ action: 'brand.switch', actorId: auth.userId, brand_id: body.brand_id, payload: { from_brand_id: auth.brandId, to_brand_id: body.brand_id, workspace_id: auth.workspaceId, role_granted: row.roleCode } })` [MA-09]
- Step 8: Set httpOnly cookie; return `{ auth: { brand_id, workspace_id, role } }` (same shape as set-org response)
- Document TOCTOU gap (remove+switch sub-millisecond window) in implementation [MA-05]
- Document create-then-switch primary-targeting requirement [MA-12]

**AC-2 — `brand_self_read` RLS policy (migration `0013_brand_self_read.sql`) (modified by MA-04)**

- `FOR SELECT`, `TO brain_app`
- `USING` subquery: `m.brand_id IS NOT NULL AND m.app_user_id = GUC(current_user_id) AND m.organization_id = GUC(current_workspace_id)` [MA-04 workspace filter]
- Soft-delete warning comment REQUIRED [MA-04]
- NN-1 two-arg negative-control assertion block REQUIRED [MA-04]
- Must ship before or atomically with AC-1 backend implementation (it is a hard dependency of the brand list and the switcher)

**AC-3 — Brand switcher UI (modified by MA-14, MA-15, MA-06)**

- Lists brands via `GET /api/v1/bff/brands` (or `brandApi.list()`), scoped to `auth.workspaceId` (current org only — no cross-org listing in M1) [MA-14]
- Active brand indicated by matching `auth.brandId` from session (not array index) [MA-06 adapter fix]
- Selecting a brand calls `brandApi.switchBrand(id)` → AC-1 endpoint
- On success: call `queryClient.invalidateQueries({ queryKey: ['dashboard'] })` then redirect/reload in new brand context [MA-06 cache invalidation]
- Single-brand users: show the switcher with active brand + "+ Create brand" CTA (for Owner/Brand-Admin) — do NOT hide the switcher [MA-15]
- Do NOT call `set-brand` if the selected brand is already the active brand (no-op guard on client)
- After switch: full page reload is acceptable; soft-navigate requires explicit cache invalidation before navigation

**AC-4 — Create additional brand UI (modified by MA-08, MA-15)**

- Visible to Owner/Brand-Admin only (client: check `auth.role`; backend is source of truth)
- Entry point: inside the brand switcher ("+ Create brand" CTA) and/or a dashboard action [MA-15]
- Implementation: `DashboardCreateBrandDialog` (new component) — do NOT import `CreateBrandForm` with its default `onSuccess` [MA-08]
- Fields: `display_name`, `currency_code`, `timezone`, `revenue_definition` (same validation as onboarding)
- On success: `queryClient.invalidateQueries` on brands query, optionally call `brandApi.switchBrand(newBrand.id)` to switch to the new brand, then remain on `/dashboard` — NEVER call `resolveOnboardingRoute` [MA-08]
- Does NOT redirect to onboarding wizard
- Document M1 invariant at `brand.service.ts:170`: every brand-member holds an org-level row [MA-07]

**AC-5 — Dashboard brand-summary reflects active brand (modified by MA-06)**

- BFF `brand-summary` handler: filter by `auth.brandId` (active brand from JWT session) — returns active brand name, currency, and per-brand member count [MA-06]
- Member count: `COUNT(DISTINCT app_user_id) FROM membership WHERE organization_id = $orgId AND brand_id = $activeBrandId` [MA-06]
- Response payload: include `active_brand_id` field so client can verify it matched session state [MA-06]
- BFF adapter (`client.ts:getBrandSummary`): resolve brand by `response.active_brand_id`, not `brands[0]` [MA-06]
- `useBrandSummary` hook: cache invalidated on brand switch (via AC-3's `invalidateQueries` call) — the 60s staleTime is acceptable between switches; the invalidation on switch is mandatory [MA-06]
- Under `brain_app` with 0013 shipped, the existing broad query will return all member brands — the handler must scope it to active brand using `auth.brandId` as a WHERE clause filter, not rely on RLS alone

**AC-6 — `findActiveByUser` multi-brand behavior (unchanged from 02 review; LOW concern)**

- No code change required
- Document behavior in implementation: "login auto-resolves most-recently-created brand membership; user switches via AC-3" [MA-13]

**AC-7 — Isolation fuzz: brand-switch test case (unchanged from 02 review)**

- After `set-brand` to brand B, a query for brand A's `connector_instance` / `brand` rows MUST return zero results under `brain_app`
- Test must not be skipped
- Add to `tools/isolation-fuzz` suite

---

## Part 3 — Deferred List (unchanged from 02 review; confirmed out of scope)

| Item | Reason |
|---|---|
| Cross-org brand moves | Org-transfer logic; separate requirement |
| Brand deletion / archival lifecycle | Soft-delete flow + downstream suppression; separate requirement |
| Per-brand billing | Billing meter; separate M-milestone requirement |
| Brand-level theming | UI + CDN; separate requirement |
| "Remember last active brand" across re-logins | Needs `last_active_brand_id` persistence; separate UX requirement |
| MFA / Authentik / Google one-tap | Deferred from feat-access-onboarding-flow (SD-1 stands) |
| Brand-level invite flow | Per-brand role grants + invite email scoped to brand; post-M1 |
| Per-brand member management UI | Separate surface |

---

## Part 4 — Canon Verification (confirmed)

**No Canon amendment required.**

- STACK.md: no new primitive; no new ADR; no new infrastructure.
- INVARIANTS.md: I-S01 (brand isolation absolute) holds. `brand_self_read` is a SELECT-only, membership-predicated addition — it does not allow cross-tenant reads.
- TRIGGER-SURFACES.md: `auth` and `multi_tenancy` surfaces correctly assigned. The workspace-GUC filter on `brand_self_read` (MA-04) keeps the policy within the multi_tenancy surface already flagged.
- METRICS.md: no metric change; per-brand currency already the model.
- Cost paradigm: Tier-0 deterministic throughout. Zero model calls. No cost-routing audit section required.
- M1 invariant for `brand.service.list()` authority guard (MA-07) is an explicit documentation note, not a Canon change.

---

## Part 5 — Lane and Build Tracks (confirmed)

**Lane: high_stakes — CONFIRMED.**
Surfaces: `auth` (session re-mint, JWT brand_id/role update, CSRF, revocation), `multi_tenancy` (new RLS policy, brand-switch as isolation boundary event).

**Build tracks:**
- **backend-developer:** AC-1 (`set-brand` endpoint), AC-2 (migration 0013), AC-5 BFF handler update, AC-7 isolation test, MA-07 code comment
- **frontend-web-developer:** AC-3 (brand switcher UI), AC-4 (create-brand dialog), AC-5 adapter + cache invalidation, MA-06 BFF adapter fix

Both tracks can proceed in parallel once migration 0013 is deployed and AC-1 endpoint is live.

---

## Part 6 — Summary of Must-Address Counts

| Severity | Count | Items |
|---|---|---|
| CRITICAL | 2 | MA-01 (mintSessionToken direct path), MA-02 (workspaceId from JWT only) |
| HIGH | 6 | MA-03 (brand-level role), MA-04 (0013 workspace filter + soft-delete comment + NN-1), MA-05 (sessionPreHandler), MA-06 (brand-summary filter + cache), MA-07 (M1 invariant doc), MA-08 (create-brand routing) |
| MED | 4 | MA-09 (audit from/to), MA-10 (archived-brand reject), MA-11 (GUC ctx no brandId), MA-12 (primary-targeting note) |
| LOW | 3 | MA-13 (findActiveByUser doc), MA-14 (switcher scope), MA-15 (switcher CTA) |
| **Total** | **15** | |
