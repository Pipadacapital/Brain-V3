-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_snap_attribution_credit
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_snap_attribution_credit.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_silver.snap_attribution_credit). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Attribution-credit daily SNAPSHOT (lives in the Iceberg SILVER namespace). credited_revenue_minor SIGNED BIGINT minor units + currency_code, never blended. Key (brand_id, credit_id, snapshot_date).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_snap_attribution_credit;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_snap_attribution_credit. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_snap_attribution_credit AS
SELECT
  brand_id,
  credit_id,
  snapshot_date,
  order_id,
  channel,
  campaign_id,
  model_id,
  model_version,
  row_kind,
  credited_revenue_minor,
  currency_code,
  confidence_grade,
  occurred_at,
  computed_at
FROM iceberg.brain_silver.snap_attribution_credit;
