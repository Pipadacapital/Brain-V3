-- 0069_collector_spool_retention.sql
--
-- DB-AUDIT M6 — bound data_plane.collector_spool growth. The drainer marks rows 'drained' (after a
-- confirmed Kafka produce) but never deletes them, so this raw pre-tenant ingest buffer grows
-- unbounded. Grant DELETE so the collector's retention reaper can purge drained rows past a short
-- trail window, and add a partial index so the reap scan is O(reaped), not O(table).
--
-- collector_spool intentionally has NO brand_id / NO RLS (pre-brand-validation edge, migration 0015);
-- retention — not isolation — is the correct control for it. The durability contract (ACK→spool until
-- Kafka produce) is unaffected: only already-drained rows past the trail window are removed.

GRANT DELETE ON data_plane.collector_spool TO brain_app;

CREATE INDEX IF NOT EXISTS idx_collector_spool_drained
  ON data_plane.collector_spool (drained_at)
  WHERE status = 'drained';

-- ── Guard ────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='data_plane' AND table_name='collector_spool'
      AND grantee='brain_app' AND privilege_type='DELETE'
  ) THEN
    RAISE EXCEPTION '0069 VIOLATION: brain_app must hold DELETE on data_plane.collector_spool for the reaper';
  END IF;
END $$;
