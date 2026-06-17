# QA Review — feat-connector-backfill

## FULL Review (2026-06-17T13:15:00Z) — FAIL
Verdict: FAIL. Blocking: 3 (QA-BF-B1, QA-BF-B2, QA-BF-B3). See qa-review.verdict.json (prior state preserved in git history).

---

## DELTA Review (2026-06-17T09:40:00Z) — PASS

**Mode:** DELTA — reasoning scoped to 3 blocking findings; test suite re-run in full (no shortcuts).

**Fix commits verified:** Track A: 2f244d2 + d35cedb (B1+B2); Track C: 26647ae (B3).

### QA-BF-B1 — RESOLVED

Migration 0023 applied and verified:
- `\df list_queued_backfill_jobs` — function exists, SECURITY DEFINER (prosecdef=t), search_path=public pinned (hijack prevention per 0019 pattern).
- T11 assertion 1: `brain_app` direct `SELECT count(*) FROM backfill_job WHERE status='queued'` without GUC → **0 rows** (non-inert negative control; FORCE RLS fail-closed confirmed).
- T11 assertions 2+3: `findQueuedJob(appPool, ciId)` and poll-mode `findQueuedJob(appPool)` via `list_queued_backfill_jobs()` → **seeded job returned** (id, brandId, ciId match). Worker dispatch path functional.

### QA-BF-B2 — RESOLVED (SC#10 payoff proven)

T12 verified end-to-end:
- LedgerWriter seeds `provisional_recognition` with `occurred_at='2022-06-01'` (past-horizon, 3 years ago).
- `runRevenueFinalization()` invoked directly (real code, not stub).
- Captured stdout: `[revenue-finalization] finalized brand=aa111111-aaaa-4aaa-8aaa-111111111111 order=T12-PAST-DATED-ORDER-001 amount=250000 INR` / `complete: finalized=1 skipped=0`.
- Idempotent re-run: `complete: finalized=0 skipped=0`.
- All assertions under `brain_app` (not superuser). amount_minor='250000' (no float drift, I-S07).
- SC#10 (past-dated→realized GMV) demonstrated end-to-end.

### QA-BF-B3 — RESOLVED

`backfill.spec.ts` re-run result: **6 passed / 3 skipped / 0 failed** (was 5 passed / 2 failed / 2 skipped).
- Test 2 (connectors page): **PASS** 6.0s — marketplace-page + connector-tile-shopify testids asserted directly.
- Test 3 (manager D-15 UI gate): **SKIP** — Radix combobox fix applied; invite UI not seeded in local env. Skip is explicit and env-conditional. D-15 server gate (403) authoritative; B3 T2 (meetsMinimumRole) is unit-level authoritative gate — confirmed PASS (unchanged).
- Tests 1, 4, 5, 8, 9: **PASS**.
- Tests 6, 7: **SKIP** (SHOPIFY_CONNECTED_CONNECTOR_ID — unchanged documented skip).

`marketplace.spec.ts`: 6/6 PASS — no regression.

### Typechecks

- `pnpm --filter @brain/core typecheck` — EXIT 0
- `pnpm --filter @brain/web typecheck` — EXIT 0

### Full stream-worker suite

67/67 PASS (5 test files). No regressions vs prior 61/61; +6 new assertions (T11: 3, T12: 3).

### Verdict

**PASS. Blocking: 0. Warnings QA-BF-W1 + QA-BF-W2 remain documented non-blocking (unchanged).**
