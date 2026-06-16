# 02b — Persona Review: Scope & Product-Realism Skeptic
## feat-multi-brand — Multi-brand: create additional brands + brand switcher

**persona:** scope-product-realism-skeptic
**reviewed_at:** 2026-06-16T04:52:00Z
**req_id:** feat-multi-brand
**decision:** PASS (with required corrections)
**severity_max:** HIGH

---

## Journal Stub

```
## 2026-06-16T04:52:00Z — Persona:scope-product-realism-skeptic — feat-multi-brand
Angle: AC-3 brand list + AC-5 active-brand dashboard refresh + create-then-switch race + onboarding_status re-trigger on 2nd brand
Top concern: brand_summary stale-cache defect — after set-brand the TanStack Query cache for ['dashboard','brand-summary'] has staleTime=60s and no invalidation hook; the card will continue showing the OLD brand name and OLD member count for up to 60 seconds post-switch, silently
Severity: HIGH
```

---

## Evidence Base

Files read:
- `/apps/core/src/modules/frontend-api/internal/bff.routes.ts` (lines 506–547) — the `brand-summary` BFF handler
- `/apps/web/lib/hooks/use-dashboard.ts` — `useBrandSummary` with `staleTime: 60_000`
- `/apps/web/lib/api/client.ts` (lines 561–570) — `getBrandSummary` adapter; picks `brands[0].display_name`
- `/apps/web/components/dashboard/brand-summary-card.tsx` — renders `data.brand_name` and `data.member_count`
- `/apps/web/app/(dashboard)/layout.tsx` — no switcher slot; no `queryClient.invalidateQueries` on brand switch
- `/apps/core/src/modules/workspace-access/internal/application/brand.service.ts` (lines 67–106) — authority check, `advanceOnboardingStatus` call
- `/apps/core/src/modules/workspace-access/internal/application/auth.service.ts` (lines 560–609) — `resolveActiveContext` signature; no `preferredBrandId` parameter
- `/apps/core/src/modules/workspace-access/internal/infrastructure/repositories.ts` (lines 672–697) — `findByOrganizationId` uses `WHERE organization_id = $1`; no per-user membership filter
- `/apps/web/components/onboarding/create-brand-form.tsx` — onboarding wizard form re-used in onboarding flow only; no dashboard entry point
- `.engineering-os/runs/.../01b-stakeholder-scope-decisions.json` — SD-2 confirmed: active-brand-first, per-brand member count on switch

---

## Concern 1 (HIGH) — Stale dashboard cache after brand switch

**Gap:** After `set-brand` succeeds, the browser session cookie is updated with the new `brand_id`. However, the `useBrandSummary` hook uses `staleTime: 60_000` and is NOT invalidated anywhere in the switcher flow. The `brand-summary` BFF handler returns `brands[0].display_name` from a query ordered by `created_at DESC` — after a switch, that will still be the first/most-recent brand at org level, not the active brand. Under the Stakeholder decision SD-2 ("active-brand-first, per-brand member count"), the member count must also be filtered to the new brand's `brand_id`. Neither the cache invalidation nor the per-brand member count filter exists today.

**Evidence:**
- `use-dashboard.ts:14`: `staleTime: 60_000` — the React Query cache for `['dashboard','brand-summary']` will serve stale data for up to 60 seconds post-switch.
- `client.ts:568`: `brand_name: data.brands[0]?.display_name ?? ''` — picks the first item in the BFF array, not the session-active brand. This is wrong post-switch regardless of cache.
- `bff.routes.ts:524–526`: member count is `COUNT(DISTINCT app_user_id) FROM membership WHERE organization_id = $1` — org-level, not brand-level. SD-2 explicitly requires per-brand member count on the active-brand card.
- Dashboard layout (`layout.tsx`) has no `queryClient.invalidateQueries` call on brand switch; no `onSuccess` hook to trigger cache invalidation.

**Concrete failure scenario:** User has Brand A (3 members) and Brand B (1 member). They switch to Brand B. For up to 60 seconds, the BrandSummaryCard shows Brand A's name and "3 members." Worse, even after the staleTime expires, the refreshed query still returns the wrong brand name because the BFF adapter picks `brands[0]` (most-recently-created brand at org level) rather than the session-active brand.

