-- ============================================================================
-- stg_order_ledger_events — 1:1 staging read of order-lifecycle ledger events + dedup.
-- feat-silver-tier-order-state (Stage 3, @data-engineer). Materialization: view.
--
-- GRAIN: 1 row per lifecycle-relevant ledger event, deduped on the 0018 natural key
--        (brand_id, order_id, event_type, occurred_at::date) — mirrors the Postgres
--        UNIQUE INDEX realized_revenue_ledger_dedup. NO business math here (that is
--        intermediate's job); this is a typed, deduped projection of the source.
--
-- DEV BOUNDARY: reads the JDBC catalog as superuser brain → CROSS-BRAND by design
--               (dbt is the ETL writer). Isolation is enforced at the Silver READ
--               seam (metric-engine), not here. See _sources.yml.
--
-- MONEY (I-S07): amount_minor cast to BIGINT minor units, currency_code carried.
-- REPLAY-SAFE: pure deterministic projection — re-run yields identical rows.
-- ============================================================================
{{
  config(
    materialized = 'view',
    tags         = ['silver', 'staging', 'order_state']
  )
}}

with source as (

    select
        brand_id,
        order_id,
        brain_id,
        event_type,
        -- I-S07: money stays BIGINT minor units; never float/NUMERIC.
        cast(amount_minor as bigint)            as amount_minor,
        currency_code,
        occurred_at,
        economic_effective_at,
        created_at                              as ingested_at  -- M3: ingestion-time incremental watermark
    from {{ source('oltp', 'realized_revenue_ledger') }}
    -- Only the event_types that contribute to the ORDER LIFECYCLE (architecture §2 map).
    -- Settlement/fee/adjustment event_types (0027) do not move lifecycle state → excluded.
    where event_type in (
        'provisional_recognition',
        'finalization',
        'cancellation',
        'rto_reversal',
        'cod_rto_clawback',
        'cod_delivery_confirmed',
        'refund',
        'chargeback'
    )

),

deduped as (

    -- Dedup on the 0018 natural key (brand_id, order_id, event_type, occurred_at::date).
    -- Same-day replay → suppressed (keep earliest occurred_at, deterministic tiebreak on
    -- economic_effective_at then amount_minor) — distinct from legit split-shipment (a
    -- different day → a different dedup key → kept).
    select
        *,
        row_number() over (
            partition by brand_id, order_id, event_type, cast(occurred_at as date)
            order by occurred_at asc, economic_effective_at asc, amount_minor asc
        ) as _dedup_rn
    from source

)

select
    brand_id,
    order_id,
    brain_id,
    event_type,
    amount_minor,
    currency_code,
    occurred_at,
    economic_effective_at,
    ingested_at
from deduped
where _dedup_rn = 1
