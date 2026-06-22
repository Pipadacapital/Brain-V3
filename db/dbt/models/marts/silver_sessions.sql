-- ============================================================================
-- silver_sessions — the SESSION-grain Silver mart (M10, audit remediation).
--
-- silver_touchpoint is per-TOUCH grain; this rolls those touches up to one row per SESSION
-- (brand_id, brain_anon_id, session_key) — the natural unit the funnel/engagement reads already
-- COUNT DISTINCT over. Making the session a first-class additive mart means session-grain analytics
-- (sessions/day, entry/exit channel, browse depth, bounce, session-level conversion) read a real grain
-- instead of re-deriving it from the touch grain every query.
--
-- DEFINITIONS (one row per session): session_key is the deterministic 30-min-inactivity session id
-- already computed in int_touchpoint_sessionized (server-re-derived, replay-stable). Per session we
-- carry: touch_count, distinct page-view count, the entry (first) + exit (last) channel + page_type,
-- the session start/end + duration, a bounce flag (touch_count = 1), and a converted flag (any touch
-- stitched to an order — deterministic read-back, D-5; never inferred).
--
-- ADDITIVE / DETERMINISTIC ONLY (ADR-004): COUNT / MIN / MAX / first-last-by-order over the touch grain
-- — a pure projection. Non-additive session RATES (bounce %, engagement %, avg touches) stay in the
-- metric-engine (storefront-engagement) — this mart holds the additive session components. NO money
-- column (sessions are not monetary). brand_id first key; per-brand at the read seam (I-ST01).
-- REPLAY-SAFE: deterministic ordering (occurred_at, touch_seq) → re-run yields identical sessions.
-- ============================================================================
{{
  config(
    schema         = 'brain_silver',
    materialized   = 'table',
    table_type     = 'PRIMARY',
    keys           = ['brand_id', 'brain_anon_id', 'session_key'],
    distributed_by = ['brand_id'],
    order_by       = ['brand_id', 'brain_anon_id', 'session_key'],
    buckets        = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['silver', 'mart', 'sessions']
  )
}}

with touches as (

    select
        brand_id,
        brain_anon_id,
        session_key,
        session_seq,
        touch_seq,
        occurred_at,
        event_type,
        channel,
        page_type,
        stitched_order_id,
        -- deterministic order-encoded channel/page so first/last resolve by touch order, not value.
        concat(lpad(cast(touch_seq as string), 10, '0'), '|', coalesce(channel, ''))   as _ch_enc,
        concat(lpad(cast(touch_seq as string), 10, '0'), '|', coalesce(page_type, '')) as _pt_enc
    from {{ ref('silver_touchpoint') }}

)

select
    brand_id,
    brain_anon_id,
    session_key,
    max(session_seq)                                                     as session_seq,
    cast(count(*) as bigint)                                             as touch_count,
    cast(sum(case when event_type = 'page.viewed' then 1 else 0 end) as bigint)    as pageview_count,
    cast(sum(case when event_type = 'product.viewed' then 1 else 0 end) as bigint) as product_view_count,
    -- entry/exit channel + entry page_type (deterministic by touch order).
    substring_index(min(_ch_enc), '|', -1)                              as entry_channel,
    substring_index(max(_ch_enc), '|', -1)                              as exit_channel,
    substring_index(min(_pt_enc), '|', -1)                              as entry_page_type,
    min(occurred_at)                                                    as session_start_at,
    max(occurred_at)                                                    as session_end_at,
    cast(timestampdiff(second, min(occurred_at), max(occurred_at)) as bigint) as duration_seconds,
    (count(*) = 1)                                                      as is_bounce,
    (max(case when stitched_order_id is not null then 1 else 0 end) = 1) as is_converted,
    current_timestamp()                                                as updated_at
from touches
group by brand_id, brain_anon_id, session_key