**Required fixes (both needed):**
1. The `set-brand` client handler MUST call `queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY })` on success before or immediately after the page reload. A full-page reload after switch (which AC-3 permits) would naturally discard the cache — but if the implementation uses session-refresh-then-soft-navigate instead of a hard reload, the cache is NOT cleared automatically.
2. The BFF `brand-summary` handler MUST be updated per SD-2: use `auth.brandId` (from the session JWT) to (a) pick the active brand name from the result set by `id` match rather than array index, and (b) filter the member count to `WHERE organization_id = $1 AND brand_id = $2` for the per-brand count.
3. The BFF adapter in `client.ts:getBrandSummary` MUST be updated to match: rather than `brands[0]`, resolve the active brand by matching the session's `auth.brandId` — but the BFF response must expose `active_brand_id` in the payload for the client to key off.

**Files touched:** `apps/web/lib/hooks/use-dashboard.ts`, `apps/web/lib/api/client.ts`, `apps/core/src/modules/frontend-api/internal/bff.routes.ts`.

---

## Concern 2 (HIGH) — AC-3 brand list (`brandApi.list`) returns ALL org brands, not user's brands

**Gap:** The Advisor's AC-3 states: "Calls `GET /api/v1/bff/brands` (or the existing `brandApi.list()`) to list the brands the user has membership in." But `brand.service.list()` calls `brandRepo.findByOrganizationId(organizationId, ...)` which queries `WHERE organization_id = $1` — it returns ALL brands in the org, not just the brands the user holds a membership row for.

After `brand_self_read` ships (migration 0013), the RLS policy filters by `membership.app_user_id`, so under `brain_app` the query will naturally return only brands the user is a member of. This means AC-3's correctness is entirely dependent on the RLS working as the gate — there is no application-layer filter in `brand.service.list()`.

**Why this is a realism risk:** The `brand.service.list()` authority check only confirms the user has an org-level membership (`memberRepo.findByUserAndOrg(..., null, ctx)`) before running the query. An org-level member who is NOT a member of a specific brand will not get that brand back from RLS (correct), but a brand-only member who holds no org-level membership row will fail the authority check at line 172 and receive a 403 before RLS even runs. The product requirement says a user can hold per-brand memberships; it does not say they always have an org-level membership row. Confirm: does every user who has a brand-level membership also have a corresponding org-level membership row (`brand_id IS NULL`)? If `memberRepo.insert` in `brand.service.create` only creates the brand-level row (lines 88–96), and the org-level row was created at org-creation time, then users invited to a specific brand (not the org) would fail the `list` authority check with a 403.

**Evidence:** `brand.service.ts:172` performs `findByUserAndOrg(..., null, ctx)` — org-level check. `brand.service.ts:88–96` inserts only the brand-level membership on brand creation (the org-level membership for the creator was already present from org creation). The invite flow scope for brand-only members is deferred — but this creates a latent inconsistency between the list authorization model and the data model.

**Recommended clarification:** Confirm that for M1, every user in the system always has an org-level membership row before they can hold brand-level memberships. If yes, the guard is correct for M1. Document this assumption explicitly in the handoff so the future brand-invite feature does not silently break `brand.service.list()`.

**Files touched:** `apps/core/src/modules/workspace-access/internal/application/brand.service.ts` (lines 170–177), `apps/core/src/modules/workspace-access/internal/infrastructure/repositories.ts` (lines 672–697).

---

## Concern 3 (HIGH) — `resolveActiveContext` has no `preferredBrandId` parameter; `set-brand` cannot be built using `refreshSession` as-is

**Gap:** The Advisor's AC-1 specifies the `set-brand` endpoint should call `refreshSession(userId, jti, correlationId)` with a `preferredBrandId` extension. But the current `refreshSession` signature at `auth.service.ts:597` is:

```typescript
async refreshSession(userId, jti, correlationId, preferredWorkspaceId?)
```

And `resolveActiveContext` at line 560:

```typescript
async resolveActiveContext(userId, correlationId, preferredWorkspaceId?)
```

