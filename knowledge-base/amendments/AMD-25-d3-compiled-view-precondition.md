# AMD-25 — D.3 consumer migration ships the switch dark; compiled-view parity is D.2-gated

**Status:** FILED (R1 adopted). Additive + invariant-preserving.
**Spec anchors:** PART 5 §D.3 (consumer migration), §D.4.1 (same-number test), §1.11 (interactive serving).
**Blocks:** nothing. **Depends on:** D.2 (compiled metric views) for the *second half* (flag-ON parity).

## Conflict (spec text vs ground truth)

§D.3 reads: "Gateway endpoints + dashboards migrate behind flags with per-endpoint parity; BAI
serves from compiled views — BAI and dashboards cannot disagree by construction." §D.4.1 requires
a same-number test where `endpoint == compiled view == direct entity computation` to the minor unit.

Ground truth at the time WD-D3 executed: **the compiled metric views do not exist yet.**
`packages/semantic-metrics` carries the registry schema (`src/schema.ts`) but no compiler output —
`generated/views/` and `generated/preaggs/` are empty, and no `semantic_metric_*` Trino view is
registered live. The D.1 semantic ENTITY views (`semantic_customer/order/product/campaign/journey`)
exist as SQL but the per-metric×grain compiled views §D.2 mandates (the migration *target*) do not.

A verbatim §D.3 ("serve from compiled views") is therefore **impossible today** — there is nothing
to migrate *to*. A literal reading would force one of: (a) block D.3 entirely on D.2, stalling the
serving/gate/cache infrastructure that is independently shippable; or (b) invent throw-away compiled
reads, violating ADDITIVE-ONLY and the metrics-as-code governance (views must be *compiler* output,
never hand-authored).

## Resolution

**R1 (adopted):** D.3 ships the *migration mechanism* dark and byte-identical; flag-ON compiled
parity lands incrementally as D.2 emits each compiled view.

1. **The switch is the deliverable, not the compiled read.** Every migrated endpoint routes through
   the `SemanticServingRouter` (`packages/metric-engine/src/semantic-serving.ts`). With flag
   `semantic.serving` OFF (DEFAULT, per-brand, `@brain/platform-flags`) the router is a **pure
   pass-through to the existing legacy `mv_gold_*` read** — provably byte-identical (proven by
   `semantic-serving.D3.parity.test.ts`). A migrated endpoint whose compiled view has NOT landed
   passes `semanticCompute` = undefined, so it stays on legacy **even with the flag ON** (safe
   per-metric migration — a brand can flip the flag before every metric is compiled without a 500
   or an empty panel).

2. **Parity is proven in two tiers.** (i) *Switch parity* (available now): the router NEVER perturbs
   a value for an unmigrated metric, and for the migration-scope metrics the flag-ON path returns a
   value deep-equal to the flag-OFF path to the minor unit (bigint money → equality IS minor-unit
   equality) — `D3.parity` suite. (ii) *Compiled parity* (per-metric, as D.2 lands): when the
   compiled `semantic_metric_<name>` view for a metric is registered, its `semanticCompute` closure
   is wired and a `D3.parity.<metric>` golden test asserts `compiled == legacy` to the minor unit
   before that metric's flag-ON path is enabled for any brand. Until then the closure is absent.

3. **§D.4.1 same-number test** is satisfied incrementally: it runs per metric at the moment that
   metric's compiled view is wired, and is a *precondition* for enabling `semantic.serving` = ON for
   that metric on any live brand. Golden fixtures for the 7 first-migration metrics are pinned today
   in `D3.parity`; the direct-entity-computation leg attaches when D.2 compiles the view.

4. **§1.11 infrastructure ships now, independent of D.2:** the per-brand Trino admission gate
   (`trino-brand-gate.ts`, wired at the `srPool` chokepoint in `apps/core/src/main.ts`, DEFAULT
   permissive) and the BAI query-result cache key `{brand_id}:q:{normalized_query_hash}`
   (`analytics-cache.ts`) are pure additions that do not depend on any compiled view.

**R2 (rejected):** block all of D.3 on D.2 — stalls independently-valuable, zero-risk serving
infrastructure and yields no incremental convergence.

## Migration scope (first cut, `SEMANTIC_SERVING_METRICS`)

`realized_revenue, provisional_revenue, order_status_mix, aov, blended_roas, cac, cod_mix` — the
delta plan's highest-value headline set (revenue/orders/aov/roas/cac/cm*). Endpoints wired through
the router in this wave: `GET /api/v1/analytics/blended-roas` (metricId `blended_roas`) and
`GET /api/v1/analytics/order-status-mix` (metricId `order_status_mix`). Both are BYTE-IDENTICAL
today (flag OFF / no compiled view). The router is threaded end-to-end
(`main.ts → registerWorkspaceAccess → registerBffRoutes → BffDeps.semanticRouter`) so remaining
scope endpoints are a one-line `routeMetric(...)` wrap plus, later, one `semanticCompute` closure.

## Invariants preserved

ADDITIVE-ONLY (legacy marts untouched, no drops); DEFAULT-OFF per-brand flag; brand_id-first +
`${BRAND_PREDICATE}` compile-time tenancy unchanged (the gate is a liveness control, never touches
SQL/isolation); money = bigint minor + currency; metrics-as-code governance intact (no hand-authored
compiled views introduced).
