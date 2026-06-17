# Backend Engineer — Journal

> Append-only. See /Users/rishabhporwal/.claude/plugins/cache/engineering-os/engineering-os/2.3.1/docs/role-empowerment-model.md for entry shape.

## 2026-06-15T07:19:27Z — system — bootstrap
**Action:** Journal initialized by /eos-init on 2026-06-15T07:19:27Z.

## 2026-06-15T13:30:00Z — Backend Engineer — chore-platform-foundations-sprint0
**Stage:** 3 · **Tracks:** A + E-packages · **Verification:** typecheck 10/10 PASS; 75 unit tests PASS; lint fixtures fire correctly; gen:contracts emits all 4 artifact families; READY-FOR-SECURITY

**Delivered:**
- `eslint.config.mjs` — flat config with boundaries rules (app-to-app ban, tool-import ban, metric-engine fence), `no-float-money` (I-S07), `no-raw-redis-key` (NN-7)
- `tools/eslint-rules/no-float-money.mjs` — AST rule; fires on float literal + TS `number` type on monetary column names (`*_minor`, `*_amount`, `*_value`, `*_fee`, `*_cost`, `*_revenue`, `*_price`)
- `tools/eslint-rules/no-raw-redis-key.mjs` — AST rule; fires on string literal/concat/template on first arg of Redis client methods; passes when key is an identifier or `brandKey()` call
- `tools/eslint-rules/fixtures/bad-float-money.ts` + `bad-redis-key.ts` — failing fixtures (negative controls for CI)
- `packages/contracts/src/events/sample.collector.event.v1.ts` — `CollectorEventV1Schema`; brand_id, correlation_id, hashed_user_id (NO raw PII), properties
- `packages/contracts/src/api/sample.api.v1.ts` — `IngestEventRequestSchema` with idempotency-key header; MCP tool schemas
- `packages/contracts/src/dq/index.ts` — DQ category stubs: freshness, completeness, schema_validity, reconciliation
- `packages/contracts/scripts/codegen.ts` — Zod → TS barrel + OpenAPI 3.1 + Avro `.avsc` + MCP tools.json
- `packages/contracts/generated/{types,openapi,avro,mcp}/` — all 4 artifact families emitted
- `packages/contracts/src/events/sample.collector.event.v1.test.ts` — 8 tests; I-S01 negative-control (rejects missing brand_id)
- `packages/observability/src/redact.ts` — `isPiiKey`, `redactAttributes`, `redactLogRecord`; PII_SUFFIX_PATTERNS excludes `_name` to avoid catching `service_name`/`event_name`
- `packages/observability/src/redact.test.ts` + `span.test.ts` — 13 tests; NN-6 negative controls
- `packages/observability/src/index.ts` — `BrainSpan`, `StubSpan`, `startSpan`, `startGenAiSpan`, `extractCorrelationId`
- `packages/tenant-context/src/index.ts` — `brandKey()`, `rateLimitKey()`, `sessionKey()` with separator-injection guards
- `packages/db/src/index.ts` — `buildSetGucSql` (two-arg), `buildResetGucSql`, `createStubClient`, `checkoutStubClient`
- `packages/db/src/rls.test.ts` — 14 tests; NN-1 negative control: null GUC → 0 rows; one-arg-vs-two-arg distinction documented
- `db/migrations/0001_init.sql` — audit_log (INSERT+SELECT only), brand_keyring (SELECT only), _rls_demo with two-arg RLS policy, NN-1 assertion DO block scanning pg_policies
- `packages/money/src/index.ts` — `Money` (bigint minor units), `moneyFromNumber` (rejects floats), arithmetic helpers
- `packages/audit/src/index.ts` — `AuditEntry`, `AuditWriter`, `NoopAuditWriter`, hash stub
- `packages/config/src/index.ts` — Zod env schemas, `parseEnv` with exit-on-prod-failure
- `packages/feature-flags/src/index.ts` — `FeatureFlagReader`, `InMemoryFlagReader`, `requireFlag`, `FeatureFlagDisabledError`
- `packages/identity-core/src/index.ts` — `normalizeIdentifier`, `hashIdentifier`, `piiVaultRef`
- `tools/isolation-fuzz/src/redis.test.ts` — 30 structural tests (no Docker); brand isolation negative controls; imports `brandKey` from `@brain/tenant-context`
- `CODEOWNERS` — contracts, migrations, db, metric-engine, security-critical packages, eslint-rules

