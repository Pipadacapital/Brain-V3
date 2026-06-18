-- ============================================================================
-- 0035_dq_check_result.sql
-- feat-data-quality-engine — Track A (@data-engineer). Architecture §1a.
-- ============================================================================
--
-- Phase 7 — Data Quality. The append-only record of every DQ check OUTCOME
-- (freshness / completeness / schema_validity / reconciliation) per
-- (brand_id, category, target). The stream-worker DQ executors write one
-- dated row per check tick; the metric-engine reads the LATEST row per
-- (category, target) at READ TIME to derive cost_confidence and the trust gate.
--
-- THE INVARIANTS THIS MIGRATION ENCODES:
--   • Confidence is a metric-engine OUTPUT, not a persisted float (I-ST01 /
--     METRICS.md). This table stores RAW check outcomes + a FROZEN letter grade
--     ONLY. cost_confidence / effective_confidence / the trust tier are computed
--     deterministically at read time on the sole metric-engine path — NEVER a
--     column here. There is intentionally NO value_minor / numeric-confidence
--     column (it stores grades, not money — see Assertion-4).
--   • Deterministic grade (I-E03/E04): grade is a FROZEN enum (A+|A|B|C|D) filled
--     by a fixed lookup over the check outcome. A re-run on the same inputs yields
--     the SAME grade (a new row id — history is the point — but an identical grade).
--   • Money (I-S07): cost_confidence reads spend/settlement FRESHNESS +
--     COMPLETENESS + RECONCILIATION grades, never re-floats money. No money column.
--   • Append-only by GRANT (mirrors 0034 / 0033 / 0018): brain_app holds SELECT +
--     INSERT only. NO UPDATE / NO DELETE. History is immutable. Asserted (Assertion-2).
--   • RLS ENABLE + FORCE; NN-1 two-arg fail-closed policy verbatim from 0034
--     (missing GUC → current_setting(...,TRUE)=NULL → brand_id=NULL → FALSE → 0 rows).
--     Verified NON-INERT under brain_app (superuser 'brain' BYPASSES → proves nothing).
--
-- ADDITIVE ONLY (I-E02): CREATE TABLE / INDEX IF NOT EXISTS. No existing row or
--   column on any existing table is touched.
-- ROLLBACK (migrate down):
--   DROP TABLE IF EXISTS dq_check_result;
-- ============================================================================

-- ── 1. dq_check_result — append-only record of every DQ check outcome ─────────
-- One row per (brand_id, result_id) — result_id is a surrogate (gen_random_uuid)
-- so each dated check tick inserts a fresh audit row (no ON CONFLICT: history is
-- the point). The metric-engine reads the LATEST per (category, target) via the
-- idx_dq_check_result_latest index (brand_id, category, target, checked_at DESC).
CREATE TABLE IF NOT EXISTS dq_check_result (
  result_id      UUID         NOT NULL DEFAULT gen_random_uuid(),
  brand_id       UUID         NOT NULL,                       -- tenant key / RLS anchor (I-S01)
  category       TEXT         NOT NULL
                   CHECK (category IN ('freshness','completeness','schema_validity','reconciliation')),
  target         TEXT         NOT NULL,                       -- table/topic/subject checked (e.g. 'bronze_events','silver.order_state','schema_validity')
  grade          TEXT         NOT NULL
                   CHECK (grade IN ('A+','A','B','C','D')),   -- FROZEN enum; deterministic lookup, no runtime float
  score          NUMERIC(5,4) NULL,                           -- observed ratio (null-rate, validity-rate, delta-ratio) as exact decimal; NULL for pure-age freshness
  observed       TEXT         NOT NULL,                       -- raw measured signal as text (e.g. '42' minutes, '0.0123' null-rate, '17' row-delta)
  threshold      TEXT         NOT NULL,                       -- the SLA measured against (e.g. '60' max_age_minutes, '0.0' max_null_rate)
  passing        BOOLEAN      NOT NULL,                       -- observed within threshold (drives freshness-SLA green/breached)
  checked_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, result_id)                           -- tenant-first
);

