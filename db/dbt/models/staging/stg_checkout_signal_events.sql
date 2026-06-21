-- ============================================================================
-- stg_checkout_signal_events — typed, deduped projection of payments/checkout SIGNAL Bronze events.
-- feat-payments-checkout-silver (payments-category Silver normalizer). Materialization: view.
--
-- GRAIN: 1 row per signal Bronze event, deduped on the Bronze idempotency key (brand_id, event_id).
--        MULTI-SOURCE by design — the shared payments-checkout-signal canonical surface:
--          - gokwik.rto_predict.v1        (GoKwik RTO-Predict — categorical risk_flag per order)
--          - shopflo.checkout_abandoned.v1 (Shopflo abandoned-checkout — recoverable GMV at risk)
--        Reserved seams (add the event_type to the filter + a signal_type when partner access lands):
--          - gokwik.checkout_abandoned.v1 / gokwik.otp_verification.v1 (Tier-B/C, partner-gated)
--
-- signal_type is the deterministic discriminant ('rto_predict' | 'checkout_abandoned'); per-signal
-- columns are NULL for the other signal (risk_flag only for rto_predict; the money/address fields only
-- for checkout_abandoned). risk_flag carries the mapper's NORMALIZED closed set
-- (high|medium|low|control|unknown) — never a fabricated number.
--
-- READ SOURCE: the raw Iceberg Bronze (bronze_iceberg.collector_events) — the operational read path
-- (Iceberg-sole SoR). The per-event-type filter is applied here.
-- REPLAY-SAFE: pure deterministic projection — re-run yields identical rows.
-- ============================================================================
{{
  config(
    materialized = 'view',
    tags         = ['silver', 'staging', 'checkout', 'payments']
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
    where event_type in ('gokwik.rto_predict.v1', 'shopflo.checkout_abandoned.v1')

),

typed as (

    select
        brand_id,
        event_id,
        event_type,
        occurred_at,
        case event_type
            when 'gokwik.rto_predict.v1'         then 'rto_predict'
            when 'shopflo.checkout_abandoned.v1' then 'checkout_abandoned'
        end                                                  as signal_type,
        case event_type
            when 'gokwik.rto_predict.v1'         then 'gokwik'
            when 'shopflo.checkout_abandoned.v1' then 'shopflo'
        end                                                  as source,
        get_json_string(pj, '$.properties.order_id')         as order_id,
        -- rto_predict: normalized categorical risk band (NULL for checkout rows)
        get_json_string(pj, '$.properties.risk_flag')        as risk_flag,
        -- checkout_abandoned money (minor units, BIGINT) + address flag (NULL for rto rows)
        cast(get_json_string(pj, '$.properties.total_price_minor')    as bigint) as total_price_minor,
        cast(get_json_string(pj, '$.properties.total_discount_minor') as bigint) as total_discount_minor,
        case when get_json_string(pj, '$.properties.has_address') = 'true' then true else false end as has_address,
        get_json_string(pj, '$.properties.currency_code')    as currency_code,
        case when get_json_string(pj, '$.properties.data_source') = 'synthetic'
             then true else false end                        as is_synthetic
    from raw

),

deduped as (

    select
        *,
        row_number() over (
            partition by brand_id, event_id
            order by occurred_at asc
        ) as _dedup_rn
    from typed

)

select
    brand_id,
    event_id,
    event_type,
    signal_type,
    source,
    order_id,
    risk_flag,
    total_price_minor,
    total_discount_minor,
    has_address,
    currency_code,
    occurred_at,
    is_synthetic
from deduped
where _dedup_rn = 1
