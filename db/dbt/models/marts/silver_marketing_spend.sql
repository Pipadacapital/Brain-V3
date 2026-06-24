-- ============================================================================
-- silver_marketing_spend — ad spend as a connector-agnostic Silver ENTITY (re-platform Phase G).
--
-- MEDALLION REALIGNMENT (AV-1 / MV-1): this mart now builds FROM Bronze (stg_ad_spend_bronze, which
-- reads brain_bronze.collector_events WHERE event_type='spend.live.v1'), NOT from the PostgreSQL
-- ad_spend_ledger via a JDBC read-shim. Bronze is the analytical source of truth; the PG ledger
-- remains the operational WRITE SoR (billing/invoicing — the spend repull jobs still append there).
-- The marketing metric-engine reads (ad-spend-timeseries, channel-roas, blended-roas) + the CM2
-- recommendation detector read here via withSilverBrand so PostgreSQL is no longer a spend READ source.
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
from {{ ref('stg_ad_spend_bronze') }}
where spend_event_id is not null
