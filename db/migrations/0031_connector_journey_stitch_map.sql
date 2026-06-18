-- ============================================================================
-- 0031_connector_journey_stitch_map.sql
-- feat-journey-touchpoint — Track 1 (@data-engineer). Architecture §3.
-- ============================================================================
--
-- THE deterministic cart-stitch map: a brand-scoped lookup table that projects an
-- anon journey key (brain_anon_id) onto a known order / brain_id. Populated at
-- order-webhook time by reading `brain_anon_id` (+ utm / click_ids) BACK from the
-- order's note_attributes (the storefront pixel forwards them at checkout).
--
-- DETERMINISTIC ONLY (D-5): the anon→order link is READ BACK from the order payload,
--   NEVER inferred/probabilistic/fuzzy/ML. Same input → same stitch row (idempotent).
--   NULL brain_id is HONEST (anon not yet linked in the identity graph) — never guessed.
--
-- Mirrors connector_razorpay_order_map (0027:86-113): tenant-first composite PK,
--   ENABLE+FORCE RLS, NN-1 two-arg fail-closed policy, S/I/U grants (upsert on webhook
--   re-delivery — a lookup table, not append-only), migration-time FORCE+NN-1 assertions.
--
-- ADDITIVE ONLY (I-E02): CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS only.
-- ROLLBACK (migrate down):
--   DROP TABLE IF EXISTS connector_journey_stitch_map;
--   (the read-shim view db/starrocks/bronze_touchpoint_src.sql also drops its
--    connector_journey_stitch_map_src view — reversible, not a migration)
-- ============================================================================

-- ── connector_journey_stitch_map — deterministic anon↔order stitch lookup (§3) ──
--
-- order_id: the Brain ledger spine key (= realized_revenue_ledger.order_id / the
--   Shopify order id used as order_id). The join spine onto silver.order_state.
-- stitched_anon_id: brain_anon_id READ BACK from the order note_attributes (D-5).
-- brain_id: resolved known identity from the identity graph (nullable — anon not
--   yet linked → honest NULL, never inferred).
-- click_ids / utms: the marketing attribution captured at order time (JSONB).

CREATE TABLE IF NOT EXISTS connector_journey_stitch_map (
  brand_id          UUID        NOT NULL,            -- RLS anchor (I-S01) / tenant key
  order_id          TEXT        NOT NULL,            -- Brain ledger spine key (= ledger.order_id)
  stitched_anon_id  TEXT        NOT NULL,            -- brain_anon_id read BACK from the order (D-5)
  brain_id          UUID        NULL,                -- resolved known identity (identity graph; NULL = unlinked)
  click_ids         JSONB       NULL,                -- {fbclid,gclid,ttclid} captured at order time
  utms              JSONB       NULL,                -- {source,medium,campaign,term,content}
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, order_id)                   -- tenant-first composite PK (idempotent upsert)
);

-- Index for the §2 Silver mart join (brand + anon → stitched order/brain_id).
CREATE INDEX IF NOT EXISTS connector_journey_stitch_map_anon_idx
  ON connector_journey_stitch_map (brand_id, stitched_anon_id);

-- ENABLE + FORCE RLS — two-arg fail-closed (I-S01 / NN-1), verbatim 0027:104-113.
ALTER TABLE connector_journey_stitch_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_journey_stitch_map FORCE ROW LEVEL SECURITY;

CREATE POLICY connector_journey_stitch_map_isolation ON connector_journey_stitch_map
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- brain_app: SELECT + INSERT + UPDATE (upsert on webhook re-delivery; NOT append-only).
REVOKE ALL ON connector_journey_stitch_map FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON connector_journey_stitch_map TO brain_app;

-- ── Post-migration assertions (mirror 0027 §G) ────────────────────────────────

-- G-1: connector_journey_stitch_map has FORCE RLS (fail-closed under brain_app)
DO $$
DECLARE
  tbl_rowsecurity      BOOLEAN;
  tbl_forcerowsecurity BOOLEAN;
BEGIN
  SELECT relrowsecurity, relforcerowsecurity
  INTO tbl_rowsecurity, tbl_forcerowsecurity
  FROM pg_class
  WHERE relname = 'connector_journey_stitch_map'
    AND relkind = 'r';

  IF NOT tbl_rowsecurity THEN
    RAISE EXCEPTION
      'SEC-JNY-0031: connector_journey_stitch_map does not have RLS enabled.';
  END IF;

  IF NOT tbl_forcerowsecurity THEN
    RAISE EXCEPTION
      'SEC-JNY-0031: connector_journey_stitch_map does not have FORCE RLS enabled.';
  END IF;
END
$$;

-- G-2: NN-1 two-arg current_setting check on the new table's policy.
DO $$
DECLARE
  bad_policy RECORD;
BEGIN
  FOR bad_policy IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE tablename = 'connector_journey_stitch_map'
      AND (
        qual LIKE '%current_setting(''app.current_brand_id'')%'
        AND qual NOT LIKE '%current_setting(''app.current_brand_id'', TRUE)%'
        AND qual NOT LIKE '%current_setting(''app.current_brand_id'', true)%'
      )
  LOOP
    RAISE EXCEPTION
      'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting. '
      'Replace with two-arg form: current_setting(''app.current_brand_id'', TRUE).',
      bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
  END LOOP;
END
$$;
