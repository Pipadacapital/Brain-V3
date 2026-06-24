-- ============================================================================
-- stg_ad_spend_bronze — ad-spend staging read DIRECTLY from Iceberg Bronze.
--
-- MEDALLION REALIGNMENT (AV-1 / MV-1): the connector-agnostic spend entity must be built from Bronze
-- (the raw source), NOT from the PostgreSQL ad_spend_ledger (an app-tier-written ledger) via a JDBC
-- read-shim. spend.live.v1 now lands in Bronze via the server-trusted spend bridge (the Spark sink —
-- bronze_materialize.py SERVER_TRUSTED_BRONZE), with a server-derived brand_id (MT-1):
--   brain_bronze.collector_events WHERE event_type = 'spend.live.v1'
-- Every field silver_marketing_spend needs is in payload.properties (the @brain/ad-spend-mapper
-- SpendEventProperties allowlist) — no PG read required. PG ad_spend_ledger stays the operational
-- WRITE SoR (billing/invoicing); only the ANALYTICAL source moves to Bronze.
--
-- GRAIN: 1 row per (brand_id, spend_event_id). spend_event_id IS the Bronze event_id — the mapper
--   seeds it deterministically (uuidV5FromSpendRow over platform/stat_date/level/level_id, ADR-AD-5),
--   so a trailing re-pull re-emits the SAME spend row with the SAME event_id → we keep the latest
--   ingested version (mirrors stg_order_events_bronze's repull dedup). Money is BIGINT minor units
--   (I-S07). REPLAY-SAFE: pure deterministic projection. DEV BOUNDARY: reads Bronze as the ETL writer
--   (cross-brand); isolation is enforced at the Silver READ seam, not here.
-- ============================================================================
{{
  config(
    materialized = 'view',
    tags         = ['silver', 'staging', 'marketing', 'spend']
  )
}}

with raw as (

    select
        brand_id,
        event_id,
        occurred_at,
        ingested_at,
        parse_json(payload) as pj
    from {{ source('bronze_iceberg', 'collector_events') }}
    where event_type = 'spend.live.v1'

),

typed as (

    select
        brand_id,
        -- spend_event_id == the Bronze idempotency key (the mapper seeds event_id from the spend grain).
        event_id                                                       as spend_event_id,
        get_json_string(pj, '$.properties.platform')                   as platform,
        get_json_string(pj, '$.properties.level')                      as level,
        get_json_string(pj, '$.properties.level_id')                   as level_id,
        get_json_string(pj, '$.properties.parent_id')                  as parent_id,
        get_json_string(pj, '$.properties.campaign_id')                as campaign_id,
        get_json_string(pj, '$.properties.campaign_name')              as campaign_name,
        get_json_string(pj, '$.properties.stat_date')                  as stat_date,
        cast(get_json_string(pj, '$.properties.spend_minor') as bigint) as spend_minor,
        get_json_string(pj, '$.properties.currency_code')              as currency_code,
        cast(get_json_string(pj, '$.properties.impressions') as bigint) as impressions,
        cast(get_json_string(pj, '$.properties.clicks') as bigint)      as clicks,
        get_json_string(pj, '$.properties.account_timezone')           as account_timezone,
        occurred_at,
        ingested_at
    from raw

),

deduped as (

    -- CANONICAL SPEND GRAIN = (brand_id, spend_event_id). A trailing re-pull re-emits the SAME spend
    -- row with the SAME event_id (ADR-AD-5 deterministic seed) — keep the LATEST ingested version
    -- (occurred_at as deterministic tiebreak). Mirrors stg_order_events_bronze's repull dedup.
    select
        *,
        row_number() over (
            partition by brand_id, spend_event_id
            order by ingested_at desc, occurred_at desc
        ) as _dedup_rn
    from typed
    -- Drop malformed events with no spend_event_id (cannot be a canonical spend row).
    where spend_event_id is not null and spend_event_id <> ''

)

select
    brand_id,
    spend_event_id,
    platform,
    level,
    level_id,
    parent_id,
    campaign_id,
    campaign_name,
    stat_date,
    spend_minor,
    currency_code,
    impressions,
    clicks,
    account_timezone,
    occurred_at
from deduped
where _dedup_rn = 1
