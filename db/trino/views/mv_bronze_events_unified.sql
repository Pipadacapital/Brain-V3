-- G1 — unified READ-ONLY Bronze view over the ADR-0010 Kafka Connect tables (additive; the
-- ADR-0010 write path is unchanged — each lane still lands in its OWN Connect table).
--
-- UNION ALL over every Connect-written Bronze table that EXISTS: the collector lane
-- (collector_events_connect, envelope-JSON payload → brand_id lifted at query time) plus each
-- per-provider <lane>_raw_connect table (exploded envelope → brand_id is a real column).
--
-- Lanes appear as their tables auto-create; re-apply run-trino-views.sh after a new lane's
-- first record; NOT a replay source of record — operational audit surface only (exploded raw
-- lanes cannot reproduce wire bytes).
--
-- kafka_partition is CAST to bigint: the collector table stores integer, the raw lanes bigint —
-- UNION branches must agree.
--
-- Existing lanes at authoring time (SHOW TABLES FROM iceberg.brain_bronze LIKE '%_connect'):
--   collector_events_connect, shopify_orders_raw_connect
CREATE OR REPLACE VIEW iceberg.brain_bronze.events_unified AS
SELECT
  'collector'                                   AS connector,
  json_extract_scalar(payload, '$.brand_id')    AS brand_id,
  kafka_topic,
  CAST(kafka_partition AS bigint)               AS kafka_partition,
  kafka_offset
FROM iceberg.brain_bronze.collector_events_connect
UNION ALL
SELECT
  'shopify'                                     AS connector,
  brand_id,
  kafka_topic,
  CAST(kafka_partition AS bigint)               AS kafka_partition,
  kafka_offset
FROM iceberg.brain_bronze.shopify_orders_raw_connect
