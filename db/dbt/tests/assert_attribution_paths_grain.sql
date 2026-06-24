-- assert_attribution_paths_grain — key uniqueness for the DUPLICATE-key mart gold_attribution_paths (ADR-0005).
-- The PRIMARY->DUPLICATE conversion (date partitioning) removed the storage-layer dedup, so this test
-- guards that the deterministic full-rebuild model still yields exactly one row per (brand_id, brain_anon_id, stitched_order_id).
-- PASS = 0 rows.
select brand_id, brain_anon_id, stitched_order_id, count(*) as n
from {{ ref('gold_attribution_paths') }}
group by brand_id, brain_anon_id, stitched_order_id
having count(*) > 1