There is no `preferredBrandId` parameter. `resolveActiveContext` at line 566–573 will, when given a `preferredWorkspaceId`, call `findByUserAndOrg(userId, workspaceId, null, ctx)` — the org-level null form — then fall back to `findActiveByUser` if that fails. Neither path threads through a specific `brand_id`. The `set-brand` endpoint needs to resolve the user's role for a SPECIFIC brand, not the most-recent one. Without the brand parameter reaching `resolveActiveContext`, the re-minted JWT will contain the brand the system auto-selects (most-recently-created), not the brand the user explicitly chose.

**Concrete failure scenario:** User has Brand A (owner) and Brand B (analyst). They click "Switch to Brand B." The `set-brand` endpoint verifies membership in Brand B (correct). It then calls `refreshSession(userId, jti, correlationId)` — without a way to pass `brandId`. `resolveActiveContext` calls `findActiveByUser` which returns the most-recently-created brand membership — which might be Brand A. The re-minted JWT has `brand_id = Brand A, role = owner`. The user gets the wrong brand context.

**Required fix:** `refreshSession` and `resolveActiveContext` must accept an optional `preferredBrandId` parameter. The `resolveActiveContext` logic must be extended: if `preferredWorkspaceId` AND `preferredBrandId` are both provided, call `findByUserAndOrg(userId, workspaceId, brandId, ctx)` — the three-arg form — to resolve the exact brand-level membership. The Advisor noted this as "a `preferredBrandId` extension" but did not confirm it requires code changes to two existing methods. This is a required implementation change, not an optional pattern.

**Files touched:** `apps/core/src/modules/workspace-access/internal/application/auth.service.ts` (lines 560–609), `apps/core/src/modules/frontend-api/internal/bff.routes.ts` (set-brand handler, to be written).

---

## Concern 4 (MED) — `create-brand-form.tsx` re-routes to onboarding wizard after creating a 2nd brand

**Gap:** The existing `CreateBrandForm.onSuccess` handler (line 127–133 of `create-brand-form.tsx`) calls `sessionApi.refresh()` then `router.push(resolveOnboardingRoute(session.onboarding_status))`. For a first brand, `onboarding_status = 'brand_created'` routes to `/onboarding/integrations`. For a 2nd brand, `advanceOnboardingStatus` is idempotent and `onboarding_status` stays at `'complete'`. `resolveOnboardingRoute('complete')` must therefore route to `/dashboard` — or the user gets bounced back into the onboarding wizard flow.

This relies on `resolveOnboardingRoute` correctly handling `'complete'` as a terminal state that routes to `/dashboard`. If that function routes `'complete'` to `/onboarding/done` (the final wizard step), the user creating a second brand from the dashboard will be deposited on the onboarding "done" screen — a jarring UX regression.

**Evidence:** `create-brand-form.tsx:129` — `router.push(resolveOnboardingRoute(session.onboarding_status))`. The form is only used in the onboarding context currently (there is no dashboard entry point for brand creation yet — AC-4 must build one). However the Advisor's AC-4 says to reuse the same `brandApi.create()` call. If the new dashboard "Create brand" UI reuses this form component, the post-create routing MUST be overridden (e.g. via a prop `onSuccess` callback) to stay on the dashboard rather than follow the onboarding route resolver.

**Required fix:** AC-4's "Create brand" dashboard action must NOT reuse `CreateBrandForm` directly with its current `onSuccess` behavior. Either (a) extract the form fields into a shared component and provide a dashboard-specific `onSuccess` that calls `brandApi.switchBrand(newBrand.id)` then stays on `/dashboard`, or (b) add an `afterCreate` prop to `CreateBrandForm` that overrides the default route-to-onboarding behavior. Option (a) is cleaner.

**Files touched:** `apps/web/components/onboarding/create-brand-form.tsx`, and the new dashboard brand-create component (to be built).

---

## Concern 5 (MED) — Create-then-switch race: membership row visibility before `set-brand` call

