-- analytics_grants.sql — idempotent SELECT grants for the read-only analytics user.
--
-- The BFF/metric-engine reads StarRocks as `brain_analytics` (SELECT-only). It must be able to read
-- EVERY mart regardless of how dbt materialized it. In StarRocks, TABLE, VIEW, and MATERIALIZED VIEW
-- are SEPARATE object types — `GRANT SELECT ON ALL TABLES` does NOT cover views, so a view-materialized
-- mart (e.g. brain_gold.gold_marketing_attribution) would 500 the attribution endpoints with
-- "Access denied … SELECT on VIEW …". Granting all three classes closes that gap for good.
--
-- Idempotent (GRANT + CREATE DATABASE IF NOT EXISTS) — safe to re-run. Mirrors bootstrap.sql §4 so a
-- fresh dev box that runs `make silver-catalog` (but not the full cluster bootstrap.sql) is covered.
-- Assumes the `brain_analytics` user already exists (created by bootstrap.sql / row_policy_template.sql
-- at cluster init). The databases are ensured here so the grants never fail on a not-yet-created schema.

CREATE DATABASE IF NOT EXISTS brain_silver;
CREATE DATABASE IF NOT EXISTS brain_gold;

GRANT SELECT ON ALL TABLES             IN DATABASE brain_silver TO 'brain_analytics'@'%';
GRANT SELECT ON ALL TABLES             IN DATABASE brain_gold   TO 'brain_analytics'@'%';
GRANT SELECT ON ALL VIEWS              IN DATABASE brain_silver TO 'brain_analytics'@'%';
GRANT SELECT ON ALL VIEWS              IN DATABASE brain_gold   TO 'brain_analytics'@'%';
GRANT SELECT ON ALL MATERIALIZED VIEWS IN DATABASE brain_silver TO 'brain_analytics'@'%';
GRANT SELECT ON ALL MATERIALIZED VIEWS IN DATABASE brain_gold   TO 'brain_analytics'@'%';
