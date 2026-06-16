# 11 — Final Review (Stage 6, independent go/no-go) — `feat-access-onboarding-flow`

| Field | Value |
|-------|-------|
| **req_id** | `feat-access-onboarding-flow` |
| **Stage** | 6 — Final Review (Engineering Advisor, Opus tier) |
| **Reviewed at** | 2026-06-16T04:25:00Z |
| **Branch** | `feat/access-onboarding-flow` (41 staged files: 40 product-code + 1 deletion) |
| **Lane** | `high_stakes` (auth, connectors, multi_tenancy, outbound_channel, pii, schema_changes) |
| **Upstream** | Security PASS (DELTA-R2), QA PASS (round 4 DELTA-R2) |
| **Bounce history** | r1: 8 findings · r2/r3: CRITICAL regression (invalid `SET LOCAL $1`, caught because the unit test was inert → replaced with live-PG test) |
| **Verdict** | **PASS → GO** |

This review did NOT rubber-stamp the upstream PASS. Every load-bearing check below was re-run on THIS machine (dev stack UP: Postgres `brainv3-postgres-1` healthy, Redis `brainv3-redis-1` healthy, core :3001, web :3000) with captured output.

---

## 1. Independent re-run table (captured on this machine)

| # | Check | Command | Result | Captured evidence |
|---|-------|---------|--------|-------------------|
| R1 | Full suite | `pnpm turbo run typecheck test:unit lint --force` | **PASS** | 75/75 turbo tasks; core unit 74/74; typecheck 0 errors; lint 0 violations; 4.176s |
| R2 | Live-PG family-wipe test non-skipped | (in R1) `family-wipe.live.test.ts` | **PASS 3/3** | 53ms duration (real PG, NOT skipped); LIVE-PG-1/2/3 green |
| R3 | isolation-fuzz | (in R1) `@brain/tool-isolation-fuzz` | **PASS 18/18** | NN-2 cross-brand/cross-tenant negative controls green |
| R4 | validity_check | `validity_check.py --paths apps/core/src --artifacts qa-review.verdict.json --require-negative-control` | **exit 0** | "clean (80 files scanned)" |
| R5 | **Family-wipe LIVE under `brain_app` (the regressed path)** | `SET LOCAL ROLE brain_app; set_config('app.current_user_id',...); UPDATE … WHERE family_id=…` | **PASS** | with set_config → **rowcount=3**; **negative control** (no set_config) → **rowcount=0**. This is the exact replay-containment path that regressed; the fix is real and the negative control is genuine. |
| R6 | `set_config` fix present, no residual `SET LOCAL $N` | `grep set_config / SET LOCAL $N` | **PASS** | `auth.service.ts:411 SELECT set_config('app.current_user_id', $1, true)`; zero remaining parameterized `SET LOCAL $N` in `apps/core/src` |
| R7 | Playwright e2e (4-step + ghost-404 + resume) | `pnpm --filter @brain/web test:e2e` | **PASS 3/3** | (1) register→verify→login→Step1→Step2→Step3 Skip→Step4 Done→dashboard→logout, zero uncaught errors (5.6s); (2) ghost `/invite` 404 (254ms); (3) resume: brand_created → Step 3 (1.5s) |
| R8 | BFF rate-limit single-count (SEC-AOF-N1) | `curl x6 wrong-password /bff/session` + Redis GET | **PASS** | attempts 1–5 → 401 INVALID_CREDENTIALS; attempt 6 → 429 RATE_LIMITED; **Redis counter = exactly 6** (double-count would trip at 3) |
| R9 | set-org / member routes fail-closed | `curl` without auth | **PASS** | set-org → 401 UNAUTHORIZED; `GET /members?organization_id=<foreign>` → 401 UNAUTHORIZED (auth boundary before org logic) |
| R10 | Brand CHECK rejects `placed` + non-allowlist currency | live INSERT under `brain` | **PASS** | `placed` → `brand_revenue_definition_check` violation; `USD` → `brand_currency_code_check` violation |
| R11 | Tenant-isolation (the ONE invariant) on new `onboarding_status` | `brain_app` no-GUC / wrong-WS / `brain` | **PASS** | brain (BYPASSRLS) = 16 orgs; brain_app no-GUC = 0 rows; brain_app wrong-workspace GUC = 0 rows for a real org |
| R12 | Migrations 0010–0012 applied | `information_schema` + `pg_constraint` | **PASS** | brand `currency_code/timezone/revenue_definition` + CHECKs; org `onboarding_status/onboarding_step`; user_session `family_id/rotated_from/used_at` |

**Spot-re-run requirement (≥3 QA gates):** satisfied and exceeded — R1 (suite), R5 (family-wipe brain_app), R7 (Playwright), R8 (rate-limit single-count), R10/R11 (CHECK + RLS negative controls) all independently reproduced with captured output. None could only be replicated by trusting the report.

