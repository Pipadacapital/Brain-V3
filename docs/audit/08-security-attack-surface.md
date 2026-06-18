# PASS 10 — Security & Attack Surface Audit

**Auditor:** Independent principal security reviewer (no attachment to codebase)
**Scope:** OWASP Top 10 against actual code; authn (auth.service / JWT), authz/RBAC, secrets management, encryption, audit-log completeness, PII handling/hashing/masking, API security (rate limiting, input validation), injection, CSRF, the dev StarRocks weak-password footgun. Attack-surface map. Every finding cites repository evidence.
**Verdict:** Strong, defense-in-depth design with disciplined token/secret handling and HMAC-first webhook ordering. **One CRITICAL** (the production RLS GUC middleware never sets the GUC in-transaction, so it has never been validated against `brain_app`, and is structurally broken on the primary OLTP read path) and **one HIGH** (StarRocks analytics password silently defaults to a weak hardcoded dev credential in production with no fail-closed guard) gate a clean pass.

---

## Attack-Surface Map

| Surface | Entry | AuthN | AuthZ / Tenant Isolation | Notable controls |
|---|---|---|---|---|
| Auth REST (`/api/v1/auth/*`) | public | argon2id + JWT (HS256) | n/a (pre-tenant) | enumeration-safe, timing-equalised, rotating refresh + family-wipe |
| BFF (`/api/v1/bff/*`) | browser cookie | httpOnly `brain_session` → Bearer bridge | JWT claims (brand/workspace/role) | httpOnly+secure+sameSite=strict; double-submit CSRF bound to jti |
| Protected REST | Bearer / cookie | `validateSessionPreHandler` (DB revoke check) | `requireRole` (JWT claim) + RLS GUC | NN-3 session validation per request |
| OLTP (Postgres) | repositories | — | **3-GUC RLS via `@brain/db` createPool** | **BROKEN: SET LOCAL outside txn (FIND-SEC-01)** |
| OLAP (StarRocks) | metric-engine seam | mysql2 brain_analytics | app-level `brand_id=?` predicate injection (no engine row-policy in dev) | weak-pw default (FIND-SEC-02); sentinel-forget gap (FIND-SEC-05) |
| Shopify OAuth callback | public | HMAC-first + single-use state nonce | brand_id from server state, never query | NN-4 ordering enforced |
| Webhooks (Shopify/Razorpay/Shopflo) | public | HMAC-first (timingSafeEqual) | brand_id from DB row via SECURITY DEFINER fn, never header | raw-body HMAC, fast-ack |
| Secrets | AWS Secrets Manager (prod) / Local (dev) | IRSA | per-brand CMK key policy | prod hard-fail on missing KMS key; ARN-only in DB rows |
| Audit log | internal | — | app-level `WHERE brand_id` (RLS off, cross-brand SoR) | sha256 hash-chain, append-only GRANT |

---

## Findings

### FIND-SEC-01 — Production RLS GUC middleware issues `SET LOCAL` outside a transaction → GUC never in scope for the actual query; isolation path is unvalidated against `brain_app`
**Severity:** Critical | **Category:** A01 Broken Access Control / A06 Insecure Design (tenant isolation) | **Priority:** P0

**Evidence:** `packages/db/src/index.ts:194-211` — the production `createPool().connect().query()` hot path:
```ts
async query<T>(ctx, sql, params=[]) {
  const gucSql = buildContextGucSql(ctx);   // → "SET LOCAL app.current_brand_id = '...'"
  if (gucSql) { await rawClient.query(gucSql); }   // separate statement, NO BEGIN
  const result = await rawClient.query(sql, params); // separate statement, NO GUC in scope
  ...
}
```
`buildContextGucSql` (`packages/db/src/index.ts:118-133`) emits `SET LOCAL ...`. Postgres `SET LOCAL` only persists for the duration of the **surrounding transaction**; executed in autocommit mode it applies to nothing beyond its own (auto-committed) statement and Postgres emits `WARNING: SET LOCAL can only be used in transaction blocks`. The subsequent `rawClient.query(sql)` runs in a *fresh* implicit transaction with the GUC unset. Under the RLS predicate `xxx_id = current_setting('app.current_brand_id', true)::uuid` (e.g. `db/migrations/0004_brand.sql`), the two-arg form returns NULL → `xxx_id = NULL` → **0 rows**.

