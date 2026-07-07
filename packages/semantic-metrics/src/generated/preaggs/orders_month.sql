-- SPEC:D.2 / §1.11.1 — Spark-maintained pre-agg for interactive metric orders @ grain=month.
-- Additive MEASURES only; the non-additive metric value is derived at read in the view.
CREATE TABLE IF NOT EXISTS iceberg.brain_serving.preagg_orders_month (
  brand_id varchar,
  period timestamp(6),
  channel varchar,
  order_count bigint
)
USING iceberg
PARTITIONED BY (bucket(16, brand_id))
TBLPROPERTIES ('format-version'='2', 'write.delete.mode'='merge-on-read');

-- SPEC:D.2 / §1.11.1 — refresh (idempotent full rebuild) for iceberg.brain_serving.preagg_orders_month. Run by the Spark refresh loop.
INSERT OVERWRITE iceberg.brain_serving.preagg_orders_month
SELECT
    brand_id,
    date_trunc('month', conversion_at) AS period,
    channel,
    COUNT(DISTINCT order_id) AS order_count
FROM iceberg.brain_serving.semantic_order
  WHERE conversion_at IS NOT NULL
GROUP BY 1, 2, 3;
