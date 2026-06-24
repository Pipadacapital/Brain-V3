-- ============================================================================
-- gold_customer_scores — deterministic RFM + churn-risk customer scoring (DB-AUDIT C5: "no customer
-- scoring / RFM profile; scores deferred to an absent ML phase").
--
-- The HONEST, deterministic scoring layer (NOT ML — that's a separate multi-week platform). Reads the
-- LATEST per-customer snapshot from feature_customer_daily (the C3 history table — so that table is no
-- longer orphaned) and assigns transparent, rule-based RFM tiers + a churn-risk band. When predictive
-- models land they REPLACE these scores via the same grain; until then dashboards get real, explainable
-- scores instead of nothing.
--
-- Grain: 1 row per (brand_id, brain_id). Deterministic per-customer bucketing (same pattern as
-- gold_customer_segments — labeling, not aggregation). MONEY = BIGINT minor units + currency_code.
-- ISOLATION: brand_id first key/dist column; per-brand at the read seam (I-ST01).
-- ============================================================================
{{
  config(
    schema         = 'brain_gold',
    materialized   = 'table',
    table_type     = 'PRIMARY',
    keys           = ['brand_id', 'brain_id'],
    distributed_by = ['brand_id'],
    order_by       = ['brand_id', 'brain_id'],
    buckets        = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['gold', 'mart', 'scoring', 'feature']
  )
}}

with latest as (

    -- the most recent daily snapshot per customer (point-in-time-consistent feature row)
    select *
    from (
        select *,
               row_number() over (partition by brand_id, brain_id order by snapshot_date desc) as rn
        from {{ ref('feature_customer_daily') }}
    ) s
    where rn = 1

)

select
    brand_id,
    brain_id,
    currency_code,
    snapshot_date                                  as scored_on,
    lifetime_orders,
    lifetime_value_minor,
    days_since_last_order,

    -- Recency tier (lower days = fresher). Deterministic, explainable bands.
    case
        when days_since_last_order <= 30  then 5
        when days_since_last_order <= 60  then 4
        when days_since_last_order <= 90  then 3
        when days_since_last_order <= 180 then 2
        else 1
    end                                            as recency_score,

    -- Frequency tier (repeat behaviour).
    case
        when lifetime_orders >= 10 then 5
        when lifetime_orders >= 5  then 4
        when lifetime_orders >= 3  then 3
        when lifetime_orders >= 2  then 2
        else 1
    end                                            as frequency_score,

    -- Monetary tier (realized lifetime value, minor units).
    case
        when lifetime_value_minor >= 10000000 then 5   -- ≥ 100k major
        when lifetime_value_minor >= 5000000  then 4
        when lifetime_value_minor >= 1000000  then 3
        when lifetime_value_minor >= 200000   then 2
        else 1
    end                                            as monetary_score,

    -- Churn risk: rule-based on recency (an honest proxy until a churn model lands).
    case
        when days_since_last_order > 180 then 'high'
        when days_since_last_order > 90  then 'medium'
        else 'low'
    end                                            as churn_risk,

    cast('live' as varchar(16))                        as data_source,  -- MK-1: real builds = live; demo seed overwrites to 'synthetic'

    current_timestamp()                            as computed_at
from latest
