# 01 — Architecture Compliance Audit (PASS 1 + PASS 2 + PASS 18)

**Board:** Architecture · **Reviewer:** Independent principal · **Date:** 2026-06-19
**Repo:** `/Users/rishabhporwal/Desktop/Brain V3/worktrees/audit`

## Canon used (the product's, not the generic skill)

This is a **modular monolith with 3 deployables** (collector, stream-worker, core monolith) + web, per **ADR-0001** (`docs/adr/0001-modular-monolith.md`) and doc 04 §B / doc 05 §1A. It is NOT the microservices reference binding. I audited against the product's own canon: `index.ts`-public / `internal/`-fenced bounded-context modules (doc 05 §175, §181), `apps/` may never import `apps/` (I-E05), the **Analytics API / metric-engine sole DB read path** (ADR-002 / I-ST01), the **metric-engine fence to `analytics`+`measurement` only** (doc 05 §7 #3, line 329; ADR-004), and the truth-capture spine (Capture Truth → Build Trust → Enable Decisions).

**Headline:** The architecture is largely faithful — the truth-capture spine (collector accept-before-validate + spool, stream-worker identity/consent/recognition, the realized-revenue + attribution-credit ledgers, the in-process metric engine) is real, app-to-app coupling is clean, and the analytics sole-read-path discipline is genuinely well-maintained. The drift is concentrated in **boundary enforcement**: the two import-lint rules that are supposed to *mechanically* protect the modular monolith are partially inert or out-of-date, and several modules import the metric-engine outside its documented fence. The vision is intact (it is a Commerce OS truth system, not a dashboard).

---

## CRITICAL

_None._ No invariant is violated in a way that corrupts truth or breaks tenant isolation at the architecture layer.

---

## HIGH

### A-1 — The cross-module reach-around lint rule is INERT: it cannot match relative imports, and the BFF already reaches past `index.ts`
**Severity:** High · **Category:** Boundary enforcement / architectural drift
**Evidence:**
- The guard in `eslint.config.mjs:138-150` (`no-restricted-imports`) uses patterns `apps/core/src/modules/*/internal/*` and `apps/core/src/modules/*/*/**` — **project-root-relative globs**. But every intra-`core` import is written **relative**, e.g. `apps/core/src/modules/frontend-api/internal/bff.routes.ts:53`:
  ```ts
  import { MembershipRepository, OrganizationRepository } from '../../workspace-access/internal/infrastructure/repositories.js';
  ```
  `no-restricted-imports` matches the **literal import source string** (`../../workspace-access/internal/...`), which can never match the glob `apps/core/src/modules/*/internal/*`. The rule fires on nothing.
- Real reach-arounds already exist: `bff.routes.ts:45-57` deep-imports `workspace-access/internal/`. Of these, `MembershipRepository`, `OrganizationRepository` (`:53`), `RateLimiter` / `loginFailKeySync` / `loginIpKey` / `registerIpKey` (`:56-57`), and `OnboardingStatus` (`:51`) are **NOT exported** by `apps/core/src/modules/workspace-access/index.ts` (which exports only `AuthService`, `WorkspaceService`, `BrandService`, `InviteService`, the `register*Routes`, `validateSessionPreHandler`, `AuthenticatedRequest`, `RoleCode`). These are genuine past-`index.ts` reach-arounds.
**Impact (prod):** The module boundary that ADR-0001 relies on for "extraction is a move-a-folder operation" is not actually enforced. `frontend-api` is now coupled to `workspace-access`'s repository and rate-limiter internals; extracting either later is no longer mechanical. Each such coupling is invisible to CI.
**Root cause:** Rule authored for absolute paths; the codebase imports relatively. No test asserts the rule actually rejects a known-bad import.
**Recommended fix:** Replace `no-restricted-imports` with an `eslint-plugin-boundaries` `external`/`element-types` rule keyed on resolved file paths (boundaries resolves relative imports to elements), or add a `no-restricted-imports` pattern set covering relative forms (`*/internal/*`, `**/modules/*/internal/**`). Add a fixture test that a deep cross-module import errors. Move the 5 reach-around symbols into `workspace-access/index.ts` or inject them via the container.
**Priority:** P1 · **Tenant Impact:** multi-tenant (rate-limiter + membership internals are tenant-security surfaces; uncontrolled coupling raises isolation-regression risk) · **Detection:** silent — never surfaces; only an extraction attempt or a future internal refactor breaking `frontend-api` reveals it.

