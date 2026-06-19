-- ============================================================================
-- 0043_realized_gmv_for_period.sql
-- fix-billing-meter-period-delta (P1) — bill the per-period DELTA, not cumulative-as-of
-- ============================================================================
--
-- The billing meter (0040) sealed realized_gmv_as_of(period_end) — CUMULATIVE realized GMV through
-- the period's last day. That double-bills: each period's basis includes every prior period's GMV.
-- Billing must meter the GMV ASSIGNED TO the period, i.e. the per-period delta.
--
-- The ledger already models this: realized_revenue_ledger.billing_posted_period (CHAR(7) 'YYYY-MM',
-- D-2) is the OPEN period a row is billed in. Backdated corrections (clawbacks, late realizations,
-- RTO reversals) post FORWARD to the open period via billing_adjustment — never edit a closed one.
-- So a brand's billable GMV for a period = SUM(amount_minor) WHERE billing_posted_period = period
-- (provisional excluded). Non-overlapping across periods; gapless; corrections handled by forward
-- posting. (doc 04 §F.1.5 / doc 08 billing_adjustment.)
--
-- These are NEW seams. realized_gmv_as_of() is UNCHANGED — analytics correctly uses it for the
-- cumulative as-of realized-revenue curve; only billing switches to the period-delta seams.
--
-- D-3: all as-of/period realized money math goes through named DB functions (NO ad-hoc SUM in app).
-- ADDITIVE ONLY (I-E02): CREATE OR REPLACE FUNCTION. ROLLBACK:
--   DROP FUNCTION IF EXISTS realized_gmv_for_period(uuid,char), realized_gmv_composition_for_period(uuid,char);

-- ── 1. realized_gmv_for_period() — scalar per-period realized GMV (the bill basis) ──
-- Same provisional-exclusion as realized_gmv_as_of(), but scoped by billing_posted_period instead
-- of an economic as-of. SECURITY INVOKER → runs under brain_app RLS (cross-brand = 0).
CREATE OR REPLACE FUNCTION realized_gmv_for_period(p_brand_id UUID, p_period CHAR(7))
  RETURNS BIGINT
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
AS $$
  SELECT COALESCE(SUM(amount_minor), 0)::BIGINT
  FROM realized_revenue_ledger
  WHERE brand_id = p_brand_id
    AND billing_posted_period = p_period
    AND event_type <> 'provisional_recognition';
$$;

GRANT EXECUTE ON FUNCTION realized_gmv_for_period(uuid, char) TO brain_app;

-- ── 2. realized_gmv_composition_for_period() — the inspectable per-event_type breakdown ──
-- SUM(amount_minor) across all returned rows for a currency == realized_gmv_for_period() for that
-- brand/period — the reconciliation invariant the inspectable bill checks.
CREATE OR REPLACE FUNCTION realized_gmv_composition_for_period(p_brand_id UUID, p_period CHAR(7))
  RETURNS TABLE (event_type TEXT, currency_code CHAR(3), amount_minor BIGINT)
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
AS $$
  SELECT
    event_type,
    currency_code,
    COALESCE(SUM(amount_minor), 0)::BIGINT AS amount_minor
  FROM realized_revenue_ledger
  WHERE brand_id = p_brand_id
    AND billing_posted_period = p_period
    AND event_type <> 'provisional_recognition'
  GROUP BY event_type, currency_code;
$$;

GRANT EXECUTE ON FUNCTION realized_gmv_composition_for_period(uuid, char) TO brain_app;

-- ── 3. Migration-time assertions ──────────────────────────────────────────────

-- Both seams must be SECURITY INVOKER (RLS applies to the caller — a DEFINER would bypass isolation).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosecdef
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('realized_gmv_for_period', 'realized_gmv_composition_for_period')
  LOOP
    IF r.prosecdef IS TRUE THEN
      RAISE EXCEPTION 'MIGRATION ASSERTION (0043): %() must be SECURITY INVOKER, not DEFINER.', r.proname;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'realized_gmv_for_period') THEN
    RAISE EXCEPTION 'MIGRATION ASSERTION (0043): realized_gmv_for_period() not found.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'realized_gmv_composition_for_period') THEN
    RAISE EXCEPTION 'MIGRATION ASSERTION (0043): realized_gmv_composition_for_period() not found.';
  END IF;
END
$$;
