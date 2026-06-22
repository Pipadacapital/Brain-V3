-- ============================================================================
-- silver_order_state — THE first canonical Silver mart. The order lifecycle table.
-- feat-silver-tier-order-state (Stage 3, @data-engineer).
--
-- MATERIALIZATION: StarRocks PRIMARY KEY (upsert) table in brain_silver.
-- GRAIN: exactly 1 row per (brand_id, order_id) — latest lifecycle state per order.
--
-- THE FOLD (deterministic, replay-stable — architecture §2):
--   For each order, pick the WINNING lifecycle row:
--     1. terminal states win over non-terminal  (is_terminal desc)
--     2. then later economic_effective_at wins   (handles late terminal events)
--     3. then higher state_rank wins             (progression order)
--     4. then later occurred_at wins             (final deterministic tiebreak)
--   → a pure ordering over append-only source rows. Re-running dbt yields byte-identical
--     rows (idempotent / reproducible-from-source). PROVEN by tests/assert_order_state_replay.sql.
--
-- ADDITIVE ONLY (ADR-004): this is a latest-state PROJECTION of source rows, NOT a
--   non-additive aggregation. order-status-mix (COUNT/share) lives in metric-engine.
--
-- MONEY (I-S07): order_value_minor is BIGINT minor units, always paired with currency_code.
--   It is the SIGNED SUM of the order's recognized ledger rows (the realized order value),
--   excluding provisional_recognition (the no-double-count rule, D-3) — i.e. the realized
--   value, not raw placed GMV. Placed-only orders (no finalization yet) → 0 realized value.
--
-- ISOLATION: brand_id is the FIRST key/distribution/order column. dbt writes ALL brands
--   (ETL-writer posture); per-brand isolation is enforced at the Silver READ seam (I-ST01).
-- ============================================================================
{{
  config(
    materialized         = 'incremental',
    incremental_strategy = 'default',
    unique_key           = ['brand_id', 'order_id'],
    table_type           = 'PRIMARY',
    keys                 = ['brand_id', 'order_id'],
    distributed_by       = ['brand_id', 'order_id'],
    order_by             = ['brand_id', 'order_id'],
    buckets              = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['silver', 'mart', 'order_state']
  )
}}

-- M3 — INCREMENTAL RESTATEMENT with an INGESTION-TIME watermark (not economic time, so a late or
-- backdated event is never missed): on an incremental run, only orders that received a newly-ingested
-- ledger event since the last run are re-folded. Crucially the FULL event history of each dirty order
-- is re-folded (the winning lifecycle row may be an OLD event), then upserted by (brand_id, order_id)
-- into the PRIMARY KEY table; untouched orders keep their existing row. Re-run with no new events →
-- empty dirty set → no-op (idempotent). First run (table absent) folds everything (full build).
{% if is_incremental() %}
with dirty_orders as (

    select distinct brand_id, order_id
    from {{ ref('int_order_lifecycle') }}
    where ingested_at > (
        select coalesce(max(max_ingested_at), cast('1970-01-01 00:00:00' as datetime)) from {{ this }}
    )

),

lifecycle as (

    select l.*
    from {{ ref('int_order_lifecycle') }} l
    join dirty_orders d
      on l.brand_id = d.brand_id and l.order_id = d.order_id

),
{% else %}
with lifecycle as (

    select * from {{ ref('int_order_lifecycle') }}

),
{% endif %}

-- Per-order winning lifecycle row (the deterministic fold).
ranked as (

    select
        brand_id,
        order_id,
        brain_id,
        lifecycle_state,
        is_terminal,
        currency_code,
        occurred_at,
        economic_effective_at,
        row_number() over (
            partition by brand_id, order_id
            order by
                is_terminal           desc,
                economic_effective_at desc,
                state_rank            desc,
                occurred_at           desc
        ) as _win_rn
    from lifecycle

),

winner as (

    select
        brand_id,
        order_id,
        brain_id,
        lifecycle_state,
        is_terminal,
        currency_code
    from ranked
    where _win_rn = 1

),

-- Realized order value (I-S07): signed sum of recognized rows, excluding the
-- provisional_recognition pre-realization rows (D-3 no-double-count). One row per order.
order_value as (

    select
        brand_id,
        order_id,
        cast(sum(amount_minor) as bigint) as order_value_minor
    from lifecycle
    where lifecycle_state <> 'placed'   -- exclude provisional_recognition contribution
    group by brand_id, order_id

),

-- Lifecycle timestamps per order (additive min/max, not a metric aggregation).
order_times as (

    select
        brand_id,
        order_id,
        min(occurred_at) as first_event_at,
        max(economic_effective_at) as state_effective_at,
        max(ingested_at) as max_ingested_at   -- M3 incremental watermark (max ingestion time per order)
    from lifecycle
    group by brand_id, order_id

)

select
    w.brand_id,
    w.order_id,
    w.brain_id,
    w.lifecycle_state,
    w.is_terminal,
    cast(coalesce(ov.order_value_minor, 0) as bigint) as order_value_minor,
    w.currency_code,
    t.first_event_at,
    t.state_effective_at,
    t.max_ingested_at,
    current_timestamp() as updated_at
from winner w
left join order_value ov
    on w.brand_id = ov.brand_id and w.order_id = ov.order_id
left join order_times t
    on w.brand_id = t.brand_id and w.order_id = t.order_id
