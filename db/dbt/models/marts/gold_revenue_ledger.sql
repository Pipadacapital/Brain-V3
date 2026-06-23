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
    table_type           = 'PRIMARY',
    keys                 = ['brand_id', 'ledger_event_id'],
    distributed_by       = ['brand_id'],
    order_by             = ['brand_id', 'ledger_event_id'],
    buckets              = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['gold', 'mart', 'ledger']
  )
}}

-- H2 — SOURCE FLIP (var-gated + reversible): serve the ledger mart from the lakehouse, not a live
-- read of Postgres.
--   ledger_source='iceberg' → brain_bronze.revenue_ledger in the Iceberg catalog (landed by the Spark
--                             batch revenue_ledger_materialize.py). DEFAULT — PG is no longer the
--                             analytical SoR for the ledger (the H2 goal). Parity-proven
--                             (db/iceberg/parity/ledger_bronze_parity.sh: Iceberg==PG).
--   ledger_source='pg'      → JDBC read-shim over PG billing.realized_revenue_ledger (reversible escape).
-- FRESH ENV / SOURCE FLIP: the Iceberg revenue_ledger must exist + be fresh first
-- (run-ledger-bronze-refresh.sh), and the FIRST build after a source switch must be a --full-refresh
-- (the table's column TYPES change PG↔Iceberg; on_schema_change=append_new_columns means we re-seed via
-- full-refresh rather than an unsupported StarRocks DROP COLUMN). Steady-state incrementals are clean.
{% set ledger_source = var('ledger_source', 'iceberg') %}
--
-- M3 — INCREMENTAL append. The ledger is strictly append-only: one IMMUTABLE row per
-- (brand_id, ledger_event_id). So incremental is trivially correct — only rows ingested since the last
-- run are inserted (watermark on created_at = ingestion time, which is fresh even for a backdated
-- economic_effective_at, so nothing is missed). PRIMARY KEY upsert makes a re-pulled duplicate a no-op.
-- First run (table absent) loads the full ledger.
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
    current_timestamp()                                as updated_at
-- MEDALLION REALIGNMENT (Epic 1): the revenue ledger is now computed in Silver FROM Bronze
-- (silver_order_recognition), not the PostgreSQL ledger. Full-rebuild table so recognition events that
-- become eligible later (e.g. a prepaid finalization once its horizon passes) are always captured —
-- an incremental ingested-at watermark would miss them (they carry the order's original ingest time).
from {{ ref('silver_order_recognition') }}
where ledger_event_id is not null