The sibling engine path was explicitly fixed for exactly this: `packages/metric-engine/src/deps.ts:8-13,39-60` wraps every GUC set in `BEGIN/COMMIT` ("the GUC's is_local=true scope only holds within a transaction; under autocommit it can reset on connection return"). The OLTP `createPool` middleware that backs `AuthService`, `WorkspaceService`, `InviteService`, and all BFF reads (`apps/core/src/main.ts:371,435,436,458,477`) was **never given the same fix**.

**Why it's CRITICAL and not merely fail-closed cosmetic:** the live RLS proofs all wrap `set_config` in `BEGIN` and therefore never exercise the real `createPool` code path — `tools/isolation-fuzz/src/pg.test.ts:173-176` ("SET LOCAL must be inside a transaction to scope the GUC to just this query" → `await c.query('BEGIN')`), and `tools/isolation-fuzz/src/ai-provenance.test.ts:152,171,188` / `attribution-credit-ledger.test.ts:162` all `BEGIN` first. `packages/db/src/rls.test.ts` is a pure stub simulation (lines 154-164 fabricate the RLS result). So the production isolation mechanism for the OLTP read path has **zero passing test that runs the actual `createPool.query()` under `brain_app`**. In dev, `DATABASE_URL=postgres://brain:brain@...` (`.env.example:2`) is the BYPASSRLS superuser, which masks the defect entirely (every query returns rows regardless of GUC). The net result: an isolation control that is asserted everywhere in comments (NN-1) but is structurally inoperative on its primary code path and unproven under the prod role. Any future change that grants `brain_app` BYPASSRLS, or any table where RLS is `ENABLE`d but not `FORCE`d for the table owner, flips this from fail-closed to fail-open cross-tenant read.

**Impact (production):** On day-one prod cutover to `brain_app`, every brand/workspace-scoped repository read returns 0 rows (auth context resolution, membership lookups, brand reads) → total functional outage; if mitigated by hot-patching `brain_app` to BYPASSRLS (the likely incident reflex), tenant isolation on the OLTP tier collapses to application-WHERE-clause-only with no datastore backstop — a single missing `WHERE brand_id` becomes a cross-tenant data breach.

**Root Cause:** `SET LOCAL` chosen for GUC scoping without wrapping the GUC-set + business query in one explicit transaction on the pooled connection; the fix applied to `metric-engine/deps.ts` was not back-ported to `@brain/db`.

**Recommended Fix:** In `createPool().connect().query()`, wrap the GUC set and the business query in one transaction on the same client (`BEGIN; SET LOCAL ...; <query>; COMMIT;`), OR use `SELECT set_config(name, val, true)` only inside an explicit `withBrandTxn`-style wrapper (mirror `deps.ts:39-60`), OR switch to `SET` (session-scoped) with a guaranteed `RESET ALL` on release. Then add a live test that runs the **real** `createPool` instance (not a stub, not a hand-rolled `BEGIN`) against Postgres as `brain_app` and asserts cross-brand reads return 0 rows. Until then this is a non-validated control.

**Tenant Impact:** Multi-tenant — blast radius is every brand/workspace on the OLTP tier.
**Detection:** Today: invisible (dev superuser masks it; no test exercises the path). In prod: mass "0 rows / not found" errors on auth/membership reads at cutover, or — post-hot-patch — silent cross-tenant reads with no alert.

---

### FIND-SEC-02 — StarRocks analytics password silently defaults to the weak hardcoded dev credential `brain_analytics_dev` in production (no fail-closed guard)
**Severity:** High | **Category:** A02 Security Misconfiguration / A07 Auth Failures | **Priority:** P1

**Evidence:** `apps/core/src/main.ts:191`:
```ts
starrocksPassword: getEnv('STARROCKS_ANALYTICS_PASSWORD', 'brain_analytics_dev'),
```
The default is the literal dev password created in `db/starrocks/bootstrap.sql:12` — `CREATE USER ... 'brain_analytics'@'%' IDENTIFIED BY 'brain_analytics_dev'`. Unlike the JWT signing key, cookie secret, and connector KMS key — which **hard-fail** when absent in production (`apps/core/src/main.ts:142-143` `getEnvOrThrow`, and `:531` `if (isProduction && !process.env['CONNECTOR_SECRETS_KMS_KEY_ID']) throw`) — `STARROCKS_ANALYTICS_PASSWORD` has **no `isProduction` guard**. If the env var is unset/misconfigured in prod, the core silently connects to the Silver tier with the publicly-known dev password.