---

## 2. Acceptance map (each in-scope AC → MET / SCAFFOLD / GAP + evidence)

| AC / item | Status | Evidence |
|---|---|---|
| **AC-1 — Rotating refresh tokens + `/auth/token/refresh`** | **MET** | Endpoint registered; rotation under `SELECT FOR UPDATE`; replay→family-wipe→401 SESSION_REVOKED (R5 live + LIVE-PG-3); `SESSION_CONFLICT` on jti 23505; sha256 hash only (R6) |
| **AC-2 — Revoke-on-all (role/remove/suspend/scope=all)** | **MET** | `revokeAllForUser(AndBrand)` present; `removeMember`/`updateMemberRole` revoke in same raw-pg txn; suspend service method + scope=all logout; audit `sessions.bulk_revoked` |
| **AC-3 — Rate limiting + timing equalization** | **MET** | login/bff-session/forgot/register/refresh capped; **fail-open** on Redis error (rate-limiter:46); single-count proven (R8); forgot/register fire-and-forget |
| **AC-4 — Brand `currency_code/timezone/revenue_definition`** | **MET** | Migration 0010 + CHECKs (R10); region derived server-side; currency immutability guard (42P01-safe); money pairs `CHAR(3)` + `*_minor`, no float |
| **AC-5 — `onboarding_status` resume** | **MET** | enum on `organization`; forward-only advance (`onboarding_step < $newStep`); `needs_onboarding` boolean removed from every BFF response; resume proven (R7 test 3) |
| **AC-6 — 4-step wizard + currency/timezone/revenue** | **MET** | Steps "of 4" on all 4 pages; Step 2 has currency/timezone/revenue selects, **no Placed**; Step 3 integrations + Skip-For-Now; Step 4 Done; ghost `/invite` deleted (R7 test 2) |
| **AC-7 — Invited-email guard + acceptInvite hardening + dup UX** | **MET** | EMAIL_MISMATCH/USER_UNVERIFIED 403 inside BEGIN…COMMIT; markAccepted after guards; register INVITE_PENDING; verification fire-and-forget |
| **AC-8 — Multi-org set-org + member-route scoping** | **MET** | set-org membership check (`findByUserAndOrg` via GUC-wrapped client) BEFORE refreshSession → 403; member GET/PATCH/DELETE 403 on org mismatch; server re-verified, no claim override |
| **AC-9 — BFF session contract + CSRF consolidation** | **MET** | `onboarding_status` replaces `needs_onboarding`; snake_case auth sub-object; CSRF single authoritative check in `main.ts`, weak BFF duplicate removed, refresh exempt |
| **AC-10 — Audit coverage** | **MET** | `membership.removed`/`membership.role_changed`/`user.suspended`/`sessions.bulk_revoked {count,reason}` via `@brain/audit` in-txn |
| **Stakeholder tested complaint** (redirect skipping steps; 2-step not 4-step; missing currency/timezone) | **MET** | R7 test 1 (full 4-step flow, no step-skip) + test 3 (resume to exact step) + currency/timezone/revenue selects in Step 2 — all reproduced on this machine |

**Counts: MET = 11 / 11 · MET_AS_SCAFFOLD = 0 · GAP = 0.**

Note on AC-2 suspend: there is no member-facing suspend *route* in M1 (plan-sanctioned — `03 §B-2`); the repo method + service method + audit + unit test ship and the route is documented post-M1. This is the plan's explicit decision, not a gap.

---

## 3. Scope discipline + Canon audit

| Check | Result |
|---|---|
| Deferred items OUT (Authentik/OIDC, Google one-tap, MFA/TOTP/FIDO, remember-me/trusted-device, Redis-session-store) | **CLEAN** — all absent from added lines |
| Over-engineering (new table/service/queue/worker beyond plan) | **CLEAN** — 3 additive column-migrations only; no new table/service/queue |
| New dependencies | **1** — `ioredis@^5.11.1` (plan-sanctioned, AC-3; Redis already provisioned ADR-004) |
| Single-Primitive | **CLEAN** — extends `user_session`/`UserSessionRepository`/Redis CacheAdapter/`AuditWriter`; CSRF consolidated TWO→ONE (net reduction) |
| Canon: `revenue_definition` excludes `placed` | **HELD** — form + Zod + DB CHECK all `('realized','delivered')`; R10 rejects `placed` |
| Canon: currency rules (`CHAR(3)` allowlist, money `*_minor`, no float) | **HELD** — R10 rejects `USD`; no float columns added |
| Canon: the ONE invariant (tenant isolation) | **HELD** — R11 (brain_app fail-closed) + isolation-fuzz 18/18 + NC-01..04 |
| Canon: passwords/tokens never logged; sha256-only | **HELD** — R6; the one `console.error` logs `{correlationId, err}` only; no plaintext token columns |
| Migrations 0010–0012 rollback documented | **HELD** — MANUAL ROLLBACK PROCEDURE blocks (SEC-AOF-M3); DOWN-block→comment deviation is driven by a real node-pg-migrate parser constraint and documented |
| Paradigm | Tier-1 deterministic, **$0 model spend** — no model call anywhere; no paradigm escalation beyond plan |

