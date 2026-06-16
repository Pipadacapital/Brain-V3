# 02 — CTO Advisor Review (Stage 1 Intake)
## feat-access-onboarding-flow

| Field | Value |
|-------|-------|
| **req_id** | `feat-access-onboarding-flow` |
| **Stage** | 1 — Intake |
| **Author** | Engineering Advisor (cto-advisor, Sonnet tier) |
| **Authored at** | 2026-06-16T00:00:00Z |
| **Decision** | ADVANCE (scoped slice — scope wall is binding) |
| **Lane validated** | `high_stakes` — CONFIRMED |
| **Trigger surfaces validated** | `auth, connectors, multi_tenancy, outbound_channel, pii` — CONFIRMED + `schema_changes` ADDED (new columns on `brand` and onboarding-progress state; migration required) |

---

## 1. Reality check — what M1 actually shipped

M1 (`feat-m1-app-foundation`, status: `shipped`) delivered:

**Auth (app-native, app-native only):**
- Register (email+password, argon2id, NN-5), verify-email (single-use sha256 token), login (JWT 15 min, `user_session` DB row, revocation denylist via `revoked_at`), logout, forgot-password (neutral 200), reset-password.
- No Google one-tap. No OIDC. No MFA. No Redis session store. No rotating refresh token (the M1 refresh is a 7-day JWT not a rotating secret). Revocation denylist: partial — `user_session.revoked_at` is set on logout; however there is no separate Redis denylist checked on every request at speed. The JWT `jti` denylist check is against Postgres `user_session` (SQL lookup on every protected route — NN-3).

**Onboarding wizard shape — 2 steps (NOT 4):**
- Step 1: Workspace creation (`/workspace/new` → `Step 1 of 3` label, but "Step 3" is invite-teammate which is optional).
- Step 2: Brand creation (`/brand/new` → `Step 2 of 3`).
- No Step 3 Integration-selection. No Step 4 Done screen.
- Brand form fields: `display_name`, `domain` (optional). **No `currency_code`, no `timezone`, no `revenue_definition`.**
- No progress persistence (no resume-after-crash).
- No "pixel NOT in onboarding" enforcement (pixel wizard exists in `components/pixel/pixel-wizard.tsx` but appears outside onboarding route group — needs verification).
- Post-brand creation: redirects to `/dashboard` immediately. Correct direction, but no integration-selection or Done step in between.

**Membership / invite infrastructure:** fully shipped — invite table, compound RLS (NN-7), invite service, invite accept route.

**CSRF:** present in `apps/core/src/modules/frontend-api/internal/csrf.ts`.

**Rate limiting / lockout:** NOT found in any shipped file. Lockout state is not persisted.

**Multi-org "which org to enter" selector:** not shipped (only single-org path in login → picks `workspaces[0]`).

**Duplicate-email "offers sign-in / forgot" UI:** not found — the auth service returns a success message on duplicate register (timing-safe, correct) but the frontend register page behavior for this path is unverified.

---

## 2. Canon-conflict table — spec item vs M1 Canon

