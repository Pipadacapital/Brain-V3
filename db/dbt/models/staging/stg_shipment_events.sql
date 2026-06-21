-- ============================================================================
-- stg_shipment_events — typed, deduped projection of logistics shipment Bronze events.
-- feat-logistics-silver-courier-rto (Slice 2). Materialization: view.
--
-- GRAIN: 1 row per shipment-transition Bronze event, deduped on the Bronze idempotency key
--        (brand_id, event_id). MULTI-SOURCE by design — the shared logistics canonical surface:
--          - gokwik.awb_status.v1        (GoKwik AWB feed)
--          - shiprocket.shipment_status.v1 (Shiprocket tracking — lands once that connector merges)
--        Both mappers emit the SAME properties shape (source, order_id, awb_number_hash, status,
--        terminal_class, is_terminal, payment_method, pincode, courier) classified by the shared
--        @brain/logistics-status authority — so this one staging model normalizes both.
--
-- terminal_class is the deterministic authority (rto|delivered|other|none); is_terminal is derived
-- from it here (never trust a raw JSON bool). courier is NULL for sources that don't carry it (GoKwik).
--
-- READ SOURCE: the raw Iceberg Bronze (bronze_iceberg.collector_events) — the operational read path
-- (Iceberg-sole SoR). The per-event-type filter is applied here.
-- REPLAY-SAFE: pure deterministic projection — re-run yields identical rows.
-- ============================================================================
{{
  config(
    materialized = 'view',
    tags         = ['silver', 'staging', 'shipment']
  )
}}

with raw as (

    select
        brand_id,
        event_id,
        event_type,
        occurred_at,
        parse_json(payload) as pj
    from {{ source('bronze_iceberg', 'collector_events') }}
    where event_type in ('gokwik.awb_status.v1', 'shiprocket.shipment_status.v1')

),

source as (

    select
        brand_id,
        event_id,
        event_type,
        occurred_at,
        get_json_string(pj, '$.properties.source')          as source,
        get_json_string(pj, '$.properties.order_id')         as order_id,
        get_json_string(pj, '$.properties.awb_number_hash')  as awb_number_hash,
        get_json_string(pj, '$.properties.status')           as status,
        get_json_string(pj, '$.properties.terminal_class')   as terminal_class,
        get_json_string(pj, '$.properties.payment_method')   as payment_method,
        get_json_string(pj, '$.properties.pincode')          as pincode,
        get_json_string(pj, '$.properties.courier')          as courier,
        get_json_string(pj, '$.properties.status_changed_at') as status_changed_at,
        case when get_json_string(pj, '$.properties.data_source') = 'synthetic'
             then true else false end                        as is_synthetic
    from raw

),

-- Must have an order_id (the ledger/journey spine key) to be useful for the shipment marts.
keyed as (

    select * from source
    where order_id is not null and order_id <> ''

),

deduped as (

    select
        *,
        row_number() over (
            partition by brand_id, event_id
            order by occurred_at asc
        ) as _dedup_rn
    from keyed

)

select
    brand_id,
    event_id,
    event_type,
    source,
    order_id,
    awb_number_hash,
    status,
    coalesce(terminal_class, 'none')          as terminal_class,
    (coalesce(terminal_class, 'none') <> 'none') as is_terminal,
    payment_method,
    pincode,
    courier,
    coalesce(status_changed_at, cast(occurred_at as string)) as status_changed_at,
    occurred_at,
    is_synthetic
from deduped
where _dedup_rn = 1
