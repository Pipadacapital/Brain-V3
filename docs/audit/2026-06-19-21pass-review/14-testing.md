# Pass 14: Testing Audit (2026-06-19)

**Date:** 2026-06-19
**Auditor:** Principal-Level CTO Audit Pipeline
**Board:** Testing

---

## Board Verdict

The test suite contains high-quality islands — RLS isolation-fuzz tests, metric-engine boundary tests, AI eval golden-set, and contract-boundary seam tests are genuinely excellent. However, the stream-worker test subsystem is structurally broken in CI: `test:unit` includes 20+ e2e tests via `src/**/*.test.ts` but `.github/workflows/pr.yml` provides only Postgres (no Redis, no Kafka). Only `pipeline-wire.e2e.test.ts` has an `allInfraUp()` guard; the rest fail at `beforeAll` with ECONNREFUSED or FK violations from hardcoded dev-only brand UUIDs. A self-referential dedup metric test bypasses the actual production emission path in `CollectorEventConsumer.ts` entirely. Thirty-eight Playwright E2E specs exist and are not wired into CI. The AI eval workflow is a TODO stub. Billing, recommendation, job-orchestration, and the 2,554-line `bff.routes.ts` (sole analytics DB read path) have zero test coverage. There is no code coverage enforcement anywhere. The net effect: CI gives a green signal on the stream-worker pipeline that is structurally unable to validate the component it claims to test.

**Severity counts:** 2 Critical, 3 High, 2 Medium

---

## Finding TESTING-1

**Title:** stream-worker `test:unit` runs 20+ e2e tests in CI without Redis or Kafka infrastructure

**Severity:** Critical
**Priority:** P0
**Category:** CI Infra / Test Isolation

**Evidence:**
- `apps/stream-worker/vitest.config.ts:5` — `include: ['src/**/*.test.ts']` captures all test files including those with `.e2e.` in their names
- `.github/workflows/pr.yml:63` — `pnpm turbo run ... test:unit --affected`; CI matrix provides only `postgres:16` service; no Redis, no Kafka/Redpanda
- `apps/stream-worker/package.json` — `"test:unit": "vitest run --passWithNoTests"` uses the same config, no glob exclusion for e2e

**Root Cause:** The vitest include glob `src/**/*.test.ts` does not distinguish between pure unit tests and e2e tests that require live infrastructure. Only `pipeline-wire.e2e.test.ts` has an `allInfraUp()` guard that produces a graceful skip. All other stream-worker e2e tests (`identity.e2e.test.ts`, `consent-suppressor.e2e.test.ts`, `ingest-hardening.e2e.test.ts`, `dedup-adapter.e2e.test.ts`, etc.) fail at `beforeAll` with ECONNREFUSED or FK violations.

**Impact:** CI fails or silently suppresses stream-worker test failures. The `passWithNoTests: true` flag means the job may still exit 0 if Vitest treats connection failures as non-test errors in certain modes. Either outcome is wrong: real failures are swallowed or CI is red on every PR.

**Tenant Impact:** The stream-worker processes all ingest events and is the primary multi-tenant dedup/isolation layer. A broken CI gate means regressions in tenant isolation and dedup correctness can ship undetected.

**Fix:** Add a `test:unit` vitest config (or a separate `exclude` list) that omits `**/*.e2e.test.ts` for the unit run. Add a `test:e2e` target in `turbo.json` that is gated on a `[needs: infra]` label or a matrix with Redis+Kafka services. Wire `pipeline-wire.e2e.test.ts`'s `allInfraUp()` guard pattern to all e2e files as an interim measure.

**Detection:** Run `pnpm turbo run test:unit --affected` in a clean environment without Redis — stream-worker tests will ECONNREFUSED.

---

## Finding TESTING-2

**Title:** `identity.e2e.test.ts` and `consent-suppressor.e2e.test.ts` use hardcoded dev-only brand UUIDs without seeding

