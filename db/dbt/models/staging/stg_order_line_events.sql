-- ============================================================================
-- stg_order_line_events — typed, deduped staging of order line items (Silver line-grain).
-- feat-shopify-order-depth. Materialization: view.
--
-- GRAIN: 1 row per (brand_id, order_id, line_index).
--   pg      → the shim view bronze_order_line_src already (a) picks the LATEST order.* event per
--             order and (b) unnests its line_items with a 1-based ORDINAL (array position).
--   iceberg → this model does the SAME latest-pick (row_number) + unnest natively in StarRocks
--             (the shim's transform moves into staging, like the touchpoint flip). One difference,
--             by design: StarRocks unnest has no WITH ORDINALITY and array_generate needs literals,
--             so line_index is a DETERMINISTIC row_number over the line's own content (sku,
--             variant_id, unit_price_minor) — NOT the array position. It is still 1..N, stable, and
--             replay-safe; the line CONTENT (sku/title/qty/money) is byte-identical to the PG path.
--             line_index is a grain disambiguator, never a business value, so this is benign.
-- Either way this model is a typed projection + a defensive dedup on the grain key.
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

-- SOURCE FLIP (ADR-0002), var-gated + reversible (mirrors stg_touchpoint_events):
--   bronze_source='pg'      → the JDBC read-shim view (PG bronze_events; latest-pick + unnest done in SQL view)
--   bronze_source='iceberg' → the raw Iceberg collector_events catalog; the latest-order pick + the
--                             line_items unnest move HERE (the shim's transform inlined into staging).
{% set bronze_source = var('bronze_source', 'pg') %}
with raw as (

    {% if bronze_source == 'iceberg' %}
    -- Latest order.* event per (brand_id, order_id), then unnest its line_items array natively.
    select
        l.brand_id,
        l.order_id,
        -- See header: deterministic content-ordered ordinal (StarRocks has no WITH ORDINALITY).
        row_number() over (
            partition by l.brand_id, l.order_id
            order by get_json_string(t.item, '$.sku'),
                     get_json_string(t.item, '$.variant_id'),
                     get_json_string(t.item, '$.unit_price_minor')
        )                                                          as line_index,
        get_json_string(t.item, '$.sku')                          as sku,
        get_json_string(t.item, '$.title')                        as title,
        coalesce(get_json_string(t.item, '$.quantity'), '0')             as quantity,
        coalesce(get_json_string(t.item, '$.unit_price_minor'), '0')     as unit_price_minor,
        coalesce(get_json_string(t.item, '$.line_total_minor'), '0')     as line_total_minor,
        coalesce(get_json_string(t.item, '$.line_discount_minor'), '0')  as line_discount_minor,
        get_json_string(t.item, '$.product_id')                   as product_id,
        get_json_string(t.item, '$.variant_id')                   as variant_id,
        l.currency_code,
        l.occurred_at
    from (
        select
            brand_id,
            event_id,
            occurred_at,
            coalesce(get_json_string(payload, '$.properties.order_id'),
                     get_json_string(payload, '$.order_id'))           as order_id,
            get_json_string(payload, '$.properties.currency_code')     as currency_code,
            get_json_string(payload, '$.properties.line_items')        as line_items_json,
            row_number() over (
                partition by brand_id,
                             coalesce(get_json_string(payload, '$.properties.order_id'),
                                      get_json_string(payload, '$.order_id'))
                order by occurred_at desc, event_id desc   -- deterministic latest-event tiebreak
            )                                                          as rn
        from {{ source('bronze_iceberg', 'collector_events') }}
        where event_type like 'order.%'
          and json_length(parse_json(get_json_string(payload, '$.properties.line_items'))) > 0
    ) l
    cross join unnest(cast(parse_json(l.line_items_json) as array<json>)) as t(item)
    where l.rn = 1   -- only the current (latest) order event's lines
    {% else %}
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
    {% endif %}

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
