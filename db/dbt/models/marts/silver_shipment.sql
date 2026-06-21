-- ============================================================================
-- silver_shipment — canonical Silver shipment latest-state mart (multi-source).
-- feat-logistics-silver-courier-rto (Slice 2).
--
-- MATERIALIZATION: StarRocks PRIMARY KEY (upsert) table in brain_silver.
-- GRAIN: exactly 1 row per (brand_id, order_id) — the LATEST shipment state per order, folded
--        deterministically from silver_shipment_event (max status_changed_at, terminal-state
--        preferred on ties). One shipment per order in Slice 2 (latest AWB wins). Multi-source
--        (GoKwik AWB + Shiprocket) via the shared terminal_class authority.
--
-- The decision-bearing flags (is_rto / is_delivered) + courier + pincode drive the courier/RTO/NDR
-- Gold metrics (packages/metric-engine) and join to silver_order_state on (brand_id, order_id).
--
-- ADDITIVE ONLY (ADR-004): deterministic latest-state projection — re-run yields identical rows.
-- ISOLATION: brand_id first key/distribution column; enforced at the Silver READ seam (I-ST01).
-- ============================================================================
{{
  config(
    materialized   = 'table',
    table_type     = 'PRIMARY',
    keys           = ['brand_id', 'order_id'],
    distributed_by = ['brand_id', 'order_id'],
    order_by       = ['brand_id', 'order_id'],
    buckets        = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['silver', 'mart', 'shipment']
  )
}}

with events as (

    select * from {{ ref('silver_shipment_event') }}

),

ranked as (

    select
        *,
        row_number() over (
            partition by brand_id, order_id
            order by
                is_terminal        desc,   -- prefer a terminal end-state as the resolved state
                status_changed_at  desc,
                occurred_at        desc,
                event_id           desc
        ) as _win_rn,
        min(occurred_at) over (partition by brand_id, order_id) as first_event_at
    from events

)

select
    brand_id,
    order_id,
    source,
    awb_number_hash,
    courier,
    status                              as current_status,
    terminal_class,
    is_terminal,
    (terminal_class = 'rto')           as is_rto,
    (terminal_class = 'delivered')     as is_delivered,
    payment_method,
    pincode,
    first_event_at,
    status_changed_at                  as last_status_at,
    is_synthetic,
    current_timestamp()                as updated_at
from ranked
where _win_rn = 1
