# CTO Advisor Review — feat-metric-engine-parity
**Stage:** 1 (intake, personas folded into this pass)
**Decision:** ADVANCE
**Date:** 2026-06-17T00:45:00Z
**Reviewer:** Engineering Advisor (cto-advisor, Sonnet tier)

---

## Lane Confirmation

Deterministic scan declared: `high_stakes` — surfaces `[metric_engine, money, multi_tenancy]`.

**Validated (no removals):** All three surfaces confirmed correct.
**Addition:** `ci_gate` added as a distinct surface — the parity oracle's CI-blocking wiring is a separate enforcement surface from `metric_engine`, and a misconfiguration there (advisory vs blocking) would defeat the entire requirement. Recording it explicitly.

**Final trigger surfaces:** `[metric_engine, money, multi_tenancy, ci_gate]`

---

## Dependency Pre-flight

Blocker: `feat-realized-revenue-ledger` — status `shipped` (migration 0018 verified-applied, `realized_gmv_as_of()` confirmed in repo at `db/migrations/0018_realized_revenue_ledger.sql:176`). No dependency hold.

---

## Make It Less Dumb First

The requirement is already tight. M1 scope = one metric (`realized_revenue`) + its oracle. The non-goals section correctly excludes all other registry metrics, StarRocks mirrors, the Analytics API, and billing meter. No scope to cut further. The two scaffolds (`packages/metric-engine/src/index.ts`, `tools/parity-oracle/src/index.ts`) exist and are wired into the CI `test:parity` step (`pr.yml:33`). This is wiring existing scaffolds, not building new infrastructure.

One simplification confirmed appropriate: M1 reads the Postgres ledger SoR directly. StarRocks/Gold mirror path is a non-goal. Do not let the Architect introduce a StarRocks read path for M1.

---

## Adversarial Stress Findings (Severity-Ranked)

### CRITICAL — Tautological Oracle Risk

**Risk:** The current Sprint-0 oracle scaffold (`tools/parity-oracle/src/index.ts`) is a pure in-memory fixture comparison — `tsComputedValueMinor` is hardcoded alongside `referenceValueMinor` in the same array. For Sprint-0 (EC9, a trivial green scaffold) this is intentional and the anti-tautology comment acknowledges it. But when M1 adds `realized_revenue` fixtures, the reference value MUST NOT be produced by calling the same `realized_gmv_as_of()` function the engine calls.

**The specific tautology to prevent:** if the parity fixture is written as `referenceValueMinor = await db.query('SELECT realized_gmv_as_of($1, $2)', [brandId, asOf])`, and the engine also calls `realized_gmv_as_of()` under the hood, a bug inside `realized_gmv_as_of()` would produce identical wrong values in both paths — the oracle passes, the drift goes undetected.

**The non-tautological reference SQL (binding D-2 below):** the oracle's reference must independently derive:

```sql
SELECT currency_code, SUM(amount_minor) AS realized_minor
FROM realized_revenue_ledger
WHERE brand_id = $1
  AND economic_effective_at::date <= $2::date
  AND recognition_label = 'finalized'
GROUP BY currency_code
```

This query deliberately differs from `realized_gmv_as_of()` in two structural ways: (a) it filters on `recognition_label = 'finalized'` rather than `event_type <> 'provisional_recognition'`, and (b) it groups by `currency_code` rather than returning a single bigint. This is intentional — it forces agreement via a different predicate path. A bug that allows provisional rows through the fn will produce a delta here. A cross-currency blend in the fn will produce a delta here. Both bugs get caught.

Note: `realized_gmv_as_of()` excludes provisionals via `event_type <> 'provisional_recognition'` while the reference SQL excludes them via `recognition_label = 'finalized'`. These are semantically equivalent for the M1 ledger (only `finalization` rows carry `recognition_label='finalized'`), which is exactly why using both is the right cross-check — any divergence in ledger population between the two predicates surfaces immediately.

Severity: CRITICAL — if the oracle is tautological, the entire CI gate proves nothing.

### HIGH — provisional_revenue Read Path Not Yet Named

**Risk:** The requirement names `provisional_revenue` as adjacent to `realized_revenue`. The ledger exposes `realized_gmv_as_of()` (which excludes `provisional_recognition` rows) but has no named function for provisional/settling rows. The requirement notes "architect to bind — keep it a named DB path too, no ad-hoc SUM." This is unresolved at intake and must be bound by the Architect before implementation.