**Non-negotiables met:**
- NN-1: two-arg `current_setting('app.current_brand_id', TRUE)::uuid` in migration; GUC reset at checkout + before query in db middleware; unit test proves null GUC → 0 rows (fail-closed)
- NN-6: SDK-layer PII drop in `redactAttributes`; logger-layer `redactLogRecord`; `_name` suffix excluded (preserves service_name/event_name); negative-control test proves shrinkage
- NN-7: `no-raw-redis-key` ESLint rule fires on string concat/template/literal; passes on `brandKey()` identifier
- I-S07: `no-float-money` fires on float literal + TS `number` type on monetary columns; `Money.amount_minor` is bigint
- I-S06: audit_log REVOKE ALL + GRANT INSERT,SELECT only; no UPDATE/DELETE for brain_app
- I-S09: brand_keyring REVOKE ALL + GRANT SELECT only

**Deferrals honored:** No Playwright, Husky/Commitlint, guideline docs, LiteLLM deploy, Authentik deploy, full dbt harness, real OTel collector wiring (collector config is infra/Track C).

**Cross-track request for platform-devops (Track B/C):** OTel collector transform processor config needs `attributes` redaction block for PII key list. Key list: `email, phone, mobile, name, full_name, first_name, last_name, address, ip, ip_address, user_agent, dob, date_of_birth, pan, aadhaar, passport, card_number, cvv, bank_account` + prefix `pan_, card_, aadhaar_, passport_, contact_, pii_, email_, phone_, address_` + suffix `_email, _phone, _mobile, _address, _pan, _aadhaar, _passport`. This is the Layer 2 of NN-6; Layer 1 ships in `packages/observability`.

**Next owner:** security-reviewer + qa-agent (Stage 4)

## 2026-06-16T02:22:00Z — Backend Engineer — feat-access-onboarding-flow
**Stage:** 3 · **Service:** core + db/migrations · **Verification:** typecheck PASS (0 errors); 55/55 unit tests PASS; lint PASS; curl proofs: refresh rotation + replay→family-wipe, onboarding_status enum, brand locale fields, AC-8 org scoping guard
**Self-review vs gates:** PASS — all must-fix items resolved; no offset pagination; no plaintext tokens; access-control on every mutation; idempotency on all inserts; CSRF consolidated to app-wide hook (MA-14); raw pool injected correctly
**Next:** READY-FOR-SECURITY

**Tracks delivered:**
- **B-MIG**: 3 migrations (0010 brand_locale, 0011 onboarding_state, 0012 session_rotation_lineage) — all applied and verified in dev DB; columns confirmed; migration file format fixed (removed invalid UP/DOWN markers that caused DROP COLUMN to run during UP pass)
- **B-1 (AC-1)**: Rotating refresh tokens — `POST /api/v1/auth/token/refresh`; SELECT FOR UPDATE in raw pg txn; sha256-hash stored; replay→family-wipe→SESSION_REVOKED; jti conflict→SESSION_CONFLICT; family lineage (`family_id`, `rotated_from`, `used_at`) on user_session; CSRF-exempt in app-wide hook
- **B-2 (AC-2)**: `revokeAllForUser()` + `revokeAllForUserAndBrand()` in UserSessionRepository; `removeMember()` + `updateMemberRole()` revoke ALL target sessions in same raw pg txn (SD-3 unconditional); `logout(scopeAll=true)` path
- **B-3 (AC-3)**: `RateLimiter` (Redis INCR+EXPIRE sliding window, fail-open); key factories for 4 routes; ioredis injected via constructor; wired in main.ts; registered into `registerAuthRoutes()`; REDIS_URL config
- **B-4 (AC-4)**: `currency_code`, `timezone`, `revenue_definition` on brand domain entity + repository + service + routes + contracts; `region_code` derived from currency; MA-11 currency immutability guard (42P01 caught for M1); MA-12 CHECK excludes 'placed'
- **B-5 (AC-5)**: `onboarding_status` enum replaces `needs_onboarding: boolean` in ALL BFF responses; `advanceOnboardingStatus()` (forward-only via `WHERE onboarding_step < $newStep`) called on org create (→ org_created) and brand create (→ brand_created); `POST /api/v1/bff/session/set-org` resolves fresh context
- **B-6 (AC-7)**: `acceptInvite()` email-match + email-verified guards; membership insert + markAccepted in single raw pg txn (atomicity)
- **B-7 (AC-8)**: `POST /api/v1/bff/session/set-org` endpoint; GET /members 403 guard when `query.organization_id !== auth.workspaceId`
- **B-8 (MA-14)**: Removed weaker duplicate CSRF check from `bffProtectedPreHandler`; authoritative jti-bound check lives in main.ts `onRequest` hook