### A-2 — Metric-engine imported OUTSIDE its documented fence (`ai`, `attribution`, `data-quality`, `frontend-api`); the fence rule is simultaneously too narrow (omits `data-quality`) and unenforced in the worktree
**Severity:** High · **Category:** Sole-read-path / ADR-004 fence drift
**Evidence:**
- Canon: doc 05 §7 #3 (`docs/requirements/05_Brain_Implementation_Build_Plan.md:329`): "**Metric-engine fencing: only `analytics` and `measurement` may import `packages/metric-engine`.**" Reinforced at §295 ("imported **only** by `core/modules/analytics` and `core/modules/measurement` (lint-enforced — ADR-004)"). The eslint rule encodes exactly that allow-list: `eslint.config.mjs:91` `from: [['core-module', { module: '!(measurement|analytics)' }]], disallow: ['metric-engine']`.
- Actual runtime (non-type) imports of `@brain/metric-engine` from **outside** the fence:
  - `apps/core/src/modules/data-quality/internal/application/queries/get-metric-trust.ts:15` — `import { evaluateGate }`.
  - `apps/core/src/modules/ai/nlq/resolve-question.ts:24` — `import { resolveMetric }`; `apps/core/src/modules/ai/provenance/ai-provenance.repository.ts:17` — `import { withBrandTxn }`.
  - `apps/core/src/modules/attribution/internal/credit-writer.ts:35` — `import { withSilverBrand, BRAND_PREDICATE }`.
  - `apps/core/src/modules/frontend-api/internal/bff.routes.ts:63-66` — `import type {...}` (type-only; lower risk but still outside the literal fence).
- Distinct outside-fence importers (excluding tests): `grep -rln '@brain/metric-engine' apps/core/src/modules` → `ai (5), attribution (1), data-quality (2), frontend-api (1)` in addition to the sanctioned `analytics (25), measurement`.
- The fence is also **stale**: doc 05 build-order line 417 lists `core/data-quality` in the read-path "grade/gating" group *with* metric-engine, so `data-quality` importing it is intended — yet `eslint.config.mjs:91` does not include `data-quality` in the allow-list. The rule would **fail-error on legitimate data-quality code** if run.
- In this worktree `node_modules` is absent, so `npx eslint` ran with no plugins and exited 0 on known violations — i.e., the gate is not actually executing here.
**Impact (prod):** Either (a) the rule was loosened/disabled to let `ai`/`attribution`/`data-quality` through (in which case the documented fence is fiction), or (b) the rule errors on legitimate `data-quality` (in which case lint is red or being bypassed). Either way, the "only `analytics`+`measurement` touch the engine" guarantee — the structural reason dual-store parity holds — is no longer mechanically true.
**Root cause:** The metric-engine grew a DB read seam (`withBrandTxn`, `withSilverBrand`, `BRAND_PREDICATE`; see A-3) that other modules legitimately need; the fence doc + rule were never reconciled with that evolution.
**Recommended fix:** Decide the real allow-list and encode it in ONE place. Recommended: keep pure **compute** functions fenced to `analytics`+`measurement`; move the shared DB/RLS seam (`withBrandTxn`, `withSilverBrand`) to a small `@brain/db` or `@brain/silver-read` package the registry-resolver (`resolveMetric`) can also live near; update `eslint.config.mjs:91` allow-list to match the doc (add `data-quality`); add a unit test that an out-of-fence runtime import errors; restore `node_modules`/CI enforcement so the gate actually runs.
**Priority:** P1 · **Tenant Impact:** multi-tenant (the fence guards the one isolation surface that computes money) · **Detection:** CI lint (if run) — currently not running in-worktree; no runtime alert.

---

## MEDIUM

