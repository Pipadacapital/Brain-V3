-- ============================================================================
-- snap_attribution_credit — daily attribution-result history snapshot (DB-AUDIT C3/H6 F8:
-- "attribution results are not re-stated/versioned — you can't reproduce what a dashboard showed
-- last month, nor compare model versions historically").
--
-- gold_marketing_attribution holds only the CURRENT credit picture. This INCREMENTAL, append-per-day
-- snapshot captures the credit-as-of each date, keyed (brand_id, credit_id, snapshot_date) — so
-- attribution can be reproduced as-of a report date and compared across model versions over time.
-- Prior days preserved; same-day re-run idempotent (PRIMARY-key upsert on the grain).
--
-- Completes the history layer (order-state ✓ snap_order_state, customer ✓ feature_customer_daily,
-- attribution + here). Populates once attribution flows (journey-stitch + reconcile on finalized
-- orders); structurally complete + ready. MONEY = BIGINT minor units + currency_code (I-S07).
-- ISOLATION: brand_id first key/dist column; per-brand at the read seam (I-ST01).
-- ============================================================================
{{
  config(
    schema               = 'brain_silver',
    materialized         = 'incremental',
    incremental_strategy = 'default',
    on_schema_change     = 'append_new_columns',
    unique_key           = ['brand_id', 'credit_id', 'snapshot_date'],
    table_type           = 'PRIMARY',
    keys                 = ['brand_id', 'credit_id', 'snapshot_date'],
    distributed_by       = ['brand_id'],
    order_by             = ['brand_id', 'credit_id', 'snapshot_date'],
    buckets              = 8,
    properties           = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['silver', 'snapshot', 'history', 'attribution']
  )
}}

select
    brand_id,
    credit_id,
    current_date()             as snapshot_date,
    order_id,
    channel,
    campaign_id,
    model_id,
    model_version,
    row_kind,
    credited_revenue_minor,
    currency_code,
    confidence_grade,
    occurred_at,
    current_timestamp()        as computed_at
from {{ ref('gold_marketing_attribution') }}
