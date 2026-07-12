-- SPEC:D.2 / §1.11.1 / AUD-SL-10 — ATOMIC Trino materialization for iceberg.brain_serving.preagg_aov_month.
-- Run by the semantic-preagg-refresh cron. GENERATED — DO NOT EDIT (change the YAML + recompile).
CREATE OR REPLACE TABLE iceberg.brain_serving.preagg_aov_month
WITH (partitioning = ARRAY['bucket(brand_id, 16)'], format_version = 2)
AS
SELECT
    brand_id,
    date_trunc('month', conversion_at) AS period,
    currency_code,
    channel,
    SUM(order_value_minor) AS gross_revenue_minor,
    COUNT(DISTINCT order_id) AS order_count
FROM iceberg.brain_serving.semantic_order
  WHERE conversion_at IS NOT NULL
GROUP BY 1, 2, 3, 4
