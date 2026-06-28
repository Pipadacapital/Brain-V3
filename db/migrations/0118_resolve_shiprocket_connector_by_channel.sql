-- 0118_resolve_shiprocket_connector_by_channel.sql
--
-- Shiprocket inbound WEBHOOK brand-resolution (real-time shipment lifecycle / RTO outcome).
--
-- Shiprocket's PRIMARY real-time seam (besides the trailing-window repull) is webhooks: Shiprocket
-- POSTs shipment-status events to our endpoint. The WebhookPipeline resolves brand_id from a
-- SECURITY-DEFINER fn keyed by a provider lookup value (NEVER from the request body — MT-1). For
-- Shiprocket the lookup key is the `x-shiprocket-channel-id` header (fallback `x-shiprocket-account-id`),
-- which the connect flow persists as connector_instance.shiprocket_channel_id (0059) and/or the
-- account_key (0092). registerWebhookRoutes ALREADY calls resolve_shiprocket_connector_by_channel(text)
-- — but it existed in NO migration (0059 created only list_shiprocket_connectors_for_repull). Without
-- this fn the Shiprocket webhook route is DEAD (resolver missing → no tenant resolve, event lost).
-- This fn mirrors resolve_gokwik_connector_by_merchant (0108) exactly in shape.
--
-- Owned by 'brain'; runs as 'brain' to bypass FORCE RLS on connector_instance (returns dispatch-only
-- cols, no tenant data). The pipeline sets the brand GUC AFTER this returns. search_path is widened
-- to span the operational schemas (post-0063 connector_instance lives in `connectors`).
--
-- FALLBACK: channel_id is OPTIONAL at connect (a brand may connect with email/password only). When
-- absent, shiprocket_channel_id is NULL and account_key (0092) falls back to the email. So we resolve
-- by `shiprocket_channel_id = p_channel OR account_key = p_channel` — the webhook can route on either
-- the per-channel id OR the account_key, matching the registerWebhookRoutes header order
-- (x-shiprocket-channel-id, then x-shiprocket-account-id). An exact channel match is preferred over an
-- account_key match (ORDER BY) so a multi-row brand resolves deterministically.
--
-- ADDITIVE + idempotent (CREATE OR REPLACE). Rollback = DROP FUNCTION resolve_shiprocket_connector_by_channel(text);

CREATE OR REPLACE FUNCTION resolve_shiprocket_connector_by_channel(p_channel text)
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
  WHERE (ci.shiprocket_channel_id = p_channel OR ci.account_key = p_channel)
    AND ci.provider     = 'shiprocket'
    AND ci.status       = 'connected'
  ORDER BY (ci.shiprocket_channel_id = p_channel) DESC NULLS LAST  -- prefer exact channel match over account_key
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION resolve_shiprocket_connector_by_channel(text) TO brain_app;

-- Post-condition guards (mirror the SEC-* pattern): SECURITY DEFINER + search_path pinned + grant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'resolve_shiprocket_connector_by_channel'
       AND p.prosecdef
       AND p.proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0118 failed: resolve_shiprocket_connector_by_channel must be SECURITY DEFINER + search_path-pinned';
  END IF;
  IF NOT has_function_privilege('brain_app', 'resolve_shiprocket_connector_by_channel(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0118 failed: brain_app lacks EXECUTE on resolve_shiprocket_connector_by_channel(text)';
  END IF;
END $$;