| Spec item (01-requirement.md) | M1 Canon status (ADR-006 / D0.1) | Ruling | Disposition |
|---|---|---|---|
| **Authentik OIDC as IdP** | Explicitly deferred in D0.1 (app-native M1; Authentik fronts later as token-issuer swap) | CANON CONFLICT — not a critical flaw; graduation trigger not fired | DEFERRED: child requirement `feat-authentik-oidc-swap` (post-M1, before Phase 2 extract). Requires ADR amendment to activate. |
| **Google one-tap sign-up / sign-in** | Not in M1 Canon; depends on Authentik OIDC (the OIDC provider would issue the Google federation). App-native path has no Google OAuth path. | CANON CONFLICT — pulling Google one-tap without Authentik means a direct Google OAuth integration in app-native code; either way is a new layer | DEFERRED: child requirement `feat-google-oauth-signin` (can be added as a parallel social OAuth path in app-native code without Authentik, but adds a new security surface and should be a separate intake). |
| **MFA (TOTP/FIDO2)** | Explicitly deferred in D0.1. MFA was named as an Authentik capability. App-native MFA is a separate implementation. | CANON CONFLICT — not a critical flaw; no fired trigger | DEFERRED: child requirement `feat-mfa`. Must not block this requirement. |
| **Redis session store** | CacheAdapter (ADR-004) is Redis on ElastiCache — Redis EXISTS. But sessions currently live in `user_session` Postgres table (NN-3 revocation via SQL). Redis for session storage would move the session SoR. | CANON CONFLICT — the current design is Postgres-backed denylist (NN-3); moving to Redis changes the SoR and isolation layer. | DEFERRED: assess whether the Postgres-based denylist (with indexed `jti` lookup) meets the latency budget before proposing a Redis session store. If latency is acceptable (P95 < 5ms at M1 scale), the Postgres path is correct. File as `chore-session-store-assessment` before any Redis migration. |
| **Rotating refresh tokens (7-day)** | M1 has a 7-day refresh JWT, not a rotating opaque token. Rotating refresh tokens = each use issues a new refresh token and invalidates the old one. This requires a token family store (Redis or Postgres). | PARTIAL CONFLICT — the 7-day expiry is implemented; rotation is not. Rotation significantly hardens stolen-refresh-token attacks. | IN-SCOPE NOW (app-native, Postgres): add `refresh_token_hash` rotation to `user_session` — on each `/auth/token/refresh` call, invalidate the old `user_session` row and insert a new one with a new `refresh_token_hash` and new `jti`. This is a Postgres-only change, no new infrastructure, and directly hardens security. The `user_session` table already has `refresh_token_hash`. |
| **`POST /auth/token/refresh` endpoint** | NOT found in shipped M1 auth routes (register/verify/login/logout/forgot/reset/me only). The BFF has `POST /bff/session/refresh` (as a session-cookie refresh via the BFF layer). | Gap: the spec requires a proper access-token refresh endpoint, not just a BFF cookie refresh. | IN-SCOPE NOW: wire `POST /api/v1/auth/token/refresh` in auth routes; it validates the refresh token hash against `user_session`, rotates it, and mints a new access JWT. |
| **Immediate revocation denylist** | Partially shipped: `user_session.revoked_at` is checked on every protected route (NN-3). BUT: the revocation path for "remove/suspend a user" or "change a role" triggering instant session kill is NOT confirmed shipped. | Gap: the service-layer revocation on membership removal/role-change is not verified shipped. | IN-SCOPE NOW: confirm and ship `membership.removed / role_changed → revoke all open user_session rows for that user/brand`. |
| **4-step wizard (Org → Brand → Integration → Done)** | M1 ships 2 steps (Org + Brand). Steps 3 (Integration selection) and 4 (Done) are missing. | Gap vs requirement (Stakeholder tested and found "not as per expectations"). | IN-SCOPE NOW: add Step 3 (Integration selection: Shopify connect-or-skip, Meta/Google "coming soon" stub) + Step 4 (Done / guided empty state). Step labels must read `Step 1 of 4` through `Step 4 of 4`. |
| **Currency + timezone hard-validation on brand** | NOT in shipped brand table or form. `brand` has `region_code` only. | Gap — currency/timezone are load-bearing for every monetary and day-boundary metric (Canon: money = `*_minor BIGINT + currency_code CHAR(3)` ∈ {INR, AED, SAR}). Without them on the brand, the entire metric/analytics layer has no anchor. | IN-SCOPE NOW: migration adds `currency_code CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency_code IN ('INR','AED','SAR'))` + `timezone text NOT NULL DEFAULT 'Asia/Kolkata'` to `brand`; brand form hard-validates both; currency contradicting region → confirm-prompt (not a block). |
| **Revenue definition default** | NOT in shipped brand table or form. | Gap — spec says "Realized/Delivered recommended for COD-heavy India/GCC markets." | IN-SCOPE NOW: migration adds `revenue_definition text NOT NULL DEFAULT 'realized' CHECK (revenue_definition IN ('realized','delivered','placed'))` to `brand`; brand form exposes it with "Realized (recommended)" pre-selected. |
| **Onboarding progress persistence (resume-after-crash)** | NOT shipped. | Gap — spec requires progress saved after every step. | IN-SCOPE NOW: add `onboarding_status text NOT NULL DEFAULT 'pending' CHECK (onboarding_status IN ('pending','org_created','brand_created','integration_selected','complete'))` + `onboarding_step int NOT NULL DEFAULT 0` to `organization` (or a separate `onboarding_state` table). On each step completion, persist progress. On login, if `onboarding_status != 'complete'`, redirect to resume point. |
| **Pixel NOT in onboarding** | The spec says pixel install is done later in Tracking, not during onboarding. M1 `pixel_wizard` exists outside the onboarding route group — likely correct placement, but the onboarding wizard must not include a pixel step. | Needs verification of routing | IN-SCOPE NOW: confirm (and gate at Architect) that no pixel-install step appears in the 4-step onboarding wizard. Pixel remains in `(settings)/tracking` or equivalent. |
| **Post-onboarding redirect to dashboard** | M1 redirects to `/dashboard` after brand creation. With the 4-step wizard, the redirect should come AFTER Step 4 (Done → dashboard). | Gap: redirect fires too early today. | IN-SCOPE NOW: fix redirect to trigger after Step 4 completion. |
| **Sole-Owner-per-new-org** | Shipped: `organization.owner_user_id NOT NULL` + service-layer sole-Owner guard. | ALIGNED | No change needed. |
| **Invitation is the only way into an existing org** | Shipped at the infrastructure level (invite table + accept flow). UI enforcement of "you cannot sign up into an existing org" needs confirmation. | Needs verification | IN-SCOPE NOW: confirm and ship the UI-level guard: if a registering email is already invited to an org, guide them to accept the invite rather than creating a new org. |
| **Duplicate email → offer sign-in / forgot (no leak)** | Auth service returns success message for duplicate register (timing-safe). The frontend may not surface "Sign in / Forgot password" UX. | Gap: frontend UX for duplicate email path | IN-SCOPE NOW: frontend shows "An account with this email already exists. Sign in or reset your password." link on register — no enumeration (the message is the same timing-wise from the API; the UI can safely offer this because the user already typed their email). |
| **Abandon-then-re-register re-issues verify** | Shipped in auth service: `if existing and not verified → re-issue verification token`. | ALIGNED | No change needed. |
| **Invited teammate who signs up → guided to accept invite** | NOT confirmed shipped. | Gap | IN-SCOPE NOW: on register, if the email has a pending invite, return a specific response code (or redirect to invite-accept flow). No org creation for an invited email. |
| **Rate-limit / lockout on login + neutral error messages** | Rate limiting NOT found in shipped code. Neutral errors ARE implemented (NN-5: "email or password is incorrect"). | Gap: rate limiting missing | IN-SCOPE NOW: add rate limiting to login route (e.g. 5 attempts / 15 min per IP+email, using Redis or in-memory with a Postgres fallback). This is a security baseline — not optional. |
| **Multi-org "which org to enter" selector** | NOT shipped. M1 login picks `workspaces[0]`. | Gap — spec says "a user in multiple orgs is asked which to enter". Multi-org is an edge case at M1 scale. | DEFERRED if trivial is too broad: IN-SCOPE NOW for the basic path (if user has 0 or 1 org → no selector needed; if > 1 → show selector). This is a 1-screen addition, not a separate epic. Include it. |
| **"Remember me" extends on trusted devices** | NOT shipped. | Lower priority for M1 user experience. | DEFERRED: child requirement `feat-remember-me-trusted-devices`. |
| **Backup codes / audited recovery for lost MFA** | MFA not shipped; this is a sub-item of MFA. | N/A until MFA ships. | DEFERRED with MFA. |
| **Membership lifecycle (Invited → Active → Suspended → Removed)** | Invite + accept shipped. Suspend state on `app_user` (`status IN ('active','suspended')`) is in the schema. Removed = DELETE on `membership` row. Immediate revocation on suspend/remove: not verified shipped. | Gap: suspend/remove → immediate session revocation path | IN-SCOPE NOW: wire `membership.removed` → `user_session` revocation for that user+brand. `app_user.suspended` → revoke all sessions for that user globally. |
| **4 roles (Owner / Brand Admin / Manager / Analyst)** | Shipped: CHECK constraint on `membership.role_code`. | ALIGNED | No change needed. |
| **Re-inviting a removed email creates new membership** | Invite service supports this (no unique constraint blocks re-invite of removed member). | ALIGNED | Confirm at Architect level. |
| **Audit-logged auth actions (logins, role changes, invites)** | Shipped: `user.logged_in`, `user.registered`, `membership.created`, `invite.created`, `invite.accepted` in audit. | ALIGNED (needs `membership.removed` + `membership.role_changed` + `user.suspended` audit entries confirmed) | IN-SCOPE NOW: confirm those audit events are emitted on the revocation paths. |

