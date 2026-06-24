-- 0106_ad_account_activation.sql
--
-- AD-ACCOUNT ACTIVATION (one active ad account per brand+platform).
--
-- PROBLEM: an agency/MCC OAuth login (Meta, Google Ads, future TikTok/X) exposes MANY ad
-- accounts. The connect callbacks created ONE connector_instance per discovered account, ALL with
-- status='connected', and the spend-repull enumeration fns ingested EVERY connected ad account.
-- One agency login therefore ingested every brand's ad spend against a single Brain brand →
-- cross-brand data noise that corrupts ROAS/attribution, and disabled accounts 403-loop forever.
--
-- FIX: separate "the OAuth connection is healthy" (status='connected') from "this account is the
-- chosen one to ingest" (activated_at IS NOT NULL). The user activates EXACTLY ONE ad account per
-- (brand, platform); only activated ad accounts are enumerated for repull. Non-activated accounts
-- never produce a Bronze row → no noise can enter in production. This is GENERIC: any provider in
-- the ad-platform set is gated; storefront/payment providers are unaffected (always ingest).
--
-- This migration:
--   1. ADD connector_instance.activated_at TIMESTAMPTZ NULL  (the activation marker).
--   2. INDEX (brand_id, provider, activated_at) for the activation enumeration + switch.
--   3. BACKFILL: auto-activate the account where a (brand, provider) ad pair has EXACTLY ONE
--      connected account (nothing to choose); leave NULL where there are several (forces a pick).
--   4. RE-PIN both enumeration fns to gate ad-platform rows on activated_at IS NOT NULL.
--
-- ADDITIVE + reversible. Rollback:
--   DROP INDEX IF EXISTS connector_instance_active_ad_account_idx;
--   ALTER TABLE connector_instance DROP COLUMN IF EXISTS activated_at;
--   + re-CREATE the two fns from 0029/0053 (without the activated_at gate).
--
-- NOTE on search_path: 0063 widened these SECURITY DEFINER fns to span the operational schemas
-- (connector_instance now lives in schema `connectors`). CREATE OR REPLACE resets proconfig, so we
-- MUST re-set the widened search_path here or the fn body's unqualified `connector_instance` would
-- fail to resolve. The 0029/0053 guards only require *a* search_path be pinned — the widened one
-- satisfies them.

-- NOTE on schema qualification: post-0063 connector_instance lives in schema `connectors`, and the
-- migration runner's session search_path is `public` only. SQL-language function bodies are
-- validated at CREATE time against the session search_path, so every reference below is qualified
-- `connectors.connector_instance` (DDL, DML, AND inside the fn bodies). The fns still pin their own
-- runtime search_path for the 0029/0053 SECURITY DEFINER invariant.

-- ── 1. activation marker ─────────────────────────────────────────────────────
ALTER TABLE connectors.connector_instance ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;

COMMENT ON COLUMN connectors.connector_instance.activated_at IS
  'Ad-account activation marker (0106). NULL = discovered-but-not-ingesting; NOT NULL = the chosen '
  'account that ingests. Exactly one active per (brand, ad-platform provider). NULL/ignored for '
  'storefront + payment providers, which always ingest when status=connected.';

-- ── 2. index for the activation enumeration + sibling switch ─────────────────
CREATE INDEX IF NOT EXISTS connector_instance_active_ad_account_idx
  ON connectors.connector_instance (brand_id, provider, activated_at);

-- ── 3. backfill: auto-activate the lone account; leave multi-account pairs for the user ──
-- A (brand, provider) ad pair with exactly ONE connected account has nothing to choose → activate
-- it so existing single-account connections keep ingesting. Pairs with >1 account are left NULL so
-- the user must pick (the whole point of this change). Idempotent (only sets where NULL).
UPDATE connectors.connector_instance ci
   SET activated_at = COALESCE(ci.connected_at, now())
 WHERE ci.provider IN ('meta', 'google_ads')
   AND ci.status = 'connected'
   AND ci.activated_at IS NULL
   AND (
     SELECT COUNT(*) FROM connectors.connector_instance c2
      WHERE c2.brand_id = ci.brand_id
        AND c2.provider = ci.provider
        AND c2.status   = 'connected'
   ) = 1;

-- ── 4a. list_ad_connectors_for_spend_repull(): gate on activated_at ───────────
-- Only ACTIVATED ad accounts are returned for the spend repull. This is the data-authority
-- chokepoint: even if a non-activated connector is somehow dispatched, it resolves 0 rows → no-op.
CREATE OR REPLACE FUNCTION list_ad_connectors_for_spend_repull()
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    provider               text,
    secret_ref             text,
    ad_account_id          text
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config
AS $$
  SELECT
    ci.id             AS connector_instance_id,
    ci.brand_id,
    ci.provider,
    ci.secret_ref,
    ci.ad_account_id
  FROM connectors.connector_instance ci
  WHERE ci.provider IN ('meta', 'google_ads')
    AND ci.status      = 'connected'
    AND ci.activated_at IS NOT NULL   -- 0106: only the chosen account ingests
  ORDER BY ci.created_at ASC
$$;

GRANT EXECUTE ON FUNCTION list_ad_connectors_for_spend_repull() TO brain_app;

-- ── 4b. claim_due_repull_connectors(): don't even claim non-activated ad accounts ──
-- Generic across ALL providers: storefront/payment connectors are claimed as before; ad-platform
-- connectors are claimed only once activated. A non-activated (or disabled) ad account is therefore
-- never dispatched → it backs off instead of 403-looping. Future ad platforms: add to the IN-list.
CREATE OR REPLACE FUNCTION claim_due_repull_connectors(p_batch INT, p_interval_seconds INT)
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    provider               text
  )
  LANGUAGE sql
  VOLATILE
  SECURITY DEFINER
  SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config
AS $$
  WITH due AS (
    SELECT id
      FROM connectors.connector_instance
     WHERE status = 'connected'
       AND (next_repull_at IS NULL OR next_repull_at <= now())
       -- 0106: ad-platform connectors must be activated to be claimed; non-ad providers unaffected.
       AND (provider NOT IN ('meta', 'google_ads') OR activated_at IS NOT NULL)
     ORDER BY next_repull_at ASC NULLS FIRST
     FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(p_batch, 0)
  )
  UPDATE connectors.connector_instance ci
     SET next_repull_at = now() + make_interval(secs => GREATEST(p_interval_seconds, 1)),
         updated_at     = now()
    FROM due
   WHERE ci.id = due.id
  RETURNING ci.id AS connector_instance_id, ci.brand_id, ci.provider
$$;

GRANT EXECUTE ON FUNCTION claim_due_repull_connectors(INT, INT) TO brain_app;

-- ── 5. post-condition guards ─────────────────────────────────────────────────
DO $$
BEGIN
  -- column exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'connectors'
       AND table_name = 'connector_instance' AND column_name = 'activated_at'
  ) THEN
    RAISE EXCEPTION '0106 failed: connector_instance.activated_at not created';
  END IF;

  -- both fns remain SECURITY DEFINER with a pinned search_path (0029/0053 invariant preserved)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'list_ad_connectors_for_spend_repull'
       AND p.prosecdef
       AND p.proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0106 failed: list_ad_connectors_for_spend_repull() must stay SECURITY DEFINER + search_path-pinned';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'claim_due_repull_connectors'
       AND p.prosecdef
       AND p.proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0106 failed: claim_due_repull_connectors() must stay SECURITY DEFINER + search_path-pinned';
  END IF;
END $$;
