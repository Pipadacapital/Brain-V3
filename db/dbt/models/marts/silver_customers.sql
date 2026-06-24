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
    tags = ['silver', 'mart', 'customers']
  )
}}

-- H4 — INCREMENTAL RESTATEMENT with an INGESTION-TIME watermark (mirrors silver_order_state's proven
-- dirty-key fold). On an incremental run we re-aggregate ONLY customers whose underlying order rows
-- received a newly-ingested ledger event since the last run (dirty set), then re-fold each dirty
-- customer's FULL order history (a lifetime total must restate when a new order lands) and upsert by
-- (brand_id, brain_id) into the PRIMARY KEY table; untouched customers keep their row. Watermark =
-- silver_order_state.max_ingested_at (ingestion time, so a backdated economic event is never missed).
-- on_schema_change=append_new_columns avoids the StarRocks DROP COLUMN cascade. First run (table absent)
-- folds everything (full build). Re-run with no new orders → empty dirty set → no-op (idempotent).
{% if is_incremental() %}
with dirty_customers as (
    select distinct brand_id, brain_id
    from {{ ref('silver_order_state') }}
    where brain_id is not null
      and max_ingested_at > (
        select coalesce(max(customer_watermark), cast('1970-01-01 00:00:00' as datetime)) from {{ this }}
      )
),
order_rollup as (
    select
        s.brand_id,
        s.brain_id,
        count(s.order_id)                          as lifetime_orders,
        cast(sum(s.order_value_minor) as bigint)   as lifetime_value_minor,
        max(s.currency_code)                       as currency_code,
        min(s.first_event_at)                      as first_seen_at,
        max(s.state_effective_at)                  as last_seen_at,
        max(s.max_ingested_at)                     as customer_watermark
    from {{ ref('silver_order_state') }} s
    join dirty_customers d
      on s.brand_id = d.brand_id and s.brain_id = d.brain_id
    where s.brain_id is not null
    group by s.brand_id, s.brain_id
),
{% else %}
with order_rollup as (
    select
        brand_id,
        brain_id,
        count(order_id)                          as lifetime_orders,
        cast(sum(order_value_minor) as bigint)   as lifetime_value_minor,
        max(currency_code)                       as currency_code,
        min(first_event_at)                      as first_seen_at,
        max(state_effective_at)                  as last_seen_at,
        max(max_ingested_at)                     as customer_watermark
    from {{ ref('silver_order_state') }}
    where brain_id is not null
    group by brand_id, brain_id
),
{% endif %}

-- H6: acquisition time (first strong-identifier attach) from the identity graph. LEFT JOIN so a
-- customer with orders but no resolved identity row still appears (first_identified_at NULL).
-- MEDALLION REALIGNMENT (Epic 3/4): identity is the Neo4j SoR; read the customer-identity projection
-- (identity-export → brain_silver.silver_customer_identity), not the dropped PG identity.customer shim.
identity_node as (
    select brand_id, brain_id, first_identified_at
    from brain_silver.silver_customer_identity
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
    o.customer_watermark,
    current_timestamp()                      as updated_at
from order_rollup o
left join identity_node i
    on o.brand_id = i.brand_id and o.brain_id = i.brain_id
