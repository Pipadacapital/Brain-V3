-- assert_marketing_spend_grain — key uniqueness for the DUPLICATE-key mart silver_marketing_spend (ADR-0005).
-- The PRIMARY->DUPLICATE conversion (date partitioning) removed the storage-layer dedup, so this test
-- guards that the deterministic full-rebuild model still yields exactly one row per (brand_id, spend_event_id).
-- PASS = 0 rows.
select brand_id, spend_event_id, count(*) as n
from {{ ref('silver_marketing_spend') }}
group by brand_id, spend_event_id
having count(*) > 1
