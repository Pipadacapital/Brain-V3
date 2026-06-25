-- ops_identity_export_state.sql — the high-watermark cursor for the INCREMENTAL identity-export job.
--
-- BRAIN V4 PHASE 6a RELOCATION: this is the SAME table that previously lived in the dbt-internal
-- brain_silver database (db/starrocks/identity_export_state.sql → brain_silver.identity_export_state).
-- brain_silver is being RETIRED in Phase 6b. This is NOT a dbt-derived Silver mart — it is APPLICATION-
-- WRITTEN operational state (the identity-export job persists its per-projection cursor here). Its V4
-- home is the operational StarRocks database brain_ops, alongside the other app-owned operational
-- StarRocks state. Moving it here lets brain_silver be dropped in 6b.
--
-- MEDALLION REALIGNMENT (Epic 3 / ADR-0004): the identity-export job (apps/stream-worker/src/jobs/
-- identity-export) materializes the Neo4j identity graph into brain_ops.silver_identity_link +
-- silver_customer_identity. It exports INCREMENTALLY: only Customer nodes / IDENTIFIES edges CREATED
-- since the last high-watermark (created_at > cursor) are UPSERTed into the PRIMARY KEY tables, plus a
-- cheap tombstone sweep for the bounded set of deactivated edges. This table persists the per-projection
-- cursor between runs.
--
-- scope = the export stream identity ('identity_link' | 'customer_identity'). last_created_at_ms = the
-- MAX(Neo4j created_at, epoch-millis) successfully exported. Single-row-per-scope; idempotent upsert (PK).
-- A full backfill (IDENTITY_EXPORT_FULL=1) ignores + resets this cursor to 0 after a clean TRUNCATE reload.
--
-- Moved VERBATIM — only the database changes (brain_silver → brain_ops). Schema/keys/distribution
-- unchanged. Idempotent DDL (CREATE ... IF NOT EXISTS) — applied by db/starrocks/ops/run_ops.sh.

CREATE DATABASE IF NOT EXISTS brain_ops;

CREATE TABLE IF NOT EXISTS brain_ops.identity_export_state (
  scope               varchar(32) NOT NULL,  -- 'identity_link' | 'customer_identity'
  last_created_at_ms  bigint,                 -- MAX Neo4j created_at (epoch-millis) exported so far
  updated_at          datetime
)
PRIMARY KEY (scope)
DISTRIBUTED BY HASH(scope) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_persistent_index" = "true");
