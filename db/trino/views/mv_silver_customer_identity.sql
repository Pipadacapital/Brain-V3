-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_silver_customer_identity
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_silver_customer_identity.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_silver.silver_customer_identity). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- No money. StarRocks-side export of the Neo4j identity SoR (ADR-0004); serves the exported snapshot. Grain (brand_id, brain_id).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_silver_customer_identity;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_silver_customer_identity. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_silver_customer_identity AS
SELECT
  brand_id,
  brain_id,
  lifecycle_state,
  merged_into,
  minted_at,
  first_identified_at,
  updated_at
FROM iceberg.brain_silver.silver_customer_identity;
