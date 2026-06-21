-- ============================================================================
-- gold_revenue_analytics — the FIRST Gold serving mart (re-platform Phase E).
--
-- Brain's business-data platform serves brain_gold as denormalized, query-ready datasets the
-- dashboards read. This mart is realized revenue + order counts rolled up by month × lifecycle ×
-- currency, per brand — the executive/revenue dashboard's drill source.
--
-- ADDITIVE ONLY (ADR-004): COUNT(orders) + SUM(realized value) are additive aggregates over Silver.
-- Non-additive ratios (AOV, RTO%, growth) are NOT computed here — they remain the metric-engine's job
-- (the sole emitter of registry KPIs). Gold holds the additive components; ratios are derived at read.
--
-- READS SILVER ONLY (silver_order_state) — never Bronze, never a connector. MONEY = BIGINT minor
-- units paired with currency_code (I-S07). ISOLATION: brand_id is the first key/distribution column;
-- dbt writes all brands (ETL-writer posture), per-brand isolation enforced at the read seam (I-ST01).
-- ============================================================================
{{
  config(
    schema         = 'brain_gold',
    materialized   = 'table',
    table_type     = 'PRIMARY',
    keys           = ['brand_id', 'period_month', 'lifecycle_state', 'currency_code'],
    distributed_by = ['brand_id'],
    order_by       = ['brand_id', 'period_month', 'lifecycle_state', 'currency_code'],
    buckets        = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['gold', 'mart', 'revenue']
  )
}}

with orders as (

    select * from {{ ref('silver_order_state') }}

)

select
    brand_id,
    date_format(state_effective_at, '%Y-%m')          as period_month,
    lifecycle_state,
    currency_code,
    count(order_id)                                   as order_count,
    cast(sum(order_value_minor) as bigint)            as realized_value_minor,
    -- additive helper: terminal orders in the cohort (denominator components stay additive)
    cast(sum(case when is_terminal then 1 else 0 end) as bigint) as terminal_order_count,
    current_timestamp()                               as updated_at
from orders
where currency_code is not null
group by
    brand_id,
    date_format(state_effective_at, '%Y-%m'),
    lifecycle_state,
    currency_code
