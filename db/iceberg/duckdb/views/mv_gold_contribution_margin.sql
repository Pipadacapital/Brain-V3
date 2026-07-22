-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_contribution_margin
--
-- ADR-0019 WS-3 D5: gold_contribution_margin is built every Gold pass (gold_contribution_margin.py)
-- but had NO serving view — dead transform compute, and the reader (contribution-margin.ts)
-- recomputed CM1/CM2 at read time. This THIN projection over the pre-materialized Iceberg mart
-- (iceberg.brain_gold.gold_contribution_margin) turns the dead mart into a served read; the reader
-- repoints behind SERVING_CONTRIB_MARGIN_FROM_MART (default OFF → today's live recompute). Serving
-- is a column projection only (no compute) — the CM math lives in the transform tier.
--
-- Money: net_revenue_minor / cogs_minor / variable_minor / cm1_minor / marketing_minor / cm2_minor are
-- bigint MINOR units + the sibling currency_code, never blended, never a float. Grain (brand_id,
-- currency_code). Parity: the mart result must match the live recompute to the money-byte before the
-- flag flips default-ON (ADR-0019 WS-3 parity gate).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_contribution_margin; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is attached as `iceberg`;
-- local views shadow its namespace). brand_id is the tenant key; the ${BRAND_PREDICATE} seam injects
-- brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_contribution_margin AS
SELECT
  brand_id,
  currency_code,
  as_of_date,
  net_revenue_minor,
  cogs_minor,
  variable_minor,
  cm1_minor,
  marketing_minor,
  cm2_minor,
  cost_confidence,
  updated_at
FROM iceberg.brain_gold.gold_contribution_margin;
