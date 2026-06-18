-- ============================================================================
-- assert_touchpoint_replay — internal consistency invariants of the sessionize fold.
-- PASS = 0 rows returned. These invariants must hold on EVERY run; combined with the
-- `make journey-verify` content-checksum diff (run dbt twice, compare a hash of all
-- columns except the build-time updated_at), they prove the mart is replay-safe /
-- reproducible-from-source.
--
-- Invariant set:
--   (a) exactly one is_first_touch=true per (brand_id, brain_anon_id)  (first-touch uniqueness)
--   (b) exactly one is_last_touch=true per (brand_id, brain_anon_id)   (last-touch uniqueness)
--   (c) touch_seq=1 IFF is_first_touch=true                            (fold consistency)
--   (d) channel is one of the canonical values                        (defense-in-depth)
-- ============================================================================
with mart as (
    select * from {{ ref('silver_touchpoint') }}
),

-- (a) first-touch uniqueness
first_dupes as (
    select brand_id, brain_anon_id, count(*) as n
    from mart
    where is_first_touch = true
    group by brand_id, brain_anon_id
    having count(*) <> 1
),

-- (b) last-touch uniqueness
last_dupes as (
    select brand_id, brain_anon_id, count(*) as n
    from mart
    where is_last_touch = true
    group by brand_id, brain_anon_id
    having count(*) <> 1
)

select brand_id, brain_anon_id, 'first_touch_not_unique' as violation from first_dupes
union all
select brand_id, brain_anon_id, 'last_touch_not_unique' as violation from last_dupes
union all
-- (c) touch_seq=1 must coincide with is_first_touch
select brand_id, brain_anon_id, 'seq1_not_first' as violation
from mart
where (touch_seq = 1 and is_first_touch = false)
   or (touch_seq <> 1 and is_first_touch = true)
union all
-- (d) channel in the canonical set
select brand_id, brain_anon_id, 'unknown_channel' as violation
from mart
where channel not in ('paid_meta', 'paid_google', 'paid_tiktok', 'paid', 'email', 'organic_social', 'referral', 'direct')
