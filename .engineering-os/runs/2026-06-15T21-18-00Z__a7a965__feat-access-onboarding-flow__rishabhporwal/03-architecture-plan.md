# 03 — Architecture Plan (BINDING) — `feat-access-onboarding-flow`

| Field | Value |
|-------|-------|
| **req_id** | `feat-access-onboarding-flow` |
| **Stage** | 2 — Architecture |
| **Author** | Architect |
| **Authored at** | 2026-06-16T01:50:00Z |
| **Lane** | `high_stakes` (auth, connectors, multi_tenancy, outbound_channel, pii, schema_changes) |
| **Decision** | ADVANCE — Stage 3 (backend-developer + frontend-web-developer, parallel) |
| **Paradigm** | **Tier 1 — Deterministic logic only.** Zero model calls. Estimated model spend: $0/mo, 0 tokens/day. Justification: every item is a DB transaction, a Redis counter, an enum-to-URL lookup table, or a CHECK constraint. No statistical/ML/LLM tier is reachable or appropriate — a model call anywhere here would be a paradigm-bypass. |
| **Sources** | `02c-intake-synthesis.md`, `02a`, `02b`, `01b-stakeholder-scope-decisions.json`, Canon: `METRICS.md`/`INVARIANTS.md`/`STACK.md`/`TRIGGER-SURFACES.md`, live code (cited `file:line`), M1 plan `03-architecture-plan.md` |

---

## 0. Branch / rebase reality (READ FIRST — both tracks)

- All auth/onboarding/CSRF work lives on `feat/onboarding-session-context`. The Stakeholder merged a PR; **base may have moved.** Builders MUST branch from the **latest integration of `feat/onboarding-session-context`** (rebase onto it first), NOT from `master`.
- **Migrations on this branch already reach `0009`** (`0008_membership_self_read.sql`, `0009_organization_self_read.sql`). **Next migration number is `0010`.** If a concurrent branch lands a `0010_*` before this work merges, the backend builder renumbers ours to the next free integer and re-runs `pnpm migrate up` from clean — node-pg-migrate orders by filename prefix, so a collision is a rename, not a logic change.
- Migration runner is `node-pg-migrate@^8.0.4` (real — `package.json:34`; scripts `migrate`/`migrate:up`/`migrate:down`/`migrate:create` at `package.json:20-23`). Existing `.sql` files are raw single-direction SQL with no `down` section. **All new migrations in this plan MUST ship both an `up` and a `-- DOWN` block** (run in reverse via `migrate:down`). The app role is `brain_app` (NOLOGIN, no BYPASSRLS — `0001_init.sql`). RLS pattern = **NN-1 two-arg fail-closed** `current_setting('app.current_*_id', TRUE)::uuid`.

---

## 1. The two architect decisions (resolved before schema — binding)

### MA-09 — `onboarding_status` placement → **Option A: on `organization`** (BINDING)

**Decision:** `onboarding_status` + `onboarding_step` columns live on **`organization`**, tracking **first-brand onboarding only**.

**Justification (against M1 reality + Canon):**
1. **M1 is single-brand-per-org in practice.** `create-brand-form.tsx:32` reads `workspaces[0].id` and the wizard creates exactly one brand. There is no second-brand UI in M1. Tracking per-org is sufficient and simpler.
2. **The wizard is an *organization* bootstrap, not a *brand* bootstrap.** Step 1 (Org) precedes any brand existing — there is no `brand_id` to hang status on at Step 1. Putting the column on `brand` would force a NULL-status limbo for the org-created-but-no-brand state, reintroducing exactly the `needs_onboarding` ambiguity we are killing.
3. **Canon "brand = tenant unit" is about data isolation (RLS, I-S01), not about UX wizard state.** Onboarding status is control-plane UX bookkeeping, never a tenant-scoped data row. `organization` is already workspace-GUC RLS-scoped (`0009`), so the column inherits correct isolation with zero new policy.
4. **The dashboard onboarding-progress widget (`bff.routes.ts:511`) is the multi-brand-safe surface** — it derives per-brand completion (Shopify/pixel) live from data tables and is separate from the wizard. Second-brand onboarding (post-M1) routes through that widget's guided empty states, not the wizard.

**M1 constraint (document in code):** `onboarding_status` tracks the **first** brand only. After `'complete'`, adding a second brand does NOT reset the wizard. Builder MUST add this comment at every advance call-site:
`// M1: onboarding_status tracks first-brand onboarding only; multi-brand onboarding is post-M1 (routes via dashboard onboarding-progress widget).`

**Enum (resume states — a mid-wizard crash resumes to the exact step):**

| `onboarding_status` | Meaning | Resume route (frontend) |
|---|---|---|
| `pending` | account exists, no org yet | `/workspace/new` (Step 1) |
| `org_created` | org exists, no brand yet | `/brand/new` (Step 2) |
| `brand_created` | brand exists, integration step not done | `/onboarding/integrations` (Step 3) |
| `integration_selected` | Shopify connected OR skipped; Done not acked | `/onboarding/done` (Step 4) |
| `complete` | wizard finished | `/dashboard` |

`onboarding_step SMALLINT` (0–4) is a denormalized convenience mirror for the progress bar; the **status enum is authoritative** for routing. The frontend router keys off `onboarding_status` exclusively (the lookup table in §5, Track F-1).

### MA-12 — `revenue_definition` enum → **`('realized','delivered')`, `placed` EXCLUDED. NO Canon amendment.** (BINDING)

**Decision:** M1 CHECK constraint = `CHECK (revenue_definition IN ('realized','delivered'))`. `placed` is **NOT** in the constraint and **NOT** exposed in the brand form. Default = `'realized'`.

