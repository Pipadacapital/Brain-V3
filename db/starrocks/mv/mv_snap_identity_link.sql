-- ============================================================
-- Brain V4 — StarRocks serving layer
-- mv_snap_identity_link — ASYNC materialized view over the Iceberg AS-OF identity-link snapshot
--   source: brain_gold_local.brain_silver.snap_identity_link
--     (snap_identity_link is materialized in the brain_silver namespace; read here through the
--      brain_gold_local catalog, which exposes every namespace over the same REST endpoint)
--   serving DB: brain_serving
-- The app/BFF/metric-engine read ONLY this MV — never the bare Iceberg table.
-- AS-OF read: SELECT ... WHERE snapshot_date <= :as_of, latest row per identifier (see _snap_as_of.py).
-- NO money (an identity mapping carries none); identifier_value is a 64-hex HASH (never raw PII);
-- brand_id present; grain key = (brand_id, identifier_type, identifier_value, snapshot_date).
-- ============================================================
CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_snap_identity_link
COMMENT "V4 serving MV over Iceberg snap_identity_link (point-in-time identity-link AS-OF snapshot; hash-only, no money)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  identifier_type,
  identifier_value,
  snapshot_date,
  brain_id,
  is_active,
  computed_at
FROM brain_gold_local.brain_silver.snap_identity_link;
