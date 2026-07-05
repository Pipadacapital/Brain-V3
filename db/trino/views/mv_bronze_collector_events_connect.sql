-- ADR-0010 — lift view over the Kafka Connect collector Bronze table.
--
-- The Connect Iceberg sink lands the collector lane TRULY RAW: verbatim envelope `payload` +
-- kafka coordinates, with NO lifted envelope scalars (unlike the Spark-written collector_events /
-- events tables). The operational Bronze readers (get-data-health / get-tracking-health /
-- get-recent-events via _bronze-source.ts, and the stream-worker DQ silver-reader) select
-- brand_id / event_type / occurred_at / ingested_at as real columns — this view lifts them at
-- query time so those readers work unchanged under BRONZE_SOURCE=connect. A `connector` dimension
-- (G1) is derived from the kafka topic name (`brain.<connector>.…` → segment 2), aligning this
-- lane with the per-lane *_raw_connect tables for cross-lane operational queries.
--
-- Trino dialect notes (see trino-serving-type-drift memory/PRs): ISO-8601 varchar → timestamp MUST
-- go through from_iso8601_timestamp (a bare CAST fails); CAST back to timestamp(6) keeps the
-- column type aligned with the Spark-written Bronze tables so downstream stringification is
-- byte-identical across BRONZE_SOURCE modes.
--
-- NOTE: created by run-trino-views.sh (continue-on-error) — it applies cleanly only after the
-- Connect sink's first commit auto-creates brain_bronze.collector_events_connect.
CREATE OR REPLACE VIEW iceberg.brain_bronze.collector_events_connect_lifted AS
SELECT
  json_extract_scalar(payload, '$.event_id')                              AS event_id,
  json_extract_scalar(payload, '$.brand_id')                              AS brand_id,
  json_extract_scalar(payload, '$.event_name')                            AS event_type,
  CAST(from_iso8601_timestamp(json_extract_scalar(payload, '$.occurred_at')) AS timestamp(6))  AS occurred_at,
  CAST(from_iso8601_timestamp(json_extract_scalar(payload, '$.ingested_at')) AS timestamp(6))  AS ingested_at,
  json_extract_scalar(payload, '$.correlation_id')                        AS correlation_id,
  payload,
  kafka_topic,
  kafka_partition,
  kafka_offset,
  split_part(kafka_topic, '.', 2) AS connector
FROM iceberg.brain_bronze.collector_events_connect