**Hard-rule deviation check:** none. No dependency violation (ioredis is sanctioned), no Single-Primitive violation, no compliance gap, no paradigm escalation beyond plan, no un-codified gate-skip. Nothing requires Stakeholder-only adjudication.

---

## 4. Honesty-of-done spot-check (skeptical re-verification of "done" claims)

The round-2 report once falsely claimed `/bff/session/onboarding/advance` was delivered when it 404'd. Verified directly:

- **`onboarding/advance` endpoint** — now genuinely registered (`bff.routes.ts:363`); the false-done claim is closed. (Source-confirmed; reachable behind cookie+CSRF.)
- **set-org membership guard** — `findByUserAndOrg` via a `pool.connect()` GUC-wrapped client BEFORE `refreshSession` (`bff.routes.ts:311→328`); fail-closed 403. Confirmed in source, not just the report.
- **Family-wipe under brain_app** — the report's headline claim (rowcount>1 under set_config) reproduced independently (R5): 3 with set_config, 0 without. The claim is honest.
- **Rate-limit single-count** — report claim "trips at 6 not 3" reproduced independently (R8); Redis counter=6.

No discrepancy between report claims and reality on the items spot-checked.

---

## 5. Residual risk register (LOW only — none blocking)

| ID | Sev | Item | Why not a bounce |
|---|---|---|---|
| RR-1 | LOW | Member-route org guard fires only when both `query.organization_id` AND `auth.workspaceId` are present; if `auth.workspaceId` is null it falls back to the query param | Plan-sanctioned first-login/unauthenticated-workspace fallback; RLS still fail-closes data access (R11). Defense-in-depth, not the primary control. |
| RR-2 | LOW | Migrations use MANUAL ROLLBACK comment blocks instead of executable `-- DOWN` (node-pg-migrate parser quirk) | Rollback is fully documented + precondition-gated; consistent with 0001–0009; reversible only inside deploy window (documented). |
| RR-3 | LOW | AC-2 suspend has no member-facing route in M1 (service+repo+audit+test only) | Plan-sanctioned post-M1; capability (the AC requirement) ships. |
| RR-4 | LOW | Playwright e2e requires the live stack (no `webServer` auto-start); CI must `docker-compose up` first | Stack was UP; 3/3 reproduced here. Note for the deploy runbook. |

No CRITICAL/HIGH/MED open. `open_critical_high = 0`.

---

## 6. Retro (auto-candidate check)

**Root cause of the costly bounce (r2→r3):** a security fix introduced invalid Postgres syntax (`SET LOCAL app.current_user_id = $1` → 42601) on the tenancy-critical family-wipe path, and it escaped because the unit test was **inert** (asserted a string, never executed against Postgres). It was only caught at re-review and fixed by replacing the mock with a genuine live-PG test (`family-wipe.live.test.ts`) that fails if `set_config` is removed.

**Lesson:** on tenancy/auth paths under `brain_app` (NOBYPASSRLS), a mock-only test is structurally incapable of catching a GUC/SQL-syntax defect — the DEV superuser `brain` bypasses RLS and hides the failure. Any RLS/GUC-dependent assertion MUST run under `SET ROLE brain_app` against live Postgres with a negative control (remove the GUC → expect 0 rows).

**Auto-candidate rule (≥3 distinct prior runs):** This is the first run in this repo's run history exhibiting the "inert unit test masked a live-PG RLS defect" root cause at this severity. It does NOT yet meet the ≥3-distinct-prior-run threshold, so **no `rule-proposals/` file is written** and nothing is appended to `pending-stakeholder-attention.md`. Recorded here as a watch-item; if a second/third run repeats it, propose a durable rule: "RLS/GUC assertions require a live-PG test under `brain_app` with a GUC-removed negative control."

---

## 7. Recommendation

**PASS → GO.** Advance to the Stakeholder gate (Stage 7). All in-scope ACs MET (11/11), 0 open CRITICAL/HIGH, the regressed family-wipe path is independently proven fixed with a real negative control, the Stakeholder's tested complaints are reproduced as fixed on this machine, scope and Canon are clean, and no hard-rule deviation requires Stakeholder-only adjudication beyond the normal deploy approval.

Mechanical commit command (explicit product-code paths; no `git add -A`; `.engineering-os/` state excluded) is staged in `pending-stakeholder-commit.md`.
</content>
</invoke>
