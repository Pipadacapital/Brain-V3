-- ============================================================
-- StarRocks bootstrap — runs via starrocks-init container at cluster startup (NN-2).
-- Idempotent (IF NOT EXISTS throughout).
--
-- BRAIN V4: dbt is REMOVED. The medallion (Silver/Gold) lives in the EXTERNAL Iceberg catalogs
-- (brain_*_local) and is SERVED to the app by the StarRocks async MVs in brain_serving. The only
-- StarRocks-NATIVE app state is the operational DB brain_ops (see db/starrocks/ops/). This bootstrap
-- therefore NO LONGER creates the retired dbt-internal brain_silver / brain_gold databases
-- (db/starrocks/teardown/drop_dbt_internal_dbs.sql).
--
-- Sets up:
--   1. Analytics read-only user
--   2. Operational DB (brain_ops) + the isolation-fuzz test table (relocated off the retired brain_silver)
--   3. External Iceberg Bronze catalog (local dev — Iceberg REST + MinIO) + its grant
-- (The brain_serving MVs are created by db/starrocks/mv/*.sql; the rest of brain_ops by
--  db/starrocks/ops/*.sql — both run separately, not here.)
-- ============================================================

-- 1. Analytics service user (read-only)
CREATE USER IF NOT EXISTS 'brain_analytics'@'%' IDENTIFIED BY 'brain_analytics_dev';

-- 2. Operational DB + isolation-fuzz test table
--    V4: isolation_test is a StarRocks-native operational fixture → it lives in brain_ops, NOT in the
--    retired dbt brain_silver DB. (tools/isolation-fuzz/src/starrocks.test.ts reads brain_ops.isolation_test.)
CREATE DATABASE IF NOT EXISTS brain_ops;

CREATE TABLE IF NOT EXISTS brain_ops.isolation_test (
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
INSERT INTO brain_ops.isolation_test (brand_id, test_value, created_at)
SELECT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'brand-A-secret-data', NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM brain_ops.isolation_test
   WHERE brand_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
);

INSERT INTO brain_ops.isolation_test (brand_id, test_value, created_at)
SELECT 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'brand-B-secret-data', NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM brain_ops.isolation_test
   WHERE brand_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
);

-- Grants: the analytics user reads the serving MVs (brain_serving) + operational tables (brain_ops).
-- VIEWS + MATERIALIZED VIEWS are SEPARATE object types in StarRocks — "ALL TABLES" does NOT cover them,
-- so grant every class. brain_serving is created by db/starrocks/mv/*.sql; guard the grants with a
-- CREATE DATABASE IF NOT EXISTS so this bootstrap is order-independent.
CREATE DATABASE IF NOT EXISTS brain_serving;
GRANT SELECT ON ALL TABLES             IN DATABASE brain_serving TO 'brain_analytics'@'%';
GRANT SELECT ON ALL VIEWS              IN DATABASE brain_serving TO 'brain_analytics'@'%';
GRANT SELECT ON ALL MATERIALIZED VIEWS IN DATABASE brain_serving TO 'brain_analytics'@'%';
GRANT SELECT ON ALL TABLES             IN DATABASE brain_ops     TO 'brain_analytics'@'%';

-- 2a. Row Policy (NN-2 engine-level enforcement — M-01)
-- ============================================================
-- CREATE ROW POLICY is an enterprise/managed StarRocks feature.
-- StarRocks 3.3.2 allin1 (open-source, used in local dev) does NOT support it.
-- On a StarRocks Enterprise or managed cluster, apply the following:
--
--   CREATE ROW POLICY IF NOT EXISTS tenant_isolation_policy
--     ON brain_ops.isolation_test
--     TO 'brain_analytics'@'%'
--     USING (brand_id = IFNULL(NULLIF(@brain_current_brand_id, ''),
--                               '00000000-0000-0000-0000-000000000000'));
--
-- M1 STEP: Apply the above on the production/staging StarRocks cluster.
-- Until applied, tools/isolation-fuzz/src/starrocks.test.ts will FAIL LOUD
-- on the plain-SELECT negative-control tests (correct behavior — not silently green).
-- ============================================================

-- 3. External Iceberg catalog (local dev — Iceberg REST + MinIO; ADR-0002)
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

-- 4. Grant brain_analytics SELECT on the Iceberg Bronze catalog (Slice 5 / ADR-0002): the core
-- operational reads (data/tracking health, recent events, orders) read collector_events from this
-- catalog as the SELECT-only brain_analytics user. SET CATALOG first — the "GRANT … IN ALL DATABASES"
-- form applies to the ACTIVE catalog (StarRocks 3.3 has no "OF CATALOG" clause).
GRANT USAGE ON CATALOG brain_bronze_local TO 'brain_analytics'@'%';
SET CATALOG brain_bronze_local;
GRANT SELECT ON ALL TABLES IN ALL DATABASES TO 'brain_analytics'@'%';
SET CATALOG default_catalog;

SELECT 'StarRocks bootstrap complete' AS status;
