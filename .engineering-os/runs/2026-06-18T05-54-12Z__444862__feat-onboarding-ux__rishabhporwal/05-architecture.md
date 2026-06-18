# 05 — Architecture Plan: feat-onboarding-ux

| Field | Value |
|-------|-------|
| **req_id** | `feat-onboarding-ux` |
| **Stage** | 2 (Architect) → binding plan for Stage 3 |
| **Paradigm** | Deterministic logic only (auth/session, SQL state-machine, server-side guards). ZERO model/statistical/ML. Justification: every deliverable is a deterministic control-flow / persistence change. Cost: $0 incremental tokens/day, $0/mo spend. |
| **Pattern** | Locked: BFF (frontend-api) at edge, web → BFF only, core owns OLTP. No new service, no new topic, no new envelope. Additive migration only. |
| **Tracks** | `@backend-developer` (core BFF + workspace-access + connector mount) ∥ `@frontend-web-developer` (onboarding wizard, banner, gating UI). Deploy: single-service (`apps/core`) + `apps/web` — affected-only; no new deploy app. |

## Cost-paradigm gate — PASS
No model call anywhere. Pure deterministic logic beats every alternative. No region assumption added (RegionAdapter already derives region from `currency_code` in `brand.service.ts:36`; untouched).

## Single-Primitive sweep — CLEAN (extend, do not create)
- Session issuance: ONE primitive — `AuthService.login()` + the `brain_session` cookie set in `bff.routes.ts:177`. Auto-login REUSES it; no second session path.
- Forward-only guard: ONE primitive — `OrganizationRepository.advanceOnboardingStatus()` (`repositories.ts:580`, `WHERE onboarding_step < $2`) already idempotent + forward-only. We route on top of it; we do NOT add a second status machine.
- Verified-email gate: ONE primitive — a new `requireVerifiedEmail` Fastify preHandler (mirrors `requireRole` in `rbac.ts:34`), consumed by every sensitive route. NOT per-action inline checks.
- Merged provisioning: ONE transactional command reusing the EXISTING `WorkspaceService.create` + `BrandService.create` (incl. the website/pixel provisioner). NOT a new brand/workspace path.

---

## Deliverable 1 — Auto-login session issuance on register

### Decision
Issue a real authenticated session **inside the register flow, server-side, by reusing the existing session-minting path** — NOT a client-side token, NOT an auth bypass. The cleanest seam: a new **BFF route `POST /api/v1/bff/register`** that (a) calls `AuthService.register()`, then (b) on a genuinely-new user, mints a session via the SAME mechanism `bff.routes.ts:160-183` uses for login and sets the `brain_session` httpOnly cookie. The web app calls this instead of `/v1/auth/register`.

### Why a new BFF route (not a change to `/v1/auth/register`)
- `/v1/auth/register` (`auth.routes.ts:60`) returns `201` with NO cookie by design (it is the public, CSRF-exempt, rate-limited registration contract — also reused by non-browser callers). Adding a cookie there would couple the public auth contract to the browser session.
- The BFF is the browser's only edge (`client.ts:73`, web → `/api/bff/*` only). Session cookies are minted ONLY in the BFF (`bff.routes.ts`). Auto-login belongs in the BFF for the same reason login does.

### Mechanism (secure — no bypass)
`AuthService.register()` today returns `{ userId, message, code? }` and does NOT distinguish "created new" vs "already existed" (NN-5 timing-equalization — `auth.service.ts:159-176`). Auto-login must issue a session **only for a freshly-created user**, and must NOT leak existence for an existing user.

