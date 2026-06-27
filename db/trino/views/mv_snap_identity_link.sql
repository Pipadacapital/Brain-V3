-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_snap_identity_link
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_snap_identity_link.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_silver.snap_identity_link). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- AS-OF identity-link snapshot (SILVER namespace). NO money; identifier_value is a 64-hex HASH (never raw PII). Key (brand_id, identifier_type, identifier_value, snapshot_date).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_snap_identity_link;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_snap_identity_link. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_snap_identity_link AS
SELECT
  brand_id,
  identifier_type,
  identifier_value,
  snapshot_date,
  brain_id,
  is_active,
  computed_at
FROM iceberg.brain_silver.snap_identity_link;
