# Pass 10: Security Audit (Security)

## Board Verdict

The Brain V3 monorepo demonstrates solid foundational security hygiene: JWT algorithm-confusion is mitigated via a custom HS256-only verifier with timing-safe comparison; argon2id is enforced at startup parameters; refresh-token replay triggers atomic family-wipe; CSRF uses session-bound HMAC double-submit; RLS GUC middleware resets all three GUCs on pool checkout; audit_log is append-only at the GRANT level with sha256 hash-chain. However, five concrete, exploitable weaknesses were found. The most critical is that password reset does NOT revoke active sessions — an attacker who has stolen a session can remain active indefinitely even after the victim resets their password. A real Shopify partner client secret (`shpss_`) appears verbatim in the committed `.env` file on disk, though `.env` is gitignored and not in history; it is still a live credential exposure risk in the developer workflow. HTTP security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options) are absent from both the Next.js frontend and the Fastify API, constituting a concrete browser-exploitation surface. The StarRocks analytics password is hardcoded as a source-code default (`brain_analytics_dev`) in the production build artifact. The `dev_secret` Postgres table — which stores plaintext connector OAuth tokens — lacks RLS and has full DML grants to `brain_app`, making cross-tenant secret leakage possible if an RLS bug allows a cross-brand query to reach that table.

**Severity count: 1 Critical, 2 High, 1 Medium, 1 Low**

---

## Finding SEC-10-1

**title:** Password reset does not revoke active sessions — session hijackers survive credential rotation

**severity:** Critical

**category:** Broken Authentication / Session Management (OWASP A07)

**evidenceRef:** `apps/core/src/modules/workspace-access/internal/application/auth.service.ts:1121-1153`

**impact:** An attacker who has stolen a valid session token (via XSS, network interception, or device theft) retains full access to the account indefinitely, even after the victim changes their password via the forgot-password flow. The `resetPassword()` method (lines 1121–1153) only updates `password_hash` and marks the reset token used — it never calls `sessionRepo.revokeAllForUser()` or `sessionRepo.revoke()`. The victim has no way to evict the attacker; the attacker's JWT and refresh token remain active until they naturally expire (access = 1 hour, refresh = 7 days). Doc 06 §API contracts and doc 04 §F explicitly require credential changes to invalidate existing sessions.

**rootCause:** The `resetPassword` implementation was built around token single-use and password hash update only. Session revocation on password change was never added. The `logout(scopeAll=true)` and `revokeAllForUser` methods exist and work correctly but are not called from `resetPassword`.

**fix:** In `resetPassword()`, after `userRepo.updatePasswordHash()` succeeds, add `await sessionRepo.revokeAllForUser(token.appUserId, ctx)` and write a `sessions.bulk_revoked` audit entry with `reason: 'password_reset'`. Mirror the same pattern in `suspendUser()` which already handles this correctly (line 942–951). This is a single-file change in `auth.service.ts`.

**priority:** P0

**tenantImpact:** Single-user blast radius per incident, but affects every tenant; an account takeover in a multi-brand workspace exposes all brands that user has access to.

**detection:** No existing alert. Add a monitor: after `password_reset.completed` audit action, check for `user.logged_in` from a different IP within 15 min on the same user — this is the observable signal of a retained hijacked session.

---

## Finding SEC-10-2

**title:** Real Shopify partner client secret committed to on-disk `.env` file

**severity:** High

**category:** Sensitive Data Exposure / Secrets Management (OWASP A02)

**evidenceRef:** `/Users/rishabhporwal/Desktop/Brain V3/.env:12` — `SHOPIFY_CLIENT_SECRET=shpss_***REDACTED***`

