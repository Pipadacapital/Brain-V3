-- ============================================================================
-- 0030_gokwik_shopflo_connectors.sql
-- feat-gokwik-shopflo-connectors (Slice 1) — Track A (Data Engineer)
-- 05-architecture.md §6
-- ============================================================================
--
-- Mirrors 0027_razorpay_settlement.sql + 0029_ad_spend.sql structure exactly. Parts:
--   (A) connector_instance: extend provider CHECK to include shopflo/gokwik;
--       add shopflo_merchant_id + gokwik_appid columns (NULL for other providers)
--       + partial indexes
--   (B) realized_revenue_ledger: extend event_type CHECK (retain ALL existing values)
--       + add cod_rto_clawback / cod_delivery_confirmed
--   (C) resolve_shopflo_connector_by_merchant(text) — SECURITY DEFINER webhook brand resolve
--   (D) list_shopflo_connectors() — SECURITY DEFINER enumeration fn
--   (E) list_gokwik_connectors_for_awb_repull() — SECURITY DEFINER enumeration fn
--       (returns gokwik_appid for AWB re-pull + RTO-Predict keying)
--   (F) Migration-time assertion DO-blocks (SEC-0030a..i) — prosecdef/search_path/grant
--   (G) Post-migration assertions: provider CHECK includes new values; fns SECURITY DEFINER
--
-- ADDITIVE ONLY (I-E02):
--   - ALTER TABLE ... ADD COLUMN IF NOT EXISTS
--   - ALTER TABLE ... DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT (CHECK extension)
--   - CREATE INDEX IF NOT EXISTS
--   - CREATE OR REPLACE FUNCTION
--
-- No new physical table: Silver is mapper-output landed in bronze_events;
-- Gold is the extended realized_revenue_ledger. Both reuse existing FORCE-RLS tables.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS resolve_shopflo_connector_by_merchant(text);
--   DROP FUNCTION IF EXISTS list_shopflo_connectors();
--   DROP FUNCTION IF EXISTS list_gokwik_connectors_for_awb_repull();
--   ALTER TABLE connector_instance DROP COLUMN IF EXISTS shopflo_merchant_id;
--   ALTER TABLE connector_instance DROP COLUMN IF EXISTS gokwik_appid;
--   (provider CHECK: drop+recreate to ('shopify','razorpay','meta','google_ads'))
--   (event_type CHECK: drop+recreate without cod_rto_clawback/cod_delivery_confirmed —
--    ledger rebuildable from Bronze; remove rows of the new event_types first if present)
-- ============================================================================

-- ── (A) connector_instance: add Shopflo + GoKwik support ─────────────────────
--
-- The existing CHECK (provider IN ('shopify','razorpay','meta','google_ads')) is
-- extended to include 'shopflo' and 'gokwik'. Drop+re-add (additive — same pattern
-- as 0027/0029).
--
-- shopflo_merchant_id: the Shopflo Merchant ID (non-secret merchant identifier).
--   Read by resolve_shopflo_connector_by_merchant() at webhook-receive time to
--   resolve brand_id from the connector ROW (MT-1 — never from the webhook body).
--   NULL for non-shopflo connectors.
-- gokwik_appid: the GoKwik appid (non-secret app identifier).
--   Used for AWB re-pull enumeration + RTO-Predict event keying.
--   NULL for non-gokwik connectors.

ALTER TABLE connector_instance
  DROP CONSTRAINT IF EXISTS connector_instance_provider_check;

ALTER TABLE connector_instance
  ADD CONSTRAINT connector_instance_provider_check
    CHECK (provider IN ('shopify', 'razorpay', 'meta', 'google_ads', 'shopflo', 'gokwik'));

ALTER TABLE connector_instance
  ADD COLUMN IF NOT EXISTS shopflo_merchant_id TEXT NULL;

ALTER TABLE connector_instance
  ADD COLUMN IF NOT EXISTS gokwik_appid TEXT NULL;

