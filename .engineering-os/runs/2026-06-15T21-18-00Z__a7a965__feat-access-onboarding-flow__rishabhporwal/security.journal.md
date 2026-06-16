
## 2026-06-16T00:10:00Z — Security Reviewer — feat-access-onboarding-flow
**Stage:** 4 · **Mode:** DELTA · **Verdict:** BOUNCE
**Findings:** 0 CRIT / 1 HIGH (OPEN — REGRESSION) / 1 MED (OPEN — NEW) / 0 LOW
**Scanners:** delta-skip (FULL scan ran in prior review; no new deps/images in bounce-fix-r2 beyond ioredis already present)
**Diff scope:** bounce-fix-r2 — 40 files; key changes: auth.service.ts SET LOCAL fix, bff.routes.ts SEC-AOF-H1+rate-limiter+onboarding/advance, member.routes.ts M1, migrations M3, critical-paths.test.ts QA-06

**Summary:**
- SEC-AOF-H1 (HIGH): RESOLVED — live-proven: non-member → 403, member → 200 + onboarding_status. MembershipRepository.findByUserAndOrg() called before refreshSession(). GUC-wrapped pool. PASS.
- SEC-AOF-L1 (was LOW, now HIGH REGRESSION): OPEN — bounce-fix introduced `SET LOCAL app.current_user_id = $1` parameterized query. Postgres SET statement does not accept parameterized placeholders via extended protocol → 42601 syntax_error. Replay path returns 500 (not 401 SESSION_REVOKED). Family wipe UPDATE never executes. Sibling sessions remain active. Unit test in critical-paths.test.ts:193-225 is an inert probe (mock intercepts any string containing 'SET LOCAL' — does not validate Postgres syntax). Fix: use `SELECT set_config('app.current_user_id', $1, true)` instead. Live proof: replay of RT1 → 500/42601; RT2 sibling remains revoked=f in DB.
- SEC-AOF-N1 (MED, NEW): OPEN — /bff/session loginFailKey double-counted (incremented at entry AND in catch). Effective limit 2 failures not 5. Mirror auth.routes.ts pattern. No bypass, just over-aggressive throttle.
- SEC-AOF-M1/M2/M3: RESOLVED — code-verified.
- B-1 happy path: PASS. B-1 replay/family-wipe: FAIL (SEC-AOF-L1). B-2 scope=all: PASS (0 sessions after).
- Tenant isolation: preserved on all new surfaces.

**Next:** bounce_target=backend-developer (SEC-AOF-L1 + SEC-AOF-N1)

## 2026-06-16T04:15:00Z — Security Reviewer — feat-access-onboarding-flow
**Stage:** 4 · **Mode:** DELTA-R2 · **Verdict:** PASS
**Findings:** 0 CRIT / 0 HIGH / 0 MED / 0 LOW open · **Scanners:** delta-skip (full scan ran in FULL review; no new deps in bounce-fix-r3) · **Next:** reconcile with QA (PASS)
**SEC-AOF-L1/QA-08:** RESOLVED — set_config('app.current_user_id',$1,true) at auth.service.ts:411. Replay→401 SESSION_REVOKED (not 500). DB rowcount=3 (>1). LIVE-PG-1/2/3 green under brain_app NOBYPASSRLS. Unit test non-inert. Zero remaining SET LOCAL $N in apps/core/src.
**SEC-AOF-N1:** RESOLVED — loginFailKey single-counted (catch only); success resets both keys; 4 fails→correct pwd→200; trips at 5 failures (429 on 6th). Mirrors auth.routes.ts.
**Regression:** 9 previously-closed findings remain closed. B-1 replay+wipe PASS. B-2 not regressed. Isolation preserved. 74/74 tests.
