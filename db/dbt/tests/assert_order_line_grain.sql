-- ============================================================================
-- assert_order_line_grain — the mart grain is exactly 1 row per (brand_id, order_id, line_index).
-- Dependency-free singular test (no dbt_utils). PASS = 0 rows returned. Emits one row IFF total
-- row count != distinct (brand_id, order_id, line_index) count — any duplicate violates the grain.
-- ============================================================================
select
    total_rows,
    distinct_keys
from (
    select
        count(*)                                                              as total_rows,
        count(distinct concat(brand_id, '|', order_id, '|', cast(line_index as string))) as distinct_keys
    from {{ ref('silver_order_line') }}
) g
where total_rows <> distinct_keys
