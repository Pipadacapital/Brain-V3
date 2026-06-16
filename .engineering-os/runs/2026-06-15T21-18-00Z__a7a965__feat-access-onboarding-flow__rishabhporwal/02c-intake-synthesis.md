# 02c — Intake Synthesis (Stage 1 — Engineering Advisor, synthesis pass)
## feat-access-onboarding-flow

| Field | Value |
|-------|-------|
| **req_id** | `feat-access-onboarding-flow` |
| **Stage** | 1 — Intake (synthesis pass) |
| **Author** | Engineering Advisor (cto-advisor, Sonnet tier) |
| **Authored at** | 2026-06-15T21:37:25Z |
| **Decision** | ADVANCE |
| **Lane** | `high_stakes` — CONFIRMED |
| **Trigger surfaces** | `auth, connectors, multi_tenancy, outbound_channel, pii, schema_changes` — ALL CONFIRMED |
| **Sources synthesized** | `02-cto-advisor-review.md`, `01b-stakeholder-scope-decisions.json`, `02a-persona-identity-abuse.md`, `02b-persona-scope-realism.md` |

---

## 1. Consolidated "Architect Must-Address" List

All CRITICAL and HIGH concerns from both personas are included below. Nothing dropped. Items are ranked by severity, then by blast-radius within severity tier. Each concern maps to the AC it modifies or introduces.

---

### CRITICAL

**MA-01 (CRITICAL) — Refresh token rotation is entirely absent from the codebase**
- Source: `02a` C-01
- AC modified: AC-1
- Detail: `POST /api/v1/auth/token/refresh` does not exist in `auth.routes.ts`. The existing `POST /bff/session/refresh` in `bff.routes.ts` only re-mints the access JWT using the current session context — it does NOT validate `refresh_token_hash`, rotate the row, or detect replay. The `refresh_token_hash` column on `user_session` is stored but never read during a refresh call. A stolen 7-day refresh token is permanently valid with zero detection capability.
- Architect build requirement:
  1. Create `POST /api/v1/auth/token/refresh` in `auth.routes.ts`. Flow: (a) accept raw refresh token in body, (b) hash and look up `user_session WHERE refresh_token_hash = $hash AND revoked_at IS NULL AND expires_at > NOW()` using `SELECT ... FOR UPDATE` (serializes concurrent rotations — see MA-03), (c) set `revoked_at = NOW()` on the old row, (d) INSERT new `user_session` row with new `jti`, new `refresh_token_hash`, new `expires_at = NOW() + 7 days`, (e) mint new 15-min access JWT on the new `jti`.
  2. Replay detection: if a refresh token hash is presented and the matching row already has `revoked_at IS NOT NULL`, perform a token-family wipe — set `revoked_at = NOW()` on ALL open `user_session` rows for that `app_user_id` — and return 401 `SESSION_REVOKED`.
  3. Rename the BFF route to `POST /bff/session/context-refresh` or add a clear code comment distinguishing it from token rotation. These are separate operations.
- Code locations: `auth.service.ts:refreshSession` (lines 338–349), `bff.routes.ts:POST /api/v1/bff/session/refresh` (lines 177–206), `UserSessionRepository` (repositories.ts lines 135–157, 180–207).

