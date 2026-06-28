-- 0117_gokwik_retire_awb_model.sql
--
-- GoKwik AWB-model retirement — webhook-first payments/checkout cutover.
--
-- WHY: GoKwik is a checkout / payments-optimisation source. Its real-time seam is WEBHOOKS
-- (order / checkout / payment / risk events POSTed to our endpoint, HMAC-signed). GoKwik has
-- **no AWB-read API** — the earlier `list_gokwik_connectors_for_awb_repull()` enumeration fn
-- (0030) fed a synthetic AWB trailing-window re-pull job + a `gokwik.awb_status.v1` →
-- `cod_rto_clawback`/`cod_delivery_confirmed` ledger model that was the WRONG source shape.
-- Logistics truth is **Shiprocket**, not GoKwik. The AWB re-pull job, the synthetic AWB client,
-- the awb_status Bronze bridge, the dead `silver_gokwik_normalize.py` raw-lane normalizer, and the
-- gokwik→awb-repull scheduler dispatch were all removed in this change set.
--
-- WHAT THIS MIGRATION DOES:
--   (1) RENAME the enumeration fn list_gokwik_connectors_for_awb_repull() → list_gokwik_connectors()
--       (model-neutral name). Same SECURITY DEFINER / search_path-pinned / return shape; the rename
--       drops the AWB framing. DROP-then-CREATE because the function NAME changes.
--
-- WHAT THIS MIGRATION KEEPS (do NOT touch — still load-bearing for the webhook-first model):
--   - the `gokwik` value in the connector_instance.provider CHECK (0030);
--   - the connector_instance.gokwik_appid column + its index (0030) — the webhook routing key;
--   - resolve_gokwik_connector_by_merchant(text) (0108) — inbound-webhook brand resolution (MT-1).
--
-- The `cod_rto_clawback` / `cod_delivery_confirmed` ledger event-types are already GONE: the
-- realized_revenue_ledger table itself was dropped in the Medallion realignment (recognition is
-- now built from Bronze). Nothing to drop here for them.
--
-- ADDITIVE + idempotent. Rollback (model resurrection not advised):
--   DROP FUNCTION IF EXISTS list_gokwik_connectors();
--   -- and re-create list_gokwik_connectors_for_awb_repull() from 0030 if ever needed.

-- ── (1) Rename the enumeration fn → model-neutral list_gokwik_connectors() ────────────
-- SECURITY DEFINER enumeration (durable rule system-job-force-rls-enumeration): runs as 'brain',
-- bypasses FORCE RLS on connector_instance. NO GUC at enumerate time. search_path is widened to span
-- the operational schemas (post-0063 connector_instance lives in `connectors`). Returns dispatch-only
-- cols (no tenant data); callers set the brand GUC AFTER the fn returns (MT-1).

DROP FUNCTION IF EXISTS list_gokwik_connectors_for_awb_repull();

CREATE OR REPLACE FUNCTION list_gokwik_connectors()
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    secret_ref             text,
    gokwik_appid           text
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config
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

GRANT EXECUTE ON FUNCTION list_gokwik_connectors() TO brain_app;

-- ── Post-condition guards (mirror the SEC-* pattern from 0030/0108) ───────────────────
DO $$
BEGIN
  -- The renamed fn exists, is SECURITY DEFINER, and is search_path-pinned.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'list_gokwik_connectors'
       AND p.prosecdef
       AND p.proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0117 failed: list_gokwik_connectors() must exist, be SECURITY DEFINER + search_path-pinned';
  END IF;

  IF NOT has_function_privilege('brain_app', 'list_gokwik_connectors()', 'EXECUTE') THEN
    RAISE EXCEPTION '0117 failed: brain_app lacks EXECUTE on list_gokwik_connectors()';
  END IF;

  -- The retired AWB-model enumerator is GONE.
  IF EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.proname = 'list_gokwik_connectors_for_awb_repull'
  ) THEN
    RAISE EXCEPTION '0117 failed: retired list_gokwik_connectors_for_awb_repull() still present';
  END IF;

  -- KEEP guards: the webhook-first model still depends on these.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.proname = 'resolve_gokwik_connector_by_merchant'
  ) THEN
    RAISE EXCEPTION '0117 failed: resolve_gokwik_connector_by_merchant(text) (0108) must be preserved';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'connector_instance' AND column_name = 'gokwik_appid'
  ) THEN
    RAISE EXCEPTION '0117 failed: connector_instance.gokwik_appid column must be preserved';
  END IF;
END $$;