**Severity:** Critical
**Priority:** P0
**Category:** Test Environment Parity / Hardcoded State

**Evidence:**
- `apps/stream-worker/src/tests/identity.e2e.test.ts:49-51`:
  ```typescript
  const BRAND_A = 'eefda8d9-2ee5-42a8-a667-06af5e51a99c';  // Smoke Brand
  const BRAND_B = 'ef1b8fe7-bad9-4400-87ca-778d7b1a9a37';  // Resume Brand
  ```
- `apps/stream-worker/src/tests/identity.e2e.test.ts:240-262` — `beforeAll` block contains no `INSERT INTO brand` statement; assumes these UUIDs exist in the DB
- `apps/stream-worker/src/tests/consent-suppressor.e2e.test.ts:38-39` — identical hardcoded UUIDs

**Root Cause:** These UUIDs exist only in the developer's local or staging database. Tests were written against an already-seeded dev environment and were never made self-seeding. Any clean CI Postgres instance will produce FK violations on first `INSERT INTO pixel_event WHERE brand_id = 'eefda8d9...'`.

**Impact:** Tests always fail in CI on a clean database. The FK violation is opaque — the error message names the constraint, not the brand seeding gap. False green if `passWithNoTests` swallows the failure.

**Tenant Impact:** Cross-tenant isolation tests are the highest-value tests in the suite. If they cannot run in CI, regressions in tenant boundary enforcement are invisible until production.

**Fix:** Add `beforeAll` seeding: `INSERT INTO brand (id, workspace_id, name) VALUES ($BRAND_A, ...) ON CONFLICT DO NOTHING` using a self-contained UUID generated per-run (or a stable test UUID documented as test-only). Remove hardcoded prod-seeded UUIDs. After the test: `DELETE FROM brand WHERE id IN ($BRAND_A, $BRAND_B)`.

**Detection:** Run the test against a fresh `CREATE DATABASE` Postgres instance — FK violation on first event insert.

---

## Finding TESTING-3

**Title:** Dedup metric observability test is self-referential — bypasses production emission point in `CollectorEventConsumer.ts`

**Severity:** High
**Priority:** P1
**Category:** False Confidence / Test Correctness

**Evidence:**
- `apps/stream-worker/src/tests/ingest-hardening.e2e.test.ts:418-425`:
  ```typescript
  const { incrementCounter } = await import('@brain/observability');
  incrementCounter('collector_dedup_conflict_total', {
    brand_id: second.brandId ?? 'unknown',
    layer: 'redis',
    event_name: second.eventName ?? 'unknown',
  });
  const hit = recorded.find((m) => m.name === 'collector_dedup_conflict_total');
  expect(hit, '...').toBeDefined();
  ```
  The test itself calls `incrementCounter` directly.
- `apps/stream-worker/src/interfaces/consumers/CollectorEventConsumer.ts:108-113` — actual production emission:
  ```typescript
  if (result.outcome === 'pk_conflict' || result.outcome === 'dedup_hit') {
    incrementCounter('collector_dedup_conflict_total', { ... });
  }
  ```

**Root Cause:** The test author recorded the metric sink correctly but then called `incrementCounter` from the test body rather than exercising the full `CollectorEventConsumer` → `ProcessEventUseCase` → dedup → counter path. The assertion only proves that the metric sink works (trivially true) — it does NOT prove that `CollectorEventConsumer` emits the metric on a real duplicate.

**Impact:** If `CollectorEventConsumer.ts:109` were deleted or the condition changed, this test would still pass. Zero regression protection for the actual observability path.

**Tenant Impact:** `collector_dedup_conflict_total` is the primary signal for detecting dedup failures per brand. Silent failures in this metric would mask per-tenant dedup regressions in production alerting.

**Fix:** Remove the direct `incrementCounter` call from the test body. Instead, send two identical events through the real `CollectorEventConsumer.processEvent()` path and assert that the metric sink recorded the counter from the consumer's own emission. The test must exercise `CollectorEventConsumer.ts:108-113`, not bypass it.

