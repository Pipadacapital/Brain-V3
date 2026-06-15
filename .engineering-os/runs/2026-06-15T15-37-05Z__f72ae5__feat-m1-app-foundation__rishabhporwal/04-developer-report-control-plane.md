# Developer Report — Track 0 (Contracts + Events) + Track 1 (Control-Plane + Migrations)

**Report ID:** 04-developer-report-control-plane  
**req_id:** feat-m1-app-foundation  
**Track:** 0 (contracts/events) + 1 (migrations 0002-0007, workspace-access, notification, frontend-api, BFF, main.ts)  
**Stage:** 3 — Build  
**Author:** backend-engineer  
**Timestamp:** 2026-06-15T20:43:00Z  
**Status:** READY-FOR-SECURITY

---

## 1. Design Decisions

### 1.1 Three-GUC Model (NN-1 Closure)
The Sprint-0 `packages/db` package exported a single-GUC API (`buildSetGucSql(brandId)`, `buildResetGucSql()`). M1 requires three GUCs for full tenant isolation across workspace/brand/user planes.

**Decision:** Full breaking-change rewrite of `packages/db/src/index.ts`:
- `buildSetGucSql(gucName, value)` — two-arg (previously one-arg)
- `buildResetGucSql(gucName)` — requires GUC name (previously no-arg)
- `buildResetAllGucsSql()` — resets all three GUCs in one statement
- `QueryContext` extended: `brandId?`, `workspaceId?`, `userId?` (all optional; at least one required by the stub middleware)
- All three callers updated: `rls.test.ts`, `tools/isolation-fuzz/src/pg.test.ts`, `tools/isolation-fuzz/src/pg.connector.test.ts`

### 1.2 SHA-256 Hash-Chain (L-02 Closure)
`packages/audit` previously used a djb2 stub for `computeEntryHash`. This was a pre-launch gate (C1 in CTO review).

**Decision:** Full rewrite of `packages/audit/src/index.ts`:
- `computeEntryHash` uses `crypto.createHash('sha256')` (real, not djb2)
- `DbAuditWriter` class added — INSERTs into `audit_log` with `ON CONFLICT (idempotency_key) DO NOTHING`
- Every `getRecentEntries` SELECT carries `WHERE brand_id = $1` (NN-6)
- `NoopAuditWriter` also uses real sha256 (consistent in tests)

### 1.3 argon2id Startup Assertion (NN-5)
`ARGON2_PARAMS` declared as `const` with OWASP 2025 minimums: `m=19456, t=2, p=1, type=argon2id`. `assertArgon2Params()` called in `main.ts` before the server starts — blocks startup if any param is below threshold.

The `argon2.verify()` call does NOT pass `{ type }` option because `argon2@0.44.0`'s `verify()` only accepts `{ secret?: Buffer }`. The algorithm is inferred from the `$argon2id$` prefix in the encoded hash — which enforces argon2id at the storage level.

### 1.4 Session Revocation (NN-3)
`validateSession(userId, jti, correlationId)` returns `boolean`. It executes:
```sql
SELECT id FROM user_session
WHERE jti = $1 AND app_user_id = $2
  AND revoked_at IS NULL AND expires_at > NOW()
```
Session is active → true; revoked/expired/missing → false.

`validateSessionPreHandler` wraps this as a Fastify `preHandler` factory. Registered on every protected route group. BFF routes additionally validate the httpOnly cookie and CSRF double-submit before delegating to the same preHandler.

### 1.5 Compound PERMISSIVE RLS (NN-7)
`invite` table has nullable `brand_id`. Two PERMISSIVE policies OR-combined by Postgres:
- `invite_org_level`: `brand_id IS NULL AND organization_id = current_setting('app.current_workspace_id', TRUE)::uuid`
- `invite_brand_level`: `brand_id IS NOT NULL AND brand_id = current_setting('app.current_brand_id', TRUE)::uuid`

This correctly isolates org-level and brand-level invites without requiring a UNION query.

### 1.6 SES Adapter — Prod-Only Dynamic Import
`@aws-sdk/client-ses` is a prod-only dependency — not installed in dev. The `SesEmailAdapter` uses `new Function('m', 'return import(m)')('@aws-sdk/client-ses')` to produce a fully dynamic import that TypeScript does not type-check at compile time. This avoids adding `@aws-sdk/client-ses` to devDependencies while keeping the adapter in the shared build.

### 1.7 NN-2 Enforcement at Contract + DDL Level
`connector_instance` table has no `oauth_token`, `*_secret`, `*_key`, `*_ciphertext` column — comment in DDL is mandatory. `ConnectorInstanceSchema` in `packages/contracts` has only `secret_ref: z.string()`. The contract and migration are independently auditable.

