-- ============================================================================
-- 0060_woocommerce_connector.sql
-- feat-woocommerce-connector (Slice 1) — Data Engineer
-- SPEC 2 (storefront) — mirrors 0059_shiprocket_connector.sql / 0030 structure exactly.
-- ============================================================================
--
-- WooCommerce is a second storefront-category source (after Shopify). It maps to the SAME
-- canonical order.live.v1 event and reuses the existing order→ledger + silver_order_state
-- pipeline — so this migration adds NO new event_type and NO new physical business table. Parts:
--   (A) connector_instance: extend provider CHECK to include 'woocommerce';
--       add woocommerce_site_url column (NULL for other providers) + partial index
--   (B) list_woocommerce_connectors_for_repull() — SECURITY DEFINER enumeration fn
--       (mirror list_shiprocket_connectors_for_repull); GUC set by the job AFTER enumerate
--   (C) Migration-time assertion DO-blocks (SEC-0060a/b/c) — prosecdef/search_path/grant
--   (D) Post-migration assertion: provider CHECK includes 'woocommerce'
--
-- ADDITIVE ONLY (I-E02). ROLLBACK:
--   DROP FUNCTION IF EXISTS list_woocommerce_connectors_for_repull();
--   ALTER TABLE connector_instance DROP COLUMN IF EXISTS woocommerce_site_url;
--   (provider CHECK: drop+recreate without 'woocommerce' — remove woocommerce rows first if present)
-- ============================================================================

-- ── (A) connector_instance: add WooCommerce support ──────────────────────────
-- woocommerce_site_url: the store base URL (non-secret) — the REST base + webhook-resolution key.

ALTER TABLE connector_instance
  DROP CONSTRAINT IF EXISTS connector_instance_provider_check;

ALTER TABLE connector_instance
  ADD CONSTRAINT connector_instance_provider_check
    CHECK (provider IN (
      'shopify', 'razorpay', 'meta', 'google_ads', 'shopflo', 'gokwik', 'shiprocket', 'woocommerce'
    ));

ALTER TABLE connector_instance
  ADD COLUMN IF NOT EXISTS woocommerce_site_url TEXT NULL;

CREATE INDEX IF NOT EXISTS connector_instance_woocommerce_site_url_idx
  ON connector_instance (woocommerce_site_url)
  WHERE woocommerce_site_url IS NOT NULL;

-- ── (B) list_woocommerce_connectors_for_repull() ─────────────────────────────
-- SECURITY DEFINER enumeration for the REST backfill/incremental re-pull job. Runs as 'brain',
-- bypasses FORCE RLS. No GUC at enumerate (the job sets the GUC AFTER the fn returns).

CREATE OR REPLACE FUNCTION list_woocommerce_connectors_for_repull()
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    secret_ref             text,
    woocommerce_site_url   text
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public
AS $$
  SELECT
    ci.id             AS connector_instance_id,
    ci.brand_id,
    ci.secret_ref,
    ci.woocommerce_site_url
  FROM connector_instance ci
  WHERE ci.provider = 'woocommerce'
    AND ci.status   = 'connected'
  ORDER BY ci.created_at ASC
$$;

GRANT EXECUTE ON FUNCTION list_woocommerce_connectors_for_repull() TO brain_app;

-- ── (C) Migration-time assertion DO-blocks (SEC-0060) ────────────────────────

DO $$
DECLARE
  fn_secdef  TEXT;
  fn_config  TEXT;
BEGIN
  SELECT p.prosecdef::text, array_to_string(p.proconfig, ', ')
  INTO fn_secdef, fn_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_woocommerce_connectors_for_repull' AND n.nspname = 'public';

  IF fn_secdef IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'SEC-0060a GUARD: list_woocommerce_connectors_for_repull() must be SECURITY DEFINER (prosecdef=true). Got: %', fn_secdef;
  END IF;
  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION
      'SEC-0060a GUARD: list_woocommerce_connectors_for_repull() must have SET search_path=public. Got config: %', fn_config;
  END IF;
END
$$;

DO $$
DECLARE has_execute BOOLEAN;
BEGIN
  SELECT has_function_privilege('brain_app', 'list_woocommerce_connectors_for_repull()', 'EXECUTE')
  INTO has_execute;
  IF NOT has_execute THEN
    RAISE EXCEPTION 'SEC-0060b GUARD: brain_app does not have EXECUTE on list_woocommerce_connectors_for_repull().';
  END IF;
END
$$;

DO $$
DECLARE fn_count INT;
BEGIN
  SELECT count(*) INTO fn_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_woocommerce_connectors_for_repull' AND n.nspname = 'public';
  IF fn_count = 0 THEN
    RAISE EXCEPTION 'SEC-0060c GUARD: list_woocommerce_connectors_for_repull() not found after creation.';
  END IF;
END
$$;

-- ── (D) Post-migration assertion: provider CHECK includes 'woocommerce' ───────
DO $$
DECLARE chk TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO chk
  FROM pg_constraint c
  WHERE c.conname = 'connector_instance_provider_check';

  IF chk IS NULL OR chk NOT LIKE '%woocommerce%' THEN
    RAISE EXCEPTION
      'SEC-0060 GUARD: connector_instance_provider_check must include woocommerce. Got: %', chk;
  END IF;
END
$$;