### A-3 — `packages/metric-engine` has absorbed a DB/RLS seam, contradicting its documented "pure, no-DB, no-network" contract
**Severity:** Medium · **Category:** Documented-vs-code drift / parity-oracle assumption
**Evidence:** Doc 05 §295: "`packages/metric-engine/` is **pure, deterministic, dependency-light (no DB, no network)** so the parity oracle can run it against an independent reference on golden fixtures." Actual: `packages/metric-engine/src/deps.ts:18` imports `pg` and `:38-62` defines `withBrandTxn` (acquires a pool client, `BEGIN`, sets the `app.current_brand_id` RLS GUC, `COMMIT`). `index.ts` re-exports `withBrandTxn` and the package also exposes `withSilverBrand` / `BRAND_PREDICATE` / `SilverPool` consumed by `attribution/internal/credit-writer.ts:35`. The engine now owns the brand-scoped read transaction, not just math.
**Impact (prod):** The "pure library" premise behind the parity oracle is weakened (the engine is no longer trivially runnable against a reference without DB scaffolding), and this seam is the *reason* A-2's fence broke — every module needing brand-scoped reads is pulled into the engine import. `pg` is `import type` only, so the *math* stays pure, which limits the blast radius.
**Root cause:** Convenience: co-locating the RLS read seam with the engine that consumes it, rather than a dedicated read-seam package.
**Recommended fix:** Extract `withBrandTxn` / `withSilverBrand` / `BRAND_PREDICATE` into a dedicated `@brain/silver-read` (or `@brain/db`) package; keep `metric-engine` to registry + pure compute. This simultaneously resolves A-2 (other modules import the seam package, not the engine) and restores the §295 purity contract.
**Priority:** P2 · **Tenant Impact:** multi-tenant (the seam sets the per-brand RLS GUC) · **Detection:** none today; surfaces as parity-oracle setup friction.

