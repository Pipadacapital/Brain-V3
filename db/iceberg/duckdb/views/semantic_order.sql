-- ============================================================
-- SPEC:D.1 — Semantic ENTITY view: semantic_order
--
-- Wave D semantic layer. ONE ROW PER ORDER, a THIN COMPOSITION (no recompute) over:
--   • iceberg.brain_silver.silver_order_state    — order spine (customer link brain_id, lifecycle, order value)
--   • iceberg.brain_gold.gold_order_economics     — FULL Wave C economics (CM1/CM2/CM3 per AMD-17 spec numbering,
--       economics_state, is_new_customer, cost/fee/marketing parts, cm3_allocation_basis)
--   • iceberg.brain_silver.silver_order_line      — line summary (count / total qty / distinct SKUs)
--   • iceberg.brain_gold.gold_attribution_credit  — DETERMINISTIC attributed channel/campaign (top credit).
--       §1.4: attribution consumes deterministic identity links only; this is the deterministic ledger.
--       (Empty on golden today → channel/campaign_id NULL = honest unknown, never a guessed attribution.)
--
-- Journey trace pointer: (brand_id, brain_id, conversion_at=order_recognized_at) is exactly the key the
-- Wave-B Journey API `GET /v1/journeys/trace?order_id=` uses to lift the lookback touchpoints — this row
-- carries the pointer, not the trace payload.
--
-- Money: order_value_minor / net_revenue_minor / all *_minor are bigint MINOR units + currency_code,
-- per-currency, never blended/float. Grain: one row per (brand_id, order_id). brand_id FIRST/tenant key;
-- consumers read through the ${BRAND_PREDICATE} seam (brand_id = ?) — every join predicate is brand_id-keyed.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.semantic_order AS
SELECT
  o.brand_id,
  o.order_id,
  o.brain_id,                                 -- customer link + journey trace pointer
  -- order state
  o.lifecycle_state,
  o.is_terminal,
  o.order_value_minor,
  o.currency_code,
  o.first_event_at,
  o.state_effective_at,
  -- Wave C economics (spec CM1/CM2/CM3, AMD-17)
  e.economics_state,
  e.is_new_customer,
  e.net_revenue_minor,
  e.cogs_minor,
  e.shipping_fwd_minor,
  e.shipping_rev_minor,
  e.packaging_minor,
  e.fees_minor,
  e.cm1_minor,
  e.cm2_minor,
  e.marketing_minor,
  e.cm3_minor,
  e.cm3_allocation_basis,
  e.order_recognized_at AS conversion_at,      -- journey trace pointer (conversion ts)
  -- line summary
  COALESCE(l.line_count, 0)      AS line_count,
  COALESCE(l.total_quantity, 0)  AS total_quantity,
  l.distinct_skus,
  -- deterministic attributed channel/campaign (top credit; NULL when unattributed — honest)
  a.channel,
  a.campaign_id,
  a.model_id AS attribution_model_id,
  o.updated_at
FROM iceberg.brain_silver.silver_order_state o
LEFT JOIN iceberg.brain_gold.gold_order_economics e
  ON e.brand_id = o.brand_id AND e.order_id = o.order_id
LEFT JOIN (
  SELECT
    ol.brand_id,
    ol.order_id,
    count(*)                      AS line_count,
    sum(ol.quantity)              AS total_quantity,
    array_agg(DISTINCT ol.sku)    AS distinct_skus
  FROM iceberg.brain_silver.silver_order_line ol
  GROUP BY ol.brand_id, ol.order_id
) l ON l.brand_id = o.brand_id AND l.order_id = o.order_id
LEFT JOIN (
  -- Top deterministic attribution credit per order (highest weight, earliest touch tie-break).
  SELECT brand_id, order_id, channel, campaign_id, model_id
  FROM (
    SELECT
      ac.brand_id, ac.order_id, ac.channel, ac.campaign_id, ac.model_id,
      row_number() OVER (
        PARTITION BY ac.brand_id, ac.order_id
        ORDER BY ac.weight_fraction DESC, ac.touch_seq ASC
      ) AS rn
    FROM iceberg.brain_gold.gold_attribution_credit ac
    WHERE ac.row_kind = 'credit'
  ) ranked
  WHERE rn = 1
) a ON a.brand_id = o.brand_id AND a.order_id = o.order_id;
