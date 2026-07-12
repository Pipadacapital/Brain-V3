-- SPEC:D.2 / §1.11.1 / AUD-SL-10 — ATOMIC Trino materialization for iceberg.brain_serving.preagg_net_revenue_week.
-- Run by the semantic-preagg-refresh cron. GENERATED — DO NOT EDIT (change the YAML + recompile).
CREATE OR REPLACE TABLE iceberg.brain_serving.preagg_net_revenue_week
WITH (partitioning = ARRAY['bucket(brand_id, 16)'], format_version = 2)
AS
SELECT
    brand_id,
    date_trunc('week', conversion_at) AS period,
    currency_code,
    channel,
    SUM(net_revenue_minor) AS net_revenue_minor
FROM iceberg.brain_serving.semantic_order
  WHERE conversion_at IS NOT NULL
GROUP BY 1, 2, 3, 4