---

## 3. Scoped in-scope acceptance criteria (ships now)

These items directly address the Stakeholder's tested gaps and are achievable within the current app-native stack with no new infrastructure layer.

### AC-1 — Rotating refresh tokens + `/auth/token/refresh` endpoint
- `POST /api/v1/auth/token/refresh`: validates current `refresh_token_hash` in `user_session`, rotates it (new `refresh_token_hash`, new `jti`, new access JWT), invalidates old row (`revoked_at = NOW()`).
- If the same refresh token is presented twice (replay), revoke the entire token family (the old row) as a theft-detection heuristic.
- No new infrastructure. Postgres-only. `user_session` table already has the columns.

### AC-2 — Immediate revocation on membership remove / suspend
- `DELETE /api/v1/members/:id` (remove): sets `membership.deleted_at` (add soft-delete column OR hard-delete with cascade to `user_session`) AND revokes all open `user_session` rows for that `app_user_id` where `brand_id` matches the scope.
- `PATCH /api/v1/members/:id/role` (role change): does NOT revoke sessions (access-adding change applies on next protected action, per spec). Access-removing role changes DO revoke (e.g. Owner → Analyst demote). Architect to decide whether all role changes revoke for simplicity.
- `PATCH /api/v1/app_user/:id/status` (suspend): revokes ALL open sessions for that user across all brands.
- Audit entry emitted for each revocation.

