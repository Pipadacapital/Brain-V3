-- 0127_list_shiprocket_connectors_for_webhook.sql
--
-- Shiprocket webhook TENANT-ROUTING FALLBACK (header-less deliveries).
--
-- Shiprocket's webhook configuration UI lets some merchants set ONLY a delivery URL + an x-api-key
-- token — they cannot attach the custom x-shiprocket-channel-id / x-shiprocket-account-id header the
-- ShiprocketWebhookStrategy routes on. Every such delivery previously hard-failed with
-- LOOKUP_KEY_MISSING (event lost). Because the token is Brain-MINTED at connect (SR-2
-- provisionGeneratedSecrets — high-entropy, unique per connector), it uniquely identifies the tenant:
-- the fallback resolver (registerWebhookRoutes) enumerates connected Shiprocket connectors via THIS
-- fn, timing-safe-compares the presented token against each bundle's webhook_secret (Secrets Manager
-- — the secret itself is NEVER in PG), and routes on the matching row's lookup_key.
--
-- lookup_key = COALESCE(shiprocket_channel_id, account_key): the SAME value
-- resolve_shiprocket_connector_by_channel (0118) resolves, so the pipeline's Step-3 brand resolution
-- works unchanged with the fallback-resolved key. account_key falls back to the connect email (0092).
--
-- SECURITY DEFINER enumeration mirrors list_shiprocket_connectors_for_repull (0059): owned by
-- 'brain', bypasses FORCE RLS pre-auth, returns dispatch-only cols (id/brand/secret_ref/lookup_key
-- — NO tenant data, NO secrets). search_path spans the operational schemas (post-0063).
--
-- ADDITIVE + idempotent (CREATE OR REPLACE).
-- Rollback = DROP FUNCTION list_shiprocket_connectors_for_webhook();

CREATE OR REPLACE FUNCTION list_shiprocket_connectors_for_webhook()
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    secret_ref             text,
    lookup_key             text
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config
AS $$
  SELECT
    ci.id                                              AS connector_instance_id,
    ci.brand_id,
    ci.secret_ref,
    COALESCE(ci.shiprocket_channel_id, ci.account_key) AS lookup_key
  FROM connector_instance ci
  WHERE ci.provider = 'shiprocket'
    AND ci.status   = 'connected'
  ORDER BY ci.created_at ASC
$$;

GRANT EXECUTE ON FUNCTION list_shiprocket_connectors_for_webhook() TO brain_app;

-- Post-condition guards (mirror the SEC-* pattern): SECURITY DEFINER + search_path pinned + grant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'list_shiprocket_connectors_for_webhook'
       AND p.prosecdef
       AND p.proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0127 failed: list_shiprocket_connectors_for_webhook must be SECURITY DEFINER + search_path-pinned';
  END IF;
  IF NOT has_function_privilege('brain_app', 'list_shiprocket_connectors_for_webhook()', 'EXECUTE') THEN
    RAISE EXCEPTION '0127 failed: brain_app lacks EXECUTE on list_shiprocket_connectors_for_webhook()';
  END IF;
END $$;
