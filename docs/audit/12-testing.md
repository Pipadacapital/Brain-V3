# PASS 14 — Testing Audit (Brain Commerce OS)

**Auditor stance:** Independent principal reviewer. Every finding cites repository evidence. Theoretical concerns excluded.

## Test census (verified)
- **138** TS `*.test.ts` / `*.spec.ts` files under `apps/` + `packages/` (excl. node_modules).
- **38** Playwright e2e specs in `apps/web/e2e/`.
- **17** `*.live.test.ts` files (real Postgres) in `apps/core/src/modules/`.
- **0** Python tests (all-TS stack → no cross-runtime parity surface; the skill's cross-runtime parity requirement is N/A here, NOT a gap).
- Isolation-fuzz suite: `tools/isolation-fuzz/src/{pg,pg.connector,starrocks,redis,silver-order-state,silver-touchpoint,ai-provenance,attribution-credit-ledger,mcp}.test.ts`.
- Parity oracle: `tools/parity-oracle/src/parity.test.ts` + `reference.ts`.

## Strengths (credited, not findings)
- **Money ledger live tests are exemplary** (`realized-revenue-ledger.live.test.ts`, `attribution-credit-ledger.live.test.ts`): run RLS assertions under `brain_app`, assert `current_user='brain_app'` AND `is_superuser=false` (lines 587-594), append-only permission-denied probes, banker's-rounding golden fixtures, cross-brand=0, closed-sum vs naive-SUM contrast.
- **Parity oracle is non-tautological** (`tools/parity-oracle/src/reference.ts:5,32` — explicit "DO NOT import @brain/metric-engine"; independent SQL `SUM(amount_minor)` vs engine `realized_gmv_as_of()`; tolerance-0; RED proof at `parity.test.ts:469-512`; brand_app isolation block D).
- **All 12 appPool live tests assert non-superuser** — isolation tests are genuinely NON-inert.
- **Identity merge is well-covered** (`apps/stream-worker/src/tests/identity.e2e.test.ts`): deterministic-merge, phone-guard N=10 boundary, replay-idempotency, read-back under brain_app RLS.

---

## FINDINGS

### F1 — Playwright e2e + real-network smoke gate NEVER runs in CI (false PASS confidence)
**Severity:** Critical | **Category:** Test-as-gate / verification validity
**Evidence:** `grep -rl "playwright|test:e2e" .github/workflows/` → **no matches**. 38 specs in `apps/web/e2e/` (incl. `smoke.spec.ts`, `full-journey.spec.ts`, `consent-compliance.spec.ts`, `multi-brand.spec.ts`) are invoked by no workflow. `apps/web/playwright.config.ts:6-12` has **no `webServer` block** — "PREREQUISITE: the dev stack must already be running (`pnpm dev`)". `forbidOnly`/`retries` are keyed on `process.env.CI` (lines 20-21), proving CI intent that was never wired.
**Impact:** The entire UI→BFF→Postgres journey layer and the happy-path smoke (`smoke.spec.ts`) are manual-only. A broken register/onboarding/dashboard flow, a cross-brand UI leak, or a consent-compliance regression ships to staging/prod with zero automated detection. The testing-tdd skill names real-network smoke the **non-negotiable PASS gate**; it is absent from automation.
**Root Cause:** Playwright config built for local-only runs; no CI job starts the stack (web :3000 + core :3001 + infra) and runs `playwright test`.
**Recommended Fix:** Add a `webServer` block to `playwright.config.ts` (boot built web+core) and a `pr.yml` job that spins docker-compose infra, runs migrations, then `pnpm --filter @brain/web test:e2e` against a real port. Block merge on it.
**Priority:** P0 | **Tenant Impact:** Multi-tenant — UI-layer cross-brand leaks undetected. | **Detection:** Surfaces only as a customer-reported incident or staging bake-window failure.

### F2 — Deploy pipeline (main.yml) runs ZERO tests before prod promotion
**Severity:** Critical | **Category:** CI gate
**Evidence:** `.github/workflows/main.yml` (push to main): jobs are `build-and-push`, `gitops-staging`, `prod-promote` — **no lint/typecheck/test/isolation/parity step anywhere**. Tests live only in `pr.yml` (`on: pull_request`).
**Impact:** Any commit reaching `main` by a non-PR path (direct push, admin merge bypassing required checks, hotfix branch merged without the PR check enforced) builds and promotes images to staging→prod with **no test execution**. The money-ledger, RLS, and parity gates that exist in `pr.yml` provide zero protection on the actual release path.
**Root Cause:** Test gating placed only on `pull_request`; branch-protection enforcement of `pr.yml` checks is assumed but not guaranteed in-repo, and `main.yml` has no independent re-verification.
**Recommended Fix:** Add a blocking `test`/`isolation`/`parity` job to `main.yml` as a `needs:` of `build-and-push`, OR document+enforce required status checks. Treat the deploy pipeline as untrusted of PR state.
**Priority:** P0 | **Tenant Impact:** Multi-tenant — a money/RLS regression promotes platform-wide. | **Detection:** Auto-rollback signals in `main.yml:200-205` (post-deploy), i.e. after customer impact.

### F3 — StarRocks cross-tenant negative control self-skips on the CI image (analytics gateway isolation unproven)
**Severity:** Critical | **Category:** False-confidence / inert isolation test
**Evidence:** `tools/isolation-fuzz/src/starrocks.test.ts:183-221` — the M-01 negative control ("plain SELECT without `AND brand_id` predicate must return 0 rows via engine row policy") calls `ctx.skip()` (line 216) because "the OSS StarRocks allin1 image" lacks `CREATE ROW POLICY` support. Also `pr.yml:16-32` provisions **only Postgres** — no StarRocks service at all, so the whole file is PENDING in CI.
**Impact:** The Silver/Gold analytics layer's tenant isolation depends on a StarRocks row policy self-injecting `brand_id = @brain_current_brand_id`. The positive test passes only because it manually adds the predicate. The security-critical case — the app forgets the predicate and the engine must still block cross-brand reads — is **never asserted on any CI-available engine**. A query-gateway bug that drops the tenant predicate would leak Brand A's analytics to Brand B undetected.
**Root Cause:** OSS StarRocks test image lacks row-policy support; no alternative (enterprise image or app-layer gateway assertion) substituted.
**Recommended Fix:** Run isolation-fuzz against a StarRocks build that supports row policies, OR add an app-layer test that asserts the analytics query gateway REJECTS any query lacking a tenant-key predicate (the skill's explicit must-cover edge). Do not let the only proof be a skipped test.
**Priority:** P0 | **Tenant Impact:** Multi-tenant — analytics cross-brand read. | **Detection:** None automated; would surface as a data-leak incident.

### F4 — Isolation-fuzz + several live tests SILENTLY PASS GREEN when datastores are unavailable
**Severity:** High | **Category:** Verification validity (silent-skip = false green)
**Evidence:** `tools/isolation-fuzz/src/pg.test.ts:266,276,293,...` — every assertion guarded by `if (!pgAvailable || !appClient) return;`; `openConnection()` swallows failures (`catch { return null }`, lines 67-69) so `pgAvailable=false` → suite is GREEN with **zero assertions executed**. Same pattern: `pg.connector.test.ts`, `attribution-credit-ledger.live.test.ts:148` (`if (!live) return ctx.skip()`; `live` only set true inside a `try` at line 130, `catch` just `console.warn` at line 137). Redis (`redis.test.ts:33`) and StarRocks "skip gracefully if unavailable."
**Impact:** When `test:isolation` runs without Postgres (and it is `--affected`-gated, so it is skipped for unrelated PRs entirely), the RLS negative controls report success having proven nothing. Combined with F2/F3, the cross-brand RLS guarantee can regress while CI stays green.
**Root Cause:** Tests designed to "degrade to pending" rather than fail-hard when infra is absent; no environment assertion forcing infra presence in CI.
**Recommended Fix:** In CI set a `REQUIRE_LIVE=1` env that makes the absence of Postgres/Redis/StarRocks a hard FAIL (not a skip). Make `openConnection` failure throw in CI. The money ledger tests already fail-hard (`await appPool.query('SELECT 1')` with no catch) — apply that pattern everywhere.
**Priority:** P0/P1 | **Tenant Impact:** Multi-tenant. | **Detection:** Green CI; masked until incident.

### F5 — No mutation testing anywhere despite critical-path mandate
**Severity:** High | **Category:** Test effectiveness
**Evidence:** No `stryker*` config, no `mutation` script in any `package.json`, no mutation step in any workflow (`grep -rln "stryker|mutation"` → none). The testing-tdd skill mandates 90-95% mutation score on the metric registry, recognition/ledger writer, compliance engine, and auth+tenant middleware.
**Impact:** Coverage ("line ran") is the only signal; there is no proof the assertions are meaningful. A `>`→`>=` mutant at a recognition horizon boundary (COD 25d / prepaid 7d — `realized-revenue-ledger.live.test.ts:869`), a `&&`→`||` in `can_contact()` consent chain, or a tenant-id string swap in RLS GUC handling could survive. Boundary/arithmetic correctness on money paths is unverified at the mutant level.
**Root Cause:** Mutation testing never adopted.
**Recommended Fix:** Add Stryker (TS) on `packages/metric-engine`, `apps/core/.../measurement`, `packages/identity-core`, auth/tenant-context; `thresholds {high:90,low:75,break:75}`; nightly full + PR `--incremental` on changed critical files.
**Priority:** P1 | **Tenant Impact:** Multi-tenant (metric/money correctness). | **Detection:** N/A (preventive gap).

### F6 — No coverage thresholds enforced anywhere
**Severity:** High | **Category:** Coverage gate
**Evidence:** `grep "coverage|thresholds|--coverage"` across all vitest configs, `turbo.json`, `package.json`, workflows → **no matches**. The skill mandates >70% overall, >95% on auth/money/compliance paths.
**Impact:** New code can ship with arbitrarily low coverage; the >95% critical-path floor (money ledger, RLS, attribution) is unverifiable and unenforced. Untested branches accumulate silently.
**Root Cause:** No `coverage: { thresholds }` in vitest config; no coverage job in CI.
**Recommended Fix:** Add per-package vitest `coverage.thresholds` and a CI `vitest run --coverage` gate; set 95% on measurement/identity/workspace-access auth.
**Priority:** P1 | **Tenant Impact:** Platform-wide. | **Detection:** N/A.

### F7 — Auth refresh-token rotation/replay path tested only against a hand-mocked SQL stub
**Severity:** Medium | **Category:** Over-mocking / false confidence
**Evidence:** `apps/core/src/modules/workspace-access/tests/critical-paths.test.ts:88-118` — `makeRawPgPool()` is a `vi.fn()` returning canned rows keyed on `sql.includes('FOR UPDATE')`, `sql.includes('WITH revoked')`, etc.; 40 mock usages in the file. The `FOR UPDATE` row-lock semantics that replay-detection depends on are asserted against the mock's own scripted responses, not real Postgres.
**Impact:** A refactor of the rotation SQL (e.g. dropping `FOR UPDATE`, changing the revoke CTE) would still pass — the test validates the mock, not the lock. Replay-detection is a security control (session family revocation). Mitigated by `member-lifecycle.live.test.ts` / `family-wipe.live.test.ts` which exercise real PG, but the dedicated AC-1 rotation unit is over-mocked.
**Root Cause:** Unit test mocks the datastore (the skill's named anti-pattern "mocking the datastores masks RLS + gateway bugs").
**Recommended Fix:** Promote AC-1 rotation/replay assertions into a live test against real `user_session` rows + RLS, asserting actual `FOR UPDATE` contention and family revocation.
**Priority:** P2 | **Tenant Impact:** Single-tenant (per-user session) but auth-critical. | **Detection:** N/A.

### F8 — packages/db/src/rls.test.ts is a tautological simulation (RLS modeled by a vi.fn)
**Severity:** Medium | **Category:** Tautological / inert test
**Evidence:** `packages/db/src/rls.test.ts:137-206` — the "NEGATIVE CONTROL" models RLS with `makeRlsExecutor()`, a `vi.fn()` that itself decides to return 0 rows; the "REMOVAL PROOF" (line 190) asserts a different mock returns >0 rows. It proves the **mock's own branching**, not Postgres RLS. The file header (line 17-22) correctly defers the real proof to `tools/isolation-fuzz/src/pg.test.ts` — which is the one that self-skips (F4).
**Impact:** Read in isolation this looks like an RLS negative control but cannot catch any real RLS regression. The genuine proof depends entirely on `pg.test.ts`, which silently passes when PG is down. Defensible as a GUC-helper unit test, but the "NEGATIVE CONTROL"/"REMOVAL PROOF" naming overstates its guarantee.
**Root Cause:** Unit-test layer simulating the protection it claims to verify.
**Recommended Fix:** Rename to "GUC contract unit"; remove "negative control" framing; ensure the real `pg.test.ts` fail-hards in CI (F4) so the actual canary is load-bearing.
**Priority:** P2 | **Tenant Impact:** Multi-tenant (RLS). | **Detection:** N/A.

### F9 — Kafka/Redis-dependent stream-worker e2e + integration tests have no datastores in CI
**Severity:** Medium | **Category:** Test-env parity
**Evidence:** `pr.yml:16-32` services block provisions Postgres only — no Kafka, no Redis, no StarRocks. `apps/stream-worker/src/tests/*.e2e.test.ts` (bronze, identity, ingest-scheduler, dq-checks, capi-deletion) and `*.integration.test.ts` need the bus/redis; `test:e2e` for stream-worker (`apps/stream-worker/package.json:6`) is not invoked in any workflow, and `test:unit` runs them with `--passWithNoTests` so missing infra → skip/no-op rather than fail.
**Impact:** Bronze ingestion, identity stitch, DQ grading, and CAPI deletion e2e flows are not exercised in CI. Test-env parity with the docker-compose dev stack is broken for everything except Postgres.
**Root Cause:** CI services block never extended beyond Postgres; no docker-compose-up step.
**Recommended Fix:** Add Kafka(Redpanda)+Redis(+StarRocks where feasible) to the CI job (or `docker compose --profile core up`) and invoke `test:e2e` for stream-worker as a blocking gate.
**Priority:** P2 | **Tenant Impact:** Multi-tenant (ingestion/identity). | **Detection:** N/A.

### F10 — Isolation/parity gates are `--affected`-scoped, so unrelated PRs never re-run them
**Severity:** Medium | **Category:** CI gate scope
**Evidence:** `pr.yml:62-69` — `pnpm turbo run lint typecheck test:unit --affected`, `test:contract --affected`, `test:isolation --affected`, `test:parity --affected`. A PR that doesn't touch the affected package graph of `tools/isolation-fuzz` or `tools/parity-oracle` skips them entirely.
**Impact:** A cross-cutting change (shared util, migration, GUC middleware) that breaks RLS isolation or metric parity but isn't in turbo's affected set for those packages ships with the isolation/parity gate un-run. The QA delta-review discipline ("re-run the FULL prior-passing suite") is violated structurally by `--affected` on security/money gates.
**Root Cause:** Cost-optimization (`--affected`) applied uniformly, including to cross-cutting security/money gates that should always run.
**Recommended Fix:** Run `test:isolation` and `test:parity` unconditionally (drop `--affected`) on every PR; keep `--affected` only for ordinary unit tests.
**Priority:** P2 | **Tenant Impact:** Multi-tenant. | **Detection:** N/A.

### F11 — pr.yml comment claims "migrations through 0020" but 37 migrations exist (stale/misleading gate doc)
**Severity:** Low | **Category:** Test-env parity / documentation drift
**Evidence:** `pr.yml:60` comment "Apply all migrations through 0020 (includes ledger schema...)" but `pnpm migrate:up` (`package.json:25`) actually runs ALL 37 (`db/migrations/` through `0036_ai_provenance.sql`). Functionally OK (all run), but the comment misleads a reader about which schema the CI DB has, and tests referencing post-0020 tables (e.g. `attribution_credit_ledger` 0032, `dq_check_result` 0035) rely on the comment being wrong.
**Impact:** Low — a maintainer trusting the comment could wrongly assume 0021-0036 tables are absent in CI and gate tests on a stale `to_regclass` PENDING path (as `attribution-credit-ledger.live.test.ts:110-115` does), turning a real test into a silent skip if the comment ever became true.
**Root Cause:** Comment not updated as migrations grew.
**Recommended Fix:** Correct the comment to "all migrations"; remove `to_regclass`-PENDING fallbacks now that CI applies the full set.
**Priority:** P3 | **Tenant Impact:** N/A. | **Detection:** Code review.

---

## Verdict
The deep, hand-built tests on the highest-stakes paths are genuinely strong and non-tautological: the money/realized-revenue and attribution-credit ledgers run RLS assertions under a real `brain_app` NOSUPERUSER role with explicit `is_superuser=false` guards, append-only permission-denied probes, and banker's-rounding golden fixtures; the parity oracle asserts the engine against a deliberately-independent SQL reference at tolerance-0 with a working RED proof; identity merge has boundary and replay coverage. The auditor confirmed the isolation tests are NOT inert/superuser-bypassed — a real risk the team explicitly mitigated. **However, the test ARCHITECTURE around these gems is unsound:** the 38-spec Playwright e2e + real-network smoke gate runs in NO CI workflow; the deploy pipeline (`main.yml`) runs zero tests before prod promotion; the StarRocks analytics-gateway cross-tenant negative control self-skips on the CI image and StarRocks/Kafka/Redis are absent from CI services; the isolation-fuzz RLS canary silently passes green when Postgres is unavailable; and there is no mutation testing and no enforced coverage threshold anywhere. The result is high-quality tests guarding the money/RLS core, sitting behind a CI that can ship a regression — including a cross-brand isolation or analytics-leak regression — without those tests ever executing. Net domain rating: **NEEDS-WORK (FAIL the PASS gate)** until F1-F4 are remediated.