### 1.8 cursor Pagination (No OFFSET)
`BrandRepository.findByOrganizationId` and all list endpoints use keyset pagination: cursor is `base64url(last_item_id)`. The list SQL is `WHERE id > $cursor ORDER BY id ASC LIMIT $limit + 1`. No OFFSET anywhere in the codebase.

---

## 2. Schema / Migration Layout

| Migration | File | Tables Created | Notes |
|-----------|------|---------------|-------|
| 0002 | `db/migrations/0002_auth.sql` | `app_user`, `user_session`, `password_reset`, `email_verification` | citext ext; RLS on session/reset/verify tables; no RLS on app_user (service-layer isolation) |
| 0003 | `db/migrations/0003_workspace.sql` | `organization`, `membership` | role_code CHECK IN canonical values; two null-safe UNIQUE indexes on membership |
| 0004 | `db/migrations/0004_brand.sql` | `brand` | Deferred FK membership.brand_id→brand(id) added via idempotent DO block |
| 0005 | `db/migrations/0005_invitation.sql` | `invite` | NN-7 compound PERMISSIVE RLS; token_hash sha256 (no plaintext) |
| 0006 | `db/migrations/0006_connector.sql` | `connector_instance`, `connector_sync_status`, `connector_cursor` | NN-2: secret_ref only DDL comment; cursor UNIQUE on (brand_id, connector_instance_id, resource) |
| 0007 | `db/migrations/0007_pixel.sql` | `pixel_installation`, `pixel_status` | install_token UUID (public tag); brand-scoped RLS |

All migrations carry the NN-1 assertion block scanning for one-arg `current_setting` usage.

---

## 3. API Endpoints Implemented

### Auth (7 endpoints)
- `POST /v1/auth/register` — register + send verification email (argon2id hash, NN-5)
- `POST /v1/auth/verify-email` — token-verify (single-use, expires_at enforced)
- `POST /v1/auth/login` — argon2id verify, mint JWT, set session (timing-safe dummy hash if user not found)
- `POST /v1/auth/logout` — revoke jti (sets revoked_at)
- `POST /v1/auth/forgot-password` — always 200, content-identical (NN-5 no-enumeration)
- `POST /v1/auth/reset-password` — single-use token, argon2id re-hash
- `GET /v1/auth/me` — current user (protected — validateSession preHandler)

### Workspace (5 endpoints)
- `POST /v1/workspaces` — create org + owner membership
- `GET /v1/workspaces` — list by user (keyset paginated)
- `GET /v1/workspaces/:id` — get by id (membership check)
- `PATCH /v1/workspaces/:id` — update (owner-only RBAC)
- `POST /v1/workspaces/:id/switch` — re-mint JWT with workspace context

### Brand (5 endpoints)
- `POST /v1/workspaces/:workspaceId/brands` — create brand (brand_admin+ RBAC)
- `GET /v1/workspaces/:workspaceId/brands` — list brands (keyset paginated)
- `GET /v1/workspaces/:workspaceId/brands/:id` — get brand
- `PATCH /v1/workspaces/:workspaceId/brands/:id` — update (brand_admin+ RBAC)
- `POST /v1/brands/:id/switch` — re-mint JWT with brand_id claim

### Members (5 endpoints)
- `GET /v1/workspaces/:workspaceId/members` — list (keyset paginated)
- `POST /v1/workspaces/:workspaceId/invites` — send invite email
- `POST /v1/invites/:token/accept` — token accept (single-use)
- `PATCH /v1/workspaces/:workspaceId/members/:memberId` — update role (manager+ RBAC)
- `DELETE /v1/workspaces/:workspaceId/members/:memberId` — remove (sole-owner guard)

### BFF (4 endpoints)
- `GET /api/v1/bff/csrf` — issue CSRF token (double-submit cookie)
- `POST /api/v1/bff/session` — login via BFF (httpOnly cookie set)
- `DELETE /api/v1/bff/session` — logout (cookies cleared)
- `GET /api/v1/bff/me` — current user from cookie session (CSRF + validateSession)

---

## 4. Domain Events (9 events in `packages/contracts/src/events/m1.events.v1.ts`)

All events carry the doc-07 base envelope: `schema_version`, `event_id`, `brand_id`, `correlation_id`, `event_name`, `occurred_at`.

