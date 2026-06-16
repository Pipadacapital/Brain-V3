-- 0020_provisional_gmv_as_of.sql
-- Additive migration (I-E02): creates provisional_gmv_as_of() named DB seam.
-- No ALTER/DROP of existing objects. Reversible (down = DROP FUNCTION IF EXISTS).
--
-- INVARIANTS (mirroring 0018 header):
--   I-S07  No FLOAT/NUMERIC money columns — BIGINT only.
--   I-E02  Additive-only: no existing object is altered or dropped.
--   D-4    provisional_revenue has ONE named as-of path (this function).
--          NO ad-hoc SUM(amount_minor) against realized_revenue_ledger in app code.
--   D-5    Per-currency TABLE result (not a scalar BIGINT) — multi-currency ready.
--   F-SEC-02 SECURITY INVOKER — executes under caller's RLS context (brain_app).
--            Cross-brand read = 0 under brain_app (RLS filters brand_id).
--
-- recognition_label coverage:
--   provisional   — sale recorded, awaiting finalization horizon
--   settling      — in the settlement processing window
--   (finalized)   — EXCLUDED: finalized rows are realized_revenue's domain
--
-- This function is the provisional counterpart to realized_gmv_as_of() (0018:176).
-- The engine is the SOLE caller; no ad-hoc SUM permitted elsewhere.

-- ── provisional_gmv_as_of() ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION provisional_gmv_as_of(p_brand_id UUID, p_as_of DATE)
  RETURNS TABLE (currency_code CHAR(3), provisional_minor BIGINT)
  LANGUAGE sql
  STABLE
  SECURITY INVOKER          -- executes under caller's RLS context (brain_app) — cross-brand = 0
AS $$
  SELECT
    currency_code,
    COALESCE(SUM(amount_minor), 0)::BIGINT AS provisional_minor
  FROM realized_revenue_ledger
  WHERE brand_id = p_brand_id
    AND economic_effective_at::date <= p_as_of
    AND recognition_label IN ('provisional', 'settling')
  GROUP BY currency_code;
$$;

-- ── Migration-time assertions ─────────────────────────────────────────────────

-- Assertion-1: function exists (belt-and-suspenders — CREATE OR REPLACE above guarantees it,
-- but the assertion makes the invariant explicit and catches a future accidental DROP).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'provisional_gmv_as_of'
      AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION
      'MIGRATION ASSERTION FAILED (0020): provisional_gmv_as_of() not found in public schema. '
      'The D-4 named seam must exist.';
  END IF;
END
$$;

-- Assertion-2: SECURITY INVOKER (prosecdef = false means SECURITY INVOKER)
-- This catches a future careless edit to SECURITY DEFINER, which would bypass RLS
-- and violate the brand-isolation invariant (I-S01, F-SEC-02).
DO $$
DECLARE
  is_security_definer BOOLEAN;
BEGIN
  SELECT p.prosecdef INTO is_security_definer
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'provisional_gmv_as_of'
    AND n.nspname = 'public';

  IF is_security_definer IS NULL THEN
    RAISE EXCEPTION
      'MIGRATION ASSERTION FAILED (0020): provisional_gmv_as_of() not found. '
      'Cannot verify SECURITY INVOKER.';
  END IF;

  IF is_security_definer = TRUE THEN
    RAISE EXCEPTION
      'MIGRATION ASSERTION FAILED (0020): provisional_gmv_as_of() is SECURITY DEFINER '
      '(prosecdef=true). It must be SECURITY INVOKER so RLS is enforced under the '
      'caller''s role (brain_app). Cross-brand reads must return 0 rows.';
  END IF;
END
$$;

-- ── Down migration ────────────────────────────────────────────────────────────
-- To reverse: DROP FUNCTION IF EXISTS provisional_gmv_as_of(uuid, date);
-- (node-pg-migrate down script)
