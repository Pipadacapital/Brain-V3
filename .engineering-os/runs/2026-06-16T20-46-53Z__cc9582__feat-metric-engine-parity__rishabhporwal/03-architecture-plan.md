# Architecture Plan — feat-metric-engine-parity

**Stage:** 2 (architecture, binding) · **Decision:** ADVANCE · **Date:** 2026-06-17
**Architect:** architect · **req_id:** `feat-metric-engine-parity`
**Branch:** `feat/metric-engine-parity` (base `master` @ `f29e61d` — has the ledger, migrations through 0019)
**Run:** `.engineering-os/runs/2026-06-16T20-46-53Z__cc9582__feat-metric-engine-parity__rishabhporwal/`
**Track:** single — **@intelligence-engineer** (metric parity, the metric registry, the parity/eval gate are theirs)

> The heart of this slice is **one non-tautological assertion**: the TypeScript engine's number must equal a number derived by a **structurally different SQL predicate path** over the same ledger, on golden fixtures, and **any delta — even 1 minor unit — fails CI**. The engine reads ONLY via named DB seams (`realized_gmv_as_of` / new `provisional_gmv_as_of`); the oracle's reference must NOT call those seams. Per-currency map from day one; provisional never blended into realized; no float ever. No new deployable — `packages/metric-engine` is an in-process library; `tools/parity-oracle` is a CI test runner.

---

## 0. Cost-routing paradigm (the gate)

**Tier-0 deterministic — zero model calls — $0/mo, 0 tokens/day.**

Every operation is a SQL aggregate inside a named function, a typed registry lookup (compile-time constant), a `bigint` sum, or an integer equality assertion. There is no classification, ranking, or natural-language step anywhere in the engine or the oracle. A model call on this surface = paradigm-bypass, block at review. Justification (METRICS.md effort-tier table, row tier-0): "All metric computation … the only tier that produces numbers." The LLM never produces a number (METRICS.md rule §5). Confirmed by CTO review §Domain-Check ("Tier 0 deterministic throughout … No model call. No ML.").

**Spend estimate:** $0/mo. **Token estimate:** 0/day. **Compute:** the parity test runs O(fixtures) `bigint` comparisons + a handful of indexed ledger scans against a local/CI Postgres — bounded, no new infra, no new deployable (D-7).

---

## 1. Single-Primitive sweep (extend before create)

| Concern | Decision | Evidence |
|---|---|---|
| **The metric engine** | ONE engine in `packages/metric-engine` — the SOLE emitter. Fill the `export {}` stub; do NOT add a second compute path anywhere | `packages/metric-engine/src/index.ts:2` (stub). STACK locked-choice 4 "the only place a number is computed". CLEAN — extend the stub. |
| **As-of realized read** | REUSE the existing named seam `realized_gmv_as_of()` via the existing `GetRealizedGmvAsOfQuery` CQRS query — do NOT re-implement the sum | `db/migrations/0018_realized_revenue_ledger.sql:176`; `apps/core/src/modules/measurement/internal/application/queries/GetRealizedGmvAsOf.ts:23`. CLEAN reuse. |
| **Provisional read** | NEW named seam `provisional_gmv_as_of()` (migration 0020) — there is NO provisional named path today; an ad-hoc `SUM` in app code is the violation to prevent | `0018` has only `realized_gmv_as_of`; CTO HIGH "provisional_revenue read path not yet named" (`02:59-66`). Minimal additive function, mirrors 0018's signature/security. |
| **Money arithmetic + types** | REUSE `packages/money` (`Money`, `CurrencyCode`, `add`) and `bigint` everywhere; the engine's per-currency map values are `bigint` | `packages/money/src/index.ts:17,44,55`. No package API change. |
| **No-float enforcement (TS)** | REUSE the existing `no-float-money` ESLint rule — it already fires on `TSPropertySignature` `number` for `*_minor`/`*_revenue` fields (this is exactly why the GoldenFixture `number` fields must become `bigint`) | `tools/eslint-rules/no-float-money.mjs:115-130`; wired `error` (`eslint.config.mjs:112`), `warn` in test/fixture files (`:116-122`). |
| **metric-engine import fence** | EXTEND the EXISTING boundary rule — it currently over-blocks (disallows metric-engine from ALL core-modules); fix to allow `measurement` + `analytics` only, per its own comment | `eslint.config.mjs:83-88` rule says `from:['core-module'] disallow:['metric-engine']` but the comment (`:84`) says "analytics and measurement modules only". D-6 binding §2. |
| **Parity oracle harness** | EXTEND `tools/parity-oracle` — reuse `checkParity`/`runGoldenFixtures`/`ParityResult` (already integer-delta, tolerance-0), fix the `number`→`bigint` types, add the live-DB independent reference + real fixtures | `tools/parity-oracle/src/index.ts:51,71` (keep); `:19-46` (retype). CLEAN extend. |
| **Live-DB test harness** | REUSE the ledger slice's live-test pattern: superuser pool for DDL/seed, `brain_app` pool for RLS assertions, `set_config('app.current_brand_id',$1,true)` | `apps/core/src/modules/measurement/tests/realized-revenue-ledger.live.test.ts:41-90`. CLEAN reuse — copy the dual-pool + `setBrandGuc` shape. |
| **CI gate** | REUSE the EXISTING `test:parity --affected` step — only the Turbo dependency edge is missing so it fires on engine changes | `.github/workflows/pr.yml:32-33`; `turbo.json:16` (`test:parity` task exists). D-3 binding §2. |

