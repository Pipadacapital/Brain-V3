-- ============================================================================
-- 0041_billing_plan_and_composition.sql
-- feat-billing-inspectable-bill (P1) — the rate source + the inspectable composition seam
-- ============================================================================
--
-- The inspectable bill answers "how was this fee derived?" from a sealed period (0040):
--   fee = sealed realized-GMV basis × rate  — itemized down to the ledger composition that
--   reconciles to the basis. This migration adds the two missing pieces:
--
--   1. billing_plan — the per-brand billing RATE (basis points). doc 08 invoice_line carries
--      rate_bps; this is its source. When a brand has no plan row the bill falls back to a
--      platform default (in app code) and SAYS so (rate.source = 'default') — honest provenance.
--
--   2. realized_gmv_composition_as_of() — a named DB seam (D-3: NO ad-hoc SUM in app code) that
--      returns the realized GMV broken down BY event_type, as-of a date, using the SAME filter as
--      realized_gmv_as_of() (0018:176) so the components RECONCILE to the scalar basis. This is
--      what makes the bill "inspectable": the customer sees finalizations, refunds, RTO reversals
--      etc. summing to the figure they're billed on.
--
-- RLS: ENABLE + FORCE; two-arg fail-closed current_setting('app.current_brand_id', TRUE) (NN-1).
-- ADDITIVE ONLY (I-E02): CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE FUNCTION.
-- ROLLBACK: DROP FUNCTION IF EXISTS realized_gmv_composition_as_of(uuid,date);
--           DROP TABLE IF EXISTS billing_plan.

-- ── 1. billing_plan — per-brand billing rate ──────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_plan (
  brand_id      UUID        NOT NULL,            -- tenant key / RLS anchor (I-S01); ONE plan per brand
  rate_bps      INTEGER     NOT NULL             -- billing rate in basis points (100 bps = 1.00%)
                  CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  effective_from DATE       NOT NULL DEFAULT CURRENT_DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id)
);

ALTER TABLE billing_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_plan FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_plan_isolation ON billing_plan
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON billing_plan FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON billing_plan TO brain_app;

-- ── 2. realized_gmv_composition_as_of() — inspectable per-event_type breakdown ─
-- Mirrors realized_gmv_as_of()'s filter EXACTLY (provisional_recognition excluded, economic
-- as-of), grouped by event_type + currency. SUM(amount_minor) across all returned rows for a
-- currency == realized_gmv_as_of() for that brand/date — the reconciliation invariant.
-- SECURITY INVOKER → runs under brain_app's RLS context (cross-brand = 0 rows).
CREATE OR REPLACE FUNCTION realized_gmv_composition_as_of(p_brand_id UUID, p_as_of DATE)
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
    AND economic_effective_at::date <= p_as_of
    AND event_type <> 'provisional_recognition'
  GROUP BY event_type, currency_code;
$$;

GRANT EXECUTE ON FUNCTION realized_gmv_composition_as_of(uuid, date) TO brain_app;

-- ── 3. Migration-time assertions ──────────────────────────────────────────────

-- Assertion-1: billing_plan RLS ENABLED + FORCED.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE relname = 'billing_plan' AND relrowsecurity IS TRUE AND relforcerowsecurity IS TRUE
  ) THEN
    RAISE EXCEPTION 'RLS GUARD (0041): billing_plan must have ROW LEVEL SECURITY ENABLED + FORCED.';
  END IF;
END
$$;

-- Assertion-2: the composition seam is SECURITY INVOKER (NOT definer — RLS must apply to caller).
DO $$
DECLARE
  v_secdef boolean;
BEGIN
  SELECT p.prosecdef INTO v_secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'realized_gmv_composition_as_of';
  IF v_secdef IS NULL THEN
    RAISE EXCEPTION 'MIGRATION ASSERTION (0041): realized_gmv_composition_as_of() not found.';
  END IF;
  IF v_secdef IS TRUE THEN
    RAISE EXCEPTION 'MIGRATION ASSERTION (0041): realized_gmv_composition_as_of() must be SECURITY INVOKER '
      '(RLS is enforced under the caller — a DEFINER would bypass tenant isolation).';
  END IF;
END
$$;
