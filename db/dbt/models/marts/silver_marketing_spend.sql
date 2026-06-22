-- ============================================================================
-- silver_marketing_spend — ad spend as a connector-agnostic Silver ENTITY (re-platform Phase G).
--
-- Phase G moves business data OUT of Postgres. This StarRocks Silver mart is the lakehouse copy of
-- ad_spend_ledger (sourced via the JDBC read-shim during transition; rebuilds from Bronze in prod).
-- The marketing metric-engine reads (ad-spend-timeseries, channel-roas, blended-roas) re-point here
-- via withSilverBrand so PostgreSQL stops being a read source for spend. PG remains the WRITE SoR
-- until a later cutover (the spend repull jobs still append there); this mart is a derived projection.
--
-- Connector-agnostic by entity: the column is `platform` (meta | google_ads | …), never a connector
-- name in the table name. MONEY = BIGINT minor units (I-S07). ISOLATION: brand_id first key; per-brand
-- at the read seam (I-ST01). dbt writes all brands (ETL-writer posture). Grain = (brand_id, spend_event_id).
-- ============================================================================
{{
  config(
    materialized   = 'table',
    table_type     = 'PRIMARY',
    keys           = ['brand_id', 'spend_event_id'],
    distributed_by = ['brand_id'],
    order_by       = ['brand_id', 'stat_date', 'platform'],
    buckets        = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['silver', 'mart', 'marketing']
  )
}}

select
    brand_id,
    spend_event_id,
    platform,
    level,
    level_id,
    parent_id,
    campaign_id,
    campaign_name,
    cast(stat_date as date)                  as stat_date,
    cast(spend_minor as bigint)              as spend_minor,
    currency_code,
    cast(coalesce(impressions, 0) as bigint) as impressions,
    cast(coalesce(clicks, 0) as bigint)      as clicks,
    account_timezone,
    occurred_at,
    current_timestamp()                      as updated_at
from {{ source('oltp', 'ad_spend_ledger') }}
where spend_event_id is not null
