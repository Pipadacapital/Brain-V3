-- SPEC:D.2 / §1.11.1 — Spark-maintained pre-agg for interactive metric aov @ grain=week.
-- Additive MEASURES only; the non-additive metric value is derived at read in the view.
CREATE TABLE IF NOT EXISTS iceberg.brain_serving.preagg_aov_week (
  brand_id varchar,
  period timestamp(6),
  currency_code varchar,
  channel varchar,
  gross_revenue_minor bigint,
  order_count bigint
)
USING iceberg
PARTITIONED BY (bucket(16, brand_id))
TBLPROPERTIES ('format-version'='2', 'write.delete.mode'='merge-on-read');

-- SPEC:D.2 / §1.11.1 — refresh (idempotent full rebuild) for iceberg.brain_serving.preagg_aov_week. Run by the Spark refresh loop.
INSERT OVERWRITE iceberg.brain_serving.preagg_aov_week
SELECT
    brand_id,
    date_trunc('week', conversion_at) AS period,
    currency_code,
    channel,
    SUM(order_value_minor) AS gross_revenue_minor,
    COUNT(DISTINCT order_id) AS order_count
FROM iceberg.brain_serving.semantic_order
  WHERE conversion_at IS NOT NULL
GROUP BY 1, 2, 3, 4;
