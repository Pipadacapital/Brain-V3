-- ============================================================================
-- silver_touchpoint — the SECOND canonical Silver mart. The journey touchpoint table.
-- feat-journey-touchpoint (Stage 3, @data-engineer). Architecture §2/§3.
--
-- MATERIALIZATION: StarRocks PRIMARY KEY (upsert) table in brain_silver.
-- GRAIN: exactly 1 row per (brand_id, brain_anon_id, touch_seq) — every touch in
--        journey order, with is_first_touch / is_last_touch flags + session linkage.
--        (Per-touch grain — NOT one-row-per-session — so §4 serves BOTH the first-touch
--        mix AND the full timeline from one mart. First/last are flags on this grain.)
--
-- THE JOIN (deterministic cart-stitch, D-5): LEFT JOIN the stitch map on
--   (brand_id, brain_anon_id = stitched_anon_id). stitched_brain_id is set when the anon
--   journey was read BACK onto a known order (never inferred). NULL stitched_brain_id =
--   un-stitched journey = the §4 stitch-hit-rate denominator (honest).
--
-- ADDITIVE ONLY (ADR-004): this is a deterministic projection of the sessionized fold +
--   a key-equality join. NO non-additive aggregation (COUNT/share lives in metric-engine).
-- NO MONEY: touchpoints are not monetary — there is NO money/float column in this mart
--   (asserted by tests/assert_touchpoint_no_money.sql).
--
-- REPLAY-SAFE: pure ordering over append-only Bronze + the deterministic session/touch
--   numbering + a key-equality join → re-run yields byte-identical rows. PROVEN by
--   tests/assert_touchpoint_replay.sql + `make journey-verify`.
--
-- ISOLATION: brand_id is the FIRST key/distribution/order column. dbt writes ALL brands
--   (ETL-writer posture); per-brand isolation is enforced at the Silver READ seam (I-ST01).
-- ============================================================================
{{
  config(
    materialized   = 'table',
    table_type     = 'PRIMARY',
    keys           = ['brand_id', 'brain_anon_id', 'touch_seq'],
    distributed_by = ['brand_id', 'brain_anon_id'],
    order_by       = ['brand_id', 'brain_anon_id', 'touch_seq'],
    buckets        = 8,
    properties     = {
      'replication_num'        : '1',
      'enable_persistent_index': 'true',
      'compression'            : 'LZ4'
    },
    tags = ['silver', 'mart', 'touchpoint']
  )
}}

with touches as (

    select * from {{ ref('int_touchpoint_sessionized') }}

),

-- Deterministic cart-stitch lookup (read-back, never inferred — D-5).
-- One stitch row per (brand_id, stitched_anon_id) is expected; if multiple orders share
-- an anon we take the earliest deterministically so the mart stays replay-stable.
stitch as (

    select
        brand_id,
        stitched_anon_id,
        order_id,
        brain_id as stitched_brain_id,
        row_number() over (
            partition by brand_id, stitched_anon_id
            order by created_at asc, order_id asc
        ) as _stitch_rn
    from {{ source('oltp', 'connector_journey_stitch_map_src') }}

),

stitch_one as (

    select brand_id, stitched_anon_id, order_id, stitched_brain_id
    from stitch
    where _stitch_rn = 1

)

select
    t.brand_id,
    t.brain_anon_id,
    t.touch_seq,
    t.session_key,
    t.session_seq,
    t.is_first_touch,
    t.is_last_touch,
    t.occurred_at,
    t.event_type,
    t.channel,
    t.utm_source,
    t.utm_medium,
    t.utm_campaign,
    t.utm_term,
    t.utm_content,
    t.fbclid,
    t.gclid,
    t.ttclid,
    t.referrer_host,
    t.landing_path,
    s.order_id          as stitched_order_id,
    s.stitched_brain_id as stitched_brain_id,
    t.is_synthetic,
    t.session_id_raw,
    current_timestamp() as updated_at
from touches t
left join stitch_one s
    on t.brand_id = s.brand_id
   and t.brain_anon_id = s.stitched_anon_id
