-- ============================================================================
-- bronze_touchpoint_src.sql — Postgres read-shim view for the StarRocks JDBC catalog.
-- feat-journey-touchpoint (Stage 3, @data-engineer). APPLIED TO POSTGRES (not StarRocks).
--
-- WHY (mirrors oltp_pg_read_shim.sql): StarRocks' JDBC external catalog cannot read
--   Postgres `uuid` columns OR `jsonb` columns (both surface as UNKNOWN_TYPE — any
--   SELECT errors "Datatype of external table column is not supported!").
--   `bronze_events.brand_id`/`.event_id` are uuid and `.payload` is jsonb. So we expose a
--   read-only view that casts uuid→text AND jsonb→text, and pre-filters to the journey
--   event_types. The dbt staging model re-parses the text payload with StarRocks
--   get_json_string(parse_json(payload), ...) to extract fields.
--
-- WHAT: the SDK journey signal lives entirely inside payload.properties
--   (packages/pixel-sdk/src/capture.ts:56-77 — the exact pixel shape):
--     properties.brain_anon_id   (TEXT — the anon journey key)
--     properties.session_id      (TEXT — SDK 30-min session; we RE-DERIVE, architecture §2)
--     properties.utm.*           ({source,medium,campaign,term,content})
--     properties.click_ids.*     ({fbclid,gclid,ttclid})
--     properties.referrer, .landing_path
--     properties._synthetic      (BOOL — dev-honesty flag on the journey_synthetic seed; NULL on real)
--
-- ADDITIVE + REVERSIBLE: CREATE OR REPLACE VIEW; rollback = `DROP VIEW IF EXISTS
--   bronze_touchpoint_src;`. This is a dev read-shim, NOT a node-pg-migrate migration
--   (consumes NO migration number) — applied by `make journey-catalog`, exactly like
--   the order shim.
--
-- DEV BOUNDARY (honest, identical to the order_state source): the JDBC catalog connects
--   to Postgres as superuser `brain`, which BYPASSES RLS → this source is CROSS-BRAND by
--   construction. That is the correct ETL-writer posture (dbt builds Silver for ALL brands).
--   Per-brand isolation is enforced downstream at the metric-engine READ seam (I-ST01),
--   NEVER here.
--
-- PROD SWAP: in prod the staging source reads the Iceberg Bronze catalog (native string
--   brand_id) — this shim is dev/transition-only and disappears with no downstream change.
-- ============================================================================

-- DROP first: CREATE OR REPLACE cannot change a column's type (jsonb→text), so on
-- re-apply we drop and recreate. Idempotent + reversible.
DROP VIEW IF EXISTS bronze_touchpoint_src;
CREATE VIEW bronze_touchpoint_src AS
SELECT
    brand_id::text   AS brand_id,
    event_id::text   AS event_id,
    event_type,
    occurred_at,
    payload::text    AS payload   -- jsonb→text (JDBC cannot read jsonb); re-parsed in StarRocks
FROM bronze_events
WHERE event_type IN ('page.viewed', 'cart.viewed', 'cart.item_added');

GRANT SELECT ON bronze_touchpoint_src TO brain;

-- MEDALLION REALIGNMENT (Epic 4): the connector_journey_stitch_map_src read-shim that used to live here
-- was REMOVED. The cart-stitch is materialized into brain_silver.silver_journey_stitch by the
-- journey-stitch-export job (PG capture → StarRocks); silver_touchpoint reads that StarRocks projection
-- directly, so there is no PG stitch shim to create. (The bronze_touchpoint_src view above belongs to the
-- separate Iceberg-Bronze retirement — dev/PG-mode only; prod reads Iceberg Bronze.)
