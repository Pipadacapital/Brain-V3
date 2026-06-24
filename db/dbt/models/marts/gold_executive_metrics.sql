-- ============================================================================
-- gold_executive_metrics — brand-level executive KPI rollup (re-platform Phase E, brain_gold).
--
-- The executive dashboard's headline source: one row per (brand_id, currency_code) with the additive
-- COMPONENTS of the headline KPIs — realized revenue, order counts by lifecycle, distinct customers.
-- ADDITIVE ONLY (ADR-004): non-additive ratios (AOV = revenue/orders, RTO% = rto/terminal) are derived
-- at read by the metric-engine, NOT stored here. Reads Silver only. MONEY = BIGINT minor units (I-S07).
-- ============================================================================
{{
  config(
    schema         = 'brain_gold',
    materialized   = 'table',
    table_type     = 'PRIMARY',
    keys           = ['brand_id', 'currency_code'],
    distributed_by = ['brand_id'],
    order_by       = ['brand_id', 'currency_code'],
    buckets        = 4,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['gold', 'mart', 'executive']
  )
}}

select
    brand_id,
    currency_code,
    count(order_id)                                                       as total_orders,
    cast(sum(order_value_minor) as bigint)                               as realized_value_minor,
    cast(count(distinct brain_id) as bigint)                            as distinct_customers,
    cast(sum(case when is_terminal then 1 else 0 end) as bigint)         as terminal_orders,
    cast(sum(case when lifecycle_state = 'delivered' then 1 else 0 end) as bigint) as delivered_orders,
    cast(sum(case when lifecycle_state = 'rto'       then 1 else 0 end) as bigint) as rto_orders,
    cast(sum(case when lifecycle_state = 'cancelled' then 1 else 0 end) as bigint) as cancelled_orders,
    cast(sum(case when lifecycle_state = 'refunded'  then 1 else 0 end) as bigint) as refunded_orders,
    cast('live' as varchar(16))                        as data_source,  -- MK-1: real builds = live; demo seed overwrites to 'synthetic'
    current_timestamp()                                                  as updated_at
from {{ ref('silver_order_state') }}
where currency_code is not null
group by brand_id, currency_code
