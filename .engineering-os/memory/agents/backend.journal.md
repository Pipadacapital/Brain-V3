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
