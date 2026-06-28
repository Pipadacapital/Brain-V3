-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_silver_return  (SR-10)
--
-- Thin serving projection over the Iceberg return mart that Spark builds
-- (iceberg.brain_silver.silver_return — SR-4). Sibling of mv_silver_shipment,
-- but for the RETURN lifecycle, which is a SEPARATE dimension that must NEVER be
-- confused with forward delivery / RTO. Returns carry NO terminal_class column
-- (by design), so this view cannot leak a false forward DELIVERED into the ledger.
--
-- No money. Grain (brand_id, order_id). The metric-engine reads this as the
-- two-part name brain_serving.mv_silver_return; with the Trino default catalog =
-- iceberg that resolves to iceberg.brain_serving.mv_silver_return. brand_id is the
-- tenant key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
--
-- Hashed identity columns (awb_number_hash / hashed_customer_*) are PROJECTED but
-- only ever read as hashes — raw PII never reaches Silver.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_silver_return AS
SELECT
  brand_id,
  order_id,
  source,
  awb_number_hash,
  courier,
  current_status,
  return_class,
  is_return_complete,
  payment_method,
  pincode,
  hashed_customer_email,
  hashed_customer_phone,
  first_event_at,
  last_status_at,
  is_synthetic,
  updated_at
FROM iceberg.brain_silver.silver_return;
