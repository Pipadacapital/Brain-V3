-- ops_silver_customer_identity.sql — the StarRocks-side export of the Neo4j Customer nodes (Epic 3/4).
--
-- BRAIN V4 PHASE 6a RELOCATION: this is the SAME table that previously lived in the dbt-internal
-- brain_silver database (db/starrocks/silver_customer_identity.sql → brain_silver.silver_customer_identity).
-- brain_silver is being RETIRED in Phase 6b. This table is NOT a dbt-derived Silver mart — it is an
-- APPLICATION-WRITTEN operational projection (the identity-export job TRUNCATE+INSERTs the Neo4j Customer
-- nodes into it directly). Its V4 home is the operational StarRocks database brain_ops, alongside the
-- other app-owned operational StarRocks state (silver_identity_link / silver_journey_stitch /
-- identity_export_state / ops_ml_prediction_log). Moving it here lets brain_silver be dropped in 6b.
--
-- MEDALLION REALIGNMENT (ADR-0004): identity is the Neo4j SoR; dbt/StarRocks can't read it. The customer
-- marts (silver_customers) need per-customer acquisition/lifecycle attributes (first_identified_at,
-- lifecycle_state, merged_into, minted_at). The identity-export job materializes the Neo4j Customer nodes
-- into THIS table, which silver_customers reads instead of the dropped PG identity.customer JDBC shim
-- (silver_customer_identity_src, removed).
--
-- NOTE: the Iceberg projection brain_silver_local.brain_silver.silver_customer_identity (built by the
-- Spark job db/iceberg/spark/silver/silver_customer_identity.py) and the serving MV
-- brain_serving.mv_silver_customer_identity are SEPARATE objects and are UNAFFECTED by this relocation.
--
-- One row per (brand_id, brain_id). Per-brand isolation at the read seam.
--
-- Moved VERBATIM — only the database changes (brain_silver → brain_ops). Schema/keys/distribution
-- unchanged. Idempotent DDL (CREATE ... IF NOT EXISTS) — applied by db/starrocks/ops/run_ops.sh.

CREATE DATABASE IF NOT EXISTS brain_ops;

CREATE TABLE IF NOT EXISTS brain_ops.silver_customer_identity (
  brand_id             varchar(64) NOT NULL,
  brain_id             varchar(64) NOT NULL,
  lifecycle_state      varchar(16),
  merged_into          varchar(64),
  minted_at            datetime,
  first_identified_at  datetime,
  updated_at           datetime
)
PRIMARY KEY (brand_id, brain_id)
DISTRIBUTED BY HASH(brand_id) BUCKETS 8
PROPERTIES ("replication_num" = "1", "enable_persistent_index" = "true");
