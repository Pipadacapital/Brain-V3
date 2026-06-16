# 02a — Identity & Session-Abuse Red-team Review
## feat-access-onboarding-flow

| Field | Value |
|-------|-------|
| **persona** | Identity & Session-Abuse Red-teamer |
| **tier** | `:sonnet` |
| **req_id** | `feat-access-onboarding-flow` |
| **authored_at** | 2026-06-16T00:30:00Z |
| **decision** | PASS (advance with architect must-address list) |
| **concerns_count** | 9 |
| **severity_max** | CRITICAL |

---

## Scope Attacked

The in-scope app-native slice per `02-cto-advisor-review.md` and `01b-stakeholder-scope-decisions.json`:

- AC-1: Rotating refresh tokens + `/auth/token/refresh` endpoint
- AC-2: Immediate revocation on role/permission/remove/suspend
- AC-3: Rate limiting on auth endpoints
- AC-7: Invited-email sign-up guard
- AC-8: Multi-org selector on login
- AC-9: Session context (BFF + post-login redirect)
- Cookie→Bearer bridge + CSRF defense (existing, now load-bearing for new flows)
- Postgres RLS policies (0002, 0008, 0009)

Deferred items (Authentik, Google, MFA, Redis session store) are explicitly out of scope per SD-1.

---

## Concerns (ranked by severity)

---

### C-01 — Rotating refresh tokens: ZERO rotation logic ships in the current codebase (CRITICAL)

**Attack:** The spec (AC-1) mandates rotating refresh tokens as a `SD-2` decision. The CTO review describes the mechanics: on each `/auth/token/refresh` call, invalidate the old `user_session` row, insert a new one with a new `refresh_token_hash` and new `jti`. But the current code (`auth.service.ts`) does NOT ship this endpoint at all. `POST /api/v1/auth/token/refresh` is absent from `auth.routes.ts`. What exists instead is `POST /api/v1/bff/session/refresh` in `bff.routes.ts` — which only re-mints the ACCESS token with the current context, but does NOT rotate the refresh token at all. The `refreshSession()` method in `auth.service.ts` reuses the same `jti` indefinitely and never touches `refresh_token_hash`.

**Concrete flow targeted:** `auth.service.ts::refreshSession()` lines 338–349 + `bff.routes.ts::POST /api/v1/bff/session/refresh` lines 177–206. The refresh token stored in `user_session.refresh_token_hash` is never consumed, rotated, or validated by any current code path. A stolen 7-day refresh token from `user_session` cannot be detected — there is no reuse detection because the token is never checked against the DB during a refresh call.

**Blast radius:** A stolen refresh token is permanently valid for 7 days with no detection mechanism. Even if the user logs out, the `jti`-based logout revokes that session row — but a stolen raw refresh token value was never matched against `refresh_token_hash` during refresh, so there is no "use-and-rotate" lifecycle that makes theft visible.

**Severity:** CRITICAL

**Mitigation required:**
1. Ship `POST /api/v1/auth/token/refresh` as a separate endpoint (not just BFF). It must: (a) accept the raw refresh token, (b) hash it and query `user_session WHERE refresh_token_hash = $hash AND revoked_at IS NULL AND expires_at > NOW()`, (c) if found, set `revoked_at = NOW()` on the old row and insert a new `user_session` row with a new `jti`, new `refresh_token_hash`, and new `expires_at = NOW() + 7 days`, (d) mint a new 15-min access JWT on the new `jti`.
2. If the same `refresh_token_hash` is presented after the row is already `revoked_at IS NOT NULL` (replay of a used token), revoke ALL `user_session` rows for that `app_user_id` (token-family wipe) and return 401 with `SESSION_REVOKED`. This is the only theft-detection signal available in a Postgres-backed scheme.
3. The `bff.routes.ts` session/refresh route should be renamed to `bff/session/context-refresh` or similar to clarify it is a context update, not a refresh-token rotation. These are two distinct operations.

---

### C-02 — Revocation on remove/role-change: session kill is not wired (CRITICAL)

