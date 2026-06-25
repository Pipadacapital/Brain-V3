# RETIRED: feature_customer_daily (Brain V4 Phase 2, GROUP executive+cac)

V4 **forbids permanent feature tables** — features become **runtime** (computed point-in-time at
serving, never materialized as a daily-appended permanent table). The dbt model
`db/dbt/models/marts/feature_customer_daily.sql` (schema `brain_feature`, an incremental daily
customer-feature SCD snapshot) is therefore **DROPPED from the V4 Gold/feature build**:

- **NO Spark→Iceberg job** is written for it (there is no `db/iceberg/spark/gold/feature_customer_daily.py`).
- **NO `mart_registry.py` entry** is added for it (the parity oracle never tracks it on the V4 side).
- The dbt model + its legacy `brain_feature.feature_customer_daily` StarRocks table are **left untouched**
  (Phase 2 is additive / non-breaking and changes no dbt). They simply have **no V4 successor** — when the
  legacy dbt path is eventually cut over/retired, this table dies with it.

## Why it is safe to drop from the V4 build
The table's only documented consumer is `gold_customer_scores` (RFM/churn), via
`ref('feature_customer_daily')`. In V4 those scores are recomputed at runtime from the canonical Silver
customer entity (`silver_customer`) + the order spine, point-in-time-correct, rather than read from a
permanent daily-snapshot feature table. The historical-restatement role the snapshot served is covered by
`snap_order_state` (the order-state SCD this same group DOES port) and by Iceberg time-travel on the
Silver entities — neither of which requires a permanent per-day feature mart.

## What this group DID port (the Phase-2 Spark Gold marts)
- `gold_executive_metrics.py`  → `brain_gold.gold_executive_metrics`
- `gold_cac.py`                → `brain_gold.gold_cac`
- `snap_order_state.py`        → `brain_silver.snap_order_state`