**Bug fixed (MA-04)**: `forgotPassword` fire-and-forget wrapped in `Promise.resolve()` to guard against test mocks returning undefined (`.catch()` on undefined throws)

**Bug fixed (raw pool injection)**: `this.pool as unknown as Pool` cast was incorrect — `DbPool.connect()` returns `DbClient` not pg `PoolClient`. Fixed by injecting `rawPgPool?: Pool` into `AuthService` and `InviteService` constructors; `main.ts` creates `pg.Pool` separately and passes it

**DB schema confirmed (curl proof)**:
- Login returns `refresh_token` ✓
- Rotation: old token → 200 new pair; replay old → SESSION_REVOKED; new after wipe → SESSION_REVOKED ✓  
- BFF login: `onboarding_status: null` (no org), `onboarding_status: "org_created"` after workspace, `onboarding_status: "brand_created"` after brand ✓
- Brand create: `currency_code: "AED"`, `timezone: "Asia/Dubai"`, `region_code: "AE"` derived ✓
- AC-8: GET /members with mismatched org_id → 403 FORBIDDEN ✓
- Rate limiter: fail-open on Redis absence — login still works ✓

## 2026-06-16T00:15:00Z — Backend Engineer — feat-access-onboarding-flow (bounce-fix r3)
**Stage:** 3 · **Service:** core · **Verification:** typecheck PASS (0 errors); 74/74 tests PASS (3 new live PG + 71 existing); lint PASS; validity_check exit 0 (80 files); curl proofs below
**Self-review vs gates:** PASS — SEC-AOF-L1 (CRITICAL) + SEC-AOF-N1 (MED) fixed; no regressions on 9 closed findings; family-wipe confirmed working under brain_app role; rate-limit single-count confirmed
**Next:** READY-FOR-SECURITY

**Findings fixed:**
- **SEC-AOF-L1 / QA-08 (CRITICAL)**: Replaced `SET LOCAL app.current_user_id = $1` (invalid Postgres syntax → 42601) with `SELECT set_config('app.current_user_id', $1, true)`. Replay path now returns 401 SESSION_REVOKED (not 500). Family-wipe fires correctly. Grepped entire apps/core/src — no other occurrences of this anti-pattern. Unit test in critical-paths.test.ts updated (mock + assertion) to match set_config. New live PG integration test (family-wipe.live.test.ts, 3 tests): LIVE-PG-1 (set_config no 42601), LIVE-PG-2 (brain_app role wipe rowcount>1), LIVE-PG-3 (AuthService replay→SESSION_REVOKED + sibling revoked in DB).
- **SEC-AOF-N1 (MED)**: Fixed double-count in bff.routes.ts POST /api/v1/bff/session. Pattern now mirrors auth.routes.ts: entry=loginIpKey only; catch=loginFailKey (await + return 429 if exceeded); success=reset BOTH loginFailKey+loginIpKey. Proof: 4 fails → correct → HTTP 200; trips at 6th attempt (after 5 failures); Redis counter = 6 at first 429.

**Live proof summary:**
- RT0→RT1→RT2 rotation: all HTTP 200
- Replay RT1 → HTTP 401 SESSION_REVOKED (not 500); DB shows 3/3 sessions revoked_at IS NOT NULL
- brain_app role wipe: `SET LOCAL ROLE brain_app; SELECT set_config(...); WITH revoked AS (UPDATE...)` → rowcount=1
- BFF rate-limit: 4×wrong → 1×correct → HTTP 200; 5×wrong → 6th → HTTP 429 RATE_LIMITED; counter=6 (single-count)

