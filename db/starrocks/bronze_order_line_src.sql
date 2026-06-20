-- ============================================================================
-- bronze_order_line_src.sql — Postgres read-shim view for the StarRocks JDBC catalog.
-- feat-shopify-order-depth (Silver line-grain). APPLIED TO POSTGRES (not StarRocks).
--
-- WHY (mirrors bronze_touchpoint_src.sql): StarRocks' JDBC external catalog cannot read
--   Postgres `uuid` or `jsonb` columns (both surface as UNKNOWN_TYPE). bronze_events.brand_id
--   is uuid and .payload is jsonb. So we expose a read-only view that:
--     (1) picks the LATEST order.* event per (brand_id, order_id) — live order events are
--         per-state rows keyed by updated_at, so the newest occurred_at is the current order;
--     (2) UNNESTS that event's payload.properties.line_items array (jsonb_array_elements
--         WITH ORDINALITY) into ONE ROW PER LINE — the line grain;
--     (3) casts every output column to text / int / bigint / timestamp (NO jsonb leaves the
--         view), so the JDBC catalog can read it. The dbt staging model just types/dedups.
--
-- WHY UNNEST HERE (not in StarRocks): the touchpoint precedent extracts SCALAR JSON in
--   StarRocks via get_json_string. Line items are an ARRAY; Postgres jsonb_array_elements is
--   the clean, deterministic unnest. Doing it in the shim keeps the StarRocks SQL flat and
--   avoids StarRocks JSON-array unnest. (PROD swaps this for the Iceberg Bronze read, which
--   unnests natively — this shim is the documented dev/transition boundary, like the others.)
--
-- GRAIN: one row per (brand_id, order_id, line_index). The order_id natural key + the 1-based
--   ordinal within the latest order event's line_items. Replay-stable: the latest-event pick
--   has a deterministic tiebreak (occurred_at desc, event_id desc) and ordinality is stable.
--
-- MONEY (I-S07): unit_price_minor / line_total_minor / line_discount_minor are the mapper's
--   minor-unit BIGINT-as-string values (feat-shopify-order-depth) — exposed as text, cast to
--   BIGINT in staging. No float ever.
--
-- ADDITIVE + REVERSIBLE: CREATE OR REPLACE VIEW; rollback = `DROP VIEW IF EXISTS
--   bronze_order_line_src;`. Dev read-shim, NOT a node-pg-migrate migration (no migration
--   number) — applied by `make orderline-catalog`, exactly like the touchpoint shim.
--
-- DEV BOUNDARY (honest, identical to the other sources): the JDBC catalog connects to
--   Postgres as superuser `brain`, which BYPASSES RLS → this source is CROSS-BRAND by design
--   (dbt is the ETL writer for ALL brands). Per-brand isolation is enforced downstream at the
--   metric-engine Silver READ seam (I-ST01), NEVER here.
-- ============================================================================

DROP VIEW IF EXISTS bronze_order_line_src;
CREATE VIEW bronze_order_line_src AS
WITH latest_order AS (
    -- The current state of each order: the newest order.* event carrying line_items.
    SELECT DISTINCT ON (brand_id, COALESCE(payload->'properties'->>'order_id', payload->>'order_id'))
        brand_id,
        event_id,
        occurred_at,
        COALESCE(payload->'properties'->>'order_id', payload->>'order_id') AS order_id,
        payload->'properties'->>'currency_code'                            AS currency_code,
        payload->'properties'->'line_items'                                AS line_items
    FROM bronze_events
    WHERE event_type LIKE 'order.%'
      AND jsonb_typeof(payload->'properties'->'line_items') = 'array'
    ORDER BY
        brand_id,
        COALESCE(payload->'properties'->>'order_id', payload->>'order_id'),
        occurred_at DESC,
        event_id   DESC      -- deterministic tiebreak (replay-stable)
)
SELECT
    lo.brand_id::text                       AS brand_id,
    lo.event_id::text                       AS event_id,
    lo.order_id                             AS order_id,
    lo.currency_code                        AS currency_code,
    lo.occurred_at                          AS occurred_at,
    li.ord::int                             AS line_index,      -- 1-based ordinal in line_items
    li.item->>'sku'                         AS sku,
    li.item->>'title'                       AS title,
    COALESCE((li.item->>'quantity'), '0')   AS quantity,        -- text → cast to BIGINT in staging
    COALESCE((li.item->>'unit_price_minor'), '0')   AS unit_price_minor,
    COALESCE((li.item->>'line_total_minor'), '0')   AS line_total_minor,
    COALESCE((li.item->>'line_discount_minor'), '0') AS line_discount_minor,
    li.item->>'product_id'                  AS product_id,
    li.item->>'variant_id'                  AS variant_id
FROM latest_order lo
CROSS JOIN LATERAL jsonb_array_elements(lo.line_items) WITH ORDINALITY AS li(item, ord);

GRANT SELECT ON bronze_order_line_src TO brain;