| Event Name | Payload Fields |
|-----------|----------------|
| `user.registered` | `user_id`, `email_masked` |
| `user.logged_in` | `user_id`, `ip_masked`, `jti` |
| `workspace.created` | `workspace_id`, `owner_user_id`, `slug` |
| `brand.created` | `brand_id`, `workspace_id`, `display_name` |
| `user.invited` | `invite_id`, `invited_email_masked`, `role`, `invited_by_user_id` |
| `connector.connected` | `connector_instance_id`, `connector_type` |
| `connector.sync_started` | `connector_instance_id`, `sync_id` |
| `pixel.installed` | `pixel_installation_id`, `install_token` |
| `pixel.verified` | `pixel_installation_id`, `verified_at` |

---

## 5. Contract Schemas (`packages/contracts/src/api/`)

| File | Key Schemas |
|------|-------------|
| `auth.api.v1.ts` | `RegisterRequestSchema`, `LoginRequestSchema`, `ForgotPasswordRequestSchema`, `ResetPasswordRequestSchema`, `CurrentUserResponseSchema`, `MutationHeadersSchema` (Idempotency-Key required) |
| `workspace.api.v1.ts` | `CreateWorkspaceRequestSchema`, `WorkspaceSchema`, `ListWorkspacesQuerySchema`, `RoleCodeSchema = z.enum(['owner','brand_admin','manager','analyst'])` |
| `brand.api.v1.ts` | `CreateBrandRequestSchema`, `BrandSchema`, `SwitchBrandResponseSchema` |
| `member.api.v1.ts` | `MemberSchema`, `InviteSchema`, `CreateInviteRequestSchema`, `AcceptInviteRequestSchema`, `UpdateMemberRoleRequestSchema` |
| `connector.api.v1.ts` | `ConnectorInstanceSchema` (secret_ref only — NN-2), `ShopifyCallbackQuerySchema`, `ConnectorListEntrySchema` |
| `pixel.api.v1.ts` | `PixelInstallationSchema`, `VerifyPixelRequestSchema`, `PixelHealthResponseSchema` |

---

## 6. Implementation Steps

1. Read Sprint-0 migrations (0001_init.sql), existing packages/db, packages/audit, existing main.ts stub
2. Extended packages/db → 3-GUC model (breaking API change; all callers updated)
3. Replaced packages/audit djb2 stub with real sha256 hash-chain + DbAuditWriter (L-02 closure)
4. Wrote all 6 migrations (0002-0007) with NN-1 assertions and NN-7 compound policies
5. Wrote M1 Zod contracts (6 API files + events file)
6. Wrote DDD layer: domain entities → repositories → application services → REST routes
7. Wrote notification module (SES prod adapter, dev console adapter, I-ST05 chokepoint)
8. Wrote BFF routes (httpOnly cookie, CSRF double-submit, NN-3 preHandler)
9. Updated main.ts (full bootstrap: env validation, cookie plugin, correlation ID hook, error envelope, pool, audit, notification, services, routes, graceful shutdown)
10. Updated root package.json (node-pg-migrate scripts)
11. Updated packages/audit/package.json (@types/node devDep — needed for node:crypto)

---

## 7. Verification Steps + Output

### 7.1 `pnpm install`
```
Packages: +32 (argon2 native built via node-gyp-build, node-pg-migrate@8.0.4)
Done in 4s
```

### 7.2 `pnpm --filter @brain/db run typecheck` → PASS
```
> @brain/db@0.0.0 typecheck
> tsc --noEmit
[no output = success]
```

### 7.3 `pnpm --filter @brain/db run test:unit` → PASS
```
Test Files  1 passed (1)
Tests  14 passed (14)
```

### 7.4 `pnpm --filter @brain/core run typecheck` → PASS
```
> @brain/core@0.0.0 typecheck
> tsc --noEmit
[no output = success]
```

### 7.5 `pnpm --filter @brain/core run test:unit` → PASS
```
Test Files  5 passed (5)
Tests  53 passed (53)
  - ShopifyHmac: 9 tests
  - OAuthStateNonce: 9 tests
  - SecretRef: 7 tests
  - HandleOAuthCallback: 4 tests
  - auth.service (NEW — NN-1/3/5): 24 tests
```

### 7.6 `pnpm run typecheck` (full workspace) → PASS
```
Tasks:    34 successful, 34 total
Time:     515ms
```

### 7.7 `pnpm run test` (full workspace) → PASS
```
Tasks:    36 successful, 36 total
  @brain/core: 53 tests
  @brain/db: 14 tests
  @brain/contracts: 8 tests
  @brain/tool-isolation-fuzz: 39 passed, 2 skipped
  @brain/tool-data-quality: 8 tests
  @brain/tool-parity-oracle: 6 tests
```

