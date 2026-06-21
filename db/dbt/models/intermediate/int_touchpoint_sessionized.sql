-- ============================================================================
-- int_touchpoint_sessionized — 30-min inactivity sessionization + channel + first/last.
-- feat-journey-touchpoint (Stage 3, @data-engineer). Materialization: view.
--
-- THE FOLD (deterministic, replay-stable — architecture §2):
--   Per (brand_id, brain_anon_id) ordered by occurred_at:
--     * a NEW session starts when the gap from the previous touch > 30 minutes
--       (or it is the first touch). session_seq = running sum of the boundary flag.
--     * session_key = murmur_hash3_32(brand_id|brain_anon_id|session_seq) — deterministic,
--       replay-stable (the same hashing primitive the Makefile fingerprint uses).
--     * touch_seq = row_number() over the anon's touches ordered by occurred_at asc.
--       is_first_touch = (touch_seq = 1); is_last_touch = last touch by occurred_at desc.
--     * channel = a fixed deterministic CASE ladder (click_id → utm.medium → referrer →
--       direct). NEVER a classifier/model (D-5, Tier-0).
--
-- We RE-DERIVE the 30-min window server-side rather than trust the client session_id, so
--   Silver is reproducible-from-Bronze independent of client clock skew. The raw
--   session_id_raw is carried for cross-check only.
--
-- NO non-additive aggregation here (ADR-004) — COUNT/share lives in metric-engine.
-- ============================================================================
{{
  config(
    materialized = 'view',
    tags         = ['silver', 'intermediate', 'touchpoint']
  )
}}

with events as (

    select * from {{ ref('stg_touchpoint_events') }}

),

-- Mark a session boundary: first touch for the anon, or a >30-min gap from the prior touch.
boundaries as (

    select
        *,
        lag(occurred_at) over (
            partition by brand_id, brain_anon_id
            order by occurred_at asc
        ) as prev_occurred_at
    from events

),

flagged as (

    select
        *,
        case
            when prev_occurred_at is null then 1
            -- 30-minute inactivity window (1800 seconds).
            when timestampdiff(second, prev_occurred_at, occurred_at) > 1800 then 1
            else 0
        end as is_session_start
    from boundaries

),

-- Running sum of the boundary flag → a per-anon session_seq (1,2,3...).
sessionized as (

    select
        *,
        sum(is_session_start) over (
            partition by brand_id, brain_anon_id
            order by occurred_at asc
            rows between unbounded preceding and current row
        ) as session_seq
    from flagged

),

-- Touch ordering + channel derivation.
ordered as (

    select
        brand_id,
        brain_anon_id,
        event_id,
        event_type,
        occurred_at,
        session_id_raw,
        session_seq,
        -- Deterministic, replay-stable session key (mirrors the Makefile fingerprint hash).
        murmur_hash3_32(
            concat_ws('|', brand_id, brain_anon_id, cast(session_seq as string))
        ) as session_key,

        -- Touch ordering across the WHOLE anon journey (not per-session) — §2 first/last.
        row_number() over (
            partition by brand_id, brain_anon_id
            order by occurred_at asc, event_id asc
        ) as touch_seq,
        row_number() over (
            partition by brand_id, brain_anon_id
            order by occurred_at desc, event_id desc
        ) as touch_seq_desc,

        -- Channel ladder (deterministic CASE — NEVER a model). click_id → paid by network;
        -- else utm.medium mapped; else referrer non-empty → referral; else direct.
        case
            when fbclid is not null and fbclid <> '' then 'paid_meta'
            when gclid  is not null and gclid  <> '' then 'paid_google'
            when ttclid is not null and ttclid <> '' then 'paid_tiktok'
            when lower(coalesce(utm_medium, '')) in ('cpc', 'ppc', 'paid')      then 'paid'
            when lower(coalesce(utm_medium, '')) = 'email'                      then 'email'
            when lower(coalesce(utm_medium, '')) in ('social', 'paid_social')   then 'organic_social'
            when lower(coalesce(utm_medium, '')) = 'referral'                   then 'referral'
            when referrer is not null and referrer <> ''                        then 'referral'
            else 'direct'
        end as channel,

        utm_source,
        utm_medium,
        utm_campaign,
        utm_term,
        utm_content,
        fbclid,
        gclid,
        ttclid,
        referrer,
        landing_path,
        page_type,
        product_handle,
        collection_handle,
        search_query,
        is_synthetic
    from sessionized

)

select
    brand_id,
    brain_anon_id,
    event_id,
    event_type,
    occurred_at,
    session_id_raw,
    session_seq,
    session_key,
    touch_seq,
    (touch_seq = 1)      as is_first_touch,
    (touch_seq_desc = 1) as is_last_touch,
    channel,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_term,
    utm_content,
    fbclid,
    gclid,
    ttclid,
    referrer,
    -- referrer host (best-effort deterministic extraction; NULL when no referrer).
    case
        when referrer is null or referrer = '' then null
        else regexp_replace(referrer, '^[a-zA-Z]+://([^/]+).*$', '$1')
    end as referrer_host,
    landing_path,
    page_type,
    product_handle,
    collection_handle,
    search_query,
    is_synthetic
from ordered
