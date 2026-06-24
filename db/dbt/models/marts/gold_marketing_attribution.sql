-- ============================================================================
-- gold_marketing_attribution — the attribution credit/clawback ledger, SERVED FROM THE LAKEHOUSE.
--
-- MEDALLION REALIGNMENT (Epic 2): this is now a thin VIEW over brain_gold.gold_attribution_credit —
-- the app-written StarRocks PRIMARY KEY ledger that the reconcile batch job (AttributionCreditWriter)
-- appends to. PostgreSQL billing.attribution_credit_ledger + the Spark attribution_credit_materialize
-- → Bronze hop + the gold_attribution_credit_src JDBC read-shim are GONE. The view keeps the same name
-- + column shape the metric-engine reads (channel-roas, reconciliation, campaign-roas) and the
-- snap_attribution_credit ref() — so the dashboard sees writes LIVE (no refresh lag).
--
-- credited_revenue_minor is SIGNED BIGINT (+credit / -clawback; I-S07, never float). channel is the
-- canonical JourneyChannel COLUMN (ADR-CM-1). ISOLATION: brand_id first; per-brand at the read seam
-- (I-ST01). One row per (brand_id, credit_id) — the deterministic sha256 credit id.
-- ============================================================================
{{
  config(
    schema       = 'brain_gold',
    materialized = 'view',
    tags = ['gold', 'mart', 'attribution']
  )
}}

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
    updated_at
from brain_gold.gold_attribution_credit
where credit_id is not null
