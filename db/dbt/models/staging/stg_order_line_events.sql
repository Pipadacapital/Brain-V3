-- ============================================================================
-- stg_order_line_events — typed, deduped staging of order line items (Silver line-grain).
-- feat-shopify-order-depth. Materialization: view.
--
-- GRAIN: 1 row per (brand_id, order_id, line_index). The shim view bronze_order_line_src
--        already (a) picks the LATEST order.* event per order and (b) unnests its line_items
--        with a 1-based ordinal — so this staging model is a pure typed projection + a
--        defensive dedup on the grain key (idempotent re-reads collapse to one row).
--
-- TYPING (I-S07): the shim exposes money + quantity as TEXT (jsonb cannot ride JDBC). We cast
--        them to BIGINT here — the money invariant is enforced as integer minor units, no float.
--        A non-numeric value (should never occur — the mapper writes minor-unit strings) casts
--        defensively via a numeric guard to 0 rather than failing the build.
--
-- DEV BOUNDARY: reads the JDBC catalog as superuser brain → CROSS-BRAND by design (ETL writer).
--        Isolation is enforced at the Silver READ seam (I-ST01), not here.
-- REPLAY-SAFE: pure deterministic projection — re-run yields identical rows.
-- ============================================================================
{{
  config(
    materialized = 'view',
    tags         = ['silver', 'staging', 'order_line']
  )
}}

with raw as (

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
    from {{ source('oltp', 'bronze_order_line_src') }}

),

typed as (

    select
        brand_id,
        order_id,
        line_index,
        sku,
        title,
        -- Integer minor-units (I-S07). regexp guard: a non-integer string → 0 (never float, never fail).
        case when quantity            rlike '^[0-9]+$'    then cast(quantity as bigint)            else 0 end as quantity,
        case when unit_price_minor    rlike '^-?[0-9]+$'  then cast(unit_price_minor as bigint)    else 0 end as unit_price_minor,
        case when line_total_minor    rlike '^-?[0-9]+$'  then cast(line_total_minor as bigint)    else 0 end as line_total_minor,
        case when line_discount_minor rlike '^-?[0-9]+$'  then cast(line_discount_minor as bigint) else 0 end as line_discount_minor,
        product_id,
        variant_id,
        currency_code,
        cast(occurred_at as datetime) as occurred_at
    from raw

),

deduped as (

    -- Defensive dedup on the grain key (the shim already yields a unique grain; this guards a
    -- pathological double-read). Deterministic tiebreak on occurred_at.
    select
        *,
        row_number() over (
            partition by brand_id, order_id, line_index
            order by occurred_at desc
        ) as _dedup_rn
    from typed

)

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
from deduped
where _dedup_rn = 1
