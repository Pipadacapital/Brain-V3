-- ============================================================================
-- 0022_backfill_job.sql — Additive: backfill_job progress table.
-- ============================================================================
-- I-E02 (additive only): NO DROP/ALTER on any existing table. 0006 untouched.
-- ADR-BF-1 / D-12: new backfill_job table for per-brand backfill progress.
-- Rollback: DROP TABLE IF EXISTS backfill_job — rebuildable; NOT a source-of-truth.
--
-- RLS: FORCE (enforced even for table owner — superuser BYPASS only).
-- Policy: two-arg current_setting('app.current_brand_id', TRUE) — NN-1 fail-closed.
--   Missing GUC → NULL → brand_id = NULL → FALSE → 0 rows (not an error, closed).
-- brain_app: SELECT + INSERT + UPDATE — NO DELETE (D-12).
--
-- Status CHECK values (D-12):
--   queued    — written by the trigger, not yet claimed by a worker
--   running   — worker has taken ownership (started_at set)
--   completed — all pages done, no errors
--   partial   — stopped at a cursor checkpoint; resumable on next trigger
--   failed    — unrecoverable error; failure_reason populated
--
-- Overlap-lock support (D-9 / HP-2):
--   backfill_job_active_idx: partial index on (connector_instance_id) WHERE status IN ('queued','running')
--   Caller does: SELECT id FROM backfill_job WHERE connector_instance_id=$1
--     AND status IN ('queued','running') FOR UPDATE SKIP LOCKED
--   If found → 409 BACKFILL_ALREADY_RUNNING. Lock is DB-level, not in-process.
-- ============================================================================

CREATE TABLE IF NOT EXISTS backfill_job (
  id                     UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id               UUID        NOT NULL REFERENCES brand(id),            -- tenant key / RLS anchor (I-S01)
  connector_instance_id  UUID        NOT NULL REFERENCES connector_instance(id),
  status                 TEXT        NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  records_processed      BIGINT      NOT NULL DEFAULT 0,
  estimated_total        BIGINT      NULL,                                     -- NULL = count failed (D-8 honesty)
  cursor_value           TEXT        NULL,                                     -- last since_id checkpoint (D-14)
  cursor_date            TIMESTAMPTZ NULL,                                     -- oldest processed_at seen (progress)
  achieved_depth_label   TEXT        NULL,                                     -- written at completion (HP-3)
  failure_reason         TEXT        NULL,                                     -- SP-3: auth error, page error, etc.
  started_at             TIMESTAMPTZ NULL,
  completed_at           TIMESTAMPTZ NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

-- Lookup by brand + connector for progress queries (ADR-BF-4).
CREATE INDEX IF NOT EXISTS backfill_job_brand_connector_idx
  ON backfill_job (brand_id, connector_instance_id);

-- Overlap-lock support (D-9 / HP-2): partial index on active jobs per connector.
-- Enables efficient: SELECT id FROM backfill_job WHERE connector_instance_id=$1
--   AND status IN ('queued','running') FOR UPDATE SKIP LOCKED
CREATE INDEX IF NOT EXISTS backfill_job_active_idx
  ON backfill_job (connector_instance_id) WHERE status IN ('queued', 'running');

-- Worker poll index (D-2): pick up queued jobs ordered by creation time.
CREATE INDEX IF NOT EXISTS backfill_job_queued_idx
  ON backfill_job (created_at) WHERE status = 'queued';

-- ── Tenant isolation — Postgres RLS ─────────────────────────────────────────
-- FORCE: enforced even for table owner (brain_app is the only runtime accessor).
-- Two-arg current_setting (NN-1): missing GUC → NULL → fail-closed.

ALTER TABLE backfill_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE backfill_job FORCE ROW LEVEL SECURITY;

CREATE POLICY backfill_job_isolation ON backfill_job
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);   -- NN-1 two-arg fail-closed

-- brain_app grants: SELECT + INSERT + UPDATE — NO DELETE (D-12).
-- Backfill jobs are an immutable audit trail (completed/failed rows stay forever).
REVOKE ALL ON backfill_job FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON backfill_job TO brain_app;

-- ── NN-1 assertion (carry-forward from 0006) ─────────────────────────────────
-- Fail the migration if ANY policy on ANY table uses the one-arg current_setting
-- form (which does NOT fail closed when the GUC is missing).
DO $$
DECLARE
  bad_policy RECORD;
BEGIN
  FOR bad_policy IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE (
      (qual LIKE '%current_setting(''app.current_brand_id'')%'
       AND qual NOT LIKE '%current_setting(''app.current_brand_id'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.current_brand_id'', true)%')
      OR
      (qual LIKE '%current_setting(''app.current_user_id'')%'
       AND qual NOT LIKE '%current_setting(''app.current_user_id'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.current_user_id'', true)%')
    )
  LOOP
    RAISE EXCEPTION
      'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting (0022 check).',
      bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
  END LOOP;
END
$$;
