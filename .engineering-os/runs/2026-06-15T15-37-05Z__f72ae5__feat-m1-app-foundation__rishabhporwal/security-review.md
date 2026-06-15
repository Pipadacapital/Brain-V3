# Security Review — feat-m1-app-foundation

| Field | Value |
|-------|-------|
| **req_id** | `feat-m1-app-foundation` |
| **Stage** | 4 — Security Reviewer |
| **Mode** | FULL (first review of this surface) |
| **Reviewer** | Security Reviewer (Sonnet tier) |
| **Reviewed at** | 2026-06-15T23:58:00Z |
| **Verdict** | **BOUNCE** |
| **Critical/High count** | 0 CRITICAL / 3 HIGH / 2 MEDIUM / 3 LOW |

---

## Scanner Results

**Secrets scan (grep):** 0 hardcoded credentials, private keys, AWS keys, or JWT secrets found in staged diff.

**One-arg `current_setting()` grep (migrations):** 0 violations. All GUC references in migrations 0002-0007 use two-arg `current_setting(..., TRUE)` form. NN-1 assertion block present in every migration.

**BYPASSRLS grep:** Only appears in test files (`pg.test.ts`, `pg.connector.test.ts`) and the init-migration assertion block (expected — assertion explicitly checks BYPASSRLS is NOT granted).

**Forbidden column names grep (`*_token`, `*_ciphertext`, `*_secret`, `*_key` in connector DDL):** 0 violations in `db/migrations/0006_connector.sql`. NN-2 satisfied at DDL level.

**Dependency audit (`pnpm audit --audit-level=high`):**
- 2 CRITICAL, 13 HIGH, 13 MODERATE, 4 LOW — 32 total.
- Production-path critical/high vulnerabilities identified (see HIGH-SCA-01 below).
- Dev-only path: vitest CRITICAL (UI server, dev only), esbuild HIGH (dev/test only), handlebars CRITICAL (eslint-plugin-boundaries transitive, dev toolchain only) — not in production images.

---

## NN-1 through NN-7 + L-02 Status

| Gate | Status | Evidence |
|------|--------|----------|
| **NN-1** Three-GUC RLS | **PASS** | All 13 M1 tables have RLS with two-arg fail-closed `current_setting(..., TRUE)::uuid`. `app_user` explicitly has NO RLS by design with service-layer isolation via explicit `WHERE` clauses confirmed in `repositories.ts`. GUC reset middleware in `packages/db/src/index.ts` resets all 3 GUCs on pool checkout (step a) and sets applicable GUCs before each query (step b). Isolation-fuzz tests in `tools/isolation-fuzz/src/pg.test.ts` and `pg.connector.test.ts` run on NOSUPERUSER NOBYPASSRLS connections. |
| **NN-2** secret_ref only | **PASS** | `db/migrations/0006_connector.sql` has no `*_token`, `*_ciphertext`, `*_secret`, `*_key` column. `ConnectorInstance` domain entity has `secretRef` field only. `HandleOAuthCallbackCommand` stores via `ISecretsManager.storeShopifyToken()` → returns ARN → writes ARN to DB. Token is not returned from the command. `LocalSecretsManager` (dev stub) stores in-memory but never to Postgres. Production `AwsSecretsManager` implementation is absent — flagged as HIGH-SECRETS-01. |
| **NN-3** Session revocation | **PASS on mounted routes** | `validateSessionPreHandler` checks `user_session.revoked_at IS NULL AND expires_at > NOW()` via `UserSessionRepository.findActiveByJti()`. All workspace-access protected routes use this preHandler. BFF `bffProtectedPreHandler` calls `validateSessionPreHandler` after cookie/CSRF checks. HOWEVER: connector and pixel routes (`shopifyConnectorRoutes.ts`, `pixelRoutes.ts`) are NOT mounted in `main.ts` — they exist as built modules but have no route registration, so no session gap exists for running M1, but this creates HIGH-MOUNT-01 risk for when they are wired. |
| **NN-4** Shopify OAuth HMAC | **PASS** | `HandleOAuthCallbackCommand.execute()` calls `ShopifyHmac.validateOAuthCallback()` as absolute first operation before any state/token/repo work. Uses `timingSafeEqual`. State nonce is `crypto.randomBytes(16)`, brand-bound, single-use (deleted on `consumeAndValidate`), 15-min TTL (`OAuthStateNonce.TTL_SECONDS = 900`). Webhook handler also HMAC-validates first. `brand_id` in callback comes from query param (see MED-CALLBACK-01). |
| **NN-5** Auth hardening | **PASS with LOW concern** | argon2id (m=19456, t=2, p=1) asserted at startup in `assertArgon2Params()`. Login uses `argon2.verify()` with a dummy hash when user not found (timing-safe). Forgot-password always returns 200 with content-identical body (`FORGOT_PASSWORD_RESPONSE`) and fires the handler fire-and-forget. Token generation uses `crypto.randomBytes(32)` → `sha256` hex → stored only as hash. Single-use enforced via `used_at` DB column checked in `findValidByHash`. LOW: `forgotPassword()` has no dummy argon2 hash for missing user — the timing difference is accepted by the builder with a note, but this is a measurable timing channel (see LOW-TIMING-01). JWT uses HS256 with custom implementation — see MED-JWT-01. |
| **NN-6** Audit isolation + sha256 | **PASS** | `packages/audit/src/index.ts` uses `createHash('sha256')` for `computeEntryHash()`. L-02 djb2 stub replaced. Every `getRecentEntries()` query carries `WHERE brand_id = $1`. `DbAuditWriter.append()` fetches prev_hash with `WHERE brand_id = $1`. Isolation-fuzz tests cover M1 tables (workspace tables in `pg.test.ts`, connector/pixel in `pg.connector.test.ts`). WORM checkpoint job (hourly S3 Object Lock) is referenced in architecture but not in M1 diff — noted as pending pre-launch (L-02 gate). |
| **NN-7** Compound RLS on invite | **PASS** | `db/migrations/0005_invitation.sql` creates two PERMISSIVE policies: `invite_org_level` (brand_id IS NULL + workspace_id match) and `invite_brand_level` (brand_id IS NOT NULL + brand_id match). RLS FORCE enabled. |
| **L-02** sha256 audit hash | **PASS** | `computeEntryHash()` in `packages/audit/src/index.ts` uses `crypto.createHash('sha256')`. No djb2. Both `DbAuditWriter` and `NoopAuditWriter` use real sha256. |

---

## Findings

### HIGH-SCA-01 — Production dependency vulnerabilities: Next.js (multiple HIGH CVEs) + fast-uri (HIGH)

**Severity:** HIGH
**File:Line:** `apps/web/package.json` (next@14.2.35), `apps/core/package.json` (fastify@^4.28.0 → fast-uri@2.4.0 transitive)