**Verdict: CLEAN — extend-only.** ONE engine, ONE money library, ONE no-float rule, ONE import fence (fixed), ONE parity harness, ONE CI step. The only NEW artifacts are: migration `0020_provisional_gmv_as_of.sql` (additive function), `packages/metric-engine/src/registry.ts` (a typed constant), and the engine/oracle fill-in. **No new service, table, queue, or deployable.**

---

## 2. Architecture decisions — ALL bindings D-1..D-7 + bigint-fixtures RESOLVED

### D-2 — Non-tautological independent parity reference (CRITICAL) — BOUND

This is the load-bearing wall. Two **structurally different predicate paths** over the same `realized_revenue_ledger` must agree.

- **The engine path (path A):** `computeRealizedRevenue(brandId, asOf)` → `GetRealizedGmvAsOfQuery` → `realized_gmv_as_of(p_brand_id, p_as_of)` → SQL `SUM(amount_minor) WHERE economic_effective_at::date <= p_as_of AND event_type <> 'provisional_recognition'` returning a single `BIGINT` (`0018:182-187`). The engine wraps it into the per-currency `Map` (M1: single entry, the brand's currency).

- **The oracle's independent reference (path B) — MUST NOT call `realized_gmv_as_of` or `GetRealizedGmvAsOfQuery`:**

  ```sql
  SELECT currency_code, SUM(amount_minor) AS realized_minor
  FROM realized_revenue_ledger
  WHERE brand_id = $1
    AND economic_effective_at::date <= $2::date
    AND recognition_label = 'finalized'
  GROUP BY currency_code
  ```

- **Why this is non-tautological (the two load-bearing structural differences):**
  1. **Different exclusion predicate.** Path A excludes provisionals via `event_type <> 'provisional_recognition'`. Path B *includes* only `recognition_label = 'finalized'`. For the M1 ledger these are semantically equivalent (only `finalization` rows carry `recognition_label='finalized'` — `0018:87-88,166-175`), so a correct engine yields a zero delta. But a bug that lets a provisional/settling row leak through path A (e.g. a wrong `event_type` filter, or a row mislabeled at write time) produces a **non-zero delta** because path B's `recognition_label='finalized'` predicate excludes it. The two predicates can only agree if the ledger population is internally consistent — exactly the property the oracle exists to prove.
  2. **Different shape — per-currency vs blended.** Path A returns one blended `BIGINT`; path B `GROUP BY currency_code`. The engine must split A into a per-currency map; if it ever blended two currencies into one number (D-5 violation), path B's grouped rows would disagree. (M1 single-currency-per-brand is enforced by the 0018 trigger `0018:156-159`, so M1 fixtures have one currency per brand; the 2-brand/2-currency fixture proves the map keys by `currency_code` and never blends across brands.)

- **The test helper (the binding):** `getIndependentReferenceRevenue(brandId, asOf, client): Promise<Map<string, bigint>>` in `tools/parity-oracle/src/reference.ts`. It runs **exactly the SQL above** with parameter binding, reads `currency_code` + `realized_minor`, and returns `Map<currency_code, BigInt(realized_minor)>`. It is forbidden from importing `@brain/metric-engine` or the measurement module, and forbidden from calling either named function — enforced by code review + the import fence (the oracle is a `tool`; `@brain/metric-engine` is a `package` it may import for the engine path, but `reference.ts` must use raw SQL only). A doc-comment on `reference.ts` states: "INDEPENDENT recompute — MUST NOT call realized_gmv_as_of / provisional_gmv_as_of / the metric engine. Tautology = the gate proves nothing."

- **Fail-on-any-delta:** `checkParity` already computes an integer delta with `toleranceMinor` (`tools/parity-oracle/src/index.ts:51-66`). For every `realized_revenue` / `provisional_revenue` fixture `toleranceMinor = 0` → a 1-minor-unit delta sets `passed=false` → the vitest assertion fails → the CI `test:parity` step exits non-zero → build blocked. The parity test asserts **per-currency-key equality** of the two maps (same key set AND equal `bigint` per key), not just a scalar.

- **Both paths run against the SAME seeded snapshot** inside one test DB so the comparison is meaningful (no time-of-read skew): seed under superuser, read path A under `brain_app` (GUC set), read path B under `brain_app` (GUC set), compare.

### D-1 — Metric registry shape `(metric_id, version)` — BOUND

- **TypeScript compile-time registry** in `packages/metric-engine/src/registry.ts` — the M1 SoR for "what a metric means" (the Postgres `metric_definition` table referenced in METRICS.md §Rules is the long-term SoR; not needed for M1, do NOT create it — smallest/safest).
- **Shape — keyed by `(metric_id, version)`, version bump = new key (immutable):**

  ```ts
  export type MetricId = 'realized_revenue' | 'provisional_revenue';
  export type MetricVersion = `v${number}`;

  export interface MetricDefinition {
    readonly metricId: MetricId;
    readonly version: MetricVersion;
    /** Human-readable definition (mirrors METRICS.md registry row). */
    readonly description: string;
    /** The named DB read seam this metric resolves through (sole-as-of-path). */
    readonly readSeam: 'realized_gmv_as_of' | 'provisional_gmv_as_of';
    /** recognition_label semantics this metric covers (documentation + oracle cross-check). */
    readonly recognitionLabels: readonly ('provisional' | 'settling' | 'finalized')[];
    readonly tolerantMinor: 0;  // money metrics are exact-integer (METRICS.md §Rules)
  }

  // (metric_id, version) keyed — a version bump is a NEW KEY, never a mutation.
  export const METRIC_REGISTRY: {
    readonly [M in MetricId]: { readonly [V: MetricVersion]: MetricDefinition };
  } = {
    realized_revenue:    { v1: { metricId: 'realized_revenue',    version: 'v1', readSeam: 'realized_gmv_as_of',    recognitionLabels: ['finalized'],              description: '...', tolerantMinor: 0 } },
    provisional_revenue: { v1: { metricId: 'provisional_revenue', version: 'v1', readSeam: 'provisional_gmv_as_of', recognitionLabels: ['provisional','settling'], description: '...', tolerantMinor: 0 } },
  } as const;

  export function resolveMetric(metricId: MetricId, version: MetricVersion): MetricDefinition {
    const def = METRIC_REGISTRY[metricId]?.[version];
    if (!def) throw new Error(`[metric-engine] unknown metric (${metricId}, ${version}) — registry is the sole SoR`);
    return def;
  }
  ```

- **Immutability:** `as const`; a definition change requires a NEW version key (`v2`), never editing `v1`. The engine resolves the definition before computing; the `readSeam` field encodes which named DB path the metric uses, so the engine never inlines a SUM. A registry unit test asserts each metric's `recognitionLabels` matches its `readSeam` (realized→finalized, provisional→provisional/settling) so a registry edit that drifts from the DB seam fails CI.

### D-3 — CI-blocking gate + Turbo dependency edge — BOUND

- **The edge that makes the gate fire on engine changes:** add `@brain/metric-engine` as a workspace dependency in `tools/parity-oracle/package.json` (`"dependencies": { "@brain/metric-engine": "workspace:*" }`) AND add a per-package Turbo override so the parity task depends on the engine build:

  ```jsonc
  // tools/parity-oracle/turbo.json  (package-level config; extends root)
  {
    "extends": ["//"],
    "tasks": {
      "test:parity": { "dependsOn": ["@brain/metric-engine#build", "^build"] }
    }
  }
  ```

  Rationale: the root `turbo.json:16` already has `test:parity: { dependsOn: ["^build"] }`, but `^build` only builds the oracle's *own* declared dependencies. Declaring `@brain/metric-engine` as a workspace dependency puts the engine into the oracle's `^` graph, so `pnpm turbo run test:parity --affected` (`pr.yml:33`) computes the oracle as affected whenever the engine package changes. The explicit `@brain/metric-engine#build` dependsOn is belt-and-suspenders so the engine's `dist/**` is built before the parity test imports it. **Verified mechanisms:** Turbo is `2.9.18` (root `package.json`) — package-level `turbo.json` with `extends: ["//"]` IS supported in Turbo 2.x. `workspace:*` is the repo's established protocol (`packages/audit/package.json`, `apps/core/package.json`). Note: `apps/core/package.json` ALREADY declares `@brain/metric-engine: workspace:*`, confirming the in-process-library binding (D-7) — only the **oracle's** dep edge is missing; core needs no change. (Fallback if package-level config is disallowed by repo policy: add `"@brain/metric-engine#build"` to the root `test:parity.dependsOn` array — same effect.)

- **The gate is already BLOCKING:** `pr.yml:32-33` runs `pnpm turbo run test:parity --affected` in the `lint-typecheck-unit` job with **no `continue-on-error`** → a non-zero exit fails the job → PR blocked (CTO confirmed `02:123`). No CI YAML change is required beyond confirming the affected edge fires; the builder verifies by touching only `packages/metric-engine` and confirming `--dry-run` lists the oracle as affected.

- **The parity test lives in `tools/parity-oracle`, NOT in `packages/metric-engine`** (CTO `02:72`). The engine package keeps `test:unit` (pure-unit registry/shape tests); the cross-path parity assertion is the oracle's `test:parity`.

### D-4 — Provisional read path = named function, migration 0020 — BOUND

- **Migration `db/migrations/0020_provisional_gmv_as_of.sql`** — additive (I-E02): `CREATE OR REPLACE FUNCTION` only; no ALTER/DROP of existing objects; reversible (down = `DROP FUNCTION IF EXISTS provisional_gmv_as_of(uuid, date)`).
- **Signature + body (mirrors `realized_gmv_as_of`'s security posture; per-currency to match D-5 — returns a SET, not a scalar):**

  ```sql
  CREATE OR REPLACE FUNCTION provisional_gmv_as_of(p_brand_id UUID, p_as_of DATE)
    RETURNS TABLE (currency_code CHAR(3), provisional_minor BIGINT)
    LANGUAGE sql
    STABLE
    SECURITY INVOKER          -- executes under caller's RLS context (brain_app) — cross-brand = 0
  AS $$
    SELECT currency_code, COALESCE(SUM(amount_minor), 0)::BIGINT
    FROM realized_revenue_ledger
    WHERE brand_id = p_brand_id
      AND economic_effective_at::date <= p_as_of
      AND recognition_label IN ('provisional', 'settling')
    GROUP BY currency_code;
  $$;
  ```

- **Why per-currency (TABLE) and not a scalar like `realized_gmv_as_of`:** provisional is new code; we build the correct per-currency shape from day one (D-5) rather than inheriting the realized function's legacy scalar. The engine's `computeProvisionalRevenue` maps the rows straight into `Map<currency_code, bigint>`.
- **No ad-hoc SUM:** the engine reads provisional ONLY through this function (the same sole-as-of-path rule as realized). An inline `SELECT SUM(...) WHERE recognition_label IN (...)` in app code is the D-6 violation to block.
- **Migration-time assertion** (copy 0018's NN-1 two-arg DO-block + a SECURITY-INVOKER confirmation): assert the function exists and is `SECURITY INVOKER` (`prosecdef = false`) so a future careless edit to `SECURITY DEFINER` is caught at migration time.
- **Provisional-never-blended-into-realized:** structurally guaranteed by the disjoint predicates — `realized_gmv_as_of` excludes provisional via `event_type <> 'provisional_recognition'`; `provisional_gmv_as_of` selects only `recognition_label IN ('provisional','settling')`. The oracle asserts a fixture whose ledger has BOTH provisional and finalized rows: realized map == finalized-only reference; provisional map == provisional/settling-only; and `realized ∩ provisional contribution = ∅` (adding provisional rows does not move the realized number).

### D-5 — Per-currency output shape — BOUND

- **Engine signatures (per-currency map from day one — multi-currency is then an additive change, never a breaking one):**

  ```ts
  import type { CurrencyCode } from '@brain/money';

  export function computeRealizedRevenue(
    brandId: string, asOf: Date, deps: EngineDeps,
  ): Promise<Map<CurrencyCode, bigint>>;

  export function computeProvisionalRevenue(
    brandId: string, asOf: Date, deps: EngineDeps,
  ): Promise<Map<CurrencyCode, bigint>>;
  ```

  `EngineDeps` carries the `pg.Pool`/client + the resolved `MetricDefinition` so the engine stays testable and the read seam is injected (no hidden global).

- **M1 reality:** single-currency-per-brand (0018 trigger) → the realized map always has exactly one entry. The engine wraps `realized_gmv_as_of`'s scalar `BIGINT` into `Map<brandCurrency, value>` (it reads the brand's `currency_code` to key the map; in M1 that is the one currency every ledger row carries). Provisional reads the per-currency TABLE directly.
- **Never blend currencies:** the map keys ARE the currencies; there is no code path that sums across keys. The 2-brand/2-currency fixture (Brand A=INR, Brand B=AED) proves: querying Brand A returns `{INR: x}`, Brand B returns `{AED: y}`, and neither map ever contains the other's currency or a blended total.

### D-6 — Sole-emitter enforcement — BOUND

- **The fence already exists but is mis-scoped** — `eslint.config.mjs:83-88` blocks `metric-engine` from ALL `core-module`s, contradicting its own comment ("analytics + measurement only"). **Fix:** invert to an allow-list so `measurement` (and `analytics`, when it lands) may import `@brain/metric-engine`, and every OTHER core-module is denied. Concretely, capture the module name and disallow `metric-engine` from core-modules whose `module` is not in `{measurement, analytics}` (eslint-plugin-boundaries supports per-element capture matching; if a single rule cannot express "all-except", express it as: default-deny `metric-engine` from `core-module`, plus an `allow` entry scoped to `measurement`/`analytics`). The builder confirms the measurement module can import the engine and an arbitrary other module (e.g. `identity`) cannot — a fixture test in the lint suite.
- **No ad-hoc ledger aggregation outside the engine:** add a `no-restricted-syntax`/import note (or extend the boundary rule) so no module outside `packages/metric-engine` calls `realized_gmv_as_of`/`provisional_gmv_as_of` for its own SUM, and no app code writes `SUM(amount_minor)` against `realized_revenue_ledger`. The existing `GetRealizedGmvAsOfQuery` is the ONE sanctioned caller of the realized seam; the engine is its ONE consumer. Documented in the ADR note (§7). If a lint expression for raw-SQL-SUM is infeasible (SQL is in string literals), document it as a review-gate rule + the boundary fence covers the import path — acceptable, noted.

### D-7 — No new deployable + F-SEC-02 carry-in — BOUND

- **No new deployable:** `packages/metric-engine` is an in-process library imported by the `core` monolith's `measurement` module; `tools/parity-oracle` is a CI test runner only. No service, container, Lambda, queue, or GitOps app is added. Confirmed CTO `02:156`. (Deploy track §6 is therefore a no-op confirmation, NOT a new pipeline.)
- **F-SEC-02 carry-in (the engine must not make it worse):** `GetRealizedGmvAsOf.ts:24-41` sets `set_config('app.current_brand_id', $1, true)` (transaction-scoped GUC) on a pooled connection but executes in autocommit — the GUC's `true` (local) scope only holds within a transaction, so under autocommit it can reset on connection return (the F-SEC-02 MED gap). **Binding:** when the engine calls the realized/provisional read seams it MUST wrap the GUC-set + the function call in an explicit `BEGIN … COMMIT` on the SAME client, so the GUC is genuinely transaction-scoped and cannot leak across pool reuse. The two-arg `current_setting('app.current_brand_id', TRUE)` fail-closed predicate (`0018:117`) already returns NULL → 0 rows on a missing GUC, so the worst case is fail-closed; the explicit transaction removes the ambiguity. The engine's `EngineDeps` exposes a `withBrandTxn(brandId, fn)` helper that does `BEGIN; set_config(...,true); <fn>; COMMIT`. This is the carry-in tighten — it does not "fix" `GetRealizedGmvAsOf` itself (pre-existing, tracked as F-SEC-02 must-fix-before-Phase-2), but the new engine code is correct by construction. **No PII** is read (ledger is UUID-keyed, `brain_id` is a reference — `0018:9`).

### bigint-fixtures — GoldenFixture money fields `number`→`bigint` — BOUND

- `tools/parity-oracle/src/index.ts:27,31,33,44-45` declares `expectedValueMinor`, `tsComputedValueMinor`, `referenceValueMinor`, and `ParityResult.delta/tsValue/referenceValue` as `number`. **Retype all money fields to `bigint`.** `number` is a float in TS and the `no-float-money` rule's `TSPropertySignature` check (`no-float-money.mjs:115-130`) fires on `*_minor`/`*Value*` money identifiers typed `number`. `GetRealizedGmvAsOf.ts:37` already returns `bigint`; the engine and fixtures must match.
- `checkParity` (`:51-66`) currently uses `Math.abs(a - b)` — `Math.abs` does not accept `bigint`. **Rewrite the delta as `bigint`:** `const delta = ts >= ref ? ts - ref : ref - ts;` and `const passed = delta <= fixture.toleranceMinor;` (with `toleranceMinor: bigint`). `assertNotTautology` (`:145-153`) retypes its `typeof === 'number'` guards to `typeof === 'bigint'`. The Sprint-0 fixtures (`:90-131`) get `bigint` literals (`3n`, `150000n`, `0n`).
- The independent reference returns `bigint` per currency; the engine returns `bigint` per currency; the comparison is `bigint`-exact. Zero float anywhere in the money path.

---

## 3. Data + read-path design

### 3.1 Read seams (the ONLY two paths to a number)

| Metric | Engine method | Named DB seam | Predicate | Returns |
|---|---|---|---|---|
| `realized_revenue` v1 | `computeRealizedRevenue` | `realized_gmv_as_of(uuid, date)` (existing, 0018) via `GetRealizedGmvAsOfQuery` | `event_type <> 'provisional_recognition' AND economic_effective_at::date <= as_of` | `Map<CurrencyCode, bigint>` (M1: 1 entry) |
| `provisional_revenue` v1 | `computeProvisionalRevenue` | `provisional_gmv_as_of(uuid, date)` (NEW, 0020) | `recognition_label IN ('provisional','settling') AND economic_effective_at::date <= as_of` | `Map<CurrencyCode, bigint>` |
| oracle reference (path B) | `getIndependentReferenceRevenue` (oracle only) | **raw SQL, no function** | `recognition_label = 'finalized' AND economic_effective_at::date <= as_of GROUP BY currency_code` | `Map<string, bigint>` |

### 3.2 Migration 0020 (additive, I-E02, reversible)

- New file `db/migrations/0020_provisional_gmv_as_of.sql`. ONE `CREATE OR REPLACE FUNCTION provisional_gmv_as_of` (per D-4) + a migration-time assertion (function exists, `SECURITY INVOKER`). Header block copies 0018's invariant comments. Down: `DROP FUNCTION IF EXISTS provisional_gmv_as_of(uuid, date)`. No table change, no ALTER, additive-only — node-pg-migrate compatible.

### 3.3 Engine internals (DDD — `packages/metric-engine`)

The engine is a library, not a service, so it uses a thin internal shape rather than the full service skeleton: `src/registry.ts` (D-1), `src/realized-revenue.ts` (`computeRealizedRevenue`), `src/provisional-revenue.ts` (`computeProvisionalRevenue`), `src/deps.ts` (`EngineDeps` + `withBrandTxn`), `src/index.ts` (re-exports the public surface). Money values flow as `bigint` minor units keyed by `CurrencyCode` from `@brain/money` — no raw `number` for money.

### 3.4 Golden fixtures (the four required + the 2-currency)

Each fixture seeds `realized_revenue_ledger` rows (under superuser), then asserts engine-map == independent-reference-map per currency, tolerance 0:

| Fixture | Ledger rows | Expected realized | Expected provisional | Proves |
|---|---|---|---|---|
| **clean_finalized** | 1 finalization (+50000 INR) | `{INR: 50000n}` | `{}` (or `{INR:0n}`) | base agreement |
| **full_rto_to_zero** | finalization (+50000) + rto_reversal (−50000), both finalized | `{INR: 0n}` | `{}` | reversals net to 0; signed sum |
| **partial_refund** | finalization (+50000) + refund (−15000), finalized | `{INR: 35000n}` | `{}` | proportional clawback |
| **provisional_plus_finalized** | provisional (+20000, label=provisional) + finalization (+50000, finalized) | `{INR: 50000n}` (provisional NOT counted) | `{INR: 20000n}` | provisional never blended into realized |
| **two_brand_two_currency** | Brand A: finalization +50000 INR; Brand B: finalization +30000 AED | A→`{INR:50000n}`, B→`{AED:30000n}` | — | per-currency, no cross-brand/cross-currency blend |

Negative-control fixture (mirrors the existing scaffold `parity.test.ts:40-59`): a deliberately drifted engine value (off by 1 minor unit) MUST fail the oracle — proves non-tautology end-to-end.

---

## 4. Test strategy (the gate is the product)

All money-bearing tests run against **live Postgres** (the parity assertion is meaningless against a mock). Reuse the ledger slice's dual-pool harness (`realized-revenue-ledger.live.test.ts:41-90`).

| # | Test | Where | Asserts | must-fix source |
|---|---|---|---|---|
| 1 | **Parity — engine == independent SQL** on all 5 fixtures | `tools/parity-oracle` `test:parity` | per-currency `bigint`-exact equality, tolerance 0; would FAIL on 1-minor-unit delta (non-tautological — paths A≠B) | D-2 (CRITICAL) |
| 2 | **Negative control** — drifted engine value fails the oracle | `test:parity` | 1-minor-unit delta → `passed=false` → vitest fails → CI red | D-2 |
| 3 | **Provisional never blended into realized** | `test:parity` | adding provisional rows does not move the realized map; provisional map == provisional/settling-only | D-4 |
| 4 | **Per-currency no-blend** (2-brand/2-currency) | `test:parity` | maps key by `currency_code`; no cross-brand/cross-currency entry; no blended total | D-5 |
| 5 | **No-float** | lint (`brain-money/no-float-money` error) + types | GoldenFixture + engine money fields are `bigint`; lint green | bigint-fixtures, M-2 |
| 6 | **Isolation negative-control under `SET ROLE brain_app`** | live test | reads run as `brain_app` (assert `current_user='brain_app'`); cross-brand query = 0 (RLS); no-GUC = 0 (fail-closed two-arg) | F-SEC-02, I-S01 |
| 7 | **Registry resolution** | `packages/metric-engine` `test:unit` | `resolveMetric('realized_revenue','v1')` returns the def; unknown `(id,version)` throws; `recognitionLabels` ↔ `readSeam` consistency | D-1 |
| 8 | **GUC transaction-scoping** | live test | the engine sets GUC inside an explicit txn (`withBrandTxn`); a read with no txn-scoped GUC returns 0 rows (fail-closed) | F-SEC-02 |
| 9 | **Import fence** | lint fixture | `measurement` may import `@brain/metric-engine`; an unrelated core-module may NOT; no app code calls the named seams directly | D-6 |

**Dev-DB caveat (from MEMORY):** dev connects as superuser `brain` which BYPASSES RLS — so test #6/#8 MUST connect via the `brain_app` pool (`BRAIN_APP_DATABASE_URL`, `postgres://brain_app:brain_app@...`) exactly as the ledger live test does (`realized-revenue-ledger.live.test.ts:43-45`). An isolation assertion run as superuser is a false green.

---

## 5. Slices (smallest-first, COMMIT PER SLICE)

Prior builders died on infra timeouts — keep each slice independently committable and green. Branch `feat/metric-engine-parity` off `master` first.

### Slice 1 — Registry + realized engine + per-currency type
- `packages/metric-engine/src/registry.ts` — `METRIC_REGISTRY` keyed `(metric_id, version)`, `resolveMetric`, types (D-1).
- `packages/metric-engine/src/deps.ts` — `EngineDeps` + `withBrandTxn(brandId, fn)` (F-SEC-02 explicit txn).
- `packages/metric-engine/src/realized-revenue.ts` — `computeRealizedRevenue → Map<CurrencyCode,bigint>` via `GetRealizedGmvAsOfQuery` (reuse the existing seam) (D-5).
- `packages/metric-engine/src/index.ts` — replace `export {}` with the public surface; add `vitest` config + `test:unit` registry tests.
- Fix `eslint.config.mjs` import fence so `measurement` may import the engine (D-6).
- **Acceptance:** registry tests green; engine returns a 1-entry map for a seeded brand under `brain_app`; lint green; fence allows measurement, denies others. **COMMIT.**

### Slice 2 — Provisional fn (0020) + provisional metric
- `db/migrations/0020_provisional_gmv_as_of.sql` — additive `provisional_gmv_as_of` TABLE-returning, SECURITY INVOKER + assertion (D-4).
- `packages/metric-engine/src/provisional-revenue.ts` — `computeProvisionalRevenue → Map<CurrencyCode,bigint>` via the new fn; register `provisional_revenue` v1.
- **Acceptance:** migration applies + reverses cleanly; provisional map correct under `brain_app`; provisional rows do NOT appear in realized. **COMMIT.**

### Slice 3 — Parity oracle: independent reference + golden fixtures + CI dep edge + bigint fix
- `tools/parity-oracle/src/index.ts` — retype all money fields `number`→`bigint`; rewrite `checkParity` delta as `bigint`; retype `assertNotTautology` (bigint-fixtures).
- `tools/parity-oracle/src/reference.ts` — `getIndependentReferenceRevenue` (raw SQL path B; MUST NOT call the engine/named fns) (D-2).
- Golden fixtures (the 5 scenarios §3.4) seeding live ledger rows.
- `tools/parity-oracle/package.json` — add `@brain/metric-engine` workspace dep; `tools/parity-oracle/turbo.json` — `test:parity dependsOn @brain/metric-engine#build` (D-3).
- **Acceptance:** `pnpm turbo run test:parity --affected` after touching ONLY `packages/metric-engine` lists the oracle as affected (dep edge proven); fixtures present; bigint types; lint green. **COMMIT.**

### Slice 4 — Tests + gate proof (the green bar)
- Wire the full parity assertion (engine map == reference map, tolerance 0) across all 5 fixtures; the negative-control drift test; provisional-never-blended; per-currency-no-blend; isolation under `brain_app`; GUC-txn-scope; import-fence fixture.
- Confirm the CI `test:parity` step goes RED on an injected 1-minor-unit delta and GREEN on agreement.
- **Acceptance:** all §4 tests green; CI parity step blocking + firing on engine changes; over-engineering self-check PASS. **COMMIT.**

---

## 6. Deploy track (D-7 — confirmation, no new pipeline)

**No service is created or changed → no deploy pipeline is added.** `packages/metric-engine` ships as part of the `core` app's existing build/image when `core` next deploys (it is an in-process import of the measurement module); `tools/parity-oracle` is CI-only and never deployed. The only "deploy-adjacent" artifact is migration `0020`, which rides the existing additive-migration path (node-pg-migrate, applied before/with the next `core` release — same mechanism as 0018/0019). The builder confirms: (a) `core`'s build still passes with the engine wired in; (b) `0020` is in the migration sequence and reverses cleanly; (c) no new GitOps app, container, or service-deploy manifest is introduced. This is the explicit "no new deployable" confirmation the plan requires in-slice (Slice 4 acceptance), not a follow-up.

---

## 7. ADR / Canon note

- **No new STACK.md layer or ADR required.** This slice wires existing locked choices (metric engine = sole emitter, parity oracle, no-float, RLS). The TS compile-time registry is the M1 binding of METRICS.md's `(metric_id, version)` rule; the Postgres `metric_definition` table remains the long-term SoR (future slice). Flag for the decision-log only: **the eslint metric-engine fence was mis-scoped (over-blocking) and is corrected here to match its documented intent (measurement + analytics only)** — a bug-fix, not a policy change.
- **METRICS.md alignment:** `realized_revenue`/`provisional_revenue` definitions (`METRICS.md:16-17`) are implemented exactly — finalized-only realized, provisional/settling labeled-never-blended, per-currency, exact-integer parity. No Canon amendment.

---

## 8. Acceptance contract (folded must-fixes — REQUIRED pass-1, @intelligence-engineer)

Every item below is a pass-1 requirement (folds all CTO must-fixes — kills the rework bounce):

1. **[D-2 CRITICAL]** The oracle's `getIndependentReferenceRevenue` runs the `recognition_label='finalized' GROUP BY currency_code` SQL and **MUST NOT** call `realized_gmv_as_of`/`provisional_gmv_as_of`/the engine. Doc-comment states the non-tautology rule.
2. **[D-2]** Parity test fails CI on ANY per-currency delta ≥ 1 minor unit (tolerance 0); the negative-control drift test proves it goes red.
3. **[D-1]** Registry keyed `(metric_id, version)`, `as const`, version bump = new key; `resolveMetric` throws on unknown.
4. **[D-3]** `@brain/metric-engine` workspace dep added to the oracle + Turbo `test:parity dependsOn @brain/metric-engine#build`; proven affected by touching only the engine.
5. **[D-4]** `0020_provisional_gmv_as_of.sql` additive, `SECURITY INVOKER`, per-currency TABLE, `recognition_label IN ('provisional','settling')`; reverses cleanly; no ad-hoc SUM in app code.
6. **[D-5]** Both engine methods return `Map<CurrencyCode,bigint>`; 2-brand/2-currency fixture proves no blend.
7. **[D-6]** Import fence corrected (measurement+analytics allowed, others denied); engine is the sole emitter; no app-code ledger SUM.
8. **[D-7 + F-SEC-02]** No new deployable; engine reads via `withBrandTxn` (explicit txn-scoped GUC); F-SEC-02 not regressed; no PII.
9. **[bigint-fixtures / M-2]** All GoldenFixture + engine money fields `bigint`; `checkParity` delta is `bigint`; no-float lint green.
10. **[I-S01]** Isolation negative-control runs under the `brain_app` pool (NOT superuser `brain` — masks RLS); cross-brand=0, no-GUC=0.
11. **COMMIT PER SLICE** (Slices 1–4); branch `feat/metric-engine-parity` off `master`.

---

## In-lane DoD self-check

- [x] All sections filled (no `{{TBD}}`); cost paradigm declared + justified (tier-0, $0/mo, 0 tokens/day); Single-Primitive sweep CLEAN (extend-only).
- [x] Tenant-isolation at every layer (RLS seam + `brain_app` negative control + GUC txn-scope) + observability (parity gate is the observability) + real-network smoke (live-Postgres parity); ≥1 alternative + rejection (per-type/scalar provisional rejected for per-currency TABLE; Postgres `metric_definition` table rejected for M1 in favor of TS const); reversible migration (0020 down = DROP FUNCTION); cost estimate ($0/mo, 0 tokens/day).
- [x] Plan length matches calibration (high-stakes, money+ci_gate surfaces → fuller binding warranted); over-engineering self-check PASS (no speculative table/service/queue); every slice has concrete file targets; deploy track present (no-op confirmation, D-7).
- [x] All CTO must-fix items in the acceptance contract (§8); every named version real (0020 is the next migration after 0019; `workspace:*` is the repo's existing protocol).
- [x] Journal + audit-log + live.log + HANDOFF.