**Gap:** After `brandApi.create()` resolves, the new brand-level `owner` membership row has been committed. The client then immediately calls `brandApi.switchBrand(newBrandId)` (per AC-4's optional "switch to new brand" flow). The `set-brand` endpoint calls `memberRepo.findByUserAndOrg(userId, workspaceId, brandId, ctx)` — a fresh DB query. Under normal conditions this is fine: the `create` call committed synchronously before `switchBrand` is called. However, if the backend uses any form of read replica routing (even just pgbouncer with a short lag) or if `switchBrand` is called in parallel with the session cookie being set (a race in the client), the membership row may not be visible and `set-brand` would 403.

**Evidence:** `brand.service.ts:88–96` inserts the membership synchronously in the same `pool.connect()` client before the brand creation endpoint returns. If the `set-brand` endpoint acquires a different client that hits a lagged replica, the membership row is not visible. In the current single-node Postgres setup for M1, this is unlikely but not impossible under connection pool pressure.

**Recommendation:** `set-brand` should use the same `QueryContext` strategy for the membership check (a fresh primary-targeted client). If pgbouncer or a read replica is ever introduced, the membership check in `set-brand` should explicitly target the primary. Flag this in the AC-1 implementation note: "membership check query must target primary; do not route to read replica." No code change required now; document the assumption.

---

## Concern 6 (LOW — scoping) — Switcher scope: brands-within-current-org vs. all user brands across orgs

**Gap:** The requirement says "the switcher lists brands the user is a member of (possibly across orgs)." The Advisor correctly notes the two-step compose model: set-org first, then set-brand within the org. However, if the switcher shows brands across orgs, a user switching to a brand in Org B while currently in Org A needs to trigger `set-org` then `set-brand` — two calls, and the intermediate state (valid JWT for Org B but no brand yet) must be handled. AC-3 defers the UI placement entirely to the implementation. For M1, **recommending brands-within-current-org only** as the switcher scope. This is the minimal correct model and matches the two-step compose:

- Switcher queries `GET /api/v1/bff/brands` — which is already scoped to `auth.workspaceId` (the org in the current JWT). With `brand_self_read`, this returns only brands the user is a member of within the current org.
- Cross-org brand switching is org-switch first (existing `set-org`) then brand-switch. The switcher does not need to handle this case.

This is a scope recommendation, not a blocker, but must be explicitly captured in the AC-3 implementation note to prevent scope creep.

---

## Concern 7 (LOW) — Single-brand user: switcher hidden vs. non-clickable

**Gap:** AC-3 says "if user has only one brand — switcher either hidden or shows the single brand as non-clickable (UX decision)." Hiding the switcher entirely when there is only one brand means the user never discovers that brand creation is possible from the dashboard. Recommend showing the switcher with the single active brand and a "+ Create brand" option (visible to Owner/Brand-Admin) even in the single-brand case. This prevents the stakeholder from re-filing "I can't see where to create a second brand." The "Create brand" CTA inside the switcher is the natural discovery point.

This is a product-realism flag, not a code bug. Capture it in AC-4 as a required UX anchor.

---

## Summary Table

| # | Concern | Severity | Files | Must-fix? |
|---|---|---|---|---|
| C-1 | Stale dashboard cache post-switch + wrong brand name + wrong member count | HIGH | `use-dashboard.ts`, `client.ts`, `bff.routes.ts:524` | YES — breaks SD-2 |
| C-2 | `brandApi.list` / `brand.service.list` uses org-level auth guard that 403s brand-only members | HIGH | `brand.service.ts:172` | YES — clarify/document M1 assumption |
| C-3 | `resolveActiveContext` / `refreshSession` missing `preferredBrandId` param; `set-brand` will re-mint wrong brand | HIGH | `auth.service.ts:560–608` | YES — blocks AC-1 correctness |
| C-4 | `CreateBrandForm.onSuccess` routes via `resolveOnboardingRoute` — will break for 2nd-brand creation if form is reused | MED | `create-brand-form.tsx:127–133` | YES — AC-4 must not reuse form as-is |
| C-5 | Create-then-switch race under replica lag | MED | AC-1 implementation note | Document only for M1 |
| C-6 | Switcher scope: recommend brands-within-current-org only for M1 | LOW | AC-3 spec note | Scoping recommendation |
| C-7 | Single-brand switcher should expose "+ Create brand" CTA to prevent re-report | LOW | AC-3/AC-4 UX spec | UX recommendation |
