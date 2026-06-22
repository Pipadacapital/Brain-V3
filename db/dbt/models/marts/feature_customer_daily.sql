-- ============================================================================
-- feature_customer_daily — daily point-in-time customer feature snapshot (DB-AUDIT C3: "no history /
-- SCD anywhere → ML training impossible, no retention cohorts, no historical restatement").
--
-- Every Silver/Gold mart was latest-state only. This is the FIRST history table: an INCREMENTAL,
-- append-per-day snapshot of each customer's features, keyed (brand_id, brain_id, snapshot_date).
-- Prior days are preserved; a same-day re-run is idempotent (PRIMARY-key upsert on the grain). This
-- is the point-in-time-correct training substrate for churn / propensity / LTV (C5) and the basis for
-- retention-cohort analysis — features as-of each date, never just "now".
--
-- ADDITIVE snapshot (no non-additive math here). MONEY = BIGINT minor units + currency_code (I-S07).
-- ISOLATION: brand_id first key/dist column; per-brand isolation at the read seam (I-ST01).
--
-- M10 (audit) — FEATURE LAYER SEPARATION: this lives in the dedicated `brain_feature` schema, NOT
-- brain_silver. brain_silver/brain_gold are the ANALYTICS medallion (additive marts the dashboards read);
-- brain_feature is the ML FEATURE STORE substrate (point-in-time-correct, training/serving). Keeping the
-- feature layer in its own schema makes the boundary explicit (feature ≠ analytics), so the offline
-- training reads and the online feature reads target one namespace and can evolve without touching the
-- serving marts. (dbt ref() is schema-agnostic, so gold_customer_scores' ref('feature_customer_daily')
-- resolves unchanged across the move.)
--
-- SCHEDULING: run daily (the snapshot stamps current_date()). A missed day = a gap (acceptable); a
-- re-run = idempotent. No is_incremental() filter: each run upserts TODAY's row per customer and
-- leaves all prior snapshot_dates intact (the unique_key is the full grain incl. snapshot_date).
-- ============================================================================
{{
  config(
    schema               = 'brain_feature',
    materialized         = 'incremental',
    incremental_strategy = 'default',
    unique_key           = ['brand_id', 'brain_id', 'snapshot_date'],
    table_type           = 'PRIMARY',
    keys                 = ['brand_id', 'brain_id', 'snapshot_date'],
    distributed_by       = ['brand_id'],
    order_by             = ['brand_id', 'brain_id', 'snapshot_date'],
    buckets              = 8,
    properties           = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['silver', 'feature', 'snapshot', 'history']
  )
}}

select
    brand_id,
    brain_id,
    current_date()                                              as snapshot_date,
    currency_code,
    lifetime_orders,
    lifetime_value_minor,
    -- Recency / tenure features (the RFM + churn-label substrate). Integer day counts.
    datediff(current_date(), cast(last_seen_at as date))        as days_since_last_order,
    datediff(current_date(), cast(first_seen_at as date))       as customer_age_days,
    first_seen_at,
    last_seen_at,
    current_timestamp()                                         as computed_at
from {{ ref('silver_customers') }}
