-- assert_checkout_signal_grain — key uniqueness for the DUPLICATE-key mart silver_checkout_signal (ADR-0005).
-- The PRIMARY->DUPLICATE conversion (date partitioning) removed the storage-layer dedup, so this test
-- guards that the deterministic full-rebuild model still yields exactly one row per (brand_id, event_id).
-- PASS = 0 rows.
select brand_id, event_id, count(*) as n
from {{ ref('silver_checkout_signal') }}
group by brand_id, event_id
having count(*) > 1
