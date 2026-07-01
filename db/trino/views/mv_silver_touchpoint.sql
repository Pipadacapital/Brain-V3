-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_silver_touchpoint
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_silver_touchpoint.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_silver.silver_touchpoint). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- No money. Grain (brand_id, brain_anon_id, touch_seq).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_silver_touchpoint;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_silver_touchpoint. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_silver_touchpoint AS
SELECT
  brand_id,
  brain_anon_id,
  touch_seq,
  session_key,
  session_seq,
  is_first_touch,
  is_last_touch,
  occurred_at,
  event_type,
  channel,
  utm_source,
  utm_medium,
  utm_campaign,
  utm_term,
  utm_content,
  fbclid,
  gclid,
  ttclid,
  msclkid,
  gbraid,
  wbraid,
  dclid,
  referrer_host,
  landing_path,
  page_type,
  product_handle,
  collection_handle,
  search_query,
  stitched_order_id,
  stitched_brain_id,
  is_synthetic,
  is_composite,
  session_id_raw,
  updated_at
FROM iceberg.brain_silver.silver_touchpoint;