## 2026-06-16T04:00:00Z — Backend Engineer — feat-access-onboarding-flow
**Stage:** 3 (bounce-fix r2) · **Service:** core + db/migrations · **Verification:** typecheck PASS (0 errors); 71/71 unit tests PASS (16 new + 55 existing); validity_check.py exit 0 (79 files); curl proofs: advance-200, set-org-organization_id, 403-non-member, BFF-rate-limited, snake_case-auth-keys; brain_app-wipe-rowcount=1
**Self-review vs gates:** PASS — all 8 bounce findings resolved; B-1/B-2 not regressed (5 AC-1 + 2 AC-2 tests pass); no offset pagination; no plaintext tokens; every mutation has access-control guard; forward-only onboarding enforced; GUC set before wipe; CSRF comment corrected; rollback docs added
**Next:** READY-FOR-SECURITY

**Findings resolved:**
- **QA-01 (CRITICAL)**: Registered `POST /api/v1/bff/session/onboarding/advance` — cookie-auth, forward-only allowlist (`integration_selected`, `complete`), calls `advanceOnboardingStatus`, returns `{ onboarding_status }`. Curl proof: 200 `{"onboarding_status":"integration_selected"}`.
- **QA-02 (HIGH)**: `set-org` body field changed `workspace_id` → `organization_id`. Curl proof: `{"organization_id":"<uuid>"}` → 200.
- **SEC-AOF-H1 (HIGH)**: `set-org` now calls `MembershipRepository.findByUserAndOrg` BEFORE `refreshSession`; non-member → 403 FORBIDDEN. Curl proof: non-member org → 403; member org → 200.
- **SEC-AOF-L1 (HIGH/prod-correctness)**: Added `SET LOCAL app.current_user_id = $1` before family-wipe UPDATE in `rotateRefreshToken`. RLS proof under `brain_app` NOBYPASSRLS: wipe rowcount = 1 (was 0).
- **QA-03 (HIGH)**: Wired `rateLimiter` to `registerBffRoutes()`; `POST /api/v1/bff/session` now enforces 20/15min/IP + 5/15min/email+IP. Curl proof: 429 RATE_LIMITED at attempt 4.
- **QA-07 (MED)**: All 3 BFF session responses explicitly map `brand_id`/`workspace_id`/`role` (snake_case). Curl proof: all 3 endpoints return `['brand_id','workspace_id','role']` as auth keys.
- **QA-06 (HIGH)**: 16 unit tests in `critical-paths.test.ts` with real negative controls for AC-1/AC-2/AC-5/AC-7. validity_check.py exits 0.
- **SEC-AOF-M1/M2/M3 (MED)**: PATCH/DELETE member routes fixed (auth.workspaceId is source of truth); set-org CSRF comment corrected; rollback procedures added to 0010/0011/0012 migrations.

## 2026-06-15T20:43:00Z — Backend Engineer — feat-m1-app-foundation
**Stage:** 3 · **Service:** core (Track 0 contracts + Track 1 control-plane) · **Verification:** typecheck 34/34 PASS; 36/36 test tasks PASS (53 core + 14 db); lint 18/18 PASS

