<!-- SPEC: C.3 / AMD-17 -->
# CM1/CM2/CM3 Naming Map — `gold_order_economics` (spec) ⇄ `gold_contribution_margin` (live)

**Purpose.** AMD-17 (BINDING, R1) requires the NEW Wave-C economics mart to adopt the industry-convention
CM numbering **from day one**, while the LIVE `gold_contribution_margin` + its served TS twin
(`contribution-margin.ts`) are **left untouched** — no rename, no re-labelling of served values. Two
numbering schemes therefore coexist during Waves C–D. This document is the explicit mapping the amendment
mandates. Convergence is handled by Wave D's governed deprecation path
(`knowledge-base/semantic/deprecation-map.md`, where the semantic layer becomes the single naming
authority and the live mart is deprecation-mapped).

## The collision

The live `gold_contribution_margin` (built by `db/iceberg/spark/gold/gold_contribution_margin.py`, served
via `metric-engine/.../contribution-margin.ts`) uses a **SHIFTED** numbering that omits a dedicated
"revenue − COGS only" tier and folds COGS into the first published margin:

| Concept | Formula | **Live** name (`gold_contribution_margin`) | **Spec** name (`gold_order_economics`) |
|---|---|---|---|
| Net revenue − COGS | `net_revenue − cogs` | *(not published as its own tier)* | **CM1** (`cm1_minor`) |
| … − variable (ship + packaging + fees) | `(net − cogs) − variable` | **CM1** (`cm1_minor`) | **CM2** (`cm2_minor`) |
| … − marketing | `cm1 − marketing` | **CM2** (`cm2_minor`) | **CM3** (`cm3_minor`) |

**Read this as:** `live CM1 ≙ spec CM2` and `live CM2 ≙ spec CM3`. There is **no** live tier equal to spec
CM1 (the live mart never publishes revenue−COGS on its own).

## Authoritative equivalences

```
gold_contribution_margin.cm1_minor   ≙   gold_order_economics.cm2_minor      (net − COGS − ship − packaging − fees)
gold_contribution_margin.cm2_minor   ≙   gold_order_economics.cm3_minor      (… − marketing)
gold_contribution_margin.net_revenue_minor  ≙  Σ gold_order_economics.net_revenue_minor   (per brand×currency)
gold_contribution_margin.marketing_minor    ≙  Σ gold_order_economics.marketing_minor      (per brand×currency)
(no live equivalent)                  ←   gold_order_economics.cm1_minor      (spec CM1 = net − COGS; NEW tier)
```

## Why they are NOT the same number (do not expect a row-for-row parity)

The two marts are **not** a straight relabelling — they differ in grain and in cost basis, by design:

| Dimension | `gold_contribution_margin` (live) | `gold_order_economics` (spec/new) |
|---|---|---|
| Grain | one row per **(brand_id, currency_code)** — brand LIFETIME totals | one row per **(brand_id, order_id)** — per order |
| COGS / variable basis | **pct-of-revenue** from `billing.cost_input` (`pct_bps`) | **MEASURED** facts: `gold_product_costs` (COGS), `gold_measurement_costs` (ship+packaging), `gold_measurement_fees` (fees) — degraded to 0 until WC-C2 builds them |
| Marketing | brand total spend | **per-order allocated** (`cm3_allocation_basis`: `deterministic_attributed` \| `day_channel_prorata` \| `none`) |
| Reversals | not order-aware | `economics_state = reversed`; RTO/refund flip `net_revenue_minor` negative → negative CM3 |

So `gold_contribution_margin.cm1_minor` (live) and `Σ gold_order_economics.cm2_minor` (spec) answer the
same *question* but will differ in *value* whenever measured costs ≠ pct-config costs. That is expected and
intended — the new mart is the fact-based successor. **Neither number is silently changed**: the live
served metric keeps its exact meaning and value until Wave D migrates consumers under a per-brand flag with
a parity gate (AMD-17 R1; §C.4).

## Money & invariant notes

- Both marts carry signed **BIGINT minor units + sibling `currency_code`**, per-currency, never blended,
  no float (§1.2). `gold_order_economics` proves the GCC 3-decimal (KWD/BHD/OMR fils) sum-of-parts
  reconciliation with ZERO rounding loss (`_order_economics_test.py`, C.5.3).
- `gold_order_economics` net revenue is the ledger's recognized/reversal basis (Σ non-provisional events,
  == `silver_order_state.order_value_minor`), so a reversed order nets negative → CM3 negative (C.5.2).

## Wave D convergence (forward pointer)

Wave D authors `knowledge-base/semantic/deprecation-map.md` and a deprecation lint that BLOCKS **new**
consumers of `gold_contribution_margin`, routing them to the semantic `contribution_margin` metric defined
over `gold_order_economics` (spec numbering). Existing consumers migrate route-by-route behind the
`semantic.serving` flag with per-endpoint parity tests. Only after every consumer has moved is the live
mart's numbering retired. Until then, **this map is the single source of truth for translating between the
two schemes.**