**Attack:** `invite.service.ts::removeMember()` (lines 316–362) calls `memberRepo.delete(memberId, ctx)` and then writes an audit entry. It does NOT call any session revocation. The `UserSessionRepository` has a `revoke()` method that revokes by `jti`, but there is no `revokeAllForUser()` or `revokeAllForUserAndBrand()` method on any repository. The same gap exists in `updateMemberRole()` (lines 262–313): it updates the role and audits, but never kills the affected user's sessions.

**Concrete flow targeted:** `invite.service.ts` lines 348 (after `memberRepo.delete`) — no call to session revocation exists. `UserSessionRepository` (repositories.ts lines 180–207) has no bulk-revocation method at all. The stakeholder decision `SD-3` mandates "REVOKE ON ALL CHANGES — any role/permission change or remove/suspend instantly revokes affected sessions." The code as shipped does the exact opposite: it silently continues.

**Blast radius:** A removed Brand Admin retains a valid 15-min access JWT and can continue to act within their former brand for up to 15 minutes — that window is the JWT TTL. More critically, they also retain a valid 7-day refresh token that will continue to mint new access JWTs. So the effective window after removal without session kill is 7 days, not 15 minutes. This directly violates the invariant "immediate revocation is non-negotiable" from the spec §1.2 and SD-3.

**Severity:** CRITICAL

**Mitigation required:**
1. Add `revokeAllForUserAndBrand(appUserId: string, brandId: string | null, ctx)` to `UserSessionRepository`. SQL: `UPDATE user_session SET revoked_at = NOW() WHERE app_user_id = $1 AND revoked_at IS NULL` (for org-wide revocation on suspend) or scoped to brand via a JOIN to the membership scope.
2. Call this from `removeMember()` immediately after `memberRepo.delete()` and within the same DB client (so the audit, delete, and revocation are in a single transaction if possible).
3. Call this from `updateMemberRole()` for all role changes (SD-3 is "ALL changes", not just demotions).
4. Add `revokeAllForUser(appUserId, ctx)` for the `app_user.status = 'suspended'` path (which currently has no code path at all for global suspension).
5. Both bulk revocations must emit audit entries per AC-10.

---

### C-03 — Rate limiting: not shipped, fail-open on Redis outage (HIGH)

**Attack:** `auth.routes.ts` and `bff.routes.ts` have zero rate-limiting code. The CTO review (AC-3) calls for 5 failed attempts per (email + IP) in 15 minutes using the CacheAdapter (Redis). The spec confirms Redis (ElastiCache, ADR-004) exists. But no rate-limit middleware, decorator, or call is present anywhere in the shipped code.

**Critical nuance — fail-open design:** The CTO review explicitly states "fail-open on Redis unavailability (do not block login if Redis is down — log and continue)." This is documented and intentional for M1. However, the fail-open posture means that if Redis is unavailable (ElastiCache node replacement, AZ outage, connection pool exhaustion), an attacker can brute-force the login endpoint indefinitely with zero throttling. At argon2id `m=19456, t=2`, each verify takes roughly 100ms on a modern CPU. A single core can attempt ~600 passwords/min. A modest botnet with 100 threads = 60,000 attempts/min per account with no lockout.

**Secondary surface:** The `forgot-password` endpoint is fire-and-forget (`authService.forgotPassword(...).catch(...)` — bff.routes.ts line 197-200 pattern also exists in auth.routes.ts lines 197-200). An attacker can enumerate the forgot-password flow timing side-channel: even though the response is always 200 with a constant body, the `forgotPassword()` method only sends an email if the user exists AND is active (auth.service.ts lines 386-412). The absence of a dummy hash computation (unlike the login path which always hashes) means the code path is 1 DB query for non-existent users vs. 1 DB query + email send for existing users. Without rate limiting, this timing difference is exploitable for account enumeration despite the neutral response.

