-- 0055_cost_input.sql
--
-- feat-cm2-cost-inputs (the "True CM2" moat foundation).
--
-- Brain can compute realized REVENUE but not MARGIN: there is no cost structure, so cost_confidence
-- floors to 'D' for every brand (computeCostConfidence([]) — no cost-relevant grades) and the
-- billing cap fee = max(min(tier%·GMV, cap%·CM2), floor) is uncomputable. This adds the per-brand
-- cost inputs from which Contribution Margin (CM1/CM2) is computed.
--
-- UNLIKE the ledgers, cost_input is brand CONFIGURATION (not append-only events): a brand edits its
-- COGS/shipping/fee structure over time, so brain_app gets SELECT + INSERT + UPDATE (no DELETE —
-- history via effective_from/effective_to + updated_at). RLS FORCE + two-arg fail-closed (NN-1).
--
-- A cost input is EITHER a percentage of revenue (pct_bps) OR a fixed per-order amount (amount_minor)
-- — exactly one (CHECK). Money is BIGINT minor units (I-S07). cost_confidence per input records how
-- the cost was sourced (manual='Trusted', benchmark default='Estimated', absent='Insufficient') and
-- floors into the metric-engine CM confidence.

CREATE TABLE IF NOT EXISTS cost_input (
  brand_id        UUID        NOT NULL,                              -- tenant key / RLS anchor
  cost_input_id   TEXT        NOT NULL,                              -- deterministic: sha256(brand‖scope‖scope_ref‖cost_type)
  scope           TEXT        NOT NULL
                    CHECK (scope IN ('global', 'sku', 'category')),
  scope_ref       TEXT        NOT NULL DEFAULT '',                   -- '' for global; sku id / category name otherwise
  cost_type       TEXT        NOT NULL
                    CHECK (cost_type IN ('cogs', 'shipping', 'packaging', 'payment_fee', 'marketplace_fee')),
  amount_minor    BIGINT      NULL,                                  -- fixed per-order cost (minor units, I-S07)
  pct_bps         INT         NULL                                   -- OR percent-of-revenue in basis points (4000 = 40%)
                    CHECK (pct_bps IS NULL OR (pct_bps >= 0 AND pct_bps <= 100000)),
  currency_code   CHAR(3)     NOT NULL,
  cost_confidence TEXT        NOT NULL DEFAULT 'Estimated'
                    CHECK (cost_confidence IN ('Trusted', 'Estimated', 'Insufficient')),
  effective_from  DATE        NOT NULL DEFAULT CURRENT_DATE,
  effective_to    DATE        NULL,                                  -- NULL = currently active
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, cost_input_id),
  -- exactly one of pct_bps / amount_minor (a cost is a rate OR a fixed amount, never both/neither)
  CONSTRAINT cost_input_rate_xor_amount CHECK ((amount_minor IS NOT NULL) <> (pct_bps IS NOT NULL))
);

-- Active-input scan: the metric engine reads the currently-effective inputs for a brand.
CREATE INDEX IF NOT EXISTS cost_input_active_idx
  ON cost_input (brand_id, scope, cost_type)
  WHERE effective_to IS NULL;

-- ── RLS — two-arg fail-closed (NN-1) ─────────────────────────────────────────
ALTER TABLE cost_input ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_input FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_input_isolation ON cost_input;
CREATE POLICY cost_input_isolation ON cost_input
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)
  WITH CHECK (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- Config table (not append-only): SELECT + INSERT + UPDATE; NO DELETE (history is retained).
REVOKE ALL ON cost_input FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON cost_input TO brain_app;

-- ── Read seam: cost_inputs_as_of — the currently-effective inputs for a brand at a date ──
-- SECURITY INVOKER (RLS applies). The metric engine (computeContributionMargin) reads through this.
CREATE OR REPLACE FUNCTION cost_inputs_as_of(p_brand_id UUID, p_as_of DATE)
  RETURNS TABLE (
    scope           TEXT,
    scope_ref       TEXT,
    cost_type       TEXT,
    amount_minor    BIGINT,
    pct_bps         INT,
    currency_code   CHAR(3),
    cost_confidence TEXT
  )
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
  SET search_path = public
AS $$
  SELECT scope, scope_ref, cost_type, amount_minor, pct_bps, currency_code, cost_confidence
    FROM cost_input
   WHERE brand_id = p_brand_id
     AND effective_from <= p_as_of
     AND (effective_to IS NULL OR effective_to > p_as_of)
$$;

GRANT EXECUTE ON FUNCTION cost_inputs_as_of(uuid, date) TO brain_app;

-- ── Migration-time assertions (FORCE RLS + no DELETE grant + I-S07 money type) ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'cost_input' AND relforcerowsecurity = true
  ) THEN
    RAISE EXCEPTION 'GUARD: cost_input must FORCE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_name = 'cost_input' AND grantee = 'brain_app' AND privilege_type = 'DELETE'
  ) THEN
    RAISE EXCEPTION 'GUARD: brain_app must NOT hold DELETE on cost_input (history is retained)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'cost_input' AND column_name = 'amount_minor' AND data_type = 'bigint'
  ) THEN
    RAISE EXCEPTION 'GUARD: cost_input.amount_minor must be BIGINT minor units (I-S07)';
  END IF;
END $$;
