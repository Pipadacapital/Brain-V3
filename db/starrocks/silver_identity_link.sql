-- silver_identity_link.sql — the lakehouse-readable projection of the Neo4j identity graph (Epic 3).
--
-- MEDALLION REALIGNMENT (ADR-0004): Neo4j is the identity SoR, but dbt/StarRocks CANNOT read Neo4j.
-- silver_order_recognition (gold revenue ledger) + the customer marts resolve brain_id by joining the
-- identity hash→brain_id mapping. So the identity-export job (apps/stream-worker/src/jobs/identity-export)
-- materializes the active IDENTIFIES edges from Neo4j into THIS StarRocks PRIMARY KEY table, which dbt
-- reads in place of the old PG identity_link JDBC shim (identity_link_src, removed).
--
-- One row per (brand_id, identifier_type, identifier_value) — the hashed identifier (64-hex, NEVER raw
-- PII). brain_id is the resolved customer. is_active mirrors the edge state (tombstoned on erase).
-- Per-brand isolation at the metric-engine/dbt read seam (StarRocks has no RLS). Idempotent upsert (PK).

CREATE DATABASE IF NOT EXISTS brain_silver;

CREATE TABLE IF NOT EXISTS brain_silver.silver_identity_link (
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
