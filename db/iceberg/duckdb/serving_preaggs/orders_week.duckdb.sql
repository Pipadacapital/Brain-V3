-- SPEC:D.2 / §1.11.1 / AUD-SL-10 — ATOMIC DuckDB materialization for iceberg.brain_serving.preagg_orders_week.
-- Run by the semantic-preagg-refresh cron (db/iceberg/duckdb/serving_preagg_refresh.py).
-- GENERATED — DO NOT EDIT (change the YAML + recompile: pnpm --filter @brain/semantic-metrics compile).
CREATE TABLE IF NOT EXISTS iceberg.brain_serving.preagg_orders_week (
  brand_id string,
  period timestamptz,
  channel string,
  order_count bigint
)
PARTITIONED BY (bucket(16, brand_id));

BEGIN TRANSACTION;

DELETE FROM iceberg.brain_serving.preagg_orders_week;

INSERT INTO iceberg.brain_serving.preagg_orders_week
SELECT
    brand_id,
    date_trunc('week', conversion_at) AS period,
    channel,
    COUNT(DISTINCT order_id) AS order_count
FROM brain_serving.semantic_order
  WHERE conversion_at IS NOT NULL
GROUP BY 1, 2, 3;

COMMIT;
