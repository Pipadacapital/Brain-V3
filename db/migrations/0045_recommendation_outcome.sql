-- ============================================================================
-- 0045_recommendation_outcome.sql
-- feat-recommendation-detectors-learning-loop (P1) — the learning loop + a 2nd detector signal
-- ============================================================================
--
-- The decision engine's unit of output is a DECISION, and the engine measures whether it WORKED
-- (doc 09 Part 10). recommendation_outcome records, per recommendation + window, the detector's
-- signal AT RAISE vs NOW — so a rec carries its own effectiveness evidence ("RTO was 5.0%, now
-- 4.1% — improving"). This is the feedback that (later) auto-mutes low-precision detectors.
--
-- Also adds realization_signal_for_brand() — the certified signal for the 2nd detector
-- (realization gap: recognized GMV that has not settled = cash at risk), counts/money only.
--
-- ADDITIVE ONLY (I-E02). ROLLBACK: DROP FUNCTION realization_signal_for_brand(uuid);
--   DROP TABLE recommendation_outcome.

-- ── 1. recommendation_outcome (doc 08 §5.5) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS recommendation_outcome (
  recommendation_id  UUID        NOT NULL REFERENCES recommendation(recommendation_id),
  brand_id           UUID        NOT NULL,                -- RLS anchor (denormalized)
  measurement_window TEXT        NOT NULL,                -- measurement window key, e.g. 'latest'
  measured           JSONB       NOT NULL,                -- {metric, then, now, delta, improved}
  measured_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (recommendation_id, measurement_window)     -- one outcome per rec per window (upsert)
);

ALTER TABLE recommendation_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendation_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY recommendation_outcome_isolation ON recommendation_outcome
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);
REVOKE ALL ON recommendation_outcome FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON recommendation_outcome TO brain_app;  -- upsert on re-measure

-- ── 2. realization_signal_for_brand() — recognized vs settled (the 2nd detector's signal) ──
-- provisional_minor = recognized-but-not-yet-realized; realized_minor = settled (finalizations net
-- of reversals). The gap is cash recognized in the ledger that has not yet realized. SECURITY
-- INVOKER (RLS applies to the caller). Not the D-3 as-of money seam — a current-state risk signal.
CREATE OR REPLACE FUNCTION realization_signal_for_brand(p_brand_id UUID)
  RETURNS TABLE (provisional_minor BIGINT, realized_minor BIGINT, order_count BIGINT)
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
AS $$
  SELECT
    COALESCE(SUM(amount_minor) FILTER (WHERE event_type = 'provisional_recognition'), 0)::BIGINT,
    COALESCE(SUM(amount_minor) FILTER (WHERE event_type <> 'provisional_recognition'), 0)::BIGINT,
    COUNT(DISTINCT order_id)::BIGINT
  FROM realized_revenue_ledger
  WHERE brand_id = p_brand_id;
$$;

GRANT EXECUTE ON FUNCTION realization_signal_for_brand(uuid) TO brain_app;

-- ── 3. Assertions ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'recommendation_outcome'
       AND relrowsecurity IS TRUE AND relforcerowsecurity IS TRUE
  ) THEN
    RAISE EXCEPTION 'RLS GUARD (0045): recommendation_outcome must have RLS ENABLED + FORCED.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'realization_signal_for_brand') THEN
    RAISE EXCEPTION 'MIGRATION ASSERTION (0045): realization_signal_for_brand() not found.';
  END IF;
END
$$;
