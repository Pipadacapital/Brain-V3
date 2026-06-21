-- ============================================================================
-- silver_shipment_event — canonical Silver shipment-transition mart (multi-source).
-- feat-logistics-silver-courier-rto (Slice 2).
--
-- MATERIALIZATION: StarRocks PRIMARY KEY (upsert) table in brain_silver.
-- GRAIN: exactly 1 row per (brand_id, event_id) — one row per shipment status transition,
--        from EVERY logistics source (GoKwik AWB + Shiprocket tracking), normalized through the
--        shared @brain/logistics-status terminal_class authority. The append-only transition log
--        behind silver_shipment (latest-state) and the courier/RTO/NDR Gold metrics.
--
-- ADDITIVE ONLY (ADR-004): a deterministic projection of Bronze. Non-additive aggregation
-- (counts / RTO% / courier rollups) lives in packages/metric-engine, never here.
-- ISOLATION: brand_id is the FIRST key/distribution column; per-brand isolation is enforced at
-- the Silver READ seam (I-ST01), not in dbt (ETL-writer posture).
-- ============================================================================
{{
  config(
    materialized   = 'table',
    table_type     = 'PRIMARY',
    keys           = ['brand_id', 'event_id'],
    distributed_by = ['brand_id'],
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

select
    brand_id,
    event_id,
    order_id,
    source,
    awb_number_hash,
    status,
    terminal_class,
    is_terminal,
    payment_method,
    pincode,
    courier,
    status_changed_at,
    occurred_at,
    is_synthetic,
    current_timestamp() as updated_at
from {{ ref('stg_shipment_events') }}