**Impact (production):** A misconfigured deploy connects to the OLAP store (all brands' Silver order-state, touchpoints, journey data) with a credential that is hardcoded in the repo. Combined with FIND-SEC-05 (no engine row-policy in dev image / sentinel-dependent predicate), an attacker who reaches port 9030 with this credential reads cross-brand commerce data. Silent — no startup failure flags the weak credential.

**Root Cause:** Convenience default added to avoid `ER_ACCESS_DENIED` on fresh `pnpm dev` (per the inline comment at `:187-190`) without an accompanying production fail-closed branch.

**Recommended Fix:** Mirror the KMS guard: `if (isProduction && (!process.env['STARROCKS_ANALYTICS_PASSWORD'] || process.env['STARROCKS_ANALYTICS_PASSWORD'] === 'brain_analytics_dev')) throw new Error(...)`. Resolve the StarRocks password via `secretsProvider.getSecret(...)` in prod (same as JWT/cookie), not a raw env default.

**Tenant Impact:** Multi-tenant — the OLAP credential is global across all brands.
**Detection:** No current detection. Would surface only via a StarRocks audit log of `brain_analytics` logins from prod with the dev password, or a pentest reaching :9030.

---

### FIND-SEC-03 — `root` (no password) used for StarRocks bootstrap; dev brokers/stores ship weak/default credentials with no network isolation in compose
**Severity:** Medium | **Category:** A02 Security Misconfiguration | **Priority:** P2

**Evidence:** `docker-compose.yml:102` runs `mysql -h starrocks -P 9030 -u root` (no `-p`, StarRocks `root` has empty password by default and the bootstrap never sets one — `db/starrocks/bootstrap.sql` has no `SET PASSWORD FOR root`). Other dev defaults: `POSTGRES_PASSWORD: brain` (`:21`), `MINIO_ROOT_PASSWORD: brainbrain` (`:49`), `GF_SECURITY_ADMIN_PASSWORD: brain` (`:265`). These are dev-compose values, but `root`-with-no-password on the analytics engine is the same engine that holds all-brand Silver/Gold data, and the bootstrap GRANTs are applied as this unauthenticated root.

**Impact (production):** If the dev compose topology is ever lifted toward a shared/staging environment (a common path), `root`/empty on :9030 is a full-control unauthenticated path to all tenants' analytics. In pure local dev it is low risk but normalizes a dangerous default.

**Root Cause:** allin1 StarRocks dev image ships root/empty; bootstrap never hardens it.

**Recommended Fix:** Document that compose is local-only and never network-exposed; if any shared use is contemplated, set a `root` password in bootstrap and inject it. Add a CI/policy check that these literals never appear in non-dev manifests.

**Tenant Impact:** Multi-tenant (analytics engine is cross-brand).
**Detection:** Posture scan of running infra; not currently alerted.

---

### FIND-SEC-04 — Auth rate limiter is fail-OPEN on Redis error AND on most enforcement gaps; brute-force protection silently disappears under Redis degradation
**Severity:** Medium | **Category:** A07 Auth Failures | **Priority:** P2

**Evidence:** `apps/core/src/modules/workspace-access/internal/infrastructure/rate-limiter.ts:43-47`:
```ts
} catch (err) {
  console.error('[rate-limiter] Redis error — failing open', { key, err });
  return { allowed: true, retryAfter: 0, remaining: limit };
}
```
Login/forgot-password/register/refresh all route through this limiter (`bff.routes.ts:225` uses `loginFailKeySync(email, ip)` limit 5/900s). On any Redis error the limiter returns `allowed: true` — credential-stuffing and password-reset-flooding protection vanishes whenever Redis is unavailable, with only a `console.error` and no alert/metric.

**Impact (production):** During a Redis incident (or a deliberately induced one — e.g. exhausting Redis connections), the login endpoint becomes unthrottled. Combined with argon2id's deliberate cost, this also opens a CPU-exhaustion DoS via unthrottled login attempts (each does a full argon2 verify, including the dummy-hash path for unknown users at `auth.service.ts:362-364`).

**Root Cause:** Deliberate fail-open per plan §4 AC-3 (availability-over-security choice) with no compensating alert.

**Recommended Fix:** Keep fail-open if availability mandates it, but emit a metric/alert on the fail-open branch (so a sustained open state pages on-call), and add an independent edge/WAF rate limit on `/api/v1/auth/*` so Redis is not the sole throttle. Consider fail-closed for `forgot-password` and `register` (lower availability cost than login).

**Tenant Impact:** Platform-wide (pre-tenant auth surface).
**Detection:** Only `console.error` today — no metric/alert. Recommend a `rate_limiter_fail_open_total` counter.

---

### FIND-SEC-05 — StarRocks per-brand isolation depends on the caller remembering the `${BRAND_PREDICATE}` sentinel; a query without it gets NO brand filter (no query-gateway rejection)
**Severity:** Medium | **Category:** A01 Broken Access Control / A05 Injection-adjacent (missing query gateway) | **Priority:** P2

**Evidence:** `packages/metric-engine/src/silver-deps.ts:115-129` and `apps/stream-worker/src/jobs/dq/silver-reader.ts:64`:
```ts
finalSql = sql.replace(BRAND_PREDICATE, 'brand_id = ?');
finalParams = [...params, brandId];
```
`String.replace` is a no-op when the sentinel is absent. If a future Silver query author writes a `WHERE` without `${BRAND_PREDICATE}`, `runScoped` appends **no** brand predicate and the query runs cross-brand. The session var `SET @brain_current_brand_id` is set, but `silver-deps.ts:11-15,27-30` is explicit that the dev StarRocks allin1 image has **no engine row-policy** — so that session var enforces nothing in dev (and only enforces if the prod cluster is enterprise and the row-policy was applied). The OWASP-baseline requirement is "the OLAP query gateway rejects unscoped queries"; here the gateway is opt-in by string convention, not enforced. The negative-control test (`tools/isolation-fuzz/src/silver-order-state.test.ts` via `__unsafeDisableBrandPredicate`) proves the predicate *works when present* but does not prevent a caller from omitting the sentinel.

**Impact (production):** A single forgotten sentinel in a new metric/DQ query leaks one brand's Silver rows (orders, touchpoints, GMV) to another brand's dashboard. Until a managed StarRocks row-policy is applied, there is no datastore backstop — defense-in-depth is one layer (app string-replace), violating the baseline's "never one layer."

**Root Cause:** Predicate injection via optional sentinel substitution rather than a mandatory gateway that rejects any Silver query lacking a brand predicate.

**Recommended Fix:** Make `runScoped` **reject** (throw) any `sql` that does not contain `BRAND_PREDICATE` (fail-closed at the seam). Track and gate the managed-StarRocks row-policy application (`db/starrocks/row_policy_template.sql`) as a hard prerequisite before multi-tenant prod, so the engine enforces isolation independent of app code.

**Tenant Impact:** Multi-tenant (Silver/OLAP cross-brand).
**Detection:** Would surface as wrong-brand rows in a dashboard; no automated detection today. Recommend a CI lint asserting every `runScoped` call site contains `${BRAND_PREDICATE}`.

---

### FIND-SEC-06 — RBAC role is trusted entirely from the JWT claim; a role change (demotion/removal) is not reflected until token expiry (≤1h)
**Severity:** Medium | **Category:** A01 Broken Access Control / A07 Auth Failures | **Priority:** P2

**Evidence:** `apps/core/src/modules/workspace-access/internal/security/rbac.ts:34-55` — `requireRole` reads `auth.role` straight from the JWT claims (set at `auth.service.ts:663-675` `mintSessionToken`). `validateSessionPreHandler` checks only `user_session.revoked_at IS NULL` (`auth.service.ts:1158-1172`), not the live membership role. The access token lifetime is 1h (`auth.service.ts:103`). So a member demoted from `brand_admin` to `analyst` (or removed from a brand) retains elevated authority for up to 1h on every protected route guarded only by `requireRole`. Note: `suspendUser` does revoke sessions (`auth.service.ts:942-958`), so suspension is immediate — but a *role downgrade* path mints no revocation.

**Impact (production):** Window of privilege after demotion/removal — a just-removed manager can still mutate brand resources for up to an hour. For destructive endpoints (member suspend, connector disconnect, billing) this is a real authz gap.

**Root Cause:** Stateless role claim with no live re-check and no session-revocation on role change.

**Recommended Fix:** On any membership role change / removal, revoke the affected user's sessions (reuse `revokeAllForUserAndBrand`, referenced in the auth header as AC-2) so the next refresh re-mints the correct role; OR re-resolve role from DB in `validateSessionPreHandler` for high-stakes routes. Shorten access-token TTL if neither is feasible.

**Tenant Impact:** Single-tenant blast radius (the affected brand/workspace), but applies to every tenant.
**Detection:** Audit log shows the role change but not the continued use of the stale token; no alert.

---

### FIND-SEC-07 — JWT verification leaks signature *length* before the constant-time compare; minor timing/structure oracle
**Severity:** Low | **Category:** A04 Cryptographic Failures | **Priority:** P3

**Evidence:** `apps/core/src/modules/workspace-access/internal/security/jwt.ts:72-85` — the verify returns early on `signature.length !== expectedSignature.length` before the byte-wise constant-time XOR loop. The header is correctly pinned (canonical `JWT_HEADER` reused at `:66`, alg/typ validated at `:54-61`, closing alg-confusion), and the payload-side compare is constant-time. The length check is a standard early-out and not exploitable for HS256 forgery (the attacker cannot produce a valid same-length signature without the key), so impact is negligible — but it is a deviation from "compare in constant time" purity and worth noting since the team rolled its own JWT (`:13-14` "no external JWT lib in core path").

**Impact (production):** No practical forgery path; at most a structural oracle that the expected signature has a fixed length (always 43 base64url chars for HMAC-SHA256). Negligible.

**Root Cause:** Hand-rolled JWT verify with a length pre-check.

**Recommended Fix:** Prefer `crypto.timingSafeEqual` over fixed-size buffers (it already throws on length mismatch); or pad/normalize before compare. Low priority. Consider adopting a vetted JWT library when Authentik fronts this in Phase 2 (per the file header).

**Tenant Impact:** Platform-wide (token verification), but no exploitable cross-tenant path.
**Detection:** n/a.

---

### FIND-SEC-08 — `dev_secret` table stores connector OAuth tokens in plaintext and is GRANTed to `brain_app`; relies solely on a runtime NODE_ENV guard to stay out of prod
**Severity:** Low | **Category:** A04 Cryptographic Failures / A02 Misconfiguration (dev) | **Priority:** P3

**Evidence:** `db/migrations/0024_dev_secret.sql` creates `dev_secret(name, secret_value TEXT)` storing raw connector credentials in plaintext, with `GRANT SELECT, INSERT, UPDATE, DELETE ON dev_secret TO brain_app`. `LocalSecretsManager` writes/reads it (`.../secrets/LocalSecretsManager.ts:45-68,113`). The migration ships in the same `db/migrations/` set that runs in every environment; the only thing keeping plaintext tokens out of a prod DB is the runtime `NODE_ENV==='production'` throw in `LocalSecretsManager` (`:33-38`) and `LocalSecretsProvider`. The table itself, its GRANT, and its plaintext column exist in prod schema.

**Impact (production):** If a future code path (or a mis-set `NODE_ENV`) writes to `dev_secret` in prod, OAuth tokens land in Postgres in plaintext — exactly what NN-2/I-S09 forbid. The structural backstop (table simply not existing in prod) is absent; isolation is a single runtime string check.

**Root Cause:** Dev vault stand-in implemented as a migration that runs everywhere, guarded only at the application layer.

**Recommended Fix:** Gate the `0024` migration behind a dev-only migration set / environment flag so the table never exists in prod, or add a DB-level `CHECK`/trigger that hard-fails inserts when a prod marker is present. Keep the existing app guard as belt-and-suspenders.

**Tenant Impact:** Multi-tenant (connector tokens span brands).
**Detection:** A secret scanner over the prod DB; not currently checked.

---

## Controls Verified (positive findings — evidence-backed)

- **Password hashing:** argon2id m=19456/t=2/p=1, asserted at startup (`auth.service.ts:62-80,129`). Login is timing-equalised with a dummy-hash verify for unknown users (`:362-364`).
- **Enumeration safety:** `forgotPassword` always 200, fire-and-forget send, no else branch (`auth.service.ts:1079-1117`); register collision mints no session and returns body-identical response minus Set-Cookie (`:174-225`).
- **Refresh-token rotation + replay defense:** single-use under `SELECT ... FOR UPDATE`, replay → family-wipe with audit, jti-UNIQUE race handling (`auth.service.ts:481-654`). Correctly sets `app.current_user_id` for the family-wipe UPDATE under `brain_app` RLS (`:528-531`).
- **JWT alg-confusion closed:** header pinned to canonical constant, alg/typ validated, payload compare constant-time (`jwt.ts:45-85`).
- **Cookies:** `brain_session` httpOnly + secure(prod) + sameSite=strict; CSRF cookie JS-readable but bound to session jti via HMAC(cookieSecret, jti) double-submit (`bff.routes.ts:98-103,194-199`; `main.ts:256-302`; `csrf.ts:35-36`).
- **Webhook security:** HMAC-first ordering with `timingSafeEqual` + length pre-check for Shopify (`ShopifyHmac.ts:46-57,79-89`) and Razorpay (`razorpayWebhookHandler.ts:7,220`); brand_id derived from DB row via SECURITY DEFINER fn, never from header/body (`shopifyWebhookHandler.ts:117-159`).
- **OAuth callback:** HMAC → single-use brand-bound state nonce → shop-domain validation → token exchange → ARN-only persistence; brandId from server state, never query param (`HandleOAuthCallbackCommand.ts:77-170`).
- **Secrets at rest:** prod uses AWS Secrets Manager under a per-brand customer-managed CMK; only the ARN (`secret_ref`) is stored in Postgres; fail-closed on SM errors; secret values never logged; `LocalSecretsManager`/`LocalSecretsProvider` hard-fail in prod (`AwsSecretsManager.ts:67-105,184-204`; `LocalSecretsManager.ts:33-38`; `main.ts:531`).
- **Audit log:** sha256 hash-chain (`@brain/audit:61-69`), append-only at GRANT level, idempotency keys; auth lifecycle events (register/login/logout/rotate/suspend/brand.switch) all written.
- **PII handling:** email masking for events/logs (`auth.service.ts:93-97`); webhook maps PII to per-brand salted hashes before leaving handler scope (`shopifyWebhookHandler.ts:201-216`); a targeted grep for raw email/phone/token in `console.*`/logger across `apps/core`+`apps/collector` found no leaks.
- **Injection:** no string-interpolated SQL on data paths — the only template-literal SQL is `SET @brain_current_brand_id = '<uuid-stripped>'` for StarRocks (which rejects parameter binding on SET) with `replace(/[^0-9a-fA-F-]/g,'')` sanitization (`silver-deps.ts:110-111`); GUC values are UUID-validated before interpolation (`db/index.ts:78-82,94-97`). Parameterized queries everywhere else.
- **No-token-in-logs:** request serializer omits Authorization header (`main.ts:198-207`); stack traces stripped from client responses and from logs in prod (`main.ts:306-322`).

---

## Counts
- Critical: 1 (FIND-SEC-01)
- High: 1 (FIND-SEC-02)
- Medium: 4 (FIND-SEC-03, -04, -05, -06)
- Low: 3 (FIND-SEC-07, -08, and FIND-SEC-03 is Medium — see above)

(Net: 1 Critical, 1 High, 4 Medium, 2 Low.)

## Domain Verdict
The auth/token/secrets/webhook surfaces are genuinely well-engineered: argon2id, enumeration- and timing-safety, rotating refresh with family-wipe, HMAC-first webhook ordering, server-derived brand_id, per-brand CMK secrets with ARN-only DB rows, a hash-chained append-only audit log, and disciplined PII masking. The blocking issue is structural rather than cosmetic: the **OLTP RLS GUC middleware in `@brain/db` issues `SET LOCAL` outside any transaction, so the tenant GUC is never in scope for the business query**, and — because the dev superuser masks it and every live RLS test hand-rolls its own `BEGIN` — this primary isolation control has **never been validated against the production `brain_app` role**. That is a CRITICAL that must be fixed and proven with a test that runs the real `createPool` path under `brain_app` before any multi-tenant production cutover. The **StarRocks analytics password silently defaulting to a hardcoded weak dev credential in prod** (no fail-closed guard, unlike JWT/cookie/KMS) is a HIGH that, combined with the sentinel-dependent (gateway-less) Silver isolation, exposes all-brand commerce data on a misconfigured deploy. Fix FIND-SEC-01 and FIND-SEC-02, convert the Silver predicate to a fail-closed gateway, and add the missing fail-open alert on the rate limiter, and this domain is in strong shape.
