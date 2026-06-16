# 02b — Scope & Product-Realism Skeptic Review
## feat-access-onboarding-flow

| Field | Value |
|-------|-------|
| **req_id** | `feat-access-onboarding-flow` |
| **Persona** | Scope & Product-Realism Skeptic |
| **Tier** | `:sonnet` |
| **Authored at** | 2026-06-16T00:30:00Z |
| **Decision** | PASS — with 7 concrete concerns, 3 HIGH severity |

---

## Journal stub

```
## 2026-06-16T00:30:00Z — Persona:scope-product-realism-skeptic — feat-access-onboarding-flow
Angle: Canon-amendment test, migration compatibility, wizard buildability, step-state robustness, what exactly the Stakeholder sees as failing
Top concern: needs_onboarding is a binary brandId===null check — cannot route to a mid-wizard resume point; any crash after Step 2 lands the user at Step 1 indefinitely
Severity: HIGH
```

---

## What the Stakeholder actually sees as broken (exact gap mapping)

Reading the shipped frontend against the spec:

**Symptom 1 — Step labels say "Step N of 3", spec requires 4 steps.**
Evidence: `/apps/web/app/(onboarding)/workspace/new/page.tsx` line 11 hard-codes "Step 1 of 3"; `/apps/web/app/(onboarding)/brand/new/page.tsx` line 11 hard-codes "Step 2 of 3"; the invite step at `/apps/web/app/(onboarding)/invite/page.tsx` says "Step 3 of 3" — which is the team-invite screen, not the integration-selection screen required by the spec. The team-invite screen is not in the 4-step spec at all.

**Symptom 2 — Redirect fires after Step 2, skipping Steps 3 and 4.**
Evidence: `create-brand-form.tsx` line 53: `router.push('/dashboard')` fires immediately after `onSuccess` of brand creation. There is no integration-selection or Done step in the current route tree. The Stakeholder completes Step 2 and lands in the dashboard, which is exactly the gap named in the spec.

**Symptom 3 — Brand form has no currency, timezone, or revenue_definition fields.**
Evidence: `createBrandSchema` in `apps/web/lib/api/schemas.ts` has only `display_name` and `domain`. The `brand` table (migration `0004_brand.sql`) has only `display_name`, `domain`, `status`, `region_code`. No `currency_code`, `timezone`, `revenue_definition` columns exist in any migration.

**Symptom 4 — region_code is hard-coded to 'IN' in the frontend.**
Evidence: `create-brand-form.tsx` line 41: `region_code: 'IN'` hard-coded in the submit payload. `create-workspace-form.tsx` line 49: same. No UI field for region selection. This is an implicit scope item — if the spec says currency contradicting region shows a confirm-prompt, but region is never collected, the confirm-prompt cannot trigger.

**Symptom 5 — No resume-after-crash. The onboarding gate is binary.**
Evidence: `login-form.tsx` line 32: `router.push(result.needs_onboarding ? '/workspace/new' : '/dashboard')`. The `needs_onboarding` flag is computed in `bff.routes.ts` line 166 as `result.context.brandId === null`. This means: if brandId is null → always restart at `/workspace/new`. A user who crashes after Step 1 (org created, no brand yet) is sent to `/workspace/new` — correct, as org creation is Step 1. But a user who crashes after Step 2 (brand created, integration step not yet done) has `brandId !== null`, so `needs_onboarding = false`, and is routed to `/dashboard`, skipping the integration step entirely. There is no `onboarding_status` column on `organization` and no separate onboarding-progress table.

**Symptom 6 — The third onboarding step is "Invite your team", not "Integration selection".**
Evidence: `apps/web/app/(onboarding)/invite/page.tsx` exists and routes through the `(onboarding)` layout. The spec says Step 3 is Integration selection (Shopify connect or skip). Team invite is not in the 4-step spec and appears to be a legacy artifact from before this spec was written. The route `/invite` inside the `(onboarding)` group is not referenced from `brand/new` — the brand form redirects directly to `/dashboard`, so this page may be unreachable in the current flow.

---

## Concern 1 (HIGH) — Onboarding resume is broken by design; the binary `needs_onboarding` flag cannot express mid-wizard state

