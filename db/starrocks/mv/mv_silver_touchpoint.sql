-- ============================================================
-- Brain V4 Phase 4a — StarRocks serving layer (Silver)
-- mv_silver_touchpoint — ASYNC materialized view over Iceberg Silver
--   source: brain_silver_local.brain_silver.silver_touchpoint
--   serving DB: brain_serving
-- ADDITIVE / dual-run: app still reads dbt brain_silver.silver_touchpoint today.
-- Phase 4b repoints readers to brain_serving.mv_silver_touchpoint.
-- No money columns; brand_id present; grain key = (brand_id, brain_anon_id, touch_seq).
-- ============================================================
CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_silver_touchpoint
COMMENT "V4 serving MV over Iceberg Silver silver_touchpoint"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
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
  session_id_raw,
  updated_at
FROM brain_silver_local.brain_silver.silver_touchpoint;
