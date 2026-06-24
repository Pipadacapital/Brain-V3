-- silver_customer_identity.sql — the lakehouse projection of the Neo4j Customer nodes (Epic 3/4).
--
-- MEDALLION REALIGNMENT (ADR-0004): identity is the Neo4j SoR; dbt/StarRocks can't read it. The customer
-- marts (silver_customers) need per-customer acquisition/lifecycle attributes (first_identified_at,
-- lifecycle_state, merged_into, minted_at). The identity-export job materializes the Neo4j Customer nodes
-- into THIS table, which silver_customers reads instead of the dropped PG identity.customer JDBC shim
-- (silver_customer_identity_src, removed).
--
-- One row per (brand_id, brain_id). Per-brand isolation at the read seam.

CREATE DATABASE IF NOT EXISTS brain_silver;

CREATE TABLE IF NOT EXISTS brain_silver.silver_customer_identity (
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