-- Index for webhook brand resolution via shopflo_merchant_id
CREATE INDEX IF NOT EXISTS connector_instance_shopflo_merchant_idx
  ON connector_instance (shopflo_merchant_id)
  WHERE shopflo_merchant_id IS NOT NULL;

-- Index for AWB re-pull enumeration via gokwik_appid
CREATE INDEX IF NOT EXISTS connector_instance_gokwik_appid_idx
  ON connector_instance (gokwik_appid)
  WHERE gokwik_appid IS NOT NULL;

-- ── (B) realized_revenue_ledger: extend event_type CHECK (MB-3 pattern) ──────
--
-- Drop + recreate the CHECK, retaining ALL existing values (append-only: existing
-- rows MUST satisfy the new constraint) + add the two CoD/RTO event_types.
--
-- New event_type values:
--   cod_rto_clawback        — terminal RTO on a CoD order → reverse recognized revenue (−)
--   cod_delivery_confirmed  — terminal Delivered on a CoD order → confirm recognition (provenance)

ALTER TABLE realized_revenue_ledger
  DROP CONSTRAINT IF EXISTS realized_revenue_ledger_event_type_check;

ALTER TABLE realized_revenue_ledger
  ADD CONSTRAINT realized_revenue_ledger_event_type_check
    CHECK (event_type IN (
      -- existing event_types from 0018 (MUST remain — D-2 append-only)
      'provisional_recognition',
      'finalization',
      'rto_reversal',
      'refund',
      'chargeback',
      'cancellation',
      'settlement_fee_reversal',
      'marketplace_adjustment',
      'payment_adjustment',
      'concession',
      -- settlement event_types from 0027 (MUST remain)
      'settlement_finalization',
      'payment_fee',
      'settlement_tax',
      'rolling_reserve_deduction',
      'rolling_reserve_release',
      'settlement_reversal',
      'settlement_adjustment',
      -- NEW CoD/RTO event_types (0030)
      'cod_rto_clawback',
      'cod_delivery_confirmed'
    ));

-- ── (C) resolve_shopflo_connector_by_merchant(text) (§2.3) ───────────────────
--
-- Webhook brand resolution: called AFTER raw-body parse to extract merchant_id,
-- BEFORE HMAC verify (need the webhook_secret from the row) and BEFORE any write.
-- Resolves (connector_instance_id, brand_id, secret_ref) from shopflo_merchant_id.
-- brand_id comes from the connector ROW — NEVER from the webhook body (MT-1).
-- SECURITY DEFINER: no GUC at webhook-receive time (brand unknown until this lookup).
-- Returns 0 rows if no connected connector → caller returns 401, no write.

CREATE OR REPLACE FUNCTION resolve_shopflo_connector_by_merchant(p_merchant_id text)
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    secret_ref             text
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public
AS $$
  SELECT
    ci.id             AS connector_instance_id,
    ci.brand_id,
    ci.secret_ref
  FROM connector_instance ci
  WHERE ci.shopflo_merchant_id = p_merchant_id
    AND ci.provider             = 'shopflo'
    AND ci.status               = 'connected'
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION resolve_shopflo_connector_by_merchant(text) TO brain_app;

-- ── (D) list_shopflo_connectors() (enumeration) ──────────────────────────────
--
-- SECURITY DEFINER enumeration (durable rule system-job-force-rls-enumeration):
-- runs as 'brain', bypasses FORCE RLS on connector_instance. No GUC at enumerate.
-- Provided for completeness / future re-pull symmetry (Shopflo is webhook-driven in
-- Slice 1, but the enumeration seam mirrors the other providers).

CREATE OR REPLACE FUNCTION list_shopflo_connectors()
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    secret_ref             text,
    shopflo_merchant_id    text
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
    ci.shopflo_merchant_id
  FROM connector_instance ci
  WHERE ci.provider = 'shopflo'
    AND ci.status   = 'connected'
  ORDER BY ci.created_at ASC
$$;

GRANT EXECUTE ON FUNCTION list_shopflo_connectors() TO brain_app;

