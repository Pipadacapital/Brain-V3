# Persona Review — Tenant Isolation & Auth Hardness Skeptic

| Field | Value |
|-------|-------|
| **req_id** | `feat-m1-app-foundation` |
| **Stage** | 1 — Stress Test (Persona) |
| **Persona** | Tenant Isolation & Auth Hardness Skeptic |
| **Reviewed at** | 2026-06-15T16:10:00Z |
| **Decision** | PASS (with mandatory pre-build concerns — all rated H or M) |
| **Skills loaded** | `auth-and-access`, `multi-tenancy-isolation`, `oauth-implementation` (the three load-bearing skills for this lens; `ai-llm-security` not loaded — no model path in this surface) |

---

## Lens Statement

M1 is the first moment Brain's tenant boundary becomes real load-bearing infrastructure. Before M1, isolation existed only in a stub demo table (`_rls_demo`) and a test harness. After M1, real users, real workspaces, real brands, real Shopify tokens, and real session JWTs exist. Every gap cemented here is a P0 waiting to happen. My job is to find the gaps before the builder cements them.

The Brain invariant is unambiguous: brand isolation is absolute and structural (I-S01). A cross-brand leak has SLO = 0 and triggers a breach workflow. This review asks one question at every surface: is this boundary structurally unbreakable, or merely conventional?

---

## Finding IAH-01 — GUC Coverage Is Insufficient for the User/Workspace Layer (HIGH)

**Risk:** The Sprint-0 RLS framework establishes one GUC: `app.current_brand_id`. The NN-1 two-arg predicate is correct for brand-scoped tables. But M1 introduces a two-tier hierarchy — workspaces contain brands, and users belong to many workspaces. The tables `workspaces`, `workspace_members`, `users`/`app_user`, `invitations`, and `user_sessions` are NOT brand-scoped in the same way as `brands` or `connector_instances`.

**The structural gap:** The Sprint-0 pattern applies `brand_id = current_setting('app.current_brand_id', TRUE)::uuid` to every brand-scoped table. But:

- `workspaces` is workspace-scoped, not brand-scoped. An RLS policy on `workspaces` using `app.current_brand_id` is wrong — a workspace has no `brand_id`.
- `workspace_members` is workspace-scoped. The correct isolation predicate is `workspace_id = current_setting('app.current_workspace_id', TRUE)::uuid`.
- `users` / `app_user` is cross-workspace by design (a user belongs to many workspaces). Applying ANY isolating RLS to `users` using a single GUC breaks login (a user logging in has no `current_workspace_id` until AFTER they authenticate).
- `invitations` must be isolated by BOTH `workspace_id` (workspace-level invites) and `brand_id` (brand-level invites). A single-GUC policy would allow a workspace-A member to enumerate workspace-B's pending invitations if only `app.current_brand_id` is set.
- `user_sessions` is user-global. An RLS policy on `user_sessions` that uses `app.current_brand_id` is either wrong (brand-scoped = blocks multi-workspace login) or absent (no isolation = any session can be read by any query in the pool).

**The missing GUCs:** The current framework has exactly one GUC (`app.current_brand_id`). The M1 workspace/user layer requires at minimum:
- `app.current_workspace_id` — set on every request scoped to a workspace.
- `app.current_user_id` — set on every authenticated request for user-self-read operations.

Without `app.current_workspace_id`, there is NO structural mechanism to write an RLS policy that isolates `workspaces`, `workspace_members`, or workspace-scoped `invitations`. The Sprint-0 single-GUC model is structurally insufficient for the M1 workspace/user layer.

**Evidence:** The Sprint-0 migration `0001_init.sql` defines exactly one policy variable: `current_setting('app.current_brand_id', TRUE)`. The requirement specifies tables spanning workspace (`workspaces`, `workspace_members`), user-global (`users`/`app_user`, `user_sessions`), and cross-scoped (`invitations`) domains. Doc 08 §5.1 confirms the membership table (`membership`) has BOTH `org_id` and `brand_id` FK columns — isolation requires two axes. The auth-and-access skill states explicitly: "The tenant key AND role MUST come from verified JWT — never from request body/query."

