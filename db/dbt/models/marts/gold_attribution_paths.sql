-- ============================================================================
-- gold_attribution_paths — the JOURNEY/PATH-grain attribution mart (M9, audit remediation).
--
-- The existing gold_marketing_attribution is a FLAT credit ledger (one row per credit_id, per-channel
-- credit amounts) — it cannot answer "what SEQUENCE of touches led to this conversion?". This mart makes
-- the multi-touch PATH inspectable: one row per CONVERTED journey (brand_id, brain_anon_id,
-- stitched_order_id) with the ordered channel path (e.g. 'organic_social>paid_google>email>direct'),
-- the first/last touch channel, the touch count, and the path span. The path-attribution UI / analysts
-- read this to see real customer journeys, not just a credit total.
--
-- SOURCE: silver_touchpoint (the per-touch grain, channel + stitched_order_id from the deterministic
-- read-back stitch, D-5). A CONVERTED journey = an anon whose touches carry a stitched_order_id (never
-- inferred). Un-stitched journeys are NOT a conversion path and are excluded (honest — they have no
-- conversion to attribute).
--
-- ADDITIVE / DETERMINISTIC ONLY (ADR-004): an ordered string-agg + min/max + count over the per-touch
-- grain — a pure projection, NO non-additive ratio/model. Multi-touch CREDIT math (linear/time-decay/
-- position) stays in the metric-engine over gold_marketing_attribution; this mart is the PATH spine the
-- credit math and the journey UI inspect. NO money column (the path is not monetary; revenue joins at
-- read via stitched_order_id → gold_revenue_ledger). brand_id first key; per-brand at the read seam.
-- REPLAY-SAFE: deterministic ordering (occurred_at, touch_seq) → re-run yields identical paths.
-- ============================================================================
{{
  config(
    schema         = 'brain_gold',
    materialized   = 'table',
    table_type     = 'PRIMARY',
    keys           = ['brand_id', 'brain_anon_id', 'stitched_order_id'],
    distributed_by = ['brand_id'],
    order_by       = ['brand_id', 'brain_anon_id', 'stitched_order_id'],
    buckets        = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['gold', 'mart', 'attribution', 'paths']
  )
}}

-- Only the marketing/journey touches that carry a channel signal feed the path (browse-only behavioral
-- events like scroll.depth/element.clicked have a channel too — they ride the same deterministic ladder —
-- so every touch counts toward the journey path; this is the FULL inspectable journey).
with converted_touches as (

    select
        brand_id,
        brain_anon_id,
        stitched_order_id,
        stitched_brain_id,
        touch_seq,
        occurred_at,
        channel
    from {{ ref('silver_touchpoint') }}
    where stitched_order_id is not null   -- a CONVERTED journey (deterministic read-back, D-5)

),

-- First/last touch channel per converted journey (deterministic by touch order).
endpoints as (

    select
        brand_id,
        brain_anon_id,
        stitched_order_id,
        -- first-touch channel = channel at the min touch_seq; last = max touch_seq.
        min(case when touch_seq is not null then concat(lpad(cast(touch_seq as string), 10, '0'), '|', channel) end) as _first_enc,
        max(case when touch_seq is not null then concat(lpad(cast(touch_seq as string), 10, '0'), '|', channel) end) as _last_enc
    from converted_touches
    group by brand_id, brain_anon_id, stitched_order_id

)

select
    t.brand_id,
    t.brain_anon_id,
    t.stitched_order_id,
    max(t.stitched_brain_id)                                              as stitched_brain_id,
    -- the ORDERED multi-touch channel path (the inspectable journey).
    group_concat(t.channel order by t.touch_seq asc, t.occurred_at asc separator ' > ') as channel_path,
    cast(count(*) as bigint)                                             as touch_count,
    cast(count(distinct t.channel) as bigint)                           as distinct_channel_count,
    substring_index(max(e._first_enc), '|', -1)                          as first_touch_channel,
    substring_index(max(e._last_enc),  '|', -1)                          as last_touch_channel,
    min(t.occurred_at)                                                   as path_start_at,
    max(t.occurred_at)                                                   as path_end_at,
    current_timestamp()                                                  as updated_at
from converted_touches t
join endpoints e
  on t.brand_id = e.brand_id
 and t.brain_anon_id = e.brain_anon_id
 and t.stitched_order_id = e.stitched_order_id
group by t.brand_id, t.brain_anon_id, t.stitched_order_id
