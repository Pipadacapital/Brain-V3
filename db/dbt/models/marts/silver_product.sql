-- ============================================================================
-- silver_product — the product master / performance dimension (DB-AUDIT: "no product dimension →
-- product cohorts not buildable; product title was MIN-over-lines").
--
-- The canonical per-product Silver entity: one row per brand × product × currency, aggregated from
-- silver_order_line. Gives product analytics (performance, revenue) a real product master and the
-- first/last-sold timestamps that product cohorts need.
--
-- product_key = product_id when present, else sku, else 'unknown' (a stable grain key — products
-- without a platform product_id still resolve by SKU). ADDITIVE ONLY (ADR-004): units_sold,
-- gross_revenue_minor, discount_minor, order_count are additive; per-product ratios (AOV) derive at
-- read. MONEY = BIGINT minor units + currency_code (I-S07). ISOLATION: brand_id first key/dist column;
-- per-brand isolation at the read seam (I-ST01). currency_code required (PRIMARY-key non-null).
-- ============================================================================
{{
  config(
    schema         = 'brain_silver',
    materialized   = 'table',
    table_type     = 'PRIMARY',
    keys           = ['brand_id', 'product_key', 'currency_code'],
    distributed_by = ['brand_id'],
    order_by       = ['brand_id', 'product_key', 'currency_code'],
    buckets        = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['silver', 'mart', 'product']
  )
}}

with lines as (

    select
        *,
        coalesce(nullif(product_id, ''), nullif(sku, ''), 'unknown') as product_key
    from {{ ref('silver_order_line') }}
    where currency_code is not null

)

select
    brand_id,
    product_key,
    currency_code,
    max(sku)                          as sku,
    max(title)                        as title,
    count(distinct order_id)          as order_count,
    sum(quantity)                     as units_sold,
    sum(line_total_minor)             as gross_revenue_minor,
    sum(line_discount_minor)          as discount_minor,
    min(occurred_at)                  as first_sold_at,
    max(occurred_at)                  as last_sold_at,
    current_timestamp()               as updated_at
from lines
group by brand_id, product_key, currency_code
