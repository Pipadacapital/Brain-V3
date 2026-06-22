-- ============================================================================
-- gold_marketing_attribution — the attribution credit/clawback ledger, SERVED FROM THE LAKEHOUSE (Phase G).
--
-- Phase G moves business data OUT of Postgres. This StarRocks mart in brain_gold is the lakehouse copy of
-- attribution_credit_ledger (sourced via the JDBC read-shim during transition; rebuilds from Bronze in
-- prod). The attribution metric-engine reads (channel-roas, attribution-credit, contribution-margin)
-- re-point here via withSilverBrand so PostgreSQL stops being a read source for attributed revenue. PG
-- remains the WRITE SoR until a later cutover (the attribution writer still appends there).
--
-- Append-only ledger semantics preserved: one row per (brand_id, credit_id) — the deterministic sha256
-- credit id. credited_revenue_minor is SIGNED BIGINT (+credit / -clawback; I-S07, never float). channel is
-- the canonical JourneyChannel COLUMN (ADR-CM-1 — never a per-channel table). ISOLATION: brand_id first
-- key; per-brand at the read seam (I-ST01). dbt writes all brands (ETL-writer posture).
-- ============================================================================
{{
  config(
    schema         = 'brain_gold',
    materialized   = 'table',
    table_type     = 'PRIMARY',
    keys           = ['brand_id', 'credit_id'],
    distributed_by = ['brand_id'],
    order_by       = ['brand_id', 'model_id', 'channel'],
    buckets        = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['gold', 'mart', 'attribution']
  )
}}

-- H2 — SOURCE FLIP (var-gated + reversible), mirroring gold_revenue_ledger: serve the attribution
-- ledger mart from the lakehouse, not a live read of Postgres.
--   ledger_source='iceberg' → brain_bronze.attribution_credit (landed by attribution_credit_materialize.py).
--                             DEFAULT (mirrors gold_revenue_ledger) — PG no longer the analytical SoR.
--   ledger_source='pg'      → JDBC read-shim over PG attribution_credit_ledger (reversible escape).
-- This mart is materialized=table (full CTAS each run) so a source flip needs no special handling.
-- Data-starved (0 rows) today. Freshness via run-ledger-bronze-refresh.sh.
{% set ledger_source = var('ledger_source', 'iceberg') %}

select
    brand_id,
    credit_id,
    order_id,
    brain_anon_id,
    cast(touch_seq as int)                          as touch_seq,
    channel,
    campaign_id,
    model_id,
    row_kind,
    cast(credited_revenue_minor as bigint)          as credited_revenue_minor,
    currency_code,
    cast(realized_revenue_minor as bigint)          as realized_revenue_minor,
    reversed_of_credit_id,
    confidence_grade,
    cast(attribution_confidence as decimal(4, 3))   as attribution_confidence,
    model_version,
    occurred_at,
    economic_effective_at,
    billing_posted_period,
    current_timestamp()                             as updated_at
{% if ledger_source == 'iceberg' %}
from {{ source('bronze_iceberg', 'attribution_credit') }}
{% else %}
from {{ source('oltp', 'attribution_credit_ledger') }}
{% endif %}
where credit_id is not null
