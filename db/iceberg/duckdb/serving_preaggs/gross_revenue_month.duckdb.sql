-- SPEC:D.2 / §1.11.1 / AUD-SL-10 — ATOMIC DuckDB materialization for iceberg.brain_serving.preagg_gross_revenue_month.
-- Run by the semantic-preagg-refresh cron (db/iceberg/duckdb/serving_preagg_refresh.py).
-- GENERATED — DO NOT EDIT (change the YAML + recompile: pnpm --filter @brain/semantic-metrics compile).
CREATE TABLE IF NOT EXISTS iceberg.brain_serving.preagg_gross_revenue_month (
  brand_id string,
  period timestamptz,
  currency_code string,
  channel string,
  gross_revenue_minor bigint
)
PARTITIONED BY (bucket(16, brand_id));

BEGIN TRANSACTION;

DELETE FROM iceberg.brain_serving.preagg_gross_revenue_month;

INSERT INTO iceberg.brain_serving.preagg_gross_revenue_month
SELECT
    brand_id,
    date_trunc('month', conversion_at) AS period,
    currency_code,
    channel,
    SUM(order_value_minor) AS gross_revenue_minor
FROM brain_serving.semantic_order
  WHERE conversion_at IS NOT NULL
GROUP BY 1, 2, 3, 4;

COMMIT;
