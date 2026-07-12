-- 0127_backfill_job_requested_window.sql
--
-- feat(backfill-depth): carry the CALLER-REQUESTED historical window on the backfill job.
--
-- WHY: the resumable backfill driver (@brain/connector-core runResumableBackfill) has accepted a
-- `requestedWindowMs` since the framework landed (resolveBackfillFloor clamps it to the resource's
-- platform `maxBackfillWindowMs`), but the seam was DEAD end-to-end: the trigger endpoint
-- (POST /api/v1/connectors/:id/backfill) had no way to persist "pull the last N months" onto the
-- queued `backfill_job` row, so every claimer always ran the provider max. This column closes that
-- gap: the trigger writes it, BOTH claim paths read it —
--   • the bespoke shopify order runner (apps/stream-worker jobs/shopify-backfill) clamps its
--     created_at_min window to min(requested_window_ms, 24-month max), and
--   • the generic ingestion claimer (jobs/ingestion-backfill runIngestionBackfillFromQueue) passes
--     it into runResumableBackfill, where resolveBackfillFloor clamps per-resource.
--
-- ADDITIVE ONLY (I-E02): one nullable column, no existing row/policy/grant touched.
--   NULL = "provider max" (the pre-existing behaviour — every legacy row keeps its semantics).
--   Value = the requested window in MILLISECONDS (BIGINT — months expressed as ms so the claimers
--   need no calendar math; the UI sends 30-day months). Always clamped at execution time to the
--   provider manifest's maxBackfillWindowMs — the DB stores the REQUEST, never the entitlement.
--
-- CHECK > 0: a zero/negative window is meaningless and would silently no-op a backfill.
--
-- Rollback: ALTER TABLE jobs.backfill_job DROP COLUMN requested_window_ms.

ALTER TABLE jobs.backfill_job
  ADD COLUMN IF NOT EXISTS requested_window_ms BIGINT NULL
    CHECK (requested_window_ms IS NULL OR requested_window_ms > 0);

COMMENT ON COLUMN jobs.backfill_job.requested_window_ms IS
  'Caller-requested historical depth in ms (NULL = provider max). Clamped to the provider manifest maxBackfillWindowMs at claim time — never a depth entitlement.';
