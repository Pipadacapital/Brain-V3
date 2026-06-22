-- ============================================================================
-- 0091_data_driven_provider_discovery.sql
-- feat/universal-connector-platform — Data Engineer
-- Gap A: data-driven provider discovery
-- ============================================================================
--
-- PROBLEM: one SECURITY DEFINER fn per provider (list_<provider>_connectors_for_repull)
--   + per-provider fat columns on connector_instance do NOT scale to 100+ connectors.
--   enumerateConnectedConnectors must enumerate 6 separate query blocks, each adding
--   a new fat column + a new SECURITY DEFINER fn on every new provider.
--
-- SOLUTION (additive-then-cutover, I-E02):
--   (A) Add connector_provider_config JSONB to connector_instance.
--       Backfill the existing per-provider fat columns into it (columns KEPT — drop later).
--   (B) Create ONE generic SECURITY DEFINER fn list_connectors_for_repull(provider text)
--       that keys off provider + JSONB (replaces the N per-provider fns; the old fns are
--       KEPT for now — they are retired by the stream-worker rewrite in the same PR).
--   (C) Migration-time assertions (SECURITY DEFINER + search_path + EXECUTE).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS list_connectors_for_repull(text);
--   ALTER TABLE connector_instance DROP COLUMN IF EXISTS connector_provider_config;
--   (Old per-provider fns remain untouched — no rollback needed for those.)
-- ============================================================================

-- ── (A) Add connector_provider_config JSONB ────────────────────────────────────
-- Additive column — NULL for all existing rows before backfill. NOT NULL enforced
-- at the app layer after the backfill is confirmed green.

ALTER TABLE connectors.connector_instance
  ADD COLUMN IF NOT EXISTS connector_provider_config JSONB NULL;

-- ── (A) Backfill: project existing fat columns into JSONB ────────────────────
-- Each provider's relevant non-secret identifier(s) land under a
-- deterministic key set that the generic enumeration fn can select.
-- Rules:
--   shopify     → { shop_domain }   (from shop_domain column)
--   razorpay    → { razorpay_account_id }
--   meta        → { ad_account_id }
--   google_ads  → { ad_account_id }
--   shopflo     → { shopflo_merchant_id }
--   gokwik      → { gokwik_appid }
--   shiprocket  → { shiprocket_channel_id }  (may be NULL if not set)
--   woocommerce → { woocommerce_site_url }
--
-- Idempotent: only overwrites rows where the config is NULL (so re-running
-- a failed migration is safe). Rows already written (e.g. by the app after
-- this migration runs) keep their config.

UPDATE connectors.connector_instance
SET connector_provider_config = CASE provider
    WHEN 'shopify'     THEN jsonb_build_object('shop_domain', shop_domain)
    WHEN 'razorpay'    THEN jsonb_build_object('razorpay_account_id', razorpay_account_id)
    WHEN 'meta'        THEN jsonb_build_object('ad_account_id', ad_account_id)
    WHEN 'google_ads'  THEN jsonb_build_object('ad_account_id', ad_account_id)
    WHEN 'shopflo'     THEN jsonb_build_object('shopflo_merchant_id', shopflo_merchant_id)
    WHEN 'gokwik'      THEN jsonb_build_object('gokwik_appid', gokwik_appid)
    WHEN 'shiprocket'  THEN jsonb_build_object('shiprocket_channel_id', shiprocket_channel_id)
    WHEN 'woocommerce' THEN jsonb_build_object('woocommerce_site_url', woocommerce_site_url)
    ELSE               '{}'::jsonb
END
WHERE connector_provider_config IS NULL;

-- GIN index for JSONB queries (the generic fn does NOT use JSONB operators in its WHERE —
-- it selects the entire column — but application-level queries may want JSONB containment).
CREATE INDEX IF NOT EXISTS connector_instance_provider_config_gin_idx
  ON connectors.connector_instance USING GIN (connector_provider_config)
  WHERE connector_provider_config IS NOT NULL;

