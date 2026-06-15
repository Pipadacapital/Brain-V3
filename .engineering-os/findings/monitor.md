# Monitor Findings

> Appended by /engineering-os:monitor. De-dupe before opening requirements.

## 2026-06-15T19:49:49Z — MED — unauthenticated /dashboard floods console with 401s
**URL:** http://localhost:3000/dashboard (and /settings/*)
**Captured:** 72 issues / 5 sweeps. Pattern (repeats every sweep):
```
http-error: 401 /api/bff/v1/auth/me
http-error: 401 /api/bff/v1/dashboard/brand-summary
http-error: 401 /api/bff/v1/dashboard/connection-status
http-error: 401 /api/bff/v1/dashboard/data-status
http-error: 401 /api/bff/v1/dashboard/onboarding-progress
console.error: Failed to load resource: 401 (Unauthorized) ×N
```
**Root cause:** No auth guard on the (dashboard)/(onboarding) route groups. An
unauthenticated (or session-expired) visit renders the shell and fires API calls
that 401, instead of redirecting to /login. Authenticated users get 200 (verified).
**Recommended action:** Add Next middleware that gates /dashboard & /settings on the
brain_session cookie → redirect to /login when absent; redirect to /login on 401 mid-session.
**Status:** fixing directly on branch fix/api-url-consistency (this session's workflow).

**RESOLVED 2026-06-15T19:52:49Z** — Added apps/web/middleware.ts (cookie gate → /login) + RequireSession client guard (401→/login). Re-ran monitor: 0 issues / 3 sweeps (was 72). Fixed on fix/api-url-consistency.
