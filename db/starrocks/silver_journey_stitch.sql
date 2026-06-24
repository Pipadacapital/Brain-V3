-- silver_journey_stitch.sql — the lakehouse projection of the journey cart-stitch (Epic 4).
--
-- MEDALLION REALIGNMENT: the deterministic anon↔order↔brain_id cart-stitch is captured transactionally
-- in PostgreSQL (connectors.connector_journey_stitch_map — written by order webhooks reading the stitch
-- BACK from note_attributes, + the journey-stitch-from-identity cron). dbt previously read it via a PG
-- JDBC shim (connector_journey_stitch_map_src) — the last "PG as analytical read source" deviation. The
-- journey-stitch-export job materializes it into THIS StarRocks table, which silver_touchpoint reads
-- instead — so the lakehouse no longer reaches into PG for the journey mart.
--
-- One row per (brand_id, order_id). stitched_anon_id = the brain_anon_id read back from the order;
-- brain_id = the resolved customer (nullable until identity links). Per-brand isolation at the read seam.

CREATE DATABASE IF NOT EXISTS brain_silver;

CREATE TABLE IF NOT EXISTS brain_silver.silver_journey_stitch (
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
