-- ============================================================
-- StarRocks bootstrap — runs via starrocks-init container at cluster startup (NN-2).
-- Idempotent (IF NOT EXISTS throughout).
-- Sets up:
--   1. Analytics read-only user
--   2. Silver/Gold databases
--   3. Isolation test table + seed data (for isolation-fuzz CI)
--   4. External Iceberg catalog (local dev — Iceberg REST + MinIO)
-- ============================================================

-- 1. Analytics service user (read-only)
CREATE USER IF NOT EXISTS 'brain_analytics'@'%' IDENTIFIED BY 'brain_analytics_dev';

-- 2. Silver / Gold databases
CREATE DATABASE IF NOT EXISTS brain_silver;
CREATE DATABASE IF NOT EXISTS brain_gold;

-- 3. Isolation test table (for tools/isolation-fuzz/src/starrocks.test.ts)
CREATE TABLE IF NOT EXISTS brain_silver.isolation_test (
  brand_id     VARCHAR(36)   NOT NULL COMMENT 'Tenant key — row policy enforcement anchor',
  test_value   VARCHAR(255)            COMMENT 'Simulated private row data',
  created_at   DATETIME                COMMENT 'Row creation timestamp'
)
DUPLICATE KEY(brand_id)
DISTRIBUTED BY HASH(brand_id) BUCKETS 4
PROPERTIES (
  "replication_num" = "1",
  "storage_medium"  = "HDD"
);

-- Seed two brands' test data
INSERT INTO brain_silver.isolation_test (brand_id, test_value, created_at)
SELECT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'brand-A-secret-data', NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM brain_silver.isolation_test
   WHERE brand_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
);

INSERT INTO brain_silver.isolation_test (brand_id, test_value, created_at)
SELECT 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'brand-B-secret-data', NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM brain_silver.isolation_test
   WHERE brand_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
);

-- 4. Grants
GRANT SELECT ON ALL TABLES IN DATABASE brain_silver TO 'brain_analytics'@'%';
GRANT SELECT ON ALL TABLES IN DATABASE brain_gold   TO 'brain_analytics'@'%';

-- 4a. Row Policy (NN-2 engine-level enforcement — M-01)
-- ============================================================
-- CREATE ROW POLICY is an enterprise/managed StarRocks feature.
-- StarRocks 3.3.2 allin1 (open-source, used in local dev) does NOT support it.
-- On a StarRocks Enterprise or managed cluster, apply the following:
--
--   CREATE ROW POLICY IF NOT EXISTS tenant_isolation_policy
--     ON brain_silver.isolation_test
--     TO 'brain_analytics'@'%'
--     USING (brand_id = IFNULL(NULLIF(@brain_current_brand_id, ''),
--                               '00000000-0000-0000-0000-000000000000'));
--
-- M1 STEP: Apply the above on the production/staging StarRocks cluster.
-- Until applied, tools/isolation-fuzz/src/starrocks.test.ts will FAIL LOUD
-- on the plain-SELECT negative-control tests (correct behavior — not silently green).
-- ============================================================

-- 5. External Iceberg catalog (local dev — Iceberg REST + MinIO; ADR-0002)
-- Underscore property names + aws.s3.region + client.factory are ALL required (Slice 4): the hyphen
-- form is ignored → StarRocks falls back to the default AWS chain → "Region must be specified".
-- VERIFIED reading collector_events through this catalog.
CREATE EXTERNAL CATALOG IF NOT EXISTS brain_bronze_local
COMMENT "Local dev Bronze catalog — Iceberg REST + MinIO"
PROPERTIES (
  "type"                              = "iceberg",
  "iceberg.catalog.type"             = "rest",
  "iceberg.catalog.uri"              = "http://iceberg-rest:8181",
  "aws.s3.region"                    = "us-east-1",
  "aws.s3.endpoint"                  = "http://minio:9000",
  "aws.s3.access_key"                = "brain",
  "aws.s3.secret_key"                = "brainbrain",
  "aws.s3.enable_ssl"                = "false",
  "aws.s3.enable_path_style_access"  = "true",
  "client.factory"                   = "com.starrocks.connector.iceberg.IcebergAwsClientFactory"
);

SELECT 'StarRocks bootstrap complete' AS status;
