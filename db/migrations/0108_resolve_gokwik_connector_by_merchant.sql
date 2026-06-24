-- 0108_resolve_gokwik_connector_by_merchant.sql
--
-- GoKwik inbound WEBHOOK brand-resolution (real-time payment/order/delivery status).
--
-- GoKwik's real-time seam (besides the settlement pull) is webhooks: GoKwik POSTs status events to
-- our endpoint. The WebhookPipeline resolves brand_id from a SECURITY-DEFINER fn keyed by a
-- provider lookup value (NEVER from the request body — MT-1). For GoKwik the lookup key is the
-- gokwik_appid (the non-secret application id already stored on connector_instance by migration 0030
-- for AWB/RTO enumeration). This fn mirrors resolve_razorpay_connector_by_account exactly.
--
-- Owned by 'brain'; runs as 'brain' to bypass FORCE RLS on connector_instance (returns dispatch-only
-- cols, no tenant data). The pipeline sets the brand GUC AFTER this returns. search_path is widened
-- to span the operational schemas (post-0063 connector_instance lives in `connectors`).
--
-- ADDITIVE + idempotent (CREATE OR REPLACE). Rollback = DROP FUNCTION resolve_gokwik_connector_by_merchant(text);

CREATE OR REPLACE FUNCTION resolve_gokwik_connector_by_merchant(p_appid text)
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    secret_ref             text
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config
AS $$
  SELECT
    ci.id        AS connector_instance_id,
    ci.brand_id,
    ci.secret_ref
  FROM connector_instance ci
  WHERE ci.gokwik_appid = p_appid
    AND ci.provider     = 'gokwik'
    AND ci.status       = 'connected'
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION resolve_gokwik_connector_by_merchant(text) TO brain_app;

-- Post-condition guards (mirror the SEC-* pattern): SECURITY DEFINER + search_path pinned + grant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'resolve_gokwik_connector_by_merchant'
       AND p.prosecdef
       AND p.proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0108 failed: resolve_gokwik_connector_by_merchant must be SECURITY DEFINER + search_path-pinned';
  END IF;
  IF NOT has_function_privilege('brain_app', 'resolve_gokwik_connector_by_merchant(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0108 failed: brain_app lacks EXECUTE on resolve_gokwik_connector_by_merchant(text)';
  END IF;
END $$;