**Detection:** Delete `CollectorEventConsumer.ts:108-113` — the test still passes. That proves the test is self-referential.

---

## Finding TESTING-4

**Title:** 38 Playwright E2E specs and the AI eval workflow are never run in CI

**Severity:** High
**Priority:** P1
**Category:** CI Coverage Gap

**Evidence:**
- `.github/workflows/pr.yml` — no `test:e2e` step anywhere in the file; only `test:unit`, `test:contract`, `test:isolation`, `test:parity`
- `apps/web/playwright.config.ts` — Playwright config exists with 30+ test files in `apps/web/e2e/`
- `.github/workflows/eval.yml:9` — `run: 'echo "TODO: run AI eval gates"'` — the eval workflow is a stub
- `apps/core/src/modules/ai/evaluation/nlq-resolution.eval.test.ts` — well-written AI honesty gate with golden-set mocks; never triggered in CI

**Root Cause:** Playwright E2E tests and AI eval tests were written but the CI integration step was deferred. The `eval.yml` workflow was scaffolded but not implemented.

**Impact:** The entire web UI (30+ E2E scenarios) and the AI NLQ honesty gate (the primary safety check for the LLM resolution path) receive zero CI validation. Any regression in the web layer or AI response path is invisible until manual QA.

**Tenant Impact:** The web analytics dashboard is the primary stakeholder-visible surface. Broken UI regressions affect all tenants. The AI honesty gate blocks fabricated numbers from reaching users — its absence in CI means this safety property is unverified on every PR.

**Fix:** Add `test:e2e` step to `pr.yml` with `npx playwright test --reporter=github` against a started web server (`pnpm --filter web start &`). Implement `eval.yml` to run `vitest run --reporter=verbose` in `apps/core/src/modules/ai/evaluation/`. Both can run on `[needs: e2e]` labeled PRs or nightly, separate from the fast PR check.

**Detection:** Search `pr.yml` for `playwright` or `eval` — zero matches.

---

## Finding TESTING-5

**Title:** AC-7 atomicity test in `critical-paths.test.ts` contains dead code that computes `insertIdx`/`acceptIdx` on an empty array

**Severity:** Medium
**Priority:** P2
**Category:** Test Correctness / Dead Code

**Evidence:**
- `apps/core/src/modules/workspace-access/tests/critical-paths.test.ts:507-562`:
  ```typescript
  const { queries } = makeInviteService(invite, user);  // queries is empty []
  const insertIdx = queries.findIndex(sql => sql.includes('INSERT INTO membership'));  // always -1
  const acceptIdx = queries.findIndex(sql => sql.includes("UPDATE invite SET status = 'accepted'"));  // always -1
  // At this point queries is empty — run the operation first.  ← comment admits this
  const { inviteService } = makeInviteService(invite, user);  // SECOND inviteService instance
  await inviteService.acceptInvite(rawToken, CORR, 'user-0001');
  // ... third inviteService (svc2) with its own queries2 — real assertions use insertIdx2/acceptIdx2
  void insertIdx;  // suppresses "unused variable" — explicit admission of dead code
  void acceptIdx;
  ```

**Root Cause:** `makeInviteService` creates a new service instance with a fresh `queries` array each time it is called. The first call returns an empty array before any operation is run. The developer noticed this (comment: "At this point queries is empty — run the operation first") but left the dead variables instead of removing them. The real assertions correctly use `queries2` from the third service instance.

**Impact:** The dead variables create a misleading audit trail — a reader might believe `insertIdx === -1` represents a real test failure or intentional skip, when it is structurally impossible for it to be anything else.

**Tenant Impact:** The invite atomicity path (AC-7) is a multi-tenant security boundary. The actual assertions in `queries2` do cover the real path correctly, so there is no missing coverage — only dead code that obscures test intent.

