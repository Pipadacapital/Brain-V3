-- ============================================================================
-- assert_order_line_replay — internal consistency invariants of the line projection.
-- PASS = 0 rows returned. Combined with the `make orderline-verify` content-checksum diff
-- (dbt run twice, compare a hash of all columns), these prove the mart is replay-safe /
-- reproducible-from-source.
--
-- Invariant set:
--   (a) line_index is a valid 1-based ordinal (>= 1)
--   (b) quantity is non-negative
--   (c) money is the mapper's exact integer identity:
--       line_total_minor = quantity * unit_price_minor - line_discount_minor
--       (proves the unnested values are internally consistent, no float drift)
-- ============================================================================
with mart as (
    select * from {{ ref('silver_order_line') }}
)
-- (a) line_index must be a valid ordinal
select brand_id, order_id, line_index, 'bad_line_index' as violation
from mart
where line_index < 1

union all
-- (b) quantity must be non-negative
select brand_id, order_id, line_index, 'negative_quantity' as violation
from mart
where quantity < 0

union all
-- (c) the exact integer money identity must hold (no float drift)
select brand_id, order_id, line_index, 'line_total_identity_violation' as violation
from mart
where line_total_minor <> (quantity * unit_price_minor) - line_discount_minor