### AC-3 — Rate limiting on auth endpoints
- Login: 5 failed attempts per (email + IP) in a 15-minute window → 429 with retry-after header. Use Redis (CacheAdapter ADR-004 already wired) for the counter; fail-open on Redis unavailability (do not block login if Redis is down — log and continue).
- Register: 10 attempts per IP per hour.
- Forgot-password: 5 attempts per email per hour.
- The neutral error message is already shipped (NN-5).

### AC-4 — Brand schema: add `currency_code`, `timezone`, `revenue_definition`
- Migration `0010_brand_locale.sql`:
  - `ALTER TABLE brand ADD COLUMN currency_code CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency_code IN ('INR','AED','SAR'))`.
  - `ALTER TABLE brand ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata'`.
  - `ALTER TABLE brand ADD COLUMN revenue_definition TEXT NOT NULL DEFAULT 'realized' CHECK (revenue_definition IN ('realized','delivered','placed'))`.
- Timezone hard-validated against an allowlist (IANA zones for India/UAE/KSA at minimum; `Intl.supportedValuesOf('timeZone')` at runtime).
- Currency contradicting region (e.g. `AED` with `region_code='IN'`) → confirm-prompt ("Unusual currency for your region. Confirm?"), not a hard block.
- `revenue_definition` defaulted to `'realized'` with display label "Realized (Recommended for COD markets)".
- Money invariant (I-S07): `currency_code CHAR(3)` paired with the existing `*_minor BIGINT` pattern — no float columns.

### AC-5 — Onboarding progress persistence
- Migration `0010_brand_locale.sql` (or `0011_onboarding_state.sql`): add `onboarding_step SMALLINT NOT NULL DEFAULT 0` + `onboarding_status TEXT NOT NULL DEFAULT 'pending' CHECK (onboarding_status IN ('pending','org_created','brand_created','integration_selected','complete'))` to `organization`.
- After each wizard step, PATCH the `organization` record to advance `onboarding_step` / `onboarding_status`.
- At login, if the resolved org has `onboarding_status != 'complete'`, redirect to the appropriate step URL instead of `/dashboard`.
- BFF session refresh must return `onboarding_status` so the frontend can route correctly.

