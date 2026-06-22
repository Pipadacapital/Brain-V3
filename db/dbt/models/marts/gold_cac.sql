-- ============================================================================
-- gold_cac — Customer Acquisition Cost components (DB-AUDIT: "CAC was not buildable").
--
-- The audit found CAC had no supporting model — nothing joined ad spend to first-order customers.
-- This mart joins acquisition spend (silver_marketing_spend) to newly-acquired customers
-- (silver_customers.first_seen_at) per brand × acquisition_month × currency.
--
-- ADDITIVE ONLY (ADR-004): exposes new_customers (COUNT) + acquisition_spend_minor (SUM). The CAC
-- RATIO (spend ÷ new_customers, honest-null when new_customers=0) is NON-additive and is derived at
-- read by the metric-engine — never precomputed here.
--
-- READS SILVER ONLY. MONEY = BIGINT minor units paired with currency_code (I-S07). ISOLATION:
-- brand_id is the first key/distribution column; dbt writes all brands (ETL-writer posture),
-- per-brand isolation enforced at the read seam (I-ST01). currency_code is required (PRIMARY-key
-- table → non-null keys); rows with no currency are excluded (cannot be money-paired).
-- ============================================================================
{{
  config(
    schema         = 'brain_gold',
    materialized   = 'table',
    table_type     = 'PRIMARY',
    keys           = ['brand_id', 'acquisition_month', 'currency_code'],
    distributed_by = ['brand_id'],
    order_by       = ['brand_id', 'acquisition_month', 'currency_code'],
    buckets        = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['gold', 'mart', 'marketing']
  )
}}

with new_customers as (

    select
        brand_id,
        date_format(first_seen_at, '%Y-%m')  as acquisition_month,
        currency_code,
        count(*)                             as new_customers
    from {{ ref('silver_customers') }}
    where first_seen_at is not null
      and currency_code is not null
    group by 1, 2, 3

),

spend as (

    select
        brand_id,
        date_format(stat_date, '%Y-%m')      as acquisition_month,
        currency_code,
        sum(spend_minor)                     as acquisition_spend_minor
    from {{ ref('silver_marketing_spend') }}
    where stat_date is not null
      and currency_code is not null
    group by 1, 2, 3

)

select
    coalesce(n.brand_id, s.brand_id)                          as brand_id,
    coalesce(n.acquisition_month, s.acquisition_month)        as acquisition_month,
    coalesce(n.currency_code, s.currency_code)                as currency_code,
    coalesce(n.new_customers, 0)                              as new_customers,
    coalesce(s.acquisition_spend_minor, 0)                    as acquisition_spend_minor,
    current_timestamp()                                       as updated_at
from new_customers n
full outer join spend s
    on  n.brand_id         = s.brand_id
    and n.acquisition_month = s.acquisition_month
    and n.currency_code     = s.currency_code