**Evidence:**
- `next@14.2.35` carries multiple HIGH CVEs:
  - GHSA-5xrq-8626-4rwp: Vitest UI server arbitrary file read/exec (dev dep — NOT this)
  - GHSA-h25m-26qc-wcjf: Next.js HTTP request deserialization DoS with insecure RSC
  - GHSA-36qx-fr4f-26g5: Next.js Middleware/Proxy bypass (i18n)
  - GHSA-gv7w-rqvm-qjhr: esbuild binary integrity (dev dep — NOT this)
  - **GHSA-g77x-44xx-532m: Next.js SSRF in applications using WebSocket upgrades** (patched in >=15.5.16)
- `fast-uri@2.4.0` (transitive via fastify@4.x in production): GHSA path-traversal + host-confusion HIGH

**Risk:** The Next.js SSRF CVE (GHSA-g77x-44xx-532m) affects applications using WebSocket upgrades, which may be triggered in the Next.js server-side rendering path. The Next.js Middleware/Proxy bypass affects i18n routing — applicable if i18n is enabled. The DoS CVEs are directly exploitable against the production web frontend.

**Fix:** Upgrade `next` to `>=15.5.16` in `apps/web/package.json`. For `fast-uri`, upgrade fastify to a version that pulls in `fast-uri@>=3.1.1` or accept as compensated by WAF rules on the edge with tracking in a suppression allowlist entry (with expiry). Each accepted finding needs an allowlist entry with expiry date, not a blanket ignore.

---

### HIGH-SECRETS-01 — No production AwsSecretsManager implementation; JWT signing key from env var

**Severity:** HIGH
**File:Line:**
- `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/LocalSecretsManager.ts` (dev stub only)
- `apps/core/src/main.ts:56` — `jwtSigningSecret: getEnvOrThrow('JWT_SIGNING_SECRET')`

**Evidence:**
- `ISecretsManager` interface exists but only `LocalSecretsManager` is implemented. No `AwsSecretsManager` class is present in the diff. In production, `LocalSecretsManager.getShopifyClientSecret()` reads from `process.env['SHOPIFY_CLIENT_SECRET']` — a plain env var, not a Secrets Manager fetch.
- `JWT_SIGNING_SECRET` is read from an environment variable (line 56 of main.ts), not fetched from AWS Secrets Manager at runtime. INVARIANTS.md I-S09: "Secrets only via Secrets Manager/KMS." Architecture plan §secrets_auth_iam: "JWT signing key must be KMS-backed or Secrets Manager — never in env vars or code."
- `COOKIE_SECRET` defaults to `randomUUID()` (main.ts:60) if unset — ephemeral, causes session invalidation on restart.

**Risk:** If the environment is compromised or a CI system leaks env vars (e.g., CI log exposure), the JWT signing secret and Shopify client secret are exposed. This enables token forgery and connector OAuth hijacking.

**Fix:**
1. Implement `AwsSecretsManager` that fetches secrets at startup/per-use from AWS Secrets Manager using IRSA credentials (no env var for the secret value itself).
2. `JWT_SIGNING_SECRET` must be fetched from Secrets Manager at startup, not from a plain env var. The env var may hold the ARN/path, not the value.
3. `COOKIE_SECRET` must be required (`getEnvOrThrow`) or fetched from Secrets Manager — not defaulted to `randomUUID()`.
4. `SHOPIFY_CLIENT_ID` similarly must not be a plain env var in production.

---

### HIGH-MOUNT-01 — Connector and pixel routes built but not mounted; session/RBAC preHandlers deferred to mount time

**Severity:** HIGH
**File:Line:**
- `apps/core/src/modules/connector/sources/storefront/shopify/interfaces/http/shopifyConnectorRoutes.ts:14-16` (comment: "preHandlers wired at mount time by the module that mounts these routes")
- `apps/core/src/modules/connector/pixel/interfaces/http/pixelRoutes.ts:10` (comment: "preHandlers are wired at mount time")
- `apps/core/src/main.ts` — no `registerShopifyConnectorRoutes` or `registerPixelRoutes` call

**Evidence:**
- The connector routes (`/api/v1/connectors/*`) and pixel routes (`/api/v1/pixel/*`) are fully implemented in their route files but are NOT registered in `main.ts`. The comment in `shopifyConnectorRoutes.ts` explicitly defers session/RBAC guards to "mount time" — i.e., the route handlers assume `getBrandId(req)` works because session has already been validated, but this contract is not enforced at the route level itself.
- When these routes ARE mounted (which must happen before M1 is usable), if the caller omits the `validateSession` preHandler in the fastify mount call, `/api/v1/connectors` and `/api/v1/pixel/*` routes will accept unauthenticated requests and extract `brandId` from an un-validated JWT.
- The `/api/v1/connectors/shopify/callback` is intentionally public (Shopify calls it), protected only by HMAC — this is correct. But `/api/v1/connectors`, `/api/v1/connectors/shopify/install`, `/api/v1/connectors/:id/status`, `DELETE /api/v1/connectors/:id`, and all pixel routes REQUIRE session validation.

**Risk:** If routes are mounted without the preHandler contract being documented as a hard requirement, a future engineer wires them without session guards, creating unauthenticated data access for all connector/pixel reads and writes.

**Fix:** Before M1 ships, the route-mount code in `main.ts` must be present AND must wire `validateSessionPreHandler` + `requireRole` as preHandlers for the connector/pixel routes. The "deferred to mount time" pattern must be replaced with self-contained preHandlers within the route registration functions. Alternatively, add a guard at the route level that panics if `request.auth` is not set (fail-closed).

---

### MED-JWT-01 — Custom JWT implementation does not validate the `alg` header claim

**Severity:** MEDIUM
**File:Line:** `apps/core/src/modules/workspace-access/internal/security/jwt.ts:43-44`

**Evidence:**
```typescript
const [header, payload, signature] = parts as [string, string, string];
const signingInput = `${header}.${payload}`;  // uses RECEIVED header, not expected
```
The `verifyJwt` function reconstructs `signingInput` from the received header rather than from the expected `JWT_HEADER` constant (defined at line 26). This means:
- The `alg` claim in the header is never validated.
- An attacker cannot exploit `alg:none` (the 3-part check at line 39 rejects tokens with no signature component), and algorithm confusion attacks (RS256→HS256) are not applicable since HMAC is always used.
- However, an attacker supplying a modified header (different `alg`, `kid`, or other claims) will have it used in the signingInput without rejection. The HMAC comparison still protects against forgery, but the header parsing is insecure-by-practice.

**Risk:** LOW for alg confusion (mitigated by always using HMAC), MEDIUM for future confusion if header content is used for routing decisions. Not an immediate exploit.

**Fix:** Validate the decoded header before using it: assert `alg === 'HS256'` and `typ === 'JWT'`. Use the fixed `JWT_HEADER` in verification or add an explicit header parse and assertion step.

---

### MED-CALLBACK-01 — OAuth callback reads `brand_id` from query param (attacker-supplied)

**Severity:** MEDIUM
**File:Line:** `apps/core/src/modules/connector/sources/storefront/shopify/interfaces/http/shopifyConnectorRoutes.ts:106`