**What happens if left unfixed:** A builder following the Sprint-0 pattern mechanically applies `brand_id = current_setting('app.current_brand_id', TRUE)::uuid` to every M1 table. On `workspaces` (which has no `brand_id`), this policy either (a) fails to compile, (b) returns 0 rows always (safe but broken), or (c) the builder omits RLS entirely on workspace-layer tables because the pattern doesn't fit — which is the actual danger: workspace tables silently without RLS. A user in Workspace A could enumerate members of Workspace B via the `workspace_members` table.

**Mandatory fix — the Architect must specify in the migration DDL:**

1. Three GUCs are required, all in the NN-1 two-arg form:
   - `current_setting('app.current_brand_id', TRUE)` — brand-scoped tables (`brands`, `brand_members`, `connector_instances`, `connector_sync_status`, `connector_cursors`, `pixel_installations`, `pixel_status`).
   - `current_setting('app.current_workspace_id', TRUE)` — workspace-scoped tables (`workspaces`, `workspace_members`).
   - `current_setting('app.current_user_id', TRUE)` — user-self-read (`user_sessions`, `password_resets`, `email_verifications`).

2. The middleware (in `workspace-access` and `frontend-api` BFF) must set ALL applicable GUCs before any query — not just `app.current_brand_id`. The BFF must assert non-null for the applicable scope before forwarding.

3. `users`/`app_user` gets NO isolating RLS predicate — it is cross-tenant by nature. Access control is enforced at the service layer: the login endpoint reads `users` by email (no tenant context; this is correct for authentication); all post-login reads go through the membership join (which IS RLS-protected). This must be an explicit architectural decision, not an accidental omission.

4. `invitations` requires a compound RLS policy: `workspace_id = current_setting('app.current_workspace_id', TRUE)::uuid` for workspace-scoped invitations. Brand-scoped invitations additionally check `brand_id = current_setting('app.current_brand_id', TRUE)::uuid`.

5. The NN-1 assertion in `0001_init.sql` scans for one-arg `current_setting('app.current_brand_id')` only. It must be extended to scan all three GUC names.

**Cost of retrofit:** If the builder ships M1 with workspace tables either lacking RLS or with wrong-GUC RLS, fixing it post-ship requires: (a) new RLS policies on live tables with real data; (b) middleware changes to set the new GUCs on every existing protected route; (c) re-running isolation negative-tests on every table. This is expensive and risky on a live system. Cement the three-GUC model NOW, before any builder touches a migration file.

---

## Finding IAH-02 — `users` Table Exposes User Enumeration Attack Surface (HIGH)

**Risk:** The `users` / `app_user` table is cross-tenant by design — a user can belong to many workspaces. But this means the table has no RLS isolation (confirmed by IAH-01 reasoning). Combined with M1's auth flows, two attack vectors open:

**Vector A — Forgot-password user enumeration.** The `POST /auth/forgot-password` endpoint receives an email and must trigger a password-reset token. If the response differs for "email exists" vs "email does not exist" (different timing, different response body, different HTTP code), an attacker can enumerate whether an email is registered. OWASP mandates the response be identical for both cases (always return 200 with "If this email exists, you'll receive a reset link"). The CTO Advisor review mentions the forgot-password flow but does not specify this timing-safe response requirement.

**Vector B — Invitation token enumeration.** The `invitations` table has `token_hash text UNIQUE`. If the token is derived from low-entropy input (e.g., a numeric ID, a timestamp, or a short random string), it is brute-forceable. The requirement mentions "secure" tokens but does not specify entropy floor, single-use enforcement, or expiry.

**Evidence:** The auth-and-access skill specifies "audit every transition" and "per-environment secrets in a secrets manager, never env files" but does not prescribe timing-safe response for forgot-password. The requirement (Part 1, §1) says "Forgot/Reset Password" but gives no entropy or single-use specification. Doc 08 §5.1 shows `invite` with `token_hash text UNIQUE` — the hashing pattern is correct but the pre-hash entropy is unspecified.

