-- ============================================================================
-- stg_touchpoint_events — 1:1 staging read of SDK journey Bronze events + dedup.
-- feat-journey-touchpoint (Stage 3, @data-engineer). Materialization: view.
--
-- GRAIN: 1 row per journey Bronze event (page.viewed / cart.viewed / cart.item_added),
--        deduped on the Bronze idempotency key (brand_id, event_id) — 0016:36. NO
--        business logic / sessionization here (that is the intermediate's job); this is
--        a typed, deduped, field-extracted projection of the source.
--
-- FIELD EXTRACTION: the SDK journey signal lives entirely in payload.properties
--   (capture.ts:56-77). The JDBC read-shim exposes payload as TEXT (jsonb is UNKNOWN_TYPE
--   over JDBC); we re-parse it with parse_json() and pull each field with get_json_string().
--   NULL when absent (honest).
--
-- DEV-HONESTY (architecture §1 ASSUMPTION correction): real Bronze page.viewed rows do
--   NOT all carry brain_anon_id (only the SDK-instrumented subset does — verified 23/94
--   in dev). Rows with NULL brain_anon_id CANNOT be sessionized (no journey key) and are
--   DROPPED here with a counted reason. We never synthesize an anon_id. The dropped count
--   is surfaced honestly downstream (coverage line).
--
-- SYNTHETIC FLAG: payload.properties._synthetic='true' (the journey_synthetic seed) rides
--   through as is_synthetic so the metric-engine/UI can badge fixture-backed journeys.
--
-- DEV BOUNDARY: reads the JDBC catalog as superuser brain → CROSS-BRAND by design
--   (dbt is the ETL writer). Isolation is enforced at the Silver READ seam, not here.
-- REPLAY-SAFE: pure deterministic projection — re-run yields identical rows.
-- ============================================================================
{{
  config(
    materialized = 'view',
    tags         = ['silver', 'staging', 'touchpoint']
  )
}}

-- SOURCE FLIP (ADR-0002 Slice 4b), var-gated + reversible:
--   bronze_source='pg'      → the JDBC read-shim view (PG bronze_events; pre-filtered + cast)
--   bronze_source='iceberg' → the raw Iceberg collector_events catalog; we apply the journey
--                             event-type filter HERE (the shim's WHERE moves into staging).
-- Both expose payload as a JSON string with the SAME .properties.* shape → identical extraction.
{% set bronze_source = var('bronze_source', env_var('BRONZE_OPERATIONAL_READ_SOURCE', 'pg')) %}
with raw as (

    {% if bronze_source == 'iceberg' %}
    select
        brand_id,
        event_id,
        event_type,
        occurred_at,
        parse_json(payload) as pj
    from {{ source('bronze_iceberg', 'collector_events') }}
    where event_type in ('page.viewed', 'cart.viewed', 'cart.item_added')
    {% else %}
    select
        brand_id,
        event_id,
        event_type,
        occurred_at,
        parse_json(payload) as pj   -- text → JSON (jsonb cannot ride JDBC; shim sent text)
    from {{ source('oltp', 'bronze_touchpoint_src') }}
    {% endif %}

),

source as (

    select
        brand_id,
        event_id,
        event_type,
        occurred_at,
        -- Journey signal extracted from payload.properties (capture.ts shape).
        get_json_string(pj, '$.properties.brain_anon_id')   as brain_anon_id,
        get_json_string(pj, '$.properties.session_id')      as session_id_raw,
        get_json_string(pj, '$.properties.utm.source')      as utm_source,
        get_json_string(pj, '$.properties.utm.medium')      as utm_medium,
        get_json_string(pj, '$.properties.utm.campaign')    as utm_campaign,
        get_json_string(pj, '$.properties.utm.term')        as utm_term,
        get_json_string(pj, '$.properties.utm.content')     as utm_content,
        get_json_string(pj, '$.properties.click_ids.fbclid') as fbclid,
        get_json_string(pj, '$.properties.click_ids.gclid')  as gclid,
        get_json_string(pj, '$.properties.click_ids.ttclid') as ttclid,
        get_json_string(pj, '$.properties.referrer')        as referrer,
        get_json_string(pj, '$.properties.landing_path')    as landing_path,
        -- dev-honesty: synthetic fixtures flag themselves; real events have no flag → NULL.
        case when get_json_string(pj, '$.properties._synthetic') = 'true'
             then true else false end                       as is_synthetic
    from raw

),

-- Drop rows with no journey key (cannot sessionize). Counted downstream for honesty.
keyed as (

    select * from source
    where brain_anon_id is not null and brain_anon_id <> ''

),

deduped as (

    -- Dedup on the Bronze idempotency key (brand_id, event_id) — 0016 PK. Re-delivered
    -- events (same event_id) collapse to one row. Deterministic tiebreak on occurred_at.
    select
        *,
        row_number() over (
            partition by brand_id, event_id
            order by occurred_at asc
        ) as _dedup_rn
    from keyed

)

select
    brand_id,
    event_id,
    event_type,
    occurred_at,
    brain_anon_id,
    session_id_raw,
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
    is_synthetic
from deduped
where _dedup_rn = 1