- **Add** `AuthService.registerAndStartSession(email, password, ip, userAgent, correlationId)` in `auth.service.ts`. It calls the existing internal register logic; when the user is genuinely new it then runs the **identical session-creation block** already in `login()` (`auth.service.ts:287-326`: `randomUUID()` jti → `generateToken()` refresh → `sessionRepo.insert` → `setFamilyIdToSelf` → `resolveActiveContext` (will be `EMPTY_CONTEXT` — no membership yet) → `mintSessionToken`). It returns `{ created: boolean, accessToken?, refreshToken?, expiresIn?, user, context }`.
  - **DO NOT duplicate** the session block — extract the lines `auth.service.ts:287-326` into a private `issueSession(client, user, ip, userAgent, ctx)` helper and call it from BOTH `login()` and `registerAndStartSession()` (Single-Primitive; removes the temptation to fork session-minting).
- **Existing-user path:** `created=false`, NO tokens. The BFF still returns `201` with the SAME body shape and the SAME generic message as the new-user path **minus the cookie** — and (to keep timing equalized, NN-5/MA-15) the existing-user branch already re-issues verification fire-and-forget. The response body MUST be byte-identical between created/existing except it is acceptable that only the new-user path also carries `Set-Cookie` (an attacker cannot read httpOnly Set-Cookie cross-origin; the visible JSON body stays identical). > ASSUMPTION: the product accepts that a freshly-created account is auto-logged-in while a collision (email already exists) is not — this is the Stakeholder-approved UX and does not create an enumeration oracle in the JSON body.
- **Audit:** `user.registered` already written (`auth.service.ts:197`). Add `user.logged_in` (reuse the existing audit shape at `auth.service.ts:328`) only on the `created=true` branch, entity `user_session`, `jti`.

### Cookie
Set `brain_session` httpOnly cookie EXACTLY as `bff.routes.ts:177-183` (httpOnly, `secure` in prod, `sameSite:'strict'`, `path:'/'`, `maxAge: expiresIn`). After registering, the web app then fetches `/v1/bff/csrf` to bind a session CSRF token (same as `client.ts:235`).

### Forward flow
New user lands authenticated with `EMPTY_CONTEXT` (no workspace/brand) → middleware sees the cookie (`middleware.ts:42`) → web routes to the wizard Step 1 (merged create step). No `/login` detour.

