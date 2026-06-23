-- ============================================================================
-- stg_order_events_bronze — canonical order staging read DIRECTLY from Iceberg Bronze.
--
-- MEDALLION REALIGNMENT (Epic 1, decision B): the canonical order/revenue entity must be built from
-- Bronze (the raw source), NOT from the PostgreSQL realized_revenue_ledger (an app-tier-computed copy).
-- The raw order events already land in Bronze via the live-order Bronze bridge:
--   brain_bronze.collector_events WHERE event_type = 'order.live.v1'
-- (verified: 999 rows). Every field recognition needs is in payload.properties — no PG read required.
--
-- This staging is the FOUNDATION the new silver_order_recognition (provisional / finalization / COD /
-- reversal) is built on; gold_revenue_ledger + silver_order_state will be cut over to read it, after
-- which the PG ledger + the app-tier measurement writers are deleted.
--
-- GRAIN: 1 row per order.live.v1 Bronze event, deduped on the Bronze idempotency key (brand_id,
--   event_id). REPLAY-SAFE: pure deterministic projection. DEV BOUNDARY: reads Bronze as the ETL
--   writer (cross-brand); isolation is enforced at the Silver READ seam, not here.
-- ============================================================================
{{
  config(
    materialized = 'view',
    tags         = ['silver', 'staging', 'order', 'revenue']
  )
}}

with raw as (

    select
        brand_id,
        event_id,
        occurred_at,
        parse_json(payload) as pj
    from {{ source('bronze_iceberg', 'collector_events') }}
    where event_type = 'order.live.v1'

),

typed as (

    select
        brand_id,
        event_id,
        occurred_at,
        get_json_string(pj, '$.properties.order_id')                as order_id,
        get_json_string(pj, '$.properties.source')                  as source,
        cast(get_json_string(pj, '$.properties.amount_minor') as bigint)         as amount_minor,
        get_json_string(pj, '$.properties.currency_code')           as currency_code,
        lower(get_json_string(pj, '$.properties.payment_method'))   as payment_method,
        get_json_string(pj, '$.properties.financial_status')        as financial_status,
        get_json_string(pj, '$.properties.fulfillment_status')      as fulfillment_status,
        get_json_string(pj, '$.properties.cancelled_at')            as cancelled_at,
        -- Identity bridge keys (NO raw PII): connector-prehashed email + storefront customer id.
        get_json_string(pj, '$.properties.hashed_customer_email')   as hashed_customer_email,
        get_json_string(pj, '$.properties.storefront_customer_id')  as storefront_customer_id,
        cast(get_json_string(pj, '$.properties.tax_total_minor') as bigint)      as tax_total_minor,
        cast(get_json_string(pj, '$.properties.shipping_total_minor') as bigint) as shipping_total_minor,
        cast(get_json_string(pj, '$.properties.discount_total_minor') as bigint) as discount_total_minor,
        -- ingested_at carried for incremental watermarking downstream (mirrors the ledger contract).
        get_json_string(pj, '$.ingested_at')                        as ingested_at_raw
    from raw

),

deduped as (

    -- CANONICAL ORDER GRAIN = (brand_id, order_id). A repull re-emits the SAME order with a NEW
    -- event_id each run, so we must collapse to ONE row per order — the LATEST version (most recently
    -- ingested wins; occurred_at is the deterministic tiebreak). Deduping per event_id (the Bronze
    -- idempotency key) would keep every repull copy and over-count the order set.
    select
        *,
        row_number() over (
            partition by brand_id, order_id
            order by ingested_at_raw desc, occurred_at desc, event_id desc
        ) as _dedup_rn
    from typed
    -- Drop malformed events with no order_id (cannot be a canonical order).
    where order_id is not null and order_id <> ''

)

select
    brand_id,
    event_id,
    order_id,
    source,
    amount_minor,
    currency_code,
    -- Normalize payment_method to the canonical {cod, prepaid} (anything non-cod → prepaid).
    case when payment_method = 'cod' then 'cod' else 'prepaid' end as payment_method,
    financial_status,
    fulfillment_status,
    cancelled_at,
    hashed_customer_email,
    storefront_customer_id,
    tax_total_minor,
    shipping_total_minor,
    discount_total_minor,
    occurred_at,
    occurred_at as economic_effective_at,  -- provisional: economic_effective_at = occurred_at (dual-date)
    ingested_at_raw
from deduped
where _dedup_rn = 1