**Justification (against METRICS.md — verified by grep):**
- `METRICS.md:16` defines `realized_revenue`. `METRICS.md:17` defines `provisional_revenue` (the `delivered`/settling horizon). **There is NO `placed` metric anywhere in METRICS.md** (grep confirmed). `METRICS.md:28` (`mer`) is explicit: *"Always on **realized** revenue (never placed/gross)."*
- Shipping a brand-form option the metric engine cannot compute = a phantom setting → a stakeholder selects "Placed" and every revenue surface silently has no `placed_revenue` to render. That is a correctness defect, not a feature.
- `realized` → `realized_revenue` (exact). `delivered` → `provisional_revenue` (the delivery-horizon recognition, `recognition_label IN ('provisional','settling')`). Both have engine definitions + golden fixtures TODAY.
- **Default `'realized'`** matches COD-India/GCC reality: COD revenue is only real at the finalized ledger horizon (~25d COD / 7d prepaid, `METRICS.md:55`); recognizing at "delivered" would over-count RTO-bound orders.

**Canon impact: NONE.** No METRICS.md amendment, no Stakeholder escalation. We ship only values METRICS.md already sanctions. `placed` is deferred to a future migration *if and only if* a `placed_revenue` metric is ever added to METRICS.md first (that would be its own intake). **This does NOT force NEEDS-STAKEHOLDER** — the synthesis Canon-amendment assessment (`02c §4`) confirms: amendment required only if `placed` is included. We exclude it. → `decision: ADVANCE`.

---

## 2. Single-Primitive sweep + over-engineering self-check

**Single-Primitive: CLEAN (extend-only).** No new primitives. Every item extends an existing one:
- Refresh rotation → extends `user_session` (cols already present: `jti`, `refresh_token_hash`, `revoked_at`, `expires_at` — `0002_auth.sql:51-64`) + extends `UserSessionRepository`.
- Bulk revocation → 2 new methods on the **one** `UserSessionRepository` (`repositories.ts:132`). No second revocation path.
- Rate limiting → the **one** Redis CacheAdapter (ADR-004); a single `RateLimiter` helper consumed by all auth routes (no per-route forks).
- Onboarding status → 2 columns on the existing `organization`; the **one** BFF session contract carries it.
- Brand locale → 3 columns on the existing `brand`; the existing `BrandRepository`.
- Audit → the **one** `AuditWriter` (`@brain/audit`), already wired.
- CSRF → consolidates TWO implementations DOWN TO ONE (removes the duplicate — net primitive reduction).

**Over-engineering self-check: PASS.** Deferred/rejected gold-plating: dynamic `Intl.supportedValuesOf` timezone list (bounded 3-value allowlist instead); per-session audit rows on bulk revoke (one `sessions.bulk_revoked` row with count instead); making invite-accept a protected route (flagged MA-07 item 3 — DEFERRED, email-match guard is sufficient for M1); generic rate-limit middleware framework (a single targeted helper for 4 routes). No new service, no new queue, no new table beyond column adds.

---

## 3. Schema / migrations (Track B-MIG — `@backend-developer`)

All migrations: `node-pg-migrate` raw-SQL style, **each with an `up` and a `-- DOWN` block**. RLS/GRANT in the same migration as any new table (none here — all are column adds to existing RLS-enabled tables, so isolation is inherited; **explicit negative-control note per column below**).

### `0010_brand_locale.sql` — brand currency/timezone/revenue_definition (AC-4)

```sql
-- UP
ALTER TABLE brand ADD COLUMN IF NOT EXISTS currency_code CHAR(3) NOT NULL DEFAULT 'INR'
  CHECK (currency_code IN ('INR','AED','SAR'));               -- I-S07 money pairing
ALTER TABLE brand ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata'
  CHECK (timezone IN ('Asia/Kolkata','Asia/Dubai','Asia/Riyadh'));  -- bounded allowlist (no Intl.*)
ALTER TABLE brand ADD COLUMN IF NOT EXISTS revenue_definition TEXT NOT NULL DEFAULT 'realized'
  CHECK (revenue_definition IN ('realized','delivered'));     -- MA-12: 'placed' EXCLUDED
-- backfill: NOT NULL DEFAULT already fills existing test brands (INR/Kolkata/realized). No data migration.
-- DOWN
ALTER TABLE brand DROP COLUMN IF EXISTS revenue_definition;
ALTER TABLE brand DROP COLUMN IF EXISTS timezone;
ALTER TABLE brand DROP COLUMN IF EXISTS currency_code;
```
- **PG14+ catalog-only change** for `ADD COLUMN ... NOT NULL DEFAULT <const>` — no table rewrite, no lock escalation, safe under load.
- **Down is reversible** in the first deploy window (before any non-default brand value). If any brand row holds a non-default value, `migrate:down` is documented-irreversible — the deploy runbook (§7) gates down on the deploy-window only.
- **Negative-control / NN-1:** `brand` is already RLS-scoped to `app.current_brand_id` (two-arg fail-closed, `0004_brand.sql:37-39`). New columns inherit that policy — a cross-brand SELECT returns 0 rows including these columns. **No new policy needed; the existing NN-6 isolation-fuzz on `brand` covers the new columns** (builder extends the fuzz assertion to read `currency_code` and confirm cross-brand returns nothing). `region_code` derivation: derive from `currency_code` (INR→IN, AED→AE, SAR→SA) in `brand.service.create` — no separate region selector field (smallest). No money column is a float (I-S07: these are config, not amounts; the `*_minor` ledger columns are untouched).

### `0011_onboarding_state.sql` — onboarding_status on organization (AC-5)

