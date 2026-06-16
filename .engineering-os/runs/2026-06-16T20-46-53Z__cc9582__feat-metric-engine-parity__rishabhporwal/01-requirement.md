# Requirement: Metric engine + parity oracle (realized_revenue, CI-gated)

| Field | Value |
|-------|-------|
| **req_id** | `feat-metric-engine-parity` |
| **Title** | Metric engine (sole emitter) + parity oracle — realized_revenue, CI-blocking |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-16T20:46:53Z |
| **Tier impact** | M1 data-plane critical path (ledger → **metric engine** → Analytics API) |
| **Region impact** | India (per-currency, single-currency-per-brand) |

---

## Lane *(advisor to confirm — deterministic scan: high_stakes; surfaces: metric_engine, money, multi_tenancy)*

---

## Raw text (from the Stakeholder)

> Build the **metric engine + parity oracle** — the layer after the realized-revenue ledger (`feat-realized-revenue-ledger`, shipped). The TypeScript metric engine is the SOLE emitter of computed numbers; the parity oracle CI-gates it. Wire the EXISTING scaffolds: `packages/metric-engine`, `tools/parity-oracle`. Per `METRICS.md` registry.
>
> DELIVER (M1 scope = the ONE number + its parity gate — NOT all registry metrics):
> 1. **Metric engine — `realized_revenue`** (+ adjacent `provisional_revenue`): the TypeScript engine is the SOLE place a number is computed. `realized_revenue` = sum of `realized_revenue_ledger` rows where `recognition_label = 'finalized'` and `economic_effective_at ≤ as_of`, per `currency_code` (NEVER blend currencies). Read via the ledger's `realized_gmv_as_of()` seam (the sole as-of path). `provisional_revenue` = the provisional/settling rows, displayed alongside, NEVER blended with realized, NEVER fed to billing.
> 2. **Metric registry** — each metric keyed by `(metric_id, version)` (e.g. `realized_revenue` v1); the engine resolves the definition from the registry; the registry is the single source of truth for what a metric means.
> 3. **Parity oracle** (`tools/parity-oracle`) — asserts **engine output == an INDEPENDENT SQL recomputation** over `realized_revenue_ledger` finalized rows, on golden fixtures; **CI-BLOCKING on any delta** (this is the M1 "parity oracle green" exit criterion). Golden fixtures must cover: a clean finalized order, a full-RTO (realized → 0), a partial refund (proportional), and a multi-currency brand set (per-currency sums, no blend).
> 4. **Money discipline:** all math in integer minor units + `currency_code`; NO floats (lint `no-float-money`); per-`currency_code` result; FX never blended (M1 = single-currency-per-brand).
> 5. **Per-brand isolation:** the engine reads under brand RLS (the `realized_gmv_as_of` fn is SECURITY INVOKER — respects the caller's brand context); cross-brand = 0 under `SET ROLE brain_app`; no PII.
> 6. **Automated tests + the CI gate:** the parity oracle test (engine == SQL on every golden fixture; would FAIL on a 1-minor-unit delta — non-tautological); provisional-never-blended; no-float; per-currency (a 2-currency brand set sums separately); isolation negative-control under `brain_app`; the parity gate wired CI-blocking.

---

## Problem statement

The ledger holds the money truth, but nothing COMPUTES the displayed number, and there is no guarantee the computation matches the ledger. METRICS.md mandates ONE metric engine (the sole emitter) + a parity oracle that CI-blocks on any delta between the engine and an independent recomputation — so a number on screen can NEVER silently drift from the ledger. This is the M1 "reconciling number" computed correctly + the "parity oracle green" exit criterion. (Putting it on screen is the next slice: Analytics API + dashboard.)

## Target user

Internal/platform (the metric engine every surface + the billing meter read). India DTC brand, M1.

## Success metric

`realized_revenue` for a brand as-of any date, computed by the engine, equals an independent SQL recomputation over the finalized ledger rows on every golden fixture (incl. RTO/refund/multi-currency) — the parity oracle is green and CI-blocking; provisional is never blended into realized; no float ever; per-currency sums never blend; cross-brand = 0 under `brain_app`. The "parity oracle green" M1 exit criterion is met.

## Constraints

- **One metric engine, sole emitter** — no number computed anywhere else (no ad-hoc SUM in app/API code; the engine is the only path). Registry-keyed `(metric_id, version)`.
- **Money:** integer minor units + currency_code; NO floats (lint-enforced); per-currency; never blend currencies.
- **Parity is CI-blocking** — any engine-vs-SQL delta fails CI (the gate, not advisory).
- Absolute brand/tenant isolation (the ONE invariant); reads under brand RLS; verify under `SET ROLE brain_app` (dev superuser masks RLS). No PII.
- Reads the ledger via `realized_gmv_as_of()` (the sole as-of path the ledger exposes) — do NOT re-implement the ledger sum in app code.
- Hard rule: no NEW deployable — `packages/metric-engine` + `tools/parity-oracle` + the engine called from the existing core. Migrations additive (I-E02) if any.

## Non-goals

- The OTHER registry metrics: cm1, cm2/True CM2, attribution_credit, attribution_reconciliation_rate, identity_match_rate, recovered_cm2_to_fee_ratio, events_captured_count (later slices — this slice proves the engine + oracle pattern on `realized_revenue`).
- The **Analytics API + dashboard** (the NEXT slice — puts the number on screen via a read-only API).
- StarRocks / Gold mirror / dbt marts (M1 reads the Postgres ledger SoR directly).
- The billing meter, recommendations, attribution.
- Cross-currency FX conversion (single-currency-per-brand for M1).

## Linked prior runs

- feat-realized-revenue-ledger (the `realized_gmv_as_of()` seam + the ledger SoR)
- feat-identity-graph, feat-data-plane-ingest-spine

## Notes

- Scaffolds: `packages/metric-engine/src/index.ts` (stub), `tools/parity-oracle/src/parity.test.ts` (scaffold). METRICS.md registry defines `realized_revenue` + `provisional_revenue` precisely (recognition_label filter; per-currency sum; reversals signed-negative; sale never mutated).
- The ledger exposes `realized_gmv_as_of(brand_id, as_of)` (SECURITY INVOKER, excludes provisional) — the engine's realized read seam. `provisional_revenue` may need an adjacent named read for provisional/settling rows (architect to bind — keep it a named DB path too, no ad-hoc SUM).
- **Architect must bind:** the registry shape `(metric_id, version)` + how the engine resolves a definition; the parity oracle's independent-recomputation source (an independent SQL over the ledger that does NOT call the same fn — else it's tautological); how the CI gate is wired (the parity test as a CI-blocking step); the provisional read path; per-currency result shape.
- Builder lesson: tight scopes + COMMIT PER SLICE (prior builders died on infra timeouts). Primary builder: **intelligence-engineer** (metric parity, the evaluation/parity gate, the metric registry). Verify isolation under `SET ROLE brain_app`.
- F-SEC-02 carry-in: the ledger's `GetRealizedGmvAsOf` uses a raw pool with per-call set_config (defense-in-depth gap) — if the engine reaches the ledger via that path, note/tighten it (txn-scoped GUC). Pre-existing, tracked.