**Risk:** `needs_onboarding: brandId === null` is a coarse gate. A user who finishes Step 2 (brand created) but has not done Step 3 (integration) is incorrectly classified as `needs_onboarding = false` and routed to `/dashboard`. Adding `onboarding_status` to `organization` (as AC-5 proposes) is correct, but the BFF session refresh response currently only returns `needs_onboarding: boolean` — the frontend has no field to consume a step-level resume URL. The Architect must design the full contract: the BFF login and session-refresh responses must return `onboarding_status` (e.g. `'pending' | 'org_created' | 'brand_created' | 'integration_selected' | 'complete'`) and the frontend `login-form.tsx` must use it to compute the correct redirect target, not a boolean.

**Files touched:** `apps/core/src/modules/frontend-api/internal/bff.routes.ts` (lines 158–168, 200–204), `apps/web/components/auth/login-form.tsx` (line 32), migration `0010/0011` (new column on `organization`).

**Recommendation:** Replace `needs_onboarding: boolean` in the BFF session response with `onboarding_status: string | null` (the enum value from `organization.onboarding_status`). The frontend maps this to a resume URL via a deterministic lookup table. Include this in the session-refresh response too (post-brand-creation refresh must also return the updated status). The migration adds the column and advances the status at each step via the BFF route handlers for workspace creation and brand creation, not just at login.

---

## Concern 2 (HIGH) — Brand schema migration has an RLS isolation trap: the new NOT NULL columns on `brand` cannot be read by `brain_app` for existing rows during the migration window

**Risk:** The `brand` table has RLS enforced (`FORCE ROW LEVEL SECURITY`) with the policy `id = current_setting('app.current_brand_id', TRUE)::uuid`. A migration adding `NOT NULL DEFAULT` columns runs as a superuser/migration role (not `brain_app`) and will succeed for row storage. However, the RLS policy means that existing brand rows will not be readable by the application role without a valid `app.current_brand_id` GUC being set. This is not a migration-time problem but a zero-downtime deployment concern: if the migration deploys before the application code that supplies `currency_code` in the `INSERT`, then:

1. New brand rows created by old code will INSERT with `region_code='IN'` only and the DB will fill `currency_code='INR'` (the DEFAULT). This is safe.
2. Existing brand rows at migration time will have the DEFAULT applied by Postgres (`ADD COLUMN ... NOT NULL DEFAULT` does a catalog-only change in PG14+ for new columns with a `DEFAULT` that is not volatile). This is safe.

The real trap is if `brand.service.ts` `BrandRepository.insert()` is called before the backend code is updated to supply `currency_code`, `timezone`, `revenue_definition` — the `INSERT` query in `repositories.ts` line 458 will fail with "column does not exist" on old code, or succeed with defaults on new code. This is a deploy-order dependency: **migrate first, deploy app code second**. This must be explicit in the architecture plan. There is also a concern that the `BrandRepository.mapRow` function (which maps SQL rows to the `Brand` domain entity) will break if the `Brand` entity type is updated to include `currencyCode` before the column exists in the DB.

**Files touched:** `apps/core/src/modules/workspace-access/internal/infrastructure/repositories.ts` (lines 452–463, the `mapRow` function), migration `0010_brand_locale.sql`.

**Recommendation:** The migration must be additive-only with a `DEFAULT` so Postgres does a catalog-only add (no table rewrite, no lock escalation in PG14+). The deploy sequence must be: (1) run migration, (2) deploy backend with updated `BrandRepository` that returns the new fields, (3) deploy frontend with new brand form fields. The Architect must document this three-step deploy sequence explicitly and include a down migration that `DROP COLUMN`s the three new columns (reversible in the first deploy window before any brand has set non-default values).

---

## Concern 3 (HIGH) — `onboarding_status` placed on `organization` breaks when a user has multiple brands in one org (future path); the current single-brand assumption is hidden

**Risk:** AC-5 proposes adding `onboarding_status` to `organization`. This implies a single onboarding flow per organization. But the `brand` entity is the tenant unit (TRIGGER-SURFACES.md: "brand = workspace is the unit of everything"). A user can add a second brand to an org — at that point, which brand's onboarding does `organization.onboarding_status` track? The current code already handles multi-brand via `BrandRepository.findByOrganizationId`. If a user creates Org → Brand A (complete) → Brand B (new), the org-level `onboarding_status = 'complete'` (from Brand A) means Brand B will never trigger the wizard.

**Files touched:** migration `0010/0011`, `auth.service.ts` `resolveActiveContext`, `bff.routes.ts` login response.

