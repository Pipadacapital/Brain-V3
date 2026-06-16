-- ============================================================================
-- 0016_bronze_events.sql — DEV/M1 STAGING MIRROR of brain_bronze.collector_events
-- Phase-3 → Iceberg (STACK.md:46). This table is the M1 Bronze sink.
-- ============================================================================
-- D-4 fallback (architecture-plan §1): no production-grade TS Iceberg writer
-- exists; Nessie REST is catalog-only, not a row-write endpoint. Postgres
-- bronze_events is the explicitly pre-authorised D-4 fallback for M1.
--
-- Column shape mirrors bronze_spec.json exactly so the Phase-3 Iceberg
-- migration is a mechanical column-map, not a redesign.
--
-- TENANT ISOLATION (D-8 re-bound to RLS for M1 Postgres sink):
--   • RLS enforced via two-arg current_setting (NN-1 CRITICAL).
--   • FORCE ROW LEVEL SECURITY — enforces even for the table owner.
--   • brain_app gets INSERT + SELECT only — Bronze is append-only at GRANT level.
--   • (brand_id, event_id) PRIMARY KEY = DB-level idempotency backstop (I-ST04).
--
-- ADDITIVE ONLY — no DROP/ALTER on any existing table (I-E02 invariant).
-- ROLLBACK (migrate down): DROP TABLE IF EXISTS bronze_events — clean; this
--   table is NOT yet an immutable SoR (Phase-3 Iceberg is the true SoR).
-- ============================================================================

CREATE TABLE IF NOT EXISTS bronze_events (
  event_id          UUID        NOT NULL,
  brand_id          UUID        NOT NULL,        -- tenant key / RLS anchor (I-S01)
  occurred_at       TIMESTAMPTZ NOT NULL,         -- ISO-8601 string → timestamptz at write boundary
  ingested_at       TIMESTAMPTZ NOT NULL,         -- ISO-8601 string → timestamptz at write boundary
  schema_name       TEXT        NOT NULL,         -- 'brain.collector.event.v1'
  schema_version    INT         NOT NULL,         -- literal 1 for M1 (F-10); Apicurio-resolved in M2
  event_type        TEXT        NOT NULL,         -- event_name from envelope
  correlation_id    TEXT        NOT NULL,
  partition_key     TEXT        NOT NULL,         -- brand_id:event_id
  payload           JSONB       NOT NULL,         -- no raw PII (I-S02)
  processing_flags  JSONB,                        -- nullable (additive evolution-safe)
  collector_version TEXT,                         -- nullable (additive evolution-safe)
  PRIMARY KEY (brand_id, event_id)                -- tenant-first PK; idempotency backstop (I-ST04)
);

-- ── Tenant isolation — Postgres RLS (D-8 M1 binding) ────────────────────────
-- Two-arg form is MANDATORY (NN-1): missing GUC → NULL → brand_id = NULL → FALSE → 0 rows (fail-closed).
-- DO NOT use the one-arg current_setting('app.current_brand_id')::uuid form.

ALTER TABLE bronze_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE bronze_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON bronze_events
  AS PERMISSIVE
  FOR ALL
  TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- ── brain_app grants — append-only at GRANT level (no UPDATE/DELETE) ─────────
REVOKE ALL ON bronze_events FROM brain_app;
GRANT SELECT, INSERT ON bronze_events TO brain_app;

-- ── Supporting indexes ────────────────────────────────────────────────────────
-- Lookup by brand + event_type for analytical queries.
CREATE INDEX IF NOT EXISTS idx_bronze_events_brand_type
  ON bronze_events (brand_id, event_type, occurred_at DESC);