-- UI / cost-read index: the LATEST graded row per (category, target) per brand.
CREATE INDEX IF NOT EXISTS idx_dq_check_result_latest
  ON dq_check_result (brand_id, category, target, checked_at DESC);

ALTER TABLE dq_check_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE dq_check_result FORCE  ROW LEVEL SECURITY;

CREATE POLICY dq_check_result_isolation ON dq_check_result
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);  -- two-arg fail-closed

REVOKE ALL ON dq_check_result FROM brain_app;
GRANT SELECT, INSERT ON dq_check_result TO brain_app;          -- append-only: no UPDATE/DELETE

-- ── 2. Migration-time assertions (copied verbatim discipline from 0034) ───────

-- Assertion-1: NN-1 — the RLS policy uses two-arg current_setting (fail-closed on
-- a missing GUC instead of 500-ing). Scans pg_policies for any one-arg form.
DO $$
DECLARE
  bad_policy RECORD;
BEGIN
  FOR bad_policy IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE tablename = 'dq_check_result'
      AND (
        (qual LIKE '%current_setting(''app.current_brand_id'')%'
         AND qual NOT LIKE '%current_setting(''app.current_brand_id'', TRUE)%'
         AND qual NOT LIKE '%current_setting(''app.current_brand_id'', true)%')
      )
  LOOP
    RAISE EXCEPTION
      'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting. '
      'Replace with two-arg form: current_setting(''app.current_brand_id'', TRUE).',
      bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
  END LOOP;
END
$$;

-- Assertion-2: Append-only-by-GRANT — brain_app must NOT hold UPDATE or DELETE on
-- dq_check_result (the check-outcome history is immutable audit).
DO $$
DECLARE
  bad_grant RECORD;
BEGIN
  FOR bad_grant IN
    SELECT table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_name     = 'dq_check_result'
      AND grantee        = 'brain_app'
      AND privilege_type IN ('UPDATE', 'DELETE')
  LOOP
    RAISE EXCEPTION
      'APPEND-ONLY VIOLATION: brain_app holds "%" on %. '
      'Only SELECT and INSERT are permitted (DQ check history is immutable by construction).',
      bad_grant.privilege_type, bad_grant.table_name;
  END LOOP;
END
$$;

-- Assertion-3: RLS FORCE is enabled (RLS enabled but not FORCE leaks to the owner
-- role; FORCE makes isolation hold even for the table owner).
DO $$
DECLARE
  bad_table RECORD;
BEGIN
  FOR bad_table IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'dq_check_result'
      AND (c.relrowsecurity = FALSE OR c.relforcerowsecurity = FALSE)
  LOOP
    RAISE EXCEPTION
      'RLS-FORCE VIOLATION: table "%" does not have ENABLE + FORCE ROW LEVEL SECURITY. '
      'Brand isolation would be inert.', bad_table.relname;
  END LOOP;
END
$$;

-- Assertion-4: No money column — defense-in-depth lint that confidence stays a
-- metric-engine OUTPUT (I-ST01), never a persisted float, and money never lands
-- here (cost_confidence reads grades, not money — I-S07). The table stores raw
-- outcomes + the FROZEN letter grade only.
DO $$
DECLARE
  bad_col RECORD;
BEGIN
  FOR bad_col IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'dq_check_result'
      AND (
        column_name LIKE '%_minor'
        OR column_name IN ('confidence','effective_confidence','cost_confidence','value','amount')
      )
  LOOP
    RAISE EXCEPTION
      'METRIC-OUTPUT VIOLATION: column %.% looks like a persisted money/confidence float. '
      'dq_check_result stores raw outcomes + the frozen letter grade only; '
      'confidence is a metric-engine OUTPUT computed at read time (I-ST01).',
      bad_col.table_name, bad_col.column_name;
  END LOOP;
END
$$;