### AC-6 — 4-step onboarding wizard (Step 3 Integration-selection + Step 4 Done)
- Step labels: `Step 1 of 4` (Org), `Step 2 of 4` (Brand), `Step 3 of 4` (Integrations), `Step 4 of 4` (Done).
- Step 3: shows Shopify (connect-now or "Skip For Now") + Meta Ads (coming soon, disabled) + Google Ads (coming soon, disabled). OAuth failure → source marked Disconnected with retry UI; does not block wizard progression.
- Step 4: Done screen with link to dashboard. Summary of what was set up. "You're ready to go."
- After Step 4, redirect to `/dashboard`.
- No pixel-install step in the wizard (pixel stays in settings/tracking).
- Route group: add `/onboarding/integrations` and `/onboarding/done` pages under `(onboarding)`.

### AC-7 — Invited-email sign-up guard + duplicate-email UX
- On `POST /api/v1/auth/register`, if the email has a `pending` invite in the `invite` table: return `{ code: 'INVITE_PENDING', invite_token_hint: true }` (not the email → no enumeration risk since the user typed their email). Frontend redirects to `/invite/accept`.
- Frontend register page: if API returns `INVITE_PENDING`, show "You have a pending invitation. Accept it to join your team." with link to invite-accept flow.
- Duplicate verified email: API already returns success (timing-safe); frontend shows "An account with this email exists. Sign in or reset your password." This is safe (the user typed the email; no new enumeration).

### AC-8 — Multi-org selector on login (basic)
- After a successful login, the auth service resolves the user's memberships. If exactly one org: proceed as today. If zero orgs: route to `/workspace/new` (new user, start onboarding). If > 1 org: show an org-picker screen before proceeding to the last-active or first brand.
- This is a single screen addition; no new infrastructure.

### AC-9 — Session context improvements (BFF + post-login redirect)
- BFF `POST /bff/session/refresh` (already ships): must return `onboarding_status` from the org record so the frontend can gate the redirect correctly.
- Post-brand-creation redirect: fires only after Step 4 completion, not after Step 2.
- Login post-onboarding: if `onboarding_status = 'complete'`, land on `/dashboard`. If not complete, land on the resume step.

### AC-10 — Audit coverage gaps
- `membership.removed` → audit entry + event.
- `membership.role_changed` → audit entry (already partially shipped per M1 plan; confirm emitted).
- `user.suspended` → audit entry.
- `session.revoked` (bulk revocation on remove/suspend) → audit entry per revoked session (or a single `sessions.bulk_revoked` entry with count).

---

## 4. Explicit deferred list

Each item below is explicitly OUT OF SCOPE for this requirement. They become named child requirements or Canon amendments.

| Item | Why deferred | Child req / amendment |
|---|---|---|
| **Authentik OIDC swap** | D0.1 Canon: app-native is the M1 design; Authentik fronts later as a token-issuer swap (no migration). Graduation trigger: explicit CTO decision + ADR + proven critical flaw or Phase-2 extraction plan. | `feat-authentik-oidc-swap` (Phase 2; requires ADR + Stakeholder) |
| **Google one-tap** | Requires either Authentik OIDC (which is deferred) or a direct Google OAuth path in app-native code. Either way it is a new auth surface with its own security intake (new IdP trust, new token validation path, new account-linking edge cases). Not a blocker for the 4-step wizard. | `feat-google-oauth-signin` (separate intake after Authentik decision) |
| **MFA (TOTP / FIDO2 / backup codes)** | Authentik-dependent per D0.1; or requires an app-native TOTP implementation. Either path is a new security surface with its own intake. Not a blocker for the onboarding wizard or session management. | `feat-mfa` (separate intake; can be app-native TOTP without Authentik) |
| **Redis session store** | Postgres `user_session` denylist with indexed `jti` is the current design and meets the revocation requirement. Moving to Redis changes the session SoR and complicates the existing RLS + audit trail. Requires a latency benchmark to justify. | `chore-session-store-assessment` (assess Postgres P95 at load before proposing migration) |
| **"Remember me" + trusted devices** | Not a P0 gap for the Stakeholder's tested issues. Adds complexity (device fingerprinting, extended refresh TTL, per-device revocation). | `feat-remember-me-trusted-devices` |
| **Lost MFA recovery (backup codes, audited recovery)** | Depends on MFA existing first. | Deferred with `feat-mfa` |
| **Multi-org SCIM / teams / custom roles** | Explicitly out of scope per M1 architecture plan (scope-defer). | Phase 2+ |
| **`scope=all` logout (all devices)** | The spec names `/auth/logout?scope=all`. This can be added as a minor addition to the logout route (revoke all sessions for the user, not just current jti). Low complexity. | IN-SCOPE NOW (low-effort, security value): add `scope=all` query param to logout. Revoke all `user_session` rows for `app_user_id`. |

