-- ============================================================
-- StarRocks External Iceberg Catalogs — Silver + Gold read path
-- Brain V4 Phase 0 (Area B). ADDITIVE — does NOT modify external_iceberg_catalog.sql
-- (the Bronze catalog brain_bronze_local) or any existing catalog.
--
-- ADR-002 one-way rule still holds: Iceberg → dbt → StarRocks → Analytics API.
-- StarRocks → Iceberg writes are FORBIDDEN; these catalogs are READ-ONLY views of the
-- Spark-written Iceberg Silver/Gold namespaces, the source for later async materialized views.
--
-- Local substrate note: the single local Iceberg REST catalog (compose `iceberg-rest`) exposes
-- ALL namespaces (brain_bronze, brain_silver, brain_gold) over one MinIO warehouse. Each StarRocks
-- external catalog below points at that SAME REST endpoint; the namespace selects the medallion
-- layer. Separate catalogs (vs. one shared) mirror the production Glue structure, where each layer
-- gets its own catalog/bucket — so SQL that says brain_silver_local.brain_silver.<t> stays portable.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- LOCAL DEV: Iceberg REST catalog (apache/iceberg-rest-fixture) + MinIO S3 — SILVER
-- Property names use UNDERSCORES (access_key, not access-key); aws.s3.region + client.factory are
-- BOTH required for the REST-catalog → MinIO read to resolve creds/region (see the Bronze catalog
-- file for the why). Identical config to brain_bronze_local — only the catalog name differs.
-- ────────────────────────────────────────────────────────────
CREATE EXTERNAL CATALOG IF NOT EXISTS brain_silver_local
COMMENT "Local dev Silver catalog — Iceberg REST + MinIO (mirrors production Glue structure)"
PROPERTIES (
  "type"                    = "iceberg",
  "iceberg.catalog.type"    = "rest",
  "iceberg.catalog.uri"     = "http://iceberg-rest:8181",
  "aws.s3.region"           = "us-east-1",
  "aws.s3.endpoint"         = "http://minio:9000",
  "aws.s3.access_key"       = "brain",
  "aws.s3.secret_key"       = "brainbrain",
  "aws.s3.enable_ssl"       = "false",
  "aws.s3.enable_path_style_access" = "true",
  "client.factory"          = "com.starrocks.connector.iceberg.IcebergAwsClientFactory"
);

-- ────────────────────────────────────────────────────────────
-- LOCAL DEV: Iceberg REST catalog + MinIO S3 — GOLD
-- ────────────────────────────────────────────────────────────
CREATE EXTERNAL CATALOG IF NOT EXISTS brain_gold_local
COMMENT "Local dev Gold catalog — Iceberg REST + MinIO (mirrors production Glue structure)"
PROPERTIES (
  "type"                    = "iceberg",
  "iceberg.catalog.type"    = "rest",
  "iceberg.catalog.uri"     = "http://iceberg-rest:8181",
  "aws.s3.region"           = "us-east-1",
  "aws.s3.endpoint"         = "http://minio:9000",
  "aws.s3.access_key"       = "brain",
  "aws.s3.secret_key"       = "brainbrain",
  "aws.s3.enable_ssl"       = "false",
  "aws.s3.enable_path_style_access" = "true",
  "client.factory"          = "com.starrocks.connector.iceberg.IcebergAwsClientFactory"
);

-- ────────────────────────────────────────────────────────────
-- PRODUCTION: AWS Glue catalogs + S3 (Terraform-provisioned per-layer buckets; not applied locally)
-- Replace environment variables at deploy time via External Secrets / config map.
-- ────────────────────────────────────────────────────────────
-- CREATE EXTERNAL CATALOG IF NOT EXISTS brain_silver_prod
-- COMMENT "Production Silver catalog — AWS Glue + S3 ap-south-1"
-- PROPERTIES (
--   "type"                    = "iceberg",
--   "iceberg.catalog.type"    = "glue",
--   "aws.glue.catalog-id"     = "${GLUE_CATALOG_ID}",
--   "aws.region"              = "ap-south-1",
--   "aws.s3.region"           = "ap-south-1",
--   "client.factory"          = "com.starrocks.connector.iceberg.IcebergAwsClientFactory"
-- );
-- CREATE EXTERNAL CATALOG IF NOT EXISTS brain_gold_prod
-- COMMENT "Production Gold catalog — AWS Glue + S3 ap-south-1"
-- PROPERTIES (
--   "type"                    = "iceberg",
--   "iceberg.catalog.type"    = "glue",
--   "aws.glue.catalog-id"     = "${GLUE_CATALOG_ID}",
--   "aws.region"              = "ap-south-1",
--   "aws.s3.region"           = "ap-south-1",
--   "client.factory"          = "com.starrocks.connector.iceberg.IcebergAwsClientFactory"
-- );

-- ────────────────────────────────────────────────────────────
-- VERIFICATION — prove connectivity (run after provision_silver_gold.py has created the namespaces):
-- ────────────────────────────────────────────────────────────
-- SHOW DATABASES FROM brain_silver_local;                       -- expect: brain_silver
-- SHOW TABLES   FROM brain_silver_local.brain_silver;           -- expect: _provision_check
-- SHOW DATABASES FROM brain_gold_local;                         -- expect: brain_gold
-- SHOW TABLES   FROM brain_gold_local.brain_gold;               -- expect: _provision_check
-- SELECT COUNT(*) FROM brain_silver_local.brain_silver._provision_check;  -- expect: 0 (empty)
-- SELECT COUNT(*) FROM brain_gold_local.brain_gold._provision_check;      -- expect: 0 (empty)
