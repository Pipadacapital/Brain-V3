-- 0056_cm2_signal_for_brand.sql
--
-- feat-decision-cm2-detector — the certified signal the margin-erosion detector reads.
--
-- Mirrors rto_risk_signal_for_brand / realization_signal_for_brand (0044/0045): a SECURITY INVOKER
-- function that returns RAW AGGREGATES (sums, the cost-rate sums, the order count, the confidence
-- floor) from the same as-of seams the metric engine reads. The DERIVED margin (CM1/CM2 + the
-- non-additive margin ratio + the decision threshold) is computed in TypeScript by the detector
-- (ADR-004: the metric engine / detector is the sole computer of a business number; SQL returns
-- only additive aggregates). This keeps the margin FORMULA in one place (TS) — SQL never decides.
--
-- Money is BIGINT minor units (I-S07). RLS applies (SECURITY INVOKER) — the caller's brand only.

CREATE OR REPLACE FUNCTION cm2_signal_for_brand(p_brand_id UUID)
  RETURNS TABLE (
    net_revenue_minor BIGINT,   -- realized (net) revenue to date
    marketing_minor   BIGINT,   -- ad spend to date (brand currency)
    order_count       BIGINT,   -- distinct realized orders (the min-orders gate)
    cogs_pct_bps      BIGINT,   -- Σ global COGS rate inputs (basis points)
    variable_pct_bps  BIGINT,   -- Σ global shipping+packaging+payment_fee+marketplace_fee rates
    has_cogs          BOOLEAN,  -- a COGS input exists (else margin is untrustworthy)
    confidence_rank   INT       -- floor of cost_input confidences: 2 Trusted / 1 Estimated / 0 none
  )
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
  SET search_path = public
AS $$
  WITH brand_ccy AS (
    SELECT currency_code FROM brand WHERE id = p_brand_id
  ),
  rev AS (
    SELECT realized_gmv_as_of(p_brand_id, CURRENT_DATE) AS net_revenue_minor
  ),
  orders AS (
    SELECT COUNT(DISTINCT order_id)::bigint AS n
      FROM realized_revenue_ledger
     WHERE brand_id = p_brand_id AND event_type <> 'provisional_recognition'
  ),
  spend AS (
    SELECT COALESCE(SUM(s.spend_minor), 0)::bigint AS marketing_minor
      FROM ad_spend_as_of(p_brand_id, DATE '2000-01-01', CURRENT_DATE) s
      JOIN brand_ccy b ON b.currency_code = s.currency_code
  ),
  costs AS (
    SELECT
      COALESCE(SUM(pct_bps) FILTER (WHERE cost_type = 'cogs' AND pct_bps IS NOT NULL), 0)::bigint AS cogs_pct_bps,
      COALESCE(SUM(pct_bps) FILTER (WHERE cost_type IN ('shipping','packaging','payment_fee','marketplace_fee') AND pct_bps IS NOT NULL), 0)::bigint AS variable_pct_bps,
      BOOL_OR(cost_type = 'cogs') AS has_cogs,
      MIN(CASE cost_confidence WHEN 'Trusted' THEN 2 WHEN 'Estimated' THEN 1 ELSE 0 END) AS confidence_rank
      FROM cost_inputs_as_of(p_brand_id, CURRENT_DATE)
     WHERE scope = 'global'
  )
  SELECT rev.net_revenue_minor, spend.marketing_minor, orders.n,
         costs.cogs_pct_bps, costs.variable_pct_bps,
         COALESCE(costs.has_cogs, false),
         COALESCE(costs.confidence_rank, 0)
    FROM rev, spend, orders, costs
$$;

GRANT EXECUTE ON FUNCTION cm2_signal_for_brand(uuid) TO brain_app;

-- ── Migration-time assertion: SECURITY INVOKER + pinned search_path ──
DO $$
DECLARE fn_def TEXT; fn_sec TEXT;
BEGIN
  SELECT p.prosecdef::text, array_to_string(p.proconfig, ', ')
    INTO fn_sec, fn_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'cm2_signal_for_brand' AND n.nspname = 'public';
  IF fn_sec IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'GUARD: cm2_signal_for_brand must be SECURITY INVOKER (RLS applies). Got prosecdef=%', fn_sec;
  END IF;
  IF fn_def IS NULL OR fn_def NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION 'GUARD: cm2_signal_for_brand must pin search_path=public. Got: %', fn_def;
  END IF;
END $$;