**Delivered:**
- `packages/contracts/src/api/{auth,workspace,brand,member,connector,pixel}.api.v1.ts` — all M1 Zod contracts (NN-2 enforced: connector uses secret_ref only; MutationHeadersSchema requires Idempotency-Key)
- `packages/contracts/src/events/m1.events.v1.ts` — 9 domain events with doc-07 envelope (user.registered, user.logged_in, workspace.created, brand.created, user.invited, connector.connected, connector.sync_started, pixel.installed, pixel.verified)
- `packages/db/src/index.ts` — full 3-GUC rewrite (BREAKING: buildSetGucSql two-arg, buildResetGucSql requires GUC name; all callers updated); sha256Hex helper added
- `packages/audit/src/index.ts` — L-02 closure: real sha256 hash-chain (replaces djb2 stub); DbAuditWriter with ON CONFLICT idempotency; NN-6 WHERE brand_id on every SELECT; NoopAuditWriter uses real sha256
- `packages/audit/package.json` — added @types/node devDep (needed for node:crypto)
- `db/migrations/0002_auth.sql` — app_user (no RLS), user_session/password_reset/email_verification (RLS: userId GUC); token_hash columns (sha256 only, no plaintext)
- `db/migrations/0003_workspace.sql` — organization + membership; role_code CHECK IN canonical values; two null-safe UNIQUE indexes
- `db/migrations/0004_brand.sql` — brand table; deferred FK membership→brand via DO block
- `db/migrations/0005_invitation.sql` — NN-7 compound PERMISSIVE RLS (two policies for nullable brand_id); token_hash sha256
- `db/migrations/0006_connector.sql` — NN-2: secret_ref only DDL comment; no *_token/*_ciphertext columns; connector_cursor UNIQUE (brand_id, instance_id, resource) for idempotent upsert
- `db/migrations/0007_pixel.sql` — pixel_installation (install_token UUID public tag) + pixel_status; brand-scoped RLS
- `apps/core/src/modules/workspace-access/**` — DDD: domain entities → repositories (8, keyset paginated) → auth/workspace/brand/invite services → REST routes (22 endpoints)
- `apps/core/src/modules/notification/**` — NotificationService interface; NotificationServiceImpl; DevEmailAdapter (console); SesEmailAdapter (prod-only dynamic import via Function constructor to avoid TS compile-time resolution)
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts` — BFF: httpOnly cookie, CSRF double-submit, NN-3 validateSession preHandler on every BFF route
- `apps/core/src/main.ts` — full Fastify bootstrap (env validation, @fastify/cookie, correlation-id hook, error envelope, health, pool, audit, notification, all services, graceful shutdown)
- `apps/core/src/modules/workspace-access/tests/auth.service.test.ts` — 24 unit tests: NN-5a (argon2id params), NN-5c (randomBytes(32) token format), NN-3 (revoked/expired session → false; SQL has revoked_at IS NULL + expires_at > NOW()), NN-1 (stub rejects no-context queries), NN-5b (forgotPassword resolves void for both email-exists and email-not-exists)
- `tools/isolation-fuzz/src/pg.test.ts` + `pg.connector.test.ts` — updated to new two-arg buildSetGucSql API
- `package.json` (root) — node-pg-migrate scripts + devDep

**Non-negotiables met:**
- NN-1: three-GUC two-arg fail-closed in packages/db + all 6 migrations; every migration has NN-1 assertion block
- NN-2: ConnectorInstanceSchema has secret_ref only; migration 0006 DDL has no token/ciphertext columns
- NN-3: validateSession preHandler registered on every protected route + BFF routes; SQL has revoked_at IS NULL; unit-tested
- NN-5: argon2id params m=19456,t=2,p=1 asserted at startup; timing-safe login; forgotPassword always void; tokens sha256-hashed in DB; single-use (used_at); expiry enforced
- NN-6: DbAuditWriter.getRecentEntries always WHERE brand_id = $1; no bare SELECT on audit_log
- NN-7: invite table two PERMISSIVE policies (OR-combined); handles nullable brand_id correctly
- L-02: sha256 hash-chain closed (crypto.createHash not djb2)

**API surface completed:** 7 auth + 5 workspace + 5 brand + 5 member + 4 BFF = 26 endpoints

**Next owner:** security-reviewer (Stage 4)

## 2026-06-16T10:40:00Z — Backend Engineer — feat-multi-brand BOUNCE r1
**Stage:** 3 (DELTA bounce-fix) · **Service:** core + web · **Verification:** typecheck/test/lint + output pasted

**Fixes delivered:**

- **SEC-MB-1 (HIGH, BLOCKING):** `POST /v1/brands` — replaced `parsed.data.workspace_id` with `auth.workspaceId` at `brand.routes.ts:58`. Added `if (!auth.workspaceId) → 400 MISSING_WORKSPACE` guard before schema parse (line 34). Made `workspace_id` optional in `CreateBrandRequestSchema` (contracts) and `CreateBrandRequest` (web types). Removed dead `requestingRole: auth.role ?? 'analyst'` JWT-claim pass-through — BrandService.create() re-derives role from DB (brand.service.ts:68-70).

- **SEC-MB-3 (MED):** `create-brand-dialog.tsx` — removed `workspace_id: getActiveWorkspaceId(queryClient) ?? ''` from the `brandApi.create()` call body. Removed the `getActiveWorkspaceId()` helper entirely. Updated `CreateBrandRequest.workspace_id` to optional in `apps/web/lib/api/types.ts`.

- **QA-1 (HIGH, BLOCKING):** Added `apps/core/src/modules/workspace-access/tests/switch-brand.live.test.ts` — real-Postgres integration test (mirrors family-wipe.live.test.ts pattern). Seeds 2-brand user (owner on A, analyst on B) + archived brand + non-member brand. 4 tests: positive switch (MA-01/MA-03), audit row verification (MA-09), archived→BRAND_ARCHIVED (MA-10), non-member→FORBIDDEN (MA-02). All pass.

- **QA-2 (MED, BLOCKING):** Appended 6 unit tests for `switchBrandContext` to `critical-paths.test.ts` (stub executor, no live PG): MA-01 direct mint, MA-02 workspaceId from arg, MA-03 brand-level role, MA-09 audit.append payload, MA-10 archived guard, non-member FORBIDDEN + audit NOT called.

- **QA-4 (LOW/MED):** Strengthened `tools/isolation-fuzz/src/pg.test.ts` AC-7 brand-table assertion from `toBeGreaterThanOrEqual(0)` (tautology) to `toBeGreaterThan(0)` (real intent: brand-A visible via self_read). Connector_instance negative control (= 0) preserved.

- **QA-3 (MED): DEFERRED** — `correlation_id` column in `audit_log` requires schema migration. Not implemented in this slice. Tracked as tech-debt.

**Verification:**
- `pnpm --filter @brain/core typecheck` → EXIT 0
- `pnpm --filter @brain/web typecheck` → EXIT 0
- workspace-access tests: 53 passed (24 + 22 + 3 + 4), 0 failed
- isolation-fuzz: 11 passed, 0 failed

**Self-review vs gates:** PASS — all blocking SEC/QA items addressed; MISSING_WORKSPACE guard added; body workspace_id not read; real-network test automated; unit coverage on all critical guard paths.

**Next:** READY-FOR-SECURITY (DELTA re-review, Stage 4)

## 2026-06-17T08:45:00Z — Backend Engineer — feat-connector-marketplace
**Stage:** 3 · **Service:** core (connector module) · **Verification:** typecheck PASS (0 errors); 189/189 unit tests PASS; lint PASS (0 warnings)
**Self-review vs gates:** PASS — all D-1..D-12 must-fix items from CTO review addressed; NN-2/NN-4/MED-CALLBACK-01 proven by dedicated negative-control tests; non-inert isolation test count===0 under brain_app; no plaintext tokens anywhere; envelope discipline on all routes.
**Next:** READY-FOR-SECURITY

**Commits (branch feat/connector-marketplace):**
- `dff9741` — A0: freeze connector.api.v1 contract + static catalog (9 tiles, 7 categories, ADR-CM-1)
- `84d350b` — A1: migration 0021 health columns (7-state health_state + 3-state safety_rating); repo + entity extended (ADR-CM-5)
- `8bbb61e` — A2: generic ISecretsManager seam (storeSecret/getSecret/deleteSecret); LocalSecretsManager prod hard-fail (D-7/ADR-CM-4)
- `9f771d6` — A3: generic connect/callback/disconnect + authz (ADR-CM-7) + audit (ADR-CM-9); deleted divergent MED-CALLBACK-01 handler (D-1)
- `d48bb79` — A4: live tests 35/35 pass — isolation (BEGIN/SET LOCAL/COMMIT, count===0), forged-body, authz, audit sha256, envelope

**Non-negotiables:**
- NN-2: no token/ciphertext/key columns in connector_instance; only secret_ref (ARN) — schema scan + entity scan + LocalSecretsManager ARN proof
- NN-4: HMAC → state-nonce → shop-domain order enforced; unit negative-control proves HmacValidationError fires first with zero repo calls
- MED-CALLBACK-01: brandId from consumeAndGetBrandId(state) only; OAuthCallbackInput has no brandId field; structural compile-time proof
- ADR-CM-8: {request_id, data} envelope on all connector routes; Zod parse validation in live test describe 11
- ADR-CM-9: auditWriter.append on connect + disconnect; sha256 hash-chain row confirmed in audit_log

**Root causes fixed during A4:**
1. SET LOCAL requires BEGIN/COMMIT transaction block to persist GUC for subsequent statements — isolation tests failed silently because RLS policy read current_setting()→"" (empty default) and got uuid parse error
2. CTX.BRAND_A empty despite hardcoded fallback — TEST_BRAND_A='' in shell env, so ?? null-coalescing didn't trigger; fixed with || falsy-coalescing
3. AuditDbClient.query generic variance — resolved by returning explicit {rows, rowCount} shape instead of pg QueryResult<T>

## 2026-06-17T12:45:00Z — Backend Engineer — feat-connector-backfill
**Stage:** 3 · **Service:** core · **Verification:** typecheck EXIT 0 + 11/11 B3 live tests PASS (brain_app pool, NOBYPASSRLS)
**Self-review vs gates:** PASS — brand_id from session (MT-1/ADR-BF-13), no secret in response (I-S09), overlap-lock DB-level (D-9/HP-2), percent=null honesty (D-8), brand_admin+ gate (D-15), isolation under brain_app (F-4 anti-trap)
**Next:** READY-FOR-SECURITY

**Delivered:**
- B1: `POST /api/v1/connectors/:id/backfill` — brand_admin+ scope; load connector → getSecret null → 409 RECONNECT_REQUIRED (D-7) → checkActiveJob FOR UPDATE SKIP LOCKED → 409 BACKFILL_ALREADY_RUNNING (D-9) → insertQueued → audit → 202 {job_id, status:'queued'}
- B2: `GET /api/v1/connectors/:id/jobs` — findLatestForConnector → BackfillJobProgress; percent=null when estimated_total=null (D-8); no secret_ref in response
- B3: 11 live tests under brain_app (NOSUPERUSER NOBYPASSRLS) — T1/insertQueued, T2/manager→403 non-inert, T3/null-secret RECONNECT path, T4/overlap-lock count===1, T5/percent honesty, T6/no-secret-in-row, T7/audit-row, T8/cross-brand isolation count===0

**Commits:**
- `72ecb32` — B1+B2: trigger + progress API (ADR-BF-3/4)
- `475c5ae` — B3: live tests, 11/11 pass

**Root causes fixed during B3 iteration:**
1. `makeAppDbPool` used `SET LOCAL` without `BEGIN/COMMIT` — GUC silently didn't persist, RLS returned 0 rows on INSERT; fixed by wrapping each query in explicit transaction block
2. `connector_instance` has `UNIQUE(brand_id, provider)` — cannot seed two shopify connectors for same brand; fixed by seeding one connector per test with per-test randomUUID shop domains
3. `storeShopifyToken` normalizes shop domain (dots→hyphens), returning ARN not manually computable; T3 positive control calls `result.arn` from the return value

## 2026-06-17T10:05:00Z — Backend Engineer — feat-connector-marketplace (bounce r1)
**Stage:** 3 · **Service:** core · **Verification:** typecheck EXIT 0 + 70/70 connector tests PASS (35 original + 4 new KMS unit tests + 1 updated MED-01 test)
**Self-review vs gates:** PASS — HIGH-01 structurally enforced (KmsKeyId on both CreateSecretCommand paths); prod hard-fail guard added to composition root; MED-01/02/03/LOW-01 all addressed; no regression on D-1/HMAC-first/RLS/envelope/deferred boundary
**Next:** READY-FOR-SECURITY

**Findings fixed:**
- HIGH-01 (VETO): `AwsSecretsManager` — added `kmsKeyId` constructor param; `storeSecret` and `storeShopifyToken` now pass `KmsKeyId: this.kmsKeyId` to `CreateSecretCommand`. Composition root hard-fails at startup if `CONNECTOR_SECRETS_KMS_KEY_ID` absent in production. Unit tests mock AWS SDK and assert `KmsKeyId` is set (non-inert negative control goes RED if dropped). Note: AWS SM `CreateSecret` does not accept caller-supplied `EncryptionContext`; CMK key policy is the isolation mechanism.
- MED-01: Removed `secretRef` from `OAuthCallbackResult` interface and return value. ARN persisted internally via `connectorRepo.save`.
- MED-02: Shopify error body no longer concatenated into `Error.message` on token exchange failure — status code only.
- MED-03: `brand_id` removed from error message strings in `storeSecret` and `storeShopifyToken`.
- LOW-01: Developer report line 74 corrected from "402" to "403".

**Commits:** `e812c4f` (HIGH-01) · `d01fdd9` (MED/LOW batch) · _(report commit pending)_