**MA-02 (CRITICAL) — Session revocation not wired into removeMember / updateMemberRole**
- Source: `02a` C-02; SD-3 decision: "REVOKE ON ALL CHANGES — any role/permission change or remove/suspend instantly revokes affected sessions (immediate revocation, non-negotiable)"
- AC modified: AC-2
- Detail: `invite.service.ts::removeMember()` calls `memberRepo.delete()` and writes an audit entry but NEVER calls any session revocation. `updateMemberRole()` updates the role and audits but NEVER kills the affected user's sessions. `UserSessionRepository` has no bulk-revocation method (`revokeAllForUser` / `revokeAllForUserAndBrand` do not exist). The effective window of access after removal, without this fix, is 7 days (the refresh token TTL), not 15 minutes.
- Architect build requirement:
  1. Add `revokeAllForUserAndBrand(appUserId: string, brandId: string | null, ctx): Promise<number>` to `UserSessionRepository`. SQL: `UPDATE user_session SET revoked_at = NOW() WHERE app_user_id = $1 AND revoked_at IS NULL` (global, for suspend) or with a JOIN to membership scope for brand-level revocation.
  2. Add `revokeAllForUser(appUserId: string, ctx): Promise<number>` for global user suspension path (which currently has no revocation code path at all).
  3. Call `revokeAllForUserAndBrand()` from `removeMember()` inside the same DB client/transaction as the membership delete and the audit entry write.
  4. Call `revokeAllForUserAndBrand()` from `updateMemberRole()` for ALL role changes (SD-3 is explicit: "all changes", not just demotions).
  5. Call `revokeAllForUser()` from the `app_user.status = 'suspended'` path.
  6. Every bulk revocation must emit an audit entry per AC-10 (`sessions.bulk_revoked` with count, or one entry per session — architect's choice, but must be documented).
- Code locations: `invite.service.ts:removeMember` (lines 316–362), `invite.service.ts:updateMemberRole` (lines 262–313), `repositories.ts UserSessionRepository` (lines 180–207).

---

### HIGH

**MA-03 (HIGH) — Concurrent refresh race: missing SELECT FOR UPDATE → token-family forking**
- Source: `02a` C-05
- AC modified: AC-1
- Detail: With rotating refresh tokens implemented per MA-01, two browser tabs simultaneously calling `/auth/token/refresh` with the same token will both read the same `user_session` row as valid before either commits the `revoked_at` update. Without `SELECT ... FOR UPDATE`, both may attempt to INSERT new session rows, triggering a `jti UNIQUE` constraint violation on the second insert. The second tab's behavior (silent 500 vs. 401 with re-auth signal) is undefined and dangerous — if mishandled, a legitimate session could be erroneously flagged as a theft replay.
- Architect build requirement: All token rotation logic must execute inside a Postgres transaction with `SELECT ... FOR UPDATE` on the `user_session` row being rotated. On `jti UNIQUE` constraint violation during the new INSERT, return a 401 with a specific error code (e.g. `SESSION_CONFLICT`) instructing the client to re-login. Do not let this surface as a 500.
- Code locations: `UserSessionRepository:insert` (repositories.ts lines 135–157), the new `/auth/token/refresh` handler.

**MA-04 (HIGH) — Rate limiting not shipped; forgot-password timing oracle**
- Source: `02a` C-03
- AC modified: AC-3
- Detail: Zero rate-limiting code in `auth.routes.ts` or `bff.routes.ts`. The CTO review (AC-3) requires 5 failed attempts per (email + IP) / 15 minutes via the Redis CacheAdapter. Additionally, `forgotPassword()` has a timing side-channel: the not-found code path is 1 DB query, while the found path is 1 DB query + email send. Despite a neutral 200 response, the response-time difference is exploitable for account enumeration without rate limiting.
- Architect build requirement:
  1. Ship rate-limit middleware before the feature reaches production. Rate-limit `POST /api/v1/auth/login` AND `POST /api/v1/bff/session` (the browser-facing login path) with per-(email+IP) counters in Redis. 5 failed attempts / 15 min → 429 with `Retry-After`.
  2. Rate-limit `POST /api/v1/auth/forgot-password` at 5 attempts per email per hour.
  3. Rate-limit `POST /api/v1/auth/register` at 10 attempts per IP per hour.
  4. Equalize forgot-password timing: fire the notification send asynchronously (fire-and-forget, matching the pattern already used in BFF) so response timing is constant regardless of whether the email exists.
  5. Fail-open on Redis unavailability: log and continue (do not block login on Redis outage). Alert if Redis is down during auth spikes.
- Code locations: `auth.routes.ts` (no rate-limit calls present), `auth.service.ts:forgotPassword` (lines 386–412), `bff.routes.ts` (BFF login path).

**MA-05 (HIGH) — `needs_onboarding: boolean` cannot encode mid-wizard resume; Step-2 completers bypass Step 3 permanently**
- Source: `02b` C1
- AC modified: AC-5, AC-9
- Detail: `bff.routes.ts` line 166 computes `needs_onboarding = result.context.brandId === null`. A user who completes Step 2 (brand created, `brandId !== null`) but has not done Step 3 (integration) is classified as `needs_onboarding = false` and routed to `/dashboard`, permanently skipping Step 3. The frontend `login-form.tsx` line 32 uses this boolean with no intermediate step awareness. Adding `onboarding_status` to `organization` (as AC-5 proposes) only solves the problem if the BFF session response is updated to return the enum value — not a boolean — and the frontend router is updated to use it.
- Architect build requirement:
  1. Replace `needs_onboarding: boolean` in every BFF session response (login, session/refresh, workspace creation, brand creation) with `onboarding_status: 'pending' | 'org_created' | 'brand_created' | 'integration_selected' | 'complete' | null`.
  2. Update `login-form.tsx` to map `onboarding_status` to resume URLs via a deterministic lookup table (not a boolean branch). The lookup table must cover every enum value and every null/missing-org case.
  3. The `onboarding_status` column on `organization` must be advanced at each step via the BFF route handlers for workspace creation (`→ org_created`), brand creation (`→ brand_created`), integration-selection or skip (`→ integration_selected`), and Done acknowledgement (`→ complete`).
  4. The session-refresh call in `create-brand-form.tsx` (line 49) must be preserved and must return the updated `onboarding_status` so the frontend router can advance from Step 2 to Step 3 correctly.
- Code locations: `bff.routes.ts:166`, `login-form.tsx:32`, AC-5 migration column on `organization`.

**MA-06 (HIGH) — caller-supplied `organization_id` override on member routes creates cross-org risk**
- Source: `02a` C-06
- AC modified: AC-8, new guard on existing member routes
- Detail: `member.routes.ts::GET /api/v1/members` (line 123): `const organizationId = query.organization_id ?? auth.workspaceId`. A client can supply any `organization_id` as a query parameter, overriding the JWT-verified workspace context. The application-layer membership check in `invite.service.ts:listMembers` (lines 239–248) uses the attacker-controlled `organizationId`, not the JWT-enforced one. While RLS would fail-closed for actual data access (the attacker does not belong to the foreign org), the fragility is unacceptable: if the application-layer check is refactored or skipped, the protection disappears. The same pattern applies to `PATCH /api/v1/members/:id/role` and `DELETE /api/v1/members/:id`.
- Architect build requirement:
  1. On all member routes that accept an `organization_id` parameter, validate that the supplied value equals `auth.workspaceId` from the JWT. If they differ, return 403 immediately.
  2. The multi-org selector flow (AC-8) must be implemented as `POST /bff/session/set-org` (see MA-13 below). The org choice comes from server re-verification, not from a client-supplied JWT claim override.
- Code locations: `member.routes.ts:GET /members` (line 123), `invite.service.ts:listMembers` (lines 239–248).

**MA-07 (HIGH) — Invite-accept: no email-match check on `acceptingUserId`; unverified users can accept invites**
- Source: `02a` C-07
- AC modified: AC-7
- Detail: `invite.service.ts::acceptInvite()` (lines 121–213) accepts an optional `acceptingUserId`. When supplied, no check is performed that the accepting user's email matches `inviteRow.email`. An attacker with a valid invite token can accept it with their own `userId`, gaining membership with the invited role. Secondary issue: when `acceptingUserId` is null and the user is found by email, `existingUser.emailVerifiedAt` is not checked — an unverified account can gain brand membership without proving email ownership.
- Architect build requirement:
  1. In `acceptInvite()`, when `acceptingUserId` is supplied: query `userRepo.findById(acceptingUserId, ctx)` and compare `acceptingUser.emailNormalized` to `inviteRow.email.toLowerCase()`. If they do not match, throw `InviteError('EMAIL_MISMATCH', ..., 403)`.
  2. When `acceptingUserId` is null and an existing user is found by email: check `existingUser.emailVerifiedAt !== null`. If unverified, return `USER_UNVERIFIED` and require email verification before membership is granted.
  3. Consider making invite-accept a protected route (requires the accepting user to be authenticated) as a longer-term hardening — flag for architect decision.
- Code locations: `invite.service.ts:acceptInvite` (lines 121–213).

**MA-08 (HIGH) — 3-step deploy order for brand schema additions must be explicit; `mapRow` will break on deploy mismatch**
- Source: `02b` C2
- AC modified: AC-4
- Detail: Adding `NOT NULL DEFAULT` columns (`currency_code`, `timezone`, `revenue_definition`) to `brand` is safe in PG14+ (catalog-only change, no table rewrite, no lock escalation). But if the application code is deployed before the migration runs, the `Brand` entity type will reference columns that do not yet exist (`mapRow` in `repositories.ts` lines 452–463 will break). If the migration runs before app code is updated, old code will insert brand rows without the new columns (DB fills defaults — safe). The down migration path must also be defined before the first prod deploy.
- Architect build requirement:
  1. Document the deploy sequence explicitly in the architecture plan: (1) run migration `0010_brand_locale.sql`, (2) deploy backend with updated `BrandRepository` and `mapRow`, (3) deploy frontend with new brand form fields.
  2. The migration must include additive-only `ADD COLUMN ... NOT NULL DEFAULT '...'` statements (no data migration, no table rewrites).
  3. Include a down migration that `DROP COLUMN`s all three new columns (reversible during the first deploy window, before any brand has set non-default values). If any brand row has a non-default value, the down migration must be blocked or documented as irreversible.
  4. The `BrandRepository.mapRow` function must handle column-absent rows gracefully during the deploy window (fallback to default value if column not present in result set — defensive `??` pattern).
- Code locations: `repositories.ts:452–463` (mapRow), migration `0010_brand_locale.sql`.

**MA-09 (HIGH) — `onboarding_status` on `organization` is ambiguous for multi-brand orgs; M1 single-brand constraint must be explicit**
- Source: `02b` C3
- AC modified: AC-5
- Detail: The Canon declares "brand = the tenant unit of everything." A user could add a second brand to an existing org. If `onboarding_status` is on `organization`, it tracks the org's first onboarding only — once `'complete'`, subsequent brand additions bypass the wizard entirely. This may or may not be the intended product behavior. The Architect must make a binding decision before implementation.
- Architect build requirement: Choose one of two options and document it in the architecture plan:
  - Option A: `onboarding_status` on `organization` tracks the first-brand onboarding only. After `'complete'`, subsequent brands have no wizard. Explicitly document this as an M1 constraint in the architecture plan. Add a code comment to the relevant service method: "M1: onboarding_status tracks first brand only; multi-brand onboarding is post-M1."
  - Option B: Move `onboarding_status` to `brand` and track per-brand wizard completion. Aligns with the Canon's "brand = tenant unit" framing. Requires updating all BFF handlers to read the most-recently-created brand's status (or the active brand's status).
  The CTO intake recommended Option A. If the Architect chooses Option B, the migration changes from `organization` to `brand` — flag in the handoff.
- Code locations: `auth.service.ts:resolveActiveContext`, BFF login handler, AC-5 migration.

---

### MEDIUM

**MA-10 (MED) — Ghost `/invite` onboarding step must be explicitly removed**
- Source: `02b` C4
- AC modified: AC-6
- Detail: `apps/web/app/(onboarding)/invite/page.tsx` exists in the `(onboarding)` route group, is labeled "Step 3 of 3", and is a team-invite screen — not the integration-selection screen required by the spec. It is currently unreachable (brand form redirects to `/dashboard`, bypassing it), but its presence in the route group creates a confusion risk: a builder may attempt to adapt it rather than replace it, or the Stakeholder may navigate to `/invite` directly and encounter an inconsistent step count.
- Architect build requirement: The architecture plan must explicitly call out: (1) `/apps/web/app/(onboarding)/invite/page.tsx` is to be REMOVED from the onboarding route group; (2) `components/onboarding/invite-team-form.tsx` is deprecated in the wizard context; (3) the new Step 3 page is created at a new route under `(onboarding)` (e.g. `/onboarding/integrations`). Do not edit the existing invite page — delete it.

**MA-11 (MED) — `currency_code` immutability after first ledger row is unresolved**
- Source: `02b` C6
- AC modified: AC-4 (new guard in `brand.service.ts`)
- Detail: METRICS.md: money = `*_minor BIGINT + currency_code CHAR(3)`. If a brand changes `currency_code` after any `realized_revenue_ledger` row exists, historical metrics become incomparable. The AC-4 migration adds the column but does not define mutation policy. TRIGGER-SURFACES.md classifies money changes as high-stakes triggers.
- Architect build requirement: In `brand.service.ts::update()`, before permitting a `currency_code` change: check for the existence of any ledger row for that brand. If rows exist, return 409 with the message "Currency cannot be changed after financial data has been recorded." If no ledger rows exist, allow the change. Document this guard in the architecture plan's invariant section.
- Code locations: `brand.service.ts:update()` (lines 137–173).

**MA-12 (MED) — `revenue_definition = 'placed'` has no matching metric in METRICS.md**
- Source: `02b` Canon gap finding
- AC modified: AC-4 (resolution required before the CHECK constraint ships)
- Detail: `realized` maps to `realized_revenue` in METRICS.md. `delivered` approximately maps to `provisional_revenue`. But `placed` (GMV at order placement) has no matching metric engine definition. Adding a brand-level setting that the frontend exposes without a matching metric computation creates a phantom option — the user selects "Placed" but the metric engine has no `placed_revenue` computation.
- Architect build requirement: Before shipping the `revenue_definition` CHECK constraint, confirm one of: (a) `placed` is intentionally included for future use, in which case the brand form must NOT expose it in M1 (change the CHECK constraint to `('realized','delivered')` for M1, add `placed` in a later migration); or (b) the metric engine already has a `placed_revenue` computation and a METRICS.md entry must be added before the constraint ships. The Architect must resolve this and record the decision in the architecture plan. Do not ship the constraint with `placed` if there is no metric definition.

**MA-13 (MED) — Multi-org selector routing: design the org switch as `POST /bff/session/set-org`**
- Source: `02b` C7 + `02a` C-06 (related)
- AC modified: AC-8
- Detail: The current `needs_onboarding: boolean` check cannot route a multi-org user who has one complete org and one mid-wizard org to the correct resume step. Additionally, the existing session does not re-evaluate `onboarding_status` when the user switches orgs. The org-picker must trigger a new context resolution.
- Architect build requirement: Implement the org-picker as `POST /bff/session/set-org` accepting `{ organization_id }`. This endpoint: (1) verifies that the authenticated user holds a membership in the requested org, (2) calls `resolveActiveContext()` for the selected org, (3) re-mints the session cookie with the new `workspaceId` / `brandId`, (4) returns `onboarding_status` (the enum, not a boolean). The frontend routes based on this returned value. Do not encode org selection as a query parameter or client-supplied claim.
- Code locations: `auth.service.ts:resolveActiveContext`, new `POST /bff/session/set-org` endpoint.

**MA-14 (MED) — Dual CSRF implementations with different binding strength**
- Source: `02a` C-08
- AC modified: AC-9 (session/BFF integrity)
- Detail: `main.ts` onRequest hook implements session-bound CSRF (HMAC on `jti` + cookie secret). `bff.routes.ts::bffProtectedPreHandler` implements a weaker equality check (`csrfCookie !== csrfHeader`) without `jti`-binding. Two code paths with different security levels create maintainability risk and ambiguity about which check is authoritative.
- Architect build requirement: Consolidate to one CSRF check. Either: (a) remove the duplicate check from `bffProtectedPreHandler` and rely solely on the session-bound `main.ts` hook (simpler), or (b) upgrade `bffProtectedPreHandler` to also use `csrfTokenForSession(jti, cookieSecret)` for session-binding (belt-and-suspenders). Document which check is authoritative. Do not leave both in place.
- Code locations: `main.ts:onRequest` (lines 160, 188–221), `bff.routes.ts:bffProtectedPreHandler` (lines 87–124, 107–115).

**MA-15 (MED) — Register timing oracle: verified-vs-unverified email side-channel**
- Source: `02a` C-09
- AC modified: AC-7
- Detail: `auth.service.ts::register()` always hashes the password regardless of whether the user exists (correct). But the unverified-existing path sends a verification re-issue email (awaited, adds network latency), while the verified-existing path returns after just one hash + one DB read. The response-time difference leaks verified vs. unverified state, which is a partial enumeration oracle.
- Architect build requirement: Fire the verification re-issue notification asynchronously (fire-and-forget, matching the `forgotPassword` pattern). The response time then equals approximately one argon2 hash + one DB read for all paths through `register()`.
- Code locations: `auth.service.ts:register()` (lines 106–170).

---

### LOW

**MA-16 (LOW) — Replay of used refresh token after logout: family-wipe path**
- Source: `02a` C-04
- AC modified: AC-1
- Detail: This is addressed by the rotation implementation in MA-01. Including it here for completeness: once AC-1 is built correctly (rotation with `SELECT FOR UPDATE`, replay detection), a refresh token presented after its row has `revoked_at IS NOT NULL` must trigger a full family wipe (`revokeAllForUser`) and return 401 `SESSION_REVOKED`. The family wipe is a separate code path from the normal rotation, invoked only on replay detection.
- Resolved by: MA-01 mitigation item 2.

---

## 2. Finalized In-Scope Acceptance Criteria

These are the architect-build-ready criteria, incorporating all persona findings. Wherever a persona concern modifies an AC, the modification is noted inline.

### AC-1 — Rotating refresh tokens + `/auth/token/refresh` endpoint (updated)

`POST /api/v1/auth/token/refresh` endpoint (new route in `auth.routes.ts`):
- Accepts raw refresh token in request body.
- Hashes it and queries `user_session WHERE refresh_token_hash = $hash AND revoked_at IS NULL AND expires_at > NOW()` using `SELECT ... FOR UPDATE` (serializes concurrent rotations — resolves MA-03).
- If found (rotation path): sets `revoked_at = NOW()` on the old row; INSERTs new `user_session` row with new `jti`, new `refresh_token_hash`, new `expires_at = NOW() + 7 days`; mints new 15-min access JWT on the new `jti`. Returns `{ access_token, refresh_token }`.
- If NOT found AND the row exists but is already `revoked_at IS NOT NULL` (replay path): revoke ALL open `user_session` rows for that `app_user_id` (family wipe — resolves MA-16); return 401 `SESSION_REVOKED`.
- If NOT found at all: return 401 `INVALID_TOKEN`.
- On `jti UNIQUE` constraint violation during INSERT (concurrent race): return 401 `SESSION_CONFLICT`, instruct client to re-login (resolves MA-03).
- Rename/comment the existing BFF route to distinguish `context-refresh` from token rotation.
- No new infrastructure. Postgres-only. `user_session` already has `refresh_token_hash`, `jti`, `revoked_at`, `expires_at`.

### AC-2 — Immediate revocation on all role changes, removal, and suspension (updated per SD-3)

- Add `revokeAllForUserAndBrand(appUserId, brandId | null, ctx)` and `revokeAllForUser(appUserId, ctx)` to `UserSessionRepository`.
- Wire `revokeAllForUserAndBrand()` into `removeMember()` (same DB client as the membership delete and audit write — atomic or best-effort with explicit documentation of the failure mode).
- Wire `revokeAllForUserAndBrand()` into `updateMemberRole()` for ALL role changes (SD-3 is unconditional).
- Wire `revokeAllForUser()` into the `app_user.status = 'suspended'` path.
- Wire `scope=all` query param on `DELETE /auth/logout`: if `scope=all`, call `revokeAllForUser()` for the session's `app_user_id`; otherwise revoke current `jti` only.
- Emit audit entries for each bulk revocation (per AC-10).

### AC-3 — Rate limiting on auth endpoints

- `POST /api/v1/auth/login` + `POST /bff/session` (the browser path): 5 failed attempts per (email + IP) / 15 min → 429 with `Retry-After`.
- `POST /api/v1/auth/forgot-password`: 5 attempts per email per hour.
- `POST /api/v1/auth/register`: 10 attempts per IP per hour.
- Redis CacheAdapter (ADR-004) for counters. Fail-open on Redis unavailability (log and continue — do not block login).
- Forgot-password timing equalization: fire notification asynchronously (fire-and-forget) for both found and not-found cases (resolves MA-04 timing oracle).

### AC-4 — Brand schema: `currency_code`, `timezone`, `revenue_definition` (updated)

Migration `0010_brand_locale.sql` (additive-only, PG14+ catalog-change for `NOT NULL DEFAULT`):
- `ALTER TABLE brand ADD COLUMN currency_code CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency_code IN ('INR','AED','SAR'))`.
- `ALTER TABLE brand ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata'` — allowlist is exactly: `Asia/Kolkata`, `Asia/Dubai`, `Asia/Riyadh` (bounded; do NOT use dynamic `Intl.supportedValuesOf` — resolves `02b` over-scope gold-plating flag).
- `ALTER TABLE brand ADD COLUMN revenue_definition TEXT NOT NULL DEFAULT 'realized'` — CHECK constraint value set to be determined by the Architect after resolving MA-12 (`placed` may be deferred to a later migration). Minimum constraint for M1 ship: `CHECK (revenue_definition IN ('realized','delivered'))` with `placed` deferred.
- Down migration: `DROP COLUMN currency_code; DROP COLUMN timezone; DROP COLUMN revenue_definition` (reversible in the first deploy window before non-default values exist).
- Deploy order (resolves MA-08): (1) run migration, (2) deploy backend with updated `BrandRepository` + `mapRow` (defensive `?? defaultValue` for absent columns), (3) deploy frontend with new brand form fields.
- `currency_code` immutability guard in `brand.service.ts::update()`: if any ledger row exists for the brand, reject `currency_code` change with 409 (resolves MA-11).
- Region selector on brand form: since `region_code` is currently hard-coded to `'IN'`, add a region selector field (or derive `region_code` from `currency_code` selection: INR → IN, AED → AE, SAR → SA). Confirm-prompt if currency contradicts region selection. Architect to pick the derivation approach.
- Money invariant (I-S07): `currency_code CHAR(3)` paired with the existing `*_minor BIGINT` pattern — no float columns.

### AC-5 — Onboarding progress persistence (updated)

Migration `0010_brand_locale.sql` or `0011_onboarding_state.sql`:
- `ALTER TABLE organization ADD COLUMN onboarding_status TEXT NOT NULL DEFAULT 'pending' CHECK (onboarding_status IN ('pending','org_created','brand_created','integration_selected','complete'))`.
- `ALTER TABLE organization ADD COLUMN onboarding_step SMALLINT NOT NULL DEFAULT 0`.
- The Architect must make the binding option-A/B decision on multi-brand orgs per MA-09 before implementation. CTO intake recommends Option A (org-level, first-brand only), with explicit M1 constraint documentation.
- Advance `onboarding_status` at each step via BFF handlers: workspace creation (`→ org_created`), brand creation (`→ brand_created`), integration-selection or skip (`→ integration_selected`), Done acknowledgement (`→ complete`).
- BFF session responses (login, session/refresh, workspace creation, brand creation) must return `onboarding_status: string | null`, replacing `needs_onboarding: boolean` (resolves MA-05).
- `login-form.tsx` must map `onboarding_status` to resume URLs via a deterministic lookup table.

### AC-6 — 4-step onboarding wizard (updated)

- Step labels: `Step 1 of 4` (Org), `Step 2 of 4` (Brand), `Step 3 of 4` (Integrations), `Step 4 of 4` (Done).
- Step 3: Shopify (connect-now or "Skip For Now") + Meta Ads (coming soon, disabled) + Google Ads (coming soon, disabled). "Skip For Now" advances `onboarding_status` to `integration_selected` via BFF PATCH. Step 3 is frontend-only — reuses existing Shopify connector install endpoint. No new backend routes for the wizard integration step.
- Step 4: Done screen with link to dashboard. Summary of what was set up.
- After Step 4, redirect to `/dashboard`.
- No pixel-install step in the wizard (pixel stays in settings/tracking — confirmed placement).
- Ghost invite step removal (resolves MA-10): `apps/web/app/(onboarding)/invite/page.tsx` is DELETED. `components/onboarding/invite-team-form.tsx` is deprecated in the wizard context (may be reused elsewhere but must not appear in the `(onboarding)` route group). New Step 3 page created at a new route (e.g. `/onboarding/integrations`) under `(onboarding)`.
- Onboarding progress BFF endpoint (`/api/v1/dashboard/onboarding-progress`) is a dashboard checklist widget — separate data model from the 4-step wizard state. The pixel step in that endpoint remains as a post-onboarding checklist item; it must not appear as a wizard step.

### AC-7 — Invited-email sign-up guard + duplicate-email UX (updated)

- In `acceptInvite()`: when `acceptingUserId` is supplied, check email match before granting membership (resolves MA-07). When found by email, check `emailVerifiedAt !== null` before granting membership.
- On `POST /api/v1/auth/register`, if the email has a `pending` invite: return `{ code: 'INVITE_PENDING' }`. Frontend redirects to `/invite/accept`.
- Register timing oracle fix: fire verification re-issue notification asynchronously (resolves MA-15).
- Duplicate verified email: API returns success (timing-safe); frontend shows "An account with this email exists. Sign in or reset your password."

### AC-8 — Multi-org selector on login (updated)

- After successful login: resolve memberships. Zero orgs → `/workspace/new`. One org → proceed as today. More than one org → show org-picker screen.
- Org-picker implemented as `POST /bff/session/set-org` accepting `{ organization_id }` (resolves MA-06 and MA-13). This endpoint: verifies current user's membership in the requested org; calls `resolveActiveContext()`; re-mints session cookie; returns `onboarding_status` (enum, not boolean). Frontend routes based on returned `onboarding_status`.
- `organization_id` parameter on all existing member routes (`GET /members`, `PATCH /members/:id/role`, `DELETE /members/:id`) must be validated against `auth.workspaceId`. Mismatch → 403 (resolves MA-06).

### AC-9 — Session context improvements: BFF + post-login redirect (updated)

- All BFF session responses return `onboarding_status: string | null` (not `needs_onboarding: boolean`).
- Post-brand-creation: fires Step 3 routing (not dashboard redirect). The session-refresh call in `create-brand-form.tsx` (line 49) must return the updated `onboarding_status = 'brand_created'`.
- Post-Done (Step 4 acknowledgement): advance `onboarding_status` to `'complete'`; then redirect to `/dashboard`.
- CSRF consolidation (resolves MA-14): remove the duplicate CSRF check from `bffProtectedPreHandler` or upgrade it to session-binding. Document which check is authoritative. Single implementation wins.

### AC-10 — Audit coverage gaps (unchanged from 02-cto-advisor-review.md)

- `membership.removed` → audit entry + event.
- `membership.role_changed` → audit entry.
- `user.suspended` → audit entry.
- `session.revoked` bulk revocation → audit entry per bulk operation (at minimum one `sessions.bulk_revoked` entry with count; architect may emit per-session entries if preferred).

---

## 3. Deferred List — Confirmed

The deferred list from `02-cto-advisor-review.md` is unchanged. No stakeholder override.

| Item | Child req / amendment |
|---|---|
| Authentik OIDC swap | `feat-authentik-oidc-swap` (Phase 2; requires ADR + Stakeholder) |
| Google one-tap sign-in | `feat-google-oauth-signin` (separate intake after Authentik decision) |
| MFA (TOTP / FIDO2 / backup codes) | `feat-mfa` (separate intake; can be app-native TOTP without Authentik) |
| Redis session store (move SoR) | `chore-session-store-assessment` (Postgres P95 benchmark first) |
| "Remember me" + trusted devices | `feat-remember-me-trusted-devices` |
| Lost MFA recovery | Deferred with `feat-mfa` |
| Multi-org SCIM / teams / custom roles | Phase 2+ |

Stakeholder decisions SD-1, SD-2, SD-3 are all resolved in `01b-stakeholder-scope-decisions.json`. No further Stakeholder escalation required to advance.

---

## 4. Canon Amendment Assessment

| In-scope item | Canon conflict | Verdict |
|---|---|---|
| `currency_code CHAR(3) CHECK IN ('INR','AED','SAR')` on `brand` | Aligns with METRICS.md money rules | CLEAR — no amendment |
| `timezone TEXT` with bounded IANA allowlist | Not a compliance surface | CLEAR — no amendment |
| `revenue_definition TEXT` CHECK constraint | `realized` and `delivered` align with METRICS.md. `placed` has no METRICS.md metric definition — MA-12 requires resolution before the constraint ships. | CONDITIONAL — no amendment required if `placed` is deferred from M1 CHECK constraint; amendment required only if `placed` is included AND a `placed_revenue` metric definition needs to be added to METRICS.md |
| `onboarding_status` on `organization` | Not a compliance or trigger surface | CLEAR — no amendment |
| Rotating refresh tokens (AC-1) | App-native, Postgres-only | CLEAR — no amendment |
| Rate limiting via Redis CacheAdapter (AC-3) | Existing ADR-004 Redis; fail-open documented | CLEAR — no amendment |
| `currency_code` immutability guard in `brand.service.ts` | Aligns with TRIGGER-SURFACES.md money/financial boundary | CLEAR — the guard itself is implementation, not a Canon field addition; no amendment. However, the Architect should add a comment in TRIGGER-SURFACES.md noting the `currency_code` mutation gate |

**Net Canon amendment required:** None, provided `revenue_definition` CHECK constraint ships without `placed` in M1 (MA-12 resolution). If `placed` is included, METRICS.md must receive a `placed_revenue` metric definition before the constraint ships. This is not a blocker for ADVANCE — it is an Architect-gate at implementation time.

---

## 5. Lane and Build Tracks

**Lane:** `high_stakes` — CONFIRMED. All 6 trigger surfaces active (`auth, connectors, multi_tenancy, outbound_channel, pii, schema_changes`). The full high-stakes DoD applies: architecture plan + security review + QA + final review + mutation tests on all auth paths.

**Build tracks:**

| Track | Owner | Primary work |
|---|---|---|
| **backend-developer** | `@backend-developer` | AC-1 (refresh endpoint + rotation), AC-2 (bulk revocation + new repository methods), AC-3 (rate-limit middleware), AC-4 (migration + brand service guard), AC-5 (onboarding_status migration + BFF handlers), AC-7 (acceptInvite fixes), AC-8 (set-org endpoint, member route organization_id guard), AC-9 (CSRF consolidation, BFF session contract), AC-10 (audit events) |
| **frontend-web-developer** | `@frontend-web-developer` | AC-5 (login-form.tsx onboarding_status routing), AC-6 (Steps 3+4, ghost invite removal, step label fixes), AC-7 (register duplicate-email UX, invite-pending UX), AC-8 (org-picker screen), AC-9 (post-brand-creation flow, Step 3 routing) |

Data / migration work is owned by `@backend-developer` but must be reviewed by the Architect before execution. The 3-step deploy order (MA-08) must be documented in the architecture plan and enforced in the deployment runbook.

**Paradigm:** Tier 1 — Deterministic logic only. No model calls. Estimated model spend: $0.

---

## 6. Summary for the Architect

The two stress-test personas surface 16 total concerns against 10 ACs. The 2 CRITICALs (MA-01, MA-02) are implementation-absent gaps — the rotation endpoint does not exist and the revocation wiring is simply not called. These must be the first items the backend build track addresses. The 6 HIGHs (MA-03 through MA-09) either harden the CRITICAL paths (SELECT FOR UPDATE, rate limiting) or catch design-level issues before implementation (resume routing, deploy order, multi-brand ambiguity, org_id override). The 5 MEDs are correctness and maintainability issues that must be resolved in the same sprint but do not block the CRITICAL path from starting.

The Architect's first act should be to resolve the binding option-A/B decision on MA-09 (`onboarding_status` placement) and the MA-12 `revenue_definition = 'placed'` question, as both affect the migration schema. All other items are ready to build.
