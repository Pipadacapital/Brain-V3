-- ============================================================================
-- 0015_collector_spool.sql — Durable accept-before-validate spool table
-- ============================================================================
-- D-1/D-2 (architecture-plan §2/§5): the collector writes raw events to this
-- table BEFORE returning HTTP 200. The drainer polls pending rows and produces
-- to Redpanda; no event is lost even if Redpanda is down (back-pressure hold).
--
-- DESIGN NOTES:
--   • NO RLS — collector_spool sits BEFORE brand validation. Events arrive raw,
--     brand_id is parsed from raw_body only by the drainer. Tenant isolation
--     lives downstream (Redpanda → stream-worker → bronze_events RLS).
--   • brain_app gets SELECT + INSERT + UPDATE (drainer marks status='drained').
--     No DELETE — spool rows are append-only; archival is a future housekeeping job.
--   • Partial index on (id) WHERE status='pending' — the drainer's hot poll path.
--
-- ADDITIVE ONLY — no DROP/ALTER on any existing table (I-E02 invariant).
-- ROLLBACK (migrate down): DROP TABLE IF EXISTS collector_spool — clean; this
--   table is NOT yet an immutable SoR.
-- ============================================================================

CREATE TABLE IF NOT EXISTS collector_spool (
  id          BIGSERIAL    PRIMARY KEY,
  received_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  raw_body    JSONB        NOT NULL,
  status      TEXT         NOT NULL DEFAULT 'pending',   -- pending | drained
  drained_at  TIMESTAMPTZ,
  CONSTRAINT  collector_spool_status_check CHECK (status IN ('pending', 'drained'))
);

-- Drainer hot-path: poll WHERE status='pending' ORDER BY id LIMIT <batch>
CREATE INDEX IF NOT EXISTS idx_collector_spool_pending
  ON collector_spool (id)
  WHERE status = 'pending';

-- ── brain_app grants (D-2: SELECT + INSERT + UPDATE; drainer flips status) ───
REVOKE ALL ON collector_spool FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON collector_spool TO brain_app;
GRANT USAGE, SELECT ON SEQUENCE collector_spool_id_seq TO brain_app;
