-- ============================================================================
-- 0044_recommendation_decision_log.sql
-- feat-recommendation-rto-detector (P1) — the deterministic decision engine, slice 1
-- ============================================================================
--
-- The recommendation module is the decision engine (doc 09): deterministic detectors read
-- CERTIFIED signals → emit ranked ACTIONS with expected ₹ impact, confidence, and evidence →
-- recorded immutably in the Decision Log. Recommend-only (doc 09 Phase-1). This migration lays
-- the two system-of-record tables (doc 08 §5.5) + the first detector's signal seam.
--
--   recommendation — one open row per (brand, detector, subject); dedup so re-running a detector
--     REFRESHES the rec (new evidence/confidence/priority) instead of duplicating (doc 09 Part 9).
--   decision_log   — append-only audit of every decision (rec raised/refreshed/dismissed), no PII
--     (references customers by brain_id only). doc 08 §5.5.
--   rto_risk_signal_for_brand() — the certified RTO signal the detector consumes (counts, not the
--     D-3 realized-GMV money seam): orders, RTO reversals, RTO-impacted GMV. SECURITY INVOKER.
--
-- confidence ∈ {Trusted,Estimated,Insufficient} — the engine NEVER overstates (effective_confidence
--   = min(input confidences), doc 09 Part 7). RLS: ENABLE+FORCE, two-arg fail-closed (NN-1).
-- ADDITIVE ONLY (I-E02). ROLLBACK: DROP FUNCTION rto_risk_signal_for_brand(uuid);
--   DROP TABLE decision_log, recommendation.

-- ── 1. recommendation ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recommendation (
  recommendation_id UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id          UUID        NOT NULL,                  -- tenant key / RLS anchor (I-S01)
  detector          TEXT        NOT NULL,                  -- registered detector id, e.g. 'rto_risk'
  subject           TEXT        NOT NULL DEFAULT 'brand',  -- dedup subject (brand-level, or e.g. a pincode)
  kind              TEXT        NOT NULL CHECK (kind IN ('risk', 'opportunity')),
  confidence        TEXT        NOT NULL CHECK (confidence IN ('Trusted', 'Estimated', 'Insufficient')),
  priority          INTEGER     NOT NULL DEFAULT 0,        -- money-weighted ordering (doc 09 Part 6)
  status            TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'expired')),
  payload           JSONB       NOT NULL,                  -- {title, summary, recommended_action, evidence{}}
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (recommendation_id),
  UNIQUE (brand_id, detector, subject)                     -- dedup key (doc 09 Part 9)
);

ALTER TABLE recommendation ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendation FORCE ROW LEVEL SECURITY;
CREATE POLICY recommendation_isolation ON recommendation
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);
REVOKE ALL ON recommendation FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON recommendation TO brain_app;  -- upsert on refresh + dismiss

-- ── 2. decision_log (append-only) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS decision_log (
  decision_log_id   UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id          UUID        NOT NULL,                  -- RLS anchor
  kind              TEXT        NOT NULL,                  -- e.g. 'recommendation'
  recommendation_id UUID        NULL,
  actor             TEXT        NOT NULL,                  -- e.g. 'detector:rto_risk'
  action            TEXT        NOT NULL,                  -- e.g. 'raised' | 'refreshed' | 'dismissed'
  reason            TEXT        NULL,
  payload           JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- no PII (brain_id only)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (decision_log_id)
);

ALTER TABLE decision_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_log FORCE ROW LEVEL SECURITY;
CREATE POLICY decision_log_isolation ON decision_log
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);
REVOKE ALL ON decision_log FROM brain_app;
GRANT SELECT, INSERT ON decision_log TO brain_app;           -- append-only (immutable audit)

-- ── 3. rto_risk_signal_for_brand() — the certified RTO signal ─────────────────
-- Counts (NOT the D-3 realized-GMV money seam): distinct orders recognized, RTO-reversal count,
-- and the GMV impacted by RTO (sum of |rto_reversal amount|). SECURITY INVOKER → RLS-scoped.
CREATE OR REPLACE FUNCTION rto_risk_signal_for_brand(p_brand_id UUID)
  RETURNS TABLE (order_count BIGINT, rto_count BIGINT, rto_gmv_minor BIGINT)
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
AS $$
  SELECT
    COUNT(DISTINCT order_id) FILTER (WHERE event_type = 'provisional_recognition')::BIGINT AS order_count,
    COUNT(*) FILTER (WHERE event_type = 'rto_reversal')::BIGINT                            AS rto_count,
    COALESCE(SUM(ABS(amount_minor)) FILTER (WHERE event_type = 'rto_reversal'), 0)::BIGINT AS rto_gmv_minor
  FROM realized_revenue_ledger
  WHERE brand_id = p_brand_id;
$$;

GRANT EXECUTE ON FUNCTION rto_risk_signal_for_brand(uuid) TO brain_app;

-- ── 4. Migration-time assertions ──────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['recommendation', 'decision_log'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class WHERE relname = t AND relrowsecurity IS TRUE AND relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION 'RLS GUARD (0044): % must have ROW LEVEL SECURITY ENABLED + FORCED.', t;
    END IF;
  END LOOP;

  -- decision_log is append-only — brain_app must NOT hold UPDATE/DELETE.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_name = 'decision_log' AND grantee = 'brain_app' AND privilege_type IN ('UPDATE', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'APPEND-ONLY VIOLATION (0044): decision_log must be SELECT + INSERT only for brain_app.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'rto_risk_signal_for_brand') THEN
    RAISE EXCEPTION 'MIGRATION ASSERTION (0044): rto_risk_signal_for_brand() not found.';
  END IF;
END
$$;