**Recommendation:** Either (a) accept that `onboarding_status` tracks the organization's FIRST onboarding only (first brand creation completes it; subsequent brands have no wizard) and document this explicitly as a M1 constraint, or (b) move `onboarding_status` to `brand` and track per-brand wizard completion. Option (b) aligns with "brand = tenant unit" from the Canon. The CTO advisor review recommends the `organization` table — the Architect must validate this matches the intended product behavior and call out the multi-brand edge case explicitly. This is a scope decision that should be confirmed before architecture.

---

## Concern 4 (MED) — The `/invite` onboarding step is a dead route and a misleading scope artifact

**Risk:** The existing `apps/web/app/(onboarding)/invite/page.tsx` route (Step 3 of 3 in the current M1 wizard) is unreachable in the current flow because `create-brand-form.tsx` redirects directly to `/dashboard` after brand creation. It is also not the Step 3 the spec requires (integration selection, not team invite). The CTO advisor review and AC-6 correctly describe what Step 3 should be (integration selection), but the shipped code has a different "Step 3" page that the team may see and assume is nearly correct. This creates a risk of the builder trying to "fix" the existing invite step instead of replacing it with the integration-selection page.

**Files touched:** `apps/web/app/(onboarding)/invite/page.tsx`, `apps/web/components/onboarding/invite-team-form.tsx`.

**Recommendation:** The Architect plan must explicitly call out: (1) `/invite` inside `(onboarding)` is to be REMOVED or rerouted out of the onboarding group; (2) `components/onboarding/invite-team-form.tsx` is deprecated in the wizard context; (3) the new Step 3 page must be created at `/onboarding/integrations` (or equivalent) under the `(onboarding)` group. Failure to explicitly deprecate these files risks a builder leaving the ghost step in place.

---

## Concern 5 (MED) — The onboarding progress endpoint (`/api/v1/dashboard/onboarding-progress`) includes pixel_installed as Step 5 — which directly contradicts the spec's "Pixel is NOT in onboarding"

**Risk:** `bff.routes.ts` lines 567–573 queries `pixel_installation` as step 5 of the onboarding progress widget. The spec (§1.3) states "Pixel install is NOT part of onboarding — it's done later in Tracking." The CTO advisor review correctly confirms this. However, the shipped BFF endpoint already treats pixel as a progress step, and the `OnboardingProgressCard` component on the dashboard renders all 5 steps including `pixel_installed`. This endpoint will remain in use post-fix (the dashboard shows onboarding progress) — the question is whether `pixel_installed` should be a progress step there. The Architect must decide: (a) keep pixel as a post-onboarding dashboard widget step (acceptable — it is in `settings/pixel`, not in the wizard), or (b) remove it from the progress endpoint entirely. What is NOT acceptable is including it as a step in the 4-step wizard, which the endpoint currently does not do (the wizard and the progress widget are separate surfaces).

**Files touched:** `apps/core/src/modules/frontend-api/internal/bff.routes.ts` (lines 498–619), `apps/web/components/dashboard/onboarding-progress-card.tsx` (not read but referenced).

**Recommendation:** Clarify that the `onboarding-progress` BFF endpoint is a dashboard widget (post-onboarding checklist), NOT the wizard state machine. The 4-step wizard must have its own state (the `onboarding_status` enum in AC-5). These are two separate data models: wizard completion state (persisted on `organization`) vs. broader setup health checklist (the BFF progress endpoint). Document the distinction explicitly in the architecture plan. The pixel step in the BFF progress endpoint is fine as a dashboard checklist item — it must simply never appear as a step in the 4-step wizard route group.

---

## Concern 6 (MED) — Currency immutability after first metric is unresolved; METRICS.md makes `currency_code` load-bearing but the spec does not define a mutation policy

**Risk:** METRICS.md states money = `*_minor BIGINT + currency_code CHAR(3)`. Every ledger row has a pinned `fx_rate` at `economic_effective_at`. If a brand changes `currency_code` after their first order is ingested, every historical metric denominated in the old currency becomes incomparable to new metrics. The AC-4 migration adds `currency_code` to `brand` but does not define whether it is immutable after first use. The spec says "currency contradicting region → confirm-prompt" but says nothing about locking the currency after the first metric row exists.

**TRIGGER-SURFACES.md** classifies money changes as high-stakes triggers: "any change to... any rounding/allocation/FX rule." A `currency_code` change on a live brand is economically equivalent to changing the FX rule for all historical rows — it would require restatement of every historical metric or acceptance of a discontinuous series.

