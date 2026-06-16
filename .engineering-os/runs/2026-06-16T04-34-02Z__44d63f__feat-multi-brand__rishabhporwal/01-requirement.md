---
req_id: feat-multi-brand
title: Multi-brand — create additional brands + brand switcher (active-brand context)
submitted_by: rishabhporwal
submitted_at: 2026-06-16T04:34:02Z
status: cto-review
stage: 1
current_owner: cto-advisor
lineage:
  - feat-m1-app-foundation (shipped) — workspace/brand + brand-level membership.
  - feat-access-onboarding-flow (shipped) — onboarding creates the FIRST brand; onboarding_status is org-scoped (first-brand only); set-org re-mints session by org. brandApi.switchBrand client method exists but its route was never built.
---

# Requirement: Multi-brand (create additional brands + brand switcher)

## Stakeholder note
> "On the dashboard I do not see an option to create more brands and switch brands."

M1/onboarding deliberately scoped **single-brand-per-org** ("multi-brand is post-M1"). This
requirement adds the post-onboarding ability to (1) create additional brands under an org and
(2) switch the active brand, re-minting the session into that brand's isolated context — per the
functional spec's tenant model: **"a brand = workspace is the unit of everything (currency,
timezone, integrations, users, Decision Log, billing). The same human across brands has one login
but separate, independent grants per brand — isolation is absolute."**

## raw_text / intent

### 1. Create additional brands
- A "Create brand" action available post-onboarding (not the wizard) to an org member with
  authority (Owner or Brand Admin — per the invitation hierarchy: "you can only grant brands you
  manage and roles at/below your authority").
- Same brand fields as onboarding Step 2: display_name, currency_code, timezone, revenue_definition
  (realized|delivered). Currency/timezone hard-validated; currency-contradicts-region → confirm.
- The creator gets a **brand-level Owner membership** for the new brand (existing pattern).
- onboarding_status is org-scoped (first-brand); additional brands do NOT re-run the wizard.

### 2. Switch active brand
- A brand switcher in the dashboard shell (e.g. header/sidebar) listing the brands the user is a
  member of, with the active one indicated.
- Selecting a brand re-mints the session JWT with that brand's `brand_id` + `workspace_id` + the
  user's **role for that brand** (a user may hold different roles per brand), then the dashboard
  reloads in the new brand's context.
- Implement the missing backend route (the client's `brandApi.switchBrand` → e.g.
  `POST /api/v1/bff/session/set-brand`): **verify the user has a membership in that brand → 403 if
  not**; resolve brand context server-side ONLY from membership (never from spoofable input);
  re-mint reusing the jti (preserve revocation). Mirror the `set-org` / session-refresh pattern.

### 3. Isolation (the ONE invariant)
- Switching to brand B must surface ONLY brand B's data (dashboard, connectors, pixel, members).
  All brand-scoped reads use the active-brand GUC; tenant isolation is absolute and verified under
  the prod `brain_app` (NOBYPASSRLS) role, fail-closed.
- The active-brand selection persists for the session; the org-level "which org" selector (set-org)
  and the brand selector compose (org → brands within it).

### Edge cases
- A user in multiple brands (and/or multiple orgs): the switcher reflects all their memberships;
  picking one sets the active context. A brand they are NOT a member of is never selectable and the
  set-brand endpoint 403s it.
- Creating a brand requires Owner/Brand-Admin in the org; Managers/Analysts cannot create brands.
- Dashboard brand-summary should reflect the ACTIVE brand (name, per-brand member count, etc.).

## Out of scope (defer)
- Cross-org brand moves; brand deletion/archival lifecycle; per-brand billing; brand-level
  branding/theme. Authentik/Google/MFA remain deferred (separate requirements).

## Reconciliation for Stage 1
The Engineering Advisor must reconcile against the sealed Canon + shipped code: confirm the
active-brand model fits the existing 3-GUC session (brand_id/workspace_id/user_id) + the self-read
RLS policies; decide whether brand-switch is a new endpoint vs extending set-org; confirm no Canon
amendment; scope the in-scope slice vs deferred; and surface any Stakeholder decisions.
