-- ============================================================================
-- assert_order_state_replay — internal consistency invariants of the latest-state fold.
-- PASS = 0 rows returned. These invariants must hold on EVERY run; combined with the
-- `make silver-verify` content-checksum diff (which runs dbt run twice and compares a
-- hash of all columns EXCEPT the build-time updated_at), they prove the mart is
-- replay-safe / reproducible-from-source.
--
-- Invariant set:
--   (a) terminal lifecycle_state ⇒ is_terminal = true   (fold consistency)
--   (b) non-terminal lifecycle_state ⇒ is_terminal = false
--   (c) lifecycle_state is one of the canonical values (defense-in-depth vs accepted_values)
-- ============================================================================
with mart as (
    select * from {{ ref('silver_order_state') }}
)
-- (a) terminal states must be flagged terminal
select brand_id, order_id, lifecycle_state, is_terminal, 'terminal_not_flagged' as violation
from mart
where lifecycle_state in ('delivered', 'cancelled', 'rto', 'refunded')
  and is_terminal = false

union all
-- (b) non-terminal states must NOT be flagged terminal
select brand_id, order_id, lifecycle_state, is_terminal, 'nonterminal_flagged_terminal' as violation
from mart
where lifecycle_state in ('placed', 'confirmed')
  and is_terminal = true

union all
-- (c) lifecycle_state in the canonical set
select brand_id, order_id, lifecycle_state, is_terminal, 'unknown_lifecycle_state' as violation
from mart
where lifecycle_state not in ('placed', 'confirmed', 'delivered', 'cancelled', 'rto', 'refunded')