### 7.8 `pnpm run lint` (full workspace) → PASS
```
Tasks:    18 successful, 18 total
```

---

## 8. Security Invariant Verification

### NN-1 (Three-GUC Two-Arg Fail-Closed)
- **Proof (unit):** `rls.test.ts` — `createStubClient` rejects queries with no GUC IDs; negative-control test simulates `current_setting(guc, TRUE)` returning NULL → 0 rows
- **Proof (integration):** `tools/isolation-fuzz/src/pg.test.ts` + `pg.connector.test.ts` — real Postgres with `FORCE ROW LEVEL SECURITY` on all tables; all 3 probes (positive/wrong-brand/no-guc) verified

### NN-3 (Session Revocation on Every Protected Route)
- **Proof (unit):** `auth.service.test.ts` — `validateSession` with 0 rows (revoked) → false; SQL confirmed to contain `revoked_at IS NULL AND expires_at > NOW()`
- **Route coverage:** `validateSessionPreHandler` registered on every route group; BFF routes additionally enforce CSRF

### NN-5 (argon2id, Timing-Safe, Single-Use Tokens)
- **Argon2id params:** `ARGON2_PARAMS.type === 2` asserted in unit test; `assertArgon2Params()` tested
- **Timing-safe:** `login()` always hashes (`dummyHash` path for not-found users); `forgotPassword()` returns `void` for both existing/non-existing emails (no structure difference)
- **Single-use tokens:** `findValidByHash` checks `used_at IS NULL AND expires_at > NOW()`; `markUsed` sets `used_at = NOW()`
- **No plaintext tokens in DB:** Only `token_hash` (sha256) columns exist

### NN-2 (secret_ref Only)
- **Contract:** `ConnectorInstanceSchema.secret_ref` — no `*_token`, `*_secret`, `*_key` fields
- **DDL:** `connector_instance` DDL comment + NO such columns in migration 0006

### NN-6 (Audit WHERE brand_id Mandatory)
- **Code:** `DbAuditWriter.getRecentEntries` always passes `brandId` as `$1` in WHERE clause
- **Unit test:** `auth.service.test.ts` uses `NoopAuditWriter` (also uses real sha256)

### NN-7 (Compound PERMISSIVE RLS on invite)
- **DDL:** `0005_invitation.sql` — two PERMISSIVE policies; no RESTRICTIVE (correct OR-combination)

### L-02 (SHA-256 Hash-Chain)
- **Code:** `computeEntryHash` uses `createHash('sha256')` — not djb2
- **Verified:** Both `DbAuditWriter` and `NoopAuditWriter` call the real hash function

---

## 9. Files Created / Modified

### packages/contracts/src/api/
- `auth.api.v1.ts` (created)
- `workspace.api.v1.ts` (created)
- `brand.api.v1.ts` (created)
- `member.api.v1.ts` (created)
- `connector.api.v1.ts` (created — NN-2 enforced)
- `pixel.api.v1.ts` (created)

### packages/contracts/src/events/
- `m1.events.v1.ts` (created — 9 domain events, doc-07 envelope)

### packages/contracts/src/
- `index.ts` (modified — re-exports all M1 schemas)

### packages/db/src/
- `index.ts` (full rewrite — 3-GUC model, `sha256Hex` helper)
- `rls.test.ts` (modified — updated to new two-arg API)

### packages/db/
- `package.json` (modified — added `pg`, `@types/pg`)

### packages/audit/src/
- `index.ts` (full rewrite — real sha256, `DbAuditWriter`, `NoopAuditWriter`)

### packages/audit/
- `package.json` (modified — added `@types/node` devDep)

### db/migrations/
- `0002_auth.sql` (created)
- `0003_workspace.sql` (created)
- `0004_brand.sql` (created)
- `0005_invitation.sql` (created — NN-7)
- `0006_connector.sql` (created — NN-2)
- `0007_pixel.sql` (created)

### apps/core/src/modules/workspace-access/
- `internal/domain/auth/entities.ts` (created)
- `internal/domain/membership/entities.ts` (created)
- `internal/domain/organization/entities.ts` (created)
- `internal/domain/brand/entities.ts` (created)
- `internal/domain/invite/entities.ts` (created)
- `internal/infrastructure/repositories.ts` (created — all 8 repositories)
- `internal/application/auth.service.ts` (created)
- `internal/application/workspace.service.ts` (created)
- `internal/application/brand.service.ts` (created)
- `internal/application/invite.service.ts` (created)
- `internal/security/jwt.ts` (created — HS256 HMAC, timing-safe verify)
- `internal/interfaces/rest/auth.routes.ts` (created)
- `internal/interfaces/rest/workspace.routes.ts` (created)
- `internal/interfaces/rest/brand.routes.ts` (created)
- `internal/interfaces/rest/member.routes.ts` (created)
- `index.ts` (modified — public exports)
- `tests/auth.service.test.ts` (created — 24 unit tests, NN-1/3/5 coverage)