-- ── (B) Generic SECURITY DEFINER enumeration fn ───────────────────────────────
-- list_connectors_for_repull(provider text):
--   Replaces the N per-provider fns for the enumeration step.
--   Runs as 'brain' (owner) → bypasses FORCE RLS (same security posture as the
--   existing per-provider fns). Returns ONLY dispatch-only cols — no tenant data
--   content beyond identifiers (same invariant as the old fns, durable rule
--   system-job-force-rls-enumeration).
--
-- The caller sets the brand GUC AFTER the fn returns, before any brand-scoped write.
--
-- search_path = connectors, public — covers connector_instance (now in connectors schema
--   after Phase A) + public functions. SECURITY DEFINER attack mitigated.

CREATE OR REPLACE FUNCTION list_connectors_for_repull(p_provider text)
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    provider               text,
    secret_ref             text,
    provider_config        jsonb
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = connectors, public
AS $$
  SELECT
    ci.id                         AS connector_instance_id,
    ci.brand_id,
    ci.provider,
    ci.secret_ref,
    COALESCE(ci.connector_provider_config, '{}'::jsonb) AS provider_config
  FROM connector_instance ci
  WHERE ci.provider = p_provider
    AND ci.status   = 'connected'
  ORDER BY ci.created_at ASC
$$;

GRANT EXECUTE ON FUNCTION list_connectors_for_repull(text) TO brain_app;

-- ── (C) Migration-time assertions ─────────────────────────────────────────────

-- (C-1) SECURITY DEFINER + search_path guard
DO $$
DECLARE
  fn_secdef  TEXT;
  fn_config  TEXT;
BEGIN
  SELECT p.prosecdef::text, array_to_string(p.proconfig, ', ')
  INTO fn_secdef, fn_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_connectors_for_repull'
    AND n.nspname = 'public'
    AND p.pronargs = 1;  -- the new text-arg version

  IF fn_secdef IS NULL THEN
    RAISE EXCEPTION 'SEC-0091a GUARD: list_connectors_for_repull(text) not found in pg_proc.';
  END IF;
  IF fn_secdef <> 'true' THEN
    RAISE EXCEPTION 'SEC-0091a GUARD: list_connectors_for_repull(text) must be SECURITY DEFINER. Got: %', fn_secdef;
  END IF;
  IF fn_config NOT LIKE '%search_path%' THEN
    RAISE EXCEPTION 'SEC-0091a GUARD: list_connectors_for_repull(text) must pin search_path. Got config: %', fn_config;
  END IF;
END
$$;

-- (C-2) brain_app EXECUTE grant guard
DO $$
DECLARE
  has_grant BOOLEAN;
BEGIN
  SELECT has_function_privilege('brain_app', 'list_connectors_for_repull(text)', 'EXECUTE')
  INTO has_grant;
  IF NOT has_grant THEN
    RAISE EXCEPTION 'SEC-0091b GUARD: brain_app lacks EXECUTE on list_connectors_for_repull(text).';
  END IF;
END
$$;

-- (C-3) connector_provider_config column exists
DO $$
DECLARE
  col_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'connector_instance'
      AND column_name = 'connector_provider_config'
  ) INTO col_exists;
  IF NOT col_exists THEN
    RAISE EXCEPTION 'SEC-0091c GUARD: connector_instance.connector_provider_config column not found.';
  END IF;
END
$$;

-- (C-4) Backfill coverage check — all connected rows must have a non-null config
DO $$
DECLARE
  missing_count BIGINT;
BEGIN
  SELECT COUNT(*)
  INTO missing_count
  FROM connectors.connector_instance
  WHERE status = 'connected'
    AND connector_provider_config IS NULL;

  IF missing_count > 0 THEN
    RAISE EXCEPTION 'SEC-0091d GUARD: % connected connector_instance rows still have NULL connector_provider_config after backfill.', missing_count;
  END IF;
END
$$;
