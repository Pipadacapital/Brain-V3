<!-- SPEC: D.2 -->
# AMD-25 — cross-entity blended metrics (mer / amer / cac) + the `all` grain

**Status:** FILED · **Wave:** D.2 (WD-D2) · **Date:** 2026-07-07 · **Branch:** `feat/commerce-os-program`
**Blocks/unblocks:** the semantic metric registry for `mer`, `amer`, `cac` (and any future blended
ratio spanning two semantic entities). Additive + invariant-preserving → implemented per §0.4.

## Conflicting spec text (PLAN-OF-RECORD §D.2)

> "`packages/semantic-metrics`: YAML per metric `{name, entity, expression (SQL over semantic
> entities), grain, dimensions_allowed, currency_handling, identity_basis, owner, description,
> examples}`."

The shape declares **one** `entity` per metric and an `expression` "over semantic entities". Read
literally, a metric aggregates over a single entity.

## Ground truth (the 5 D.1 entities as they exist — db/trino/views/semantic_*.sql)

1. **`mer`** (blended Marketing Efficiency Ratio) = total net revenue ÷ total ad spend. Revenue lives
   on `semantic_order` (`net_revenue_minor`); spend lives on `semantic_campaign` (`spend_minor`).
   **Two entities.**
2. **`amer`** (acquisition MER) = NEW-customer net revenue (`semantic_order.is_new_customer`) ÷ ad
   spend (`semantic_campaign`). **Two entities.**
3. **`cac`** (blended) = ad spend (`semantic_campaign`) ÷ distinct new customers who purchased
   (`semantic_order.is_new_customer` brain_ids). **Two entities.**
4. **`semantic_campaign` carries NO time column.** `gold_campaign_performance` is a campaign-lifetime
   rollup; the D.1 view exposes no `stat_date`. So a blended metric touching campaign spend cannot be
   time-bucketed by day/week/month from the entities alone — the only shared join axis with
   `semantic_order` is `(brand_id[, currency_code])`.

A single-entity `expression` cannot express any of these three certified metrics (they are in the
SPEC:D.2 launch list). Editing the D.1 `semantic_campaign` view to add a per-day grain would be a
non-additive regrain of another wave's shipped entity — out of scope and invariant-risky.

## Candidate resolutions

**R1 — additive `cross` block + an `all` grain (RECOMMENDED, implemented).**
Extend the metric schema with an OPTIONAL `cross: { entity, measures }` companion aggregate, and add
`all` to the grain enum (a single whole-period rollup, no time bucket). A cross-entity metric declares
its primary `entity` + `measures`, a `cross` entity + measures, and `grain: [all]`. The compiler emits
a `UNION ALL` of the two entities tagged `__src ∈ {base, cross}`, then a single aggregate CTE using
`agg FILTER (WHERE __src = '<leg>')`, joined implicitly on `(brand_id[, currency_code])` and filtered
by **exactly one** `${BRAND_PREDICATE}` at the outer aggregate (the serving seam binds one brand
param). Both legs are thereby brand-scoped at compile time (tenancy is never post-hoc). Purely
additive: existing single-entity metrics are unchanged; `cross` is optional; `all` is a new grain
value, not a change to `day|week|month`.
- **Invariants held:** §1.2 (money integer minor + per-currency grouping; `cac` uses integer
  division, money stays integer), §1.4 (both legs are `deterministicByConstruction` entities — the
  compiler records the proof; a `deterministic_only` cross metric on a physical-basis entity would
  inject the predicate per-leg), AMD-07 D3 (single `${BRAND_PREDICATE}`, compile-time), §0.5 (additive).
- **Cost:** blended MER/aMER/CAC are whole-period only (no time series) until `semantic_campaign`
  grows a time axis — an honest, documented limitation, not a wrong number.

**R2 — model blended metrics as ratios of OTHER metrics (metric composition).**
Add a `numerator_metric` / `denominator_metric` reference so `mer = net_revenue / ad_spend`. Rejected
for now: it introduces a metric-dependency graph + cycle detection + cross-grain reconciliation into
the compiler for three metrics, a much larger surface than R1, with no additional correctness (the
join key is still `(brand_id, currency_code)`).

## Recommendation

**R1.** Implemented in `packages/semantic-metrics`:
- `src/schema.ts` — optional `crossSchema`; `all` added to `TIME_GRAINS`; `superRefine` enforces
  "a `cross` metric must be `grain: [all]`" and "interactive requires ≥1 time-bucketed grain".
- `src/compiler.ts` — `crossViewSql()` (UNION-ALL + `FILTER (WHERE __src=…)` + single brand predicate).
- `metrics/{mer,amer,cac}.yaml` — the three certified cross-entity definitions.
- Tests: `D2.compile.cross_entity`, `D2.tenancy` (exactly one `${BRAND_PREDICATE}`), `D2.schema.cross_requires_all_grain`.

**Follow-up (not blocking):** if `semantic_campaign` later exposes a spend `stat_date`, blended
mer/amer/cac can add day/week/month grains additively (a new grain in the YAML + recompile) with no
schema or compiler change.
