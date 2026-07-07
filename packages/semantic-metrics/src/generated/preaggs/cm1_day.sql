-- SPEC:D.2 / §1.11.1 — Spark-maintained pre-agg for interactive metric cm1 @ grain=day.
-- Additive MEASURES only; the non-additive metric value is derived at read in the view.
CREATE TABLE IF NOT EXISTS iceberg.brain_serving.preagg_cm1_day (
  brand_id varchar,
  period timestamp(6),
  currency_code varchar,
  channel varchar,
  cm1_minor bigint
)
USING iceberg
PARTITIONED BY (bucket(16, brand_id))
TBLPROPERTIES ('format-version'='2', 'write.delete.mode'='merge-on-read');

-- SPEC:D.2 / §1.11.1 — refresh (idempotent full rebuild) for iceberg.brain_serving.preagg_cm1_day. Run by the Spark refresh loop.
INSERT OVERWRITE iceberg.brain_serving.preagg_cm1_day
SELECT
    brand_id,
    date_trunc('day', conversion_at) AS period,
    currency_code,
    channel,
    SUM(cm1_minor) AS cm1_minor
FROM iceberg.brain_serving.semantic_order
  WHERE conversion_at IS NOT NULL
GROUP BY 1, 2, 3, 4;