**Mandatory fix — the Architect must specify:**
1. Forgot-password response MUST be timing-safe and content-identical regardless of whether the email exists. Use `crypto.timingSafeEqual` if comparing hashes, and always return HTTP 200 with the same body. Never return 404 or a different message for "email not found."
2. Password-reset and invitation tokens MUST be generated from `crypto.randomBytes(32)` minimum (256 bits entropy) before hashing with SHA-256 for storage. The raw token is sent in the email; only the hash is stored.
3. Both token types MUST be single-use (consumption sets a `used_at` column; subsequent use returns 400 regardless of expiry). Expiry: password-reset = 1 hour; invitation = 7 days (configurable).
4. Token lookup MUST be timing-safe (compare stored hash to `sha256(submitted_token)` using timing-safe comparison, not `=` in SQL via user input directly).
5. The isolation-fuzz harness must include a negative test: submitting a valid token twice must fail the second attempt.

---

## Finding IAH-03 — Session/JWT Revocation Is Not Checked on BFF Fan-Out Routes (HIGH)

**Risk:** The CTO Advisor review (§4, Track 1) states: "Revocation denylist: query `user_sessions` on every protected action (the 'denylist checked on every protected action' per TRIGGER-SURFACES.md §Auth — this is a Postgres lookup, not Redis, at M1 scale)." TRIGGER-SURFACES.md §Authentication/authorization confirms: "the revocation denylist checked on every protected action."

The danger in M1 is the `frontend-api` BFF. The BFF exchanges the httpOnly cookie for a short-lived access token and fans out to multiple backend modules (workspace-access, connector, etc.). There are now TWO token validation points:

1. The BFF validates the incoming cookie/session on arrival.
2. The individual backend module route validates the forwarded token.

If the BFF checks revocation but the forwarded short token does NOT carry revocation state (it is a freshly minted short-lived JWT), and if individual module routes trust the short token without re-checking `user_sessions.revoked_at`, then: a user whose session is revoked (e.g., forced logout after password change, account compromise, or Owner removes a user) can still invoke module APIs if they already hold a BFF-forwarded short token that has not yet expired.

The doc 08 §5.1 `session` table comment is telling: "access JWTs not stored; revocation = Redis denylist" — but the CTO Advisor review rules OUT Redis at M1 scale and uses `user_sessions.revoked_at` instead. This means every protected route must query Postgres for revocation. If the BFF mints a short token and the module route does not re-query `user_sessions`, the revocation check is only at the BFF boundary.

**Compounding risk:** The Shopify OAuth callback route in the `connector` module is a protected route (it writes `connector_instances` for a brand). If this route trusts the forwarded short token without checking `user_sessions.revoked_at`, a revoked user can complete a Shopify connection.

**Mandatory fix — the Architect must specify:**
1. The `workspace-access` module must expose a `validateSession(userId, jti)` function that queries `user_sessions` for revocation state (`revoked_at IS NULL`).
2. EVERY protected route — including all BFF fan-out downstream routes (workspace, brand, connector, pixel) — must call `validateSession` before any business logic executes. This is a Fastify `preHandler` on every protected route group, not just the BFF boundary.
3. The short-lived token the BFF mints for module fan-out MUST include the `jti` (JWT ID) from the original session so downstream `validateSession` can find the correct `user_sessions` row.
4. The revocation denylist check must appear in the acceptance criteria for every API story in Track 1 and Track 2.

---

## Finding IAH-04 — Shopify OAuth HMAC Validation Must Be the First Line in the Callback Handler (HIGH)

**Risk:** The Shopify OAuth callback receives: (a) a `code` parameter, (b) a `state` parameter, (c) an HMAC signature computed by Shopify over all query parameters using the Shopify app's client secret. The HMAC validation must happen BEFORE any other processing — including state validation, database reads, or token exchange. If HMAC validation is deferred or absent, a malicious actor can craft a callback that:

- Injects a forged `code` from a different Shopify store (cross-store token injection).
- Replays a legitimate callback with a modified `shop` parameter, connecting the Brain brand to an attacker-controlled Shopify store.
- Triggers a token exchange with Shopify's API using an attacker-controlled `code`, potentially obtaining a Shopify access token for the wrong store.

The requirement mentions "Connect Shopify" and the CTO Advisor confirms the `secret_ref` pattern for token storage (I-S09). The oauth-implementation skill explicitly states: "HMAC verification first — defense in depth" and "verify_vendor_hmac(...) before parsing." But the M1 requirement does not specify HMAC validation as an explicit acceptance criterion for the Shopify callback route.