**File:** `db/migrations/0018_realized_revenue_ledger.sql` — no `provisional_gmv_as_of()` or equivalent function exists.
**Risk if deferred past architecture:** an engineer will write `SELECT SUM(amount_minor) FROM realized_revenue_ledger WHERE recognition_label IN ('provisional','settling')` inline in the engine. That is an ad-hoc SUM, violates D-3 / the sole-as-of-path rule, and bypasses RLS setup that the named fn would enforce.

Severity: HIGH — must be bound in the architecture spec before implementation starts.

### HIGH — CI Gate Wiring: `test:parity` Is Present But the Engine's Parity Test Is Not Yet Wired

**Status of what exists:** `pr.yml:33` runs `pnpm turbo run test:parity --affected`. The parity-oracle package has `"test:parity": "vitest run"` in its `package.json`. The Sprint-0 fixture runs green. This is correct scaffolding.

**What does not yet exist:** the `packages/metric-engine` package has no `test:parity` script and no vitest config. When the Architect wires the engine, the parity test must live in `tools/parity-oracle` (not in `packages/metric-engine`) and must be the one CI step that fails the build on any delta. The Architect must confirm that `tools/parity-oracle` is in the Turbo affected graph when `packages/metric-engine` changes — otherwise the gate only fires on changes to the oracle tool itself, not on engine logic drift.

**Specific concern:** Turbo's `--affected` flag computes the affected set from the dependency graph in `turbo.json` / `package.json` workspace dependencies. If `tools/parity-oracle` does not declare `@brain/metric-engine` as a dependency (or peer), a change to the engine alone will not trigger the oracle run. The Architect must wire this dependency explicitly.

Severity: HIGH — the gate exists in CI but the dependency edge that makes it fire on engine changes is not yet established.

### HIGH — per-currency Result Shape Not Yet Defined

**Risk:** `realized_gmv_as_of()` returns a single `BIGINT`, not a per-currency result. METRICS.md defines `realized_revenue` as `SUM(amount_minor) GROUP BY currency_code`. M1 is single-currency-per-brand (the trigger rejects mismatched currency), so a single BIGINT is correct today. But the engine's output type must be defined as a per-currency map from day one — `Map<CurrencyCode, bigint>` or `Array<{currencyCode: string; valueMinor: bigint}>` — so that the M2 multi-currency case is an additive change, not a breaking interface change.

The parity oracle fixture must also test a two-brand, two-currency scenario where Brand A (INR) and Brand B (AED) both appear in the ledger — confirming the engine returns separate per-currency sums and never blends them.

Severity: HIGH — architectural interface decision, must be bound before implementation.

### MEDIUM — no-float-money Lint Coverage Gap for `number` Type on Money Identifiers

**What the rule covers:** `tools/eslint-rules/no-float-money.mjs` fires on `TSNumberKeyword` type annotations on `*_minor`, `*_revenue`, `*_amount`, etc. identifiers. It fires on float literals assigned to those identifiers. It fires on float arithmetic on the right-hand side of assignments to those identifiers.

**Gap:** The `GoldenFixture` interface in `tools/parity-oracle/src/index.ts:29` declares `expectedValueMinor: number`, `tsComputedValueMinor: number`, and `referenceValueMinor: number`. `number` in TypeScript is a float. The lint rule fires on `TSNumberKeyword` for those field names — which means the CURRENT scaffold already violates the rule if no-float-money is wired to the parity-oracle package. If the lint is not yet wired to `tools/parity-oracle`, this gap will surface when it is.

**Correct type:** all money fields should be `bigint` in TypeScript, consistent with `GetRealizedGmvAsOf.ts:23` which returns `bigint`. The fixture interface should use `bigint` not `number`. The Architect must fix this in the oracle's type definitions before the real metric fixtures are written.

**Confirmed:** `GetRealizedGmvAsOf.ts` correctly returns `bigint` and uses `BigInt(raw)` at line 38. The engine must match this type.

Severity: MEDIUM — the existing scaffold has a type inconsistency that the lint rule should catch; must be resolved before real money values flow through the fixture.

### MEDIUM — F-SEC-02 Carry-in: GUC-Reset Gap in GetRealizedGmvAsOf