### Backend files
- `apps/core/src/modules/workspace-access/internal/application/auth.service.ts` — extract `issueSession()` private helper from `login()`; add `registerAndStartSession()`.
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts` — add `POST /api/v1/bff/register` (CSRF-exempt: add `/api/v1/bff/register` to the exempt list in `main.ts:246`; rate-limit by IP reusing `registerIpKey`).
- `apps/core/src/main.ts:246` — add `path === '/api/v1/bff/register'` to `csrfExempt`.

### Frontend files
- `apps/web/lib/api/client.ts` — `authApi.register` → POST `/v1/bff/register` (not `/v1/auth/register`); on success, bootstrap CSRF (mirror `client.ts:235`).
- `apps/web/components/auth/register-form.tsx:34-49` — `onSuccess` no longer pushes `/verify-email`; pushes the wizard entry (`/onboarding/start` resolver — see Deliverable 5). Keep the `INVITE_PENDING` branch.

---

## Deliverable 2 — Soft-gate email verification

### Decision
Two independent halves: (A) a **dismissible banner** (pure UX, web) and (B) a **server-side hard block** on sensitive actions enforced by a new `requireVerifiedEmail` preHandler in the BFF/core. The banner NEVER guards anything; the preHandler is the only thing that blocks.

### Server-side enforcement — the gate (this is the load-bearing part)

**New preHandler** `requireVerifiedEmail(authService)` in a new file `apps/core/src/modules/workspace-access/internal/security/email-verified.guard.ts`, mirroring `requireRole` (`rbac.ts:34`). It runs AFTER `sessionPreHandler` (which populates `request.auth`).

- The JWT does **not** carry `email_verified` (claims are `sub/brand_id/workspace_id/role/jti/iat/exp` — `auth.service.ts:549`). The guard MUST do a DB self-read, not trust a claim: call `authService.getCurrentUser(auth.userId, correlationId)` (`auth.service.ts:1057`, already RLS-safe self-read) and check `user.emailVerifiedAt !== null`.
  - Reject with **`403 EMAIL_NOT_VERIFIED`** + `{ request_id, error: { code, message } }` when unverified. (403, not 401 — the session is valid; the action is forbidden until verified. A 401 would trigger the client's logout-redirect at `client.ts:172`.)
- **Add `authService.isEmailVerified(userId, correlationId): Promise<boolean>`** as a thin wrapper over `getCurrentUser` so the guard does not reach into the user entity shape. Returns `false` if user not found (fail-closed).

**The three sensitive surfaces and their EXACT enforcement points** (gate = add `requireVerifiedEmail` to the preHandler chain, AFTER `sessionPreHandler`/`requireRole`):

1. **Connect a real store** — `apps/core/src/main.ts:795-797` connector WRITE scope (`scope.addHook('preHandler', sessionPreHandler); requireRole('manager')`). **Add `scope.addHook('preHandler', requireVerifiedEmail(authService))`** to this scope. This covers `POST /api/v1/connectors` (generic connect → OAuth initiate, `main.ts:800`) and `GET /api/v1/connectors/shopify/install` (`shopifyConnectorRoutes.ts:65`). Read routes (the marketplace list, status) stay open. > ASSUMPTION: "connect a real store" = initiating any connector OAuth/credential write; the public Shopify/ads OAuth **callbacks** stay ungated (they are HMAC/state-authed, not session-authed — `main.ts:659`, and blocking them would strand an in-flight OAuth).
2. **Invite a member** — `POST /api/v1/invites` (`member.routes.ts:41`, currently `preHandler: [sessionPreHandler]`). **Change to `preHandler: [sessionPreHandler, requireVerifiedEmail(authService)]`.** `POST /api/v1/invites/accept` (`member.routes.ts:92`, public token-authed) stays ungated.
3. **Billing** — no billing routes exist in M1. > ASSUMPTION: billing is out of code scope for this slice; we DOCUMENT the contract (any future billing-mutation route MUST include `requireVerifiedEmail`) and add it to the gate's doc-comment as the canonical list. No speculative route is created (every build ships UI; a hidden gate on a nonexistent route ships nothing). The connect-store + invite gates are the shippable, demoable enforcement.

**Why DB-read per call is acceptable:** these are rare, high-stakes mutations (connect/invite), not hot paths. One indexed self-read (`getCurrentUser`) per call is negligible and avoids a stale-claim bug (a user who verifies mid-session would otherwise stay blocked until token rotation).

### The banner (UX only)
- `/v1/bff/me` already returns `user.email_verified` (`bff.routes.ts:537`). The web reads it via `authApi.me()`.
- **New component** `apps/web/components/dashboard/verify-email-banner.tsx`: dismissible (localStorage key `brain_verify_banner_dismissed`), shown when `email_verified === false`, with a "Resend email" action (POSTs `/v1/auth/verify-email` re-issue path — reuse existing resend; if no resend endpoint, link to `/verify-email`). Dismiss hides it for the session only; it reappears on reload until verified (honest progress).
- Mount in the dashboard shell layout so it appears on the post-onboarding dashboard. NOT a route guard.
- **Sensitive-action UI affordance:** on the Connect and Invite buttons, when `email_verified === false`, show a tooltip/disabled-with-reason ("Verify your email to connect a store"). This is UX guidance ONLY — the server gate is authoritative; the UI hint must degrade gracefully if a determined user re-enables the button (server returns `403 EMAIL_NOT_VERIFIED`, surfaced as a toast).

### Files
- Backend: new `security/email-verified.guard.ts`; `auth.service.ts` (+`isEmailVerified`); `main.ts:795` (connector write scope); `member.routes.ts:41` (invite).
- Frontend: new `components/dashboard/verify-email-banner.tsx`; dashboard shell layout (mount); connector + invite components (disabled-with-reason hint + 403 toast handling).

---

## Deliverable 3 — Merged workspace+brand provisioning command (one UI step, transactional)

### Decision
**One new BFF command `POST /api/v1/bff/onboarding/provision`** that provisions **organization + first brand (with website→pixel) in ONE Postgres transaction**, server-side. The data model is unchanged (org→brand 1:1); only the UI collapses. The website/pixel path from feat-onboarding-website is preserved EXACTLY by calling the existing `BrandService.create` provisioner.

### Transactional seam — the critical part
Today `WorkspaceService.create` (`workspace.service.ts:29`) and `BrandService.create` (`brand.service.ts:72`) each open their OWN client/connection and are NOT in a shared transaction. The merged step must be atomic (no orphan org if brand creation fails). Approach:

- **Add `OnboardingService.provisionWorkspaceAndBrand(...)`** in a new file `apps/core/src/modules/workspace-access/internal/application/onboarding.service.ts`. It accepts `{ workspaceName, brandDisplayName, domain?, currencyCode?, timezone?, revenueDefinition?, ownerUserId }`, derives the slug server-side (Deliverable 4), and runs ONE transaction over a single `client` using `rawPgPool` BEGIN/COMMIT (the established pattern — `auth.service.ts:378-380`, `suspendUser`):
  1. `OrganizationRepository.insert` (slug derived server-side) + org-owner `MembershipRepository.insert` + `advanceOnboardingStatus('org_created', 1)`.
  2. `BrandRepository.insert` + brand-owner membership + `advanceOnboardingStatus('brand_created', 2)`.
  3. COMMIT.
  4. **AFTER commit** (not inside the txn): provision the pixel via the SAME injected `provisionPixel` closure used by `BrandService` (`brand.service.ts:157`), guarded by `normalizedHost !== null`. Pixel provisioning is a separate idempotent write (it targets `pixel_installation`, may hit the pixel module) and MUST stay outside the org/brand txn to avoid cross-module txn coupling — exactly mirroring the post-persist ordering in `brand.service.ts:154-159`. Re-run safety: pixel provisioning is already idempotent (get-or-create).
  - **Reuse, don't reinvent:** the repositories and the `normalizeBrandHost`/`normalizeDomain` canonicalization (`brand.service.ts:63`) and the `provisionPixel` closure are reused verbatim. The website field + per-brand pixel auto-provision keep working — this is the explicit non-regression constraint.
  - **Audit:** write `organization.created` + `brand.created` (reuse existing shapes) post-commit.
- **Session re-mint:** after provisioning, the response returns the new `organization_id` + `brand_id`; the web then calls existing `sessionApi.setOrg` (`bff.routes.ts:287`) which re-mints the cookie with the new brand/role context + `onboarding_status`. (This reuses the verified-membership re-mint path; no new session logic.)

> ASSUMPTION: the merged step keeps the brand-config fields (currency/timezone/revenue/website) from the current `/brand/new` form on ONE screen with the workspace name. Defaults (`INR`/`Asia/Kolkata`/`realized`) per `brand.service.ts:85,110,111` stand if the user does not expand "advanced".

### Why a new BFF route, not chaining the two existing REST routes from the client
The current web flow chains `POST /v1/workspaces` → `POST /v1/brands` from the browser (`create-workspace-form.tsx:53` then `create-brand-form.tsx:121`) — NON-atomic (the live-test Back-button bug is a direct symptom: an org exists with no brand). Collapsing into one server transaction kills the orphan-org class entirely and gives the wizard a single idempotent provisioning call.

### Idempotency / Back-safety (ties to Deliverable 5)
The command is guarded so a double-submit or Back→resubmit does NOT create a second org/brand:
- Honor the `Idempotency-Key` header (already sent by `client.ts:125`) — but the durable guard is: **if the caller already has an org membership** (`MembershipRepository.findActiveByUser`), return the existing `{ organization_id, brand_id }` with `200` instead of creating a duplicate. This makes the merged step idempotent per user (M1 is 1:1 org per onboarding).

### Files
- Backend: new `application/onboarding.service.ts`; new `POST /api/v1/bff/onboarding/provision` in `bff.routes.ts`; wire `OnboardingService` in `main.ts` (inject `pool`, `rawPgPool`, `audit`, `provisionPixel`, repositories — reuse the existing `BrandService` provisioner wiring). New request contract in `packages/contracts/src/api/` (e.g. `ProvisionOnboardingRequestSchema`: `workspace_name`, `brand_display_name`, optional `domain`, `currency_code`, `timezone`, `revenue_definition`).
- Frontend: new merged component `apps/web/components/onboarding/create-brand-workspace-form.tsx` (fold `create-workspace-form.tsx` + `create-brand-form.tsx`); new page replacing Step 1+2 (see Deliverable 5).

---

## Deliverable 4 — Auto-derive slug server-side (drop the slug input)

### Decision
Slug is an implementation detail; derive it server-side inside `OnboardingService` (and keep the existing `WorkspaceService.create` working for the standalone route). The web NEVER sends or shows a slug.

### Mechanism
- **Server-side slug derivation** lives in `onboarding.service.ts` (and a shared helper): `slugify(name)` = lowercase, `[^a-z0-9]+ → -`, trim hyphens, slice to ≤55 chars, then append a short random suffix (`crypto.randomUUID().replace(/-/g,'').slice(-6)`) for collision-safety — mirrors the logic the FRONTEND currently does at `create-workspace-form.tsx:34-45`, MOVED to the server (the frontend version is deleted).
- On the rare `SLUG_TAKEN` (unique violation), retry once with a fresh suffix inside the same command before COMMIT. (The suffix makes practical collisions near-zero; the retry removes the residual race.)
- **Contract change:** the merged provision request has NO `slug` field. The standalone `CreateWorkspaceRequestSchema` (`workspace.api.v1.ts:37`) keeps `slug` for API back-compat, BUT we make it **optional** and derive server-side in `WorkspaceService.create` when absent (so both paths share one slug rule). > ASSUMPTION: making `slug` optional on the existing workspace contract is additive/non-breaking (existing callers that send a slug still work); no public consumer requires it mandatory. Breaking-change check: this RELAXES a constraint → not a breaking change per `api-discipline`.

### Files
- Backend: `onboarding.service.ts` (slugify + retry); `workspace.service.ts:29` (accept optional slug, derive when absent — share the helper); `workspace.api.v1.ts:37` (`slug` optional).
- Frontend: `create-workspace-form.tsx` slug logic + the slug `<Input>` block (`:92-114`) DELETED; merged form has no slug UI.

---

## Deliverable 5 — Forward-only wizard via onboarding_status routing

### Decision
Make the wizard forward-safe by **collapsing to 3 steps and routing every onboarding entry through a single server-status resolver**, so a completed step redirects forward and Back is idempotent (no duplicate workspace/brand). The forward-only DB guard already exists (`advanceOnboardingStatus`, `repositories.ts:580`); we make the ROUTING consume it.

### New step map (post-merge)
1. **Step 1 `/onboarding/start`** — merged create workspace+brand (Deliverable 3/4).
2. **Step 2 `/onboarding/integrations`** — connect integrations (existing, `integrations/page.tsx`).
3. **Step 3 `/onboarding/done`** — done (existing).

`onboarding_status` enum is unchanged (`pending → org_created → brand_created → integration_selected → complete`, `entities.ts:10`). Both `org_created` and `brand_created` now complete in Step 1 (one transaction advances step 1→2 internally).

### Routing resolver (the forward-only guard)
- **New shared helper** `resolveOnboardingRoute(status)` in `apps/web/lib/onboarding-route.ts`:
  - `null`/`pending`/`org_created` → `/onboarding/start`
  - `brand_created` → `/onboarding/integrations`
  - `integration_selected` → `/onboarding/done`
  - `complete` → `/dashboard`
- **Entry redirect:** a new `/onboarding/start`-and-each-step client guard (a small `OnboardingGate` wrapper, or extend `(onboarding)/layout.tsx`) reads `onboarding_status` from `/v1/bff/me` (extend `bff.routes.ts:532` `/me` to ALSO return `onboarding_status` — it already resolves context in the session; add it to the `me` response) and, if the user is **past** the current page's step, `router.replace(resolveOnboardingRoute(status))`. Browser Back to `/onboarding/start` after the org+brand exist → resolver sees `brand_created`+ → forward-redirects to `/onboarding/integrations`. The already-created form is never re-shown.
- **Idempotent Back at the data layer (defense-in-depth):** even if the resolver is bypassed, the merged provision command's "already-a-member → return existing" guard (Deliverable 3) prevents a duplicate org/brand. Two layers: routing (UX) + command idempotency (correctness).

### Why status-driven (not localStorage / not history manipulation)
Status lives in `organization.onboarding_status` (server, authoritative, survives crash/refresh/new-device — `middleware.ts:14` comment already commits to this). The resolver is the single source of truth; we extend the existing pattern rather than add a parallel one.

### Files
- Backend: `bff.routes.ts:532` `/v1/bff/me` response → add `onboarding_status` (resolve via `authService.resolveActiveContext` or the membership→org read already present); no new route.
- Frontend: new `lib/onboarding-route.ts`; `(onboarding)/layout.tsx` or a new `OnboardingGate` client component (forward-redirect on mount); update step pages to 3-step indicators; `register-form.tsx` + auto-login → push `resolveOnboardingRoute(null)` = `/onboarding/start`.

---

## Deliverable 6 — Friction cuts
Clear CTAs, no dead-ends, honest progress: 3-step indicators corrected; merged step has a single primary CTA + "skip website" (preserve the existing `handleSkipWebsite` affordance, `create-brand-form.tsx:155`); banner gives a resend CTA; sensitive buttons show the verify-reason instead of a silent failure. No new backend.

---

## RLS / isolation verification (THE invariant)
- Every new/changed route runs `sessionPreHandler` first (NN-3) — `request.auth` populated before any guard.
- `requireVerifiedEmail` self-reads via `getCurrentUser` (RLS-safe `app_user` self-read, already used).
- `OnboardingService` sets `QueryContext` (`userId`/`workspaceId`/`brandId`) on every query exactly as `WorkspaceService`/`BrandService` do; the brand insert uses `{ ...ctx, brandId: '' }` (brand-not-yet-exists) then brand-scoped ctx — mirroring `brand.service.ts:113`.
- **Tests MUST run under role `brain_app`** (superuser `brain` BYPASSES RLS → any isolation assertion under `brain` is INERT — per the run constraint + memory). Live tests connect as `brain_app`.
- Cross-tenant negative test: user A cannot provision/inspect user B's org; an unverified user gets `403 EMAIL_NOT_VERIFIED` on connect-store + invite; a verified user passes.

## Reversibility
- Migration: NONE required (no schema change — `onboarding_status`/`onboarding_step`/`email_verified_at` already exist). The only contract change (optional `slug`) is additive/relaxing.
- Every change is behind an existing route family or a new additive route; revert = remove the new BFF routes + guards + restore the two-step web forms. No data migration to unwind.

## Alternatives considered + rejected
1. **Auto-login by returning the access token in the `/v1/auth/register` body and having the client set it** — REJECTED: the browser session is an httpOnly cookie minted only at the BFF; a client-set token is an XSS-exfiltration surface and bypasses the BFF edge. (Anti-blind: "plaintext token to client" rejected.)
2. **Soft-gate enforced by checking `email_verified` in the UI only / hiding buttons** — REJECTED by the requirement: the block MUST be server-side. UI hiding alone is a security hole (a crafted request connects a store unverified).
3. **Soft-gate via an `email_verified` JWT claim** — REJECTED: a user who verifies mid-session would stay blocked until token rotation (stale claim); and a claim is mintable-trust vs an authoritative DB read. The action is rare → a per-call self-read is cheap and correct.
4. **Merged step = client chains the two existing REST calls** — REJECTED: non-atomic (the orphan-org bug). One server transaction is the only correct atomicity boundary.
5. **Forward-only via browser history/`localStorage`** — REJECTED: not crash/refresh/device-safe; server `onboarding_status` is already the authority.

---

## Acceptance contract (REQUIRED pass-1 — folds every constraint; no rework bounce)

### @backend-developer
- [ ] `issueSession()` extracted from `login()`; `login()` behavior unchanged (existing auth tests green). `registerAndStartSession()` mints a real session ONLY for `created=true`; existing-user JSON body byte-identical (NN-5); `user.logged_in` audit on created path only.
- [ ] `POST /api/v1/bff/register` sets `brain_session` httpOnly cookie identically to `bff.routes.ts:177-183`; added to CSRF-exempt list (`main.ts:246`); IP rate-limited (`registerIpKey`).
- [ ] `requireVerifiedEmail` preHandler: DB self-read (NOT a claim); `403 EMAIL_NOT_VERIFIED` (NOT 401); fail-closed on user-not-found.
- [ ] Gate wired at: connector WRITE scope (`main.ts:795-797`), `POST /api/v1/invites` (`member.routes.ts:41`). Read/list/callback routes NOT gated. Billing contract documented in the guard doc-comment.
- [ ] `OnboardingService.provisionWorkspaceAndBrand`: org+brand+memberships+status-advance in ONE `rawPgPool` BEGIN/COMMIT; pixel provisioned AFTER commit via the existing `provisionPixel` closure, guarded by `normalizedHost !== null` (feat-onboarding-website NOT regressed); `organization.created`+`brand.created` audited; "already-a-member → return existing 200" idempotency guard.
- [ ] Slug derived server-side (slugify + suffix + one retry on `SLUG_TAKEN`); `slug` made optional on `CreateWorkspaceRequestSchema`; `WorkspaceService.create` derives when absent (shared helper).
- [ ] `/v1/bff/me` returns `onboarding_status`.
- [ ] All queries carry tenant `QueryContext`; live tests run under `brain_app`; cross-tenant + unverified-403 + verified-pass negative tests green.

### @frontend-web-developer
- [ ] `authApi.register` → `/v1/bff/register`; on success bootstrap CSRF then `router.push(resolveOnboardingRoute(null))` (`/onboarding/start`); `INVITE_PENDING` branch preserved.
- [ ] Merged `/onboarding/start` form (workspace name + brand config + website + skip-website), NO slug field, single primary CTA; calls `POST /v1/bff/onboarding/provision` then `sessionApi.setOrg`.
- [ ] `lib/onboarding-route.ts` resolver; `OnboardingGate` forward-redirects when status is past the current step (Back re-show eliminated); 3-step indicators.
- [ ] `verify-email-banner.tsx`: dismissible (session-only), shown when `email_verified===false`, resend CTA, mounted in dashboard shell — NOT a route guard.
- [ ] Connect + Invite buttons: verify-reason hint when unverified + graceful `403 EMAIL_NOT_VERIFIED` toast.
- [ ] Website→pixel UX (preview/skip) preserved exactly (no feat-onboarding-website regression).

### Deploy (both tracks)
- [ ] Affected-only: `apps/core` + `apps/web` build → images → per-service deploy → canary → auto-rollback. No new deploy app, no deploy-all.

---

## Journal
```
## 2026-06-18 — Architect — feat-onboarding-ux
Stage: 2 · Paradigm: deterministic-only ($0 tokens; auth/SQL/guards) · Tracks: @backend-developer ∥ @frontend-web-developer
Single-Primitive: clean (extended issueSession, advanceOnboardingStatus, provisionPixel, requireRole→requireVerifiedEmail) · Next: builders — Stage 3
Key seams: BFF /register auto-login (issueSession reuse) · requireVerifiedEmail self-read guard on connector-write scope + invites · OnboardingService 1-txn provision (org+brand+pixel) · server slugify · resolveOnboardingRoute forward-only.
```

**State:** `dev-parallel` · **Owners:** @backend-developer, @frontend-web-developer (Stage 3).