-- ── (E) list_gokwik_connectors_for_awb_repull() (§3.1) ───────────────────────
--
-- SECURITY DEFINER enumeration for the AWB trailing-window re-pull job + the
-- RTO-Predict emit job. Runs as 'brain', bypasses FORCE RLS. No GUC at enumerate
-- (the job sets the GUC AFTER the fn returns — durable rule system-job-force-rls-enumeration).
-- Returns gokwik_appid for the AWB read client + RTO-Predict event keying.

CREATE OR REPLACE FUNCTION list_gokwik_connectors_for_awb_repull()
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    secret_ref             text,
    gokwik_appid           text
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
    ci.gokwik_appid
  FROM connector_instance ci
  WHERE ci.provider = 'gokwik'
    AND ci.status   = 'connected'
  ORDER BY ci.created_at ASC
$$;

GRANT EXECUTE ON FUNCTION list_gokwik_connectors_for_awb_repull() TO brain_app;

-- ── (F) Migration-time assertion DO-blocks (SEC-0030) ────────────────────────
--
-- Three DO-blocks per SECURITY DEFINER fn (mirrors 0027:251-387 exactly).
-- Guard IDs: SEC-0030a/b/c — resolve_shopflo_connector_by_merchant()
--            SEC-0030d/e/f — list_shopflo_connectors()
--            SEC-0030g/h/i — list_gokwik_connectors_for_awb_repull()

-- ── (F-1a) resolve_shopflo_connector_by_merchant: SECURITY DEFINER + search_path ──
DO $$
DECLARE
  fn_secdef  TEXT;
  fn_config  TEXT;
BEGIN
  SELECT p.prosecdef::text, array_to_string(p.proconfig, ', ')
  INTO fn_secdef, fn_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'resolve_shopflo_connector_by_merchant' AND n.nspname = 'public';

  IF fn_secdef IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'SEC-0030a GUARD: resolve_shopflo_connector_by_merchant() must be SECURITY DEFINER (prosecdef=true). Got: %', fn_secdef;
  END IF;
  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION
      'SEC-0030a GUARD: resolve_shopflo_connector_by_merchant() must have SET search_path=public. Got config: %', fn_config;
  END IF;
END
$$;

-- ── (F-1b) resolve_shopflo_connector_by_merchant: brain_app EXECUTE ──
DO $$
DECLARE has_execute BOOLEAN;
BEGIN
  SELECT has_function_privilege('brain_app', 'resolve_shopflo_connector_by_merchant(text)', 'EXECUTE')
  INTO has_execute;
  IF NOT has_execute THEN
    RAISE EXCEPTION 'SEC-0030b GUARD: brain_app does not have EXECUTE on resolve_shopflo_connector_by_merchant(text).';
  END IF;
END
$$;

-- ── (F-1c) resolve_shopflo_connector_by_merchant: fn exists ──
DO $$
DECLARE fn_count INT;
BEGIN
  SELECT count(*) INTO fn_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'resolve_shopflo_connector_by_merchant' AND n.nspname = 'public';
  IF fn_count = 0 THEN
    RAISE EXCEPTION 'SEC-0030c GUARD: resolve_shopflo_connector_by_merchant() not found after creation.';
  END IF;
END
$$;

-- ── (F-2a) list_shopflo_connectors: SECURITY DEFINER + search_path ──
DO $$
DECLARE
  fn_secdef  TEXT;
  fn_config  TEXT;
BEGIN
  SELECT p.prosecdef::text, array_to_string(p.proconfig, ', ')
  INTO fn_secdef, fn_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_shopflo_connectors' AND n.nspname = 'public';

  IF fn_secdef IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'SEC-0030d GUARD: list_shopflo_connectors() must be SECURITY DEFINER (prosecdef=true). Got: %', fn_secdef;
  END IF;
  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION
      'SEC-0030d GUARD: list_shopflo_connectors() must have SET search_path=public. Got config: %', fn_config;
  END IF;