**Fix:** Remove the first `makeInviteService` call and the `insertIdx`/`acceptIdx` variables entirely. Start directly with the `inviteService` + `await inviteService.acceptInvite(...)` call, then the `svc2` assertions on `queries2`.

**Detection:** Static analysis: `void insertIdx` + `void acceptIdx` immediately after `findIndex` on a known-empty array.

---

## Finding TESTING-6

**Title:** Zero test coverage for billing, recommendation, job-orchestration modules and the 2,554-line `bff.routes.ts`

**Severity:** High
**Priority:** P1
**Category:** Coverage Gap / Untested Critical Path

**Evidence:**
- `apps/core/src/modules/billing/` — directory contains stub implementation files, zero `.test.ts` files
- `apps/core/src/modules/recommendation/` — same: stub stubs, zero tests
- `apps/core/src/modules/job-orchestration/` — zero tests
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts` — 2,554-line file; sole DB read path for all analytics API endpoints (KPIs, revenue snapshot, attribution, journey timeline, ask-brain); zero test coverage. Confirmed by absence of any `.test.ts` in `apps/core/src/modules/frontend-api/`

**Root Cause:** These modules were scaffolded as stubs for future slices (billing, recommendation) or grew organically (bff.routes.ts) without tests being added alongside. The BFF routes file is particularly high-risk because it is the only path between the analytics DB and the web dashboard.

**Impact:** Any regression in the analytics API response shape, error handling, or tenant isolation at the BFF layer is undetected by the test suite. The billing module — while currently a stub — will grow without a test harness.

**Tenant Impact:** `bff.routes.ts` sets the GUC parameters (`app.current_brand_id`, `app.current_workspace_id`) that RLS policies enforce. A bug in GUC setup in this file bypasses all downstream RLS isolation tests. This is the most critical gap: the seam where tenant context is established is untested.

**Fix:** Add a `bff.routes.test.ts` with at minimum: (1) a GUC injection test — spy on `db.execute(sql.raw(...set app.current_brand_id...))` and assert it is called with the correct brand ID from the JWT claim before any data query; (2) a wrong-tenant rejection test using the `brain_app` role. For billing/recommendation stubs, add placeholder test files with a single `it.todo('implement when module ships')` to ensure they appear in coverage reports.

**Detection:** `find apps/core/src/modules/frontend-api -name "*.test.ts"` — zero results.

---

## Finding TESTING-7

**Title:** No code coverage enforcement — no `--coverage` flag or threshold in any vitest config

**Severity:** Medium
**Priority:** P2
**Category:** Coverage Enforcement

**Evidence:**
- `apps/stream-worker/vitest.config.ts` — no `coverage` block
- `apps/core/vitest.config.ts` — no `coverage` block
- `apps/web/vitest.config.ts` — no `coverage` block
- `packages/metric-engine/vitest.config.ts` — no `coverage` block
- `.github/workflows/pr.yml` — no `--coverage` flag on any vitest invocation

**Root Cause:** Coverage instrumentation was never added to the project. All vitest configs use basic `{ test: { ... } }` shapes without a `coverage` provider or threshold configuration.

**Impact:** Coverage regressions are invisible. The BFF routes gap (TESTING-6) and module stub gaps cannot be automatically detected as coverage decreases. New code can be merged with 0% test coverage and CI remains green.

**Tenant Impact:** No direct tenant safety impact, but the absence of coverage tracking means the suite gives no signal about which tenant-critical paths (GUC setup, RLS boundary, dedup) are actually exercised.

**Fix:** Add `coverage: { provider: 'v8', reporter: ['text', 'lcov'], thresholds: { lines: 70, branches: 65 } }` to the core and stream-worker vitest configs. Add `--coverage` to CI steps and fail the build if thresholds are not met. Start with a coverage freeze (snapshot current coverage) to avoid breaking CI immediately, then ratchet upward.

**Detection:** `grep -r "coverage" apps/*/vitest.config.ts packages/*/vitest.config.ts` — zero matches.
