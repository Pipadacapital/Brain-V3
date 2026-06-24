-- identity_export_state.sql — the high-watermark cursor for the INCREMENTAL identity-export job.
--
-- MEDALLION REALIGNMENT (Epic 3 / ADR-0004): the identity-export job (apps/stream-worker/src/jobs/
-- identity-export) materializes the Neo4j identity graph into brain_silver.silver_identity_link +
-- silver_customer_identity. It USED to TRUNCATE + full-reload both tables every run — O(graph) regardless
-- of churn. It now exports INCREMENTALLY: only Customer nodes / IDENTIFIES edges CREATED since the last
-- high-watermark (created_at > cursor) are UPSERTed into the PRIMARY KEY tables, plus a cheap tombstone
-- sweep for the bounded set of deactivated edges (GDPR/merge — they carry no timestamp). This table
-- persists the per-projection cursor between runs.
--
-- scope = the export stream identity ('identity_link' | 'customer_identity'). last_created_at_ms = the
-- MAX(Neo4j created_at, epoch-millis) successfully exported. Single-row-per-scope; idempotent upsert (PK).
-- A full backfill (IDENTITY_EXPORT_FULL=1) ignores + resets this cursor to 0 after a clean TRUNCATE reload.

CREATE DATABASE IF NOT EXISTS brain_silver;

CREATE TABLE IF NOT EXISTS brain_silver.identity_export_state (
  scope               varchar(32) NOT NULL,  -- 'identity_link' | 'customer_identity'
  last_created_at_ms  bigint,                 -- MAX Neo4j created_at (epoch-millis) exported so far
  updated_at          datetime
)
PRIMARY KEY (scope)
DISTRIBUTED BY HASH(scope) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_persistent_index" = "true");