> Note: `scope=all` logout is moved to IN-SCOPE because it is a 5-line addition to the existing logout route and the spec names it explicitly.

---

## 5. Stakeholder decisions required

The following items require explicit Stakeholder confirmation before the Architect finalizes the plan. These are not escalation-level questions — they are scope-gate decisions the Canon does not resolve alone.

| # | Decision | Options | Default if no response |
|---|---|---|---|
| **SD-1** | **Confirm that Authentik OIDC, Google one-tap, and MFA are NOT part of this requirement.** The spec's "IdP: Authentik (OIDC) handles all of this" framing conflicts with D0.1. If the Stakeholder wants Authentik now, this becomes a multi-month canon amendment + new infrastructure, not a wizard-fix sprint. | A) Confirm deferred (this req ships app-native improvements only) — RECOMMENDED. B) Pull Authentik/Google/MFA into scope (new ADR required; at least 4–6 weeks added). | A — ADVANCE with app-native scope |
| **SD-2** | **Confirm that rotating refresh tokens (AC-1) should be added now.** This is achievable app-native with no new infra. It directly hardens against stolen refresh tokens. It requires a breaking contract change on the token refresh flow (clients must use the new endpoint). | A) Add now (recommended — security baseline). B) Defer to a later hardening sprint. | A — add now |
| **SD-3** | **Role-change revocation policy.** On `PATCH /members/:id/role`, should ALL role changes revoke existing sessions (simpler, safer) or only access-removing role changes (more nuanced)? | A) All role changes revoke — simpler, always correct. B) Access-removing only — less disruption for promotions. | A — revoke on all role changes |

If SD-1 is answered B by the Stakeholder, this review converts to a CHALLENGE-BACK pending a Canon amendment (new ADR for Authentik activation, scope tripling, timeline reassessment).

---

## 6. Trigger surfaces — validated

| Surface | Present | Notes |
|---|---|---|
| `auth` | YES | Refresh token rotation, rate limiting, revocation wiring — all touch auth paths |
| `connectors` | YES | Integration-selection step exposes Shopify connect flow in the wizard |
| `multi_tenancy` | YES | Onboarding state on `organization`, session context changes touch tenant-isolation paths |
| `outbound_channel` | YES | Email verification, invite emails pass through the notification chokepoint (I-ST05) |
| `pii` | YES | Email in register/verify/forgot paths; PII masking confirmed in auth.service |
| `schema_changes` | ADDED | New columns on `brand` (`currency_code`, `timezone`, `revenue_definition`) and onboarding state on `organization`. Requires node-pg-migrate migrations with RLS re-check. |

Lane `high_stakes` is correct and non-negotiable. All 6 surfaces require the full high-stakes DoD (architecture + security + QA + final review + mutation tests).

---

## 7. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-1 | **Canon scope creep.** The spec's "Authentik OIDC handles all of this" framing may lead the builder to add OIDC/MFA/Redis without a Canon amendment. | HIGH | Scope wall is explicit in this review (SD-1). The Architect must include a scope-violation list matching M1's §2 pattern. |
| R-2 | **Brand migration on live data.** Adding `currency_code`, `timezone`, `revenue_definition` to `brand` requires a reversible migration with DEFAULT values. If any brand row exists in prod without these columns, the migration must be additive-only with NOT NULL + DEFAULT (no data migration). | MEDIUM | Use `ALTER TABLE brand ADD COLUMN ... NOT NULL DEFAULT '...'` — Postgres adds the default without a table rewrite for most storage layouts. The Architect must confirm the migration strategy and include a down migration. |
| R-3 | **Session revocation on remove/suspend is not atomic.** Between the `membership` DELETE and the `user_session` UPDATE, there is a window where the user still has a valid access JWT (15 min TTL). The Postgres-based revocation covers refresh token usage; the access JWT is not revocable until TTL. | MEDIUM | Acceptable for M1 at this scale. The spec's "immediate revocation" applies to the refresh token (DB denylist) and the next `validateSession` call. Access JWT TTL of 15 minutes is the documented trade-off. Document this explicitly in the architecture plan. |
| R-4 | **Multi-org selector adds an untested login path.** The selector screen is new code in a high-stakes auth flow. | MEDIUM | Must be in isolation-fuzz test coverage. Persona must stress-test this path. |
| R-5 | **Rate limiting with Redis.** If Redis is unavailable, fail-open is the default (per AC-3) to avoid blocking login. Fail-open means rate limiting can be bypassed during Redis outage. | LOW-MEDIUM | Acceptable for M1. Log rate-limit counters to Grafana Cloud. Alert if Redis is unavailable during auth spikes. |
| R-6 | **Onboarding resume route conflicts with the BFF session context.** If the session JWT does not carry `onboarding_status`, the frontend cannot decide the resume route without an extra BFF call. | LOW | Resolve at BFF design time: the session refresh response includes `onboarding_status` from the org record. |

