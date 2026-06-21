-- ============================================================
-- Bronze table DDL — Apache Iceberg (local: Iceberg REST catalog; prod: AWS Glue)
-- INVARIANT I-E02: append-only, 24-month retention, partition spec fixed at creation.
-- Run via: spark-sql / iceberg REST / Glue API. For local dev use the Iceberg REST catalog
-- (compose `iceberg-rest` service, apache/iceberg-rest-fixture; ADR-0002).
-- ============================================================

-- Create the Bronze namespace (equivalent to a Glue database)
CREATE NAMESPACE IF NOT EXISTS brain_bronze;

-- ============================================================
-- Bronze collector events table
-- Partition spec: bucket(16, brand_id) + days(occurred_at)
--   - bucket(brand_id): tenant-scoped scan pruning; ~16 brand shards
--   - days(occurred_at): time-range pruning for daily/weekly backfills
-- Schema evolution: ADDITIVE-OPTIONAL only (I-E02, FULL_TRANSITIVE in Apicurio)
--   - NEVER drop a column
--   - NEVER change a column type to an incompatible type
--   - New columns MUST be nullable with a default
-- ============================================================
CREATE TABLE IF NOT EXISTS brain_bronze.collector_events (
  -- Tenant + idempotency
  event_id        STRING        NOT NULL COMMENT 'UUID v4 — idempotency key component: (brand_id, event_id)',
  brand_id        STRING        NOT NULL COMMENT 'UUID — tenant key. Partition bucket source. RLS anchor.',

  -- Event time fields
  occurred_at     TIMESTAMP     NOT NULL COMMENT 'Event time UTC. Partition days() source.',
  ingested_at     TIMESTAMP     NOT NULL COMMENT 'Collector spool time UTC. Watermark anchor.',

  -- Schema provenance
  schema_name     STRING        NOT NULL COMMENT 'Apicurio artifact ID.',
  schema_version  INT           NOT NULL COMMENT 'Apicurio schema version number.',

  -- Routing
  event_type      STRING        NOT NULL COMMENT 'Semantic event type: page_view, order_placed, etc.',
  correlation_id  STRING        NOT NULL COMMENT 'Distributed trace correlation ID.',
  partition_key   STRING        NOT NULL COMMENT 'brand_id:event_id — derived, stored for log correlation.',

  -- Payload (no raw PII per I-S02)
  payload         STRING        NOT NULL COMMENT 'JSON-encoded event body. No PII.',

  -- Optional / evolution-safe fields (added as nullable with defaults)
  processing_flags STRING                COMMENT 'JSON metadata from stream-worker. Null on first write.',
  collector_version STRING               COMMENT 'Collector deployment version. Nullable.'
)
USING iceberg
PARTITIONED BY (
  bucket(16, brand_id),
  days(occurred_at)
)
TBLPROPERTIES (
  'write.format.default'              = 'parquet',
  'write.parquet.compression-codec'  = 'zstd',
  'write.target-file-size-bytes'     = '134217728',
  'write.metadata.compression-codec' = 'gzip',
  'format-version'                   = '2',
  'write.upsert.enabled'             = 'false',

  -- 24-month rolling retention (I-E02)
  'history.expire.max-snapshot-age-ms'   = '63072000000',
  'history.expire.min-snapshots-to-keep' = '1',

  -- Object-storage per-brand prefix layout
  'write.object-storage.enabled' = 'true',

  -- Immutability annotation (informational — enforced by append-only writes in stream-worker)
  'brain.immutable'         = 'true',
  'brain.layer'             = 'bronze',
  'brain.retention.months'  = '24',
  'brain.schema.evolution'  = 'additive-optional-only'
);

-- ============================================================
-- VERIFICATION QUERY (run after table creation to confirm spec)
-- ============================================================
-- DESCRIBE EXTENDED brain_bronze.collector_events;
-- SHOW TBLPROPERTIES brain_bronze.collector_events;
