-- ============================================================================
-- silver_order_recognition — the revenue RECOGNITION ledger, computed in Silver FROM Bronze.
--
-- MEDALLION REALIGNMENT (Epic 1, decision B): recognition (provisional → finalization / COD-delivery /
-- reversals) is the canonical revenue business-logic. It was computed in the APP TIER (the measurement
-- module) and written to billing.realized_revenue_ledger (PostgreSQL). This model moves that logic
-- into Silver, deriving the SAME recognition events deterministically from the raw Bronze commerce
-- events (which already land via the Bronze bridges):
--   • order.live.v1        (stg_order_events_bronze)  — provisional / prepaid finalization / reversals
--   • gokwik.awb_status.v1 (terminal_class)            — COD delivery recognition / COD RTO clawback
-- Brand recognition horizons come from tenancy.brand (operational config) via the JDBC catalog.
--
-- OUTPUT CONTRACT = the legacy stg_order_ledger_events (so silver_order_state + the 6 marts it feeds
-- re-point to ref('silver_order_recognition') with no other change), after which stg_order_ledger_events
-- (the PG-ledger-sourced staging) is deleted. The PG ledger table itself is removed in a later slice,
-- once the metric-engine revenue readers + the billing seal are migrated off PG.
--
-- MONEY: signed BIGINT minor units, no float (I-S07). Reversals are signed-negative. DETERMINISTIC +
-- REPLAY-SAFE: economic_effective_at of a finalization = occurred_at + horizon (the moment it became
-- final), NOT run-time; eligibility (has the horizon passed) is the only as-of-now predicate.
-- COD vs prepaid is the AUTHORITATIVE payment_method (0097) — COD never finalizes; prepaid never
-- COD-recognizes. brain_id is resolved from the order's pre_hashed_email via the identity graph.
-- ============================================================================
{{
  config(
    materialized = 'view',
    tags         = ['silver', 'staging', 'order', 'revenue', 'recognition']
  )
}}

with orders as (
    select * from {{ ref('stg_order_events_bronze') }}
),

horizons as (
    select brand_id, cod_recognition_horizon_days, prepaid_recognition_horizon_days
    from {{ source('oltp', 'brand_horizons_src') }}
),

-- brain_id from the identity graph: the order's connector pre-hashed email → the resolved customer.
brain as (
    select brand_id, identifier_value as hashed_customer_email, min(brain_id) as brain_id
    from {{ source('oltp', 'identity_link_src') }}
    where identifier_type = 'pre_hashed_email' and is_active = true and brain_id is not null
    group by brand_id, identifier_value
),

-- Latest AWB status per order (COD recognition signal).
awb_raw as (
    select
        brand_id,
        get_json_string(parse_json(payload), '$.properties.order_id')       as order_id,
        get_json_string(parse_json(payload), '$.properties.terminal_class') as terminal_class,
        occurred_at
    from {{ source('bronze_iceberg', 'collector_events') }}
    where event_type = 'gokwik.awb_status.v1'
),
awb_latest as (
    select brand_id, order_id, terminal_class, occurred_at,
           row_number() over (partition by brand_id, order_id order by occurred_at desc) as _rn
    from awb_raw
    where order_id is not null and order_id <> ''
),

-- One enriched canonical order row (with brain_id, horizons, latest AWB).
enriched as (
    select
        o.brand_id, o.order_id, b.brain_id, o.amount_minor, o.currency_code, o.payment_method,
        o.financial_status, o.cancelled_at, o.occurred_at,
        cast(o.ingested_at_raw as datetime) as ingested_at,
        h.prepaid_recognition_horizon_days as prepaid_horizon,
        a.terminal_class as awb_terminal_class
    from orders o
    left join brain b on b.brand_id = o.brand_id and b.hashed_customer_email = o.hashed_customer_email
    left join horizons h on h.brand_id = o.brand_id
    left join awb_latest a on a.brand_id = o.brand_id and a.order_id = o.order_id and a._rn = 1
),

events as (
    -- 1. provisional_recognition — every order (the booking).
    select brand_id, order_id, brain_id, 'provisional_recognition' as event_type,
           amount_minor, currency_code, occurred_at, occurred_at as economic_effective_at, ingested_at
    from enriched

    union all
    -- 2. finalization — PREPAID only, past the prepaid horizon, not reversed.
    select brand_id, order_id, brain_id, 'finalization' as event_type,
           amount_minor, currency_code, occurred_at,
           date_add(occurred_at, interval prepaid_horizon day) as economic_effective_at, ingested_at
    from enriched
    where payment_method = 'prepaid'
      and date_add(occurred_at, interval coalesce(prepaid_horizon, 7) day) < current_timestamp()
      and cancelled_at is null
      and coalesce(financial_status, '') not in ('refunded', 'voided', 'cancelled')

    union all
    -- 3. cod_delivery_confirmed — COD recognized on terminal delivery.
    select brand_id, order_id, brain_id, 'cod_delivery_confirmed' as event_type,
           amount_minor, currency_code, occurred_at, occurred_at as economic_effective_at, ingested_at
    from enriched
    where payment_method = 'cod' and awb_terminal_class = 'delivered'

    union all
    -- 4. cod_rto_clawback — COD returned (RTO): signed-negative.
    select brand_id, order_id, brain_id, 'cod_rto_clawback' as event_type,
           -amount_minor as amount_minor, currency_code, occurred_at, occurred_at as economic_effective_at, ingested_at
    from enriched
    where payment_method = 'cod' and awb_terminal_class = 'rto'

    union all
    -- 5. cancellation — order cancelled: signed-negative.
    select brand_id, order_id, brain_id, 'cancellation' as event_type,
           -amount_minor as amount_minor, currency_code, occurred_at, occurred_at as economic_effective_at, ingested_at
    from enriched
    where cancelled_at is not null

    union all
    -- 6. refund — refunded (and not already counted as a cancellation): signed-negative.
    select brand_id, order_id, brain_id, 'refund' as event_type,
           -amount_minor as amount_minor, currency_code, occurred_at, occurred_at as economic_effective_at, ingested_at
    from enriched
    where coalesce(financial_status, '') = 'refunded' and cancelled_at is null
)

select
    brand_id,
    order_id,
    brain_id,
    event_type,
    cast(amount_minor as bigint) as amount_minor,
    currency_code,
    occurred_at,
    economic_effective_at,
    ingested_at
from events
