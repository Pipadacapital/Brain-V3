-- ============================================================================
-- 0036_ai_provenance.sql
-- feat-decision-intelligence-inputs — Track B (@backend-developer). Architecture §D2.
-- ============================================================================
--
-- Phase 8 — Decision-Intelligence Inputs. The append-only PROVENANCE record of
-- every "Ask Brain" answer: the resolved metric_binding (metric_id, version,
-- params), the snapshot_id (reproducibility handle), the REDACTED question, and
-- the FROZEN confidence grade + trust tier from getMetricTrust (Phase 7).
--
-- THE INVARIANTS THIS MIGRATION ENCODES:
--   • Models NEVER produce numbers (METRICS.md §5 / I-ST01): there is NO value /
--     amount / *_minor / numeric-confidence column here. The answer NUMBER is NEVER
--     persisted — it is REPRODUCED from (snapshot_id + metric_binding) by re-running
--     the metric-engine compute path. A stored number would be an un-certified second
--     source that could drift from the engine. Asserted (Assertion-4).
--   • Reproducibility: snapshot_id pins the read frame so re-running the binding at
--     the snapshot yields the SAME number. The binding (metric_id, metric_version,
--     params JSONB) + snapshot_id are the SOLE persisted decision inputs.
--   • NLQ stored REDACTED ONLY: question_redacted is the deterministically redacted
--     question (PII / free-text stripped). The RAW question is NEVER written to disk,
--     DB, or logs — only redactQuestion(raw) lands here (I-S08 / privacy).
--   • Confidence is a metric-engine OUTPUT (I-ST01), frozen onto the answer as a
--     LETTER grade (A+|A|B|C|D) + a trust tier (Trusted|Estimated|Untrusted), NEVER a
--     persisted float. confidence_grade/trust_tier are TEXT enums, not numeric.
--   • Append-only by GRANT (mirrors 0035 / 0034 / 0033 / 0018): brain_app holds
--     SELECT + INSERT only. NO UPDATE / NO DELETE. ai_provenance is immutable audit.
--     Asserted (Assertion-2).
--   • RLS ENABLE + FORCE; NN-1 two-arg fail-closed policy verbatim from 0035
--     (missing GUC → current_setting(...,TRUE)=NULL → brand_id=NULL → FALSE → 0 rows).
--     Verified NON-INERT under brain_app (superuser 'brain' BYPASSES → proves nothing).
--
-- ADDITIVE ONLY (I-E02): CREATE TABLE / INDEX IF NOT EXISTS. No existing row or
--   column on any existing table is touched.
-- ROLLBACK (migrate down):
--   DROP TABLE IF EXISTS ai_provenance;
-- ============================================================================

-- ── 1. ai_provenance — append-only provenance of every Ask-Brain answer ───────
-- One row per (brand_id, provenance_id) — provenance_id is a surrogate
-- (gen_random_uuid) so each answer inserts a fresh audit row (no ON CONFLICT:
-- history is the point). The "recent asks" UI reads the LATEST per brand via
-- the idx_ai_provenance_recent index (brand_id, created_at DESC).
CREATE TABLE IF NOT EXISTS ai_provenance (
  provenance_id     UUID         NOT NULL DEFAULT gen_random_uuid(),
  brand_id          UUID         NOT NULL,                       -- tenant key / RLS anchor (I-S01)
  metric_id         TEXT         NOT NULL
                      CHECK (metric_id IN (
                        'realized_revenue','provisional_revenue','ad_spend','blended_roas',
                        'cod_rto_rate','cod_mix','checkout_funnel','order_status_mix',
                        'journey_first_touch_mix','journey_stitch_rate','journey_timeline',
                        'attribution_credit','attribution_reconciliation_rate',
                        'attribution_confidence','cost_confidence','effective_confidence'
                      )),                                        -- mirrors the 16-id registry enum (registry.ts)
  metric_version    TEXT         NOT NULL,                       -- e.g. 'v1' (registry key)
  params            JSONB        NOT NULL DEFAULT '{}'::jsonb,   -- resolved + validated params (date range / allow-listed filters)
  snapshot_id       TEXT         NOT NULL,                       -- reproducibility handle (re-run binding @ snapshot → same number)
  question_redacted TEXT         NOT NULL,                       -- deterministically redacted; RAW question NEVER stored
  confidence_grade  TEXT         NOT NULL
                      CHECK (confidence_grade IN ('A+','A','B','C','D')),  -- FROZEN letter from getMetricTrust; NOT a float
  trust_tier        TEXT         NOT NULL
                      CHECK (trust_tier IN ('Trusted','Estimated','Untrusted')),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, provenance_id)                          -- tenant-first
);

-- UI "recent asks" index: the LATEST answers per brand.
CREATE INDEX IF NOT EXISTS idx_ai_provenance_recent
  ON ai_provenance (brand_id, created_at DESC);

ALTER TABLE ai_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_provenance FORCE  ROW LEVEL SECURITY;

CREATE POLICY ai_provenance_isolation ON ai_provenance
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);  -- two-arg fail-closed

REVOKE ALL ON ai_provenance FROM brain_app;
GRANT SELECT, INSERT ON ai_provenance TO brain_app;             -- append-only: no UPDATE/DELETE

-- ── 2. Migration-time assertions (copied verbatim discipline from 0035) ───────

-- Assertion-1: NN-1 — the RLS policy uses two-arg current_setting (fail-closed on
-- a missing GUC instead of 500-ing). Scans pg_policies for any one-arg form.
DO $$
DECLARE
  bad_policy RECORD;
BEGIN
  FOR bad_policy IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE tablename = 'ai_provenance'
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
-- ai_provenance (the provenance history is immutable audit).
DO $$
DECLARE
  bad_grant RECORD;
BEGIN
  FOR bad_grant IN
    SELECT table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_name     = 'ai_provenance'
      AND grantee        = 'brain_app'
      AND privilege_type IN ('UPDATE', 'DELETE')
  LOOP
    RAISE EXCEPTION
      'APPEND-ONLY VIOLATION: brain_app holds "%" on %. '
      'Only SELECT and INSERT are permitted (ai_provenance is immutable by construction).',
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
      AND c.relname = 'ai_provenance'
      AND (c.relrowsecurity = FALSE OR c.relforcerowsecurity = FALSE)
  LOOP
    RAISE EXCEPTION
      'RLS-FORCE VIOLATION: table "%" does not have ENABLE + FORCE ROW LEVEL SECURITY. '
      'Brand isolation would be inert.', bad_table.relname;
  END LOOP;
END
$$;

-- Assertion-4: No value/money/float column — defense-in-depth lint that the answer
-- NUMBER is NEVER persisted (I-ST01 / METRICS.md §5). The number is reproduced from
-- (snapshot_id + binding) via the engine; confidence is a FROZEN letter grade, not a
-- float. ai_provenance stores the binding + redacted question + grade ONLY.
DO $$
DECLARE
  bad_col RECORD;
BEGIN
  FOR bad_col IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'ai_provenance'
      AND (
        column_name LIKE '%_minor'
        OR column_name IN ('value','amount','confidence','effective_confidence',
                           'cost_confidence','number','answer','result')
      )
  LOOP
    RAISE EXCEPTION
      'METRIC-OUTPUT VIOLATION: column %.% looks like a persisted answer number / money / '
      'confidence float. ai_provenance stores the binding + redacted question + frozen letter '
      'grade only; the number is REPRODUCED from snapshot_id + binding via the engine (I-ST01).',
      bad_col.table_name, bad_col.column_name;
  END LOOP;
END
$$;
