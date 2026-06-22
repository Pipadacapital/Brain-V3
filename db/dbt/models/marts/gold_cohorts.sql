-- ============================================================================
-- gold_cohorts — acquisition cohorts (re-platform Phase E, brain_gold).
-- One row per (brand_id, cohort_month, currency_code): customers first seen in that month + their
-- lifetime value/orders. Additive (ADR-004) — retention ratios derived at read. Reads silver_customers.
-- ============================================================================
{{
  config(
    schema = 'brain_gold', materialized = 'table', table_type = 'PRIMARY',
    keys = ['brand_id', 'cohort_month', 'currency_code'],
    distributed_by = ['brand_id'], order_by = ['brand_id', 'cohort_month'], buckets = 4,
    properties = {'replication_num': '1', 'enable_persistent_index': 'true', 'compression': 'LZ4'},
    tags = ['gold', 'mart', 'cohorts']
  )
}}

select
    brand_id,
    date_format(first_seen_at, '%Y-%m')        as cohort_month,
    max(currency_code)                         as currency_code,
    cast(count(*) as bigint)                   as cohort_size,
    cast(sum(lifetime_value_minor) as bigint)  as cohort_value_minor,
    cast(sum(lifetime_orders) as bigint)       as cohort_orders,
    current_timestamp()                        as updated_at
from {{ ref('silver_customers') }}
where first_seen_at is not null
group by brand_id, date_format(first_seen_at, '%Y-%m')
