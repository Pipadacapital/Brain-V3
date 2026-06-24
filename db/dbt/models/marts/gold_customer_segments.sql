-- ============================================================================
-- gold_customer_segments — deterministic value-tier customer segments (re-platform Phase E, brain_gold).
-- One row per (brand_id, segment): customer_count + total value per tier. Deterministic CASE bucketing
-- (NOT ML — ML/propensity segments come from the feature layer, Phase F). Additive. Reads silver_customer.
-- ============================================================================
{{
  config(
    schema = 'brain_gold', materialized = 'table', table_type = 'PRIMARY',
    keys = ['brand_id', 'segment'],
    distributed_by = ['brand_id'], order_by = ['brand_id', 'segment'], buckets = 4,
    properties = {'replication_num': '1', 'enable_persistent_index': 'true', 'compression': 'LZ4'},
    tags = ['gold', 'mart', 'segments']
  )
}}

with segmented as (
    select
        brand_id,
        brain_id,
        lifetime_value_minor,
        case
            when lifetime_value_minor >= 100000 then 'high_value'
            when lifetime_value_minor >= 50000  then 'mid_value'
            when lifetime_value_minor > 0       then 'low_value'
            else 'no_realized_value'
        end as segment
    from {{ ref('silver_customer') }}
)

select
    brand_id,
    segment,
    cast(count(*) as bigint)                   as customer_count,
    cast(sum(lifetime_value_minor) as bigint)  as segment_value_minor,
    current_timestamp()                        as updated_at
from segmented
group by brand_id, segment
