-- ============================================================================
-- 0021_connector_health.sql — additive: 7-state health + safety on connector_instance.
-- ============================================================================
-- I-E02 (additive only): NO DROP of existing columns, NO rewrite of 0006.
-- NN-2 unaffected: no token/ciphertext column added.
-- RLS already ENABLE+FORCE on connector_instance (0006:42-43); policy untouched.
-- brain_app GRANT unchanged: columns inherit table-level SELECT/INSERT/UPDATE.
--
-- ADR-CM-5: 2 new columns (health_state + safety_rating) on connector_instance.
-- ADR-CM-6: UNIQUE(brand_id,provider) kept — KNOWN-CM-01: one instance per
--   (brand,provider) until a multi-account connector lands.
-- ============================================================================

-- 1) 7-state health (default keeps every existing row valid → 'Healthy').
ALTER TABLE connector_instance
  ADD COLUMN IF NOT EXISTS health_state TEXT NOT NULL DEFAULT 'Healthy'
    CHECK (health_state IN
      ('Healthy','Delayed','Failed','Disconnected','RateLimited','TokenExpired','Disabled'));

-- 2) 3-state recommendation safety.
ALTER TABLE connector_instance
  ADD COLUMN IF NOT EXISTS safety_rating TEXT NOT NULL DEFAULT 'safe'
    CHECK (safety_rating IN ('safe','degraded','blocked'));

-- 3) EXTEND provider CHECK additively to the Phase-1a catalog providers (even if
--    they ship coming_soon — keeps the column ready when a credential connector lands).
--    Drop+recreate the CHECK CONSTRAINT only (NOT the column) — additive in effect.
ALTER TABLE connector_instance DROP CONSTRAINT IF EXISTS connector_instance_provider_check;
ALTER TABLE connector_instance
  ADD CONSTRAINT connector_instance_provider_check
  CHECK (provider IN ('shopify','meta','google_ads','razorpay'));

-- 4) status CHECK: NO change needed this slice — health_state is the new SoR for the
--    7-state surface; the legacy 3-state `status` stays as-is (connect/disconnect still
--    write it for back-compat). Documented: status is legacy, health_state is the surface.

-- ── NN-1 assertion (carry-forward from 0006) ─────────────────────────────────
DO $$
DECLARE
  bad_policy RECORD;
BEGIN
  FOR bad_policy IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE tablename = 'connector_instance'
      AND (
        (qual LIKE '%current_setting(''app.current_brand_id'')%'
         AND qual NOT LIKE '%current_setting(''app.current_brand_id'', TRUE)%'
         AND qual NOT LIKE '%current_setting(''app.current_brand_id'', true)%')
      )
  LOOP
    RAISE EXCEPTION
      'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting (0021 check).',
      bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
  END LOOP;
END
$$;