```sql
-- UP
ALTER TABLE organization ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (onboarding_status IN ('pending','org_created','brand_created','integration_selected','complete'));
ALTER TABLE organization ADD COLUMN IF NOT EXISTS onboarding_step SMALLINT NOT NULL DEFAULT 0
  CHECK (onboarding_step BETWEEN 0 AND 4);
-- backfill: existing orgs (which already have brands in test data) should NOT be stuck at 'pending'.
UPDATE organization o SET onboarding_status = 'complete', onboarding_step = 4
  WHERE EXISTS (SELECT 1 FROM brand b WHERE b.organization_id = o.id);
-- DOWN
ALTER TABLE organization DROP COLUMN IF EXISTS onboarding_step;
ALTER TABLE organization DROP COLUMN IF EXISTS onboarding_status;
```
- **Backfill rationale:** existing test orgs already have brands; defaulting them to `'pending'` would shove fully-onboarded users back to Step 1 on next login. The `UPDATE` marks any org that already has a brand as `'complete'`. Orgs with no brand stay `'pending'` (correct).
- **Negative-control / NN-1:** `organization` is RLS-scoped to `app.current_workspace_id` (two-arg, `0009_organization_self_read.sql`). New columns inherit it. The BFF advance-writes set `ctx.workspaceId` so RLS permits the UPDATE to the caller's own org only. Builder extends the org isolation-fuzz to assert a cross-workspace `onboarding_status` read returns 0 rows.

### `0012_session_rotation_lineage.sql` — refresh-token family lineage (AC-1)