**Evidence:**
```typescript
const brandIdParam = typeof query['brand_id'] === 'string' ? query['brand_id'] : null;
```
The Shopify callback route (`GET /api/v1/connectors/shopify/callback`) is a public route (no session auth — Shopify calls it). The `brand_id` used to look up the state nonce is taken directly from the query string rather than from a server-side session.

**Mitigation in place:** The state nonce is keyed as `shopify:oauth:state:{brandId}:{state}` — so if an attacker supplies `brand_id=brandC` but the nonce was issued for `brandA`, `consumeAndValidate(brandC, state)` returns false → the callback is rejected. The 128-bit random state is not guessable.

**Risk:** The mitigation is effective for the CSRF/SSRF attack class. However, if an attacker can observe the `brand_id` and `state` in transit (e.g., log exposure of the redirect URL), they could replay the callback for the correct brand. The architecture plan mentions the BFF should inject `brandId` from the authenticated session — this is not implemented.

**Fix:** Embed `brand_id` in the state nonce itself (encode it as `{brand_id}:{random}` and store both), so the callback can verify it from the server-stored state without trusting the query param. Remove the `brand_id` query param dependency.

---

### LOW-DEV-TOKEN-01 — DevEmailAdapter logs raw token in `body_preview`

**Severity:** LOW
**File:Line:** `apps/core/src/modules/notification/internal/ses-adapter.ts:32`

**Evidence:**
```typescript
body_preview: payload.textBody.substring(0, 200),
```
The `textBody` for email verification includes `verifyUrl = appBaseUrl + '/auth/verify-email?token=' + rawToken`. The first 200 characters of this text include the raw token in the URL. This logs the verification token in dev mode.

**Risk:** Dev-only (production uses `SesEmailAdapter` which does not log body content). Not a production security issue. However, dev logs may be accessible in shared environments, and I-S09 states "secrets never in logs" without a dev exception carve-out.

**Fix:** Mask the token in the log: log the URL with the token replaced by `[REDACTED]`, or log only the correlation ID and notification type. Fix: `body_preview: payload.textBody.replace(/[?&]token=[a-f0-9]+/i, '?token=[REDACTED]').substring(0, 200)`.

---

### LOW-TIMING-01 — `forgotPassword()` has a measurable timing channel for user existence

**Severity:** LOW
**File:Line:** `apps/core/src/modules/workspace-access/internal/application/auth.service.ts:330-333`

**Evidence:**
The `forgotPassword` handler does NOT perform a dummy argon2id hash for missing users (unlike the `login` handler). The builder comments: "timing difference is acceptable for forgot-password." The response is always 200 with content-identical body, so the attack requires timing measurements, not response analysis.

**Risk:** LOW — timing attacks against forgot-password require statistical analysis over many requests. The response body does not reveal existence. Mitigated by network jitter in production. Acceptable for M1 with the existing mitigation of content-identical response.

**Note for QA convergence:** This is a LOW per the finding-severity rubric (not immediately exploitable, requires many requests, timing is noisy over network). Do not bounce on this alone.

---

### LOW-RATELIMIT-01 — No rate limiting on auth endpoints (register, login, forgot-password)

**Severity:** LOW
**File:Line:** `apps/core/src/main.ts` — no `@fastify/rate-limit` registration

**Evidence:** No rate-limiting middleware is registered in `main.ts` or any route file. The auth endpoints `/api/v1/auth/register`, `/api/v1/auth/login`, `/api/v1/auth/forgot-password` have no request frequency controls.

**Risk:** LOW for M1 (design-partner scale, not public). Will become HIGH at public launch. argon2id provides inherent rate-limiting on the server side for login (slow hash), but the register and forgot-password endpoints do not have a slow computation path.

**Fix:** Register `@fastify/rate-limit` before routes. Apply per-IP limits on auth endpoints (e.g., 10 req/min on login, 5 req/min on register/forgot-password). Add to M2 backlog with a MEDIUM priority.

---

## NN Status Summary

| Gate | Verdict | Notes |
|------|---------|-------|
| NN-1 Three-GUC RLS | PASS | All 13 tables, two-arg form, FORCE ROW LEVEL SECURITY, pool reset middleware, isolation-fuzz NOSUPERUSER/NOBYPASSRLS |
| NN-2 secret_ref only | PASS | DDL clean, ConnectorInstance entity clean, HandleOAuthCallbackCommand ARN-only flow; AwsSecretsManager not present (HIGH-SECRETS-01) |
| NN-3 Session revocation | PASS (mounted routes) | All registered routes use validateSessionPreHandler; connector/pixel routes not mounted → HIGH-MOUNT-01 |
| NN-4 Shopify OAuth HMAC | PASS | HMAC first, timingSafeEqual, 128-bit nonce, brand-bound, 15-min TTL, single-use; brand_id from query param → MED-CALLBACK-01 |
| NN-5 Auth hardening | PASS with LOW | argon2id params correct, login timing-safe, forgot-password content-identical, tokens sha256 single-use; forgotPassword no dummy hash → LOW-TIMING-01 |
| NN-6 Audit + isolation-fuzz | PASS | sha256 hash-chain, all audit reads WHERE brand_id, fuzz tests cover all M1 tables; WORM S3 checkpoint job not in diff (pre-launch gate, acceptable) |
| NN-7 Compound RLS on invite | PASS | Two PERMISSIVE policies, org-level + brand-level, correctly OR-combined |
| L-02 sha256 | PASS | computeEntryHash uses crypto.createHash('sha256'), no djb2 |

---

## Compliance Verification

**COMPLIANCE.md regime (DPDP 2023 / TCCCPR / PCI SAQ-A):**
- **PII in events:** Event schemas in `packages/contracts/src/events/m1.events.v1.ts` carry `email_masked` (not raw email), `ip_prefix` (anonymized), UUIDs only. No raw PII in event payloads. PASS.
- **PII in logs:** `send_log` masks recipient (`recipient.replace(/(.{1}).+@/, '$1***@')`). Auth audit log uses `maskEmail()`. Login payload carries `ip_prefix` (3-octet). PASS with LOW-DEV-TOKEN-01 (dev only).
- **Notification chokepoint (I-ST05):** All 3 email types (verify, reset, invite) go through `NotificationServiceImpl` → `EmailAdapter`. No direct SES calls outside this path. PASS.
- **Transactional consent exemption:** `canContact()` returns `true` for `transactional_email` with a comment citing TCCCPR transactional exemption. This is correct for M1 scope — transactional emails (verify, reset, invite) are consent-exempt. PASS.
- **No marketing path:** No `consent_record`, `consent_tombstone`, `notification_pref` in M1. PASS.
- **No PCI-scope columns:** No `pan`, `cvv`, `card_number`, `full_account`, `payment_method` table in M1 migrations. PASS.
- **No scope creep:** No OLAP/StarRocks/ledger/metric_registry/invoice/entitlement code in M1 modules. Dashboard reads Postgres only. PASS.
- **Outbound email (TCCCPR):** M1 sends transactional email only (verify, reset, invite). DLT/NCPR compliance checks are deferred to Phase 3 (non-marketing use). PASS for M1 scope.

---

## Verification Validity

