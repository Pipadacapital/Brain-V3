-- ============================================================================
-- gold_revenue_ledger — the realized-revenue ledger, SERVED FROM THE LAKEHOUSE (re-platform Phase G).
--
-- Phase G moves business data OUT of Postgres: this StarRocks mart in brain_gold is the lakehouse copy
-- of realized_revenue_ledger (sourced via the JDBC read-shim during transition; rebuilds from Bronze in
-- prod). The money metric-engine reads (cod-mix, settlement-summary, …) re-point here via withSilverBrand
-- so PostgreSQL stops being a read source for revenue. PG remains the WRITE SoR until a later cutover
-- (the worker still appends there); this mart is a derived, replayable projection.
--
-- Append-only ledger semantics preserved: one row per (brand_id, ledger_event_id) — the deterministic
-- ledger id. MONEY = signed BIGINT minor units (I-S07). ISOLATION: brand_id first key; per-brand at the
-- read seam (I-ST01). dbt writes all brands (ETL-writer posture).
-- ============================================================================
{{
  config(
    schema         = 'brain_gold',
    materialized   = 'table',
    table_type     = 'PRIMARY',
    keys           = ['brand_id', 'ledger_event_id'],
    distributed_by = ['brand_id'],
    order_by       = ['brand_id', 'ledger_event_id'],
    buckets        = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['gold', 'mart', 'ledger']
  )
}}

select
    brand_id,
    ledger_event_id,
    order_id,
    brain_id,
    event_type,
    cast(amount_minor as bigint)                       as amount_minor,
    currency_code,
    cast(coalesce(fee_minor, 0) as bigint)             as fee_minor,
    occurred_at,
    economic_effective_at,
    recognition_label,
    billing_posted_period,
    current_timestamp()                                as updated_at
from {{ source('oltp', 'realized_revenue_ledger') }}
where ledger_event_id is not null
