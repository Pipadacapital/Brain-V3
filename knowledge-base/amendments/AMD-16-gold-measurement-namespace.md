<!-- SPEC: 0.4 -->
# AMD-16 — gold_measurement_* namespace (C.2)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** Wave C (C.2 fact tables, C.4 migration)

## Conflicting spec text
> §C.2 "New fact tables (`gold_measurement_*` …) — `gold_measurement_refunds`, `gold_measurement_settlements`, `gold_measurement_fees`, `gold_measurement_costs`, `gold_measurement_spend`, `gold_measurement_inventory`."

## Ground truth (delta-plan evidence)
Substantial fact infrastructure already exists: `silver_refund` (silver_refund.py:60–73), `silver_settlement` (:53–75, real razorpay lane), `silver_marketing_spend` (canonical day×channel×campaign, **30,482 live rows**, consumed by CAC/campaign/CM marts), `silver_inventory_level`, plus `gold_settlement_summary` and `gold_contribution_margin`. A greenfield `gold_measurement_*` build would duplicate these facts.

## Candidate resolutions
### R1 — Extend/repoint existing tables; alias into the measurement namespace where load-bearing (adopted)
- Extend the existing silver facts (refund taxonomy/lineage, settlement grain, fee extraction) and add only the genuinely missing facts (costs, per-order fees).
- Where the spec name is load-bearing (lineage endpoint, registry), expose it as an **alias or view-map** onto the extended table (e.g. spend: `silver_marketing_spend` IS the fact; `gold_measurement_spend` = view alias, lineage cols mapped spend_event_id→source_event_id, platform→source_system).
- Trade-offs: mixed naming under the hood, resolved by an explicit mapping table in the Wave C gate file; per-table alias-vs-ratify decisions recorded there.

### R2 — Parallel greenfield gold_measurement_* namespace
- Trade-offs: duplicate facts for refunds/settlements/spend, permanent parity burden between the two copies, and live consumers (CAC/CM marts) still on the old ones.

## RECOMMENDED resolution (BINDING)
**R1.** Additive extension of live facts; single source of truth per fact preserved; spec names satisfied via views where needed.
