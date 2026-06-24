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
    schema               = 'brain_gold',
    materialized         = 'table',
    table_type           = 'DUPLICATE',
    keys                 = ['brand_id', 'ledger_event_id'],
    partition_type       = 'Expr',
    partition_by         = ["date_trunc('month', occurred_at)"],
    distributed_by       = ['brand_id'],
    order_by             = ['brand_id', 'ledger_event_id'],
    buckets              = 8,
    properties     = {
      'replication_num' : '1',
      'compression'     : 'LZ4'
    },
    tags = ['gold', 'mart', 'ledger']
  )
}}

-- MEDALLION REALIGNMENT (Epic 1/4): this mart is built FROM Bronze via silver_order_recognition (the
-- recognition transform), full-rebuild table. The old H2 var-gated source flip (ledger_source=iceberg→
-- brain_bronze.revenue_ledger via revenue_ledger_materialize.py, or =pg via a JDBC shim over the PG
-- realized_revenue_ledger) is GONE — the PG ledger + its Spark materializer + the bronze_iceberg.revenue_
-- ledger source were removed (migration 0098 + Epic-4 cruft cleanup). The lone source is now Bronze.
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
    ingested_at,
    cast('live' as varchar(16))                        as data_source,  -- MK-1: real builds = live; demo seed overwrites to 'synthetic'
    current_timestamp()                                as updated_at
-- MEDALLION REALIGNMENT (Epic 1): the revenue ledger is now computed in Silver FROM Bronze
-- (silver_order_recognition), not the PostgreSQL ledger. Full-rebuild table so recognition events that
-- become eligible later (e.g. a prepaid finalization once its horizon passes) are always captured —
-- an incremental ingested-at watermark would miss them (they carry the order's original ingest time).
from {{ ref('silver_order_recognition') }}
-- occurred_at NOT NULL: it is the expression-partition key (date_trunc('month', occurred_at)); StarRocks
-- expression partitioning rejects a NULL partition value. Revenue is retained in full (month partitions
-- are few + financial history is bounded by orders) — pruning, not TTL.
where ledger_event_id is not null
  and occurred_at is not null
