-- assert_revenue_ledger_grain — key uniqueness for the DUPLICATE-key mart gold_revenue_ledger (ADR-0005).
-- The PRIMARY->DUPLICATE conversion (date partitioning) removed the storage-layer dedup, so this test
-- guards that the deterministic full-rebuild model still yields exactly one row per (brand_id, ledger_event_id).
-- PASS = 0 rows.
select brand_id, ledger_event_id, count(*) as n
from {{ ref('gold_revenue_ledger') }}
group by brand_id, ledger_event_id
having count(*) > 1