**impact:** The value `shpss_***REDACTED***` follows the `shpss_` prefix pattern of a real Shopify partner client secret (Shopify app shared secret). This secret is used by `HandleOAuthCallbackCommand` to validate HMAC signatures on incoming Shopify OAuth callbacks and webhooks. If this secret is leaked (e.g., via a developer's machine being compromised, accidental inclusion in logs, or a future gitignore misconfiguration), an attacker can: (1) forge Shopify OAuth callbacks to connect arbitrary shops to any brand, and (2) craft valid HMAC-signed webhook payloads to inject arbitrary order/event data into the event pipeline. The `.env` file is gitignored and not in git history, but it exists on developer machines and in CI env var injection.

**rootCause:** The `.env` file is used for local development convenience. A real partner secret is being used in the dev environment rather than a sandbox/test app's credentials. The `.gitignore` correctly excludes `.env` but cannot protect against developer machine compromise or accidental CI inclusion.

**fix:** (1) Immediately rotate `shpss_***REDACTED***` via the Shopify Partner Dashboard. (2) Create a separate Shopify development app with its own non-production credentials; never use the production partner secret locally. (3) Add a gitleaks custom rule specifically matching `shpss_` prefix to the existing `.gitleaks.toml` (currently has `brain-aws-access-key` and `brain-jwt-secret` rules but no Shopify secret pattern). (4) Add a pre-commit hook that scans `.env` for `shpss_` patterns.

**priority:** P0

**tenantImpact:** All Shopify-connected tenants at risk if the secret is used for production webhooks/OAuth; an attacker can forge events for any brand.

**detection:** Monitor Shopify Partner Dashboard for unexpected app installations or webhook registrations. Add gitleaks `shpss_` rule to catch future instances.

---

## Finding SEC-10-3

**title:** No HTTP security headers — CSP, HSTS, X-Frame-Options, X-Content-Type-Options absent from all surfaces

**severity:** High

**category:** Security Misconfiguration (OWASP A05)

**evidenceRef:** `apps/web/next.config.js:1-50` (no `headers()` export with security headers); `apps/core/src/main.ts:195-213` (Fastify bootstrap — no `@fastify/helmet`, no manual security header registration); `apps/collector/src/main.ts:126-130` (same)

**impact:** Without CSP, any XSS vulnerability in the React frontend can execute arbitrary scripts with full session access. Without HSTS, browsers on initial visits can be downgraded to HTTP and session cookies intercepted. Without X-Frame-Options/CSP `frame-ancestors`, the dashboard can be framed by a malicious page (clickjacking). Without X-Content-Type-Options, a browser may MIME-sniff responses into executable content types. The `.engineering-os/memory/agents/platform.journal.md:57` explicitly lists "Pixel SDK CSP nonce injection" as deferred to M2 — this is a known gap that is now at production risk. The web app serves financial analytics data (revenue, attribution, journey) to authenticated users; a successful XSS would expose all of it.

**rootCause:** Security headers were deferred to M2 per the engineering OS platform journal. The Next.js `next.config.js` file has a `rewrites()` export but no `headers()` export. The Fastify apps register `@fastify/cookie` and `fastify-raw-body` but not `@fastify/helmet`.

**fix:** (1) Add `@fastify/helmet` to `apps/core` and `apps/collector` with at minimum `hsts`, `noSniff`, `frameguard`, `xssFilter` options. (2) Add a `headers()` export to `apps/web/next.config.js` returning `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` for all routes. (3) Implement CSP nonce injection for inline scripts in the Next.js middleware layer. These are runtime additions with no schema changes required.

**priority:** P1

**tenantImpact:** All tenants; any XSS attack on one user's session in a multi-brand workspace exposes all brands they can access.

**detection:** Run a browser security headers checker (e.g., securityheaders.com) against the staging deployment; absence of CSP, HSTS, and X-Frame-Options will be flagged.

---

## Finding SEC-10-4

**title:** StarRocks analytics password hardcoded as source default in production-compiled artifact

**severity:** Medium

**category:** Sensitive Data Exposure / Secrets Management (OWASP A02)

**evidenceRef:** `apps/core/src/main.ts:191` — `starrocksPassword: getEnv('STARROCKS_ANALYTICS_PASSWORD', 'brain_analytics_dev')`; also present in compiled artifact at `apps/core/dist/main.js:291` (same constant ships in the container image)

**impact:** If `STARROCKS_ANALYTICS_PASSWORD` is not set in the production environment, the application silently falls back to `brain_analytics_dev` and connects to StarRocks with that password. The comment at line 188-189 explains this was added to fix a 500 error in dev — but the default travels through the TypeScript compile and ships in the Docker container. An attacker with access to the compiled artifact (e.g., a container image) can extract this credential. The `brain_analytics` user is described as SELECT-only, limiting impact, but it exposes all Silver-tier analytical data (revenue, attribution, journey timelines) for all brands.

**rootCause:** `getEnv()` with a default was used instead of `getEnvOrThrow()`. The comment on line 188 acknowledges the password is a real dev credential (`IDENTIFIED BY 'brain_analytics_dev'`), but no production guard prevents the fallback from being used in prod if the env var is not set.

**fix:** Replace line 191 with `getEnvOrThrow('STARROCKS_ANALYTICS_PASSWORD')` so startup fails hard if the credential is not injected. Add a note in the Dockerfile/helm chart that this env var is mandatory. Mirror the pattern used for `JWT_SIGNING_SECRET` (line 142 uses `getEnvOrThrow`). The dev default should live only in `.env` or docker-compose, never in application source.

**priority:** P1

**tenantImpact:** Cross-tenant — the analytics user can read Silver-tier data across all brands if connected.

**detection:** Add a startup assertion: if `nodeEnv === 'production' && config.starrocksPassword === 'brain_analytics_dev'` throw a fatal error. This catches a misconfigured deployment before it serves any requests.

---

## Finding SEC-10-5

**title:** `dev_secret` table stores plaintext OAuth tokens without RLS; full DML granted to `brain_app`

**severity:** Low

**category:** Insecure Design / Data Exposure (OWASP A04)

**evidenceRef:** `db/migrations/0024_dev_secret.sql:20-35` — `CREATE TABLE IF NOT EXISTS dev_secret (name TEXT, secret_value TEXT NOT NULL ...)` with `GRANT SELECT, INSERT, UPDATE, DELETE ON dev_secret TO brain_app;`; `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/LocalSecretsManager.ts:44-62` (devPersist writes raw JSON credentials including `key_id`, `key_secret`, `webhook_secret` to this table)

**impact:** The `dev_secret` table stores raw connector OAuth tokens and API credentials (Shopify access tokens, Razorpay key_id/key_secret/webhook_secret) in plaintext as TEXT. The table has no RLS, no `brand_id` column, and grants full DML to `brain_app`. This is explicitly a dev-only pattern with a `NODE_ENV=production` hard-fail guard in `LocalSecretsManager`. However: (1) any query that reaches the `dev_secret` table under a compromised connection can read all brands' credentials without any RLS filter, (2) if the `LocalSecretsManager` production guard were ever bypassed (e.g., by misconfiguring `NODE_ENV`), production credentials would be stored in plaintext Postgres rows, (3) the table is included in the main migration sequence (`0024_dev_secret.sql`) which runs in all environments including production by default.

**rootCause:** The dev_secret table was designed as a cross-process dev convenience store (DEV-TOKEN-REACH pattern). It correctly has `LocalSecretsManager` production guards but the Postgres table itself has no production-guard at the schema level and ships in the migration that applies to all environments.

**fix:** (1) Add a migration-level guard: `DO $$ BEGIN IF current_setting('app.env', true) = 'production' THEN RAISE EXCEPTION 'dev_secret must not be migrated in production'; END IF; END $$;` before the table CREATE. (2) Consider extracting `0024_dev_secret.sql` to a dev-only migration profile that is excluded from production runs. (3) Add a `brand_id` column and RLS policy matching the standard `tenant_isolation` pattern, as defence-in-depth even if the table is dev-only.

**priority:** P3

**tenantImpact:** Dev-environment only if production guards hold; if guards fail, all tenant connector credentials are exposed.

**detection:** Add a production boot check: `SELECT COUNT(*) FROM dev_secret` — if this query succeeds in production, alert (the table should not exist there).
