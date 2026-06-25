-- analytics_grants.sql — idempotent SELECT grants for the read-only analytics user.
--
-- BRAIN V4: dbt is REMOVED and the dbt-internal brain_silver/brain_gold DBs are DROPPED
-- (db/starrocks/teardown/drop_dbt_internal_dbs.sql). The BFF/metric-engine reads StarRocks as
-- `brain_analytics` (SELECT-only) from exactly two places now:
--   • brain_serving — the mv_* async materialized views over the Iceberg medallion (the serving tier).
--   • brain_ops     — the StarRocks-native operational projections (identity/journey export, ML log).
-- In StarRocks, TABLE / VIEW / MATERIALIZED VIEW are SEPARATE object types — `GRANT SELECT ON ALL
-- TABLES` does NOT cover views — so grant all three classes (an MV-materialized mart would otherwise
-- 500 with "Access denied … SELECT on VIEW …"). Idempotent (GRANT + CREATE DATABASE IF NOT EXISTS),
-- safe to re-run. Assumes the `brain_analytics` user exists (created by bootstrap.sql at cluster init).

-- ── Brain V4 serving DB ─────────────────────────────────────────────────────────────────────────────
-- brain_serving holds the mv_* async materialized views the BFF reads. Without these grants the
-- read-only brain_analytics user 500s/empties on every brain_serving read.
CREATE DATABASE IF NOT EXISTS brain_serving;
GRANT SELECT ON ALL TABLES             IN DATABASE brain_serving TO 'brain_analytics'@'%';
GRANT SELECT ON ALL VIEWS              IN DATABASE brain_serving TO 'brain_analytics'@'%';
GRANT SELECT ON ALL MATERIALIZED VIEWS IN DATABASE brain_serving TO 'brain_analytics'@'%';

-- ── Brain V4 ops DB (ADDITIVE) ─────────────────────────────────────────────────────────────────────
-- brain_ops holds the StarRocks-native operational projections the V4 attribution chain reads as the
-- read-only analytics user: silver_identity_link + silver_customer_identity (the Neo4j identity export),
-- silver_journey_stitch (the cart-stitch export), the ML prediction log, and the identity-export
-- watermark. The journey-stitch-from-identity job reads brain_ops.silver_identity_link via the analytics
-- user; without this grant it 'Access denied … SELECT on … brain_ops' and stitches 0 rows → attribution
-- has no journeys to credit. Idempotent; SELECT-only (the export WRITERS connect as root, not this user).
CREATE DATABASE IF NOT EXISTS brain_ops;
GRANT SELECT ON ALL TABLES             IN DATABASE brain_ops TO 'brain_analytics'@'%';
GRANT SELECT ON ALL VIEWS              IN DATABASE brain_ops TO 'brain_analytics'@'%';
GRANT SELECT ON ALL MATERIALIZED VIEWS IN DATABASE brain_ops TO 'brain_analytics'@'%';