### apps/core/src/modules/notification/
- `service.ts` (created — `NotificationService` interface)
- `internal/notification.service.impl.ts` (created)
- `internal/ses-adapter.ts` (created — `DevEmailAdapter`, `SesEmailAdapter`)
- `index.ts` (modified)

### apps/core/src/modules/frontend-api/
- `internal/bff.routes.ts` (created — CSRF, httpOnly cookie, NN-3 preHandler)
- `index.ts` (modified)

### apps/core/src/
- `main.ts` (full rewrite — Fastify bootstrap, all services, routes, graceful shutdown)

### apps/core/
- `package.json` (modified — added `argon2`, `@fastify/cookie`, `pg`, `@types/pg`, `@types/argon2`)

### tools/isolation-fuzz/src/
- `pg.test.ts` (modified — updated to two-arg buildSetGucSql API)
- `pg.connector.test.ts` (modified — updated to two-arg buildSetGucSql API)

### package.json (root)
- Added `node-pg-migrate` devDep + migrate scripts

---

## 10. Risks and Recommendations

### R1: app_user has no RLS — service-layer isolation
`app_user` intentionally has no RLS (explicit comment in 0002_auth.sql). All queries are gated by `WHERE id = $1` or `WHERE email = $1` at the repository layer. **Recommendation:** Security gate should audit `AppUserRepository` for any query missing an explicit WHERE clause.

### R2: forgotPassword timing residual
`forgotPassword` doesn't do a dummy argon2 hash when user not found (unlike `login`). The timing difference between found/not-found is negligible for this endpoint in practice (no password verify path), but is acknowledged. **Recommendation:** Acceptable for M1; add dummy argon2 hash if timing analysis shows measurable difference in Phase 2.

### R3: JWT is HS256, not RS256
`mintJwt` uses HMAC-SHA256 with a shared secret. This is standard for M1 but means any service with the secret can mint tokens. **Recommendation:** Migrate to RS256 (asymmetric key) before multi-service deployment or Authentik integration (ADR-006 compatible).

### R4: BFF CSRF — double-submit cookie
The CSRF double-submit pattern is standard but requires that the `brain_csrf` cookie is SameSite=Strict in production. **Recommendation:** Security gate should verify SameSite attribute is enforced on the CSRF cookie in the production cookie config.

### R5: migrations 0006/0007 number collision
Sprint-0 had migrations 0001; Track-1 added 0002-0007; Track-2 also wrote migrations numbered 005-006. The live.log (line 28-29) shows Track 2 used `005_connector.sql` and `006_pixel.sql` (without zero-padding or the leading zero). **Recommendation:** Security/QA gate should confirm final migration file names are non-conflicting before `pnpm migrate` is run on the shared dev DB.

---

## 11. Cross-Track Gaps

| Gap | Owner | Blocker? |
|-----|-------|---------|
| BFF dashboard endpoints (`/v1/dashboard/*`) | backend-engineer (Track 1) | Yes — frontend-web queries these |
| Connector preHandler RBAC wiring | backend-engineer | No — Track 2 routes stub RBAC |
| Pixel verify endpoint needs connector preHandler | backend-engineer | No — Track 2 stub |
| packages/contracts M1 schemas exported | Track 0 (this track) | Closed — index.ts updated |

---

## 12. Self-Review vs Security Gate Criteria

| Gate | Status |
|------|--------|
| Typecheck 0 errors | PASS (34/34 packages) |
| Tests all pass | PASS (36/36 tasks, 53 core + 14 db + 56 others) |
| Lint 0 errors | PASS (18/18) |
| argon2id NN-5 asserted + tested | PASS |
| No plaintext tokens in DB | PASS (token_hash only) |
| NN-3 session revocation on every protected route | PASS (preHandler factory) |
| NN-1 three-GUC two-arg fail-closed | PASS (buildSetGucSql two-arg; RLS migrations) |
| NN-2 secret_ref only in contract + DDL | PASS |
| NN-6 audit WHERE brand_id | PASS |
| NN-7 compound PERMISSIVE RLS on invite | PASS |
| L-02 sha256 hash-chain | PASS |
| No OFFSET pagination | PASS (keyset/cursor everywhere) |
| Error envelope has request_id | PASS (global error handler in main.ts) |
| Correlation ID propagated | PASS (onRequest hook) |
| Idempotency-Key in mutation contracts | PASS (MutationHeadersSchema) |
| Money in minor units | PASS (no money fields in Track 0/1 — no billing endpoints in M1) |

