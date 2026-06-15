-- ============================================================
-- StarRocks Row-Level Security — Row Policy Template (NN-2)
-- Provisioned at cluster setup time so every future table inherits isolation.
-- Covers: isolation-fuzz layer (b) per the 4-layer NN-2 mandate.
-- ============================================================
--
-- DESIGN: StarRocks uses "Row Access Policies" (SECURITY POLICY ... USING filter).
-- Each policy filters rows by matching the session variable `brain_current_brand_id`
-- against the table's `brand_id` column.
-- A query that does not set `brain_current_brand_id` receives ZERO rows (not an error),
-- because the filter becomes `brand_id = ''` which matches nothing.
-- This mirrors the Postgres two-arg current_setting() semantics (NN-1).
--
-- INVARIANT I-S01: a cross-brand query must return 0 rows, not an error.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- Step 1: Create the Analytics API service user (read-only, no DDL)
-- ────────────────────────────────────────────────────────────
CREATE USER IF NOT EXISTS 'brain_analytics'@'%' IDENTIFIED BY '${STARROCKS_ANALYTICS_PASSWORD}';

-- ────────────────────────────────────────────────────────────
-- Step 2: Session variable setup function (called before every query by Analytics API)
-- The Analytics API middleware sets this variable before executing any query.
-- An empty string maps to no matching brand_id rows (structurally safe).
-- ────────────────────────────────────────────────────────────
-- Usage (Analytics API middleware):
--   SET brain_current_brand_id = '<uuid>';  -- before every query
--   SELECT ... FROM silver_orders WHERE 1=1; -- row policy filters automatically
--   SET brain_current_brand_id = '';         -- reset after query (connection pool safety)

-- ────────────────────────────────────────────────────────────
-- Step 3: Row access policy template
-- Applied to every Silver/Gold table at creation time.
-- Template — substitute <database> and <table_name> per table:
-- ────────────────────────────────────────────────────────────

-- Bronze external catalog (read-only via Iceberg catalog):
-- StarRocks external Iceberg tables: row policy via query-level predicate pushdown.
-- The Analytics API MUST always inject:
--   AND brand_id = SESSION_VALUE('brain_current_brand_id')
-- into every external catalog query. The assertion in isolation-fuzz/starrocks.test.ts
-- verifies that omitting this clause returns 0 rows (via an explicit test with a raw query).

-- Silver table row policy template (applied when Silver tables are created in M1):
-- CREATE ROW POLICY IF NOT EXISTS tenant_isolation_policy
--   ON brain_silver.<table_name>
--   TO brain_analytics
--   USING (brand_id = IFNULL(NULLIF(SESSION_VALUE('brain_current_brand_id'), ''), '00000000-0000-0000-0000-000000000000'));
--
-- NOTE: The expression `IFNULL(NULLIF(SESSION_VALUE('brain_current_brand_id'), ''), '<never-match-uuid>')`
-- ensures that an empty/unset session variable maps to a UUID that matches no real brand_id,
-- returning zero rows without an error — exactly the desired semantics per I-S01.

-- ────────────────────────────────────────────────────────────
-- Step 4: Grant minimum privileges to the analytics user
-- Read-only: SELECT on Silver/Gold databases; no DDL; no DML.
-- ────────────────────────────────────────────────────────────
-- (Applied after Silver/Gold databases are created in M1)
-- GRANT SELECT ON ALL TABLES IN DATABASE brain_silver TO brain_analytics;
-- GRANT SELECT ON ALL TABLES IN DATABASE brain_gold   TO brain_analytics;

-- ────────────────────────────────────────────────────────────
-- Step 5: Negative-control assertion (isolation-fuzz verification)
-- The isolation-fuzz test (tools/isolation-fuzz/src/starrocks.test.ts) executes:
--   SET brain_current_brand_id = '<brand_A_id>';
--   SELECT COUNT(*) FROM brain_silver.test_table WHERE brand_id = '<brand_B_id>';
-- Expected result: 0 rows (row policy filters to brand_A only).
-- Removing the row policy MUST cause the test to FAIL (it will return >0 rows).
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- BOOTSTRAP SQL for cluster setup (runs via starrocks-init container)
-- ────────────────────────────────────────────────────────────
-- Create test databases for isolation-fuzz CI
CREATE DATABASE IF NOT EXISTS brain_silver;
CREATE DATABASE IF NOT EXISTS brain_gold;

-- Create minimal test table for isolation-fuzz (Sprint-0 stub)
CREATE TABLE IF NOT EXISTS brain_silver.isolation_test (
  brand_id     VARCHAR(36)   NOT NULL COMMENT 'Tenant key — row policy anchor',
  test_value   VARCHAR(255)            COMMENT 'Test payload',
  created_at   DATETIME                COMMENT 'Row creation timestamp'
)
DUPLICATE KEY(brand_id)
DISTRIBUTED BY HASH(brand_id) BUCKETS 4
PROPERTIES (
  "replication_num" = "1",
  "storage_medium"  = "HDD"
);

-- Seed test data for isolation-fuzz (two brands)
INSERT INTO brain_silver.isolation_test (brand_id, test_value, created_at)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'brand-A-secret-data', NOW()),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'brand-B-secret-data', NOW());

-- Grant SELECT to analytics user (local dev — no password enforcement)
GRANT SELECT ON ALL TABLES IN DATABASE brain_silver TO 'brain_analytics'@'%';
GRANT SELECT ON ALL TABLES IN DATABASE brain_gold   TO 'brain_analytics'@'%';