### A-4 — Duplicate migration sequence number `0033` (ordering hazard)
**Severity:** Medium · **Category:** Repository structure / migration integrity
**Evidence:** `db/migrations/` contains both `0033_consent_record_tombstone.sql` and `0033_send_log.sql` (two files sharing prefix `0033`). The next file is `0034_capi_passback_log.sql`.
**Impact (prod):** Migration runners that order by filename get a non-deterministic apply order between the two `0033`s; depending on the runner, one may be skipped (if it tracks by version number rather than filename) or applied in an environment-dependent order, producing schema drift between environments.
**Root cause:** Two branches each claimed `0033` and both merged without renumbering.
**Recommended fix:** Renumber one to `0033a`/`0037` (per the runner's convention) and add a CI check asserting unique, monotonic migration prefixes.
**Priority:** P2 · **Tenant Impact:** multi-tenant (schema drift affects every brand on the divergent env) · **Detection:** migration-apply failure or post-deploy schema-diff alert.

### A-5 — `identity` bounded-context module is an empty stub while identity logic lives in `packages/identity-core` + `stream-worker` — ownership recorded in doc but not in code
**Severity:** Medium · **Category:** Boundary / ownership clarity
**Evidence:** `apps/core/src/modules/identity/index.ts` is `export {}; // TODO`, and `internal/` is empty. Identity resolution actually lives in `packages/identity-core/src/` and `apps/stream-worker/src/application/ResolveIdentityUseCase.ts`. Doc 05 §181-192 lists `identity` as one of the 13 bounded contexts ("resolves *who*", doc 04 §141).
**Impact (prod):** The doc's "identity is a core module" mental model is false in code — the actual identity capability is split across a shared package and the stream-worker. Not wrong per se (the deterministic core is correctly a shared library), but the empty `identity` module is a boundary the lint protects yet nothing fills, and a reader can't locate the capability from the module tree. Same pattern for `recommendation` (the Decision-Engine half per doc 09 §7) and `billing` (doc 04 Phase 1b) — both empty stubs.
**Root cause:** Scaffolding committed ahead of build; the logic that *did* land went to the package/worker layer.
**Recommended fix:** Either (a) make `identity/index.ts` the control-plane surface that re-exports/owns the `identity-core` integration so the module is non-empty and discoverable, or (b) document in `docs/architecture/README.md` that `identity` = shared package + worker (current phase) with the module reserved for the P2 control-plane. Keep `billing`/`recommendation` stubs but tag them with the phase that fills them.
**Priority:** P2 · **Tenant Impact:** single-tenant (clarity, not correctness) · **Detection:** none — a documentation/navigation gap.

---

## LOW

### A-6 — `frontend-api` BFF imports metric-engine types directly instead of re-exported view-model types
**Severity:** Low · **Category:** Layering hygiene
**Evidence:** `apps/core/src/modules/frontend-api/internal/bff.routes.ts:63-66` `import type { AttributionModelId, AdPlatform, TimeGrain, SilverPool } from '@brain/metric-engine'`. The BFF correctly routes all *data* through `analytics/index.js` use-cases (`bff.routes.ts:59`, with sole-read-path comments at `:1114`, `:1192-1193`, `:1277`) — but it pulls leaf types from the engine, partially defeating the BFF-as-isolation-layer intent (ADR-011: "no DB access").
**Impact (prod):** Minor coupling; if engine type shapes change, the BFF recompiles. No runtime/isolation risk (type-only).
**Root cause:** No analytics-owned DTO layer re-exporting these enums.
**Recommended fix:** Have `analytics/index.ts` re-export the handful of param enums the BFF needs; import those.
**Priority:** P3 · **Tenant Impact:** single-tenant · **Detection:** none.

### A-7 — `data-quality` / `attribution` / `frontend-api` modules ship without the full DDD internal skeleton, while `analytics`/`measurement`/`workspace-access` do
**Severity:** Low · **Category:** Repository structure consistency
**Evidence:** Per-module non-test file counts: `connector 61, analytics 27, notification 25, workspace-access 21, measurement 11, ai 9, frontend-api 3, data-quality 3, attribution 3`. `attribution` is effectively one file (`internal/credit-writer.ts`) rather than the `domain/ application/ infrastructure/ interfaces/` shape doc 05 §204 prescribes ("Every module follows the same internal shape"). Compute-heavy attribution logic is in `packages/metric-engine` (`attribution-credit.ts`, `attribution-clawback.ts`, etc.), so the module is a thin writer.
**Impact (prod):** Acceptable for the current thin modules, but the inconsistency means "same internal shape everywhere" (a doc 05 claim) is not literally true; future contributors may not know where attribution domain logic belongs (engine vs module).
**Root cause:** Attribution math centralized in the engine; the module is just the credit-ledger writer.
**Recommended fix:** Note explicitly in the architecture README that attribution's *compute* is engine-resident and the module owns only the write seam; or relocate the writer's domain logic into the module's `domain/`.
**Priority:** P3 · **Tenant Impact:** single-tenant · **Detection:** none.

---

## What is CORRECT (verified, not assumed)

- **Truth-capture spine is real, not a dashboard.** `apps/collector` (accept-before-validate `accept-event.usecase.ts`, durable spool `pg-spool.repository.ts`, drainer), `apps/stream-worker` (`ResolveIdentityUseCase`, `ProjectConsentUseCase`, `revenue-finalization.ts`, `RequestCapiDeletionUseCase`), the `0018_realized_revenue_ledger` + `0032_attribution_credit_ledger` migrations, and the in-process metric engine all exist. **Vision (PASS 18) is intact** — Capture Truth → Build Trust (DQ grade/gate in `data-quality`, `0035_dq_check_result`) → Enable Decisions (NLQ `ai/ask-brain.ts` narrates engine numbers; LLM never computes — `ask-brain.ts:8-9`). This is a Commerce OS, not a BI/CDP clone.
- **App-to-app coupling (I-E05) is clean.** No `apps/* → apps/*` imports; shared logic was consciously extracted to `packages/*-mapper` (see deliberate comments in `stream-worker/.../order-mapper.ts:5-6`, `LedgerWriter.ts:4`).
- **Analytics sole-read-path discipline holds in practice.** `ai/ask-brain.ts:30,186-192` routes NLQ compute through `getRevenueMetrics` (analytics) — identical to the dashboard number; no direct silver read in `ai`. Raw `.query` reads inside `analytics` are additive operational-health surfaces explicitly carved out by D-2 (`get-data-health.ts:10-12`), not non-additive money math.
- **DDD-by-bounded-context** is followed for the built modules (`domain/ application/ infrastructure/ interfaces/` under `internal/`); no `controllers/services/models` technical-layer trees.
- **Silver tier** correctly exists as dbt marts (`db/dbt/models/marts/silver_touchpoint.sql`, `silver_order_state.sql`) on Postgres; StarRocks absent matches the gated roadmap (`docs/data-collection-platform/13-...:24`), not a violation.

---

## Verdict

The modular-monolith architecture is **substantially compliant** with its own canon (ADR-0001, docs 04/05): the truth-capture spine, ledgers, in-process metric engine, app-to-app isolation, and the analytics sole-read-path are real and the Commerce-OS vision has not drifted into a dashboard. The material risk is **enforcement, not design**: the two import-lint rules meant to make the boundaries "mechanically real" are partly inert — the cross-module reach-around rule cannot match relative imports (and the BFF already reaches past `workspace-access/index.ts`), and the metric-engine fence is both out-of-date (omits the intended `data-quality`) and bypassed by `ai`/`attribution`/`frontend-api`, driven by the engine quietly absorbing a DB/RLS seam it was documented never to own. None of this corrupts truth or breaks tenant isolation today, but it erodes the exact guarantees ADR-0001 sells ("extraction is move-a-folder") and ADR-004 sells ("only `analytics`+`measurement` ever touch the engine"). Fix the two lint rules, reconcile the fence with reality, and extract the read seam; the architecture is otherwise sound.