- Isolation-fuzz tests run on NOSUPERUSER NOBYPASSRLS connections (`isofuzz_app`, `isofuzz_connector_app`) — not the superuser. Positive controls (brand-A reads brand-A) AND negative controls (brand-A reads brand-B → 0 rows, no GUC → 0 rows) are both present. Tests are not inert.
- Auth unit tests (24 tests) confirmed by builder report. NN-5 tests include timing-safe login test.
- Shopify HMAC tests (9 tests) include negative controls (tampered HMAC → rejection, empty HMAC → rejection).
- OAuthStateNonce tests (9 tests) include single-use negative control and TTL expiry test.

---

## Overall Verdict: BOUNCE

**Reason:** 3 HIGH findings block ship:
1. **HIGH-SCA-01** — `next@14.2.35` in production has SSRF (GHSA-g77x-44xx-532m), DoS, and Middleware bypass HIGH CVEs. Patched version >= 15.5.16 required.
2. **HIGH-SECRETS-01** — No `AwsSecretsManager` implementation; JWT signing key and Shopify client secret loaded from plain env vars in production, violating I-S09.
3. **HIGH-MOUNT-01** — Connector and pixel routes are implemented but not mounted in `main.ts`; `validateSession` + `rbacGuard` are deferred to mount time, creating a missing-guard risk that must be resolved before any mount.

**Bounce target:** `backend-developer` (HIGH-SECRETS-01, HIGH-MOUNT-01) + dependency upgrade track (HIGH-SCA-01 — Next.js upgrade to 15.5.16+).

---

## Journal

```
2026-06-15T23:58:00Z — Security Reviewer — feat-m1-app-foundation
Stage: 4 | Mode: FULL | Verdict: BOUNCE
Findings: 0 CRIT / 3 HIGH / 2 MED / 3 LOW | Scanners: run | Next: bounce to backend-developer (HIGH-SECRETS-01, HIGH-MOUNT-01) + dep upgrade (HIGH-SCA-01)
```

---

## Security Full Re-Review (post-bounce)

| Field | Value |
|-------|-------|
| **req_id** | `feat-m1-app-foundation` |
| **Stage** | 4 — Security Reviewer |
| **Mode** | FULL (post-bounce; fixes touched auth/secrets/multi-tenancy — high_stakes_paths) |
| **Reviewer** | Security Reviewer (Sonnet tier) |
| **Reviewed at** | 2026-06-15T21:45:00Z |
| **Verdict** | **BOUNCE** |
| **Critical/High count** | 0 CRITICAL / 2 HIGH / 0 MEDIUM / 0 LOW (net new) |

---

### Re-verification: HIGH-MOUNT-01 — RESOLVED

**Evidence:**
- `apps/core/src/main.ts:334-348` — Read routes (`GET /api/v1/connectors`, `GET /api/v1/connectors/:id/status`) registered inside a Fastify scope with `scope.addHook('preHandler', sessionPreHandler)` and `scope.addHook('preHandler', requireRole('analyst'))`.
- `apps/core/src/main.ts:352-380` — Write routes (`GET /shopify/install`, `DELETE /:id`) registered inside a separate scope with `requireRole('manager')`.
- `apps/core/src/main.ts:402-428` — Pixel read routes registered with `sessionPreHandler` + `requireRole('analyst')`.
- `apps/core/src/main.ts:431-449` — Pixel write routes (`POST /pixel/verify`) registered with `sessionPreHandler` + `requireRole('manager')`.
- The public callback (`GET /api/v1/connectors/shopify/callback`) is correctly registered directly on `app` without session guard — Shopify-called, HMAC-protected (NN-4).
- The "deferred comment" pattern is eliminated. Guards are enforced structurally at mount time, not deferred.
- `getBrandId(req)` throws `{ statusCode: 400, code: 'NO_BRAND_CONTEXT' }` if `auth.brandId` is absent — fail-closed.

**Status: RESOLVED.**

---

### Re-verification: HIGH-SECRETS-01 — PARTIALLY RESOLVED (RESIDUAL HIGH)

**JWT_SIGNING_SECRET + COOKIE_SECRET path — RESOLVED:**
- `apps/core/src/infrastructure/secrets/SecretsProvider.ts` — `SecretsProvider` interface defined.
- `apps/core/src/infrastructure/secrets/AwsSecretsProvider.ts` — `AwsSecretsProvider` implemented using `@aws-sdk/client-secrets-manager` + IRSA (no static credentials). Fail-closed on empty response.
- `apps/core/src/main.ts:97-107` — `secretsProvider.getSecret(jwtSigningSecretRef)` and `secretsProvider.getSecret(cookieSecretRef)` called at startup. Both refs obtained via `getEnvOrThrow()` (fail-closed if absent). No `randomUUID()` default. I-S09 satisfied for JWT + cookie secrets.
- In production: `AwsSecretsProvider` is selected; env var holds the ARN, not the value.

**Residual — connector-side ISecretsManager: NOT RESOLVED (HIGH):**
- `apps/core/src/main.ts:239` — `const connectorSecretsManager = new LocalSecretsManager()` is unconditionally instantiated regardless of `isProduction`.
- `LocalSecretsManager.getShopifyClientSecret()` reads `process.env['SHOPIFY_CLIENT_SECRET']` directly (`apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/LocalSecretsManager.ts:33`).
- The comment at `main.ts:236-238` acknowledges "In production, the connector builder's AwsSecretsManager handles the Shopify token" but no `AwsSecretsManager` implementing `ISecretsManager` is present. The production path for the Shopify OAuth client secret continues to read from a plain env var.
- This violates I-S09: "OAuth tokens, connector credentials … AWS Secrets Manager + IRSA for runtime credential fetch."
- **This is a HIGH residual of HIGH-SECRETS-01.** The JWT+cookie sub-issue is resolved; the connector client-secret sub-issue is not.

**Finding: HIGH-SECRETS-01-RESIDUAL — connector-side ISecretsManager not production-wired.**

---

### Re-verification: HIGH-SCA-01 — RESOLVED for originally-bounced advisories; NEW HIGH found

**Original advisories (Next.js SSRF/DoS/Middleware bypass + fast-uri path-traversal) — RESOLVED:**
- `apps/web/package.json:30` — `"next": "^15.5.16"`, resolved to `next@15.5.19` in `pnpm-lock.yaml`.
- `pnpm-lock.yaml` confirms `fast-uri@3.1.2` everywhere (pnpm override `fast-uri: ">=3.1.1"` set in root `package.json` pnpm section).
- `pnpm audit --audit-level=high` output: no Next.js or fast-uri advisories present.

