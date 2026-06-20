-- ============================================================================
-- silver_order_line — Silver order LINE-ITEM mart. feat-shopify-order-depth.
--
-- MATERIALIZATION: StarRocks PRIMARY KEY (upsert) table in brain_silver.
-- GRAIN: exactly 1 row per (brand_id, order_id, line_index) — the line items of each order's
--        LATEST state (the latest-event pick + unnest happens in the shim; staging types it).
--
-- ADDITIVE ONLY (ADR-004): a latest-state PROJECTION of source rows, NOT a non-additive
--   aggregation. Product-level rollups (top SKUs, units sold, line GMV) live in the
--   metric-engine over this mart, never here.
--
-- MONEY (I-S07): unit_price_minor / line_total_minor / line_discount_minor are BIGINT minor
--   units, always paired with currency_code.
--
-- ISOLATION: brand_id is the FIRST key/distribution/order column. dbt writes ALL brands
--   (ETL-writer posture); per-brand isolation is enforced at the Silver READ seam (I-ST01).
--
-- REPLAY-SAFE: the source is a deterministic projection (latest-event pick has a stable
--   tiebreak; ordinality is stable) → re-running dbt yields byte-identical rows. PROVEN by
--   tests/assert_order_line_replay.sql + the orderline-verify content-fingerprint diff.
-- ============================================================================
{{
  config(
    materialized   = 'table',
    table_type     = 'PRIMARY',
    keys           = ['brand_id', 'order_id', 'line_index'],
    distributed_by = ['brand_id'],
    order_by       = ['brand_id', 'order_id', 'line_index'],
    buckets        = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['silver', 'mart', 'order_line']
  )
}}

select
    brand_id,
    order_id,
    line_index,
    sku,
    title,
    quantity,
    unit_price_minor,
    line_total_minor,
    line_discount_minor,
    product_id,
    variant_id,
    currency_code,
    occurred_at
from {{ ref('stg_order_line_events') }}