**Pre-existing, tracked:** The `GetRealizedGmvAsOf` query (`apps/core/src/modules/measurement/internal/application/queries/GetRealizedGmvAsOf.ts:27`) uses `set_config(..., true)` (transaction-scoped GUC) on a pool connection, but the connection returns to the pool after `client.release()`. The per-call `set_config` is transaction-scoped — however, if the engine calls this via a non-transaction context (autocommit), the GUC resets on connection return. This is the F-SEC-02 MED gap from the ledger slice.

**For this slice:** the metric engine reads via this same path. The Architect must note that the engine must always call `GetRealizedGmvAsOf` within an explicit transaction context (BEGIN/COMMIT) to ensure the GUC is transaction-scoped and cannot leak across pool reuse. This is a defense-in-depth gap; the two-arg `current_setting(..., TRUE)` fail-closed predicate catches a missing GUC (returns NULL → brand_id = NULL → 0 rows), but explicit transaction scoping eliminates the ambiguity. Tracking as carry-in from ledger slice, must-fix before Phase-2.

Severity: MEDIUM — pre-existing, tracked as F-SEC-02; the engine must not make it worse.

### LOW — assertNotTautology Is a Structural Type Check, Not a Runtime Proof

**Observation:** `assertNotTautology()` in the oracle scaffold (`tools/parity-oracle/src/index.ts:137`) only checks that both fields are present and `toleranceMinor >= 0`. It does not — and cannot by static analysis — verify that `referenceValueMinor` was computed by a different code path than `tsComputedValueMinor`. The non-tautological guarantee must be enforced by code review + the architectural binding (D-2), not by the function itself. This is acceptable; note it so the Architect and builder understand that `assertNotTautology` is a guard rail, not a proof.

Severity: LOW — acknowledged design constraint; the binding is the enforcement mechanism.

---

## Domain Check Against Product Canon

| Check | Status |
|---|---|
| One metric engine, sole emitter | Confirmed required. Locked choice 4 in STACK.md: "the only place a number is computed." Ad-hoc SUM elsewhere = Canon violation. |
| Integer minor units + currency_code | Enforced by migration assertion-3 (bigint only), `no-float-money` lint, `GetRealizedGmvAsOf` returns bigint. Gap: oracle fixture uses `number` type — must fix. |
| Per-currency, never blend | `realized_gmv_as_of()` currently returns a single BIGINT (single-currency-per-brand enforced by trigger). Engine output type must be per-currency from day one. |
| Brand RLS | SECURITY INVOKER confirmed (`0018_realized_revenue_ledger.sql:176`). RLS policy present (`0018:115`). Dev superuser masks RLS — isolation test must run under `SET ROLE brain_app`. |
| Provisional never blended with realized | `realized_gmv_as_of()` excludes `provisional_recognition` via `event_type <> 'provisional_recognition'` predicate. The oracle must assert provisional rows produce zero delta in realized sum. |
| Parity oracle CI-blocking | `pr.yml:33` wires `test:parity --affected`. Blocking on failure: yes, the step runs in the `lint-typecheck-unit` job with no `continue-on-error`. Gate exists. Dependency-edge gap: must verify `tools/parity-oracle` is marked as depending on `packages/metric-engine` in Turbo. |
| No PII | Ledger has no PII columns (brain_id is UUID reference, not contact detail). Engine reads the ledger. No new PII surface introduced. |
| No new deployable | Confirmed non-goal. `packages/metric-engine` and `tools/parity-oracle` are packages/tools, not deployables. Engine called from existing core module. |
| Effort tier | Tier 0 deterministic throughout (aggregation over certified ledger). No model call. No ML. Correct per METRICS.md effort-tier defaults. |
| Metric registry `(metric_id, version)` | METRICS.md references `metric_definition` table keyed by `(metric_id, version)`. Table not yet created — Architect must bind whether the registry is a Postgres table, a TypeScript constant, or both for M1. |

---

## Architect Bindings (D-1 through D-7)

**D-1 — Registry shape:** the engine resolves metric definitions from a typed TypeScript registry object keyed by `(metric_id, version)`, e.g. `METRIC_REGISTRY['realized_revenue']['v1']`. For M1, this is a compile-time constant (no DB lookup needed). The Postgres `metric_definition` table (referenced in METRICS.md) is the long-term SoR; for M1 the TS registry is sufficient. A version bump requires a new key, not mutation. The Architect must define the registry type and resolution function in `packages/metric-engine/src/registry.ts`.

