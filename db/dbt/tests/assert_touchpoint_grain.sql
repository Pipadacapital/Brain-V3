-- ============================================================================
-- assert_touchpoint_grain — the mart grain is exactly 1 row per
-- (brand_id, brain_anon_id, touch_seq). Dependency-free singular test (no dbt_utils).
-- PASS = 0 rows returned. Emits one row IFF total != distinct key count — i.e. any
-- duplicate violates the per-touch grain. (Scalar form avoids the StarRocks
-- GROUP-BY/HAVING interaction with dbt's count() test wrapper.)
-- ============================================================================
select
    total_rows,
    distinct_keys
from (
    select
        count(*) as total_rows,
        count(distinct concat(brand_id, '|', brain_anon_id, '|', cast(touch_seq as string))) as distinct_keys
    from {{ ref('silver_touchpoint') }}
) g
where total_rows <> distinct_keys
