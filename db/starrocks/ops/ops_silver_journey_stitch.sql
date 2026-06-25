-- ops_silver_journey_stitch.sql — the lakehouse projection of the journey cart-stitch (Epic 4).
--
-- BRAIN V4 PHASE 6a RELOCATION: this is the SAME table that previously lived in the dbt-internal
-- brain_silver database (db/starrocks/silver_journey_stitch.sql → brain_silver.silver_journey_stitch).
-- brain_silver is being RETIRED in Phase 6b. This table is NOT a dbt-derived Silver mart — it is an
-- APPLICATION-WRITTEN operational projection (the journey-stitch-export job TRUNCATE+INSERTs the PG
-- cart-stitch into it directly). Its V4 home is the operational StarRocks database brain_ops, alongside
-- the other app-owned operational StarRocks state. Moving it here lets brain_silver be dropped in 6b.
--
-- MEDALLION REALIGNMENT: the deterministic anon↔order↔brain_id cart-stitch is captured transactionally
-- in PostgreSQL (connectors.connector_journey_stitch_map — written by order webhooks reading the stitch
-- BACK from note_attributes, + the journey-stitch-from-identity cron). connector_journey_stitch_map
-- STAYS on PG (it is PG OLTP). The journey-stitch-export job materializes it into THIS StarRocks table,
-- which silver_touchpoint reads — so the lakehouse no longer reaches into PG for the journey mart.
--
-- One row per (brand_id, order_id). stitched_anon_id = the brain_anon_id read back from the order;
-- brain_id = the resolved customer (nullable until identity links). Per-brand isolation at the read seam.
--
-- Moved VERBATIM — only the database changes (brain_silver → brain_ops). Schema/keys/distribution
-- unchanged. Idempotent DDL (CREATE ... IF NOT EXISTS) — applied by db/starrocks/ops/run_ops.sh.

CREATE DATABASE IF NOT EXISTS brain_ops;

CREATE TABLE IF NOT EXISTS brain_ops.silver_journey_stitch (
  brand_id          varchar(64)  NOT NULL,
  order_id          varchar(128) NOT NULL,
  stitched_anon_id  varchar(128),
  brain_id          varchar(64),
  created_at        datetime,
  updated_at        datetime
)
PRIMARY KEY (brand_id, order_id)
DISTRIBUTED BY HASH(brand_id) BUCKETS 8
PROPERTIES ("replication_num" = "1", "enable_persistent_index" = "true");
