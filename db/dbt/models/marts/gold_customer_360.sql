-- ============================================================================
-- gold_customer_360 — the Customer 360 serving mart (re-platform Phase E, brain_gold).
--
-- The flagship denormalized per-customer view the Customer dashboard reads: one row per
-- (brand_id, brain_id) with lifetime value + order counts + a lifecycle breakdown (delivered / rto /
-- cancelled). Joins silver_customer (the customer spine) to a per-customer lifecycle rollup of
-- silver_order_state. ADDITIVE components only (ADR-004) — churn/LTV/segment SCORES come from the
-- feature layer (Phase F), not here. MONEY = BIGINT minor units (I-S07).
-- ============================================================================
{{
  config(
    schema               = 'brain_gold',
    materialized         = 'incremental',
    incremental_strategy = 'default',
    on_schema_change     = 'append_new_columns',
    unique_key           = ['brand_id', 'brain_id'],
    table_type           = 'PRIMARY',
    keys                 = ['brand_id', 'brain_id'],
    distributed_by       = ['brand_id', 'brain_id'],
    order_by             = ['brand_id', 'brain_id'],
    buckets              = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['gold', 'mart', 'customer_360']
  )
}}

-- H4 — INCREMENTAL RESTATEMENT, per-customer grain (safe dirty-key upsert). Only customers whose
-- silver_customer row was restated since the last run (newer customer_watermark = ingestion time)
-- are re-built and upserted by (brand_id, brain_id); untouched customers keep their row. on_schema_change
-- =append_new_columns avoids the StarRocks DROP COLUMN cascade. First run / no-new-orders behave like
-- silver_order_state (full build / no-op idempotent).
{% if is_incremental() %}
with customers as (
    select * from {{ ref('silver_customer') }}
    where customer_watermark > (
        select coalesce(max(customer_watermark), cast('1970-01-01 00:00:00' as datetime)) from {{ this }}
    )
),
{% else %}
with customers as (
    select * from {{ ref('silver_customer') }}
),
{% endif %}

lifecycle as (
    select
        brand_id,
        brain_id,
        cast(sum(case when lifecycle_state = 'delivered' then 1 else 0 end) as bigint) as delivered_orders,
        cast(sum(case when lifecycle_state = 'rto'       then 1 else 0 end) as bigint) as rto_orders,
        cast(sum(case when lifecycle_state = 'cancelled' then 1 else 0 end) as bigint) as cancelled_orders,
        cast(sum(case when lifecycle_state = 'refunded'  then 1 else 0 end) as bigint) as refunded_orders
    from {{ ref('silver_order_state') }}
    where brain_id is not null
    group by brand_id, brain_id
)

select
    c.brand_id,
    c.brain_id,
    c.lifetime_orders,
    c.lifetime_value_minor,
    c.currency_code,
    c.first_seen_at,
    c.first_identified_at,
    c.last_seen_at,
    coalesce(l.delivered_orders, 0) as delivered_orders,
    coalesce(l.rto_orders, 0)       as rto_orders,
    coalesce(l.cancelled_orders, 0) as cancelled_orders,
    coalesce(l.refunded_orders, 0)  as refunded_orders,
    c.customer_watermark,
    current_timestamp()             as updated_at
from customers c
left join lifecycle l
    on c.brand_id = l.brand_id and c.brain_id = l.brain_id