**Severity:** HIGH (it's an acknowledged design gap — but with no ship date for the mitigation it becomes a standing HIGH)

**Mitigation required:**
1. Ship rate limiting before the feature reaches production. Per-email+IP counter in Redis. 5 attempts / 15 min → 429 with `Retry-After`.
2. Add a dummy async delay path on `forgotPassword()` for the not-found case to equalize timing (similar to the argon2 dummy hash on login). The fire-and-forget approach cannot be timing-equalized without a structured delay.
3. Rate limiting must cover `POST /api/v1/bff/session` (the BFF login path) in addition to `POST /api/v1/auth/login` — both funnel into `authService.login()` but the BFF path is the browser path and is the one a bot will hit.

---

### C-04 — Refresh-token replay after logout: session-family wipe not implemented (HIGH)

**Attack:** This is a specific sub-case of C-01 but deserves separate ranking. The spec AC-1 states: "If the same refresh token is presented twice (replay), revoke the entire token family (the old row) as a theft-detection heuristic." With no rotation logic shipped, a user who logs out (which sets `revoked_at = NOW()` on the `jti` row via `sessionRepo.revoke(jti, ctx)`) still has their raw refresh token value in the browser. When the attacker later presents that refresh token, there is no code path that checks it, detects it was already used, and wipes the family.

**Concrete flow targeted:** `auth.service.ts::logout()` lines 353–372 sets `revoked_at` by JTI. The `refresh_token_hash` on the same row is never invalidated in a way that signals "this was a legitimate logout" vs. "this is a replay of a stolen token." Without a `used_at` field or a `rotation_counter` on `user_session`, the system cannot distinguish the two scenarios.

**Severity:** HIGH (blocks the core theft-detection value of rotating tokens)

**Mitigation required:**
1. The rotation implementation from C-01 mitigation implicitly addresses this: once a refresh token is used-and-rotated, the old row is `revoked_at = NOW()`. If the same raw token hash appears again, the row is revoked → lookup returns null → return 401 AND wipe all sessions for that user (family wipe). Implement this as part of the AC-1 refresh endpoint.

---

### C-05 — Concurrent refresh race (two tabs) → token-family forking (HIGH)

**Attack:** With the rotating refresh token scheme (once implemented per AC-1), if two browser tabs simultaneously call `/auth/token/refresh` with the same refresh token, both requests read the same `user_session` row as valid (before either has committed the `revoked_at` update). Both mint new access JWTs and new refresh tokens. The DB `UNIQUE` constraint on `jti` (0002_auth.sql line 63) means only ONE `INSERT` into `user_session` succeeds. The second INSERT raises a constraint violation. Unless the application code handles this constraint error gracefully and presents a clear re-auth requirement, the second tab's refresh attempt may result in a silent failure or — worse — the first tab's new refresh token is a forked family where the family-wipe trigger would incorrectly kill a legitimate session.

**Concrete flow targeted:** `UserSessionRepository::insert()` (repositories.ts lines 135–157) — the INSERT uses `jti` as a UNIQUE key but does NOT have a `ON CONFLICT DO NOTHING` or `ON CONFLICT DO UPDATE` clause. The `findActiveByJti` lookup in `validateSession` does not prevent concurrent reads of the same row before the rotation write completes.

**Severity:** HIGH (race condition on the core security primitive)

**Mitigation required:**
1. Implement the refresh-token rotation within a Postgres transaction with `SELECT ... FOR UPDATE` on the `user_session` row being rotated. This serializes concurrent rotations on the same row: the second request either waits (and then sees `revoked_at IS NOT NULL`) or fails immediately.
2. On conflict from the `jti UNIQUE` constraint during the new-session INSERT, return a specific error code to the client instructing a re-login (not a silent 500).
3. Document the acceptable window: in practice, a `FOR UPDATE` lock means concurrent tabs serialize. The first succeeds; the second returns 401 with a session-replay signal and the client must re-login.

---

### C-06 — Multi-org selector: org membership verified from JWT claims, not server-side re-check (HIGH)

**Attack:** The CTO review (AC-8) requires a multi-org selector after login. The current code in `auth.service.ts::login()` resolves the active membership via `memberRepo.findActiveByUser()` and embeds `brandId`, `workspaceId`, and `role` into the JWT claims. Later, `validateSessionPreHandler` trusts these JWT claims to set `request.auth.workspaceId` and `request.auth.brandId`. Downstream handlers, including the BFF dashboard routes, use `auth.workspaceId` and `auth.brandId` directly from the JWT without re-validating that the user still holds membership in that org.

**Concrete scenario:** An adversary who was a member of Org A at login time obtains a 15-min access JWT with `workspace_id: OrgA`. They are then removed from Org A (which — per C-02 above — does not currently kill sessions). They continue to use the JWT for up to 15 minutes. But even after the session-revocation bug is fixed (C-02), if the JWT is still valid (within 15 min) and the session row is somehow not revoked, the `workspaceId` claim is server-trusted for all DB queries. If the multi-org selector allows a user to SELECT which org to enter by passing an `org_id` parameter, the system must verify at request time that the current JWT's `workspaceId` matches the user's actual membership.

**Separate injection surface:** `member.routes.ts::GET /api/v1/members` (line 123): `const organizationId = query.organization_id ?? auth.workspaceId`. This means a client can supply any `organization_id` as a query parameter and the system will use it as the workspace context — overriding what is in the JWT. The `inviteService.listMembers()` then runs a membership check for `requestingUserId` in `data.organizationId` (invite.service.ts lines 239-248). If the RLS policy on `membership` is correctly configured for `app.current_workspace_id`, the query should be filtered — but the application-layer membership check uses the attacker-controlled `organizationId`, not the JWT-verified one.

**Severity:** HIGH (potential cross-org membership enumeration)

**Mitigation required:**
1. The `organization_id` query parameter on `GET /api/v1/members` and `PATCH /api/v1/members/:id/role` and `DELETE /api/v1/members/:id` must be validated against `auth.workspaceId` from the JWT. An organization_id that does not match the session's workspace context must be rejected with 403.
2. The multi-org selector flow (AC-8) must be implemented as: after login, the server re-queries `memberRepo.findAll()` for that user, presents the list, the user selects an org, then the server re-mints the JWT with the selected org context AFTER verifying current membership. The org choice must not come from a client-supplied claim.

---

### C-07 — Invited-email guard: invite-accept does not check if accepting user's email matches (HIGH)

**Attack:** `invite.service.ts::acceptInvite()` (lines 121–213) accepts a raw token and an optional `acceptingUserId`. The invite is looked up by `token_hash`. If `acceptingUserId` is provided, the system creates a membership for that user — but there is NO check that the `acceptingUserId`'s email matches `inviteRow.email`. An attacker who intercepts or guesses an invite token can accept it using their OWN user ID, gaining membership in the target org with the role specified in the invite.

**Concrete flow:** `acceptInvite()` line 186: `memberRepo.insert({ appUserId: userId, roleCode: inviteRow.role_code })` — the `userId` comes from either `acceptingUserId` (caller-supplied) or a lookup by `inviteRow.email`. If `acceptingUserId` is provided, no email-match check is performed. The public HTTP endpoint at `POST /api/v1/invites/accept` passes `acceptingUserId` as undefined (member.routes.ts line 91: `await inviteService.acceptInvite(parsed.data.token, correlationId)`), so the current public surface does not supply `acceptingUserId`. However, `acceptInvite()` is a public method with an `acceptingUserId` parameter that any future caller could misuse — or a future route could expose.

**Secondary issue — email NOT verified at invite accept:** When `acceptingUserId` is null, the code finds an existing user by email (`userRepo.findByEmail(inviteRow.email, ctx)`) and uses their ID. It does NOT check `existingUser.emailVerifiedAt`. An unverified account can accept an invitation and gain brand membership without verifying email ownership.

**Severity:** HIGH

**Mitigation required:**
1. In `acceptInvite()`, when `acceptingUserId` is supplied, add: `const acceptingUser = await userRepo.findById(acceptingUserId, ctx); if (acceptingUser?.emailNormalized !== inviteRow.email.toLowerCase()) throw new InviteError('EMAIL_MISMATCH', 'Invite is for a different email address.', 403);`
2. When `acceptingUserId` is null and the user is found by email, check `existingUser.emailVerifiedAt !== null` before granting membership. If unverified, return `USER_UNVERIFIED` and require email verification first.
3. The `acceptingUserId` parameter pattern is risky even with the check above. Consider removing it and requiring the caller to be authenticated (session-based) with a separate protected route for authenticated invite-accept.

---

### C-08 — CSRF defense gap on BFF session/refresh: inconsistent double-submit implementation (MED)

**Attack:** The CSRF defense in `main.ts` (lines 188–221) applies the session-bound CSRF check only when a `brain_session` cookie is present AND the path is not in the exempt list. The `POST /api/v1/bff/session/refresh` (line 191 check) is NOT in the CSRF-exempt list — which is correct (it requires CSRF). However, the `bffProtectedPreHandler` in `bff.routes.ts` (lines 87–124) implements its own CSRF check (lines 107–115) that uses only a simple equality check: `csrfCookie !== csrfHeader`. It does NOT perform the session-binding HMAC check (`csrfTokenForSession(jti, cookieSecret)`) that the `main.ts` hook does.

**Concrete issue:** This means the BFF-protected routes (`DELETE /bff/session`, `GET /bff/me`, the dashboard routes) run through `bffProtectedPreHandler` which has a weaker CSRF check (no jti-binding), while routes going through the `main.ts` onRequest hook get the stronger session-bound check. There are now two code paths enforcing CSRF with different security levels. The `main.ts` hook runs FIRST (line 160) and the `bffProtectedPreHandler` also runs — they could conflict or one could be redundant, creating confusion about which check actually gates a request.

**Severity:** MED (the weaker check still blocks CSRF for same-origin attackers; the stronger check is belt-and-suspenders)

**Mitigation required:**
1. Consolidate CSRF validation into one place. Remove the duplicate check from `bffProtectedPreHandler` and rely solely on the session-bound `main.ts` hook, OR make `bffProtectedPreHandler` also use `csrfTokenForSession(jti, cookieSecret)` for the session-binding.
2. Document explicitly which CSRF check is authoritative.

---

### C-09 — Register endpoint: duplicate-email timing leak via email-verification re-send path (MED)

**Attack:** `auth.service.ts::register()` (lines 106–170) is designed to be timing-safe for the common duplicate-email case — it always runs `argon2.hash(password, ARGON2_PARAMS)` regardless of whether the user exists. However, the code branches at line 122: if the user exists AND is NOT yet verified, it sends a new verification email (`this.notification.sendVerificationEmail(...)`). If the user exists AND IS verified, it hashes the password but returns without sending any email or audit entry. The VERIFIED-existing case hashes once; the UNVERIFIED-existing case hashes once AND awaits a network call to the email service. Even though both return the same response body, the response TIME differs: the verified-existing case completes after one hash + one DB read, while the unverified-existing case completes after one hash + one DB read + one email round-trip. An attacker timing the `POST /register` response can distinguish "this email exists and is verified" from "this email exists and is unverified" — a partial enumeration oracle.

**Severity:** MED (partial oracle only — leaks verified/unverified state, not existence directly)

**Mitigation required:**
1. Fire the notification asynchronously (fire-and-forget) for the re-issue path, similar to the `forgotPassword` pattern, so the email send does not affect response timing.
2. Alternatively, always await the notification but add a constant-time pad to the overall response time.
3. Note: the "user exists + is verified" case still has a subtle leak because it does NOT call `sendVerificationEmail()` while the new-user case does. After (1) above, both existing paths return in ~1 argon2-hash time regardless of verified state.

---

## Tenant Isolation (I-S01) Assessment

No direct cross-tenant data path found in the current code. The RLS policies (0002, 0008, 0009) are correctly using the fail-closed two-arg `current_setting(..., TRUE)` form. The `organization_self_read` policy (0009) correctly limits visibility to orgs where the user holds a membership row. The `brand` table is RLS-scoped to `app.current_brand_id`.

**However:** The `GET /api/v1/members` route's `organization_id` override (C-06 above) is the highest cross-tenant risk. If an attacker supplies a foreign org's UUID as `organization_id`, the RLS policy on `membership` is set with `app.current_workspace_id = attacker_supplied_org_id` via the QueryContext. The application-layer membership check (`memberRepo.findByUserAndOrg(requestingUserId, data.organizationId, ...)`) would then find no membership for the attacker in that org and return 403 — the RLS fails closed ONLY because of the application-layer check, not because RLS independently blocks it. This is correct but fragile: if the application-layer check is ever skipped or refactored, RLS on `membership` set to the attacker-supplied workspace ID would then filter by that workspace — which the attacker does not belong to, so RLS returns 0 rows. This is safe by accident. The fix in C-06 removes the fragility.

---

## Summary Table

| # | Concern | Severity | AC Attacked | Code Location |
|---|---------|----------|-------------|---------------|
| C-01 | Refresh token rotation not implemented — endpoint absent, no reuse detection | CRITICAL | AC-1 | `auth.service.ts:refreshSession`, `bff.routes.ts:session/refresh` |
| C-02 | Remove/role-change does not kill sessions — 7-day window on stolen refresh token | CRITICAL | AC-2, SD-3 | `invite.service.ts:removeMember`, `updateMemberRole` |
| C-03 | Rate limiting not shipped; forgot-password timing oracle | HIGH | AC-3 | `auth.routes.ts`, `bff.routes.ts` |
| C-04 | Replay of used refresh token after logout: no family-wipe | HIGH | AC-1 | `auth.service.ts:logout`, `UserSessionRepository` |
| C-05 | Concurrent refresh race → token-family forking (missing SELECT FOR UPDATE) | HIGH | AC-1 | `UserSessionRepository:insert`, `findActiveByJti` |
| C-06 | Multi-org selector: attacker-controlled organization_id on member routes; cross-org risk | HIGH | AC-8 | `member.routes.ts:GET /members`, `invite.service.ts:listMembers` |
| C-07 | Invite-accept: no email-match check on acceptingUserId; unverified user can accept | HIGH | AC-7 | `invite.service.ts:acceptInvite` |
| C-08 | Dual CSRF implementations with different binding strength | MED | AC-9 | `main.ts:onRequest`, `bff.routes.ts:bffProtectedPreHandler` |
| C-09 | Register timing leak: verified-vs-unverified existing email oracle | MED | AC-7 | `auth.service.ts:register` |

---

## Must-address items for the Architect

1. **Ship AC-1 refresh endpoint with actual rotation.** The current BFF session/refresh route does not rotate. A new `POST /api/v1/auth/token/refresh` must: validate the raw refresh token against `refresh_token_hash`, revoke-and-rotate the row within a `SELECT FOR UPDATE` transaction, detect replay (revoked row = family wipe), and mint a new access JWT on the new `jti`.

2. **Wire session revocation on remove/role-change (AC-2/SD-3).** Add `revokeAllForUserAndBrand()` and `revokeAllForUser()` to `UserSessionRepository`. Call from both `removeMember()` and `updateMemberRole()`. Emit audit entries.

3. **Ship rate limiting before launch (AC-3).** Both `/auth/login` and `/bff/session` must be rate-limited. Cover the forgot-password timing oracle with a fire-and-forget or constant-delay pattern.

4. **Lock the multi-org selector org_id to the JWT's workspaceId (AC-8/C-06).** Any caller-supplied `organization_id` on member routes must match `auth.workspaceId` or be rejected.

5. **Add email-match check to invite-accept + require email-verified (AC-7/C-07).** Block membership grant for unverified users and for mismatched emails in the `acceptingUserId` path.

6. **Consolidate CSRF to one session-bound check (C-08).** Remove the weaker duplicate in `bffProtectedPreHandler` or upgrade it to session-binding.

7. **Register timing oracle: fire-and-forget the re-verification email (C-09).** Removes the partial enumeration side-channel.
