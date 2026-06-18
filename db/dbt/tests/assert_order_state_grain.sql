-- ============================================================================
-- assert_order_state_grain — the mart grain is exactly 1 row per (brand_id, order_id).
-- A dependency-free singular test (no dbt_utils). PASS = 0 rows returned.
-- Emits one row IFF total row count != distinct (brand_id, order_id) count — i.e. any
-- duplicate violates the one-row-per-order grain. (Scalar form avoids the StarRocks
-- GROUP-BY/HAVING interaction with dbt's count() test wrapper.)
-- ============================================================================
select
    total_rows,
    distinct_keys
from (
    select
        count(*)                                          as total_rows,
        count(distinct concat(brand_id, '|', order_id))   as distinct_keys
    from {{ ref('silver_order_state') }}
) g
where total_rows <> distinct_keys