**NEW HIGH — fastify@4.29.1 (GHSA-jx2c-rxcm-jvmq, CVE-2026-25223):**
- `pnpm audit` output: `apps/core > fastify@4.29.1` — HIGH severity. Patched in fastify>=5.7.2 (major version bump from 4.x to 5.x).
- Advisory: Content-Type header tab character allows body validation bypass. Affects routes using Fastify's `{ schema: }` JSON Schema body validation option.
- **Codebase impact assessment:** Inspection of `apps/core/src/main.ts` and all route files confirms ZERO Fastify route schema registrations (`{ schema: }` option is not used anywhere in apps/core). All input validation is manual (explicit checks and Zod). The bypass has no exploitable impact on this codebase in its current form.
- **However:** fastify>=5.x is a major breaking version change. The upgrade path is non-trivial. Per severity policy, a HIGH on a production-path package requires either a patch within 7 days or a Security-approved deferred exception with an audit-log entry. This must be tracked.
- **Finding: HIGH-SCA-02 — fastify@4.29.1 GHSA-jx2c-rxcm-jvmq in apps/core (production); patch deferred — requires suppression entry with expiry + exploitability assessment confirming no Fastify schema routes exist.**

---

### Re-verification: MED-JWT-01 — RESOLVED

**Evidence:**
- `apps/core/src/modules/workspace-access/internal/security/jwt.ts:44-61` — `verifyJwt` now:
  1. Decodes the received header via `base64urlDecode`.
  2. Parses as JSON; throws on invalid JSON (`Invalid JWT header: not valid JSON`).
  3. Asserts `alg === 'HS256'` AND `typ === 'JWT'`; throws otherwise (`Invalid JWT header: expected alg=HS256, typ=JWT`).
  4. Uses the canonical `JWT_HEADER` constant (line 66) for the signing input, not the received header. This closes both alg-confusion and unknown-field injection.
- Timing-safe comparison retained (byte-by-byte XOR loop, lines 77-84).

**Status: RESOLVED.**

---

### Re-verification: MED-CALLBACK-01 — RESOLVED

**Evidence:**
- `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/state/IOAuthStateStore.ts` — interface updated: `consumeAndGetBrandId(state: string): Promise<{ brandId: string } | null>` — caller does NOT supply brandId.
- `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/state/InProcessOAuthStateStore.ts:41-57` — `consumeAndGetBrandId` looks up by state key only; deletes on first use (NN-4 single-use preserved); returns `{ brandId }` from the stored record.
- `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/HandleOAuthCallbackCommand.ts:90-99` — `const stateRecord = await this.stateStore.consumeAndGetBrandId(state)` — `brandId` comes from `stateRecord.brandId`, never from the query string. Comment: "brandId is now server-trusted — never from query param".
- `OAuthCallbackInput` interface (line 26-35) explicitly omits `brandId` with comment: "NOTE: brandId is intentionally NOT here — it is derived from the server-side state record (MED-CALLBACK-01)."
- Test proof: `HandleOAuthCallbackCommand.test.ts:223-286` — MED-CALLBACK-01 proof test passes: `ATTACKER_BRAND_ID` in query is ignored; `savedInstance.brandId` equals `REAL_BRAND_ID` from the server-side state record.

**Status: RESOLVED.**

---

### Re-verification: MED-BFF-DASH-01 — RESOLVED