**Files touched:** `brand.service.ts` `update()` method (lines 137–173), migration `0010_brand_locale.sql`, METRICS.md (currency rules), potentially `connector_instance` if currency is embedded in connector config.

**Recommendation:** The Architect must add a policy: `currency_code` is immutable after the brand's first `realized_revenue_ledger` row exists. Enforce this at the service layer in `brand.service.ts` `update()`: check for the existence of any ledger row before permitting a `currency_code` change; if rows exist, return a 409 with a clear message ("Currency cannot be changed after financial data has been recorded"). If no ledger rows exist, allow the change. This guard must be documented in TRIGGER-SURFACES.md as a new money/financial boundary.

---

## Concern 7 (LOW) — Multi-org selector (AC-8) routing uses `needs_onboarding` which cannot correctly route a multi-org user who has one complete org and one incomplete org

**Risk:** AC-8 says: if user has > 1 org, show an org-picker before proceeding. After org selection, the current `needs_onboarding: brandId === null` check will re-evaluate. But the binary check cannot distinguish between "selected org has no brand yet" (needs wizard) and "selected org's onboarding is mid-wizard" (needs resume). This compounds Concern 1 specifically for the multi-org path: if a user has Org A (complete) and Org B (mid-wizard), picking Org B should route to the wizard resume step, not to `/workspace/new`. The org-picker must trigger a new `resolveActiveContext` call that returns the selected org's `onboarding_status`, and the frontend must route based on that — not on the previous `needs_onboarding` boolean from the initial login response.

**Files touched:** `auth.service.ts` `resolveActiveContext()`, `bff.routes.ts` session-refresh, `login-form.tsx`.

**Recommendation:** Design the org-picker as a POST to a new `/bff/session/set-org` endpoint that accepts `{ organization_id }`, resolves the active context for that org, re-mints the session cookie, and returns `onboarding_status` (not just `needs_onboarding: boolean`). This is a clean extension of the existing session-refresh pattern and does not require new infrastructure. Do not try to encode multi-org selection in the existing login flow.

---

## Canon-amendment boundary check

| In-scope item | Canon conflict? | Verdict |
|---|---|---|
| `currency_code CHAR(3) CHECK IN ('INR','AED','SAR')` on `brand` | Aligns with METRICS.md money rules and TRIGGER-SURFACES.md currency enum. No Canon amendment needed. | CLEAR |
| `timezone TEXT` on `brand` | Not in TRIGGER-SURFACES.md; not a compliance surface. No Canon amendment needed. | CLEAR |
| `revenue_definition TEXT CHECK IN ('realized','delivered','placed')` on `brand` | Aligns with METRICS.md `realized_revenue` definition. `delivered` and `placed` are not defined as separate metric types in METRICS.md — the Architect must confirm that `revenue_definition = 'delivered'` is a recognized concept (it maps to `provisional_revenue` in METRICS.md, but the brand-level setting is not defined). Potential silent Canon gap. | FLAG — confirm `delivered` and `placed` are accepted values per the metric engine's intake logic, or the CHECK constraint introduces an enum that METRICS.md does not recognize. |
| `onboarding_status` on `organization` | Not a compliance/trigger surface. No Canon amendment needed. | CLEAR |
| Rate limiting on auth endpoints (AC-3) using Redis | Existing Redis (CacheAdapter, ADR-004) is already in use. Fail-open on Redis outage is confirmed acceptable. No Canon amendment. | CLEAR |
| Rotating refresh tokens (AC-1) | App-native, Postgres-only. No Redis session store change. No Canon amendment needed. | CLEAR |

**One silent Canon gap:** The `revenue_definition` enum value `'placed'` does not correspond to any recognized metric in METRICS.md. `realized` maps to `realized_revenue`; `delivered` approximately maps to `provisional_revenue` (items with `recognition_label IN ('provisional','settling')`). But `placed` (i.e. GMV at order placement, before any delivery event) is not defined in the metric registry. Adding a brand-level `revenue_definition = 'placed'` that the frontend exposes without a matching metric engine definition risks a phantom setting — the user sees "Placed" as an option but the metric engine does not compute a "placed revenue" metric. The Architect must either (a) confirm that `placed` is intentionally included for future use (in which case the brand form should not expose it in M1), or (b) confirm that the metric engine already has a `placed_revenue` computation (not evident from METRICS.md).

