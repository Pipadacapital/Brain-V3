-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_conversion_feedback
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- serving projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_conversion_feedback — db/iceberg/spark/gold/gold_conversion_feedback.py).
-- Serving is fast because Gold/Silver are already materialized by Spark; the view is a
-- column projection only (no compute). Redis fronts hot reads (analytics-cache.ts).
--
-- Conversion-feedback / lead surface. Grain (brand_id, feedback_date, form_id) — daily
-- form-submission volume + session/journey reach + the brand-day payment-success reach
-- (the conversion side of the lead→payment loop). NO money (a lead/intent + payment-reach
-- counter). PII-SAFE: STRUCTURAL form_id + counts only; NO raw entered field values.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_conversion_feedback; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_conversion_feedback AS
SELECT
  brand_id,
  feedback_date,
  form_id,
  submissions,
  sessions,
  journeys,
  payments_succeeded,
  updated_at
FROM iceberg.brain_gold.gold_conversion_feedback;