**Additionally:** The Shopify `state` parameter used for CSRF protection must be: (a) cryptographically random (minimum 128 bits); (b) stored server-side (not just in a cookie or local storage — the server holds the expected value); (c) bound to the `brand_id` of the initiating request; (d) single-use (consumed on callback, never reusable); (e) short-expiry (15 minutes maximum for the OAuth flow to complete). The CTO Advisor review mentions "state/nonce CSRF" but does not specify these five requirements.

**Evidence:** The oauth-implementation skill callback pattern: `verify_vendor_hmac(vendor, params, settings.client_secret_for(vendor))` — FIRST, before `verify_state(params["state"])`. The skill's security requirements table: "state validation (signed + nonce + tenant_id; reject mismatch 401) · HMAC verification first (where the vendor signs callbacks)."

**Mandatory fix — the Architect must specify in the Shopify connector acceptance criteria:**
1. The callback handler MUST validate the Shopify HMAC signature as the absolute first operation. Any failure returns HTTP 401 with no further processing.
2. HMAC validation uses the Shopify client secret fetched from Secrets Manager (never from env vars or code). The HMAC algorithm is SHA-256 HMAC over the sorted query parameters (Shopify's documented algorithm; see Shopify Partner docs — the implementation must follow the exact Shopify HMAC specification).
3. The `state` parameter must be: generated with `crypto.randomBytes(16)` (128 bits minimum); stored server-side in `user_sessions` or a dedicated `oauth_states` table (TTL 15 minutes) keyed to `(brand_id, state)`; verified for exact match and brand_id binding; deleted on use (single-use).
4. After HMAC and state validation, the `shop` parameter must be validated against an allow-list pattern (must match `*.myshopify.com` format) and bound to the initiating brand's expected domain.
5. Webhook callbacks from Shopify (order sync, product sync) must ALSO validate HMAC using the same pattern. Webhook HMAC validation is a separate concern from the OAuth callback — both are required.

---

## Finding IAH-05 — `connector_instances` Schema Must Structurally Forbid Plaintext Tokens (HIGH)

**Risk:** I-S09 states: "No column named `*_token`, `*_secret`, `*_key` holds a plaintext string." The COMPLIANCE.md SAST rule specifies: "No `oauth_token` column may hold a plaintext token — enforced by a Semgrep rule that flags string columns named `*_token` without a `_ref` or `_hash` suffix."

Doc 08 §5.3 shows the `connector_instance` schema including: `oauth_token_ciphertext bytea, secret_ref text`. The presence of `oauth_token_ciphertext bytea` is a concern: this field name suggests the OAuth token IS stored in the database (as ciphertext), not purely by `secret_ref` to Secrets Manager. This is a different model than the `secret_ref`-only pattern mandated by I-S09.

There are two possible models:
- **Model A (correct per I-S09):** `connector_instance.secret_ref` holds only the Secrets Manager ARN. The ciphertext lives in Secrets Manager. The DB column stores ZERO token bytes.
- **Model B (doc 08 §5.3 suggests this):** `connector_instance.oauth_token_ciphertext bytea` holds the ciphertext (presumably KMS-encrypted) in the DB row. `secret_ref` holds... what exactly?

If Model B is implemented, a database compromise exposes KMS-wrapped tokens. While KMS-wrapped tokens are not immediately usable, they are one KMS key compromise away from plaintext. The `secret_ref`-only pattern (Model A) means a DB compromise exposes only a Secrets Manager ARN — which requires both DB access and IAM access to the Secrets Manager secret to obtain a plaintext token.

Furthermore, the Zod contract for `connector_instances` in `packages/contracts` is not yet written (Track 0 has not started). If the contract is written with an `oauth_token` field of type `string`, the SAST Semgrep rule will flag it — but only if the Semgrep rule is running. If the contract is written with a `secret_ref` field of type `string` and no separate `oauth_token_ciphertext` column, Model A is enforced at the contract level.

**Mandatory fix — the Architect must specify:**
1. The M1 `connector_instances` migration (migration 005) MUST NOT include `oauth_token_ciphertext bytea`. The schema is: `secret_ref text NOT NULL` — the Secrets Manager ARN only. No ciphertext in the DB row.
2. The Zod contract for `ConnectorInstance` in `packages/contracts` must include `secret_ref: z.string()` and MUST NOT include any field named `*_token`, `*_secret`, `*_key` as a string type. This is enforced at contract time (Track 0 gate).
3. The Semgrep rule in CI must scan migration DDL files as well as TypeScript files — a `bytea` column named `oauth_token_ciphertext` in SQL should also trigger a flag.
4. The connector module's Shopify token storage path must: call Secrets Manager `putSecretValue`, receive the ARN, write only the ARN to `connector_instance.secret_ref`. The token never touches Postgres.
5. This distinction must be an explicit acceptance criterion in the Track 2 connector story: "The Shopify OAuth token is stored in Secrets Manager. The `connector_instances` row contains only `secret_ref` (the Secrets Manager ARN). No token bytes exist in the database."

---

## Finding IAH-06 — Workspace-Member and Brand-Member RLS Must Prevent Cross-Workspace Member Enumeration (MEDIUM)

**Risk:** The `workspace_members` table is the join that determines which user can see which workspace. An RLS policy that only checks `workspace_id = current_setting('app.current_workspace_id', TRUE)::uuid` is correct for read isolation. But there is a subtler gap: when a user switches brands (within a workspace), the GUC values change. If the middleware sets `app.current_workspace_id` = Workspace A but a request queries `brand_members` with a `brand_id` from Workspace B (the brand belonging to a different workspace), the RLS predicate on `brand_members` (`brand_id = current_setting('app.current_brand_id', TRUE)::uuid`) correctly prevents the cross-brand read — but ONLY if `app.current_brand_id` is correctly set.

The gap is in the transition between setting the workspace GUC and the brand GUC. If a request sets `app.current_workspace_id` = Workspace A but does NOT set `app.current_brand_id` (because the request is workspace-scoped, not brand-scoped), and if `brand_members` policies check `brand_id = current_setting('app.current_brand_id', TRUE)::uuid`, then with the NN-1 two-arg form (missing GUC returns NULL → 0 rows) the policy returns 0 rows — safe. BUT: if the policy has an OR clause for workspace-level membership checks (e.g., "can read brand_members if workspace_id matches OR brand_id matches"), the NN-1 fail-closed guarantee breaks.

Additionally, `invitations` can be created at both the workspace level (inviting a user to the workspace) and the brand level (inviting to a specific brand). If the isolation policy on `invitations` is only `brand_id = current_setting('app.current_brand_id', TRUE)::uuid`, then workspace-level invitations (which have `brand_id = NULL`) are NEVER isolated — any authenticated user can enumerate all workspace-level invitations across all workspaces.

**Evidence:** Doc 08 §5.1 shows `invite(... brand_id FK NULL ...)` — brand_id is explicitly nullable for workspace-level invitations. A policy `USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)` on invitations would return 0 rows for workspace-level invites (brand_id IS NULL, NULL = uuid is always false) — but these invitations SHOULD be visible to workspace members. This means either: (a) the isolation policy is broken for workspace-level invites (they're invisible), or (b) there's no isolation on workspace-level invites (all are visible). Neither is correct.

**Mandatory fix:**
1. `invitations` RLS must be a compound policy:
   - For workspace-level invitations (`brand_id IS NULL`): `workspace_id = current_setting('app.current_workspace_id', TRUE)::uuid`.
   - For brand-level invitations (`brand_id IS NOT NULL`): `brand_id = current_setting('app.current_brand_id', TRUE)::uuid`.
   - Implementation: two PERMISSIVE policies (Postgres PERMISSIVE OR-combines them) or a single policy with an OR clause that correctly handles NULL brand_id.
2. The `workspace_members` RLS policy must be `workspace_id = current_setting('app.current_workspace_id', TRUE)::uuid` ONLY — no OR clause with brand_id.
3. The isolation-fuzz harness must test: a User in Workspace A querying `invitations` with `app.current_workspace_id` = Workspace A returns ONLY Workspace A invitations; with `app.current_workspace_id` = Workspace B returns 0 rows.

---

## Finding IAH-07 — Password Hashing Algorithm and Cost Factor Must Be Locked (MEDIUM)

**Risk:** The requirement says "secure password storage (hashing)" and the CTO Advisor review says "bcrypt/argon2 password hashing." Both algorithms are mentioned as alternatives. This is not a bikeshed — the choice has concrete security implications:

- bcrypt has a 72-byte password length limit (truncates silently). A password longer than 72 bytes is stored as if it were the 72-byte prefix. This is a known bcrypt limitation that surprises most implementations.
- bcrypt cost factor: for 2026 hardware, the minimum acceptable cost is 12. A cost factor of 10 (a common default) is approximately 4x faster to crack on current GPUs.
- argon2id (the OWASP-recommended choice for 2025-2026) has no length limit, is memory-hard, and provides better resistance to GPU-parallel attacks. OWASP recommends argon2id with m=19456 (19 MiB), t=2, p=1 as the minimum.

The requirement does not specify WHICH algorithm or WHAT cost factor. If a builder defaults to `bcrypt.hash(password, 10)` (the `bcryptjs` library default), the application ships with a below-minimum cost factor.

**Evidence:** The auth-and-access skill does not specify the hashing algorithm or cost factor. The requirement says "bcrypt/argon2" — an OR, not a specification. The CTO Advisor review says "bcrypt/argon2 password hashing" — also an OR. No cost factor is specified anywhere in the Canon.

**Mandatory fix:**
1. The Architect must specify exactly ONE algorithm in the migration acceptance criteria and the workspace-access module contract: argon2id with OWASP 2025 recommended parameters (m=19456, t=2, p=1 minimum; or bcrypt with cost=12 minimum if argon2id is rejected for dependency reasons).
2. A migration-time or startup-time assertion must validate that the configured cost factor meets the minimum. This is a startup check, not a test.
3. The password hash upgrade path must be considered: when a user logs in successfully, the system SHOULD re-hash the password with the current parameters if the stored hash was generated with an older/lower-cost factor (online rehashing). This prevents a permanent security debt from accumulating as parameters improve.

---

## Finding IAH-08 — The `audit_log` Has No Brand-Scoped RLS But IS Readable by Brain App (MEDIUM)

**Risk:** `0001_init.sql` explicitly disables RLS on `audit_log`: "Disable RLS on audit_log intentionally — the audit log must record cross-brand system events (e.g. key-rotation jobs). Row-level access control is enforced at the application layer (the app role only INSERTs its own brand's rows)."

This is architecturally correct — the audit log is a cross-brand SoR. But it creates a READ risk: the `brain_app` role has `SELECT` on `audit_log` with NO RLS. Any query like `SELECT * FROM audit_log WHERE brand_id = <attacker_brand_id>` executed without a tenant context (e.g., in a pool slot that had its GUCs cleared) would return ALL audit entries for that brand — but ALSO, more critically: `SELECT * FROM audit_log` (no WHERE) would return ALL brands' audit entries.

In practice, the application middleware sets the brand GUC and application-level code always includes `WHERE brand_id = $1`. But this is conventional (app code correctness), not structural (RLS enforcement). If a query bypasses the application layer (e.g., a SQL injection in a poorly parameterized log query, a new route that forgets the WHERE clause, or a connection pool slot that lost its GUC), all brands' audit logs are exposed.

**Evidence:** `0001_init.sql` line 109: `ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;` + line 101-103: `GRANT INSERT, SELECT ON audit_log TO brain_app;`. This is an explicit architectural choice documented with reasoning. But the reasoning ("app role only INSERTs its own brand's rows") only addresses writes — the SELECT risk is unaddressed.

**Mandatory fix (or explicit documented acceptance):**
1. The Architect must either: (a) accept this risk as architectural with a documented justification in the migration comment and require application-layer enforcement of `WHERE brand_id = $1` on every SELECT from `audit_log`; OR (b) enable RLS on `audit_log` with a cross-brand-read-capable system role (a separate `brain_audit_reader` role with BYPASSRLS) and restrict `brain_app` to INSERT + SELECT only through the RLS predicate.
2. If (a) is chosen, the isolation-fuzz harness MUST include a test: `brain_app` role with `app.current_brand_id` = Brand A executes `SELECT * FROM audit_log` (no WHERE) — the test asserts that application-layer policy (the audit query function in `packages/audit`) always appends `WHERE brand_id = $1`. This is a code-path coverage test, not an engine test.
3. Every function in `packages/audit` that reads from `audit_log` must be reviewed for the mandatory `brand_id` predicate before M1 ships.

---

## Cross-Cutting Concern: Isolation Fuzz Must Gain Workspace + Brand + Membership Layers

The Sprint-0 isolation-fuzz tests the `_rls_demo` table (stub) and the StarRocks row policy (honest-skip on OSS). M1 introduces 15+ real tables across two tenancy dimensions (workspace and brand). The existing fuzz harness tests one GUC. It MUST be extended before Track 1 ships to cover:

- `workspaces` isolation (workspace_id GUC): User A (workspace A context) cannot read workspace B's row.
- `workspace_members` isolation: User A cannot enumerate workspace B's members.
- `brands` isolation (brand_id GUC within workspace): User A (brand A context) cannot read brand B's row.
- `brand_members` isolation: User A cannot enumerate brand B's members.
- `invitations` isolation (compound policy): workspace-level and brand-level isolation both tested.
- `connector_instances` isolation: brand A cannot read brand B's connectors.
- `user_sessions` self-isolation: the session query function must only return sessions for `current_user_id`.

These tests must use the REAL `brain_app` role (not a superuser), REAL GUC values, and assert that a cross-tenant query returns 0 rows (not an error, not another tenant's data — 0 rows). This matches the NN-1 fail-closed guarantee.

**Severity: HIGH** — if this fuzz expansion does not ship before M1 goes live, the tenant isolation invariant (I-S01) is untested on every real M1 table. Sprint-0's isolation fuzz only proves the pattern works on a demo table.

---

## Summary Table

| Finding | Severity | Surface | Can Retrofit? | INVARIANT at risk |
|---------|----------|---------|---------------|-------------------|
| IAH-01: Single-GUC model insufficient for workspace/user layer | HIGH | RLS / GUC model | Expensive (live data, middleware changes) | I-S01, TRIGGER-SURFACES §Multi-tenancy |
| IAH-02: User enumeration (forgot-password + invitation token entropy) | HIGH | Auth flows, invitation token | Moderate (API change) | I-S01 (membership privacy), auth security |
| IAH-03: Session revocation not checked on BFF fan-out routes | HIGH | BFF / protected routes | Moderate (preHandler addition) | TRIGGER-SURFACES §Auth (revocation denylist on EVERY protected action) |
| IAH-04: Shopify OAuth HMAC + state not specified as acceptance criteria | HIGH | Connector OAuth callback, webhook | Moderate (callback rewrite) | I-S09, TRIGGER-SURFACES §Connectors |
| IAH-05: `connector_instances` may include ciphertext column vs. `secret_ref` only | HIGH | Migration 005 DDL, Zod contract | Expensive if shipped (schema migration) | I-S09, COMPLIANCE §KMS/secrets |
| IAH-06: Workspace-member and brand-member RLS compound policy missing for nullable brand_id invitations | MEDIUM | Migration 004, invitation table RLS | Moderate (policy update) | I-S01, TRIGGER-SURFACES §Multi-tenancy |
| IAH-07: Password hashing algorithm and cost factor unspecified | MEDIUM | Auth module | Low (config change before users created) | STACK ADR-006 security posture |
| IAH-08: `audit_log` SELECT with no RLS — app-layer-only protection | MEDIUM | `packages/audit`, audit_log table | Moderate (audit reader function review) | I-S06 (audit integrity, read confidentiality) |
| IAH-CX: Isolation fuzz not extended to M1 tables | HIGH | Test harness | Low (test code addition) | I-S01 (P0 gate) |

---

## Top Recommendation

**IAH-01 is the most expensive finding to retrofit and the most likely to be missed:** the Sprint-0 single-GUC model is a natural attractor for builders who will mechanically extend it to M1 tables. The Architect must explicitly specify a three-GUC model (`app.current_brand_id`, `app.current_workspace_id`, `app.current_user_id`) in the migration DDL plan before any builder opens a migration file. Without this, workspace-layer tables will either have wrong-GUC RLS or no RLS — a structural cross-workspace isolation gap on the tables that are the entry point to the entire platform.

---

## Journal Entry

```markdown
## 2026-06-15T16:10:00Z — Persona:tenant-isolation-auth-hardness-skeptic — feat-m1-app-foundation
**Angle:** Structural unbreakability of tenant + auth boundary at every M1 surface · **Top concern:** Sprint-0 single-GUC model is insufficient for M1 workspace/user layer — workspace tables will have no structural RLS isolation without `app.current_workspace_id` GUC being defined and set · **Severity:** H
```