---

## 8. "Make it less dumb" — what we can simplify or delete

1. **Do NOT add a separate `onboarding_state` table.** Add `onboarding_step` + `onboarding_status` columns directly to `organization`. The organization record is the natural home. Fewer tables, same result.

2. **Do NOT add a pixel step to the wizard.** The spec says pixel is NOT in onboarding. The existing `pixel_wizard` component is correctly outside the onboarding route group. Confirm this and move on.

3. **Do NOT rotate refresh tokens via Redis.** The `user_session` Postgres table already has `refresh_token_hash`. Rotation is a Postgres `UPDATE` + `INSERT` in a transaction. No Redis session store needed for this.

4. **Collapse AC-1 and AC-9 into a single auth-service change.** The refresh token endpoint and the BFF session refresh both touch the same code path. Build once.

5. **Integration-selection step (Step 3) reuses the existing Shopify connector flow** — no new backend. It is a frontend-only addition that calls the existing `GET /api/v1/connectors/shopify/install` endpoint. "Skip For Now" just advances `onboarding_status` to `integration_selected` without connecting.

---

## 9. Paradigm recommendation

**Tier 1 — Deterministic logic only** (same as M1, no model calls).

All auth, session management, RBAC, wizard flow, and onboarding state management are closed deterministic problems. No model call is justified anywhere in this requirement. Any attempt to use a model here is a paradigm-bypass (cost-routing-paradigms gate blocks at review). Estimated model spend: $0.

---

## 10. Personas for the Architect stage

Two personas are required for a `high_stakes` lane with `auth + multi_tenancy + schema_changes` surfaces.

### Persona 1: Identity & Session Abuse Red-teamer `:sonnet`
**Angle:** Attack the auth surface. Stress-test rotating refresh token implementation for replay, token-family theft, and concurrent-rotation race conditions. Stress-test the revocation path: what happens if the Postgres UPDATE to `user_session.revoked_at` fails after the new session row is inserted? What is the blast radius of rate-limit Redis outage? Does the multi-org selector leak org membership to unauthenticated callers? Can an invited user bypass the org-creation block by manipulating the API directly? Does `scope=all` logout correctly revoke across all brands for a multi-brand user?

### Persona 2: Scope & Product-Realism Skeptic `:sonnet`
**Angle:** Challenge scope and testability. Is the 4-step wizard buildable without a Canon amendment? Does adding `currency_code` + `timezone` + `revenue_definition` to `brand` require any migration on existing brand rows (data compatibility)? Is the "resume after crash" implementation (onboarding_status column) robust enough, or does it need a finer-grained step state? Is the integration-selection step truly a frontend-only addition, or does it require a new backend state machine? Is the multi-org selector going to break the single-org happy path that M1 tested? What does the Stakeholder actually see when they test that is "not as per expectations" — is it the wizard steps, the brand form missing fields, or the redirect?

---

```
needs_personas:
  - "Identity & Session Abuse Red-teamer:sonnet — replay/race/theft attack on rotating refresh tokens, revocation atomicity, rate-limit bypass, multi-org selector auth exposure"
  - "Scope & Product-Realism Skeptic:sonnet — Canon-amendment test, migration compatibility, wizard buildability, step-state robustness, what exactly the Stakeholder sees as failing"
```