**D-2 — Non-tautological parity reference SQL (the binding):** the oracle's `referenceValueMinor` for `realized_revenue` fixtures must be produced by executing this exact SQL independently against the test database, NOT by calling `realized_gmv_as_of()`:

```sql
SELECT currency_code, SUM(amount_minor) AS realized_minor
FROM realized_revenue_ledger
WHERE brand_id = $1
  AND economic_effective_at::date <= $2::date
  AND recognition_label = 'finalized'
GROUP BY currency_code
```

This is the independent recomputation. It uses `recognition_label = 'finalized'` (a different predicate than `event_type <> 'provisional_recognition'` used by the fn) and groups by `currency_code` (returning per-currency sums, not a blended total). These differences are load-bearing: they make the oracle detect bugs in the fn's predicate logic or currency handling. The Architect must write a test helper `getIndependentReferenceRevenue(brandId, asOf, db)` that runs this SQL and returns `Map<string, bigint>`.

**D-3 — CI-blocking gate dependency edge:** the Architect must add `@brain/metric-engine` as a workspace dependency in `tools/parity-oracle/package.json` AND add a `dependsOn: ["@brain/metric-engine#build"]` entry in the parity-oracle's turbo pipeline config. This ensures `test:parity` runs whenever the engine changes, not only when the oracle tool itself changes. Without this edge, the CI gate exists but does not fire on engine regressions.

**D-4 — Provisional read path:** a named DB function `provisional_gmv_as_of(p_brand_id UUID, p_as_of DATE)` must be created in migration 0020 (additive, I-E02). It must return a per-currency result (not a single BIGINT) and must be SECURITY INVOKER. It queries `WHERE recognition_label IN ('provisional', 'settling') AND economic_effective_at::date <= p_as_of`. No ad-hoc SUM in app code — the same sole-as-of-path rule applies. The parity oracle must assert provisional rows never contribute to the realized sum.

**D-5 — Per-currency result shape:** the engine's `computeRealizedRevenue(brandId: string, asOf: Date): Promise<Map<string, bigint>>` must return a `Map<CurrencyCode, bigint>` (or equivalent typed record), not a bare `bigint`. M1 will always return a map with one entry (single-currency-per-brand), but the type is multi-currency from day one. The oracle fixtures must include a two-brand scenario to prove no cross-brand blend, and a semantic multi-currency fixture (two distinct brand IDs with different currency codes each) to prove the map groups correctly.

**D-6 — Sole emitter enforcement:** the Architect must add an import lint rule (or document in the ADR) that no module outside `packages/metric-engine` may import `realized_revenue_ledger` directly for aggregation purposes. Ad-hoc `SUM(amount_minor)` in app or API code is a Canon violation (locked choice 4). The existing `GetRealizedGmvAsOf` is already gated by D-3 comment ("NO ad-hoc SUM(...) permitted anywhere in application code"). The engine must be the only caller of that query class.

**D-7 — No new deployable confirmed:** `packages/metric-engine` is an in-process library called from the `core` monolith's measurement module. `tools/parity-oracle` is a CI tool (test runner only). No new service, container, or Lambda is introduced. Primary builder: intelligence-engineer.

---

## Decision

**ADVANCE to Stage 2 (Architecture)**

The requirement is sound, Canon-aligned, and worth doing. The ledger substrate is shipped and verified. The scaffolds exist. CI wiring is partially in place. The concerns are architectural bindings the Architect must resolve — none of them invalidate the requirement, and all of them are solvable in the architecture spec.

The non-tautological independent parity reference (D-2) is the single most important binding. If the oracle calls the same function the engine calls, the CI gate proves nothing. The Architect must bind D-2 before the intelligence-engineer writes a single line of fixture code.

**No personas spawned** (compressed pass per orchestrator instruction — adversarial lenses folded inline above).

---

## Carry-in Residuals (from prior slices, tracked)

- F-SEC-02 MED: `GetRealizedGmvAsOf` GUC-reset gap (before Phase-2, must not regress in this slice)
- `list_active_brand_ids` adopt-rule pending (identity + ledger slices — does not block this slice)
- Sprint-0 `assertNotTautology` is a structural guard not a proof (LOW, acknowledged above)
