-- ============================================================================
-- snap_order_state — daily order-lifecycle state snapshot (DB-AUDIT C3: history/SCD).
--
-- silver_order_state holds only the CURRENT lifecycle row per order; you cannot ask "what state was
-- this order in as-of date X", restate a historical dashboard, or build true state-transition
-- analytics. This INCREMENTAL, append-per-day snapshot captures each order's state daily, keyed
-- (brand_id, order_id, snapshot_date) — prior days preserved, same-day re-run idempotent (PRIMARY-key
-- upsert). The point-in-time order-state history for restatement + transition analysis.
--
-- ADDITIVE snapshot (no non-additive math). MONEY = BIGINT minor units + currency_code (I-S07).
-- ISOLATION: brand_id first key/dist column; per-brand isolation at the read seam (I-ST01).
-- SCHEDULING: run daily (stamps current_date()). Missed day = gap (ok); re-run = idempotent.
--
-- PF-1 (partitioning): RANGE-partition on the snapshot_date grain (which is in the PK, as StarRocks
-- PK tables require the partition column to be). StarRocks expression partitioning auto-creates a day partition per snapshot_date on insert;
-- creates partitions ahead and drops partitions past the 400-day TTL (storage stays bounded).
-- Mirrors db/starrocks/ddl/silver_template.sql.
-- ============================================================================
{{
  config(
    schema               = 'brain_silver',
    materialized         = 'incremental',
    incremental_strategy = 'default',
    unique_key           = ['brand_id', 'order_id', 'snapshot_date'],
    table_type           = 'PRIMARY',
    keys                 = ['brand_id', 'order_id', 'snapshot_date'],
    partition_type       = 'Expr',
    partition_by         = ["date_trunc('day', snapshot_date)"],
    distributed_by       = ['brand_id'],
    order_by             = ['brand_id', 'order_id', 'snapshot_date'],
    buckets              = 8,
    properties           = {
      'replication_num'                : '1',
      'enable_persistent_index'        : 'true',
      'compression'                    : 'LZ4',
      'partition_live_number'          : '400'
    },
    tags = ['silver', 'snapshot', 'history']
  )
}}

select
    brand_id,
    order_id,
    current_date()       as snapshot_date,
    brain_id,
    lifecycle_state,
    is_terminal,
    order_value_minor,
    currency_code,
    state_effective_at,
    current_timestamp()  as computed_at
from {{ ref('silver_order_state') }}