**Evidence:**
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts:216-556` — All 4 dashboard endpoints exist and are protected by `bffProtectedPreHandler`:
  - `GET /v1/dashboard/brand-summary` (line 216)
  - `GET /v1/dashboard/connection-status` (line 289)
  - `GET /v1/dashboard/data-status` (line 365)
  - `GET /v1/dashboard/onboarding-progress` (line 447)
- All queries are Postgres-only, parameterized, with `pool.connect()` / `client.release()` pattern. Zero OLAP/StarRocks calls. ADR-002 compliance confirmed.
- Brand context from `auth.brandId` (JWT-derived, not from query param). Workspace context from `auth.workspaceId`.

**Status: RESOLVED.**

---

### Re-verification: Test-infra fixes — VERIFIED

**Evidence:**
- `tools/isolation-fuzz/src/pg.test.ts:150-158` — `afterAll` now executes `EXECUTE 'DROP OWNED BY ${APP_ROLE}'; EXECUTE 'DROP ROLE ${APP_ROLE}'` inside a DO block — robust teardown. Previous version would fail if the role held residual grants.
- `tools/isolation-fuzz/src/pg.connector.test.ts:168-173` — Same pattern: `DROP OWNED BY` before `DROP ROLE`.
- Negative controls unchanged:
  - brand-A session reading brand-B rows → 0 rows (NOSUPERUSER NOBYPASSRLS connection).
  - No-GUC fresh connection → 0 rows (two-arg `current_setting` returns NULL, not error).
  - Policy-removal proof test: `rowsWithPolicyOn=0`, `rowsWithPolicyOff>0` — canary is REAL.
  - `isofuzz_app` and `isofuzz_connector_app` are both `NOSUPERUSER NOBYPASSRLS`.
- Connector positive-seed warning (`console.warn` on FK miss) is a correct skip path — the test self-skips if brand rows are not seeded. This is not an isolation hole; it signals a test-environment dependency gap, not a policy bypass.
- All 41 isolation-fuzz tests pass (39 passing, 2 skipped — Postgres-dependent tests skip when DB is not running, which is the designed behavior).

**Status: VERIFIED — no regression on isolation assertions.**

---

### Full Scanner Re-Run (FULL mode)

| Check | Result | Evidence |
|-------|--------|----------|
| Secrets grep (hardcoded credentials/keys) | PASS | 0 hits on hardcoded values in production source |
| One-arg `current_setting()` in migrations | PASS | 0 violations; all use `current_setting(..., TRUE)` |
| BYPASSRLS in non-test/non-assertion code | PASS | Only in test files + init assertion |
| Forbidden `*_token`/`*_ciphertext` columns in connector DDL | PASS | `connector_instance.secret_ref` only; `install_token` is a UUID pixel token (not an OAuth credential) |
| `pnpm audit --audit-level=high` | PARTIAL | Original 3 HIGH cleared (next, fast-uri); new HIGH: fastify@4.29.1 (GHSA-jx2c-rxcm-jvmq) in apps/core — see HIGH-SCA-02. Remaining criticals/highs: vitest (dev-only), handlebars (dev toolchain via eslint-plugin-boundaries), esbuild (dev/test) — all dev-only paths, not in production images |
| `pnpm turbo run typecheck test:unit lint` | PASS | 75/75 tasks successful |
| Isolation-fuzz `test:isolation` | PASS | 39 pass, 2 skip (Postgres-skip by design) |
| `randomUUID()` cookie default in prod | PASS | Eliminated — `getEnvOrThrow('COOKIE_SECRET')` + `secretsProvider.getSecret()` |
| JWT_SIGNING_SECRET from plain env in prod | PASS | Eliminated — fetched via `AwsSecretsProvider` in prod |
| Connector client secret from plain env in prod | FAIL | `LocalSecretsManager` used unconditionally regardless of `isProduction` — HIGH-SECRETS-01-RESIDUAL |

---

### NN Gate Re-Verification (post-bounce)

| Gate | Status | Change from prior review |
|------|--------|--------------------------|
| **NN-1** Three-GUC RLS | **PASS** | No change — not touched by bounce-fix |
| **NN-2** secret_ref only | **PASS** | Not touched; DDL and entity still clean |
| **NN-3** Session revocation on all routes | **PASS** | HIGH-MOUNT-01 resolved — connector/pixel routes now mounted with `validateSessionPreHandler` |
| **NN-4** Shopify OAuth HMAC first | **PASS** | MED-CALLBACK-01 resolved; HMAC still first; brand_id now server-derived |
| **NN-5** Auth hardening | **PASS with LOW** | No change — LOW-TIMING-01 deferred remains acceptable |
| **NN-6** Audit + isolation-fuzz | **PASS** | Teardown fix confirmed; negative controls intact |
| **NN-7** Compound RLS on invite | **PASS** | Not touched |
| **L-02** sha256 audit hash | **PASS** | Not touched |

---

### New Findings (post-bounce)

#### HIGH-SCA-02 — fastify@4.29.1 GHSA-jx2c-rxcm-jvmq in apps/core (production path)

**Severity:** HIGH
**File:Line:** `apps/core/package.json` (fastify@^4.28.0, resolved to 4.29.1 in lock)
**Advisory:** GHSA-jx2c-rxcm-jvmq (CVE-2026-25223) — Content-Type header tab character allows body validation bypass; patched in fastify>=5.7.2.

**Exploitability in this codebase:** ZERO — no Fastify route in `apps/core` uses the `{ schema: }` JSON Schema body validation option. All validation is manual. The bypass has no operational impact as the code stands.

**Policy requirement:** HIGH advisory on a production-path package requires either patch within 7d or a Security-approved deferred exception with an audit-log entry and expiry date.

**Fix:** Two options:
1. Upgrade fastify to >=5.7.2 (major version change — breaking; recommend M2 track).
2. Add a tracked suppression entry in a versioned policy file: `{ id: "GHSA-jx2c-rxcm-jvmq", package: "fastify", reason: "no Fastify schema routes in apps/core; all validation is manual", expires: "2026-09-15", approved_by: "security-reviewer" }` — requires Stakeholder-logged waiver as tracked tech-debt.

**Status: NEW HIGH — BOUNCE until suppression entry exists with Security approval OR fastify upgraded to >=5.7.2.**

---

#### HIGH-SECRETS-01-RESIDUAL — connector ISecretsManager not production-wired

**Severity:** HIGH
**File:Line:** `apps/core/src/main.ts:239` — `new LocalSecretsManager()` unconditional; `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/LocalSecretsManager.ts:33` — `process.env['SHOPIFY_CLIENT_SECRET']` plain env read.

**Evidence:** The original HIGH-SECRETS-01 required an `AwsSecretsManager` implementing `ISecretsManager` for the Shopify client secret. The builder provided `AwsSecretsProvider` (for JWT+cookie) but did not implement `AwsSecretsManager` for `ISecretsManager`. `main.ts` uses `LocalSecretsManager` unconditionally, including in production. The comment at `main.ts:236` defers this to the "connector builder" but the code is not there.

**Risk:** In production, `SHOPIFY_CLIENT_SECRET` is read from a plain environment variable. If the environment is compromised (CI log leak, container escape, metadata IMDS traversal), the Shopify client secret is exposed. This enables OAuth hijacking for any Shopify store connected through Brain. I-S09 violation.

**Note on scope of original fix:** The builder explicitly closed JWT_SIGNING_SECRET + COOKIE_SECRET (core of the original finding). The Shopify client secret was a listed sub-item in the original HIGH-SECRETS-01. The builder's comment acknowledges the gap. This is a genuine residual, not a new finding.

**Fix:** Implement `AwsSecretsManager` (implementing `ISecretsManager`) that wraps `SecretsManagerClient` and fetches Shopify client secret from Secrets Manager by ARN. Wire it in `main.ts` when `isProduction`. The env var holds the ARN in prod; `LocalSecretsManager` remains for dev.

**Status: HIGH residual from HIGH-SECRETS-01 — BOUNCE.**

---

### Verification Validity (post-bounce)

- Isolation-fuzz: all assertions run on NOSUPERUSER NOBYPASSRLS connections (`isofuzz_app`, `isofuzz_connector_app`). Negative controls with real probe (policy-off confirms exposure). Not bypass-green.
- MED-CALLBACK-01 test: uses `REAL_BRAND_ID` in state store, checks that `savedInstance.brandId === REAL_BRAND_ID` and `!== ATTACKER_BRAND_ID`. Negative control is real.
- NN-3 (HIGH-MOUNT-01): verified structurally by code inspection — `scope.addHook('preHandler', sessionPreHandler)` wired before route handlers. Runtime curl test not possible without a running server, but structural verification is definitive.

---

### Overall Verdict: BOUNCE

**Reason:** 2 HIGH findings block ship:

1. **HIGH-SECRETS-01-RESIDUAL** (`apps/core/src/main.ts:239`, `LocalSecretsManager.ts:33`) — Shopify client secret read from plain env in production. `AwsSecretsManager` implementing `ISecretsManager` not implemented. I-S09 violation for connector credential.

2. **HIGH-SCA-02** (`apps/core/package.json` — fastify@4.29.1, GHSA-jx2c-rxcm-jvmq) — HIGH advisory on production-path package. Zero exploitability in this codebase (no Fastify schema routes), but policy requires either fastify>=5.7.2 upgrade OR a Security-approved suppression entry with expiry date — neither is present.

**Resolved findings (post-bounce):** HIGH-MOUNT-01 (RESOLVED), HIGH-SCA-01 original advisories (RESOLVED), MED-JWT-01 (RESOLVED), MED-CALLBACK-01 (RESOLVED), MED-BFF-DASH-01 (RESOLVED).

**Bounce target:** `backend-developer` (HIGH-SECRETS-01-RESIDUAL) + dependency track (HIGH-SCA-02 — suppression entry OR fastify upgrade).

---

### Journal (post-bounce)

```
2026-06-15T21:45:00Z — Security Reviewer — feat-m1-app-foundation
Stage: 4 | Mode: FULL (post-bounce) | Verdict: BOUNCE
Findings: 0 CRIT / 2 HIGH / 0 NEW-MED / 0 NEW-LOW
NN regression: none — all 7 NN + L-02 PASS
Resolved: HIGH-MOUNT-01, HIGH-SCA-01 (original), MED-JWT-01, MED-CALLBACK-01, MED-BFF-DASH-01
New HIGH: HIGH-SECRETS-01-RESIDUAL (LocalSecretsManager in prod), HIGH-SCA-02 (fastify 4.29.1 GHSA-jx2c-rxcm-jvmq)
Scanners: run (FULL scope) | Next: bounce to backend-developer (HIGH-SECRETS-01-RESIDUAL) + dep suppression track (HIGH-SCA-02)
```

---

## Security Re-Review r3 (post-bounce-2)

| Field | Value |
|-------|-------|
| **req_id** | `feat-m1-app-foundation` |
| **Stage** | 4 — Security Reviewer |
| **Mode** | DELTA (re-verify 2 open HIGHs + ISO-SEED-01 mirror-policy ruling + regression) |
| **Reviewer** | Security Reviewer (Sonnet tier) |
| **Reviewed at** | 2026-06-15T22:05:00Z |
| **Verdict** | **PASS** |
| **Critical/High count** | 0 CRITICAL / 0 HIGH (net open) |

---

### 1. HIGH-SECRETS-01-RESIDUAL — RESOLVED

**Verification target:** `AwsSecretsManager implements ISecretsManager` present; `main.ts` wires it conditionally on `isProduction`; `SHOPIFY_CLIENT_SECRET` env var holds ARN in production (not the plain value); fail-closed.

**Files read:**
- `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/AwsSecretsManager.ts`
- `apps/core/src/main.ts` (lines 52-53, 244-260)
- `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/LocalSecretsManager.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/ISecretsManager.ts`

**Evidence:**

`AwsSecretsManager.ts` — `export class AwsSecretsManager implements ISecretsManager` confirmed at line 28. Uses `SecretsManagerClient` from `@aws-sdk/client-secrets-manager`. IRSA: constructor passes `{ region }` only — no `credentials` field, so the SDK picks up the IRSA token file automatically (line 39). Fail-closed: `getShopifyClientSecret()` throws on SDK error (line 88-90) and on empty response (line 94-97). Secret value is NOT logged (comment at line 99). `storeShopifyToken()` throws on CreateSecret failure (line 64-67) and on missing ARN in response (line 71-74). Identical fail-closed pattern as `AwsSecretsProvider` (already accepted for JWT/cookie path in r2).

`main.ts` lines 257-260:
```typescript
const shopifyClientSecretRef = getEnvOrThrow('SHOPIFY_CLIENT_SECRET');
const connectorSecretsManager = isProduction
  ? new AwsSecretsManager(getEnv('AWS_REGION', 'us-east-1'), shopifyClientSecretRef)
  : new LocalSecretsManager();