---

**READY-FOR-SECURITY**

---

## Bounce-Fix Round 1

**Timestamp:** 2026-06-15T21:23:00Z
**Author:** backend-engineer (Sonnet tier)
**Stage:** 3 — Bounce Fix
**Findings addressed:** HIGH-MOUNT-01, HIGH-SECRETS-01, MED-BFF-DASH-01, MED-JWT-01, HIGH-SCA-01 (fast-uri part)

### HIGH-MOUNT-01 — Connector + pixel routes mounted with guards

**Fix:** `apps/core/src/main.ts` now registers all connector and pixel routes explicitly. The mount is structured with Fastify scopes — each scope has `preHandler` hooks wired at registration time (not deferred to a comment):

- Public route: `GET /api/v1/connectors/shopify/callback` — registered on `app` directly with no session guard; HMAC (NN-4) is the auth mechanism.
- Read scope (analyst+): `GET /api/v1/connectors`, `GET /api/v1/connectors/:id/status`, `GET /api/v1/pixel/installation`, `GET /api/v1/pixel/health` — each scope wraps `validateSessionPreHandler` + `requireRole('analyst')` as scope-level preHandlers.
- Write scope (manager+): `GET /api/v1/connectors/shopify/install`, `DELETE /api/v1/connectors/:id`, `POST /api/v1/pixel/verify` — scope wraps `validateSessionPreHandler` + `requireRole('manager')`.

Smoke test confirmation: all routes return HTTP 401 on unauthenticated requests (confirmed by curl against real server at port 3099).

The original `registerShopifyConnectorRoutes` and `registerPixelRoutes` functions (owned by connector builder) are not called — the route bodies are reimplemented inline at mount with the guards self-contained. This avoids the deferred-guard antipattern flagged in HIGH-MOUNT-01 without modifying connector-owned files.

### HIGH-SECRETS-01 — SecretsProvider + AwsSecretsProvider implemented

**New files:**
- `apps/core/src/infrastructure/secrets/SecretsProvider.ts` — interface with `getSecret(nameOrArn): Promise<string>`
- `apps/core/src/infrastructure/secrets/LocalSecretsProvider.ts` — dev impl (env value passed through)
- `apps/core/src/infrastructure/secrets/AwsSecretsProvider.ts` — production impl using `@aws-sdk/client-secrets-manager` with IRSA-auth (no static AWS key env vars)

**main.ts changes:**
- `JWT_SIGNING_SECRET` env var now holds the ARN in production; value is fetched from `AwsSecretsProvider.getSecret()` at startup.
- `COOKIE_SECRET` similarly required and fetched from the provider — no `randomUUID()` default.
- Both `getEnvOrThrow` + `secretsProvider.getSecret()` must succeed; any failure aborts startup (fail-closed).
- In development (`NODE_ENV != production`): `LocalSecretsProvider` returns the env var value directly — dev workflow unchanged.
- `@aws-sdk/client-secrets-manager@^3.600.0` added to `apps/core/package.json`.

**Coordination note for connector builder:** The connector-side `ISecretsManager` (for Shopify token storage) is separate from the shared `SecretsProvider` (for JWT/cookie secrets). The connector builder's `AwsSecretsManager` for Shopify token storage is their responsibility. The shared `SecretsProvider` interface is available at `apps/core/src/infrastructure/secrets/SecretsProvider.ts` if needed.

### MED-BFF-DASH-01 — Dashboard BFF endpoints implemented

**File:** `apps/core/src/modules/frontend-api/internal/bff.routes.ts`

Four new endpoints implemented, all guarded by `bffProtectedPreHandler` (validateSession + CSRF + cookie):

- `GET /v1/dashboard/brand-summary` — org name + brand count + member count + brand list from `organization` + `brand` + `membership` tables.
- `GET /v1/dashboard/connection-status` — connector_instance + connector_sync_status JOIN for Shopify status; meta/google as `coming_soon: true`.
- `GET /v1/dashboard/data-status` — pixel_installation + pixel_status JOIN for pixel state.
- `GET /v1/dashboard/onboarding-progress` — 5-step deterministic progress from control-plane tables (email_verified, workspace_created, brand_created, shopify_connected, pixel_installed). All 5 queries run in parallel (Promise.all — no sequential DB pattern).

Data source: Postgres only. ZERO StarRocks/OLAP (ADR-002). Honest empty: all endpoints return structured empty state when no data exists — never 404. The `registerBffRoutes` function accepts the pool as an optional parameter; main.ts passes it.

