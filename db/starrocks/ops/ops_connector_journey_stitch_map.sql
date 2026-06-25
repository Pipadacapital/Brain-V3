-- ============================================================================
-- ops_connector_journey_stitch_map.sql — the JDBC live-read shim over the PG
-- cart-stitch lookup, relocated OFF the retiring dbt brain_silver database into
-- the operational StarRocks database brain_ops.
--
-- BRAIN V4 PHASE 6b RELOCATION (brain_silver retirement): this is the SAME live-read
-- shim that journey-mix's request-time touchpoint timeline used to reference as
-- `brain_silver.connector_journey_stitch_map`. It is NOT a dbt-derived Silver mart and it
-- is NOT the materialized projection (that is brain_ops.silver_journey_stitch, written by
-- the journey-stitch-export job). It is a thin, LIVE read-back of the PG OLTP truth used
-- for the deterministic order→anon resolution at dashboard-read time (D-5). Moving it here
-- removes the last `brain_silver.*` read from metric-engine so brain_silver can be DROPPED.
--
-- WHAT IT SHIMS: connectors.connector_journey_stitch_map (PG OLTP, migration 0031 +
--   schema-move 0063) — the deterministic anon↔order↔brain_id cart-stitch, written by the
--   order webhooks (note_attributes read-back) + the journey-stitch-from-identity cron.
--   The table STAYS on PG (it is OLTP); only the ANALYTICAL read alias moves to brain_ops.
--
-- MECHANISM (mirrors the existing JDBC read-shims — oltp_pg_read_shim.sql):
--   StarRocks' JDBC external catalog (brain_oltp_pg) CANNOT read Postgres `uuid` columns
--   (brand_id/brain_id surface as UNKNOWN_TYPE → any SELECT errors
--   "Datatype of external table column [brand_id] is not supported!"). So the shim is two
--   parts, exactly like every other PG JDBC read-shim:
--     1. a PG-side cast VIEW connectors.connector_journey_stitch_map_src (brand_id::text),
--        created in db/starrocks/oltp_pg_read_shim.sql (applied by `make silver-catalog`);
--     2. THIS StarRocks VIEW brain_ops.connector_journey_stitch_map over that JDBC src view.
--   Only the three columns the journey-timeline read needs are projected
--   (brand_id, order_id, stitched_anon_id) — the click_ids/utms jsonb (also UNKNOWN_TYPE)
--   and the resolved brain_id are not needed by this read path and stay out of the shim.
--
-- Per-brand isolation: StarRocks has no RLS — isolation is enforced at the metric-engine
--   READ seam (I-ST01): the reader injects `brand_id = ?` via the ${BRAND_PREDICATE}
--   sentinel and the correlated subselect pins the same brand by column equality
--   (m.brand_id = mv_silver_touchpoint.brand_id). The JDBC catalog connects as superuser
--   `brain` (RLS-bypass, ETL-writer posture) — cross-brand BY CONSTRUCTION at this layer,
--   scoped at the read seam, exactly like the prior brain_silver home.
--
-- ADDITIVE / idempotent / reversible: CREATE DATABASE/VIEW IF NOT EXISTS. Rollback =
--   `DROP VIEW IF EXISTS brain_ops.connector_journey_stitch_map;` (+ drop the PG src view).
--   Applied by db/starrocks/ops/run_ops.sh. Does NOT touch the brain_*_local Iceberg
--   catalogs, brain_serving, the dbt internal DBs, or any other brain_ops table.
--
-- PROD SWAP (documented intent): when the touchpoint journey-stitch lands in the Iceberg
--   lakehouse natively, this view re-points to the Iceberg source with no reader change —
--   the boundary is isolated here, exactly like the other JDBC read-shims.
-- ============================================================================

CREATE DATABASE IF NOT EXISTS brain_ops;

-- LIVE read-back shim over the PG cart-stitch (via the brain_oltp_pg JDBC catalog +
-- the connectors.connector_journey_stitch_map_src uuid→text cast view).
CREATE VIEW IF NOT EXISTS brain_ops.connector_journey_stitch_map AS
SELECT
  brand_id,           -- text (cast PG uuid→text in the connector_journey_stitch_map_src view)
  order_id,           -- Brain ledger spine key (= ledger.order_id)
  stitched_anon_id    -- brain_anon_id read BACK from the order note_attributes (D-5)
FROM brain_oltp_pg.connectors.connector_journey_stitch_map_src;
