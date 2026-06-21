-- ============================================================================
-- 0059_shiprocket_connector.sql
-- feat-shiprocket-logistics-connector (Slice 1) — Data Engineer
-- SPEC 3 (logistics) — mirrors 0030_gokwik_shopflo_connectors.sql structure exactly.
-- ============================================================================
--
-- Shiprocket is the SECOND logistics-category source (after the GoKwik AWB feed). It maps to
-- the SAME logistics canonical surface and reuses the SAME CoD/RTO ledger event_types
-- (cod_rto_clawback / cod_delivery_confirmed from 0030) — so this migration adds NO new
-- event_type and NO new physical business table. Parts:
--   (A) connector_instance: extend provider CHECK to include 'shiprocket';
--       add shiprocket_channel_id column (NULL for other providers) + partial index
--   (B) list_shiprocket_connectors_for_repull() — SECURITY DEFINER enumeration fn
--       (mirror list_gokwik_connectors_for_awb_repull); GUC set by the job AFTER enumerate
--   (C) Migration-time assertion DO-blocks (SEC-0059a/b/c) — prosecdef/search_path/grant
--   (D) Post-migration assertion: provider CHECK includes 'shiprocket'
--
-- ADDITIVE ONLY (I-E02): ADD COLUMN IF NOT EXISTS, DROP+ADD CHECK (extension),
--   CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION.
--
-- No new physical table: Silver is mapper-output landed in bronze_events; Gold is the
-- existing realized_revenue_ledger (CoD/RTO event_types already exist since 0030).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS list_shiprocket_connectors_for_repull();
--   ALTER TABLE connector_instance DROP COLUMN IF EXISTS shiprocket_channel_id;
--   (provider CHECK: drop+recreate without 'shiprocket' — remove shiprocket rows first if present)
-- ============================================================================

-- ── (A) connector_instance: add Shiprocket support ───────────────────────────
--
-- Extend the provider CHECK (retain ALL existing values — append-only). shiprocket_channel_id
-- is the non-secret Shiprocket channel/account identifier used for re-pull enumeration keying
-- (mirrors gokwik_appid). NULL for non-shiprocket connectors.

ALTER TABLE connector_instance
  DROP CONSTRAINT IF EXISTS connector_instance_provider_check;

ALTER TABLE connector_instance
  ADD CONSTRAINT connector_instance_provider_check
    CHECK (provider IN (
      'shopify', 'razorpay', 'meta', 'google_ads', 'shopflo', 'gokwik', 'shiprocket'
    ));

ALTER TABLE connector_instance
  ADD COLUMN IF NOT EXISTS shiprocket_channel_id TEXT NULL;

-- Index for shipment re-pull enumeration via shiprocket_channel_id
CREATE INDEX IF NOT EXISTS connector_instance_shiprocket_channel_idx
  ON connector_instance (shiprocket_channel_id)
  WHERE shiprocket_channel_id IS NOT NULL;

-- ── (B) list_shiprocket_connectors_for_repull() ──────────────────────────────
--
-- SECURITY DEFINER enumeration for the shipment trailing-window re-pull job. Runs as 'brain',
-- bypasses FORCE RLS. No GUC at enumerate (the job sets the GUC AFTER the fn returns — durable
-- rule system-job-force-rls-enumeration). Returns shiprocket_channel_id for keying.

CREATE OR REPLACE FUNCTION list_shiprocket_connectors_for_repull()
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    secret_ref             text,
    shiprocket_channel_id  text
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
    ci.shiprocket_channel_id
  FROM connector_instance ci
  WHERE ci.provider = 'shiprocket'
    AND ci.status   = 'connected'
  ORDER BY ci.created_at ASC
$$;

GRANT EXECUTE ON FUNCTION list_shiprocket_connectors_for_repull() TO brain_app;

-- ── (C) Migration-time assertion DO-blocks (SEC-0059) ────────────────────────

-- ── (C-a) list_shiprocket_connectors_for_repull: SECURITY DEFINER + search_path ──
DO $$
DECLARE
  fn_secdef  TEXT;
  fn_config  TEXT;
BEGIN
  SELECT p.prosecdef::text, array_to_string(p.proconfig, ', ')
  INTO fn_secdef, fn_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_shiprocket_connectors_for_repull' AND n.nspname = 'public';

  IF fn_secdef IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'SEC-0059a GUARD: list_shiprocket_connectors_for_repull() must be SECURITY DEFINER (prosecdef=true). Got: %', fn_secdef;
  END IF;
  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION
      'SEC-0059a GUARD: list_shiprocket_connectors_for_repull() must have SET search_path=public. Got config: %', fn_config;
  END IF;
END
$$;

-- ── (C-b) list_shiprocket_connectors_for_repull: brain_app EXECUTE ──
DO $$
DECLARE has_execute BOOLEAN;
BEGIN
  SELECT has_function_privilege('brain_app', 'list_shiprocket_connectors_for_repull()', 'EXECUTE')
  INTO has_execute;
  IF NOT has_execute THEN
    RAISE EXCEPTION 'SEC-0059b GUARD: brain_app does not have EXECUTE on list_shiprocket_connectors_for_repull().';
  END IF;
END
$$;

-- ── (C-c) list_shiprocket_connectors_for_repull: fn exists ──
DO $$
DECLARE fn_count INT;
BEGIN
  SELECT count(*) INTO fn_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_shiprocket_connectors_for_repull' AND n.nspname = 'public';
  IF fn_count = 0 THEN
    RAISE EXCEPTION 'SEC-0059c GUARD: list_shiprocket_connectors_for_repull() not found after creation.';
  END IF;
END
$$;

-- ── (D) Post-migration assertion: provider CHECK includes 'shiprocket' ────────
DO $$
DECLARE chk TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO chk
  FROM pg_constraint c
  WHERE c.conname = 'connector_instance_provider_check';

  IF chk IS NULL OR chk NOT LIKE '%shiprocket%' THEN
    RAISE EXCEPTION
      'SEC-0059 GUARD: connector_instance_provider_check must include shiprocket. Got: %', chk;
  END IF;
END
$$;
