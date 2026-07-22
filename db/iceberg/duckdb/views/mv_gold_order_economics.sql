-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_order_economics
--
-- ADR-0019 WS-3 D5: gold_order_economics is built every Gold pass (gold_order_economics.py) but had NO
-- serving view — it appeared only as a lineage-registry table ref (metric-lineage.ts), so any endpoint
-- that resolved that ref hit a phantom mv_ and 500'd (silent-500-→-empty-chart). This THIN projection
-- over the pre-materialized Iceberg mart (iceberg.brain_gold.gold_order_economics) resolves the lineage
-- ref to a real view and makes the per-order CM1/CM2/CM3 waterfall a served read. Serving is a column
-- projection only (no compute) — the economics waterfall lives in the transform tier.
--
-- Money: every *_minor column is signed bigint MINOR units + the sibling currency_code, never blended,
-- never a float. Grain (brand_id, order_id). brand_id is the tenant key; the ${BRAND_PREDICATE} seam
-- injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_order_economics AS
SELECT
  brand_id,
  order_id,
  brain_id,
  currency_code,
  economics_state,
  is_new_customer,
  net_revenue_minor,
  cogs_minor,
  shipping_fwd_minor,
  shipping_rev_minor,
  packaging_minor,
  fees_minor,
  cm1_minor,
  cm2_minor,
  marketing_minor,
  cm3_minor,
  cm3_allocation_basis,
  components_source,
  order_recognized_at,
  source_system,
  source_event_id,
  job_version,
  updated_at
FROM iceberg.brain_gold.gold_order_economics;