---

## Over/under-scope assessment

**Gold-plating risk (do less):**

1. **`scope=all` logout** — moved to in-scope in the CTO review as a "5-line addition." This is correct and defensible; flag if builder over-engineers it. One SQL `WHERE app_user_id = $1 AND revoked_at IS NULL` UPDATE is all that is needed.

2. **Timezone allowlist validation** — AC-4 says "hard-validated against an allowlist (IANA zones for India/UAE/KSA at minimum)". The phrase "at minimum" is scope-creep bait. Define the exact list at spec time: `Asia/Kolkata`, `Asia/Dubai`, `Asia/Riyadh` are the three needed for INR/AED/SAR brands. Do not implement dynamic `Intl.supportedValuesOf('timeZone')` validation — that pulls in 600+ timezone strings and is not the bounded allowlist the spec intends.

3. **Step 3 integration-selection backend state machine** — the CTO review correctly calls this frontend-only (reuses existing Shopify connector flow). The Architect must enforce that no new backend routes are created for the wizard integration step itself. "Skip For Now" advances `onboarding_status` to `integration_selected` via the same BFF PATCH that advances other steps — no new connector endpoint needed.

**Missing that the Stakeholder will re-report:**

1. **The `/invite` ghost step** — if not explicitly removed, the Stakeholder may navigate to `/invite` directly (it is in the `(onboarding)` route group and the middleware allows it) and encounter the team-invite screen labeled "Step 3 of 3" while the new wizard has been updated to say "Step N of 4". This inconsistency is a test failure waiting to happen.

2. **The post-brand-redirect lands the Stakeholder in a dashboard with no brand context** — the current dashboard BFF endpoint `/api/v1/dashboard/brand-summary` returns `brand_count: 0, brands: []` if `auth.workspaceId` is null (line 288–297). After brand creation, the session must be refreshed (the frontend already calls `sessionApi.refresh()` in `create-brand-form.tsx`) but if the refresh response still has `needs_onboarding = false` and `brandId !== null`, the dashboard should render correctly. However, with the 4-step wizard change, the brand creation no longer redirects to `/dashboard` — it advances to Step 3. The session-refresh call in `create-brand-form.tsx` (line 49) must be preserved and must return the updated `onboarding_status` so Step 3 knows the brand is created. This is a sequence dependency the Architect must wire explicitly.

3. **The `region_code` is hard-coded to `'IN'` on both workspace and brand creation** — no UI field for region. If the spec says "currency contradicting region → confirm-prompt", but region is always 'IN', the confirm-prompt can never trigger for AED/SAR brands. Either (a) add a region selector to the brand form, or (b) derive region from currency_code selection (AED → UAE, SAR → KSA). The Architect must pick one and specify it — this is a missing field that the Stakeholder with a GCC brand will immediately re-report.

---

## Summary of concerns

| # | Severity | One-line summary | File / migration |
|---|---|---|---|
| C1 | HIGH | `needs_onboarding: boolean` cannot route mid-wizard resume; binary flag collapses Steps 2–4 | `bff.routes.ts:166`, `login-form.tsx:32`, AC-5 migration |
| C2 | HIGH | 3-step deploy order for `brand` NOT NULL columns must be explicit; `mapRow` type will break on deploy mismatch | `repositories.ts:452–463`, `0010_brand_locale.sql` |
| C3 | HIGH | `onboarding_status` on `organization` does not handle multi-brand orgs; needs explicit M1 constraint or move to `brand` | AC-5 migration, `resolveActiveContext` |
| C4 | MED | `/invite` (onboarding) is a ghost step that must be explicitly removed, or builder will not touch it | `app/(onboarding)/invite/page.tsx` |
| C5 | MED | `onboarding-progress` BFF endpoint conflates wizard state with dashboard checklist; pixel step confusion | `bff.routes.ts:498–619` |
| C6 | MED | `currency_code` immutability after first ledger row is unresolved; Canon gap on money mutation | `brand.service.ts:update()`, METRICS.md |
| C7 | LOW | Multi-org selector routing cannot use `needs_onboarding: boolean`; needs `onboarding_status` from the selected org | `auth.service.ts:resolveActiveContext`, AC-8 |

**Silent Canon gap (not a blocker but must be resolved):** `revenue_definition = 'placed'` has no matching metric in METRICS.md.
