# QA Journal — feat-access-onboarding-flow

## 2026-06-16T03:05:00Z — QA Engineer — feat-access-onboarding-flow (Round 1)
**Stage:** 5 · **Mode:** FULL · **Verdict:** BOUNCE
**Smoke:** 2/3 FAIL (main 4-step flow crashed Step 3) · **Parity:** N/A · **Validity:** exit 3 (no unit tests on new auth paths) · **Next:** backend-developer (QA-01,02,03,06,07) + frontend-web-developer (QA-04,QA-05)

7 bounce findings: QA-01 CRITICAL (advance endpoint 404), QA-02–03,05,06,07 HIGH, QA-04 HIGH (test infra). RLS controls all PASS. Replay/family-wipe proven. Revoke-on-remove proven.

---

## 2026-06-16T03:54:00Z — QA Engineer — feat-access-onboarding-flow (Round 2 delta re-review)
**Stage:** 5 · **Mode:** DELTA (reasoning scope: QA-01–QA-07); FULL suite (tests) · **Verdict:** BOUNCE
**Smoke:** 3/3 PASS · **Parity:** N/A · **Validity:** validity_check exit 0 (79 files) · **Next:** backend-developer (QA-08 regression)

QA-01–QA-07 all CLOSED with live curl evidence. Full suite green (34/34 typecheck, 71/71 unit, 18/18 lint, 3/3 Playwright). AUTO-BLOCK on QA-08: SEC-AOF-L1 fix introduced `SET LOCAL app.current_user_id = $1` using parameterized query — Postgres rejects this with 42601 (syntax_error). Replay detection path returns 500 not SESSION_REVOKED; family-wipe does not execute. Prior-green path (replay → SESSION_REVOKED) is now RED in the live server. Fix: use string interpolation `SET LOCAL app.current_user_id = '${row.app_user_id}'` (UUID character set is safe). RLS controls all PASS. Revoke-on-remove PASS.

---

## 2026-06-16T00:40:00Z — QA Engineer — feat-access-onboarding-flow (Round 4 delta-r2)
**Stage:** 5 · **Mode:** DELTA-R2 (reasoning: QA-08 + SEC-AOF-N1 scope); FULL suite (tests) · **Verdict:** PASS
**Smoke:** 3/3 PASS (10.2s) · **Parity:** N/A · **Validity:** exit 0 with artifacts (80 files clean, NC-01–NC-10) · **Next:** Security Reviewer reconciliation

QA-08 CLOSED: set_config replaces broken SET LOCAL $1. Live curl proof: replay → HTTP 401 SESSION_REVOKED; RT1 → HTTP 401 SESSION_REVOKED (family-wipe DB confirmed 2/2 rows revoked). Live-PG test (family-wipe.live.test.ts 3/3 PASS, no skips, non-inert: removing set_config → brain_app RLS 0 rows → assertion fails). SEC-AOF-N1 CLOSED: single-count confirmed — 5 fails before first 429 (not 3 as with double-count); Redis counter=6; correct password after 4 fails → 200 (reset works). Full suite: 34/34 typecheck, 74/74 unit (3 live-PG + 71 prior), 18/18 lint, 3/3 Playwright. No regressions. All 9 bounce findings from rounds 1-4 closed.
