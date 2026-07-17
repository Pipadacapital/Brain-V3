-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_silver_collector_event
--
-- ADR-0015 WS3 (identity in Silver): the Silver identity batch job
-- (apps/stream-worker/src/jobs/silver-identity/run.ts) reads NEW canonical keystone rows since a
-- per-brand watermark THROUGH this view over duckdb-serving — the established Node-side Silver
-- read path (mirrors jobs/dq/silver-reader.ts / journey-stitch-from-identity). A THIN projection
-- over the pre-materialized Iceberg keystone (brain_silver.silver_collector_event): the admitted,
-- deduped (brand_id, event_id) event set whose `payload` column is the full Bronze envelope JSON
-- the identity resolver consumes.
--
-- No money. Grain (brand_id, event_id). payload carries hashed identifiers only where the
-- envelope did; the identity stage never logs raw values (I-S02).
--
-- The stream-worker reads this as the two-part name brain_serving.mv_silver_collector_event; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is attached as
-- `iceberg`; local views shadow its namespace). brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_silver_collector_event AS
SELECT
  brand_id,
  event_id,
  event_type,
  event_category,
  occurred_at,
  ingested_at,
  anonymous_id,
  device_id,
  payload
FROM iceberg.brain_silver.silver_collector_event;
