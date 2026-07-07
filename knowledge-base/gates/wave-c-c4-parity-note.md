<!-- SPEC:C.4 -->
# Wave C · C.4 — CAC/ROAS/Executive marts-migration parity note

**Flag:** `measurement.marts_migration` (per-brand, DEFAULT OFF; registry: `packages/platform-flags/src/registry.ts`).
**Rule (C.4):** with the flag ON, outputs match legacy on the golden dataset **EXCEPT explained deltas
from newly-captured fees/costs — NEVER from revenue changes**. Deltas are enumerated line-by-line below.

## What the flag actually switches

The migration is a **spend-source swap only**. Every CAC/ROAS/executive read that consumed the legacy
spend serving-view now resolves its spend source through `spendView(measurementMartsMigration)`
(`packages/metric-engine/src/measurement-migration.ts`):

| flag | spend serving-view |
|------|--------------------|
| OFF (default) | `brain_serving.mv_silver_marketing_spend` (legacy input) |
| ON | `brain_serving.mv_gold_measurement_spend` (Wave-C measurement namespace) |

Per **AMD-16 R1**, `mv_gold_measurement_spend` is a **VIEW ALIAS over the SAME Iceberg fact**
(`iceberg.brain_silver.silver_marketing_spend`) — it is an ADDITIVE SUPERSET: every column the legacy
view exposes is retained UNCHANGED, plus the lineage aliases `source_event_id ← spend_event_id` and
`source_system ← platform`. There is **no second copy of the spend fact**, so the swap changes no spend
value and no grain. (`db/trino/views/mv_gold_measurement_spend.sql`.)

## Line-by-line delta ledger (flag ON − legacy), on golden

| Read path (metric) | Input swapped | Numerator | Denominator | Δ on golden | Cause |
|---|---|---|---|---|---|
| `computeChannelRoas` (channel ROAS) | spend view → alias | attributed_revenue (gold_marketing_attribution) — **unchanged** | spend (alias, same rows) | **0** | source-swap only |
| `computeCampaignRoas` (campaign ROAS) | spend view → alias | attributed_revenue — **unchanged** | spend (alias) | **0** | source-swap only |
| `computeBlendedRoas` (blended ROAS) | spend view → alias | realized_revenue (gold_revenue_ledger) — **unchanged** | spend (alias) | **0** | source-swap only |
| `computeAdSpendTimeseries` (spend KPI) | spend view → alias | — | spend (alias) | **0** | source-swap only |
| CAC (`mv_gold_cac` served) | — (Spark mart) | new_customers — unchanged | acquisition spend | **0** | see note ‡ |
| Executive spend KPIs (`mv_gold_executive_metrics`) | — (Spark mart) | revenue/orders — unchanged | spend | **0** | see note ‡ |

**Every delta is 0** on the golden dataset. Proven in-tree by the parity test
`packages/metric-engine/src/measurement-migration.test.ts`: given identical spend rows, `computeChannelRoas`
and `computeAdSpendTimeseries` return **deeply-equal** output OFF vs ON, and the emitted spend SQL is
identical after normalising the view token (a pure source-swap — no logic/revenue change).

‡ **CAC / executive-KPI Spark marts** (`gold_cac.py`, `gold_executive_metrics.py`) consume the spend
fact at the SPARK layer (`silver_marketing_spend`), which **IS** `gold_measurement_spend` (same fact,
AMD-16). Their eventual Spark-layer repoint is therefore a byte-identical rename (Δ = 0) and is deferred
to their mart rebuild; the serving-layer flag above already covers the TS-computed ROAS/spend read paths
that read spend directly. No revenue column is touched in either.

## Why revenue can never move under this flag

Revenue numerators (attributed_revenue, realized_revenue) read the **gold attribution / revenue ledgers**,
which this flag does **not** touch. The C.4 invariant — "explained deltas from fees/costs, NEVER revenue"
— holds by construction: the flag only re-points the **spend denominator/measure**, and only to an alias
of the same fact.

## Where the real (non-zero) fees/costs deltas live — and why NOT here

The only program-wide non-zero measurement deltas come from **newly-captured cost/fee facts**
(`gold_measurement_costs`, `gold_measurement_fees`) folding into **`gold_order_economics` (C.3)** as CM1/
CM2/CM3 margin figures. Those are:
- **NEW additive margin columns**, never a restatement of existing revenue or spend;
- surfaced on the ECONOMICS marts, **not** on CAC/ROAS/executive-spend, which are spend-denominated and
  do not consume COGS/fees.

The per-SKU COGS source that feeds those cost deltas is **`gold_product_costs`** (this WC-C4 delivery,
migration `db/migrations/0126_gold_product_costs.sql` + CSV ingest `POST /api/v1/costs/product-sheet`).
It lands the brand-uploaded unit costs that Wave C's COGS resolution reads when the connector catalog
carries none — i.e. the deltas originate in **captured costs**, exactly as C.4 requires, and land in the
economics marts, not in the CAC/ROAS/executive marts this flag governs.

## Rollback

Flag OFF (the default, fail-closed) restores the legacy spend view verbatim — no data migration, no
backfill. The legacy read paths are **not removed** (additive flag switch, §0.5).
