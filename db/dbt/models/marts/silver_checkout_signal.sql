-- ============================================================================
-- silver_checkout_signal — canonical Silver payments/checkout-SIGNAL mart (multi-source, event-grain).
-- feat-payments-checkout-silver (the payments-category Silver normalizer).
--
-- MATERIALIZATION: StarRocks PRIMARY KEY (upsert) table in brain_silver.
-- GRAIN: exactly 1 row per (brand_id, event_id) — every checkout/risk signal event from every
--        payments source, normalized through one shape. Multi-source: GoKwik RTO-Predict +
--        Shopflo abandoned-checkout today; GoKwik Tier-B/C checkout/OTP land here once partner
--        access arrives (additive — add the event_type to stg_checkout_signal_events).
--
-- This is the canonical home the payments-category Gold metrics read instead of raw Bronze:
--   - cod-rto-prediction  (latest risk_flag per order over a window) → reads signal_type='rto_predict'
--   - checkout-funnel     (abandoned counts + recoverable GMV)       → reads signal_type='checkout_abandoned'
--
-- ADDITIVE ONLY (ADR-004): deterministic projection — re-run yields identical rows.
-- ISOLATION: brand_id first key/distribution column; enforced at the Silver READ seam (I-ST01).
-- ============================================================================
{{
  config(
    materialized   = 'table',
    table_type     = 'PRIMARY',
    keys           = ['brand_id', 'event_id'],
    distributed_by = ['brand_id', 'event_id'],
    order_by       = ['brand_id', 'event_id'],
    buckets        = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['silver', 'mart', 'checkout', 'payments']
  )
}}

select
    brand_id,
    event_id,
    signal_type,
    source,
    order_id,
    risk_flag,
    total_price_minor,
    total_discount_minor,
    has_address,
    currency_code,
    occurred_at,
    is_synthetic,
    current_timestamp() as updated_at
from {{ ref('stg_checkout_signal_events') }}
