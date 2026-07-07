-- 0126_gold_product_costs.sql
--
-- SPEC:C.2.4 — versioned per-SKU cost sheet (`gold_product_costs`).
--
-- WHY: Wave C's COGS input (gold_measurement_costs / gold_order_economics, C.2.4/C.3) needs a
-- per-SKU unit cost when the connector catalog carries no cost field (product.upsert has none —
-- resources.ts:85). This is the brand-uploaded cost sheet: a CSV ingest endpoint lands rows HERE,
-- and Wave C's Spark COGS resolution reads them (JDBC, exactly like the ad_spend PG source is read
-- into the lakehouse). `cost_input` (0055) is the ANCESTOR — that table holds brand-level RATE
-- config (pct/fixed by scope global|sku|category); THIS table holds per-SKU UNIT costs with
-- bi-temporal validity so a cost can change over time without losing history.
--
-- ADDITIVE ONLY (§0.5): new table, no existing table touched. cost_input is left intact.
--
-- INVARIANTS:
--   • brand_id FIRST — tenant key / RLS anchor (§1.2).
--   • MONEY = integer minor units (BIGINT, I-S07) + explicit ISO-4217 currency_code, NEVER a float.
--     GCC 3-decimal currencies (BHD/KWD/OMR) carry 3-decimal minor units — the value is stored
--     already-minor; this table never multiplies/divides, so no rounding is ever introduced.
--   • cost_minor >= 0 — a unit cost is never negative (CHECK).
--   • BI-TEMPORAL validity: valid_from/valid_to is the VALID-TIME axis (when the cost applies);
--     created_at/updated_at is the TRANSACTION-TIME axis (when we recorded it). For one
--     (brand_id, sku, currency_code) the validity intervals may NOT overlap — DB-enforced by a GiST
--     EXCLUDE over daterange[valid_from, valid_to) (NULL valid_to = open-ended / currently valid).
--   • LINEAGE: source_system + source_event_id on every row (the upload batch that produced it).
--   • NOT subject-linked (keyed by SKU, not by a person) → NO shred-manifest entry required.
--
-- NOT append-only: like cost_input this is brand CONFIGURATION — a version is corrected in place
-- (UPDATE) or superseded by closing valid_to and inserting the next version. brain_app therefore
-- holds SELECT + INSERT + UPDATE, NO DELETE (history is retained). RLS FORCE + two-arg fail-closed.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS gold_product_costs (
  brand_id        UUID        NOT NULL,                              -- tenant key / RLS anchor (FIRST)
  product_cost_id TEXT        NOT NULL,                              -- deterministic: sha256(brand‖sku‖currency‖valid_from)
  sku             TEXT        NOT NULL,
  cost_minor      BIGINT      NOT NULL CHECK (cost_minor >= 0),      -- unit cost, minor units (I-S07), non-negative
  currency_code   CHAR(3)     NOT NULL,
  valid_from      DATE        NOT NULL,                              -- valid-time lower bound (inclusive)
  valid_to        DATE        NULL,                                  -- valid-time upper bound (exclusive); NULL = open-ended
  source_system   TEXT        NOT NULL DEFAULT 'cost_sheet_csv',     -- lineage: producing system
  source_event_id TEXT        NOT NULL,                              -- lineage: upload batch id (deterministic per upload)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),                -- transaction-time lower bound
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),                -- transaction-time of last correction
  PRIMARY KEY (brand_id, product_cost_id),
  -- valid_to, when set, must be strictly after valid_from (a version covers a non-empty interval).
  CONSTRAINT gpc_valid_interval CHECK (valid_to IS NULL OR valid_to > valid_from),
  -- NO OVERLAP: for one (brand, sku, currency) the [valid_from, valid_to) intervals are disjoint.
  -- daterange with a NULL upper bound is unbounded-above ⇒ one open version per key at a time.
  CONSTRAINT gpc_no_overlap EXCLUDE USING gist (
    brand_id      WITH =,
    sku           WITH =,
    currency_code WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  )
);

-- As-of read scan: resolve the cost valid for a (sku, currency) at a date.
CREATE INDEX IF NOT EXISTS gold_product_costs_asof_idx
  ON gold_product_costs (brand_id, sku, currency_code, valid_from);

-- ── RLS — two-arg fail-closed (NN-1) ─────────────────────────────────────────
ALTER TABLE gold_product_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE gold_product_costs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gold_product_costs_isolation ON gold_product_costs;
CREATE POLICY gold_product_costs_isolation ON gold_product_costs
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)
  WITH CHECK (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- Config table (not append-only): SELECT + INSERT + UPDATE; NO DELETE (history is retained).
REVOKE ALL ON gold_product_costs FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON gold_product_costs TO brain_app;

-- ── Read seam: product_cost_as_of — the unit cost effective for (sku, currency) at a date ──
-- SECURITY INVOKER (RLS applies). Wave C's COGS resolution reads through this (or the base table
-- via JDBC). Returns 0 or 1 row (the EXCLUDE constraint guarantees at most one valid version).
CREATE OR REPLACE FUNCTION product_cost_as_of(
  p_brand_id UUID, p_sku TEXT, p_currency CHAR(3), p_as_of DATE
)
  RETURNS TABLE (cost_minor BIGINT, currency_code CHAR(3), valid_from DATE, valid_to DATE)
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
  SET search_path = public
AS $$
  SELECT cost_minor, currency_code, valid_from, valid_to
    FROM gold_product_costs
   WHERE brand_id = p_brand_id
     AND sku = p_sku
     AND currency_code = p_currency
     AND valid_from <= p_as_of
     AND (valid_to IS NULL OR valid_to > p_as_of)
$$;

GRANT EXECUTE ON FUNCTION product_cost_as_of(uuid, text, char, date) TO brain_app;

-- ── Migration-time assertions (FORCE RLS + no DELETE grant + I-S07 money type + no-overlap) ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'gold_product_costs' AND relforcerowsecurity = true
  ) THEN
    RAISE EXCEPTION '0126 failed: gold_product_costs must FORCE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_name = 'gold_product_costs' AND grantee = 'brain_app' AND privilege_type = 'DELETE'
  ) THEN
    RAISE EXCEPTION '0126 failed: brain_app must NOT hold DELETE on gold_product_costs (history is retained)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'gold_product_costs' AND column_name = 'cost_minor' AND data_type = 'bigint'
  ) THEN
    RAISE EXCEPTION '0126 failed: gold_product_costs.cost_minor must be BIGINT minor units (I-S07)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gpc_no_overlap' AND contype = 'x'
  ) THEN
    RAISE EXCEPTION '0126 failed: gpc_no_overlap EXCLUDE (no overlapping validity) missing';
  END IF;
END $$;
