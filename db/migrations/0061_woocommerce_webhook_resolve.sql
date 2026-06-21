-- ============================================================================
-- 0061_woocommerce_webhook_resolve.sql
-- feat-woocommerce-realtime-webhook — Data Engineer
-- Mirrors resolve_shopflo_connector_by_merchant (0030) for the WooCommerce webhook receiver.
-- ============================================================================
--
-- WooCommerce real-time webhooks deliver the store base URL in the X-WC-Webhook-Source header.
-- The receiver resolves the connector (+ brand_id from the ROW — MT-1) by woocommerce_site_url
-- (added in 0060), fetches the webhook_secret from the credential bundle, and validates the
-- X-WC-Webhook-Signature HMAC BEFORE any write. brand_id is NEVER taken from the webhook body.
--
-- SECURITY DEFINER: at webhook-receive time the brand is unknown (no GUC) — the fn runs as 'brain'
-- to resolve the row, exactly like resolve_shopflo_connector_by_merchant. Returns 0 rows when no
-- connected woocommerce connector matches the site → caller returns 401, no write.
--
-- ADDITIVE ONLY (I-E02): CREATE OR REPLACE FUNCTION + GRANT. ROLLBACK:
--   DROP FUNCTION IF EXISTS resolve_woocommerce_connector_by_site(text);
-- ============================================================================

CREATE OR REPLACE FUNCTION resolve_woocommerce_connector_by_site(p_site_url text)
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
  WHERE ci.woocommerce_site_url = p_site_url
    AND ci.provider             = 'woocommerce'
    AND ci.status               = 'connected'
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION resolve_woocommerce_connector_by_site(text) TO brain_app;

-- ── Migration-time assertions (SEC-0061) ─────────────────────────────────────
DO $$
DECLARE
  fn_secdef  TEXT;
  fn_config  TEXT;
BEGIN
  SELECT p.prosecdef::text, array_to_string(p.proconfig, ', ')
  INTO fn_secdef, fn_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'resolve_woocommerce_connector_by_site' AND n.nspname = 'public';

  IF fn_secdef IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'SEC-0061a GUARD: resolve_woocommerce_connector_by_site() must be SECURITY DEFINER. Got: %', fn_secdef;
  END IF;
  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION 'SEC-0061a GUARD: resolve_woocommerce_connector_by_site() must SET search_path=public. Got: %', fn_config;
  END IF;
END
$$;

DO $$
DECLARE has_execute BOOLEAN;
BEGIN
  SELECT has_function_privilege('brain_app', 'resolve_woocommerce_connector_by_site(text)', 'EXECUTE')
  INTO has_execute;
  IF NOT has_execute THEN
    RAISE EXCEPTION 'SEC-0061b GUARD: brain_app does not have EXECUTE on resolve_woocommerce_connector_by_site(text).';
  END IF;
END
$$;
