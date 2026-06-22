-- ============================================================================
-- silver_customers — the canonical CUSTOMER entity (re-platform Phase D/E).
--
-- One row per resolved customer (brand_id, brain_id) — the customer entity the spec lists under
-- Silver. brain_id is the identity-resolved key (minted by the identity graph / @brain/identity-graph
-- on Neo4j; stamped onto orders upstream). This mart is the customer spine that gold_customer_360 and
-- the segmentation/cohort Gold marts join to.
--
-- Derived from silver_order_state (the order spine) — additive projection (counts + sums + min/max
-- timestamps), no non-additive ratios (ADR-004). MONEY = BIGINT minor units (I-S07). Unlinked orders
-- (brain_id null) are excluded — they are not yet a known customer.
-- ISOLATION: brand_id first key; per-brand isolation at the read seam (I-ST01).
-- ============================================================================
{{
  config(
    materialized   = 'table',
    table_type     = 'PRIMARY',
    keys           = ['brand_id', 'brain_id'],
    distributed_by = ['brand_id', 'brain_id'],
    order_by       = ['brand_id', 'brain_id'],
    buckets        = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['silver', 'mart', 'customers']
  )
}}

with order_rollup as (
    select
        brand_id,
        brain_id,
        count(order_id)                          as lifetime_orders,
        cast(sum(order_value_minor) as bigint)   as lifetime_value_minor,
        max(currency_code)                       as currency_code,
        min(first_event_at)                      as first_seen_at,
        max(state_effective_at)                  as last_seen_at
    from {{ ref('silver_order_state') }}
    where brain_id is not null
    group by brand_id, brain_id
),

-- H6: acquisition time (first strong-identifier attach) from the identity graph. LEFT JOIN so a
-- customer with orders but no resolved identity row still appears (first_identified_at NULL).
identity_node as (
    select brand_id, brain_id, first_identified_at
    from {{ source('oltp', 'silver_customer_identity_src') }}
    where lifecycle_state <> 'merged'
)

select
    o.brand_id,
    o.brain_id,
    o.lifetime_orders,
    o.lifetime_value_minor,
    o.currency_code,
    o.first_seen_at,
    i.first_identified_at,
    o.last_seen_at,
    current_timestamp()                      as updated_at
from order_rollup o
left join identity_node i
    on o.brand_id = i.brand_id and o.brain_id = i.brain_id