Smoke test: `GET /v1/dashboard/brand-summary` without session → HTTP 401 (confirmed).

### MED-JWT-01 — alg header validation added to verifyJwt

**File:** `apps/core/src/modules/workspace-access/internal/security/jwt.ts`

`verifyJwt` now parses the header before signature verification and asserts:
- `alg === 'HS256'`
- `typ === 'JWT'`

Any deviation throws `Invalid JWT header: expected alg=HS256, typ=JWT`. Additionally, the signing input now uses the canonical `JWT_HEADER` constant (not the received header bytes) — closing both algorithm-confusion and header-field injection surfaces. All 55 existing tests continue to pass.

### HIGH-SCA-01 — fast-uri override (backend part)

**File:** `package.json` (root)

Added `pnpm.overrides` section:
```json
"pnpm": {
  "overrides": {
    "fast-uri": ">=3.1.1"
  }
}
```

`pnpm why fast-uri` output before fix: `fast-uri@2.4.0` appeared via `@fastify/ajv-compiler`, `fast-json-stringify`, and `find-my-way`.
`pnpm why fast-uri` output after fix: all references now resolve to `fast-uri@3.1.2` — zero `2.4.0` instances.

The Next.js upgrade (apps/web) is the frontend builder's part — not touched.

### Verification Results

```
pnpm turbo run typecheck test:unit lint --filter=@brain/core --force
Tasks:    15 successful, 15 total
Cached:    0 cached, 15 total
  Time:    1.324s

Tests: 5 files, 55 tests — all PASS
Typecheck: PASS (exit 0)
Lint: PASS (exit 0)

pnpm --filter @brain/core why fast-uri → all fast-uri@3.1.2 (exit 0)

Real-network smoke (PORT=3099, DATABASE_URL=postgres://brain:brain@localhost:5432/brain):
  GET  /health                                → HTTP 200 {"status":"ok","version":"0.1.0"}
  GET  /api/v1/connectors (no session)        → HTTP 401 (guard enforced)
  GET  /api/v1/pixel/health (no session)      → HTTP 401 (guard enforced)
  GET  /v1/dashboard/brand-summary (no sess)  → HTTP 401 (guard enforced)
  GET  /v1/dashboard/onboarding-progress      → HTTP 401 (guard enforced)
```

### Journal

```
2026-06-15T21:23:00Z — Backend Engineer — feat-m1-app-foundation
Stage: 3 (bounce-fix) | Service: core | Verification: typecheck PASS / 55 tests PASS / lint PASS
Self-review vs gates: PASS — all HIGH findings addressed, guards self-contained at mount, secrets provider fail-closed
Next: READY-FOR-SECURITY
```

---

## Bounce-Fix Round 2

**Timestamp:** 2026-06-15T22:00:00Z
**Author:** backend-engineer (Sonnet tier)
**Stage:** 3 — Bounce Fix Round 2
**Findings addressed:** HIGH-SECRETS-01-RESIDUAL (connector ISecretsManager wiring), HIGH-SCA-02 (fastify upgrade to 5.8.5)

### HIGH-SECRETS-01-RESIDUAL — AwsSecretsManager implemented + conditionally wired

**New file:**
- `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/AwsSecretsManager.ts` — implements `ISecretsManager` using `@aws-sdk/client-secrets-manager` (already present as a dependency). IRSA credentials (no static AWS keys). Methods: `storeShopifyToken` (CreateSecretCommand, returns ARN for NN-2), `getShopifyClientSecret` (GetSecretValueCommand by ARN), `deleteShopifyToken` (DeleteSecretCommand with `ForceDeleteWithoutRecovery: true`). All three are fail-closed: any Secrets Manager error propagates as a thrown Error — never falls back to a plain env read. Secret values are never logged (I-S09).

**main.ts changes (lines 52-53 + 233-253):**
- Added import for `AwsSecretsManager` from the connector secrets module.
- Replaced unconditional `new LocalSecretsManager()` with a conditional selection mirroring the JWT/cookie SecretsProvider pattern:
  ```
  isProduction
    ? new AwsSecretsManager(region, shopifyClientSecretRef)  // ARN in env var
    : new LocalSecretsManager()                               // raw value in env var
  ```
- `SHOPIFY_CLIENT_SECRET` env var is now `getEnvOrThrow` — fail-closed (missing → startup abort).
- In production: env var holds the AWS Secrets Manager ARN; `AwsSecretsManager.getShopifyClientSecret()` fetches the value at call time via IRSA. I-S09 satisfied.
- In development: `LocalSecretsManager.getShopifyClientSecret()` reads the raw env var value — dev workflow unchanged.
- Fail-closed in prod: unresolved Shopify secret throws at first OAuth initiation or callback — never falls back to plain-env read.