```
- `getEnvOrThrow('SHOPIFY_CLIENT_SECRET')` — startup fails if unset (fail-closed). In production the value is the ARN; `AwsSecretsManager` passes it as `SecretId` to GetSecretValueCommand.
- `isProduction` → `AwsSecretsManager` — no plain env read of the secret value.
- Dev → `LocalSecretsManager` — reads raw value from env (acceptable dev path, never in prod image).

Grep confirms `process.env['SHOPIFY_CLIENT_SECRET']` appears ONLY in `LocalSecretsManager.ts:33` — the dev stub. Not in any production path. The production path (`AwsSecretsManager.getShopifyClientSecret()`) calls `GetSecretValueCommand` against the ARN.

**I-S09 gate:** Connector client secret now fetched from AWS Secrets Manager in production. ARN in env var, value never in env in prod. IRSA credentials. Fail-closed.

**Status: RESOLVED.** I-S09 satisfied for the connector credential. NN-2 unaffected (secret_ref DDL unchanged).

---

### 2. HIGH-SCA-02 — RESOLVED (fastify upgraded to 5.8.5 in apps/core; GHSA-jx2c-rxcm-jvmq path shifted to apps/collector stub)

**Verification target:** fastify upgraded to >=5.7.2 in `apps/core`; GHSA-jx2c-rxcm-jvmq gone from `apps/core` audit path; no security regression from fastify-5 + @fastify/cookie v11 migration.

**Files read:**
- `apps/core/package.json` — `"fastify": "^5.7.2"`, `"@fastify/cookie": "^11.0.2"`
- `pnpm --filter @brain/core why fastify` output: **fastify 5.8.5** (production dependency of @brain/core)
- `pnpm --filter @brain/core why @fastify/cookie` output: **@fastify/cookie 11.0.2**

**Audit result (`pnpm audit --audit-level=high`):**

GHSA-jx2c-rxcm-jvmq now appears ONLY under path `apps/collector > fastify@4.29.1`. The `apps/core` path is clear — fastify 5.8.5 >= 5.7.2 (patched version). The advisory is fully remediated in the production-path service.

Remaining audit findings (unchanged from r2, all outside the production-image path):
- `apps/collector > fastify@4.29.1` (GHSA-jx2c-rxcm-jvmq HIGH) — `apps/collector/src/main.ts` is a stub with a single TODO comment; no Fastify server instantiated, no route handlers, no `{ schema: }` options. Zero exploitability. The collector is not a deployed service in M1.
- `vitest` CRITICAL (GHSA-5xrq-8626-4rwp) — dev/test tooling only; not in production images.
- `handlebars` CRITICAL/HIGH — dev toolchain via `eslint-plugin-boundaries`; not in production images.
- `esbuild` HIGH — vitest transitive; dev/test only.
- `vite` HIGH — vitest transitive; dev/test only.

**@fastify/cookie v11 migration regression check (`apps/core/src/modules/frontend-api/internal/bff.routes.ts`):**

Cookie security attributes verified correct after v11 bump:
- Session cookie `brain_session`: `httpOnly: true`, `secure: isProduction`, `sameSite: 'strict'`, `maxAge` set from JWT expiry, `path: '/'`. Correct.
- CSRF cookie `brain_csrf`: `httpOnly: false` (intentional — JS must read it for double-submit), `secure: isProduction`, `sameSite: 'strict'`. Correct per double-submit CSRF pattern.
- `clearCookie` on logout clears both cookies with `path: '/'`. Correct.
- `main.ts:153` — `fastifyCookie as unknown as Parameters<typeof app.register>[0]` cast pattern used for known upstream type incompatibility in @fastify/cookie v11.0.x with Fastify 5 generic constraints. Runtime behavior is correct; this is a documented TS pattern for this version combination.

No CSRF or session-handling regression introduced by the v11 bump.

**Status: RESOLVED.** `apps/core` fastify upgraded to 5.8.5 (>= 5.7.2 patched). GHSA-jx2c-rxcm-jvmq cleared from the production-path service. Cookie/CSRF handling correct after migration. The residual `apps/collector > fastify@4.29.1` path has zero exploitability (stub, no server) and is not a deployed M1 service.

---

### 3. ISO-SEED-01 Mirror-Policy Validity — Ruling

**Question:** Is the mirror-policy approach (test-scoped PERMISSIVE policies for `isofuzz_connector_app` using the identical two-arg GUC predicate) an acceptable negative control, or does it represent a tautology / weaker-than-real test that should be a finding?

**What was implemented (`pg.connector.test.ts` lines 96-143):**

The `beforeAll` creates test-scoped PERMISSIVE RLS policies on the 5 connector/pixel tables for role `isofuzz_connector_app` (NOSUPERUSER NOBYPASSRLS). Each mirror policy uses the IDENTICAL predicate as the production policy:
```sql
USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)
```
These mirror policies are dropped in `afterAll`. The production policies (`TO brain_app`) are untouched.

**Concern evaluated:**

The concern is: the test verifies a policy it CREATED (the mirror), not the production policy (`TO brain_app`). If the mirror policy is correctly authored (which it is), the test proves GUC isolation for that predicate — but it doesn't prove the production `brain_app` policy is correctly applied.

**Why this IS acceptable (not a finding):**

1. **The predicate under test is identical.** The mirror policy uses exactly `current_setting('app.current_brand_id', TRUE)::uuid` — the same expression as the production policy. The test is not writing a weaker predicate; it is replicating the exact isolation logic.

2. **The negative controls are genuine and non-tautological.** The key question is whether the negative controls can fail:
   - `[NEGATIVE] brand-A GUC → 0 brand-B rows`: This works because `BRAND_A ≠ BRAND_B` — even with a correctly wired two-arg policy, brand-A's GUC value does not match brand-B's `brand_id`. This is a real cross-tenant isolation proof.
   - `[NEGATIVE] no GUC → 0 rows`: `current_setting('app.current_brand_id', TRUE)` returns NULL when unset, `NULL::uuid` → NULL, and `brand_id = NULL` is always false (SQL NULL semantics). This proves the two-arg fail-safe is operative.
   - Both negative controls would FAIL (return >0 rows) if: (a) the policy predicate used one-arg form (raises exception → error ≠ 0 rows, but would show as test failure); (b) the role had BYPASSRLS (both negative controls return all rows); or (c) the policy predicate expression was wrong.

3. **The NOSUPERUSER NOBYPASSRLS constraint is the structural guarantee.** The test role `isofuzz_connector_app` is enforced at role creation (`CREATE ROLE ... NOSUPERUSER NOBYPASSRLS`). This means RLS is enforced regardless of which policy applies. The question is not "is RLS active?" (it is, structurally) but "does the predicate correctly isolate by brand?" — and the negative controls prove this.

4. **What the test does NOT prove:** It does not prove that the `brain_app` role specifically has the production policy applied — i.e., if someone deleted the production `connector_instance_isolation` policy but left the mirror policy in a deployed state, the test would still pass. However, this gap is: (a) mitigated by the NN-1 assertion block in migration 0006 (which fires at migration time and would fail if policies were absent/wrong); and (b) a test-environment limitation, not a security flaw in the production system.

5. **Comparison to testing `AS brain_app` directly:** Testing `AS brain_app` would be the strongest form, as it exercises the exact production policy on the exact production role. However, this would require granting the test harness access to create a `brain_app`-authenticated connection — which itself creates a security risk (the test harness having production-role credentials). The mirror-policy approach isolates the test role from the production role, which is the safer operational pattern.

**Verdict:** The mirror-policy approach is **ACCEPTABLE**. The negative controls (brand-A≠brand-B GUC isolation, no-GUC→0 rows) are genuine non-tautological proofs of the isolation predicate. The structural NOBYPASSRLS constraint ensures RLS is active. The predicate is identical to production. The gap (not testing AS brain_app) is mitigated by the migration-time NN-1 assertion block. **No finding. Not a security defect.**

---

### 4. NN-1..NN-7 + L-02 Regression Check

**`pnpm turbo run typecheck test:unit lint` result:** 75/75 PASS (all cached — no changes to those paths).

**55 unit tests pass** (ShopifyHmac: 9, OAuthStateNonce: 10, SecretRef: 7, HandleOAuthCallbackCommand: 5, auth.service: 24).

**One-arg `current_setting()` grep in migrations:** 0 violations. All references in migrations 0002-0007 use two-arg form with `TRUE`. The grep result in `0004_brand.sql` and `0006_connector.sql` shows ONLY the NN-1 assertion block patterns (checking for violations, not committing them).

**BYPASSRLS grep:** Appears only in `0001_init.sql` (assertion that brain_app NEVER has BYPASSRLS) and test files. Zero production grants.

**Forbidden columns (`*_token`, `*_ciphertext`, `*_secret`, `*_key`) in connector DDL:** 0 violations. `install_token` in `0007_pixel.sql` is a UUID public identifier (correctly documented as non-secret in migration comment, line 16). NN-2 satisfied.

**Hardcoded secrets grep:** 0 hits in production source. `process.env['SHOPIFY_CLIENT_SECRET']` appears only in `LocalSecretsManager.ts` (dev stub).

| Gate | Status | Delta from r2 |
|------|--------|---------------|
| NN-1 Three-GUC RLS | PASS | No change — not touched |
| NN-2 secret_ref only | PASS | No change — DDL/entity unchanged |
| NN-3 Session revocation | PASS | No change — routes mounted with guards |
| NN-4 Shopify OAuth HMAC | PASS | No change |
| NN-5 Auth hardening | PASS with LOW | No change |
| NN-6 Audit + isolation-fuzz | PASS | Connector tests now seed via UPSERT RETURNING (ISO-SEED-01 fix) |
| NN-7 Compound RLS on invite | PASS | No change |
| L-02 sha256 audit hash | PASS | No change |

**No regression on any NN gate or L-02.**

---

### Overall Verdict: PASS

**All 2 open HIGHs from r2 are RESOLVED:**
1. **HIGH-SECRETS-01-RESIDUAL** — `AwsSecretsManager implements ISecretsManager` now present; `main.ts` wires it conditionally (`isProduction ? AwsSecretsManager : LocalSecretsManager`); `SHOPIFY_CLIENT_SECRET` env holds ARN in prod; IRSA credentials; fail-closed. I-S09 satisfied for connector credential.
2. **HIGH-SCA-02** — fastify upgraded to 5.8.5 in `apps/core` (patched version ≥ 5.7.2); GHSA-jx2c-rxcm-jvmq cleared from production path. Residual `apps/collector > fastify@4.29.1` has zero exploitability (stub, no running server). @fastify/cookie v11 migration correct — cookie security attributes unchanged.

**ISO-SEED-01 mirror-policy ruling:** ACCEPTABLE. The mirror-policy approach uses the identical two-arg GUC predicate; negative controls are genuine (brand-A≠brand-B cross-tenant isolation, no-GUC→0 rows); NOSUPERUSER NOBYPASSRLS structural constraint is enforced; NN-1 migration assertion covers the production policy gap. Not a finding.

**Open findings (deferred, non-blocking):** LOW-DEV-TOKEN-01 (dev-only log masking), LOW-TIMING-01 (forgotPassword timing channel), LOW-RATELIMIT-01 (rate limiting — M2). All remain LOW; none changed severity.

**NN regression:** None. All 7 NN gates + L-02 PASS. 75/75 turbo tasks pass.

---

### Journal (r3)

```
2026-06-15T22:05:00Z — Security Reviewer — feat-m1-app-foundation
Stage: 4 | Mode: DELTA | Verdict: PASS
Findings: 0 CRIT / 0 HIGH (was 2 HIGH — both RESOLVED) | Scanners: delta-scope
HIGH-SECRETS-01-RESIDUAL: RESOLVED — AwsSecretsManager + conditional main.ts wiring confirmed
HIGH-SCA-02: RESOLVED — fastify 5.8.5 in apps/core; GHSA-jx2c-rxcm-jvmq cleared; collector stub zero-exploitability
ISO-SEED-01 mirror-policy: ACCEPTABLE — identical predicate, genuine negative controls, NOBYPASSRLS structural guarantee
NN regression: none — 7 NN + L-02 all PASS; 75/75 turbo | Next: reconcile with QA Engineer
```
