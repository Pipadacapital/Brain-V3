-- ============================================================================
-- int_order_lifecycle — normalize each ledger event to a canonical lifecycle_state.
-- feat-silver-tier-order-state (Stage 3, @data-engineer). Materialization: view.
--
-- GRAIN: 1 row per staged ledger event, annotated with:
--   * lifecycle_state  — the canonical state the event_type maps to (architecture §2).
--   * is_terminal      — whether that state is a terminal lifecycle outcome.
--   * state_rank       — deterministic ordering so the mart can pick the winning state
--                        per order (terminal-wins, then progression rank). Pure ordering,
--                        no model — replay-stable.
--
-- This view contains NO non-additive aggregation (that lives in metric-engine, ADR-004);
-- it is a deterministic per-event normalization.
-- ============================================================================
{{
  config(
    materialized = 'view',
    tags         = ['silver', 'intermediate', 'order_state']
  )
}}

with events as (

    select * from {{ ref('silver_order_recognition') }}  -- Epic 1: recognition from Bronze (was the PG-ledger staging)

),

normalized as (

    select
        brand_id,
        order_id,
        brain_id,
        amount_minor,
        currency_code,
        occurred_at,
        economic_effective_at,
        ingested_at,
        event_type,

        -- event_type → canonical lifecycle_state (architecture §2)
        case event_type
            when 'provisional_recognition'   then 'placed'
            when 'finalization'              then 'confirmed'
            when 'cod_delivery_confirmed'    then 'delivered'
            when 'cancellation'              then 'cancelled'
            when 'rto_reversal'              then 'rto'
            when 'cod_rto_clawback'          then 'rto'
            when 'refund'                    then 'refunded'
            when 'chargeback'                then 'refunded'
        end as lifecycle_state,

        -- terminal outcomes end the order's lifecycle
        case event_type
            when 'cod_delivery_confirmed'    then true
            when 'cancellation'              then true
            when 'rto_reversal'              then true
            when 'cod_rto_clawback'          then true
            when 'refund'                    then true
            when 'chargeback'                then true
            else false
        end as is_terminal,

        -- deterministic progression rank: higher = later in the lifecycle.
        -- Used by the mart to pick the winning state per order (terminal-wins via
        -- is_terminal first, then this rank, then economic_effective_at).
        case event_type
            when 'provisional_recognition'   then 10   -- placed
            when 'finalization'              then 20   -- confirmed
            when 'cod_delivery_confirmed'    then 90   -- delivered (terminal, positive)
            when 'cancellation'              then 80   -- cancelled (terminal)
            when 'rto_reversal'              then 85   -- rto (terminal)
            when 'cod_rto_clawback'          then 85   -- rto (terminal)
            when 'refund'                    then 70   -- refunded (terminal, post-delivery)
            when 'chargeback'                then 70   -- refunded (terminal)
            else 0
        end as state_rank

    from events

)

select * from normalized