```sql
-- UP
ALTER TABLE user_session ADD COLUMN IF NOT EXISTS family_id UUID NULL;       -- session lineage / rotation family
ALTER TABLE user_session ADD COLUMN IF NOT EXISTS rotated_from UUID NULL REFERENCES user_session(id);
ALTER TABLE user_session ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ NULL;  -- set when a refresh token is consumed (rotation/replay marker)
-- backfill: existing live sessions get family_id = id (each its own family root).
UPDATE user_session SET family_id = id WHERE family_id IS NULL;
CREATE INDEX IF NOT EXISTS user_session_family_id_idx ON user_session (family_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS user_session_refresh_hash_idx ON user_session (refresh_token_hash);
-- DOWN
DROP INDEX IF EXISTS user_session_refresh_hash_idx;
DROP INDEX IF EXISTS user_session_family_id_idx;
ALTER TABLE user_session DROP COLUMN IF EXISTS used_at;
ALTER TABLE user_session DROP COLUMN IF EXISTS rotated_from;
ALTER TABLE user_session DROP COLUMN IF EXISTS family_id;
```
- **`family_id`** ties a login's whole rotation lineage together so replay-detection can wipe the entire family. On login, `family_id = the new row's id` (root). On rotation, the new row inherits the old row's `family_id`.
- **`refresh_token_hash_idx`** makes the rotation lookup (`WHERE refresh_token_hash = $hash`) indexed — without it, every refresh is a seq scan.
- **Negative-control / NN-1:** `user_session` RLS = `app.current_user_id` self-read (`0002_auth.sql`). The rotation path sets `ctx.userId` from the looked-up row's `app_user_id` BEFORE the `FOR UPDATE` (see AC-1 flow). Family-wipe runs under the same user GUC — a session row of another user is invisible, so family-wipe can NEVER cross users. Builder asserts this in the isolation-fuzz.

**Deploy sequence (all three migrations, MA-08 — enforced in §7 runbook):**
`(1) pnpm migrate up (0010→0011→0012)` → `(2) deploy core (backend)` → `(3) deploy web (frontend)`. Backend `mapRow` is column-absent-defensive (§4) so step (1)→(2) ordering is safe either way; frontend last so it never references a contract field the backend hasn't shipped.

---

## 4. Backend design — per-item (Track B-* — `@backend-developer`)

DDD: all logic stays in `application/` services + `infrastructure/repositories.ts`; routes (`interfaces/rest/*`) stay thin. No business rule moves into a route handler.

### AC-1 — Rotating refresh tokens (CRITICAL) — Track B-1

**New endpoint:** `POST /api/v1/auth/token/refresh` in `auth.routes.ts` (after `/login`, before `/logout`). Body: `{ refresh_token: string }`. **CSRF-exempt** (it is a token endpoint authenticated by the refresh token itself, not a cookie — add to the exempt list in `main.ts:190` and document why).

**New service method** `AuthService.rotateRefreshToken(rawRefreshToken, ip, userAgent, correlationId)` (`auth.service.ts`). Flow — **all inside ONE transaction with `SELECT ... FOR UPDATE`** (MA-03):
1. `hash = sha256(rawRefreshToken)`.
2. `BEGIN`. Look up the row **with a system context** (no user GUC yet — token IS the credential; use a direct `client.query` mirroring `acceptInvite`'s token-lookup pattern, `invite.service.ts:142`):
   `SELECT id, app_user_id, family_id, revoked_at, used_at, expires_at FROM user_session WHERE refresh_token_hash = $1 FOR UPDATE`.
3. **Not found at all** → `ROLLBACK`, throw `AuthError('INVALID_TOKEN')` → route returns **401 `INVALID_TOKEN`**.
4. **Found but `revoked_at IS NOT NULL` OR `used_at IS NOT NULL`** (REPLAY — a consumed/revoked token re-presented): **family-wipe** — `UPDATE user_session SET revoked_at = NOW() WHERE family_id = $famId AND revoked_at IS NULL` (under `ctx.userId = row.app_user_id`), `COMMIT`, audit `sessions.bulk_revoked {reason:'refresh_replay', count}`, throw → route returns **401 `SESSION_REVOKED`** (resolves MA-16).
5. **Found, valid, `expires_at > NOW()`** (ROTATION):
   - `UPDATE user_session SET revoked_at = NOW(), used_at = NOW() WHERE id = $oldId`.
   - Generate new `jti = randomUUID()`, new `refreshToken` (`generateToken()`), `expiresAt = NOW() + 7d`. INSERT new row with **`family_id = oldRow.family_id`**, `rotated_from = oldRow.id`.
   - Re-resolve active context (`resolveActiveContext`), mint new 15-min access JWT on the new `jti`.
   - `COMMIT`. Return `{ access_token, refresh_token, expires_in: 900 }`.
6. **`jti UNIQUE` violation on INSERT** (concurrent race that slipped past FOR UPDATE — defense in depth): catch PG error code `23505` → `ROLLBACK` → route returns **401 `SESSION_CONFLICT`** "please re-login" (MA-03). Do NOT surface as 500.

**Repository additions** (`UserSessionRepository`): `findForUpdateByRefreshHash(hash, client)`, `markRotated(oldId, ctx)`, `insertRotated({...family_id, rotated_from}, ctx)` — or inline in the txn since it needs `FOR UPDATE` + single client. Keep `insert()` signature back-compatible (login still works); add `family_id`/`rotated_from` as optional fields defaulting to the new-family case.

**`login()` change** (`auth.service.ts:248`): on session insert, set `family_id = <the row's own id>` (root). Simplest: INSERT then `UPDATE ... SET family_id = id WHERE id = <new>` in the same txn, OR generate the id app-side and pass it. Builder picks; document.

### AC-2 — Revoke-on-all (CRITICAL) — Track B-2

**Repository additions** (`UserSessionRepository`):
- `revokeAllForUser(appUserId, ctx, client?)`: `UPDATE user_session SET revoked_at = NOW() WHERE app_user_id = $1 AND revoked_at IS NULL`. Returns affected count.
- `revokeAllForUserAndBrand(appUserId, brandId | null, ctx, client?)`: same, brand-scoped. **M1 reality:** a JWT carries one active brand context; brand-level revocation here = revoke ALL of that user's sessions (M1 has no per-brand session column). Document: `// M1: sessions are user-global; brandId param reserved for post-M1 per-brand sessions. Currently revokes all user sessions.` So in M1 both methods do the same UPDATE — `revokeAllForUserAndBrand` is the named seam for AC-2 wiring; `revokeAllForUser` is the suspend/logout-all path. Both accept an **optional `client`** so they can join the caller's transaction.

**Atomicity guarantee (BINDING):** `removeMember()` and `updateMemberRole()` MUST run the membership write + the session revocation + the audit append **in ONE transaction on ONE client**. Refactor `invite.service.ts:316-362` (`removeMember`) and `:262-313` (`updateMemberRole`): wrap in `BEGIN ... COMMIT` (the existing `this.pool.connect()` client; add explicit `client.query(ctx,'BEGIN')` / `'COMMIT'` / `'ROLLBACK'` on error). Order inside txn: (a) membership mutate, (b) `revokeAllForUserAndBrand(target.appUserId, target.brandId, ctx, client)`, (c) audit `membership.removed`/`membership.role_changed`, (d) audit `sessions.bulk_revoked {count, reason}`. **Revocation commits with the membership change or neither happens** — no window where a removed member keeps a live session. This is the SD-3 non-negotiable.

**Wire points:**
- `removeMember()` → revoke target's sessions (b above).
- `updateMemberRole()` → revoke on **ALL** role changes (SD-3 unconditional), not only demotions.
- **Suspend path:** add `AuthService.suspendUser(appUserId, actorId, correlationId)` (or wire into the existing status path if one exists) → `revokeAllForUser()` + audit `user.suspended` (AC-10). *Note: no member-facing suspend route exists in M1 routes; if no caller exists, ship the service method + audit + repo method and a unit test, and document that the route is post-M1. The repo/service capability is the AC-2 requirement.*
- **`scope=all` logout (MED, AC-2):** `auth.routes.ts:163` logout + `bff.routes.ts:209` BFF logout — read `?scope=all`; if set, `revokeAllForUser(auth.userId, ctx)` else `revoke(jti)`. Audit accordingly.

### AC-3 — Rate limiting (HIGH) — Track B-3

**Infra reality:** Redis is in `docker-compose.yml:30`, `REDIS_URL` is in `packages/config/src/index.ts:35`, `rateLimitKey()` helper exists in `@brain/tenant-context` (`src/index.ts:92`) — **but no Redis client is wired into `apps/core`.** Smallest path: add `ioredis@^5.4.1` (resolve latest-stable at install; verify-existing) to `apps/core`, instantiate one client in `main.ts` from `REDIS_URL`, pass to a new `RateLimiter` helper. (One client, app-wide — no per-route connection.)

**`RateLimiter` helper** (new file `apps/core/src/modules/workspace-access/internal/infrastructure/rate-limiter.ts`): one method `check(key, limit, windowSecs) → { allowed, retryAfter }` using Redis `INCR` + `EXPIRE` (set EXPIRE only on first increment). Keys via `rateLimitKey()` (no raw keys — I-S01 lint). **Fail-OPEN on Redis error** (try/catch → log + allow): per AC-3, a Redis outage must not block login. Alert hook = a `console.error`/metric counter (observability spine picks it up).

**Apply (preHandler on each route):**
- `POST /api/v1/auth/login` + `POST /api/v1/bff/session`: **per-(email+IP)** — 5 failed attempts / 15 min → 429 + `Retry-After`. Increment only on FAILED login (count failures, not successes); reset window on success. Per-IP secondary cap (e.g. 20/15min) to bound credential-stuffing across emails.
- `POST /api/v1/auth/forgot-password`: per-email 5/hour.
- `POST /api/v1/auth/register`: per-IP 10/hour.
- `POST /api/v1/auth/token/refresh`: per-IP 30/15min (bounds replay-probing).

**Timing-oracle fixes (deterministic, no model):**
- **forgot-password (MA-04):** already fire-and-forget at the route (`auth.routes.ts:197`). Confirm the service `forgotPassword` does NOT `await` the notification send in a way that diverges found vs not-found timing. `auth.service.ts:377` — the found path awaits `resetRepo.insert` + `sendPasswordResetEmail`; not-found returns after 1 read. **Fix:** make the notification send fire-and-forget *inside* the service too, and add a constant-time floor (the route is already async-fire, but the response is sent before the service resolves — verify the route returns immediately and the service runs detached; it does at `:197`). Net: response time = ~1 DB read for both paths. **Confirm + add a test asserting timing parity.**
- **register (MA-15):** `auth.service.ts:122-134` — the unverified-existing path `await`s `sendVerificationEmail`, the verified-existing path does not. **Fix:** fire the verification re-issue send **fire-and-forget** (drop the `await`, `.catch(log)`). Response time then = ~1 argon2 hash + 1 DB read for all paths.

### AC-4 — Brand schema + service guards (HIGH) — Track B-4

- **`BrandRepository`** (`repositories.ts:445`): add `currency_code`, `timezone`, `revenue_definition` to every SELECT/INSERT/RETURNING column list and to `mapRow` (`:544`). **`mapRow` column-absent survival (MA-08):** use `row.currency_code ?? 'INR'`, `row.timezone ?? 'Asia/Kolkata'`, `row.revenue_definition ?? 'realized'` so a backend deployed against a pre-migration DB (deploy-window race) does not throw. `insert()` accepts the 3 new fields (defaulted).
- **`Brand` entity** (`domain/brand/entities.ts`): add the 3 typed fields (`currencyCode: 'INR'|'AED'|'SAR'`, `timezone`, `revenueDefinition: 'realized'|'delivered'`).
- **`brand.service.create`** (`brand.service.ts:29`): accept `currencyCode`/`timezone`/`revenueDefinition`; **derive `region_code` from `currency_code`** (INR→IN, AED→AE, SAR→SA) — no separate region field. Pass through to repo.
- **`currency_code` immutability guard (MA-11)** in `brand.service.update` (`:137`): before permitting a `currencyCode` change, `SELECT 1 FROM realized_revenue_ledger WHERE brand_id = $1 LIMIT 1` (table may not exist yet in M1 — wrap in a try/catch on `42P01 undefined_table` → treat as "no ledger rows, allow"). If any ledger row exists → `BrandError('CURRENCY_LOCKED', 'Currency cannot be changed after financial data has been recorded.', 409)`. Document the guard in this plan's invariant note + add a one-line note to `TRIGGER-SURFACES.md` (architect follow-up, non-blocking). **For M1, `revenue_definition` and `timezone` are mutable; only `currency_code` is gated.**

### AC-5 / AC-9 — onboarding_status threading + BFF contract (HIGH) — Track B-5

**The new BFF session contract (BINDING — this is the cross-track interface, §6):** every BFF session response replaces `needs_onboarding: boolean` with `onboarding_status: 'pending'|'org_created'|'brand_created'|'integration_selected'|'complete'|null` (null = no org membership at all → frontend sends to `/workspace/new`).

Affected responses (remove `needs_onboarding` at each):
- `POST /api/v1/bff/session` (login) — `bff.routes.ts:166`.
- `POST /api/v1/bff/session/refresh` — `bff.routes.ts:202`.
- `POST /api/v1/bff/session/set-org` (NEW — AC-8).
- Workspace-create + brand-create responses (advance + return status).

**Advance writes** (the BFF/service handler that performs each step sets the status, under `ctx.workspaceId` RLS):
- Workspace create → `UPDATE organization SET onboarding_status='org_created', onboarding_step=1 WHERE id=$org AND onboarding_status='pending'` (idempotent guard — only advances forward).
- Brand create (`brand.service.create`) → `→ 'brand_created', step=2` (forward-only).
- Integration select OR skip → `→ 'integration_selected', step=3`. **New endpoint** `POST /api/v1/bff/session/onboarding/advance` body `{ to: 'integration_selected'|'complete' }` (forward-only CHECK in SQL: `WHERE onboarding_step < $newStep`). Step 3 "Skip For Now" and Step 4 "Done" both call it. This is the ONLY new wizard backend route (Step 3 connector install reuses the existing Shopify install endpoint — no new route).
- Done ack → `→ 'complete', step=4`.

`resolveActiveContext` (`auth.service.ts:320`) gains an `onboardingStatus` read: when resolving a context, also `SELECT onboarding_status FROM organization WHERE id = <workspaceId>` and return it in `ActiveContext`. The BFF handlers surface `context.onboardingStatus`.

### AC-6 backend — none. Step 3/4 are frontend-only (reuse Shopify install). The only backend touch is the `onboarding/advance` endpoint above.

### AC-7 — acceptInvite hardening (HIGH) — Track B-6

`invite.service.ts:acceptInvite` (`:121`):
- **email-match (MA-07):** when `acceptingUserId` supplied → `const u = await userRepo.findById(acceptingUserId, ctx)`; if `u.emailNormalized !== inviteRow.email.toLowerCase()` → `InviteError('EMAIL_MISMATCH', ..., 403)`. **Move `markAccepted` to AFTER all guards pass** (currently it marks accepted at `:167` before resolving the user — a guard failure would consume the invite; reorder so the invite is only marked accepted once membership is granted, inside one txn).
- **email-verified:** when found-by-email (`acceptingUserId` null, `:173`) → if `existingUser.emailVerifiedAt === null` → `InviteError('USER_UNVERIFIED', ..., 403)`.
- **Transaction:** wrap markAccepted + membership insert + audit in one txn (atomicity — an accepted invite always has a membership).
- **Register-with-pending-invite (AC-7):** in `register()`, after creating/finding the user, check for a pending invite for that email; if one exists, return `{ code: 'INVITE_PENDING' }` in the register response so the frontend redirects to accept. (Lookup is a single indexed query; keep it after the timing-equalized hash.)
- DEFERRED (MA-07 item 3): making invite-accept a fully authenticated route — email-match guard is sufficient for M1.

### AC-8 — set-org + member-route org scoping (HIGH) — Track B-7

- **`POST /api/v1/bff/session/set-org`** (NEW, `bff.routes.ts`, `bffProtectedPreHandler`): body `{ organization_id }`. (1) verify `membership` exists for `auth.userId` in that org (via `MembershipRepository.findByUserAndOrg(userId, orgId, null, ctx)`), else 403; (2) `resolveActiveContext` for the selected org (resolve the user's brand/role within it); (3) re-mint the session cookie (same `jti`, new context — reuse the `refreshSession` cookie-set pattern at `bff.routes.ts:192`); (4) return `{ onboarding_status, auth }`. Org choice comes from **server re-verification**, never a client claim override (MA-13/MA-06).
- **Member-route org guard (MA-06):** `member.routes.ts` `GET /members` (`:123`), `PATCH /members/:id/role` (`:172`), `DELETE /members/:id` (`:215`): if a client supplies `organization_id` (query) AND it `!== auth.workspaceId` → **403 immediately** (before service call). Replace the `query.organization_id ?? auth.workspaceId` fallback with: use `auth.workspaceId` as the source of truth; if `query.organization_id` is present and differs → 403. The org switch is done via `set-org` (which re-mints the JWT), never a per-request param.

### AC-9 — CSRF consolidation (MED) — Track B-8

**Decision: the `main.ts` onRequest hook (`:178-223`) is the SINGLE authoritative CSRF check** (it is session-bound: HMAC(cookieSecret, jti), `csrf.ts:35`). **Remove the weaker duplicate** from `bffProtectedPreHandler` (`bff.routes.ts:105-116`, the `csrfCookie !== csrfHeader` equality check) — it is redundant and weaker (no jti-binding). The `main.ts` hook already fires app-wide on every cookie-authenticated mutation BEFORE the per-route preHandler, so removing the BFF duplicate leaves the strong check in force. Document at the removal site: `// CSRF is enforced once, session-bound, in the main.ts onRequest hook (SEC-0009-M02). Do not re-add a check here.` Add `/api/v1/auth/token/refresh` to the exempt list (token-authenticated, not cookie).

### AC-10 — Audit (folded into B-2/B-6) — Track B-2/B-6

`membership.removed`, `membership.role_changed`, `user.suspended` (already partially present — extend), plus `sessions.bulk_revoked {count, reason}` (ONE row per bulk op, with count — not per-session). All via the existing `@brain/audit` `AuditWriter`, inside the same txn as the mutation.

---

## 5. Frontend design — per-item (Track F-* — `@frontend-web-developer`)

### F-1 — onboarding_status router (AC-5/AC-9) — `login-form.tsx`, `create-brand-form.tsx`, client types

- Replace `result.needs_onboarding` branch (`login-form.tsx:32`) with a **deterministic lookup table** keyed by `onboarding_status`:
  ```ts
  const ONBOARDING_RESUME: Record<string, string> = {
    pending: '/workspace/new', org_created: '/brand/new',
    brand_created: '/onboarding/integrations', integration_selected: '/onboarding/done',
    complete: '/dashboard',
  };
  router.push(result.onboarding_status == null ? '/workspace/new' : ONBOARDING_RESUME[result.onboarding_status] ?? '/dashboard');
  ```
- Update `lib/api/client.ts` + `lib/api/types.ts`: `SessionResponse`/`SessionRefreshResponse` carry `onboarding_status` (string|null), drop `needs_onboarding`. `create-brand-form.tsx:48-53`: after `sessionApi.refresh()`, route by the returned `onboarding_status` (`brand_created` → `/onboarding/integrations`), NOT hard `/dashboard`.

### F-2 — 4-step wizard (AC-6) — `(onboarding)/` route group

- **Step labels:** `Step 1 of 4` (workspace/new), `Step 2 of 4` (brand/new), `Step 3 of 4` (integrations), `Step 4 of 4` (done). Update `(onboarding)/layout.tsx` header comment (currently says "/invite").
- **Step 2 brand form** (`create-brand-form.tsx`): add `currency_code` (select INR/AED/SAR), `timezone` (select Asia/Kolkata|Dubai|Riyadh), `revenue_definition` (select Realized|Delivered — **NO "Placed" option**, MA-12). `region_code` derived server-side — remove the hardcoded `region_code:'IN'` from the request (or keep but server overrides from currency).
- **Step 3 NEW page** `(onboarding)/integrations/page.tsx`: reuse the existing connector list / Shopify install endpoint. Shopify = connect-now button; Meta Ads + Google Ads = disabled "coming soon". **"Skip For Now"** → call `POST /bff/session/onboarding/advance {to:'integration_selected'}` → zero-connection finish → Step 4 (guided empty state messaging). Connect-now also advances on success.
- **Step 4 NEW page** `(onboarding)/done/page.tsx`: summary + "Go to dashboard" → call `advance {to:'complete'}` → `router.push('/dashboard')`.
- **Ghost step removal (MA-10):** DELETE `apps/web/app/(onboarding)/invite/page.tsx`. `components/onboarding/invite-team-form.tsx` is deprecated in the wizard context (do NOT adapt it; may live elsewhere for team-management later). Do not edit the invite page — delete it.
- **Pixel NOT in wizard** — stays in settings; remains a post-onboarding checklist item in the dashboard onboarding-progress widget only.

### F-3 — multi-org picker (AC-8) — new `(onboarding)/select-org` or login-flow screen

After login, if the response indicates >1 org membership, show an org-picker; selection calls `POST /bff/session/set-org {organization_id}`, then routes by the returned `onboarding_status` via the F-1 table. One org → proceed as today; zero → `/workspace/new`. (The login/me response must expose the membership-count or org list; backend B-7 returns it or the frontend calls workspace list — builder picks the lighter contract; document in §6.)

### F-4 — invite-accept + register UX (AC-7) — `register-form.tsx`, invite-accept page

- On register response `{ code:'INVITE_PENDING' }` → redirect to the invite-accept route.
- On `EMAIL_MISMATCH` / `USER_UNVERIFIED` from accept → show the specific guided message ("This invite was sent to a different email" / "Verify your email first").
- Duplicate verified email on register (timing-safe 2xx): show "An account with this email exists. Sign in or reset your password."

---

## 6. Cross-track contract (BINDING — both tracks build to THIS; no collision)

**Backend owns these shapes; frontend consumes them. Frozen here.**

```ts
// onboarding_status enum (string union) — authoritative for routing
type OnboardingStatus = 'pending'|'org_created'|'brand_created'|'integration_selected'|'complete';

// BFF session responses (login, session/refresh, set-org) — onboarding_status REPLACES needs_onboarding
interface BffSessionResponse {
  request_id: string;
  user?: { id: string; email: string; email_verified: boolean };
  expires_in?: number;
  onboarding_status: OnboardingStatus | null;   // null = no org membership
  auth: { brand_id: string|null; workspace_id: string|null; role: string|null };
}

// NEW endpoints
POST /api/v1/auth/token/refresh        { refresh_token } -> { access_token, refresh_token, expires_in } | 401 {INVALID_TOKEN|SESSION_REVOKED|SESSION_CONFLICT}
POST /api/v1/bff/session/set-org       { organization_id } -> BffSessionResponse | 403
POST /api/v1/bff/session/onboarding/advance { to: 'integration_selected'|'complete' } -> { onboarding_status }

// member routes: organization_id (query) MUST equal auth.workspaceId or 403 (no behavioral change for FE that omits it)
// brand create request gains: currency_code, timezone, revenue_definition (region_code derived server-side)
```

Frontend may begin F-1/F-2/F-3/F-4 against these stubs immediately; backend delivers B-5/B-7 to match. The only true sequencing dependency: F-3's org-list source (B-7 decides whether set-org or workspace-list provides it) — resolve in the first sync, default to existing `workspaceApi.list`.

---

## 7. Deploy-pipeline track (REQUIRED — folded into the slice) — Track DEPLOY — `@backend-developer`

Changes the `core` and `web` deployables (no new service — modular monolith, M1 ADR-001). Per the deploy invariant, the pipeline step ships **in this slice**:
- **core (Tracks B-*):** GitHub Actions → ECR (affected-only build, `turbo --affected`) → Helm bump → ArgoCD app `core` sync → health-probe bake → **auto-rollback on K8s probe failure** (M1 ADR-010; canary/percentage = Phase-4-deferred per STACK.md — ship probe-based auto-rollback + `packages/feature-flags` per-brand kill-switch).
- **web (Tracks F-*):** same pipeline for the `web` ArgoCD app.
- **Migration gate (pre-deploy Argo job):** `pnpm migrate up` runs `0010→0011→0012` against the target env BEFORE the core deploy; a failed/irreversible migration blocks the deploy.
- **Deploy ORDER (MA-08, BINDING):** `migrate (0010,0011,0012)` → `core` → `web`. Backend `mapRow` is column-absent-defensive so a migrate↔core ordering slip is non-fatal; web last so it never references an unshipped contract field. **Down-window note:** `0010`/`0011`/`0012` `migrate:down` is only safe before any brand sets a non-default currency / any org advances past `pending`; the runbook gates `down` to the deploy window.

---

## 8. Test strategy (high_stakes — mutation tests on all auth paths)

- **AC-1 (CRITICAL):** unit + integration on rotation: happy rotation; **concurrent double-refresh** (two clients, same token, FOR UPDATE → one rotates, other gets `SESSION_CONFLICT`/`SESSION_REVOKED`, never 500); **replay** (consumed token re-presented → family-wipe, all family sessions revoked, 401 SESSION_REVOKED); expired token → 401. **Real-network smoke:** hit `/api/v1/auth/token/refresh` against a running core+Postgres, assert old refresh token is dead after rotation.
- **AC-2 (CRITICAL):** removeMember/updateMemberRole revoke target sessions **in the same txn** (assert: roll back the membership write → revocation also rolled back); a removed member's access token 401s on the next request (`validateSession` sees `revoked_at`). scope=all logout kills all sessions.
- **AC-3:** rate-limit trips at the 6th failed login; Redis-down → fail-open (login still succeeds); forgot/register timing parity test (found vs not-found within tolerance).
- **AC-7:** EMAIL_MISMATCH (wrong user accepts), USER_UNVERIFIED (unverified accept), invite-only marked accepted after membership granted (txn).
- **Isolation (NN-6 fuzz, every new column/table):** cross-brand read of `currency_code` → 0 rows; cross-workspace read of `onboarding_status` → 0 rows; cross-user `user_session` family-wipe cannot touch another user → asserted.
- **Frontend:** every `onboarding_status` enum value + null maps to a route (table-coverage test); ghost `/invite` route returns 404 after deletion.
- **Observability:** every new endpoint emits a correlation-id span; rate-limit-tripped and bulk-revoke counters are metrics. Audit rows asserted for AC-10 actions.

---

## 9. Alternatives considered + rejected

- **MA-09 Option B (status on `brand`)** — REJECTED: no `brand_id` exists at Step 1 (org-create precedes brand), forcing a NULL-limbo that recreates the `needs_onboarding` ambiguity; multi-brand UX is post-M1 and routes via the dashboard widget, not the wizard.
- **MA-12 include `placed`** — REJECTED: no `placed_revenue` metric in METRICS.md (grep-confirmed); MER is "never placed/gross"; would ship a phantom uncomputable setting. (Would have forced NEEDS-STAKEHOLDER for a Canon amendment — avoided by excluding.)
- **Generic rate-limit middleware framework** — REJECTED (over-engineering): a single targeted `RateLimiter.check()` for 4 routes is smaller and sufficient.
- **Per-session audit rows on bulk revoke** — REJECTED: one `sessions.bulk_revoked {count}` row is the AC-10 minimum and avoids audit-log fan-out.
- **Redis-backed session store** — REJECTED/DEFERRED (in the confirmed deferred list): Postgres `user_session` is the SoR; rotation/revocation are Postgres txns.

---

## 10. Cost estimate

- **Model spend:** $0/mo, 0 tokens/day (Tier 1, no model calls anywhere).
- **Infra delta:** +1 Redis client connection in `core` (Redis already provisioned, ADR-004); 3 additive migrations (catalog-only, no rewrite); ~negligible storage (5 columns + lineage cols on existing tables). No new pods, no new topic, no new datastore.

---

## 11. Build tracks summary

| Track | Owner | Items |
|---|---|---|
| B-MIG | @backend-developer | `0010_brand_locale`, `0011_onboarding_state`, `0012_session_rotation_lineage` (up+down, NN-1 negative-control notes) |
| B-1 | @backend-developer | AC-1 `/auth/token/refresh` rotation + FOR UPDATE + family-wipe + SESSION_CONFLICT |
| B-2 | @backend-developer | AC-2 bulk revocation methods + removeMember/updateMemberRole/suspend/scope=all-logout txn wiring + AC-10 audit |
| B-3 | @backend-developer | AC-3 ioredis client + RateLimiter (fail-open) + 4 route caps + forgot/register timing fixes |
| B-4 | @backend-developer | AC-4 brand cols in repo/entity/service + region derivation + currency-immutability guard |
| B-5 | @backend-developer | AC-5/AC-9 onboarding_status threading + BFF contract (drop needs_onboarding) + advance endpoint + resolveActiveContext |
| B-6 | @backend-developer | AC-7 acceptInvite email-match/verified + register INVITE_PENDING + txn |
| B-7 | @backend-developer | AC-8 set-org endpoint + member-route org_id 403 guard |
| B-8 | @backend-developer | AC-9 CSRF consolidation (remove BFF duplicate; main.ts authoritative) + refresh-route exempt |
| DEPLOY | @backend-developer | migrate gate + core/web pipeline (affected build, probe auto-rollback), deploy order |
| F-1 | @frontend-web-developer | onboarding_status lookup-table router (login-form, create-brand-form, client types) |
| F-2 | @frontend-web-developer | 4-step wizard (Step labels, brand locale fields, Step 3 integrations, Step 4 done, DELETE ghost invite) |
| F-3 | @frontend-web-developer | multi-org picker → set-org |
| F-4 | @frontend-web-developer | invite-accept guard UX + register duplicate/INVITE_PENDING UX |

---

## 12. Acceptance contract (every persona must-fix is a REQUIRED pass-1 item)

Builders MUST pass ALL of these on pass 1 (each folds in a persona must-fix — no rework bounce):

- [ ] **MA-01/AC-1:** `/auth/token/refresh` exists; rotation under `SELECT FOR UPDATE`; replay→family-wipe→401 SESSION_REVOKED; jti-conflict→401 SESSION_CONFLICT (not 500); sha256 hash stored, never raw.
- [ ] **MA-02/AC-2:** removeMember + updateMemberRole (ALL role changes) revoke target sessions **in the same txn before returning**; `revokeAllForUser(AndBrand)` exist; scope=all logout; suspend path revokes.
- [ ] **MA-03:** concurrent refresh test green (no 500, no jti-unique crash).
- [ ] **MA-04/AC-3:** rate limits on login/bff-session/forgot/register/refresh; **fail-open** on Redis down; forgot+register timing parity (fire-and-forget).
- [ ] **MA-05/AC-5:** `needs_onboarding` boolean REMOVED from every BFF response; `onboarding_status` enum returned; frontend router = lookup table covering all enum values + null.
- [ ] **MA-06/AC-8:** member routes 403 on `organization_id != auth.workspaceId`; org switch only via set-org (server re-verified).
- [ ] **MA-07/AC-7:** acceptInvite email-match + email-verified guards; invite marked accepted only after membership granted (txn).
- [ ] **MA-08/AC-4:** deploy order migrate→core→web documented + in pipeline; `mapRow` column-absent-defensive `??`; down migration present.
- [ ] **MA-09:** onboarding_status on `organization`, Option A, M1-first-brand comment at every advance site.
- [ ] **MA-10/AC-6:** `(onboarding)/invite/page.tsx` DELETED; new Step 3 at `/onboarding/integrations`; step labels "of 4".
- [ ] **MA-11/AC-4:** currency_code immutability guard (409 CURRENCY_LOCKED if ledger rows exist).
- [ ] **MA-12/AC-4:** revenue_definition CHECK = `('realized','delivered')`; **no `placed`** in constraint or form.
- [ ] **MA-13/AC-8:** set-org re-mints cookie + returns onboarding_status enum.
- [ ] **MA-14/AC-9:** ONE CSRF check (main.ts authoritative); BFF duplicate removed.
- [ ] **MA-15/AC-7:** register verification re-issue fire-and-forget (timing-safe).
- [ ] **MA-16/AC-1:** replay-after-logout → family-wipe (covered by MA-01 item).
- [ ] Migrations 0010/0011/0012 each have up+down + NN-1 negative-control note; isolation-fuzz extended to new columns.
- [ ] Branch from latest `feat/onboarding-session-context`; renumber migrations if 0010 collides.

---

**Net:** 2/2 CRITICAL closed in design (B-1, B-2). All 6 HIGH + 5 MED folded into tracks + the acceptance contract. Tier-1 deterministic; $0 model spend. No Canon amendment. ADVANCE → Stage 3, both builders in parallel against the §6 contract.