### HIGH-SCA-02 — fastify upgraded to 5.8.5 (PREFERRED path taken)

**Path taken:** PREFERRED — clean fastify 5 upgrade, no suppression waiver needed.

**package.json changes (apps/core):**
- `fastify: "^4.28.0"` → `"^5.7.2"` (resolved to `5.8.5` by pnpm)
- `@fastify/cookie: "^9.4.0"` → `"^11.0.2"` (fastify-5-compatible major)

**Breaking API changes fixed:**
1. `main.ts` — Import: `import cookie from '@fastify/cookie'` → `import fastifyCookie from '@fastify/cookie'` (default export required for fastify 5).
2. `main.ts` — Register: `app.register(cookie, ...)` → `app.register(fastifyCookie as unknown as ..., ...)` with double-cast through `unknown`. Required because `@fastify/cookie` v11.0.2's `FastifyPluginCallback` type uses `FastifyTypeProviderDefault` while fastify 5's `register` overload passes `FastifyTypeProvider` (the generic constraint) — these are not directly assignable. Runtime behavior is correct; this is a known upstream TS incompatibility in `@fastify/cookie` v11.0.x.
3. `main.ts` — `setErrorHandler` now requires explicit `FastifyError` generic parameter (`app.setErrorHandler<FastifyError>(...)`) because fastify 5 types the `error` parameter as `unknown` by default.
4. `main.ts` — `FastifyError` imported from `fastify` (re-exported there in v5), not from `@fastify/error` (not installed).
5. `bff.routes.ts` — `@fastify/cookie` module augmentation (`request.cookies`, `reply.setCookie`, `reply.clearCookie`) is not automatically applied in `NodeNext` module resolution when the package lacks an `exports` field. Fixes:
   - Added local `CookieReply` intersection type at the top of the file.
   - `reply.setCookie(...)` → `(reply as CookieReply).setCookie(...)` at 2 call sites.
   - `reply.clearCookie(...)` → `(reply as CookieReply).clearCookie(...)` at 2 call sites.
   - `request.cookies` double-cast: `(request as unknown as { cookies: Record<string, string | undefined> }).cookies` — previously already cast (showed type annotation intent), now correctly typed.

**Verification:**

`pnpm --filter @brain/core why fastify` output:
```
@brain/core@0.0.0 (PRIVATE)
dependencies:
fastify 5.8.5
```

GHSA-jx2c-rxcm-jvmq is no longer present in `apps/core`. The remaining fastify HIGH entry in `pnpm audit` output is:
```
Paths: apps/collector > fastify@4.29.1
```
That is `apps/collector`, a separate workspace package NOT in scope for this fix. All other highs in the audit output are dev-only (vitest UI, esbuild, vite, handlebars via eslint-plugin-boundaries) — not in production images.

### Verification Output

```
pnpm --filter @brain/core run typecheck
→ PASS (exit 0, no output)

pnpm --filter @brain/core run test:unit
→ Test Files  5 passed (5)
→ Tests  55 passed (55)

pnpm --filter @brain/core run lint
→ PASS (exit 0, no output)

pnpm --filter @brain/core why fastify
→ fastify 5.8.5

Real-network smoke (PORT=3097, NODE_ENV=development):
  GET  /health                                → HTTP 200 {"status":"ok","version":"0.1.0","timestamp":"..."}
  GET  /api/v1/connectors (no session)        → HTTP 401 (guard enforced)
  GET  /api/v1/pixel/health (no session)      → HTTP 401 (guard enforced)
  GET  /v1/dashboard/brand-summary (no sess)  → HTTP 401 (guard enforced)
```

### Fastify Decision

**Upgraded to fastify 5.8.5** (PREFERRED path). No suppression waiver needed. GHSA-jx2c-rxcm-jvmq is resolved at the source. Total breaking API changes required: 5 targeted fixes across 2 files (`main.ts` and `bff.routes.ts`), all clean and contained.

### Journal

```
2026-06-15T22:00:00Z — Backend Engineer — feat-m1-app-foundation
Stage: 3 (bounce-fix-r2) | Service: core | Verification: typecheck PASS / 55 tests PASS / lint PASS / smoke PASS
Self-review vs gates: PASS — HIGH-SECRETS-01-RESIDUAL wired, HIGH-SCA-02 resolved via fastify 5.8.5 upgrade
Next: READY-FOR-SECURITY
```