END
$$;

-- ── (F-2b) list_shopflo_connectors: brain_app EXECUTE ──
DO $$
DECLARE has_execute BOOLEAN;
BEGIN
  SELECT has_function_privilege('brain_app', 'list_shopflo_connectors()', 'EXECUTE')
  INTO has_execute;
  IF NOT has_execute THEN
    RAISE EXCEPTION 'SEC-0030e GUARD: brain_app does not have EXECUTE on list_shopflo_connectors().';
  END IF;
END
$$;

-- ── (F-2c) list_shopflo_connectors: fn exists ──
DO $$
DECLARE fn_count INT;
BEGIN
  SELECT count(*) INTO fn_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_shopflo_connectors' AND n.nspname = 'public';
  IF fn_count = 0 THEN
    RAISE EXCEPTION 'SEC-0030f GUARD: list_shopflo_connectors() not found after creation.';
  END IF;
END
$$;

-- ── (F-3a) list_gokwik_connectors_for_awb_repull: SECURITY DEFINER + search_path ──
DO $$
DECLARE
  fn_secdef  TEXT;
  fn_config  TEXT;
BEGIN
  SELECT p.prosecdef::text, array_to_string(p.proconfig, ', ')
  INTO fn_secdef, fn_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_gokwik_connectors_for_awb_repull' AND n.nspname = 'public';

  IF fn_secdef IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'SEC-0030g GUARD: list_gokwik_connectors_for_awb_repull() must be SECURITY DEFINER (prosecdef=true). Got: %', fn_secdef;
  END IF;
  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION
      'SEC-0030g GUARD: list_gokwik_connectors_for_awb_repull() must have SET search_path=public. Got config: %', fn_config;
  END IF;
END
$$;

-- ── (F-3b) list_gokwik_connectors_for_awb_repull: brain_app EXECUTE ──
DO $$
DECLARE has_execute BOOLEAN;
BEGIN
  SELECT has_function_privilege('brain_app', 'list_gokwik_connectors_for_awb_repull()', 'EXECUTE')
  INTO has_execute;
  IF NOT has_execute THEN
    RAISE EXCEPTION 'SEC-0030h GUARD: brain_app does not have EXECUTE on list_gokwik_connectors_for_awb_repull().';
  END IF;
END
$$;

-- ── (F-3c) list_gokwik_connectors_for_awb_repull: fn exists ──
DO $$
DECLARE fn_count INT;
BEGIN
  SELECT count(*) INTO fn_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_gokwik_connectors_for_awb_repull' AND n.nspname = 'public';
  IF fn_count = 0 THEN
    RAISE EXCEPTION 'SEC-0030i GUARD: list_gokwik_connectors_for_awb_repull() not found after creation.';
  END IF;
END
$$;

-- ── (G) Post-migration assertions ─────────────────────────────────────────────

-- G-1: provider CHECK includes 'shopflo' and 'gokwik'
DO $$
DECLARE chk TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO chk
  FROM pg_constraint c
  WHERE c.conname = 'connector_instance_provider_check';

  IF chk IS NULL OR chk NOT LIKE '%shopflo%' OR chk NOT LIKE '%gokwik%' THEN
    RAISE EXCEPTION
      'SEC-0030 GUARD: connector_instance_provider_check must include shopflo + gokwik. Got: %', chk;
  END IF;
END
$$;

-- G-2: event_type CHECK includes the two new CoD/RTO event_types
DO $$
DECLARE chk TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO chk
  FROM pg_constraint c
  WHERE c.conname = 'realized_revenue_ledger_event_type_check';

  IF chk IS NULL OR chk NOT LIKE '%cod_rto_clawback%' OR chk NOT LIKE '%cod_delivery_confirmed%' THEN
    RAISE EXCEPTION
      'SEC-0030 GUARD: realized_revenue_ledger_event_type_check must include cod_rto_clawback + cod_delivery_confirmed. Got: %', chk;
  END IF;
END
$$;
