-- ============================================================
-- StarRocks External Iceberg Catalog — Bronze read path (EC3)
-- ADR-002: one-way Iceberg → dbt → StarRocks → Analytics API.
-- StarRocks → Iceberg is FORBIDDEN.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- LOCAL DEV: Iceberg REST catalog (apache/iceberg-rest-fixture) + MinIO S3
-- Catalog host = the compose `iceberg-rest` service (ADR-0002); REST base on :8181.
-- ────────────────────────────────────────────────────────────
CREATE EXTERNAL CATALOG IF NOT EXISTS brain_bronze_local
COMMENT "Local dev Bronze catalog — Iceberg REST + MinIO (mirrors production Glue structure)"
PROPERTIES (
  "type"                    = "iceberg",
  "iceberg.catalog.type"    = "rest",
  "iceberg.catalog.uri"     = "http://iceberg-rest:8181",
  "aws.s3.endpoint"         = "http://minio:9000",
  "aws.s3.access-key"       = "brain",
  "aws.s3.secret-key"       = "brainbrain",
  "aws.s3.enable-ssl"       = "false",
  "aws.s3.enable-path-style-access" = "true",
  "client.factory"          = "com.starrocks.connector.iceberg.IcebergAwsClientFactory"
);

-- ────────────────────────────────────────────────────────────
-- PRODUCTION: AWS Glue catalog + S3
-- Replace environment variables at deploy time via External Secrets / config map.
-- ────────────────────────────────────────────────────────────
-- CREATE EXTERNAL CATALOG IF NOT EXISTS brain_bronze_prod
-- COMMENT "Production Bronze catalog — AWS Glue + S3 ap-south-1"
-- PROPERTIES (
--   "type"                    = "iceberg",
--   "iceberg.catalog.type"    = "glue",
--   "aws.glue.catalog-id"     = "${GLUE_CATALOG_ID}",
--   "aws.region"              = "ap-south-1",
--   "aws.s3.region"           = "ap-south-1",
--   "client.factory"          = "com.starrocks.connector.iceberg.IcebergAwsClientFactory"
-- );

-- ────────────────────────────────────────────────────────────
-- Set active catalog for session (switch per environment)
-- ────────────────────────────────────────────────────────────
-- SET CATALOG brain_bronze_local;  -- local dev
-- SET CATALOG brain_bronze_prod;   -- production (via env config)

-- ────────────────────────────────────────────────────────────
-- VERIFICATION — prove EC3 connectivity
-- Run this after catalog creation and bronze_spec applied:
-- ────────────────────────────────────────────────────────────
-- SHOW DATABASES FROM brain_bronze_local;
-- SHOW TABLES FROM brain_bronze_local.brain_bronze;
-- SELECT brand_id, COUNT(*) AS event_count
--   FROM brain_bronze_local.brain_bronze.collector_events
--  WHERE brand_id = '00000000-0000-0000-0000-000000000001'  -- test brand A
--  GROUP BY brand_id;
