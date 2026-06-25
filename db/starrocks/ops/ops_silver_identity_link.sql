-- ops_silver_identity_link.sql — the lakehouse-readable projection of the Neo4j identity graph (Epic 3).
--
-- BRAIN V4 PHASE 6a RELOCATION: this is the SAME table that previously lived in the dbt-internal
-- brain_silver database (db/starrocks/silver_identity_link.sql → brain_silver.silver_identity_link).
-- brain_silver is being RETIRED in Phase 6b (the dbt-internal Silver database is replaced by the V4
-- Spark-built Iceberg Silver + the brain_serving MVs). This table is NOT a dbt-derived Silver mart — it
-- is an APPLICATION-WRITTEN operational projection (the identity-export job UPSERTs the active Neo4j
-- IDENTIFIES edges into it directly). Its V4 home is the operational StarRocks database brain_ops,
-- alongside the other app-owned operational StarRocks state. Moving it here removes a dependence on
-- brain_silver so brain_silver can be dropped in 6b.
--
-- MEDALLION REALIGNMENT (ADR-0004): Neo4j is the identity SoR, but dbt/StarRocks CANNOT read Neo4j.
-- silver_order_recognition (gold revenue ledger) + the customer marts resolve brain_id by joining the
-- identity hash→brain_id mapping. So the identity-export job (apps/stream-worker/src/jobs/identity-export)
-- materializes the active IDENTIFIES edges from Neo4j into THIS StarRocks PRIMARY KEY table.
--
-- One row per (brand_id, identifier_type, identifier_value) — the hashed identifier (64-hex, NEVER raw
-- PII). brain_id is the resolved customer. is_active mirrors the edge state (tombstoned on erase).
-- Per-brand isolation at the metric-engine/dbt read seam (StarRocks has no RLS). Idempotent upsert (PK).
--
-- Moved VERBATIM — only the database changes (brain_silver → brain_ops). Schema/keys/distribution
-- unchanged. Idempotent DDL (CREATE ... IF NOT EXISTS) — applied by db/starrocks/ops/run_ops.sh.

CREATE DATABASE IF NOT EXISTS brain_ops;

CREATE TABLE IF NOT EXISTS brain_ops.silver_identity_link (
  brand_id          varchar(64)  NOT NULL,
  identifier_type   varchar(32)  NOT NULL,
  identifier_value  varchar(128) NOT NULL,  -- 64-hex hash (never raw PII)
  brain_id          varchar(64),
  tier              varchar(16),            -- strong | strong_on_link | medium | weak (for CAPI subject-hash selection)
  is_active         boolean,
  updated_at        datetime
)
PRIMARY KEY (brand_id, identifier_type, identifier_value)
DISTRIBUTED BY HASH(brand_id) BUCKETS 8
PROPERTIES ("replication_num" = "1", "enable_persistent_index" = "true");
