--
-- 0000_baseline_2026_07 — CONSOLIDATED SCHEMA BASELINE
--
-- This single migration replaces the historical 0001–0128 migration files. It is a
-- pg_dump --schema-only snapshot (PG16, prod-matching) of the schema those 128 migrations
-- built, verified by replay + schema-diff. See db/baseline/README.md for how it was generated
-- and how to regenerate it.
--
-- SAFETY (how existing databases are handled): scripts/migrate.mjs stamps this baseline as
-- already-applied on any database that has prior migration history but not yet this row, so
-- node-pg-migrate SKIPS this file on prod/staging/dev (their schema already exists) and only
-- runs 0129+. A genuinely fresh/empty database runs THIS baseline (building the full schema)
-- then 0129+. New migrations start at 0129_.
--
-- pg_dump omits CREATE ROLE (roles are cluster-level); the NOBYPASSRLS app role the RLS
-- policies below are GRANTed/written TO must exist first. Matches historical 0001_init. The
-- privileged owner role `brain` is assumed to pre-exist (same assumption as 0001_init).
--
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    CREATE ROLE brain_app NOLOGIN;
  END IF;
END $$;

-- Role search_path (from the retired 0063/0066 schema-split migrations). pg_dump --schema-only does
-- NOT emit ALTER ROLE ... SET, so this MUST be restored here or unqualified app SQL (SELECT ... FROM
-- brand / connector_instance / collector_spool …) fails with "relation does not exist" on a fresh DB:
-- every operational table lives in a schema (tenancy/connectors/…), resolved via this search_path, not
-- public. On an existing DB the baseline is skipped, but that DB already carries this setting from 0066.
ALTER ROLE brain_app SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config, identity, consent, pixel, data_plane;
ALTER ROLE brain     SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config, identity, consent, pixel, data_plane;

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Debian 16.14-1.pgdg13+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: ai_config; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA ai_config;


--
-- Name: audit; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA audit;


--
-- Name: billing; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA billing;


--
-- Name: connectors; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA connectors;


--
-- Name: consent; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA consent;


--
-- Name: data_plane; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA data_plane;


--
-- Name: iam; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA iam;


--
-- Name: identity; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA identity;


--
-- Name: jobs; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA jobs;


--
-- Name: ml; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA ml;


--
-- Name: ops; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA ops;


--
-- Name: pixel; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA pixel;


--
-- Name: tenancy; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA tenancy;


--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: EXTENSION btree_gist; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';


--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: attribution_confidence_mart(uuid, text, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.attribution_confidence_mart(p_brand_id uuid, p_model_id text, p_from date, p_to date) RETURNS TABLE(confidence_grade text, attribution_confidence numeric, attributed_minor bigint)
    LANGUAGE sql STABLE
    AS $$
  SELECT
    l.confidence_grade,
    l.attribution_confidence,
    COALESCE(SUM(l.credited_revenue_minor), 0)::BIGINT AS attributed_minor
  FROM attribution_credit_ledger l
  WHERE l.brand_id = p_brand_id
    AND l.model_id = p_model_id
    AND l.economic_effective_at::date >= p_from
    AND l.economic_effective_at::date <= p_to
  GROUP BY l.confidence_grade, l.attribution_confidence;
$$;


--
-- Name: attribution_credit_currency_matches_brand(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.attribution_credit_currency_matches_brand() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  brand_currency CHAR(3);
BEGIN
  SELECT currency_code INTO brand_currency
  FROM brand
  WHERE id = NEW.brand_id;

  IF brand_currency IS NULL THEN
    RAISE EXCEPTION
      'attribution_currency_trigger: brand % not found or has no currency_code', NEW.brand_id;
  END IF;

  IF NEW.currency_code <> brand_currency THEN
    RAISE EXCEPTION
      'currency mismatch: attribution_credit_ledger row currency=% but brand % currency=%. '
      'All credit rows for a brand must share its currency_code.',
      NEW.currency_code, NEW.brand_id, brand_currency;
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: claim_due_repull_connectors(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_due_repull_connectors(p_batch integer, p_interval_seconds integer) RETURNS TABLE(connector_instance_id uuid, brand_id uuid, provider text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config'
    AS $$
  WITH reaped AS (
    -- 0119: reap a stranded 'syncing' lease (crashed/evicted worker). After the 15-min lease window
    -- a 'syncing' row is treated as abandoned → flipped to a TRANSIENT 'error' (NOT RECONNECT_REQUIRED,
    -- so it stays claimable) and surfaced on the tile. The next repull re-claims + clears it. 15 min >
    -- the scheduler's 5-min dispatch deadline, so an in-flight repull is never reaped. Always executes
    -- (data-modifying WITH runs to completion even when unreferenced by the primary query).
    UPDATE connectors.connector_sync_status s
       SET state      = 'error',
           last_error = 'REPULL_LEASE_EXPIRED — stale syncing lease reaped (>15m, worker crash/evict); re-dispatching',
           updated_at = now()
     WHERE s.state = 'syncing'
       AND s.updated_at < now() - INTERVAL '15 minutes'
    RETURNING s.connector_instance_id
  ),
  due AS (
    SELECT ci.id
      FROM connectors.connector_instance ci
     WHERE ci.status = 'connected'
       AND (ci.next_repull_at IS NULL OR ci.next_repull_at <= now())
       -- 0106: ad-platform connectors must be activated to be claimed; non-ad providers unaffected.
       AND (ci.provider NOT IN ('meta', 'google_ads') OR ci.activated_at IS NOT NULL)
       -- 0112: park connectors in the TERMINAL reconnect-required error state. A repull that needs a
       -- human reconnect (secret gone) can only fail again; re-try it at most once per back-off window
       -- (30 min) instead of every interval. Reconnect clears state/last_error → immediately claimable.
       -- Transient errors don't carry RECONNECT_REQUIRED in last_error → they keep fast-retrying
       -- (the 0119 reaped 'syncing' lease becomes such a transient 'error' → claimable next tick).
       AND NOT EXISTS (
         SELECT 1
           FROM connectors.connector_sync_status s
          WHERE s.connector_instance_id = ci.id
            AND s.state = 'error'
            AND s.last_error LIKE '%RECONNECT_REQUIRED%'
            AND s.updated_at > now() - INTERVAL '30 minutes'
       )
     ORDER BY ci.next_repull_at ASC NULLS FIRST
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


--
-- Name: cost_inputs_as_of(uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cost_inputs_as_of(p_brand_id uuid, p_as_of date) RETURNS TABLE(scope text, scope_ref text, cost_type text, amount_minor bigint, pct_bps integer, currency_code character, cost_confidence text)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
    AS $$
  SELECT scope, scope_ref, cost_type, amount_minor, pct_bps, currency_code, cost_confidence
    FROM cost_input
   WHERE brand_id = p_brand_id
     AND effective_from <= p_as_of
     AND (effective_to IS NULL OR effective_to > p_as_of)
$$;


--
-- Name: erase_contact_pii_for_customer(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.erase_contact_pii_for_customer(p_brand_id uuid, p_brain_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'identity'
    AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM contact_pii WHERE brand_id = p_brand_id AND brain_id = p_brain_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;


--
-- Name: find_email_verification_by_hash(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.find_email_verification_by_hash(p_token_hash text) RETURNS TABLE(id uuid, app_user_id uuid, token_hash text, expires_at timestamp with time zone, used_at timestamp with time zone, created_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam'
    AS $$
  SELECT e.id, e.app_user_id, e.token_hash, e.expires_at, e.used_at, e.created_at
  FROM iam.email_verification e
  WHERE e.token_hash = p_token_hash
    AND e.used_at IS NULL
    AND e.expires_at > NOW()
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: invite; Type: TABLE; Schema: iam; Owner: -
--

CREATE TABLE iam.invite (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    brand_id uuid,
    email public.citext NOT NULL,
    role_code text NOT NULL,
    token_hash text NOT NULL,
    invited_by_user_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invite_role_code_check CHECK ((role_code = ANY (ARRAY['owner'::text, 'brand_admin'::text, 'manager'::text, 'analyst'::text]))),
    CONSTRAINT invite_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'expired'::text, 'revoked'::text])))
);

ALTER TABLE ONLY iam.invite FORCE ROW LEVEL SECURITY;


--
-- Name: find_invite_for_acceptance(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.find_invite_for_acceptance(p_token_hash text) RETURNS SETOF iam.invite
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
    AS $$
  SELECT * FROM invite
   WHERE token_hash = p_token_hash AND status = 'pending' AND expires_at > NOW();
$$;


--
-- Name: find_password_reset_by_hash(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.find_password_reset_by_hash(p_token_hash text) RETURNS TABLE(id uuid, app_user_id uuid, token_hash text, expires_at timestamp with time zone, used_at timestamp with time zone, created_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam'
    AS $$
  SELECT r.id, r.app_user_id, r.token_hash, r.expires_at, r.used_at, r.created_at
  FROM iam.password_reset r
  WHERE r.token_hash = p_token_hash
    AND r.used_at IS NULL
    AND r.expires_at > NOW()
$$;


--
-- Name: user_session; Type: TABLE; Schema: iam; Owner: -
--

CREATE TABLE iam.user_session (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_user_id uuid NOT NULL,
    jti uuid NOT NULL,
    refresh_token_hash text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    ip inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    family_id uuid,
    rotated_from uuid,
    used_at timestamp with time zone
);

ALTER TABLE ONLY iam.user_session FORCE ROW LEVEL SECURITY;


--
-- Name: find_session_for_rotation(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.find_session_for_rotation(p_refresh_token_hash text) RETURNS SETOF iam.user_session
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
    AS $$
  SELECT * FROM user_session WHERE refresh_token_hash = p_refresh_token_hash FOR UPDATE;
$$;


--
-- Name: get_brand_identity_salt(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_brand_identity_salt(p_brand_id uuid) RETURNS TABLE(kms_key_id text, wrapped_salt_b64 text, key_version integer, is_active boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'tenancy'
    AS $$
  SELECT s.kms_key_id, s.wrapped_salt_b64, s.key_version, s.is_active
  FROM tenancy.brand_identity_salt s
  WHERE s.brand_id = p_brand_id
$$;


--
-- Name: get_brand_keyring(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_brand_keyring(p_brand_id uuid) RETURNS TABLE(kms_key_id text, wrapped_dek_b64 text, key_version integer, is_active boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'tenancy'
    AS $$
  SELECT k.kms_key_id, k.wrapped_dek_b64, k.key_version, k.is_active
  FROM tenancy.brand_keyring k
  WHERE k.brand_id = p_brand_id
$$;


--
-- Name: get_pixel_identity_config(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_pixel_identity_config(p_install_token uuid, p_brand_id uuid) RETURNS TABLE(identity_capture text, consent_source text, region_code text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'tenancy', 'pixel'
    AS $$
  SELECT b.identity_capture, b.consent_source, b.region_code
  FROM tenancy.brand b
  JOIN pixel.pixel_installation pi ON pi.brand_id = b.id
  WHERE pi.install_token = p_install_token
    AND b.id = p_brand_id
$$;


--
-- Name: get_subject_keyring(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_subject_keyring(p_brand_id uuid, p_brain_id uuid) RETURNS TABLE(kms_key_id text, wrapped_dek_b64 text, key_version integer, is_active boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'tenancy'
    AS $$
  SELECT s.kms_key_id, s.wrapped_dek_b64, s.key_version, s.is_active
  FROM tenancy.subject_keyring s
  WHERE s.brand_id = p_brand_id
    AND s.brain_id = p_brain_id
$$;


--
-- Name: issue_credit_note(uuid, uuid, text, bigint, integer, bigint, text, text, bigint, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.issue_credit_note(p_brand_id uuid, p_invoice_id uuid, p_reason text, p_taxable_minor bigint, p_tax_rate_bps integer, p_tax_minor bigint, p_regime text, p_sac text, p_cgst_minor bigint, p_sgst_minor bigint, p_igst_minor bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
    AS $$
DECLARE
  v_inv      invoice%ROWTYPE;
  v_credited BIGINT;
  v_total    BIGINT := p_taxable_minor + p_tax_minor;
  v_cn_id    UUID;
  v_seq      BIGINT;
  v_num      TEXT;
  v_half_bps INTEGER := p_tax_rate_bps / 2;
BEGIN
  IF p_taxable_minor < 0 OR p_tax_minor < 0 OR v_total <= 0 THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'invalid_amount');
  END IF;

  SELECT * INTO v_inv FROM invoice WHERE invoice_id = p_invoice_id AND brand_id = p_brand_id;
  IF v_inv.invoice_id IS NULL THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'invoice_not_found');
  END IF;

  -- Cap: cumulative credit notes must not exceed the invoice total (no over-crediting).
  SELECT COALESCE(SUM(total_minor), 0) INTO v_credited FROM credit_note WHERE invoice_id = p_invoice_id;
  IF v_credited + v_total > v_inv.total_minor THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'exceeds_invoice',
      'already_credited_minor', v_credited, 'invoice_total_minor', v_inv.total_minor);
  END IF;

  INSERT INTO credit_note_number_counter (legal_entity, fy, next_seq)
  VALUES (v_inv.legal_entity, v_inv.fy, 1)
  ON CONFLICT (legal_entity, fy) DO NOTHING;

  SELECT next_seq INTO v_seq
    FROM credit_note_number_counter
   WHERE legal_entity = v_inv.legal_entity AND fy = v_inv.fy
     FOR UPDATE;
  UPDATE credit_note_number_counter
     SET next_seq = v_seq + 1
   WHERE legal_entity = v_inv.legal_entity AND fy = v_inv.fy;

  v_num := v_inv.legal_entity || '/' || v_inv.fy || '/CN/' || lpad(v_seq::text, 6, '0');
  v_cn_id := gen_random_uuid();

  INSERT INTO credit_note (credit_note_id, brand_id, invoice_id, billing_period, legal_entity, fy,
    credit_note_number, currency_code, reason, taxable_minor, tax_minor, total_minor, regime, tax,
    sac_hsn_code, tax_rate_bps, seller_gstin, place_of_supply)
  VALUES (v_cn_id, p_brand_id, p_invoice_id, v_inv.billing_period, v_inv.legal_entity, v_inv.fy,
    v_num, v_inv.currency_code, p_reason, p_taxable_minor, p_tax_minor, v_total, p_regime,
    jsonb_build_object('regime', p_regime, 'rate_bps', p_tax_rate_bps, 'sac_hsn_code', p_sac,
      'cgst_minor', p_cgst_minor, 'sgst_minor', p_sgst_minor, 'igst_minor', p_igst_minor),
    p_sac, p_tax_rate_bps, v_inv.seller_gstin, v_inv.place_of_supply);

  -- Reversing (negative) output tax rows, pointing at the CN.
  IF p_regime = 'cgst_sgst' THEN
    INSERT INTO tax_ledger (brand_id, invoice_id, credit_note_id, regime, direction, rate_bps, taxable_minor, tax_minor, period, sac_hsn_code)
    VALUES (p_brand_id, p_invoice_id, v_cn_id, 'cgst', 'output', v_half_bps, -p_taxable_minor, -p_cgst_minor, v_inv.billing_period, p_sac),
           (p_brand_id, p_invoice_id, v_cn_id, 'sgst', 'output', v_half_bps, -p_taxable_minor, -p_sgst_minor, v_inv.billing_period, p_sac);
  ELSE
    INSERT INTO tax_ledger (brand_id, invoice_id, credit_note_id, regime, direction, rate_bps, taxable_minor, tax_minor, period, sac_hsn_code)
    VALUES (p_brand_id, p_invoice_id, v_cn_id, 'igst', 'output', p_tax_rate_bps, -p_taxable_minor, -p_igst_minor, v_inv.billing_period, p_sac);
  END IF;

  RETURN jsonb_build_object('issued', true, 'credit_note_id', v_cn_id, 'credit_note_number', v_num,
    'taxable_minor', p_taxable_minor, 'tax_minor', p_tax_minor, 'total_minor', v_total);
END;
$$;


--
-- Name: issue_invoice(uuid, character, text, text, text, text, integer, bigint, text, integer, bigint, text, text, bigint, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.issue_invoice(p_brand_id uuid, p_period character, p_legal_entity text, p_fy text, p_seller_gstin text, p_place_of_supply text, p_rate_bps integer, p_fee_minor bigint, p_sac text, p_tax_rate_bps integer, p_tax_minor bigint, p_regime text, p_metric_version text, p_cgst_minor bigint, p_sgst_minor bigint, p_igst_minor bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
    AS $$
DECLARE
  v_basis    BIGINT;
  v_currency CHAR(3);
  v_id       UUID;
  v_num      TEXT;
  v_seq      BIGINT;
  v_total    BIGINT;
  v_half_bps INTEGER := p_tax_rate_bps / 2;
BEGIN
  SELECT metered_gmv_minor, currency_code
    INTO v_basis, v_currency
    FROM gmv_meter_snapshot
   WHERE brand_id = p_brand_id AND billing_period = p_period;
  IF v_basis IS NULL THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'not_sealed');
  END IF;

  SELECT invoice_id, invoice_number INTO v_id, v_num
    FROM invoice WHERE brand_id = p_brand_id AND billing_period = p_period;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'already_issued',
      'invoice_id', v_id, 'invoice_number', v_num);
  END IF;

  v_total := p_fee_minor + p_tax_minor;

  INSERT INTO invoice_number_counter (legal_entity, fy, next_seq)
  VALUES (p_legal_entity, p_fy, 1)
  ON CONFLICT (legal_entity, fy) DO NOTHING;

  SELECT next_seq INTO v_seq
    FROM invoice_number_counter
   WHERE legal_entity = p_legal_entity AND fy = p_fy
     FOR UPDATE;

  UPDATE invoice_number_counter
     SET next_seq = v_seq + 1
   WHERE legal_entity = p_legal_entity AND fy = p_fy;

  v_num := p_legal_entity || '/' || p_fy || '/' || lpad(v_seq::text, 6, '0');
  v_id := gen_random_uuid();

  INSERT INTO invoice (invoice_id, brand_id, billing_period, legal_entity, fy, invoice_number,
    currency_code, basis_gmv_minor, rate_bps, fee_minor, tax_minor, total_minor, tax,
    status, seller_gstin, place_of_supply)
  VALUES (v_id, p_brand_id, p_period, p_legal_entity, p_fy, v_num,
    v_currency, v_basis, p_rate_bps, p_fee_minor, p_tax_minor, v_total,
    jsonb_build_object('regime', p_regime, 'rate_bps', p_tax_rate_bps, 'sac_hsn_code', p_sac,
      'taxable_minor', p_fee_minor, 'tax_minor', p_tax_minor,
      'cgst_minor', p_cgst_minor, 'sgst_minor', p_sgst_minor, 'igst_minor', p_igst_minor,
      'seller_gstin', p_seller_gstin, 'place_of_supply', p_place_of_supply),
    'issued', p_seller_gstin, p_place_of_supply);

  INSERT INTO invoice_line (invoice_id, line_no, brand_id, line_type, description,
    basis_gmv_minor, rate_bps, metric_definition_version, source_billing_period,
    sac_hsn_code, taxable_minor, tax_rate_bps, tax_minor, amount_minor)
  VALUES (v_id, 1, p_brand_id, 'platform_fee', 'Brain platform fee on realized GMV',
    v_basis, p_rate_bps, p_metric_version, p_period,
    p_sac, p_fee_minor, p_tax_rate_bps, p_tax_minor, v_total);

  -- tax_ledger by component: intra-state ⇒ cgst + sgst rows; inter-state ⇒ one igst row.
  IF p_regime = 'cgst_sgst' THEN
    INSERT INTO tax_ledger (brand_id, invoice_id, regime, direction, rate_bps, taxable_minor, tax_minor, period, sac_hsn_code)
    VALUES (p_brand_id, v_id, 'cgst', 'output', v_half_bps, p_fee_minor, p_cgst_minor, p_period, p_sac),
           (p_brand_id, v_id, 'sgst', 'output', v_half_bps, p_fee_minor, p_sgst_minor, p_period, p_sac);
  ELSE
    INSERT INTO tax_ledger (brand_id, invoice_id, regime, direction, rate_bps, taxable_minor, tax_minor, period, sac_hsn_code)
    VALUES (p_brand_id, v_id, 'igst', 'output', p_tax_rate_bps, p_fee_minor, p_igst_minor, p_period, p_sac);
  END IF;

  RETURN jsonb_build_object('issued', true, 'invoice_id', v_id, 'invoice_number', v_num,
    'fee_minor', p_fee_minor, 'tax_minor', p_tax_minor, 'total_minor', v_total);
END;
$$;


--
-- Name: ledger_currency_matches_brand(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ledger_currency_matches_brand() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  brand_currency CHAR(3);
BEGIN
  SELECT currency_code INTO brand_currency
  FROM brand
  WHERE id = NEW.brand_id;

  IF brand_currency IS NULL THEN
    RAISE EXCEPTION
      'currency_trigger: brand % not found or has no currency_code', NEW.brand_id;
  END IF;

  IF NEW.currency_code <> brand_currency THEN
    RAISE EXCEPTION
      'currency mismatch: ledger row currency=% but brand % currency=%. '
      'All ledger rows for a brand must share its currency_code.',
      NEW.currency_code, NEW.brand_id, brand_currency;
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: list_active_brand_ids(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_active_brand_ids() RETURNS TABLE(id uuid, cod_recognition_horizon_days integer, prepaid_recognition_horizon_days integer, currency_code character)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
    AS $$
  SELECT
    id,
    cod_recognition_horizon_days,
    prepaid_recognition_horizon_days,
    currency_code
  FROM brand
  WHERE status = 'active'
$$;


--
-- Name: list_ad_connectors_for_spend_repull(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_ad_connectors_for_spend_repull() RETURNS TABLE(connector_instance_id uuid, brand_id uuid, provider text, secret_ref text, ad_account_id text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config'
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


--
-- Name: list_connectors_for_repull(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_connectors_for_repull() RETURNS TABLE(connector_instance_id uuid, brand_id uuid, shop_domain text, secret_ref text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
    AS $$
  SELECT
    ci.id             AS connector_instance_id,
    ci.brand_id,
    ci.shop_domain,
    ci.secret_ref
  FROM connector_instance ci
  WHERE ci.provider = 'shopify'
    AND ci.status   = 'connected'
  ORDER BY ci.created_at ASC
$$;


--
-- Name: list_connectors_for_repull(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_connectors_for_repull(p_provider text) RETURNS TABLE(connector_instance_id uuid, brand_id uuid, provider text, secret_ref text, provider_config jsonb)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'connectors', 'public'
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


--
-- Name: list_gokwik_connectors(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_gokwik_connectors() RETURNS TABLE(connector_instance_id uuid, brand_id uuid, secret_ref text, gokwik_appid text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config'
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


--
-- Name: list_queued_backfill_jobs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_queued_backfill_jobs() RETURNS TABLE(id uuid, brand_id uuid, connector_instance_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
    AS $$
  SELECT
    id,
    brand_id,
    connector_instance_id
  FROM backfill_job
  WHERE status IN ('queued', 'running')
  ORDER BY created_at ASC
$$;


--
-- Name: list_razorpay_connectors_for_settlement_repull(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_razorpay_connectors_for_settlement_repull() RETURNS TABLE(connector_instance_id uuid, brand_id uuid, secret_ref text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
    AS $$
  SELECT
    ci.id             AS connector_instance_id,
    ci.brand_id,
    ci.secret_ref
  FROM connector_instance ci
  WHERE ci.provider = 'razorpay'
    AND ci.status   = 'connected'
  ORDER BY ci.created_at ASC
$$;


--
-- Name: list_resumable_backfill_states(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_resumable_backfill_states() RETURNS TABLE(id uuid, brand_id uuid, connector_instance_id uuid, resource text, status text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config'
    AS $$
  SELECT
    id,
    brand_id,
    connector_instance_id,
    resource,
    status
  FROM jobs.resource_backfill_state
  WHERE status IN ('queued', 'paused', 'failed')
  ORDER BY updated_at ASC
$$;


--
-- Name: list_shiprocket_connectors_for_repull(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_shiprocket_connectors_for_repull() RETURNS TABLE(connector_instance_id uuid, brand_id uuid, secret_ref text, shiprocket_channel_id text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
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


--
-- Name: list_shiprocket_connectors_for_webhook(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_shiprocket_connectors_for_webhook() RETURNS TABLE(connector_instance_id uuid, brand_id uuid, secret_ref text, lookup_key text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config'
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


--
-- Name: list_shopflo_connectors(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_shopflo_connectors() RETURNS TABLE(connector_instance_id uuid, brand_id uuid, secret_ref text, shopflo_merchant_id text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
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


--
-- Name: list_woocommerce_connectors_for_repull(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_woocommerce_connectors_for_repull() RETURNS TABLE(connector_instance_id uuid, brand_id uuid, secret_ref text, woocommerce_site_url text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
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


--
-- Name: maintain_time_partitions(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.maintain_time_partitions(p_ahead_months integer DEFAULT 3, p_retention_months integer DEFAULT NULL::integer) RETURNS TABLE(action text, partition text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  r          record;
  keycol     text;
  m          int;
  mstart     date;
  mend       date;
  pname      text;
  cutoff     date;
  child      record;
  upper_txt  text;
  upper_date date;
  has_brand  boolean;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema, c.relname AS tbl, c.oid AS reloid,
           pg_get_partkeydef(c.oid) AS partkeydef
    FROM pg_partitioned_table p
    JOIN pg_class c     ON c.oid = p.partrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pg_get_partkeydef(c.oid) ILIKE 'RANGE (%'
  LOOP
    keycol := trim((regexp_match(r.partkeydef, '^RANGE \(([^,)]+)\)'))[1]);
    IF keycol IS NULL THEN CONTINUE; END IF;
    -- Brand-scoped tables get child RLS lockdown (audit C1); non-tenant tables just get the partition.
    SELECT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = r.reloid AND a.attname = 'brand_id'
                   AND NOT a.attisdropped) INTO has_brand;

    -- ── CREATE-AHEAD ────────────────────────────────────────────────────────────────────────────
    FOR m IN 0..GREATEST(p_ahead_months, 0) LOOP
      mstart := (date_trunc('month', now())::date + (m || ' months')::interval)::date;
      mend   := (mstart + interval '1 month')::date;
      pname  := r.tbl || '_p' || to_char(mstart, 'YYYY_MM');
      IF NOT EXISTS (
        SELECT 1 FROM pg_class cc JOIN pg_namespace nn ON nn.oid = cc.relnamespace
        WHERE nn.nspname = r.schema AND cc.relname = pname
      ) THEN
        EXECUTE format('CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
                       r.schema, pname, r.schema, r.tbl, mstart::text, mend::text);
        -- BORN-SECURE (audit C1): the app only touches the parent, so the child needs no brain_app
        -- grant; REVOKE ALL + FORCE RLS + isolation policy so a direct child reference can never leak.
        IF has_brand THEN
          EXECUTE format('REVOKE ALL ON %I.%I FROM brain_app', r.schema, pname);
          EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schema, pname);
          EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', r.schema, pname);
          EXECUTE format(
            'CREATE POLICY %I ON %I.%I AS PERMISSIVE FOR ALL TO brain_app USING (brand_id = current_setting(''app.current_brand_id'', TRUE)::uuid)',
            pname || '_isolation', r.schema, pname);
        END IF;
        action := 'created'; partition := r.schema || '.' || pname; RETURN NEXT;
      END IF;
    END LOOP;

    -- ── DROP-OLD (opt-in retention) ─────────────────────────────────────────────────────────────
    IF p_retention_months IS NOT NULL THEN
      cutoff := (date_trunc('month', now())::date - (p_retention_months || ' months')::interval)::date;
      FOR child IN
        SELECT cc.oid, nn.nspname AS schema, cc.relname AS pname,
               pg_get_expr(cc.relpartbound, cc.oid) AS bound
        FROM pg_inherits i
        JOIN pg_class cc     ON cc.oid = i.inhrelid
        JOIN pg_namespace nn ON nn.oid = cc.relnamespace
        WHERE i.inhparent = r.reloid
      LOOP
        IF child.bound IS NULL OR child.bound ILIKE '%DEFAULT%' THEN CONTINUE; END IF;
        upper_txt := (regexp_match(child.bound, 'TO \(''([^'']+)''\)'))[1];
        IF upper_txt IS NULL THEN CONTINUE; END IF;
        BEGIN
          upper_date := upper_txt::date;
        EXCEPTION WHEN others THEN CONTINUE; END;
        IF upper_date <= cutoff THEN
          EXECUTE format('DROP TABLE %I.%I', child.schema, child.pname);
          action := 'dropped'; partition := child.schema || '.' || child.pname; RETURN NEXT;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$$;


--
-- Name: FUNCTION maintain_time_partitions(p_ahead_months integer, p_retention_months integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.maintain_time_partitions(p_ahead_months integer, p_retention_months integer) IS 'C4b partition lifecycle: create-ahead current+N months on every RANGE-partitioned table; optionally drop partitions older than a retention horizon (never the DEFAULT). Idempotent.';


--
-- Name: product_cost_as_of(uuid, text, character, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.product_cost_as_of(p_brand_id uuid, p_sku text, p_currency character, p_as_of date) RETURNS TABLE(cost_minor bigint, currency_code character, valid_from date, valid_to date)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT cost_minor, currency_code, valid_from, valid_to
    FROM gold_product_costs
   WHERE brand_id = p_brand_id
     AND sku = p_sku
     AND currency_code = p_currency
     AND valid_from <= p_as_of
     AND (valid_to IS NULL OR valid_to > p_as_of)
$$;


--
-- Name: provision_brand_crypto(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.provision_brand_crypto(p_brand_id uuid, p_kms_key_id text, p_wrapped_dek_b64 text, p_wrapped_salt_b64 text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'tenancy'
    AS $$
  INSERT INTO tenancy.brand_keyring (brand_id, kms_key_id, wrapped_dek_b64, key_version, is_active)
  VALUES (p_brand_id, p_kms_key_id, p_wrapped_dek_b64, 1, true)
  ON CONFLICT (brand_id) DO NOTHING;

  INSERT INTO tenancy.brand_identity_salt (brand_id, kms_key_id, wrapped_salt_b64, key_version, is_active)
  VALUES (p_brand_id, p_kms_key_id, p_wrapped_salt_b64, 1, true)
  ON CONFLICT (brand_id) DO NOTHING;
$$;


--
-- Name: provision_subject_crypto(uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.provision_subject_crypto(p_brand_id uuid, p_brain_id uuid, p_kms_key_id text, p_wrapped_dek_b64 text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'tenancy'
    AS $$
  INSERT INTO tenancy.subject_keyring (
    brand_id, brain_id, kms_key_id, wrapped_dek_b64, key_version, is_active
  )
  VALUES (p_brand_id, p_brain_id, p_kms_key_id, p_wrapped_dek_b64, 1, true)
  ON CONFLICT (brand_id, brain_id) DO NOTHING;
$$;


--
-- Name: provision_workspace(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.provision_workspace(p_owner_user_id uuid, p_workspace_name text, p_slug text, p_region_code text) RETURNS TABLE(organization_id uuid, onboarding_status text, onboarding_step integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
    AS $$
DECLARE
  v_org UUID;
BEGIN
  INSERT INTO organization (name, slug, owner_user_id, region_code, onboarding_status, onboarding_step)
  VALUES (p_workspace_name, p_slug, p_owner_user_id, COALESCE(p_region_code, 'IN'), 'org_created', 1)
  RETURNING id INTO v_org;

  -- Org-level owner membership (brand_id NULL = org scope).
  INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
  VALUES (v_org, NULL, p_owner_user_id, 'owner');

  RETURN QUERY SELECT v_org, 'org_created'::TEXT, 1;
END;
$$;


--
-- Name: provision_workspace_and_brand(uuid, text, text, text, text, text, character, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.provision_workspace_and_brand(p_owner_user_id uuid, p_workspace_name text, p_slug text, p_brand_display_name text, p_domain text, p_region_code text, p_currency_code character, p_timezone text, p_revenue_definition text) RETURNS TABLE(organization_id uuid, brand_id uuid, onboarding_status text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
    AS $$
DECLARE
  v_org   UUID;
  v_brand UUID;
BEGIN
  -- Organization. onboarding_status lands at 'brand_created' atomically (the intermediate
  -- 'org_created' is never observable in one transaction). A duplicate slug raises 23505 — the
  -- caller retries with a fresh slug (the random-suffix derivation makes this near-zero).
  INSERT INTO organization (name, slug, owner_user_id, region_code, onboarding_status, onboarding_step)
  VALUES (p_workspace_name, p_slug, p_owner_user_id, COALESCE(p_region_code, 'IN'), 'brand_created', 2)
  RETURNING id INTO v_org;

  -- Org-level owner membership.
  INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
  VALUES (v_org, NULL, p_owner_user_id, 'owner');

  -- Brand (1:1 brand:workspace for now — org→brand→website→pixel model).
  INSERT INTO brand (organization_id, display_name, domain, region_code, currency_code, timezone, revenue_definition)
  VALUES (v_org, p_brand_display_name, p_domain, COALESCE(p_region_code, 'IN'),
          COALESCE(p_currency_code, 'INR'), COALESCE(p_timezone, 'Asia/Kolkata'),
          COALESCE(p_revenue_definition, 'realized'))
  RETURNING id INTO v_brand;

  -- Brand-level owner membership.
  INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
  VALUES (v_org, v_brand, p_owner_user_id, 'owner');

  RETURN QUERY SELECT v_org, v_brand, 'brand_created'::TEXT;
END;
$$;


--
-- Name: realized_gmv_composition_as_of(uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.realized_gmv_composition_as_of(p_brand_id uuid, p_as_of date) RETURNS TABLE(event_type text, currency_code character, amount_minor bigint)
    LANGUAGE sql STABLE
    AS $$
  SELECT
    event_type,
    currency_code,
    COALESCE(SUM(amount_minor), 0)::BIGINT AS amount_minor
  FROM realized_revenue_ledger
  WHERE brand_id = p_brand_id
    AND economic_effective_at::date <= p_as_of
    AND event_type <> 'provisional_recognition'
  GROUP BY event_type, currency_code;
$$;


--
-- Name: resolve_brand_by_install_token(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_brand_by_install_token(p_install_token uuid) RETURNS TABLE(brand_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
    AS $$
  SELECT
    pi.brand_id
  FROM pixel_installation pi
  WHERE pi.install_token = p_install_token
  LIMIT 1
$$;


--
-- Name: resolve_connector_by_shop_domain(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_connector_by_shop_domain(p_shop_domain text) RETURNS TABLE(connector_instance_id uuid, brand_id uuid, shop_domain text, secret_ref text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
    AS $$
  SELECT
    ci.id             AS connector_instance_id,
    ci.brand_id,
    ci.shop_domain,
    ci.secret_ref
  FROM connector_instance ci
  WHERE ci.shop_domain = p_shop_domain
    AND ci.provider   = 'shopify'
    AND ci.status     = 'connected'
  LIMIT 1
$$;


--
-- Name: resolve_gokwik_connector_by_merchant(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_gokwik_connector_by_merchant(p_appid text) RETURNS TABLE(connector_instance_id uuid, brand_id uuid, secret_ref text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config'
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


--
-- Name: resolve_razorpay_connector_by_account(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_razorpay_connector_by_account(p_account_id text) RETURNS TABLE(connector_instance_id uuid, brand_id uuid, secret_ref text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
    AS $$
  SELECT
    ci.id             AS connector_instance_id,
    ci.brand_id,
    ci.secret_ref
  FROM connector_instance ci
  WHERE ci.razorpay_account_id = p_account_id
    AND ci.provider             = 'razorpay'
    AND ci.status               = 'connected'
  LIMIT 1
$$;


--
-- Name: resolve_shiprocket_connector_by_channel(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_shiprocket_connector_by_channel(p_channel text) RETURNS TABLE(connector_instance_id uuid, brand_id uuid, secret_ref text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config'
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


--
-- Name: resolve_shopflo_connector_by_merchant(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_shopflo_connector_by_merchant(p_merchant_id text) RETURNS TABLE(connector_instance_id uuid, brand_id uuid, secret_ref text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
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


--
-- Name: resolve_woocommerce_connector_by_site(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_woocommerce_connector_by_site(p_site_url text) RETURNS TABLE(connector_instance_id uuid, brand_id uuid, secret_ref text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'iam', 'tenancy', 'connectors', 'jobs', 'billing', 'audit', 'ai_config', 'identity', 'consent', 'pixel', 'data_plane'
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


--
-- Name: shred_subject_keyring(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.shred_subject_keyring(p_brand_id uuid, p_brain_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'tenancy'
    AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE tenancy.subject_keyring
  SET    is_active  = FALSE,
         updated_at = NOW()
  WHERE  brand_id  = p_brand_id
    AND  brain_id  = p_brain_id
    AND  is_active = TRUE;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;


--
-- Name: capture_brand_config_history(); Type: FUNCTION; Schema: tenancy; Owner: -
--

CREATE FUNCTION tenancy.capture_brand_config_history() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'tenancy', 'pg_temp'
    AS $_$
DECLARE
  k     TEXT;
  newv  TEXT;
  oldv  TEXT;
  keys  TEXT[] := ARRAY['revenue_definition',
                        'cod_recognition_horizon_days',
                        'prepaid_recognition_horizon_days'];
BEGIN
  FOREACH k IN ARRAY keys LOOP
    -- Extract the key's value from NEW (and OLD on UPDATE) as text.
    EXECUTE format('SELECT ($1).%I::text', k) INTO newv USING NEW;
    IF TG_OP = 'UPDATE' THEN
      EXECUTE format('SELECT ($1).%I::text', k) INTO oldv USING OLD;
    ELSE
      oldv := NULL;
    END IF;

    -- On INSERT, seed history for every key. On UPDATE, only when the value actually changed.
    IF TG_OP = 'INSERT' OR newv IS DISTINCT FROM oldv THEN
      -- Close the currently-open row for this (brand, key), if any.
      UPDATE tenancy.brand_config_history
         SET valid_to = NOW()
       WHERE brand_id = NEW.id
         AND config_key = k
         AND valid_to IS NULL;
      -- Open the new effective row.
      INSERT INTO tenancy.brand_config_history (brand_id, config_key, config_value, valid_from)
      VALUES (NEW.id, k, newv, NOW());
    END IF;
  END LOOP;
  RETURN NEW;
END;
$_$;


--
-- Name: ai_provenance; Type: TABLE; Schema: ai_config; Owner: -
--

CREATE TABLE ai_config.ai_provenance (
    provenance_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    metric_id text NOT NULL,
    metric_version text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    snapshot_id text NOT NULL,
    question_redacted text NOT NULL,
    confidence_grade text NOT NULL,
    trust_tier text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_provenance_confidence_grade_check CHECK ((confidence_grade = ANY (ARRAY['A+'::text, 'A'::text, 'B'::text, 'C'::text, 'D'::text]))),
    CONSTRAINT ai_provenance_metric_id_check CHECK ((metric_id = ANY (ARRAY['realized_revenue'::text, 'provisional_revenue'::text, 'ad_spend'::text, 'blended_roas'::text, 'cod_rto_rate'::text, 'cod_mix'::text, 'checkout_funnel'::text, 'order_status_mix'::text, 'journey_first_touch_mix'::text, 'journey_stitch_rate'::text, 'journey_timeline'::text, 'attribution_credit'::text, 'attribution_reconciliation_rate'::text, 'attribution_confidence'::text, 'cost_confidence'::text, 'effective_confidence'::text]))),
    CONSTRAINT ai_provenance_trust_tier_check CHECK ((trust_tier = ANY (ARRAY['Trusted'::text, 'Estimated'::text, 'Untrusted'::text])))
);

ALTER TABLE ONLY ai_config.ai_provenance FORCE ROW LEVEL SECURITY;


--
-- Name: recommendation; Type: TABLE; Schema: ai_config; Owner: -
--

CREATE TABLE ai_config.recommendation (
    recommendation_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    detector text NOT NULL,
    subject text DEFAULT 'brand'::text NOT NULL,
    kind text NOT NULL,
    confidence text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recommendation_confidence_check CHECK ((confidence = ANY (ARRAY['Trusted'::text, 'Estimated'::text, 'Insufficient'::text]))),
    CONSTRAINT recommendation_kind_check CHECK ((kind = ANY (ARRAY['risk'::text, 'opportunity'::text]))),
    CONSTRAINT recommendation_status_check CHECK ((status = ANY (ARRAY['open'::text, 'dismissed'::text, 'expired'::text])))
);

ALTER TABLE ONLY ai_config.recommendation FORCE ROW LEVEL SECURITY;


--
-- Name: recommendation_action; Type: TABLE; Schema: ai_config; Owner: -
--

CREATE TABLE ai_config.recommendation_action (
    action_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    recommendation_id uuid NOT NULL,
    action text NOT NULL,
    actor text NOT NULL,
    reason text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recommendation_action_action_check CHECK ((action = ANY (ARRAY['served'::text, 'accepted'::text, 'dismissed'::text, 'snoozed'::text, 'reopened'::text])))
);

ALTER TABLE ONLY ai_config.recommendation_action FORCE ROW LEVEL SECURITY;


--
-- Name: recommendation_outcome; Type: TABLE; Schema: ai_config; Owner: -
--

CREATE TABLE ai_config.recommendation_outcome (
    recommendation_id uuid NOT NULL,
    brand_id uuid NOT NULL,
    measurement_window text NOT NULL,
    measured jsonb NOT NULL,
    measured_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY ai_config.recommendation_outcome FORCE ROW LEVEL SECURITY;


--
-- Name: audit_log; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.audit_log (
    id bigint NOT NULL,
    brand_id uuid NOT NULL,
    actor_id uuid,
    actor_role text DEFAULT 'system'::text NOT NULL,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    prev_hash text,
    entry_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    idempotency_key text
);

ALTER TABLE ONLY audit.audit_log FORCE ROW LEVEL SECURITY;


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: audit; Owner: -
--

CREATE SEQUENCE audit.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: audit; Owner: -
--

ALTER SEQUENCE audit.audit_log_id_seq OWNED BY audit.audit_log.id;


--
-- Name: capi_deletion_log; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.capi_deletion_log (
    deletion_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    subject_hash text NOT NULL,
    platform text DEFAULT 'meta'::text NOT NULL,
    source_event_id uuid,
    status text NOT NULL,
    event_count integer DEFAULT 0 NOT NULL,
    tombstoned_at timestamp with time zone,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT capi_deletion_log_platform_check CHECK ((platform = 'meta'::text)),
    CONSTRAINT capi_deletion_log_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'deleted'::text, 'would_delete_dev'::text, 'failed'::text])))
);

ALTER TABLE ONLY audit.capi_deletion_log FORCE ROW LEVEL SECURITY;


--
-- Name: capi_passback_log; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.capi_passback_log (
    brand_id uuid NOT NULL,
    event_id text NOT NULL,
    platform text DEFAULT 'meta'::text NOT NULL,
    order_id text NOT NULL,
    subject_hash text NOT NULL,
    ledger_event_id text NOT NULL,
    status text NOT NULL,
    block_reason text,
    match_key_count smallint DEFAULT 0 NOT NULL,
    value_minor bigint NOT NULL,
    currency_code character(3) NOT NULL,
    fbtrace_id text,
    correlation_id text,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capi_passback_log_match_key_count_check CHECK (((match_key_count >= 0) AND (match_key_count <= 4))),
    CONSTRAINT capi_passback_log_platform_check CHECK ((platform = 'meta'::text)),
    CONSTRAINT capi_passback_log_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'blocked_no_consent'::text, 'would_send_dev'::text, 'deleted'::text, 'failed'::text, 'blocked_unsupported_currency'::text])))
);

ALTER TABLE ONLY audit.capi_passback_log FORCE ROW LEVEL SECURITY;


--
-- Name: decision_log; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.decision_log (
    decision_log_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    kind text NOT NULL,
    recommendation_id uuid,
    actor text NOT NULL,
    action text NOT NULL,
    reason text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
)
PARTITION BY RANGE (created_at);

ALTER TABLE ONLY audit.decision_log FORCE ROW LEVEL SECURITY;


--
-- Name: decision_log_p2026_06; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.decision_log_p2026_06 (
    decision_log_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    kind text NOT NULL,
    recommendation_id uuid,
    actor text NOT NULL,
    action text NOT NULL,
    reason text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY audit.decision_log_p2026_06 FORCE ROW LEVEL SECURITY;


--
-- Name: decision_log_p2026_07; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.decision_log_p2026_07 (
    decision_log_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    kind text NOT NULL,
    recommendation_id uuid,
    actor text NOT NULL,
    action text NOT NULL,
    reason text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY audit.decision_log_p2026_07 FORCE ROW LEVEL SECURITY;


--
-- Name: decision_log_pdefault; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.decision_log_pdefault (
    decision_log_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    kind text NOT NULL,
    recommendation_id uuid,
    actor text NOT NULL,
    action text NOT NULL,
    reason text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY audit.decision_log_pdefault FORCE ROW LEVEL SECURITY;


--
-- Name: dq_check_result; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.dq_check_result (
    result_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    category text NOT NULL,
    target text NOT NULL,
    grade text NOT NULL,
    score numeric(5,4),
    observed text NOT NULL,
    threshold text NOT NULL,
    passing boolean NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dq_check_result_category_check CHECK ((category = ANY (ARRAY['freshness'::text, 'completeness'::text, 'schema_validity'::text, 'reconciliation'::text]))),
    CONSTRAINT dq_check_result_grade_check CHECK ((grade = ANY (ARRAY['A+'::text, 'A'::text, 'B'::text, 'C'::text, 'D'::text])))
)
PARTITION BY RANGE (checked_at);

ALTER TABLE ONLY audit.dq_check_result FORCE ROW LEVEL SECURITY;


--
-- Name: dq_check_result_p2026_06; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.dq_check_result_p2026_06 (
    result_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    category text NOT NULL,
    target text NOT NULL,
    grade text NOT NULL,
    score numeric(5,4),
    observed text NOT NULL,
    threshold text NOT NULL,
    passing boolean NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dq_check_result_category_check CHECK ((category = ANY (ARRAY['freshness'::text, 'completeness'::text, 'schema_validity'::text, 'reconciliation'::text]))),
    CONSTRAINT dq_check_result_grade_check CHECK ((grade = ANY (ARRAY['A+'::text, 'A'::text, 'B'::text, 'C'::text, 'D'::text])))
);

ALTER TABLE ONLY audit.dq_check_result_p2026_06 FORCE ROW LEVEL SECURITY;


--
-- Name: dq_check_result_p2026_07; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.dq_check_result_p2026_07 (
    result_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    category text NOT NULL,
    target text NOT NULL,
    grade text NOT NULL,
    score numeric(5,4),
    observed text NOT NULL,
    threshold text NOT NULL,
    passing boolean NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dq_check_result_category_check CHECK ((category = ANY (ARRAY['freshness'::text, 'completeness'::text, 'schema_validity'::text, 'reconciliation'::text]))),
    CONSTRAINT dq_check_result_grade_check CHECK ((grade = ANY (ARRAY['A+'::text, 'A'::text, 'B'::text, 'C'::text, 'D'::text])))
);

ALTER TABLE ONLY audit.dq_check_result_p2026_07 FORCE ROW LEVEL SECURITY;


--
-- Name: dq_check_result_pdefault; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.dq_check_result_pdefault (
    result_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    category text NOT NULL,
    target text NOT NULL,
    grade text NOT NULL,
    score numeric(5,4),
    observed text NOT NULL,
    threshold text NOT NULL,
    passing boolean NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dq_check_result_category_check CHECK ((category = ANY (ARRAY['freshness'::text, 'completeness'::text, 'schema_validity'::text, 'reconciliation'::text]))),
    CONSTRAINT dq_check_result_grade_check CHECK ((grade = ANY (ARRAY['A+'::text, 'A'::text, 'B'::text, 'C'::text, 'D'::text])))
);

ALTER TABLE ONLY audit.dq_check_result_pdefault FORCE ROW LEVEL SECURITY;


--
-- Name: identity_audit; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.identity_audit (
    brand_id uuid NOT NULL,
    audit_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brain_id uuid NOT NULL,
    action text NOT NULL,
    merge_id uuid,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_audit_action_check CHECK ((action = ANY (ARRAY['mint'::text, 'link'::text, 'merge'::text, 'unmerge'::text, 'rebind'::text, 'erase'::text])))
)
PARTITION BY RANGE (occurred_at);

ALTER TABLE ONLY audit.identity_audit FORCE ROW LEVEL SECURITY;


--
-- Name: identity_audit_p2026_06; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.identity_audit_p2026_06 (
    brand_id uuid NOT NULL,
    audit_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brain_id uuid NOT NULL,
    action text NOT NULL,
    merge_id uuid,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_audit_action_check CHECK ((action = ANY (ARRAY['mint'::text, 'link'::text, 'merge'::text, 'unmerge'::text, 'rebind'::text, 'erase'::text])))
);

ALTER TABLE ONLY audit.identity_audit_p2026_06 FORCE ROW LEVEL SECURITY;


--
-- Name: identity_audit_pdefault; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.identity_audit_pdefault (
    brand_id uuid NOT NULL,
    audit_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brain_id uuid NOT NULL,
    action text NOT NULL,
    merge_id uuid,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_audit_action_check CHECK ((action = ANY (ARRAY['mint'::text, 'link'::text, 'merge'::text, 'unmerge'::text, 'rebind'::text, 'erase'::text])))
);

ALTER TABLE ONLY audit.identity_audit_pdefault FORCE ROW LEVEL SECURITY;


--
-- Name: send_log; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.send_log (
    id bigint NOT NULL,
    brand_id uuid NOT NULL,
    subject_hash text,
    channel text NOT NULL,
    notification_type text NOT NULL,
    status text NOT NULL,
    blocked_reason text,
    release_after timestamp with time zone,
    correlation_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT send_log_status_check CHECK ((status = ANY (ARRAY['attempted'::text, 'sent'::text, 'failed'::text, 'blocked'::text, 'pending_window'::text, 'released'::text])))
)
PARTITION BY RANGE (created_at);

ALTER TABLE ONLY audit.send_log FORCE ROW LEVEL SECURITY;


--
-- Name: send_log_p2026_06; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.send_log_p2026_06 (
    id bigint NOT NULL,
    brand_id uuid NOT NULL,
    subject_hash text,
    channel text NOT NULL,
    notification_type text NOT NULL,
    status text NOT NULL,
    blocked_reason text,
    release_after timestamp with time zone,
    correlation_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT send_log_status_check CHECK ((status = ANY (ARRAY['attempted'::text, 'sent'::text, 'failed'::text, 'blocked'::text, 'pending_window'::text, 'released'::text])))
);

ALTER TABLE ONLY audit.send_log_p2026_06 FORCE ROW LEVEL SECURITY;


--
-- Name: send_log_part_id_seq; Type: SEQUENCE; Schema: audit; Owner: -
--

ALTER TABLE audit.send_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME audit.send_log_part_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: send_log_pdefault; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.send_log_pdefault (
    id bigint NOT NULL,
    brand_id uuid NOT NULL,
    subject_hash text,
    channel text NOT NULL,
    notification_type text NOT NULL,
    status text NOT NULL,
    blocked_reason text,
    release_after timestamp with time zone,
    correlation_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT send_log_status_check CHECK ((status = ANY (ARRAY['attempted'::text, 'sent'::text, 'failed'::text, 'blocked'::text, 'pending_window'::text, 'released'::text])))
);

ALTER TABLE ONLY audit.send_log_pdefault FORCE ROW LEVEL SECURITY;


--
-- Name: billing_plan; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.billing_plan (
    brand_id uuid NOT NULL,
    rate_bps integer NOT NULL,
    effective_from date DEFAULT CURRENT_DATE NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT billing_plan_rate_bps_check CHECK (((rate_bps >= 0) AND (rate_bps <= 10000)))
);

ALTER TABLE ONLY billing.billing_plan FORCE ROW LEVEL SECURITY;


--
-- Name: cost_input; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.cost_input (
    brand_id uuid NOT NULL,
    cost_input_id text NOT NULL,
    scope text NOT NULL,
    scope_ref text DEFAULT ''::text NOT NULL,
    cost_type text NOT NULL,
    amount_minor bigint,
    pct_bps integer,
    currency_code character(3) NOT NULL,
    cost_confidence text DEFAULT 'Estimated'::text NOT NULL,
    effective_from date DEFAULT CURRENT_DATE NOT NULL,
    effective_to date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cost_input_cost_confidence_check CHECK ((cost_confidence = ANY (ARRAY['Trusted'::text, 'Estimated'::text, 'Insufficient'::text]))),
    CONSTRAINT cost_input_cost_type_check CHECK ((cost_type = ANY (ARRAY['cogs'::text, 'shipping'::text, 'packaging'::text, 'payment_fee'::text, 'marketplace_fee'::text]))),
    CONSTRAINT cost_input_pct_bps_check CHECK (((pct_bps IS NULL) OR ((pct_bps >= 0) AND (pct_bps <= 100000)))),
    CONSTRAINT cost_input_rate_xor_amount CHECK (((amount_minor IS NOT NULL) <> (pct_bps IS NOT NULL))),
    CONSTRAINT cost_input_scope_check CHECK ((scope = ANY (ARRAY['global'::text, 'sku'::text, 'category'::text])))
);

ALTER TABLE ONLY billing.cost_input FORCE ROW LEVEL SECURITY;


--
-- Name: credit_note; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.credit_note (
    credit_note_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    billing_period character(7) NOT NULL,
    legal_entity text NOT NULL,
    fy text NOT NULL,
    credit_note_number text NOT NULL,
    currency_code character(3) NOT NULL,
    reason text NOT NULL,
    taxable_minor bigint NOT NULL,
    tax_minor bigint NOT NULL,
    total_minor bigint NOT NULL,
    regime text NOT NULL,
    tax jsonb NOT NULL,
    sac_hsn_code text NOT NULL,
    tax_rate_bps integer NOT NULL,
    seller_gstin text NOT NULL,
    place_of_supply text NOT NULL,
    status text DEFAULT 'issued'::text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT credit_note_status_check CHECK ((status = 'issued'::text))
);

ALTER TABLE ONLY billing.credit_note FORCE ROW LEVEL SECURITY;


--
-- Name: credit_note_number_counter; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.credit_note_number_counter (
    legal_entity text NOT NULL,
    fy text NOT NULL,
    next_seq bigint DEFAULT 1 NOT NULL
);


--
-- Name: gmv_meter_snapshot; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.gmv_meter_snapshot (
    brand_id uuid NOT NULL,
    billing_period character(7) NOT NULL,
    currency_code character(3) NOT NULL,
    metered_gmv_minor bigint NOT NULL,
    as_of_date date NOT NULL,
    ledger_row_count bigint DEFAULT 0 NOT NULL,
    sealed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gmv_meter_snapshot_billing_period_check CHECK ((billing_period ~ '^\d{4}-\d{2}$'::text)),
    CONSTRAINT gmv_meter_snapshot_metered_gmv_minor_check CHECK ((metered_gmv_minor >= 0))
);

ALTER TABLE ONLY billing.gmv_meter_snapshot FORCE ROW LEVEL SECURITY;


--
-- Name: invoice; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.invoice (
    invoice_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    billing_period character(7) NOT NULL,
    legal_entity text NOT NULL,
    fy text NOT NULL,
    invoice_number text NOT NULL,
    currency_code character(3) NOT NULL,
    basis_gmv_minor bigint NOT NULL,
    rate_bps integer NOT NULL,
    fee_minor bigint NOT NULL,
    tax_minor bigint NOT NULL,
    total_minor bigint NOT NULL,
    tax jsonb NOT NULL,
    status text DEFAULT 'issued'::text NOT NULL,
    seller_gstin text NOT NULL,
    place_of_supply text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invoice_billing_period_check CHECK ((billing_period ~ '^\d{4}-\d{2}$'::text)),
    CONSTRAINT invoice_status_check CHECK ((status = ANY (ARRAY['issued'::text, 'void'::text])))
);

ALTER TABLE ONLY billing.invoice FORCE ROW LEVEL SECURITY;


--
-- Name: invoice_line; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.invoice_line (
    invoice_id uuid NOT NULL,
    line_no integer NOT NULL,
    brand_id uuid NOT NULL,
    line_type text NOT NULL,
    description text NOT NULL,
    basis_gmv_minor bigint NOT NULL,
    rate_bps integer NOT NULL,
    metric_definition_version text NOT NULL,
    source_billing_period character(7) NOT NULL,
    sac_hsn_code text NOT NULL,
    taxable_minor bigint NOT NULL,
    tax_rate_bps integer NOT NULL,
    tax_minor bigint NOT NULL,
    amount_minor bigint NOT NULL
);

ALTER TABLE ONLY billing.invoice_line FORCE ROW LEVEL SECURITY;


--
-- Name: invoice_number_counter; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.invoice_number_counter (
    legal_entity text NOT NULL,
    fy text NOT NULL,
    next_seq bigint DEFAULT 1 NOT NULL
);


--
-- Name: tax_ledger; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.tax_ledger (
    tax_record_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    regime text NOT NULL,
    direction text NOT NULL,
    rate_bps integer NOT NULL,
    taxable_minor bigint NOT NULL,
    tax_minor bigint NOT NULL,
    period character(7) NOT NULL,
    sac_hsn_code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    credit_note_id uuid,
    CONSTRAINT tax_ledger_direction_check CHECK ((direction = ANY (ARRAY['input'::text, 'output'::text])))
)
PARTITION BY RANGE (created_at);

ALTER TABLE ONLY billing.tax_ledger FORCE ROW LEVEL SECURITY;


--
-- Name: tax_ledger_p2026_06; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.tax_ledger_p2026_06 (
    tax_record_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    regime text NOT NULL,
    direction text NOT NULL,
    rate_bps integer NOT NULL,
    taxable_minor bigint NOT NULL,
    tax_minor bigint NOT NULL,
    period character(7) NOT NULL,
    sac_hsn_code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    credit_note_id uuid,
    CONSTRAINT tax_ledger_direction_check CHECK ((direction = ANY (ARRAY['input'::text, 'output'::text])))
);

ALTER TABLE ONLY billing.tax_ledger_p2026_06 FORCE ROW LEVEL SECURITY;


--
-- Name: tax_ledger_pdefault; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.tax_ledger_pdefault (
    tax_record_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    regime text NOT NULL,
    direction text NOT NULL,
    rate_bps integer NOT NULL,
    taxable_minor bigint NOT NULL,
    tax_minor bigint NOT NULL,
    period character(7) NOT NULL,
    sac_hsn_code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    credit_note_id uuid,
    CONSTRAINT tax_ledger_direction_check CHECK ((direction = ANY (ARRAY['input'::text, 'output'::text])))
);

ALTER TABLE ONLY billing.tax_ledger_pdefault FORCE ROW LEVEL SECURITY;


--
-- Name: connector_cursor; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_cursor (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    connector_instance_id uuid NOT NULL,
    resource text NOT NULL,
    cursor_value text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY connectors.connector_cursor FORCE ROW LEVEL SECURITY;


--
-- Name: connector_dlq_record; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_dlq_record (
    dlq_id uuid NOT NULL,
    brand_id uuid NOT NULL,
    source_topic text NOT NULL,
    partition integer NOT NULL,
    kafka_offset bigint NOT NULL,
    provider text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_class text NOT NULL,
    error_detail text DEFAULT ''::text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    redrive_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL
)
PARTITION BY RANGE (created_at);

ALTER TABLE ONLY connectors.connector_dlq_record FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE connector_dlq_record; Type: COMMENT; Schema: connectors; Owner: -
--

COMMENT ON TABLE connectors.connector_dlq_record IS 'Queryable forensic store for Kafka dead-letters. dlq_id is a deterministic UUID v5 from (source_topic, partition, kafka_offset); created_at is day-truncated by the writer so same-day retries dedup via PK. Extends retention beyond the 30d Kafka DLQ window.';


--
-- Name: COLUMN connector_dlq_record.partition; Type: COMMENT; Schema: connectors; Owner: -
--

COMMENT ON COLUMN connectors.connector_dlq_record.partition IS 'Kafka partition — "partition" is not a reserved word in PG; the column name is intentional.';


--
-- Name: COLUMN connector_dlq_record.created_at; Type: COMMENT; Schema: connectors; Owner: -
--

COMMENT ON COLUMN connectors.connector_dlq_record.created_at IS 'Set by the writer to date_trunc(''day'', now()) for day-level idempotency (same-day retries dedup via PK; cross-day re-writes produce a second row, acceptable for a forensic store).';


--
-- Name: connector_dlq_record_p2026_06; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_dlq_record_p2026_06 (
    dlq_id uuid NOT NULL,
    brand_id uuid NOT NULL,
    source_topic text NOT NULL,
    partition integer NOT NULL,
    kafka_offset bigint NOT NULL,
    provider text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_class text NOT NULL,
    error_detail text DEFAULT ''::text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    redrive_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL
);

ALTER TABLE ONLY connectors.connector_dlq_record_p2026_06 FORCE ROW LEVEL SECURITY;


--
-- Name: connector_dlq_record_p2026_07; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_dlq_record_p2026_07 (
    dlq_id uuid NOT NULL,
    brand_id uuid NOT NULL,
    source_topic text NOT NULL,
    partition integer NOT NULL,
    kafka_offset bigint NOT NULL,
    provider text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_class text NOT NULL,
    error_detail text DEFAULT ''::text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    redrive_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL
);

ALTER TABLE ONLY connectors.connector_dlq_record_p2026_07 FORCE ROW LEVEL SECURITY;


--
-- Name: connector_dlq_record_p2026_08; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_dlq_record_p2026_08 (
    dlq_id uuid NOT NULL,
    brand_id uuid NOT NULL,
    source_topic text NOT NULL,
    partition integer NOT NULL,
    kafka_offset bigint NOT NULL,
    provider text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_class text NOT NULL,
    error_detail text DEFAULT ''::text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    redrive_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL
);

ALTER TABLE ONLY connectors.connector_dlq_record_p2026_08 FORCE ROW LEVEL SECURITY;


--
-- Name: connector_dlq_record_pdefault; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_dlq_record_pdefault (
    dlq_id uuid NOT NULL,
    brand_id uuid NOT NULL,
    source_topic text NOT NULL,
    partition integer NOT NULL,
    kafka_offset bigint NOT NULL,
    provider text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_class text NOT NULL,
    error_detail text DEFAULT ''::text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    redrive_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL
);

ALTER TABLE ONLY connectors.connector_dlq_record_pdefault FORCE ROW LEVEL SECURITY;


--
-- Name: connector_instance; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_instance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    provider text NOT NULL,
    shop_domain text NOT NULL,
    secret_ref text NOT NULL,
    status text DEFAULT 'connected'::text NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    disconnected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    health_state text DEFAULT 'Healthy'::text NOT NULL,
    safety_rating text DEFAULT 'safe'::text NOT NULL,
    razorpay_account_id text,
    ad_account_id text,
    shopflo_merchant_id text,
    gokwik_appid text,
    next_repull_at timestamp with time zone,
    shiprocket_channel_id text,
    woocommerce_site_url text,
    connector_provider_config jsonb,
    account_key text DEFAULT '__default__'::text NOT NULL,
    activated_at timestamp with time zone,
    CONSTRAINT connector_instance_health_state_check CHECK ((health_state = ANY (ARRAY['Healthy'::text, 'Delayed'::text, 'Failed'::text, 'Disconnected'::text, 'RateLimited'::text, 'TokenExpired'::text, 'Disabled'::text]))),
    CONSTRAINT connector_instance_safety_rating_check CHECK ((safety_rating = ANY (ARRAY['safe'::text, 'degraded'::text, 'blocked'::text]))),
    CONSTRAINT connector_instance_status_check CHECK ((status = ANY (ARRAY['connected'::text, 'disconnected'::text, 'error'::text])))
);

ALTER TABLE ONLY connectors.connector_instance FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN connector_instance.provider; Type: COMMENT; Schema: connectors; Owner: -
--

COMMENT ON COLUMN connectors.connector_instance.provider IS 'Connector provider id (e.g. shopify, razorpay, ...). Validity is enforced in the app connect-gate against CONNECTOR_CATALOG (registry.ts, ADR-CM-1 SoT) — intentionally NOT a DB CHECK/enum, so a new connector is a catalog row + handler, never a migration. UNIQUE per (brand_id, provider).';


--
-- Name: COLUMN connector_instance.activated_at; Type: COMMENT; Schema: connectors; Owner: -
--

COMMENT ON COLUMN connectors.connector_instance.activated_at IS 'Ad-account activation marker (0106). NULL = discovered-but-not-ingesting; NOT NULL = the chosen account that ingests. Exactly one active per (brand, ad-platform provider). NULL/ignored for storefront + payment providers, which always ingest when status=connected.';


--
-- Name: connector_journey_stitch_map; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_journey_stitch_map (
    brand_id uuid NOT NULL,
    order_id text NOT NULL,
    stitched_anon_id text NOT NULL,
    brain_id uuid,
    click_ids jsonb,
    utms jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY connectors.connector_journey_stitch_map FORCE ROW LEVEL SECURITY;


--
-- Name: connector_razorpay_order_map; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_razorpay_order_map (
    brand_id uuid NOT NULL,
    razorpay_order_id text,
    shopify_order_id text NOT NULL,
    razorpay_payment_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY connectors.connector_razorpay_order_map FORCE ROW LEVEL SECURITY;


--
-- Name: connector_sync_run; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_sync_run (
    run_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    provider text NOT NULL,
    account_key text,
    run_type text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    rows_ingested bigint DEFAULT 0,
    error_class text,
    error_detail text,
    correlation_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT connector_sync_run_run_type_check CHECK ((run_type = ANY (ARRAY['backfill'::text, 'repull'::text, 'webhook'::text]))),
    CONSTRAINT connector_sync_run_status_check CHECK ((status = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text])))
)
PARTITION BY RANGE (started_at);

ALTER TABLE ONLY connectors.connector_sync_run FORCE ROW LEVEL SECURITY;


--
-- Name: connector_sync_run_p2026_07; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_sync_run_p2026_07 (
    run_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    provider text NOT NULL,
    account_key text,
    run_type text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    rows_ingested bigint DEFAULT 0,
    error_class text,
    error_detail text,
    correlation_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT connector_sync_run_run_type_check CHECK ((run_type = ANY (ARRAY['backfill'::text, 'repull'::text, 'webhook'::text]))),
    CONSTRAINT connector_sync_run_status_check CHECK ((status = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text])))
);

ALTER TABLE ONLY connectors.connector_sync_run_p2026_07 FORCE ROW LEVEL SECURITY;


--
-- Name: connector_sync_run_p2026_08; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_sync_run_p2026_08 (
    run_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    provider text NOT NULL,
    account_key text,
    run_type text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    rows_ingested bigint DEFAULT 0,
    error_class text,
    error_detail text,
    correlation_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT connector_sync_run_run_type_check CHECK ((run_type = ANY (ARRAY['backfill'::text, 'repull'::text, 'webhook'::text]))),
    CONSTRAINT connector_sync_run_status_check CHECK ((status = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text])))
);

ALTER TABLE ONLY connectors.connector_sync_run_p2026_08 FORCE ROW LEVEL SECURITY;


--
-- Name: connector_sync_run_p2026_09; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_sync_run_p2026_09 (
    run_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    provider text NOT NULL,
    account_key text,
    run_type text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    rows_ingested bigint DEFAULT 0,
    error_class text,
    error_detail text,
    correlation_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT connector_sync_run_run_type_check CHECK ((run_type = ANY (ARRAY['backfill'::text, 'repull'::text, 'webhook'::text]))),
    CONSTRAINT connector_sync_run_status_check CHECK ((status = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text])))
);

ALTER TABLE ONLY connectors.connector_sync_run_p2026_09 FORCE ROW LEVEL SECURITY;


--
-- Name: connector_sync_status; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_sync_status (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    connector_instance_id uuid NOT NULL,
    state text DEFAULT 'waiting_for_data'::text NOT NULL,
    last_sync_at timestamp with time zone,
    last_error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    consecutive_failure_count integer DEFAULT 0 NOT NULL,
    first_failure_at timestamp with time zone,
    CONSTRAINT connector_sync_status_state_check CHECK ((state = ANY (ARRAY['connected'::text, 'syncing'::text, 'waiting_for_data'::text, 'error'::text])))
);

ALTER TABLE ONLY connectors.connector_sync_status FORCE ROW LEVEL SECURITY;


--
-- Name: connector_webhook_raw_archive; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_webhook_raw_archive (
    id bigint NOT NULL,
    brand_id uuid NOT NULL,
    source text NOT NULL,
    topic text NOT NULL,
    body_sha256 text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    correlation_id text,
    redacted_body jsonb NOT NULL
)
PARTITION BY RANGE (received_at);

ALTER TABLE ONLY connectors.connector_webhook_raw_archive FORCE ROW LEVEL SECURITY;


--
-- Name: connector_webhook_raw_archive_legacy; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_webhook_raw_archive_legacy (
    id bigint NOT NULL,
    brand_id uuid NOT NULL,
    source text NOT NULL,
    topic text NOT NULL,
    body_sha256 text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    correlation_id text,
    redacted_body jsonb NOT NULL
);

ALTER TABLE ONLY connectors.connector_webhook_raw_archive_legacy FORCE ROW LEVEL SECURITY;


--
-- Name: connector_webhook_raw_archive_id_seq; Type: SEQUENCE; Schema: connectors; Owner: -
--

CREATE SEQUENCE connectors.connector_webhook_raw_archive_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: connector_webhook_raw_archive_id_seq; Type: SEQUENCE OWNED BY; Schema: connectors; Owner: -
--

ALTER SEQUENCE connectors.connector_webhook_raw_archive_id_seq OWNED BY connectors.connector_webhook_raw_archive_legacy.id;


--
-- Name: connector_webhook_raw_archive_part_id_seq; Type: SEQUENCE; Schema: connectors; Owner: -
--

CREATE SEQUENCE connectors.connector_webhook_raw_archive_part_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: connector_webhook_raw_archive_part_id_seq; Type: SEQUENCE OWNED BY; Schema: connectors; Owner: -
--

ALTER SEQUENCE connectors.connector_webhook_raw_archive_part_id_seq OWNED BY connectors.connector_webhook_raw_archive.id;


--
-- Name: connector_webhook_raw_archive_p2026_06; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_webhook_raw_archive_p2026_06 (
    id bigint DEFAULT nextval('connectors.connector_webhook_raw_archive_part_id_seq'::regclass) NOT NULL,
    brand_id uuid NOT NULL,
    source text NOT NULL,
    topic text NOT NULL,
    body_sha256 text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    correlation_id text,
    redacted_body jsonb NOT NULL
);

ALTER TABLE ONLY connectors.connector_webhook_raw_archive_p2026_06 FORCE ROW LEVEL SECURITY;


--
-- Name: connector_webhook_raw_archive_p2026_07; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_webhook_raw_archive_p2026_07 (
    id bigint DEFAULT nextval('connectors.connector_webhook_raw_archive_part_id_seq'::regclass) NOT NULL,
    brand_id uuid NOT NULL,
    source text NOT NULL,
    topic text NOT NULL,
    body_sha256 text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    correlation_id text,
    redacted_body jsonb NOT NULL
);

ALTER TABLE ONLY connectors.connector_webhook_raw_archive_p2026_07 FORCE ROW LEVEL SECURITY;


--
-- Name: connector_webhook_raw_archive_p2026_08; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_webhook_raw_archive_p2026_08 (
    id bigint DEFAULT nextval('connectors.connector_webhook_raw_archive_part_id_seq'::regclass) NOT NULL,
    brand_id uuid NOT NULL,
    source text NOT NULL,
    topic text NOT NULL,
    body_sha256 text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    correlation_id text,
    redacted_body jsonb NOT NULL
);

ALTER TABLE ONLY connectors.connector_webhook_raw_archive_p2026_08 FORCE ROW LEVEL SECURITY;


--
-- Name: connector_webhook_raw_archive_pdefault; Type: TABLE; Schema: connectors; Owner: -
--

CREATE TABLE connectors.connector_webhook_raw_archive_pdefault (
    id bigint DEFAULT nextval('connectors.connector_webhook_raw_archive_part_id_seq'::regclass) NOT NULL,
    brand_id uuid NOT NULL,
    source text NOT NULL,
    topic text NOT NULL,
    body_sha256 text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    correlation_id text,
    redacted_body jsonb NOT NULL
);

ALTER TABLE ONLY connectors.connector_webhook_raw_archive_pdefault FORCE ROW LEVEL SECURITY;


--
-- Name: consent_record; Type: TABLE; Schema: consent; Owner: -
--

CREATE TABLE consent.consent_record (
    brand_id uuid NOT NULL,
    subject_hash text NOT NULL,
    category text NOT NULL,
    state text NOT NULL,
    source text DEFAULT 'collector'::text NOT NULL,
    policy_version text DEFAULT 'v1'::text NOT NULL,
    effective_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    source_event_id uuid,
    CONSTRAINT consent_record_category_check CHECK ((category = ANY (ARRAY['analytics'::text, 'marketing'::text, 'personalization'::text, 'ai_processing'::text, 'advertising'::text]))),
    CONSTRAINT consent_record_source_check CHECK ((source = ANY (ARRAY['collector'::text, 'operator'::text, 'api'::text, 'import'::text, 'consent_manager'::text]))),
    CONSTRAINT consent_record_state_check CHECK ((state = ANY (ARRAY['granted'::text, 'withdrawn'::text])))
);

ALTER TABLE ONLY consent.consent_record FORCE ROW LEVEL SECURITY;


--
-- Name: consent_tombstone; Type: TABLE; Schema: consent; Owner: -
--

CREATE TABLE consent.consent_tombstone (
    tombstone_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    subject_hash text NOT NULL,
    category text,
    reason text DEFAULT 'withdrawal'::text NOT NULL,
    source text DEFAULT 'collector'::text NOT NULL,
    tombstoned_at timestamp with time zone DEFAULT now() NOT NULL,
    source_event_id uuid,
    CONSTRAINT consent_tombstone_category_check CHECK (((category IS NULL) OR (category = ANY (ARRAY['analytics'::text, 'marketing'::text, 'personalization'::text, 'ai_processing'::text, 'advertising'::text])))),
    CONSTRAINT consent_tombstone_reason_check CHECK ((reason = ANY (ARRAY['withdrawal'::text, 'erasure'::text]))),
    CONSTRAINT consent_tombstone_source_check CHECK ((source = ANY (ARRAY['collector'::text, 'operator'::text, 'api'::text, 'consent_manager'::text])))
);

ALTER TABLE ONLY consent.consent_tombstone FORCE ROW LEVEL SECURITY;


--
-- Name: collector_spool; Type: TABLE; Schema: data_plane; Owner: -
--

CREATE TABLE data_plane.collector_spool (
    id bigint NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    raw_body jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    drained_at timestamp with time zone,
    CONSTRAINT collector_spool_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'drained'::text])))
);


--
-- Name: collector_spool_id_seq; Type: SEQUENCE; Schema: data_plane; Owner: -
--

CREATE SEQUENCE data_plane.collector_spool_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: collector_spool_id_seq; Type: SEQUENCE OWNED BY; Schema: data_plane; Owner: -
--

ALTER SEQUENCE data_plane.collector_spool_id_seq OWNED BY data_plane.collector_spool.id;


--
-- Name: app_user; Type: TABLE; Schema: iam; Owner: -
--

CREATE TABLE iam.app_user (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email public.citext NOT NULL,
    email_normalized text NOT NULL,
    password_hash text NOT NULL,
    email_verified_at timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_user_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text])))
);


--
-- Name: email_verification; Type: TABLE; Schema: iam; Owner: -
--

CREATE TABLE iam.email_verification (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY iam.email_verification FORCE ROW LEVEL SECURITY;


--
-- Name: membership; Type: TABLE; Schema: iam; Owner: -
--

CREATE TABLE iam.membership (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    brand_id uuid,
    app_user_id uuid NOT NULL,
    role_code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT membership_role_code_check CHECK ((role_code = ANY (ARRAY['owner'::text, 'brand_admin'::text, 'manager'::text, 'analyst'::text])))
);

ALTER TABLE ONLY iam.membership FORCE ROW LEVEL SECURITY;


--
-- Name: password_reset; Type: TABLE; Schema: iam; Owner: -
--

CREATE TABLE iam.password_reset (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY iam.password_reset FORCE ROW LEVEL SECURITY;


--
-- Name: contact_pii; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.contact_pii (
    brand_id uuid NOT NULL,
    brain_id uuid NOT NULL,
    pii_type text NOT NULL,
    pii_value text,
    identifier_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pii_ciphertext bytea,
    pii_iv bytea,
    pii_auth_tag bytea,
    key_version integer,
    subject_key_version integer,
    CONSTRAINT contact_pii_pii_type_check CHECK ((pii_type = ANY (ARRAY['email'::text, 'phone'::text, 'name'::text])))
);

ALTER TABLE ONLY identity.contact_pii FORCE ROW LEVEL SECURITY;


--
-- Name: pii_erasure_log; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.pii_erasure_log (
    brand_id uuid NOT NULL,
    brain_id uuid NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    vault_shredded boolean DEFAULT false NOT NULL,
    surrogate_brain_id uuid,
    capi_requested boolean DEFAULT false NOT NULL,
    completed_at timestamp with time zone
);

ALTER TABLE ONLY identity.pii_erasure_log FORCE ROW LEVEL SECURITY;


--
-- Name: backfill_job; Type: TABLE; Schema: jobs; Owner: -
--

CREATE TABLE jobs.backfill_job (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    connector_instance_id uuid NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    records_processed bigint DEFAULT 0 NOT NULL,
    estimated_total bigint,
    cursor_value text,
    cursor_date timestamp with time zone,
    achieved_depth_label text,
    failure_reason text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    requested_window_ms bigint,
    CONSTRAINT backfill_job_requested_window_ms_check CHECK (((requested_window_ms IS NULL) OR (requested_window_ms > 0))),
    CONSTRAINT backfill_job_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'partial'::text, 'failed'::text])))
);

ALTER TABLE ONLY jobs.backfill_job FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN backfill_job.requested_window_ms; Type: COMMENT; Schema: jobs; Owner: -
--

COMMENT ON COLUMN jobs.backfill_job.requested_window_ms IS 'Caller-requested historical depth in ms (NULL = provider max). Clamped to the provider manifest maxBackfillWindowMs at claim time — never a depth entitlement.';


--
-- Name: resource_backfill_state; Type: TABLE; Schema: jobs; Owner: -
--

CREATE TABLE jobs.resource_backfill_state (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    connector_instance_id uuid NOT NULL,
    resource text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    anchor_at timestamp with time zone NOT NULL,
    floor_at timestamp with time zone NOT NULL,
    cursor_value text,
    reached_at timestamp with time zone,
    records_processed bigint DEFAULT 0 NOT NULL,
    failure_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT resource_backfill_state_records_ck CHECK ((records_processed >= 0)),
    CONSTRAINT resource_backfill_state_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'paused'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT resource_backfill_state_window_ck CHECK ((floor_at <= anchor_at))
);

ALTER TABLE ONLY jobs.resource_backfill_state FORCE ROW LEVEL SECURITY;


--
-- Name: model_registry; Type: TABLE; Schema: ml; Owner: -
--

CREATE TABLE ml.model_registry (
    model_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    name text NOT NULL,
    version text NOT NULL,
    stage text DEFAULT 'training'::text NOT NULL,
    framework text DEFAULT 'deterministic'::text NOT NULL,
    feature_set jsonb DEFAULT '[]'::jsonb NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    trained_at timestamp with time zone,
    promoted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT model_registry_stage_check CHECK ((stage = ANY (ARRAY['training'::text, 'staging'::text, 'production'::text, 'archived'::text])))
);

ALTER TABLE ONLY ml.model_registry FORCE ROW LEVEL SECURITY;


--
-- Name: brand_identity_priority; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.brand_identity_priority (
    brand_id uuid NOT NULL,
    version integer NOT NULL,
    priority_order jsonb NOT NULL,
    created_by text DEFAULT 'system'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT brand_identity_priority_order_is_array CHECK ((jsonb_typeof(priority_order) = 'array'::text)),
    CONSTRAINT brand_identity_priority_version_positive CHECK ((version >= 1))
);

ALTER TABLE ONLY ops.brand_identity_priority FORCE ROW LEVEL SECURITY;


--
-- Name: identity_export_state; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.identity_export_state (
    scope text NOT NULL,
    last_created_at_ms bigint,
    updated_at timestamp with time zone
);


--
-- Name: journey_reversion_pending; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.journey_reversion_pending (
    brand_id uuid NOT NULL,
    brain_id uuid NOT NULL,
    cause text NOT NULL,
    trigger_event text NOT NULL,
    source_event_id text,
    enqueued_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT journey_reversion_pending_cause_check CHECK ((cause = ANY (ARRAY['merge'::text, 'unmerge'::text, 'restitch'::text])))
);


--
-- Name: ops_ml_prediction_log; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.ops_ml_prediction_log (
    brand_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    prediction_id text NOT NULL,
    model_id text,
    subject_type text NOT NULL,
    subject_key text NOT NULL,
    prediction jsonb,
    score double precision
)
PARTITION BY RANGE (created_at);


--
-- Name: ops_ml_prediction_log_p2026_05; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.ops_ml_prediction_log_p2026_05 (
    brand_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    prediction_id text NOT NULL,
    model_id text,
    subject_type text NOT NULL,
    subject_key text NOT NULL,
    prediction jsonb,
    score double precision
);


--
-- Name: ops_ml_prediction_log_p2026_06; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.ops_ml_prediction_log_p2026_06 (
    brand_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    prediction_id text NOT NULL,
    model_id text,
    subject_type text NOT NULL,
    subject_key text NOT NULL,
    prediction jsonb,
    score double precision
);


--
-- Name: ops_ml_prediction_log_p2026_07; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.ops_ml_prediction_log_p2026_07 (
    brand_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    prediction_id text NOT NULL,
    model_id text,
    subject_type text NOT NULL,
    subject_key text NOT NULL,
    prediction jsonb,
    score double precision
);


--
-- Name: ops_ml_prediction_log_pdefault; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.ops_ml_prediction_log_pdefault (
    brand_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    prediction_id text NOT NULL,
    model_id text,
    subject_type text NOT NULL,
    subject_key text NOT NULL,
    prediction jsonb,
    score double precision
);


--
-- Name: restitch_pending; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.restitch_pending (
    brand_id uuid NOT NULL,
    dirty_kind text NOT NULL,
    dirty_key text NOT NULL,
    trigger_event text NOT NULL,
    source_event_id text,
    enqueued_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT restitch_pending_dirty_kind_check CHECK ((dirty_kind = ANY (ARRAY['identifier_hash'::text, 'brain_id'::text])))
);


--
-- Name: saved_segment; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.saved_segment (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    name text NOT NULL,
    definition jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY ops.saved_segment FORCE ROW LEVEL SECURITY;


--
-- Name: scoped_recompute_request; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.scoped_recompute_request (
    brand_id uuid NOT NULL,
    request_id text NOT NULL,
    source_event_id text,
    trigger_event text,
    brain_ids jsonb,
    affected_marts jsonb,
    requested_at timestamp with time zone,
    processed_at timestamp with time zone
);


--
-- Name: silver_customer_identity; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.silver_customer_identity (
    brand_id uuid NOT NULL,
    brain_id uuid NOT NULL,
    lifecycle_state text,
    merged_into uuid,
    minted_at timestamp with time zone,
    first_identified_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: silver_identity_link; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.silver_identity_link (
    brand_id uuid NOT NULL,
    identifier_type text NOT NULL,
    identifier_value text NOT NULL,
    brain_id uuid,
    tier text,
    is_active boolean,
    updated_at timestamp with time zone
);


--
-- Name: silver_journey_stitch; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.silver_journey_stitch (
    brand_id uuid NOT NULL,
    order_id text NOT NULL,
    stitched_anon_id text,
    brain_id uuid,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: stitch_conflict_review; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.stitch_conflict_review (
    brand_id uuid NOT NULL,
    review_id uuid NOT NULL,
    session_id text NOT NULL,
    brain_id_a uuid NOT NULL,
    brain_id_b uuid NOT NULL,
    trigger_reason text DEFAULT 'stitch_conflict'::text NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stitch_conflict_review_distinct_brains CHECK ((brain_id_a <> brain_id_b)),
    CONSTRAINT stitch_conflict_review_evidence_is_object CHECK ((jsonb_typeof(evidence) = 'object'::text)),
    CONSTRAINT stitch_conflict_review_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'merged'::text, 'rejected'::text, 'expired'::text])))
);

ALTER TABLE ONLY ops.stitch_conflict_review FORCE ROW LEVEL SECURITY;


--
-- Name: pixel_installation; Type: TABLE; Schema: pixel; Owner: -
--

CREATE TABLE pixel.pixel_installation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    install_token uuid DEFAULT gen_random_uuid() NOT NULL,
    target_host text NOT NULL,
    installed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auto_install_provider text,
    auto_install_ref text,
    custom_ingest_host text,
    CONSTRAINT pixel_installation_auto_install_provider_check CHECK ((auto_install_provider = ANY (ARRAY['shopify_script_tag'::text, 'shopify_web_pixel'::text])))
);

ALTER TABLE ONLY pixel.pixel_installation FORCE ROW LEVEL SECURITY;


--
-- Name: pixel_status; Type: TABLE; Schema: pixel; Owner: -
--

CREATE TABLE pixel.pixel_status (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    pixel_installation_id uuid NOT NULL,
    state text DEFAULT 'waiting_for_data'::text NOT NULL,
    verified_at timestamp with time zone,
    last_error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pixel_status_state_check CHECK ((state = ANY (ARRAY['connected'::text, 'syncing'::text, 'waiting_for_data'::text, 'error'::text])))
);

ALTER TABLE ONLY pixel.pixel_status FORCE ROW LEVEL SECURITY;


--
-- Name: dev_secret; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dev_secret (
    name text NOT NULL,
    secret_value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE dev_secret; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.dev_secret IS 'DEV-ONLY local secrets store (migration 0024). Production uses AWS Secrets Manager + KMS. Never the secret store outside dev; prod-hard-fail is enforced in LocalSecretsManager. AUDIT L3 (0087): retained intentionally — load-bearing for dev/prod-local + integration tests.';


--
-- Name: gold_product_costs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gold_product_costs (
    brand_id uuid NOT NULL,
    product_cost_id text NOT NULL,
    sku text NOT NULL,
    cost_minor bigint NOT NULL,
    currency_code character(3) NOT NULL,
    valid_from date NOT NULL,
    valid_to date,
    source_system text DEFAULT 'cost_sheet_csv'::text NOT NULL,
    source_event_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gold_product_costs_cost_minor_check CHECK ((cost_minor >= 0)),
    CONSTRAINT gpc_valid_interval CHECK (((valid_to IS NULL) OR (valid_to > valid_from)))
);

ALTER TABLE ONLY public.gold_product_costs FORCE ROW LEVEL SECURITY;
--
-- Name: brand; Type: TABLE; Schema: tenancy; Owner: -
--

CREATE TABLE tenancy.brand (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    display_name text NOT NULL,
    domain text,
    status text DEFAULT 'active'::text NOT NULL,
    region_code text DEFAULT 'IN'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    currency_code character(3) DEFAULT 'INR'::bpchar NOT NULL,
    timezone text DEFAULT 'Asia/Kolkata'::text NOT NULL,
    revenue_definition text DEFAULT 'realized'::text NOT NULL,
    identity_salt_ciphertext bytea,
    phone_guard_threshold integer DEFAULT 10 NOT NULL,
    suppression_window_days integer DEFAULT 30 NOT NULL,
    cod_recognition_horizon_days integer DEFAULT 25 NOT NULL,
    prepaid_recognition_horizon_days integer DEFAULT 7 NOT NULL,
    identity_capture text DEFAULT 'off'::text NOT NULL,
    consent_source text DEFAULT 'cmp_signal'::text NOT NULL,
    CONSTRAINT brand_consent_source_check CHECK ((consent_source = ANY (ARRAY['cmp_signal'::text, 'assume_granted'::text]))),
    CONSTRAINT brand_identity_capture_check CHECK ((identity_capture = ANY (ARRAY['off'::text, 'explicit_only'::text, 'autodetect'::text]))),
    CONSTRAINT brand_revenue_definition_check CHECK ((revenue_definition = ANY (ARRAY['realized'::text, 'delivered'::text]))),
    CONSTRAINT brand_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);

ALTER TABLE ONLY tenancy.brand FORCE ROW LEVEL SECURITY;


--
-- Name: brand_config_history; Type: TABLE; Schema: tenancy; Owner: -
--

CREATE TABLE tenancy.brand_config_history (
    history_id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    config_key text NOT NULL,
    config_value text,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_to timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT brand_config_history_check CHECK (((valid_to IS NULL) OR (valid_to >= valid_from)))
);

ALTER TABLE ONLY tenancy.brand_config_history FORCE ROW LEVEL SECURITY;


--
-- Name: brand_identity_salt; Type: TABLE; Schema: tenancy; Owner: -
--

CREATE TABLE tenancy.brand_identity_salt (
    brand_id uuid NOT NULL,
    kms_key_id text NOT NULL,
    wrapped_salt_b64 text NOT NULL,
    key_version integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY tenancy.brand_identity_salt FORCE ROW LEVEL SECURITY;


--
-- Name: brand_keyring; Type: TABLE; Schema: tenancy; Owner: -
--

CREATE TABLE tenancy.brand_keyring (
    brand_id uuid NOT NULL,
    kms_key_id text NOT NULL,
    wrapped_dek_b64 text NOT NULL,
    key_version integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY tenancy.brand_keyring FORCE ROW LEVEL SECURITY;


--
-- Name: organization; Type: TABLE; Schema: tenancy; Owner: -
--

CREATE TABLE tenancy.organization (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    owner_user_id uuid NOT NULL,
    region_code text DEFAULT 'IN'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    onboarding_status text DEFAULT 'pending'::text NOT NULL,
    onboarding_step smallint DEFAULT 0 NOT NULL,
    CONSTRAINT organization_onboarding_status_check CHECK ((onboarding_status = ANY (ARRAY['pending'::text, 'org_created'::text, 'brand_created'::text, 'integration_selected'::text, 'complete'::text]))),
    CONSTRAINT organization_onboarding_step_check CHECK (((onboarding_step >= 0) AND (onboarding_step <= 4)))
);

ALTER TABLE ONLY tenancy.organization FORCE ROW LEVEL SECURITY;


--
-- Name: ref_currency; Type: TABLE; Schema: tenancy; Owner: -
--

CREATE TABLE tenancy.ref_currency (
    code character(3) NOT NULL,
    display_name text NOT NULL,
    minor_unit_digits smallint DEFAULT 2 NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: ref_timezone; Type: TABLE; Schema: tenancy; Owner: -
--

CREATE TABLE tenancy.ref_timezone (
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: subject_keyring; Type: TABLE; Schema: tenancy; Owner: -
--

CREATE TABLE tenancy.subject_keyring (
    brand_id uuid NOT NULL,
    brain_id uuid NOT NULL,
    kms_key_id text NOT NULL,
    wrapped_dek_b64 text NOT NULL,
    key_version integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY tenancy.subject_keyring FORCE ROW LEVEL SECURITY;


--
-- Name: decision_log_p2026_06; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.decision_log ATTACH PARTITION audit.decision_log_p2026_06 FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');


--
-- Name: decision_log_p2026_07; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.decision_log ATTACH PARTITION audit.decision_log_p2026_07 FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');


--
-- Name: decision_log_pdefault; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.decision_log ATTACH PARTITION audit.decision_log_pdefault DEFAULT;


--
-- Name: dq_check_result_p2026_06; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.dq_check_result ATTACH PARTITION audit.dq_check_result_p2026_06 FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');


--
-- Name: dq_check_result_p2026_07; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.dq_check_result ATTACH PARTITION audit.dq_check_result_p2026_07 FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');


--
-- Name: dq_check_result_pdefault; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.dq_check_result ATTACH PARTITION audit.dq_check_result_pdefault DEFAULT;


--
-- Name: identity_audit_p2026_06; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.identity_audit ATTACH PARTITION audit.identity_audit_p2026_06 FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');


--
-- Name: identity_audit_pdefault; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.identity_audit ATTACH PARTITION audit.identity_audit_pdefault DEFAULT;


--
-- Name: send_log_p2026_06; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.send_log ATTACH PARTITION audit.send_log_p2026_06 FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');


--
-- Name: send_log_pdefault; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.send_log ATTACH PARTITION audit.send_log_pdefault DEFAULT;


--
-- Name: tax_ledger_p2026_06; Type: TABLE ATTACH; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.tax_ledger ATTACH PARTITION billing.tax_ledger_p2026_06 FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');


--
-- Name: tax_ledger_pdefault; Type: TABLE ATTACH; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.tax_ledger ATTACH PARTITION billing.tax_ledger_pdefault DEFAULT;


--
-- Name: connector_dlq_record_p2026_06; Type: TABLE ATTACH; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_dlq_record ATTACH PARTITION connectors.connector_dlq_record_p2026_06 FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');


--
-- Name: connector_dlq_record_p2026_07; Type: TABLE ATTACH; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_dlq_record ATTACH PARTITION connectors.connector_dlq_record_p2026_07 FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');


--
-- Name: connector_dlq_record_p2026_08; Type: TABLE ATTACH; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_dlq_record ATTACH PARTITION connectors.connector_dlq_record_p2026_08 FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');


--
-- Name: connector_dlq_record_pdefault; Type: TABLE ATTACH; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_dlq_record ATTACH PARTITION connectors.connector_dlq_record_pdefault DEFAULT;


--
-- Name: connector_sync_run_p2026_07; Type: TABLE ATTACH; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_sync_run ATTACH PARTITION connectors.connector_sync_run_p2026_07 FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');


--
-- Name: connector_sync_run_p2026_08; Type: TABLE ATTACH; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_sync_run ATTACH PARTITION connectors.connector_sync_run_p2026_08 FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');


--
-- Name: connector_sync_run_p2026_09; Type: TABLE ATTACH; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_sync_run ATTACH PARTITION connectors.connector_sync_run_p2026_09 FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');


--
-- Name: connector_webhook_raw_archive_p2026_06; Type: TABLE ATTACH; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive ATTACH PARTITION connectors.connector_webhook_raw_archive_p2026_06 FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');


--
-- Name: connector_webhook_raw_archive_p2026_07; Type: TABLE ATTACH; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive ATTACH PARTITION connectors.connector_webhook_raw_archive_p2026_07 FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');


--
-- Name: connector_webhook_raw_archive_p2026_08; Type: TABLE ATTACH; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive ATTACH PARTITION connectors.connector_webhook_raw_archive_p2026_08 FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');


--
-- Name: connector_webhook_raw_archive_pdefault; Type: TABLE ATTACH; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive ATTACH PARTITION connectors.connector_webhook_raw_archive_pdefault DEFAULT;


--
-- Name: ops_ml_prediction_log_p2026_05; Type: TABLE ATTACH; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.ops_ml_prediction_log ATTACH PARTITION ops.ops_ml_prediction_log_p2026_05 FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');


--
-- Name: ops_ml_prediction_log_p2026_06; Type: TABLE ATTACH; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.ops_ml_prediction_log ATTACH PARTITION ops.ops_ml_prediction_log_p2026_06 FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');


--
-- Name: ops_ml_prediction_log_p2026_07; Type: TABLE ATTACH; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.ops_ml_prediction_log ATTACH PARTITION ops.ops_ml_prediction_log_p2026_07 FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');


--
-- Name: ops_ml_prediction_log_pdefault; Type: TABLE ATTACH; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.ops_ml_prediction_log ATTACH PARTITION ops.ops_ml_prediction_log_pdefault DEFAULT;


--
-- Name: audit_log id; Type: DEFAULT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.audit_log ALTER COLUMN id SET DEFAULT nextval('audit.audit_log_id_seq'::regclass);


--
-- Name: connector_webhook_raw_archive id; Type: DEFAULT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive ALTER COLUMN id SET DEFAULT nextval('connectors.connector_webhook_raw_archive_part_id_seq'::regclass);


--
-- Name: connector_webhook_raw_archive_legacy id; Type: DEFAULT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive_legacy ALTER COLUMN id SET DEFAULT nextval('connectors.connector_webhook_raw_archive_id_seq'::regclass);


--
-- Name: collector_spool id; Type: DEFAULT; Schema: data_plane; Owner: -
--

ALTER TABLE ONLY data_plane.collector_spool ALTER COLUMN id SET DEFAULT nextval('data_plane.collector_spool_id_seq'::regclass);


--
-- Name: ai_provenance ai_provenance_pkey; Type: CONSTRAINT; Schema: ai_config; Owner: -
--

ALTER TABLE ONLY ai_config.ai_provenance
    ADD CONSTRAINT ai_provenance_pkey PRIMARY KEY (brand_id, provenance_id);


--
-- Name: recommendation_action recommendation_action_pkey; Type: CONSTRAINT; Schema: ai_config; Owner: -
--

ALTER TABLE ONLY ai_config.recommendation_action
    ADD CONSTRAINT recommendation_action_pkey PRIMARY KEY (action_id);


--
-- Name: recommendation recommendation_brand_id_detector_subject_key; Type: CONSTRAINT; Schema: ai_config; Owner: -
--

ALTER TABLE ONLY ai_config.recommendation
    ADD CONSTRAINT recommendation_brand_id_detector_subject_key UNIQUE (brand_id, detector, subject);


--
-- Name: recommendation_outcome recommendation_outcome_pkey; Type: CONSTRAINT; Schema: ai_config; Owner: -
--

ALTER TABLE ONLY ai_config.recommendation_outcome
    ADD CONSTRAINT recommendation_outcome_pkey PRIMARY KEY (recommendation_id, measurement_window);


--
-- Name: recommendation recommendation_pkey; Type: CONSTRAINT; Schema: ai_config; Owner: -
--

ALTER TABLE ONLY ai_config.recommendation
    ADD CONSTRAINT recommendation_pkey PRIMARY KEY (recommendation_id);


--
-- Name: audit_log audit_log_idempotency_key_key; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.audit_log
    ADD CONSTRAINT audit_log_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: capi_deletion_log capi_deletion_log_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.capi_deletion_log
    ADD CONSTRAINT capi_deletion_log_pkey PRIMARY KEY (brand_id, deletion_id);


--
-- Name: capi_passback_log capi_passback_log_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.capi_passback_log
    ADD CONSTRAINT capi_passback_log_pkey PRIMARY KEY (brand_id, event_id);


--
-- Name: decision_log decision_log_part_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.decision_log
    ADD CONSTRAINT decision_log_part_pkey PRIMARY KEY (decision_log_id, created_at);


--
-- Name: decision_log_p2026_06 decision_log_p2026_06_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.decision_log_p2026_06
    ADD CONSTRAINT decision_log_p2026_06_pkey PRIMARY KEY (decision_log_id, created_at);


--
-- Name: decision_log_p2026_07 decision_log_p2026_07_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.decision_log_p2026_07
    ADD CONSTRAINT decision_log_p2026_07_pkey PRIMARY KEY (decision_log_id, created_at);


--
-- Name: decision_log_pdefault decision_log_pdefault_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.decision_log_pdefault
    ADD CONSTRAINT decision_log_pdefault_pkey PRIMARY KEY (decision_log_id, created_at);


--
-- Name: dq_check_result dq_check_result_part_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.dq_check_result
    ADD CONSTRAINT dq_check_result_part_pkey PRIMARY KEY (brand_id, result_id, checked_at);


--
-- Name: dq_check_result_p2026_06 dq_check_result_p2026_06_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.dq_check_result_p2026_06
    ADD CONSTRAINT dq_check_result_p2026_06_pkey PRIMARY KEY (brand_id, result_id, checked_at);


--
-- Name: dq_check_result_p2026_07 dq_check_result_p2026_07_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.dq_check_result_p2026_07
    ADD CONSTRAINT dq_check_result_p2026_07_pkey PRIMARY KEY (brand_id, result_id, checked_at);


--
-- Name: dq_check_result_pdefault dq_check_result_pdefault_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.dq_check_result_pdefault
    ADD CONSTRAINT dq_check_result_pdefault_pkey PRIMARY KEY (brand_id, result_id, checked_at);


--
-- Name: identity_audit identity_audit_part_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.identity_audit
    ADD CONSTRAINT identity_audit_part_pkey PRIMARY KEY (brand_id, audit_id, occurred_at);


--
-- Name: identity_audit_p2026_06 identity_audit_p2026_06_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.identity_audit_p2026_06
    ADD CONSTRAINT identity_audit_p2026_06_pkey PRIMARY KEY (brand_id, audit_id, occurred_at);


--
-- Name: identity_audit_pdefault identity_audit_pdefault_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.identity_audit_pdefault
    ADD CONSTRAINT identity_audit_pdefault_pkey PRIMARY KEY (brand_id, audit_id, occurred_at);


--
-- Name: send_log send_log_part_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.send_log
    ADD CONSTRAINT send_log_part_pkey PRIMARY KEY (id, created_at);


--
-- Name: send_log_p2026_06 send_log_p2026_06_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.send_log_p2026_06
    ADD CONSTRAINT send_log_p2026_06_pkey PRIMARY KEY (id, created_at);


--
-- Name: send_log_pdefault send_log_pdefault_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.send_log_pdefault
    ADD CONSTRAINT send_log_pdefault_pkey PRIMARY KEY (id, created_at);


--
-- Name: billing_plan billing_plan_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.billing_plan
    ADD CONSTRAINT billing_plan_pkey PRIMARY KEY (brand_id);


--
-- Name: cost_input cost_input_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.cost_input
    ADD CONSTRAINT cost_input_pkey PRIMARY KEY (brand_id, cost_input_id);


--
-- Name: credit_note credit_note_legal_entity_fy_credit_note_number_key; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.credit_note
    ADD CONSTRAINT credit_note_legal_entity_fy_credit_note_number_key UNIQUE (legal_entity, fy, credit_note_number);


--
-- Name: credit_note_number_counter credit_note_number_counter_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.credit_note_number_counter
    ADD CONSTRAINT credit_note_number_counter_pkey PRIMARY KEY (legal_entity, fy);


--
-- Name: credit_note credit_note_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.credit_note
    ADD CONSTRAINT credit_note_pkey PRIMARY KEY (credit_note_id);


--
-- Name: gmv_meter_snapshot gmv_meter_snapshot_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.gmv_meter_snapshot
    ADD CONSTRAINT gmv_meter_snapshot_pkey PRIMARY KEY (brand_id, billing_period);


--
-- Name: invoice invoice_brand_id_billing_period_key; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.invoice
    ADD CONSTRAINT invoice_brand_id_billing_period_key UNIQUE (brand_id, billing_period);


--
-- Name: invoice invoice_legal_entity_fy_invoice_number_key; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.invoice
    ADD CONSTRAINT invoice_legal_entity_fy_invoice_number_key UNIQUE (legal_entity, fy, invoice_number);


--
-- Name: invoice_line invoice_line_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.invoice_line
    ADD CONSTRAINT invoice_line_pkey PRIMARY KEY (invoice_id, line_no);


--
-- Name: invoice_number_counter invoice_number_counter_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.invoice_number_counter
    ADD CONSTRAINT invoice_number_counter_pkey PRIMARY KEY (legal_entity, fy);


--
-- Name: invoice invoice_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.invoice
    ADD CONSTRAINT invoice_pkey PRIMARY KEY (invoice_id);


--
-- Name: tax_ledger tax_ledger_part_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.tax_ledger
    ADD CONSTRAINT tax_ledger_part_pkey PRIMARY KEY (tax_record_id, created_at);


--
-- Name: tax_ledger_p2026_06 tax_ledger_p2026_06_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.tax_ledger_p2026_06
    ADD CONSTRAINT tax_ledger_p2026_06_pkey PRIMARY KEY (tax_record_id, created_at);


--
-- Name: tax_ledger_pdefault tax_ledger_pdefault_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.tax_ledger_pdefault
    ADD CONSTRAINT tax_ledger_pdefault_pkey PRIMARY KEY (tax_record_id, created_at);


--
-- Name: connector_cursor connector_cursor_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_cursor
    ADD CONSTRAINT connector_cursor_pkey PRIMARY KEY (id);


--
-- Name: connector_cursor connector_cursor_upsert_key; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_cursor
    ADD CONSTRAINT connector_cursor_upsert_key UNIQUE (brand_id, connector_instance_id, resource);


--
-- Name: connector_dlq_record connector_dlq_record_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_dlq_record
    ADD CONSTRAINT connector_dlq_record_pkey PRIMARY KEY (brand_id, dlq_id, created_at);


--
-- Name: connector_dlq_record_p2026_06 connector_dlq_record_p2026_06_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_dlq_record_p2026_06
    ADD CONSTRAINT connector_dlq_record_p2026_06_pkey PRIMARY KEY (brand_id, dlq_id, created_at);


--
-- Name: connector_dlq_record_p2026_07 connector_dlq_record_p2026_07_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_dlq_record_p2026_07
    ADD CONSTRAINT connector_dlq_record_p2026_07_pkey PRIMARY KEY (brand_id, dlq_id, created_at);


--
-- Name: connector_dlq_record_p2026_08 connector_dlq_record_p2026_08_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_dlq_record_p2026_08
    ADD CONSTRAINT connector_dlq_record_p2026_08_pkey PRIMARY KEY (brand_id, dlq_id, created_at);


--
-- Name: connector_dlq_record_pdefault connector_dlq_record_pdefault_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_dlq_record_pdefault
    ADD CONSTRAINT connector_dlq_record_pdefault_pkey PRIMARY KEY (brand_id, dlq_id, created_at);


--
-- Name: connector_instance connector_instance_brand_provider_account_unique; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_instance
    ADD CONSTRAINT connector_instance_brand_provider_account_unique UNIQUE (brand_id, provider, account_key);


--
-- Name: connector_instance connector_instance_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_instance
    ADD CONSTRAINT connector_instance_pkey PRIMARY KEY (id);


--
-- Name: connector_journey_stitch_map connector_journey_stitch_map_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_journey_stitch_map
    ADD CONSTRAINT connector_journey_stitch_map_pkey PRIMARY KEY (brand_id, order_id);


--
-- Name: connector_razorpay_order_map connector_razorpay_order_map_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_razorpay_order_map
    ADD CONSTRAINT connector_razorpay_order_map_pkey PRIMARY KEY (brand_id, razorpay_payment_id);


--
-- Name: connector_sync_run connector_sync_run_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_sync_run
    ADD CONSTRAINT connector_sync_run_pkey PRIMARY KEY (run_id, started_at);


--
-- Name: connector_sync_run_p2026_07 connector_sync_run_p2026_07_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_sync_run_p2026_07
    ADD CONSTRAINT connector_sync_run_p2026_07_pkey PRIMARY KEY (run_id, started_at);


--
-- Name: connector_sync_run_p2026_08 connector_sync_run_p2026_08_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_sync_run_p2026_08
    ADD CONSTRAINT connector_sync_run_p2026_08_pkey PRIMARY KEY (run_id, started_at);


--
-- Name: connector_sync_run_p2026_09 connector_sync_run_p2026_09_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_sync_run_p2026_09
    ADD CONSTRAINT connector_sync_run_p2026_09_pkey PRIMARY KEY (run_id, started_at);


--
-- Name: connector_sync_status connector_sync_status_brand_connector_unique; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_sync_status
    ADD CONSTRAINT connector_sync_status_brand_connector_unique UNIQUE (brand_id, connector_instance_id);


--
-- Name: connector_sync_status connector_sync_status_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_sync_status
    ADD CONSTRAINT connector_sync_status_pkey PRIMARY KEY (id);


--
-- Name: connector_webhook_raw_archive connector_webhook_raw_archive_dedup_p; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive
    ADD CONSTRAINT connector_webhook_raw_archive_dedup_p UNIQUE (brand_id, topic, body_sha256, received_at);


--
-- Name: connector_webhook_raw_archive_p2026_07 connector_webhook_raw_archive_brand_id_topic_body_sha256_r_key1; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive_p2026_07
    ADD CONSTRAINT connector_webhook_raw_archive_brand_id_topic_body_sha256_r_key1 UNIQUE (brand_id, topic, body_sha256, received_at);


--
-- Name: connector_webhook_raw_archive_p2026_08 connector_webhook_raw_archive_brand_id_topic_body_sha256_r_key2; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive_p2026_08
    ADD CONSTRAINT connector_webhook_raw_archive_brand_id_topic_body_sha256_r_key2 UNIQUE (brand_id, topic, body_sha256, received_at);


--
-- Name: connector_webhook_raw_archive_pdefault connector_webhook_raw_archive_brand_id_topic_body_sha256_r_key3; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive_pdefault
    ADD CONSTRAINT connector_webhook_raw_archive_brand_id_topic_body_sha256_r_key3 UNIQUE (brand_id, topic, body_sha256, received_at);


--
-- Name: connector_webhook_raw_archive_p2026_06 connector_webhook_raw_archive_brand_id_topic_body_sha256_re_key; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive_p2026_06
    ADD CONSTRAINT connector_webhook_raw_archive_brand_id_topic_body_sha256_re_key UNIQUE (brand_id, topic, body_sha256, received_at);


--
-- Name: connector_webhook_raw_archive_legacy connector_webhook_raw_archive_dedup; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive_legacy
    ADD CONSTRAINT connector_webhook_raw_archive_dedup UNIQUE (brand_id, topic, body_sha256);


--
-- Name: connector_webhook_raw_archive connector_webhook_raw_archive_part_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive
    ADD CONSTRAINT connector_webhook_raw_archive_part_pkey PRIMARY KEY (brand_id, id, received_at);


--
-- Name: connector_webhook_raw_archive_p2026_06 connector_webhook_raw_archive_p2026_06_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive_p2026_06
    ADD CONSTRAINT connector_webhook_raw_archive_p2026_06_pkey PRIMARY KEY (brand_id, id, received_at);


--
-- Name: connector_webhook_raw_archive_p2026_07 connector_webhook_raw_archive_p2026_07_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive_p2026_07
    ADD CONSTRAINT connector_webhook_raw_archive_p2026_07_pkey PRIMARY KEY (brand_id, id, received_at);


--
-- Name: connector_webhook_raw_archive_p2026_08 connector_webhook_raw_archive_p2026_08_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive_p2026_08
    ADD CONSTRAINT connector_webhook_raw_archive_p2026_08_pkey PRIMARY KEY (brand_id, id, received_at);


--
-- Name: connector_webhook_raw_archive_pdefault connector_webhook_raw_archive_pdefault_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive_pdefault
    ADD CONSTRAINT connector_webhook_raw_archive_pdefault_pkey PRIMARY KEY (brand_id, id, received_at);


--
-- Name: connector_webhook_raw_archive_legacy connector_webhook_raw_archive_pkey; Type: CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_webhook_raw_archive_legacy
    ADD CONSTRAINT connector_webhook_raw_archive_pkey PRIMARY KEY (id);


--
-- Name: consent_record consent_record_pkey; Type: CONSTRAINT; Schema: consent; Owner: -
--

ALTER TABLE ONLY consent.consent_record
    ADD CONSTRAINT consent_record_pkey PRIMARY KEY (brand_id, subject_hash, category, effective_at);


--
-- Name: consent_tombstone consent_tombstone_pkey; Type: CONSTRAINT; Schema: consent; Owner: -
--

ALTER TABLE ONLY consent.consent_tombstone
    ADD CONSTRAINT consent_tombstone_pkey PRIMARY KEY (brand_id, tombstone_id);


--
-- Name: collector_spool collector_spool_pkey; Type: CONSTRAINT; Schema: data_plane; Owner: -
--

ALTER TABLE ONLY data_plane.collector_spool
    ADD CONSTRAINT collector_spool_pkey PRIMARY KEY (id);


--
-- Name: app_user app_user_email_unique; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.app_user
    ADD CONSTRAINT app_user_email_unique UNIQUE (email);


--
-- Name: app_user app_user_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.app_user
    ADD CONSTRAINT app_user_pkey PRIMARY KEY (id);


--
-- Name: email_verification email_verification_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.email_verification
    ADD CONSTRAINT email_verification_pkey PRIMARY KEY (id);


--
-- Name: email_verification email_verification_token_hash_unique; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.email_verification
    ADD CONSTRAINT email_verification_token_hash_unique UNIQUE (token_hash);


--
-- Name: invite invite_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.invite
    ADD CONSTRAINT invite_pkey PRIMARY KEY (id);


--
-- Name: invite invite_token_hash_unique; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.invite
    ADD CONSTRAINT invite_token_hash_unique UNIQUE (token_hash);


--
-- Name: membership membership_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.membership
    ADD CONSTRAINT membership_pkey PRIMARY KEY (id);


--
-- Name: password_reset password_reset_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.password_reset
    ADD CONSTRAINT password_reset_pkey PRIMARY KEY (id);


--
-- Name: password_reset password_reset_token_hash_unique; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.password_reset
    ADD CONSTRAINT password_reset_token_hash_unique UNIQUE (token_hash);


--
-- Name: user_session user_session_jti_unique; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.user_session
    ADD CONSTRAINT user_session_jti_unique UNIQUE (jti);


--
-- Name: user_session user_session_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.user_session
    ADD CONSTRAINT user_session_pkey PRIMARY KEY (id);


--
-- Name: contact_pii contact_pii_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.contact_pii
    ADD CONSTRAINT contact_pii_pkey PRIMARY KEY (brand_id, brain_id, pii_type);


--
-- Name: pii_erasure_log pii_erasure_log_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.pii_erasure_log
    ADD CONSTRAINT pii_erasure_log_pkey PRIMARY KEY (brand_id, brain_id);


--
-- Name: backfill_job backfill_job_pkey; Type: CONSTRAINT; Schema: jobs; Owner: -
--

ALTER TABLE ONLY jobs.backfill_job
    ADD CONSTRAINT backfill_job_pkey PRIMARY KEY (id);


--
-- Name: resource_backfill_state resource_backfill_state_pkey; Type: CONSTRAINT; Schema: jobs; Owner: -
--

ALTER TABLE ONLY jobs.resource_backfill_state
    ADD CONSTRAINT resource_backfill_state_pkey PRIMARY KEY (id);


--
-- Name: resource_backfill_state resource_backfill_state_upsert_key; Type: CONSTRAINT; Schema: jobs; Owner: -
--

ALTER TABLE ONLY jobs.resource_backfill_state
    ADD CONSTRAINT resource_backfill_state_upsert_key UNIQUE (brand_id, connector_instance_id, resource);


--
-- Name: model_registry model_registry_brand_id_name_version_key; Type: CONSTRAINT; Schema: ml; Owner: -
--

ALTER TABLE ONLY ml.model_registry
    ADD CONSTRAINT model_registry_brand_id_name_version_key UNIQUE (brand_id, name, version);


--
-- Name: model_registry model_registry_pkey; Type: CONSTRAINT; Schema: ml; Owner: -
--

ALTER TABLE ONLY ml.model_registry
    ADD CONSTRAINT model_registry_pkey PRIMARY KEY (model_id);


--
-- Name: brand_identity_priority brand_identity_priority_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.brand_identity_priority
    ADD CONSTRAINT brand_identity_priority_pkey PRIMARY KEY (brand_id, version);


--
-- Name: identity_export_state identity_export_state_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.identity_export_state
    ADD CONSTRAINT identity_export_state_pkey PRIMARY KEY (scope);


--
-- Name: journey_reversion_pending journey_reversion_pending_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.journey_reversion_pending
    ADD CONSTRAINT journey_reversion_pending_pkey PRIMARY KEY (brand_id, brain_id);


--
-- Name: ops_ml_prediction_log ops_ml_prediction_log_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.ops_ml_prediction_log
    ADD CONSTRAINT ops_ml_prediction_log_pkey PRIMARY KEY (brand_id, created_at, prediction_id);


--
-- Name: ops_ml_prediction_log_p2026_05 ops_ml_prediction_log_p2026_05_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.ops_ml_prediction_log_p2026_05
    ADD CONSTRAINT ops_ml_prediction_log_p2026_05_pkey PRIMARY KEY (brand_id, created_at, prediction_id);


--
-- Name: ops_ml_prediction_log_p2026_06 ops_ml_prediction_log_p2026_06_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.ops_ml_prediction_log_p2026_06
    ADD CONSTRAINT ops_ml_prediction_log_p2026_06_pkey PRIMARY KEY (brand_id, created_at, prediction_id);


--
-- Name: ops_ml_prediction_log_p2026_07 ops_ml_prediction_log_p2026_07_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.ops_ml_prediction_log_p2026_07
    ADD CONSTRAINT ops_ml_prediction_log_p2026_07_pkey PRIMARY KEY (brand_id, created_at, prediction_id);


--
-- Name: ops_ml_prediction_log_pdefault ops_ml_prediction_log_pdefault_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.ops_ml_prediction_log_pdefault
    ADD CONSTRAINT ops_ml_prediction_log_pdefault_pkey PRIMARY KEY (brand_id, created_at, prediction_id);


--
-- Name: restitch_pending restitch_pending_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.restitch_pending
    ADD CONSTRAINT restitch_pending_pkey PRIMARY KEY (brand_id, dirty_kind, dirty_key);


--
-- Name: saved_segment saved_segment_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.saved_segment
    ADD CONSTRAINT saved_segment_pkey PRIMARY KEY (id);


--
-- Name: scoped_recompute_request scoped_recompute_request_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.scoped_recompute_request
    ADD CONSTRAINT scoped_recompute_request_pkey PRIMARY KEY (brand_id, request_id);


--
-- Name: silver_customer_identity silver_customer_identity_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.silver_customer_identity
    ADD CONSTRAINT silver_customer_identity_pkey PRIMARY KEY (brand_id, brain_id);


--
-- Name: silver_identity_link silver_identity_link_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.silver_identity_link
    ADD CONSTRAINT silver_identity_link_pkey PRIMARY KEY (brand_id, identifier_type, identifier_value);


--
-- Name: silver_journey_stitch silver_journey_stitch_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.silver_journey_stitch
    ADD CONSTRAINT silver_journey_stitch_pkey PRIMARY KEY (brand_id, order_id);


--
-- Name: stitch_conflict_review stitch_conflict_review_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.stitch_conflict_review
    ADD CONSTRAINT stitch_conflict_review_pkey PRIMARY KEY (brand_id, review_id);


--
-- Name: pixel_installation pixel_installation_brand_unique; Type: CONSTRAINT; Schema: pixel; Owner: -
--

ALTER TABLE ONLY pixel.pixel_installation
    ADD CONSTRAINT pixel_installation_brand_unique UNIQUE (brand_id);


--
-- Name: pixel_installation pixel_installation_pkey; Type: CONSTRAINT; Schema: pixel; Owner: -
--

ALTER TABLE ONLY pixel.pixel_installation
    ADD CONSTRAINT pixel_installation_pkey PRIMARY KEY (id);


--
-- Name: pixel_status pixel_status_pkey; Type: CONSTRAINT; Schema: pixel; Owner: -
--

ALTER TABLE ONLY pixel.pixel_status
    ADD CONSTRAINT pixel_status_pkey PRIMARY KEY (id);


--
-- Name: dev_secret dev_secret_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dev_secret
    ADD CONSTRAINT dev_secret_pkey PRIMARY KEY (name);


--
-- Name: gold_product_costs gold_product_costs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gold_product_costs
    ADD CONSTRAINT gold_product_costs_pkey PRIMARY KEY (brand_id, product_cost_id);


--
-- Name: gold_product_costs gpc_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gold_product_costs
    ADD CONSTRAINT gpc_no_overlap EXCLUDE USING gist (brand_id WITH =, sku WITH =, currency_code WITH =, daterange(valid_from, valid_to, '[)'::text) WITH &&);


--
-- Name: brand_config_history brand_config_history_pkey; Type: CONSTRAINT; Schema: tenancy; Owner: -
--

ALTER TABLE ONLY tenancy.brand_config_history
    ADD CONSTRAINT brand_config_history_pkey PRIMARY KEY (history_id);


--
-- Name: brand_identity_salt brand_identity_salt_pkey; Type: CONSTRAINT; Schema: tenancy; Owner: -
--

ALTER TABLE ONLY tenancy.brand_identity_salt
    ADD CONSTRAINT brand_identity_salt_pkey PRIMARY KEY (brand_id);


--
-- Name: brand_keyring brand_keyring_pkey; Type: CONSTRAINT; Schema: tenancy; Owner: -
--

ALTER TABLE ONLY tenancy.brand_keyring
    ADD CONSTRAINT brand_keyring_pkey PRIMARY KEY (brand_id);


--
-- Name: brand brand_pkey; Type: CONSTRAINT; Schema: tenancy; Owner: -
--

ALTER TABLE ONLY tenancy.brand
    ADD CONSTRAINT brand_pkey PRIMARY KEY (id);


--
-- Name: organization organization_pkey; Type: CONSTRAINT; Schema: tenancy; Owner: -
--

ALTER TABLE ONLY tenancy.organization
    ADD CONSTRAINT organization_pkey PRIMARY KEY (id);


--
-- Name: organization organization_slug_unique; Type: CONSTRAINT; Schema: tenancy; Owner: -
--

ALTER TABLE ONLY tenancy.organization
    ADD CONSTRAINT organization_slug_unique UNIQUE (slug);


--
-- Name: ref_currency ref_currency_pkey; Type: CONSTRAINT; Schema: tenancy; Owner: -
--

ALTER TABLE ONLY tenancy.ref_currency
    ADD CONSTRAINT ref_currency_pkey PRIMARY KEY (code);


--
-- Name: ref_timezone ref_timezone_pkey; Type: CONSTRAINT; Schema: tenancy; Owner: -
--

ALTER TABLE ONLY tenancy.ref_timezone
    ADD CONSTRAINT ref_timezone_pkey PRIMARY KEY (name);


--
-- Name: subject_keyring subject_keyring_pkey; Type: CONSTRAINT; Schema: tenancy; Owner: -
--

ALTER TABLE ONLY tenancy.subject_keyring
    ADD CONSTRAINT subject_keyring_pkey PRIMARY KEY (brand_id, brain_id);


--
-- Name: idx_ai_provenance_recent; Type: INDEX; Schema: ai_config; Owner: -
--

CREATE INDEX idx_ai_provenance_recent ON ai_config.ai_provenance USING btree (brand_id, created_at DESC);


--
-- Name: recommendation_action_by_action_idx; Type: INDEX; Schema: ai_config; Owner: -
--

CREATE INDEX recommendation_action_by_action_idx ON ai_config.recommendation_action USING btree (brand_id, action, created_at);


--
-- Name: recommendation_action_by_rec_idx; Type: INDEX; Schema: ai_config; Owner: -
--

CREATE INDEX recommendation_action_by_rec_idx ON ai_config.recommendation_action USING btree (brand_id, recommendation_id, created_at DESC);


--
-- Name: recommendation_action_recommendation_id_idx; Type: INDEX; Schema: ai_config; Owner: -
--

CREATE INDEX recommendation_action_recommendation_id_idx ON ai_config.recommendation_action USING btree (recommendation_id);


--
-- Name: audit_log_brand_action_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX audit_log_brand_action_idx ON audit.audit_log USING btree (brand_id, action, created_at DESC);


--
-- Name: audit_log_entity_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX audit_log_entity_idx ON audit.audit_log USING btree (entity_type, entity_id, created_at DESC);


--
-- Name: capi_deletion_log_event_dedup; Type: INDEX; Schema: audit; Owner: -
--

CREATE UNIQUE INDEX capi_deletion_log_event_dedup ON audit.capi_deletion_log USING btree (brand_id, subject_hash, platform, source_event_id) WHERE (source_event_id IS NOT NULL);


--
-- Name: idx_dq_check_result_latest_p; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX idx_dq_check_result_latest_p ON ONLY audit.dq_check_result USING btree (brand_id, category, target, checked_at DESC);


--
-- Name: dq_check_result_p2026_06_brand_id_category_target_checked_a_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX dq_check_result_p2026_06_brand_id_category_target_checked_a_idx ON audit.dq_check_result_p2026_06 USING btree (brand_id, category, target, checked_at DESC);


--
-- Name: dq_check_result_p2026_07_brand_id_category_target_checked_a_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX dq_check_result_p2026_07_brand_id_category_target_checked_a_idx ON audit.dq_check_result_p2026_07 USING btree (brand_id, category, target, checked_at DESC);


--
-- Name: dq_check_result_pdefault_brand_id_category_target_checked_a_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX dq_check_result_pdefault_brand_id_category_target_checked_a_idx ON audit.dq_check_result_pdefault USING btree (brand_id, category, target, checked_at DESC);


--
-- Name: idx_identity_audit_brain_p; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX idx_identity_audit_brain_p ON ONLY audit.identity_audit USING btree (brand_id, brain_id, occurred_at DESC);


--
-- Name: identity_audit_p2026_06_brand_id_brain_id_occurred_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX identity_audit_p2026_06_brand_id_brain_id_occurred_at_idx ON audit.identity_audit_p2026_06 USING btree (brand_id, brain_id, occurred_at DESC);


--
-- Name: identity_audit_pdefault_brand_id_brain_id_occurred_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX identity_audit_pdefault_brand_id_brain_id_occurred_at_idx ON audit.identity_audit_pdefault USING btree (brand_id, brain_id, occurred_at DESC);


--
-- Name: idx_capi_deletion_recent; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX idx_capi_deletion_recent ON audit.capi_deletion_log USING btree (brand_id, requested_at DESC);


--
-- Name: idx_capi_passback_status; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX idx_capi_passback_status ON audit.capi_passback_log USING btree (brand_id, status, recorded_at DESC);


--
-- Name: idx_capi_passback_subject; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX idx_capi_passback_subject ON audit.capi_passback_log USING btree (brand_id, subject_hash);


--
-- Name: idx_send_log_brand_recent_p; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX idx_send_log_brand_recent_p ON ONLY audit.send_log USING btree (brand_id, created_at DESC);


--
-- Name: idx_send_log_pending_window_p; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX idx_send_log_pending_window_p ON ONLY audit.send_log USING btree (brand_id, status, release_after) WHERE (status = 'pending_window'::text);


--
-- Name: send_log_p2026_06_brand_id_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX send_log_p2026_06_brand_id_created_at_idx ON audit.send_log_p2026_06 USING btree (brand_id, created_at DESC);


--
-- Name: send_log_p2026_06_brand_id_status_release_after_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX send_log_p2026_06_brand_id_status_release_after_idx ON audit.send_log_p2026_06 USING btree (brand_id, status, release_after) WHERE (status = 'pending_window'::text);


--
-- Name: send_log_pdefault_brand_id_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX send_log_pdefault_brand_id_created_at_idx ON audit.send_log_pdefault USING btree (brand_id, created_at DESC);


--
-- Name: send_log_pdefault_brand_id_status_release_after_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX send_log_pdefault_brand_id_status_release_after_idx ON audit.send_log_pdefault USING btree (brand_id, status, release_after) WHERE (status = 'pending_window'::text);


--
-- Name: cost_input_active_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX cost_input_active_idx ON billing.cost_input USING btree (brand_id, scope, cost_type) WHERE (effective_to IS NULL);


--
-- Name: idx_credit_note_invoice_id; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX idx_credit_note_invoice_id ON billing.credit_note USING btree (invoice_id) WHERE (invoice_id IS NOT NULL);


--
-- Name: idx_tax_ledger_credit_note_id_p; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX idx_tax_ledger_credit_note_id_p ON ONLY billing.tax_ledger USING btree (credit_note_id) WHERE (credit_note_id IS NOT NULL);


--
-- Name: idx_tax_ledger_invoice_id_p; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX idx_tax_ledger_invoice_id_p ON ONLY billing.tax_ledger USING btree (invoice_id) WHERE (invoice_id IS NOT NULL);


--
-- Name: tax_ledger_p2026_06_credit_note_id_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX tax_ledger_p2026_06_credit_note_id_idx ON billing.tax_ledger_p2026_06 USING btree (credit_note_id) WHERE (credit_note_id IS NOT NULL);


--
-- Name: tax_ledger_p2026_06_invoice_id_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX tax_ledger_p2026_06_invoice_id_idx ON billing.tax_ledger_p2026_06 USING btree (invoice_id) WHERE (invoice_id IS NOT NULL);


--
-- Name: tax_ledger_pdefault_credit_note_id_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX tax_ledger_pdefault_credit_note_id_idx ON billing.tax_ledger_pdefault USING btree (credit_note_id) WHERE (credit_note_id IS NOT NULL);


--
-- Name: tax_ledger_pdefault_invoice_id_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX tax_ledger_pdefault_invoice_id_idx ON billing.tax_ledger_pdefault USING btree (invoice_id) WHERE (invoice_id IS NOT NULL);


--
-- Name: idx_cdlqr_brand_created; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX idx_cdlqr_brand_created ON ONLY connectors.connector_dlq_record USING btree (brand_id, created_at DESC);


--
-- Name: connector_dlq_record_p2026_06_brand_id_created_at_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_dlq_record_p2026_06_brand_id_created_at_idx ON connectors.connector_dlq_record_p2026_06 USING btree (brand_id, created_at DESC);


--
-- Name: idx_cdlqr_brand_error_class; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX idx_cdlqr_brand_error_class ON ONLY connectors.connector_dlq_record USING btree (brand_id, error_class, created_at DESC);


--
-- Name: connector_dlq_record_p2026_06_brand_id_error_class_created__idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_dlq_record_p2026_06_brand_id_error_class_created__idx ON connectors.connector_dlq_record_p2026_06 USING btree (brand_id, error_class, created_at DESC);


--
-- Name: idx_cdlqr_kafka_addr; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX idx_cdlqr_kafka_addr ON ONLY connectors.connector_dlq_record USING btree (source_topic, partition, kafka_offset);


--
-- Name: connector_dlq_record_p2026_06_source_topic_partition_kafka__idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_dlq_record_p2026_06_source_topic_partition_kafka__idx ON connectors.connector_dlq_record_p2026_06 USING btree (source_topic, partition, kafka_offset);


--
-- Name: connector_dlq_record_p2026_07_brand_id_created_at_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_dlq_record_p2026_07_brand_id_created_at_idx ON connectors.connector_dlq_record_p2026_07 USING btree (brand_id, created_at DESC);


--
-- Name: connector_dlq_record_p2026_07_brand_id_error_class_created__idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_dlq_record_p2026_07_brand_id_error_class_created__idx ON connectors.connector_dlq_record_p2026_07 USING btree (brand_id, error_class, created_at DESC);


--
-- Name: connector_dlq_record_p2026_07_source_topic_partition_kafka__idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_dlq_record_p2026_07_source_topic_partition_kafka__idx ON connectors.connector_dlq_record_p2026_07 USING btree (source_topic, partition, kafka_offset);


--
-- Name: connector_dlq_record_p2026_08_brand_id_created_at_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_dlq_record_p2026_08_brand_id_created_at_idx ON connectors.connector_dlq_record_p2026_08 USING btree (brand_id, created_at DESC);


--
-- Name: connector_dlq_record_p2026_08_brand_id_error_class_created__idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_dlq_record_p2026_08_brand_id_error_class_created__idx ON connectors.connector_dlq_record_p2026_08 USING btree (brand_id, error_class, created_at DESC);


--
-- Name: connector_dlq_record_p2026_08_source_topic_partition_kafka__idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_dlq_record_p2026_08_source_topic_partition_kafka__idx ON connectors.connector_dlq_record_p2026_08 USING btree (source_topic, partition, kafka_offset);


--
-- Name: connector_dlq_record_pdefault_brand_id_created_at_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_dlq_record_pdefault_brand_id_created_at_idx ON connectors.connector_dlq_record_pdefault USING btree (brand_id, created_at DESC);


--
-- Name: connector_dlq_record_pdefault_brand_id_error_class_created__idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_dlq_record_pdefault_brand_id_error_class_created__idx ON connectors.connector_dlq_record_pdefault USING btree (brand_id, error_class, created_at DESC);


--
-- Name: connector_dlq_record_pdefault_source_topic_partition_kafka__idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_dlq_record_pdefault_source_topic_partition_kafka__idx ON connectors.connector_dlq_record_pdefault USING btree (source_topic, partition, kafka_offset);


--
-- Name: connector_instance_active_ad_account_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_instance_active_ad_account_idx ON connectors.connector_instance USING btree (brand_id, provider, activated_at);


--
-- Name: connector_instance_ad_account_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_instance_ad_account_idx ON connectors.connector_instance USING btree (ad_account_id) WHERE (ad_account_id IS NOT NULL);


--
-- Name: connector_instance_brand_id_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_instance_brand_id_idx ON connectors.connector_instance USING btree (brand_id);


--
-- Name: connector_instance_due_repull_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_instance_due_repull_idx ON connectors.connector_instance USING btree (next_repull_at) WHERE (status = 'connected'::text);


--
-- Name: connector_instance_gokwik_appid_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_instance_gokwik_appid_idx ON connectors.connector_instance USING btree (gokwik_appid) WHERE (gokwik_appid IS NOT NULL);


--
-- Name: connector_instance_provider_config_gin_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_instance_provider_config_gin_idx ON connectors.connector_instance USING gin (connector_provider_config) WHERE (connector_provider_config IS NOT NULL);


--
-- Name: connector_instance_razorpay_account_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_instance_razorpay_account_idx ON connectors.connector_instance USING btree (razorpay_account_id) WHERE (razorpay_account_id IS NOT NULL);


--
-- Name: connector_instance_shiprocket_channel_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_instance_shiprocket_channel_idx ON connectors.connector_instance USING btree (shiprocket_channel_id) WHERE (shiprocket_channel_id IS NOT NULL);


--
-- Name: connector_instance_shopflo_merchant_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_instance_shopflo_merchant_idx ON connectors.connector_instance USING btree (shopflo_merchant_id) WHERE (shopflo_merchant_id IS NOT NULL);


--
-- Name: connector_instance_woocommerce_site_url_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_instance_woocommerce_site_url_idx ON connectors.connector_instance USING btree (woocommerce_site_url) WHERE (woocommerce_site_url IS NOT NULL);


--
-- Name: connector_journey_stitch_map_anon_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_journey_stitch_map_anon_idx ON connectors.connector_journey_stitch_map USING btree (brand_id, stitched_anon_id);


--
-- Name: connector_razorpay_order_map_order_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_razorpay_order_map_order_idx ON connectors.connector_razorpay_order_map USING btree (brand_id, razorpay_order_id) WHERE (razorpay_order_id IS NOT NULL);


--
-- Name: connector_razorpay_order_map_payment_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_razorpay_order_map_payment_idx ON connectors.connector_razorpay_order_map USING btree (brand_id, razorpay_payment_id);


--
-- Name: connector_sync_run_brand_provider_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_sync_run_brand_provider_idx ON ONLY connectors.connector_sync_run USING btree (brand_id, provider, started_at DESC);


--
-- Name: connector_sync_run_brand_status_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_sync_run_brand_status_idx ON ONLY connectors.connector_sync_run USING btree (brand_id, status, started_at);


--
-- Name: connector_sync_run_p2026_07_brand_id_provider_started_at_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_sync_run_p2026_07_brand_id_provider_started_at_idx ON connectors.connector_sync_run_p2026_07 USING btree (brand_id, provider, started_at DESC);


--
-- Name: connector_sync_run_p2026_07_brand_id_status_started_at_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_sync_run_p2026_07_brand_id_status_started_at_idx ON connectors.connector_sync_run_p2026_07 USING btree (brand_id, status, started_at);


--
-- Name: connector_sync_run_p2026_08_brand_id_provider_started_at_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_sync_run_p2026_08_brand_id_provider_started_at_idx ON connectors.connector_sync_run_p2026_08 USING btree (brand_id, provider, started_at DESC);


--
-- Name: connector_sync_run_p2026_08_brand_id_status_started_at_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_sync_run_p2026_08_brand_id_status_started_at_idx ON connectors.connector_sync_run_p2026_08 USING btree (brand_id, status, started_at);


--
-- Name: connector_sync_run_p2026_09_brand_id_provider_started_at_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_sync_run_p2026_09_brand_id_provider_started_at_idx ON connectors.connector_sync_run_p2026_09 USING btree (brand_id, provider, started_at DESC);


--
-- Name: connector_sync_run_p2026_09_brand_id_status_started_at_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_sync_run_p2026_09_brand_id_status_started_at_idx ON connectors.connector_sync_run_p2026_09 USING btree (brand_id, status, started_at);


--
-- Name: connector_sync_status_brand_connector_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_sync_status_brand_connector_idx ON connectors.connector_sync_status USING btree (brand_id, connector_instance_id);


--
-- Name: connector_webhook_raw_archive_brand_recent_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_webhook_raw_archive_brand_recent_idx ON connectors.connector_webhook_raw_archive_legacy USING btree (brand_id, received_at DESC);


--
-- Name: idx_cwra_brand_recent_p; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX idx_cwra_brand_recent_p ON ONLY connectors.connector_webhook_raw_archive USING btree (brand_id, received_at DESC);


--
-- Name: connector_webhook_raw_archive_p2026_06_brand_id_received_at_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_webhook_raw_archive_p2026_06_brand_id_received_at_idx ON connectors.connector_webhook_raw_archive_p2026_06 USING btree (brand_id, received_at DESC);


--
-- Name: connector_webhook_raw_archive_p2026_07_brand_id_received_at_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_webhook_raw_archive_p2026_07_brand_id_received_at_idx ON connectors.connector_webhook_raw_archive_p2026_07 USING btree (brand_id, received_at DESC);


--
-- Name: connector_webhook_raw_archive_p2026_08_brand_id_received_at_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_webhook_raw_archive_p2026_08_brand_id_received_at_idx ON connectors.connector_webhook_raw_archive_p2026_08 USING btree (brand_id, received_at DESC);


--
-- Name: connector_webhook_raw_archive_pdefault_brand_id_received_at_idx; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX connector_webhook_raw_archive_pdefault_brand_id_received_at_idx ON connectors.connector_webhook_raw_archive_pdefault USING btree (brand_id, received_at DESC);


--
-- Name: idx_connector_cursor_instance; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX idx_connector_cursor_instance ON connectors.connector_cursor USING btree (connector_instance_id);


--
-- Name: idx_connector_sync_status_instance; Type: INDEX; Schema: connectors; Owner: -
--

CREATE INDEX idx_connector_sync_status_instance ON connectors.connector_sync_status USING btree (connector_instance_id);


--
-- Name: consent_record_event_dedup; Type: INDEX; Schema: consent; Owner: -
--

CREATE UNIQUE INDEX consent_record_event_dedup ON consent.consent_record USING btree (brand_id, subject_hash, category, source_event_id) WHERE (source_event_id IS NOT NULL);


--
-- Name: consent_tombstone_event_dedup; Type: INDEX; Schema: consent; Owner: -
--

CREATE UNIQUE INDEX consent_tombstone_event_dedup ON consent.consent_tombstone USING btree (brand_id, subject_hash, COALESCE(category, '*'::text), source_event_id) WHERE (source_event_id IS NOT NULL);


--
-- Name: idx_consent_record_latest; Type: INDEX; Schema: consent; Owner: -
--

CREATE INDEX idx_consent_record_latest ON consent.consent_record USING btree (brand_id, subject_hash, category, effective_at DESC);


--
-- Name: idx_consent_tombstone_subject; Type: INDEX; Schema: consent; Owner: -
--

CREATE INDEX idx_consent_tombstone_subject ON consent.consent_tombstone USING btree (brand_id, subject_hash);


--
-- Name: idx_collector_spool_drained; Type: INDEX; Schema: data_plane; Owner: -
--

CREATE INDEX idx_collector_spool_drained ON data_plane.collector_spool USING btree (drained_at) WHERE (status = 'drained'::text);


--
-- Name: idx_collector_spool_pending; Type: INDEX; Schema: data_plane; Owner: -
--

CREATE INDEX idx_collector_spool_pending ON data_plane.collector_spool USING btree (id) WHERE (status = 'pending'::text);


--
-- Name: app_user_email_normalized_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX app_user_email_normalized_idx ON iam.app_user USING btree (email_normalized);


--
-- Name: email_verification_app_user_id_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX email_verification_app_user_id_idx ON iam.email_verification USING btree (app_user_id);


--
-- Name: email_verification_token_hash_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX email_verification_token_hash_idx ON iam.email_verification USING btree (token_hash);


--
-- Name: idx_invite_invited_by_user_id; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX idx_invite_invited_by_user_id ON iam.invite USING btree (invited_by_user_id) WHERE (invited_by_user_id IS NOT NULL);


--
-- Name: idx_user_session_rotated_from; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX idx_user_session_rotated_from ON iam.user_session USING btree (rotated_from) WHERE (rotated_from IS NOT NULL);


--
-- Name: invite_brand_id_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX invite_brand_id_idx ON iam.invite USING btree (brand_id) WHERE (brand_id IS NOT NULL);


--
-- Name: invite_email_org_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX invite_email_org_idx ON iam.invite USING btree (email, organization_id);


--
-- Name: invite_organization_id_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX invite_organization_id_idx ON iam.invite USING btree (organization_id);


--
-- Name: invite_pending_brand_email_uniq; Type: INDEX; Schema: iam; Owner: -
--

CREATE UNIQUE INDEX invite_pending_brand_email_uniq ON iam.invite USING btree (brand_id, email) WHERE ((status = 'pending'::text) AND (brand_id IS NOT NULL));


--
-- Name: invite_pending_org_email_uniq; Type: INDEX; Schema: iam; Owner: -
--

CREATE UNIQUE INDEX invite_pending_org_email_uniq ON iam.invite USING btree (organization_id, email) WHERE ((status = 'pending'::text) AND (brand_id IS NULL));


--
-- Name: invite_status_org_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX invite_status_org_idx ON iam.invite USING btree (organization_id, status) WHERE (status = 'pending'::text);


--
-- Name: invite_token_hash_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX invite_token_hash_idx ON iam.invite USING btree (token_hash);


--
-- Name: membership_app_user_id_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX membership_app_user_id_idx ON iam.membership USING btree (app_user_id);


--
-- Name: membership_brand_id_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX membership_brand_id_idx ON iam.membership USING btree (brand_id) WHERE (brand_id IS NOT NULL);


--
-- Name: membership_org_brand_user_uniq; Type: INDEX; Schema: iam; Owner: -
--

CREATE UNIQUE INDEX membership_org_brand_user_uniq ON iam.membership USING btree (organization_id, brand_id, app_user_id) WHERE (brand_id IS NOT NULL);


--
-- Name: membership_org_user_uniq; Type: INDEX; Schema: iam; Owner: -
--

CREATE UNIQUE INDEX membership_org_user_uniq ON iam.membership USING btree (organization_id, app_user_id) WHERE (brand_id IS NULL);


--
-- Name: membership_organization_id_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX membership_organization_id_idx ON iam.membership USING btree (organization_id);


--
-- Name: password_reset_app_user_id_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX password_reset_app_user_id_idx ON iam.password_reset USING btree (app_user_id);


--
-- Name: password_reset_token_hash_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX password_reset_token_hash_idx ON iam.password_reset USING btree (token_hash);


--
-- Name: user_session_active_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX user_session_active_idx ON iam.user_session USING btree (app_user_id) WHERE (revoked_at IS NULL);


--
-- Name: user_session_app_user_id_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX user_session_app_user_id_idx ON iam.user_session USING btree (app_user_id);


--
-- Name: user_session_family_id_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX user_session_family_id_idx ON iam.user_session USING btree (family_id) WHERE (revoked_at IS NULL);


--
-- Name: user_session_jti_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX user_session_jti_idx ON iam.user_session USING btree (jti);


--
-- Name: user_session_refresh_hash_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX user_session_refresh_hash_idx ON iam.user_session USING btree (refresh_token_hash);


--
-- Name: backfill_job_active_idx; Type: INDEX; Schema: jobs; Owner: -
--

CREATE INDEX backfill_job_active_idx ON jobs.backfill_job USING btree (connector_instance_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: backfill_job_brand_connector_idx; Type: INDEX; Schema: jobs; Owner: -
--

CREATE INDEX backfill_job_brand_connector_idx ON jobs.backfill_job USING btree (brand_id, connector_instance_id);


--
-- Name: backfill_job_queued_idx; Type: INDEX; Schema: jobs; Owner: -
--

CREATE INDEX backfill_job_queued_idx ON jobs.backfill_job USING btree (created_at) WHERE (status = 'queued'::text);


--
-- Name: resource_backfill_state_brand_connector_idx; Type: INDEX; Schema: jobs; Owner: -
--

CREATE INDEX resource_backfill_state_brand_connector_idx ON jobs.resource_backfill_state USING btree (brand_id, connector_instance_id);


--
-- Name: resource_backfill_state_resumable_idx; Type: INDEX; Schema: jobs; Owner: -
--

CREATE INDEX resource_backfill_state_resumable_idx ON jobs.resource_backfill_state USING btree (connector_instance_id, resource) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text, 'paused'::text, 'failed'::text]));


--
-- Name: idx_model_registry_brand_stage; Type: INDEX; Schema: ml; Owner: -
--

CREATE INDEX idx_model_registry_brand_stage ON ml.model_registry USING btree (brand_id, stage);


--
-- Name: model_registry_one_production; Type: INDEX; Schema: ml; Owner: -
--

CREATE UNIQUE INDEX model_registry_one_production ON ml.model_registry USING btree (brand_id, name) WHERE (stage = 'production'::text);


--
-- Name: idx_journey_reversion_pending_brand; Type: INDEX; Schema: ops; Owner: -
--

CREATE INDEX idx_journey_reversion_pending_brand ON ops.journey_reversion_pending USING btree (brand_id);


--
-- Name: idx_ops_ml_prediction_log_subject; Type: INDEX; Schema: ops; Owner: -
--

CREATE INDEX idx_ops_ml_prediction_log_subject ON ONLY ops.ops_ml_prediction_log USING btree (brand_id, subject_type, subject_key);


--
-- Name: idx_restitch_pending_brand; Type: INDEX; Schema: ops; Owner: -
--

CREATE INDEX idx_restitch_pending_brand ON ops.restitch_pending USING btree (brand_id, dirty_kind);


--
-- Name: idx_scoped_recompute_request_unprocessed; Type: INDEX; Schema: ops; Owner: -
--

CREATE INDEX idx_scoped_recompute_request_unprocessed ON ops.scoped_recompute_request USING btree (brand_id, requested_at) WHERE (processed_at IS NULL);


--
-- Name: ops_ml_prediction_log_p2026_0_brand_id_subject_type_subjec_idx1; Type: INDEX; Schema: ops; Owner: -
--

CREATE INDEX ops_ml_prediction_log_p2026_0_brand_id_subject_type_subjec_idx1 ON ops.ops_ml_prediction_log_p2026_06 USING btree (brand_id, subject_type, subject_key);


--
-- Name: ops_ml_prediction_log_p2026_0_brand_id_subject_type_subjec_idx2; Type: INDEX; Schema: ops; Owner: -
--

CREATE INDEX ops_ml_prediction_log_p2026_0_brand_id_subject_type_subjec_idx2 ON ops.ops_ml_prediction_log_p2026_07 USING btree (brand_id, subject_type, subject_key);


--
-- Name: ops_ml_prediction_log_p2026_0_brand_id_subject_type_subject_idx; Type: INDEX; Schema: ops; Owner: -
--

CREATE INDEX ops_ml_prediction_log_p2026_0_brand_id_subject_type_subject_idx ON ops.ops_ml_prediction_log_p2026_05 USING btree (brand_id, subject_type, subject_key);


--
-- Name: ops_ml_prediction_log_pdefaul_brand_id_subject_type_subject_idx; Type: INDEX; Schema: ops; Owner: -
--

CREATE INDEX ops_ml_prediction_log_pdefaul_brand_id_subject_type_subject_idx ON ops.ops_ml_prediction_log_pdefault USING btree (brand_id, subject_type, subject_key);


--
-- Name: saved_segment_brand_idx; Type: INDEX; Schema: ops; Owner: -
--

CREATE INDEX saved_segment_brand_idx ON ops.saved_segment USING btree (brand_id, created_at DESC);


--
-- Name: stitch_conflict_review_pending_idx; Type: INDEX; Schema: ops; Owner: -
--

CREATE INDEX stitch_conflict_review_pending_idx ON ops.stitch_conflict_review USING btree (brand_id, status, detected_at DESC);


--
-- Name: pixel_installation_brand_id_idx; Type: INDEX; Schema: pixel; Owner: -
--

CREATE INDEX pixel_installation_brand_id_idx ON pixel.pixel_installation USING btree (brand_id);


--
-- Name: pixel_status_brand_id_idx; Type: INDEX; Schema: pixel; Owner: -
--

CREATE INDEX pixel_status_brand_id_idx ON pixel.pixel_status USING btree (brand_id);


--
-- Name: pixel_status_pixel_installation_id_idx; Type: INDEX; Schema: pixel; Owner: -
--

CREATE INDEX pixel_status_pixel_installation_id_idx ON pixel.pixel_status USING btree (pixel_installation_id);


--
-- Name: gold_product_costs_asof_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gold_product_costs_asof_idx ON public.gold_product_costs USING btree (brand_id, sku, currency_code, valid_from);


--
-- Name: brand_config_history_brand_id_idx; Type: INDEX; Schema: tenancy; Owner: -
--

CREATE INDEX brand_config_history_brand_id_idx ON tenancy.brand_config_history USING btree (brand_id);


--
-- Name: brand_config_history_one_open_idx; Type: INDEX; Schema: tenancy; Owner: -
--

CREATE UNIQUE INDEX brand_config_history_one_open_idx ON tenancy.brand_config_history USING btree (brand_id, config_key) WHERE (valid_to IS NULL);


--
-- Name: brand_config_history_pit_idx; Type: INDEX; Schema: tenancy; Owner: -
--

CREATE INDEX brand_config_history_pit_idx ON tenancy.brand_config_history USING btree (brand_id, config_key, valid_from DESC);


--
-- Name: brand_currency_code_idx; Type: INDEX; Schema: tenancy; Owner: -
--

CREATE INDEX brand_currency_code_idx ON tenancy.brand USING btree (currency_code);


--
-- Name: brand_organization_id_idx; Type: INDEX; Schema: tenancy; Owner: -
--

CREATE INDEX brand_organization_id_idx ON tenancy.brand USING btree (organization_id);


--
-- Name: brand_timezone_idx; Type: INDEX; Schema: tenancy; Owner: -
--

CREATE INDEX brand_timezone_idx ON tenancy.brand USING btree (timezone);


--
-- Name: organization_owner_user_id_idx; Type: INDEX; Schema: tenancy; Owner: -
--

CREATE INDEX organization_owner_user_id_idx ON tenancy.organization USING btree (owner_user_id);


--
-- Name: decision_log_p2026_06_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.decision_log_part_pkey ATTACH PARTITION audit.decision_log_p2026_06_pkey;


--
-- Name: decision_log_p2026_07_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.decision_log_part_pkey ATTACH PARTITION audit.decision_log_p2026_07_pkey;


--
-- Name: decision_log_pdefault_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.decision_log_part_pkey ATTACH PARTITION audit.decision_log_pdefault_pkey;


--
-- Name: dq_check_result_p2026_06_brand_id_category_target_checked_a_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_dq_check_result_latest_p ATTACH PARTITION audit.dq_check_result_p2026_06_brand_id_category_target_checked_a_idx;


--
-- Name: dq_check_result_p2026_06_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.dq_check_result_part_pkey ATTACH PARTITION audit.dq_check_result_p2026_06_pkey;


--
-- Name: dq_check_result_p2026_07_brand_id_category_target_checked_a_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_dq_check_result_latest_p ATTACH PARTITION audit.dq_check_result_p2026_07_brand_id_category_target_checked_a_idx;


--
-- Name: dq_check_result_p2026_07_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.dq_check_result_part_pkey ATTACH PARTITION audit.dq_check_result_p2026_07_pkey;


--
-- Name: dq_check_result_pdefault_brand_id_category_target_checked_a_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_dq_check_result_latest_p ATTACH PARTITION audit.dq_check_result_pdefault_brand_id_category_target_checked_a_idx;


--
-- Name: dq_check_result_pdefault_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.dq_check_result_part_pkey ATTACH PARTITION audit.dq_check_result_pdefault_pkey;


--
-- Name: identity_audit_p2026_06_brand_id_brain_id_occurred_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_identity_audit_brain_p ATTACH PARTITION audit.identity_audit_p2026_06_brand_id_brain_id_occurred_at_idx;


--
-- Name: identity_audit_p2026_06_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.identity_audit_part_pkey ATTACH PARTITION audit.identity_audit_p2026_06_pkey;


--
-- Name: identity_audit_pdefault_brand_id_brain_id_occurred_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_identity_audit_brain_p ATTACH PARTITION audit.identity_audit_pdefault_brand_id_brain_id_occurred_at_idx;


--
-- Name: identity_audit_pdefault_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.identity_audit_part_pkey ATTACH PARTITION audit.identity_audit_pdefault_pkey;


--
-- Name: send_log_p2026_06_brand_id_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_send_log_brand_recent_p ATTACH PARTITION audit.send_log_p2026_06_brand_id_created_at_idx;


--
-- Name: send_log_p2026_06_brand_id_status_release_after_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_send_log_pending_window_p ATTACH PARTITION audit.send_log_p2026_06_brand_id_status_release_after_idx;


--
-- Name: send_log_p2026_06_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.send_log_part_pkey ATTACH PARTITION audit.send_log_p2026_06_pkey;


--
-- Name: send_log_pdefault_brand_id_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_send_log_brand_recent_p ATTACH PARTITION audit.send_log_pdefault_brand_id_created_at_idx;


--
-- Name: send_log_pdefault_brand_id_status_release_after_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_send_log_pending_window_p ATTACH PARTITION audit.send_log_pdefault_brand_id_status_release_after_idx;


--
-- Name: send_log_pdefault_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.send_log_part_pkey ATTACH PARTITION audit.send_log_pdefault_pkey;


--
-- Name: tax_ledger_p2026_06_credit_note_id_idx; Type: INDEX ATTACH; Schema: billing; Owner: -
--

ALTER INDEX billing.idx_tax_ledger_credit_note_id_p ATTACH PARTITION billing.tax_ledger_p2026_06_credit_note_id_idx;


--
-- Name: tax_ledger_p2026_06_invoice_id_idx; Type: INDEX ATTACH; Schema: billing; Owner: -
--

ALTER INDEX billing.idx_tax_ledger_invoice_id_p ATTACH PARTITION billing.tax_ledger_p2026_06_invoice_id_idx;


--
-- Name: tax_ledger_p2026_06_pkey; Type: INDEX ATTACH; Schema: billing; Owner: -
--

ALTER INDEX billing.tax_ledger_part_pkey ATTACH PARTITION billing.tax_ledger_p2026_06_pkey;


--
-- Name: tax_ledger_pdefault_credit_note_id_idx; Type: INDEX ATTACH; Schema: billing; Owner: -
--

ALTER INDEX billing.idx_tax_ledger_credit_note_id_p ATTACH PARTITION billing.tax_ledger_pdefault_credit_note_id_idx;


--
-- Name: tax_ledger_pdefault_invoice_id_idx; Type: INDEX ATTACH; Schema: billing; Owner: -
--

ALTER INDEX billing.idx_tax_ledger_invoice_id_p ATTACH PARTITION billing.tax_ledger_pdefault_invoice_id_idx;


--
-- Name: tax_ledger_pdefault_pkey; Type: INDEX ATTACH; Schema: billing; Owner: -
--

ALTER INDEX billing.tax_ledger_part_pkey ATTACH PARTITION billing.tax_ledger_pdefault_pkey;


--
-- Name: connector_dlq_record_p2026_06_brand_id_created_at_idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.idx_cdlqr_brand_created ATTACH PARTITION connectors.connector_dlq_record_p2026_06_brand_id_created_at_idx;


--
-- Name: connector_dlq_record_p2026_06_brand_id_error_class_created__idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.idx_cdlqr_brand_error_class ATTACH PARTITION connectors.connector_dlq_record_p2026_06_brand_id_error_class_created__idx;


--
-- Name: connector_dlq_record_p2026_06_pkey; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_dlq_record_pkey ATTACH PARTITION connectors.connector_dlq_record_p2026_06_pkey;


--
-- Name: connector_dlq_record_p2026_06_source_topic_partition_kafka__idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.idx_cdlqr_kafka_addr ATTACH PARTITION connectors.connector_dlq_record_p2026_06_source_topic_partition_kafka__idx;


--
-- Name: connector_dlq_record_p2026_07_brand_id_created_at_idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.idx_cdlqr_brand_created ATTACH PARTITION connectors.connector_dlq_record_p2026_07_brand_id_created_at_idx;


--
-- Name: connector_dlq_record_p2026_07_brand_id_error_class_created__idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.idx_cdlqr_brand_error_class ATTACH PARTITION connectors.connector_dlq_record_p2026_07_brand_id_error_class_created__idx;


--
-- Name: connector_dlq_record_p2026_07_pkey; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_dlq_record_pkey ATTACH PARTITION connectors.connector_dlq_record_p2026_07_pkey;


--
-- Name: connector_dlq_record_p2026_07_source_topic_partition_kafka__idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.idx_cdlqr_kafka_addr ATTACH PARTITION connectors.connector_dlq_record_p2026_07_source_topic_partition_kafka__idx;


--
-- Name: connector_dlq_record_p2026_08_brand_id_created_at_idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.idx_cdlqr_brand_created ATTACH PARTITION connectors.connector_dlq_record_p2026_08_brand_id_created_at_idx;


--
-- Name: connector_dlq_record_p2026_08_brand_id_error_class_created__idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.idx_cdlqr_brand_error_class ATTACH PARTITION connectors.connector_dlq_record_p2026_08_brand_id_error_class_created__idx;


--
-- Name: connector_dlq_record_p2026_08_pkey; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_dlq_record_pkey ATTACH PARTITION connectors.connector_dlq_record_p2026_08_pkey;


--
-- Name: connector_dlq_record_p2026_08_source_topic_partition_kafka__idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.idx_cdlqr_kafka_addr ATTACH PARTITION connectors.connector_dlq_record_p2026_08_source_topic_partition_kafka__idx;


--
-- Name: connector_dlq_record_pdefault_brand_id_created_at_idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.idx_cdlqr_brand_created ATTACH PARTITION connectors.connector_dlq_record_pdefault_brand_id_created_at_idx;


--
-- Name: connector_dlq_record_pdefault_brand_id_error_class_created__idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.idx_cdlqr_brand_error_class ATTACH PARTITION connectors.connector_dlq_record_pdefault_brand_id_error_class_created__idx;


--
-- Name: connector_dlq_record_pdefault_pkey; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_dlq_record_pkey ATTACH PARTITION connectors.connector_dlq_record_pdefault_pkey;


--
-- Name: connector_dlq_record_pdefault_source_topic_partition_kafka__idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.idx_cdlqr_kafka_addr ATTACH PARTITION connectors.connector_dlq_record_pdefault_source_topic_partition_kafka__idx;


--
-- Name: connector_sync_run_p2026_07_brand_id_provider_started_at_idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_sync_run_brand_provider_idx ATTACH PARTITION connectors.connector_sync_run_p2026_07_brand_id_provider_started_at_idx;


--
-- Name: connector_sync_run_p2026_07_brand_id_status_started_at_idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_sync_run_brand_status_idx ATTACH PARTITION connectors.connector_sync_run_p2026_07_brand_id_status_started_at_idx;


--
-- Name: connector_sync_run_p2026_07_pkey; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_sync_run_pkey ATTACH PARTITION connectors.connector_sync_run_p2026_07_pkey;


--
-- Name: connector_sync_run_p2026_08_brand_id_provider_started_at_idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_sync_run_brand_provider_idx ATTACH PARTITION connectors.connector_sync_run_p2026_08_brand_id_provider_started_at_idx;


--
-- Name: connector_sync_run_p2026_08_brand_id_status_started_at_idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_sync_run_brand_status_idx ATTACH PARTITION connectors.connector_sync_run_p2026_08_brand_id_status_started_at_idx;


--
-- Name: connector_sync_run_p2026_08_pkey; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_sync_run_pkey ATTACH PARTITION connectors.connector_sync_run_p2026_08_pkey;


--
-- Name: connector_sync_run_p2026_09_brand_id_provider_started_at_idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_sync_run_brand_provider_idx ATTACH PARTITION connectors.connector_sync_run_p2026_09_brand_id_provider_started_at_idx;


--
-- Name: connector_sync_run_p2026_09_brand_id_status_started_at_idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_sync_run_brand_status_idx ATTACH PARTITION connectors.connector_sync_run_p2026_09_brand_id_status_started_at_idx;


--
-- Name: connector_sync_run_p2026_09_pkey; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_sync_run_pkey ATTACH PARTITION connectors.connector_sync_run_p2026_09_pkey;


--
-- Name: connector_webhook_raw_archive_brand_id_topic_body_sha256_r_key1; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_webhook_raw_archive_dedup_p ATTACH PARTITION connectors.connector_webhook_raw_archive_brand_id_topic_body_sha256_r_key1;


--
-- Name: connector_webhook_raw_archive_brand_id_topic_body_sha256_r_key2; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_webhook_raw_archive_dedup_p ATTACH PARTITION connectors.connector_webhook_raw_archive_brand_id_topic_body_sha256_r_key2;


--
-- Name: connector_webhook_raw_archive_brand_id_topic_body_sha256_r_key3; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_webhook_raw_archive_dedup_p ATTACH PARTITION connectors.connector_webhook_raw_archive_brand_id_topic_body_sha256_r_key3;


--
-- Name: connector_webhook_raw_archive_brand_id_topic_body_sha256_re_key; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_webhook_raw_archive_dedup_p ATTACH PARTITION connectors.connector_webhook_raw_archive_brand_id_topic_body_sha256_re_key;


--
-- Name: connector_webhook_raw_archive_p2026_06_brand_id_received_at_idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.idx_cwra_brand_recent_p ATTACH PARTITION connectors.connector_webhook_raw_archive_p2026_06_brand_id_received_at_idx;


--
-- Name: connector_webhook_raw_archive_p2026_06_pkey; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_webhook_raw_archive_part_pkey ATTACH PARTITION connectors.connector_webhook_raw_archive_p2026_06_pkey;


--
-- Name: connector_webhook_raw_archive_p2026_07_brand_id_received_at_idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.idx_cwra_brand_recent_p ATTACH PARTITION connectors.connector_webhook_raw_archive_p2026_07_brand_id_received_at_idx;


--
-- Name: connector_webhook_raw_archive_p2026_07_pkey; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_webhook_raw_archive_part_pkey ATTACH PARTITION connectors.connector_webhook_raw_archive_p2026_07_pkey;


--
-- Name: connector_webhook_raw_archive_p2026_08_brand_id_received_at_idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.idx_cwra_brand_recent_p ATTACH PARTITION connectors.connector_webhook_raw_archive_p2026_08_brand_id_received_at_idx;


--
-- Name: connector_webhook_raw_archive_p2026_08_pkey; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_webhook_raw_archive_part_pkey ATTACH PARTITION connectors.connector_webhook_raw_archive_p2026_08_pkey;


--
-- Name: connector_webhook_raw_archive_pdefault_brand_id_received_at_idx; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.idx_cwra_brand_recent_p ATTACH PARTITION connectors.connector_webhook_raw_archive_pdefault_brand_id_received_at_idx;


--
-- Name: connector_webhook_raw_archive_pdefault_pkey; Type: INDEX ATTACH; Schema: connectors; Owner: -
--

ALTER INDEX connectors.connector_webhook_raw_archive_part_pkey ATTACH PARTITION connectors.connector_webhook_raw_archive_pdefault_pkey;


--
-- Name: ops_ml_prediction_log_p2026_05_pkey; Type: INDEX ATTACH; Schema: ops; Owner: -
--

ALTER INDEX ops.ops_ml_prediction_log_pkey ATTACH PARTITION ops.ops_ml_prediction_log_p2026_05_pkey;


--
-- Name: ops_ml_prediction_log_p2026_06_pkey; Type: INDEX ATTACH; Schema: ops; Owner: -
--

ALTER INDEX ops.ops_ml_prediction_log_pkey ATTACH PARTITION ops.ops_ml_prediction_log_p2026_06_pkey;


--
-- Name: ops_ml_prediction_log_p2026_07_pkey; Type: INDEX ATTACH; Schema: ops; Owner: -
--

ALTER INDEX ops.ops_ml_prediction_log_pkey ATTACH PARTITION ops.ops_ml_prediction_log_p2026_07_pkey;


--
-- Name: ops_ml_prediction_log_p2026_0_brand_id_subject_type_subjec_idx1; Type: INDEX ATTACH; Schema: ops; Owner: -
--

ALTER INDEX ops.idx_ops_ml_prediction_log_subject ATTACH PARTITION ops.ops_ml_prediction_log_p2026_0_brand_id_subject_type_subjec_idx1;


--
-- Name: ops_ml_prediction_log_p2026_0_brand_id_subject_type_subjec_idx2; Type: INDEX ATTACH; Schema: ops; Owner: -
--

ALTER INDEX ops.idx_ops_ml_prediction_log_subject ATTACH PARTITION ops.ops_ml_prediction_log_p2026_0_brand_id_subject_type_subjec_idx2;


--
-- Name: ops_ml_prediction_log_p2026_0_brand_id_subject_type_subject_idx; Type: INDEX ATTACH; Schema: ops; Owner: -
--

ALTER INDEX ops.idx_ops_ml_prediction_log_subject ATTACH PARTITION ops.ops_ml_prediction_log_p2026_0_brand_id_subject_type_subject_idx;


--
-- Name: ops_ml_prediction_log_pdefaul_brand_id_subject_type_subject_idx; Type: INDEX ATTACH; Schema: ops; Owner: -
--

ALTER INDEX ops.idx_ops_ml_prediction_log_subject ATTACH PARTITION ops.ops_ml_prediction_log_pdefaul_brand_id_subject_type_subject_idx;


--
-- Name: ops_ml_prediction_log_pdefault_pkey; Type: INDEX ATTACH; Schema: ops; Owner: -
--

ALTER INDEX ops.ops_ml_prediction_log_pkey ATTACH PARTITION ops.ops_ml_prediction_log_pdefault_pkey;


--
-- Name: brand brand_config_history_capture; Type: TRIGGER; Schema: tenancy; Owner: -
--

CREATE TRIGGER brand_config_history_capture AFTER INSERT OR UPDATE OF revenue_definition, cod_recognition_horizon_days, prepaid_recognition_horizon_days ON tenancy.brand FOR EACH ROW EXECUTE FUNCTION tenancy.capture_brand_config_history();


--
-- Name: recommendation_action recommendation_action_recommendation_id_fkey; Type: FK CONSTRAINT; Schema: ai_config; Owner: -
--

ALTER TABLE ONLY ai_config.recommendation_action
    ADD CONSTRAINT recommendation_action_recommendation_id_fkey FOREIGN KEY (recommendation_id) REFERENCES ai_config.recommendation(recommendation_id);


--
-- Name: recommendation_outcome recommendation_outcome_recommendation_id_fkey; Type: FK CONSTRAINT; Schema: ai_config; Owner: -
--

ALTER TABLE ONLY ai_config.recommendation_outcome
    ADD CONSTRAINT recommendation_outcome_recommendation_id_fkey FOREIGN KEY (recommendation_id) REFERENCES ai_config.recommendation(recommendation_id);


--
-- Name: credit_note credit_note_invoice_id_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.credit_note
    ADD CONSTRAINT credit_note_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES billing.invoice(invoice_id);


--
-- Name: invoice_line invoice_line_invoice_id_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.invoice_line
    ADD CONSTRAINT invoice_line_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES billing.invoice(invoice_id);


--
-- Name: tax_ledger tax_ledger_credit_note_fk; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE billing.tax_ledger
    ADD CONSTRAINT tax_ledger_credit_note_fk FOREIGN KEY (credit_note_id) REFERENCES billing.credit_note(credit_note_id);


--
-- Name: tax_ledger tax_ledger_invoice_id_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE billing.tax_ledger
    ADD CONSTRAINT tax_ledger_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES billing.invoice(invoice_id);


--
-- Name: connector_cursor connector_cursor_brand_id_fkey; Type: FK CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_cursor
    ADD CONSTRAINT connector_cursor_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES tenancy.brand(id);


--
-- Name: connector_cursor connector_cursor_connector_instance_id_fkey; Type: FK CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_cursor
    ADD CONSTRAINT connector_cursor_connector_instance_id_fkey FOREIGN KEY (connector_instance_id) REFERENCES connectors.connector_instance(id);


--
-- Name: connector_instance connector_instance_brand_id_fkey; Type: FK CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_instance
    ADD CONSTRAINT connector_instance_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES tenancy.brand(id);


--
-- Name: connector_sync_status connector_sync_status_brand_id_fkey; Type: FK CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_sync_status
    ADD CONSTRAINT connector_sync_status_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES tenancy.brand(id);


--
-- Name: connector_sync_status connector_sync_status_connector_instance_id_fkey; Type: FK CONSTRAINT; Schema: connectors; Owner: -
--

ALTER TABLE ONLY connectors.connector_sync_status
    ADD CONSTRAINT connector_sync_status_connector_instance_id_fkey FOREIGN KEY (connector_instance_id) REFERENCES connectors.connector_instance(id);


--
-- Name: email_verification email_verification_app_user_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.email_verification
    ADD CONSTRAINT email_verification_app_user_id_fkey FOREIGN KEY (app_user_id) REFERENCES iam.app_user(id);


--
-- Name: invite invite_brand_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.invite
    ADD CONSTRAINT invite_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES tenancy.brand(id);


--
-- Name: invite invite_invited_by_user_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.invite
    ADD CONSTRAINT invite_invited_by_user_id_fkey FOREIGN KEY (invited_by_user_id) REFERENCES iam.app_user(id);


--
-- Name: invite invite_organization_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.invite
    ADD CONSTRAINT invite_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES tenancy.organization(id);


--
-- Name: membership membership_app_user_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.membership
    ADD CONSTRAINT membership_app_user_id_fkey FOREIGN KEY (app_user_id) REFERENCES iam.app_user(id);


--
-- Name: membership membership_brand_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.membership
    ADD CONSTRAINT membership_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES tenancy.brand(id);


--
-- Name: membership membership_organization_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.membership
    ADD CONSTRAINT membership_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES tenancy.organization(id);


--
-- Name: password_reset password_reset_app_user_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.password_reset
    ADD CONSTRAINT password_reset_app_user_id_fkey FOREIGN KEY (app_user_id) REFERENCES iam.app_user(id);


--
-- Name: user_session user_session_app_user_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.user_session
    ADD CONSTRAINT user_session_app_user_id_fkey FOREIGN KEY (app_user_id) REFERENCES iam.app_user(id);


--
-- Name: user_session user_session_rotated_from_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.user_session
    ADD CONSTRAINT user_session_rotated_from_fkey FOREIGN KEY (rotated_from) REFERENCES iam.user_session(id);


--
-- Name: backfill_job backfill_job_brand_id_fkey; Type: FK CONSTRAINT; Schema: jobs; Owner: -
--

ALTER TABLE ONLY jobs.backfill_job
    ADD CONSTRAINT backfill_job_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES tenancy.brand(id);


--
-- Name: backfill_job backfill_job_connector_instance_id_fkey; Type: FK CONSTRAINT; Schema: jobs; Owner: -
--

ALTER TABLE ONLY jobs.backfill_job
    ADD CONSTRAINT backfill_job_connector_instance_id_fkey FOREIGN KEY (connector_instance_id) REFERENCES connectors.connector_instance(id);


--
-- Name: resource_backfill_state resource_backfill_state_brand_id_fkey; Type: FK CONSTRAINT; Schema: jobs; Owner: -
--

ALTER TABLE ONLY jobs.resource_backfill_state
    ADD CONSTRAINT resource_backfill_state_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES tenancy.brand(id);


--
-- Name: resource_backfill_state resource_backfill_state_connector_instance_id_fkey; Type: FK CONSTRAINT; Schema: jobs; Owner: -
--

ALTER TABLE ONLY jobs.resource_backfill_state
    ADD CONSTRAINT resource_backfill_state_connector_instance_id_fkey FOREIGN KEY (connector_instance_id) REFERENCES connectors.connector_instance(id);


--
-- Name: brand_identity_priority brand_identity_priority_brand_id_fkey; Type: FK CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.brand_identity_priority
    ADD CONSTRAINT brand_identity_priority_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES tenancy.brand(id);


--
-- Name: saved_segment saved_segment_brand_id_fkey; Type: FK CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.saved_segment
    ADD CONSTRAINT saved_segment_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES tenancy.brand(id);


--
-- Name: saved_segment saved_segment_created_by_fkey; Type: FK CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.saved_segment
    ADD CONSTRAINT saved_segment_created_by_fkey FOREIGN KEY (created_by) REFERENCES iam.app_user(id);


--
-- Name: pixel_installation pixel_installation_brand_id_fkey; Type: FK CONSTRAINT; Schema: pixel; Owner: -
--

ALTER TABLE ONLY pixel.pixel_installation
    ADD CONSTRAINT pixel_installation_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES tenancy.brand(id);


--
-- Name: pixel_status pixel_status_brand_id_fkey; Type: FK CONSTRAINT; Schema: pixel; Owner: -
--

ALTER TABLE ONLY pixel.pixel_status
    ADD CONSTRAINT pixel_status_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES tenancy.brand(id);


--
-- Name: pixel_status pixel_status_pixel_installation_id_fkey; Type: FK CONSTRAINT; Schema: pixel; Owner: -
--

ALTER TABLE ONLY pixel.pixel_status
    ADD CONSTRAINT pixel_status_pixel_installation_id_fkey FOREIGN KEY (pixel_installation_id) REFERENCES pixel.pixel_installation(id);


--
-- Name: brand_config_history brand_config_history_brand_id_fkey; Type: FK CONSTRAINT; Schema: tenancy; Owner: -
--

ALTER TABLE ONLY tenancy.brand_config_history
    ADD CONSTRAINT brand_config_history_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES tenancy.brand(id) ON DELETE CASCADE;


--
-- Name: brand brand_currency_code_fkey; Type: FK CONSTRAINT; Schema: tenancy; Owner: -
--

ALTER TABLE ONLY tenancy.brand
    ADD CONSTRAINT brand_currency_code_fkey FOREIGN KEY (currency_code) REFERENCES tenancy.ref_currency(code);


--
-- Name: brand brand_organization_id_fkey; Type: FK CONSTRAINT; Schema: tenancy; Owner: -
--

ALTER TABLE ONLY tenancy.brand
    ADD CONSTRAINT brand_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES tenancy.organization(id);


--
-- Name: brand brand_timezone_fkey; Type: FK CONSTRAINT; Schema: tenancy; Owner: -
--

ALTER TABLE ONLY tenancy.brand
    ADD CONSTRAINT brand_timezone_fkey FOREIGN KEY (timezone) REFERENCES tenancy.ref_timezone(name);


--
-- Name: organization organization_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: tenancy; Owner: -
--

ALTER TABLE ONLY tenancy.organization
    ADD CONSTRAINT organization_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES iam.app_user(id);


--
-- Name: ai_provenance; Type: ROW SECURITY; Schema: ai_config; Owner: -
--

ALTER TABLE ai_config.ai_provenance ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_provenance ai_provenance_isolation; Type: POLICY; Schema: ai_config; Owner: -
--

CREATE POLICY ai_provenance_isolation ON ai_config.ai_provenance TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: recommendation; Type: ROW SECURITY; Schema: ai_config; Owner: -
--

ALTER TABLE ai_config.recommendation ENABLE ROW LEVEL SECURITY;

--
-- Name: recommendation_action; Type: ROW SECURITY; Schema: ai_config; Owner: -
--

ALTER TABLE ai_config.recommendation_action ENABLE ROW LEVEL SECURITY;

--
-- Name: recommendation_action recommendation_action_isolation; Type: POLICY; Schema: ai_config; Owner: -
--

CREATE POLICY recommendation_action_isolation ON ai_config.recommendation_action TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: recommendation recommendation_isolation; Type: POLICY; Schema: ai_config; Owner: -
--

CREATE POLICY recommendation_isolation ON ai_config.recommendation TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: recommendation_outcome; Type: ROW SECURITY; Schema: ai_config; Owner: -
--

ALTER TABLE ai_config.recommendation_outcome ENABLE ROW LEVEL SECURITY;

--
-- Name: recommendation_outcome recommendation_outcome_isolation; Type: POLICY; Schema: ai_config; Owner: -
--

CREATE POLICY recommendation_outcome_isolation ON ai_config.recommendation_outcome TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: audit_log; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log audit_log_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY audit_log_isolation ON audit.audit_log TO brain_app USING (((current_setting('app.role'::text, true) = 'audit_reader'::text) OR (brand_id = (current_setting('app.current_brand_id'::text, true))::uuid))) WITH CHECK (true);


--
-- Name: capi_deletion_log; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.capi_deletion_log ENABLE ROW LEVEL SECURITY;

--
-- Name: capi_deletion_log capi_deletion_log_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY capi_deletion_log_isolation ON audit.capi_deletion_log TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: capi_passback_log; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.capi_passback_log ENABLE ROW LEVEL SECURITY;

--
-- Name: capi_passback_log capi_passback_log_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY capi_passback_log_isolation ON audit.capi_passback_log TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: decision_log; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.decision_log ENABLE ROW LEVEL SECURITY;

--
-- Name: decision_log decision_log_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY decision_log_isolation ON audit.decision_log TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: decision_log_p2026_06; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.decision_log_p2026_06 ENABLE ROW LEVEL SECURITY;

--
-- Name: decision_log_p2026_06 decision_log_p2026_06_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY decision_log_p2026_06_isolation ON audit.decision_log_p2026_06 TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: decision_log_p2026_07; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.decision_log_p2026_07 ENABLE ROW LEVEL SECURITY;

--
-- Name: decision_log_p2026_07 decision_log_p2026_07_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY decision_log_p2026_07_isolation ON audit.decision_log_p2026_07 TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: decision_log_pdefault; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.decision_log_pdefault ENABLE ROW LEVEL SECURITY;

--
-- Name: decision_log_pdefault decision_log_pdefault_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY decision_log_pdefault_isolation ON audit.decision_log_pdefault TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: dq_check_result; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.dq_check_result ENABLE ROW LEVEL SECURITY;

--
-- Name: dq_check_result dq_check_result_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY dq_check_result_isolation ON audit.dq_check_result TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: dq_check_result_p2026_06; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.dq_check_result_p2026_06 ENABLE ROW LEVEL SECURITY;

--
-- Name: dq_check_result_p2026_06 dq_check_result_p2026_06_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY dq_check_result_p2026_06_isolation ON audit.dq_check_result_p2026_06 TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: dq_check_result_p2026_07; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.dq_check_result_p2026_07 ENABLE ROW LEVEL SECURITY;

--
-- Name: dq_check_result_p2026_07 dq_check_result_p2026_07_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY dq_check_result_p2026_07_isolation ON audit.dq_check_result_p2026_07 TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: dq_check_result_pdefault; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.dq_check_result_pdefault ENABLE ROW LEVEL SECURITY;

--
-- Name: dq_check_result_pdefault dq_check_result_pdefault_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY dq_check_result_pdefault_isolation ON audit.dq_check_result_pdefault TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: identity_audit; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.identity_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: identity_audit identity_audit_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY identity_audit_isolation ON audit.identity_audit TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: identity_audit_p2026_06; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.identity_audit_p2026_06 ENABLE ROW LEVEL SECURITY;

--
-- Name: identity_audit_p2026_06 identity_audit_p2026_06_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY identity_audit_p2026_06_isolation ON audit.identity_audit_p2026_06 TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: identity_audit_pdefault; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.identity_audit_pdefault ENABLE ROW LEVEL SECURITY;

--
-- Name: identity_audit_pdefault identity_audit_pdefault_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY identity_audit_pdefault_isolation ON audit.identity_audit_pdefault TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: send_log; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.send_log ENABLE ROW LEVEL SECURITY;

--
-- Name: send_log send_log_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY send_log_isolation ON audit.send_log TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: send_log_p2026_06; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.send_log_p2026_06 ENABLE ROW LEVEL SECURITY;

--
-- Name: send_log_p2026_06 send_log_p2026_06_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY send_log_p2026_06_isolation ON audit.send_log_p2026_06 TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: send_log_pdefault; Type: ROW SECURITY; Schema: audit; Owner: -
--

ALTER TABLE audit.send_log_pdefault ENABLE ROW LEVEL SECURITY;

--
-- Name: send_log_pdefault send_log_pdefault_isolation; Type: POLICY; Schema: audit; Owner: -
--

CREATE POLICY send_log_pdefault_isolation ON audit.send_log_pdefault TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: billing_plan; Type: ROW SECURITY; Schema: billing; Owner: -
--

ALTER TABLE billing.billing_plan ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_plan billing_plan_isolation; Type: POLICY; Schema: billing; Owner: -
--

CREATE POLICY billing_plan_isolation ON billing.billing_plan TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: cost_input; Type: ROW SECURITY; Schema: billing; Owner: -
--

ALTER TABLE billing.cost_input ENABLE ROW LEVEL SECURITY;

--
-- Name: cost_input cost_input_isolation; Type: POLICY; Schema: billing; Owner: -
--

CREATE POLICY cost_input_isolation ON billing.cost_input TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid)) WITH CHECK ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: credit_note; Type: ROW SECURITY; Schema: billing; Owner: -
--

ALTER TABLE billing.credit_note ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_note credit_note_isolation; Type: POLICY; Schema: billing; Owner: -
--

CREATE POLICY credit_note_isolation ON billing.credit_note TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: gmv_meter_snapshot; Type: ROW SECURITY; Schema: billing; Owner: -
--

ALTER TABLE billing.gmv_meter_snapshot ENABLE ROW LEVEL SECURITY;

--
-- Name: gmv_meter_snapshot gmv_meter_snapshot_isolation; Type: POLICY; Schema: billing; Owner: -
--

CREATE POLICY gmv_meter_snapshot_isolation ON billing.gmv_meter_snapshot TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: invoice; Type: ROW SECURITY; Schema: billing; Owner: -
--

ALTER TABLE billing.invoice ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice invoice_isolation; Type: POLICY; Schema: billing; Owner: -
--

CREATE POLICY invoice_isolation ON billing.invoice TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: invoice_line; Type: ROW SECURITY; Schema: billing; Owner: -
--

ALTER TABLE billing.invoice_line ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_line invoice_line_isolation; Type: POLICY; Schema: billing; Owner: -
--

CREATE POLICY invoice_line_isolation ON billing.invoice_line TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: tax_ledger; Type: ROW SECURITY; Schema: billing; Owner: -
--

ALTER TABLE billing.tax_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_ledger tax_ledger_isolation; Type: POLICY; Schema: billing; Owner: -
--

CREATE POLICY tax_ledger_isolation ON billing.tax_ledger TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: tax_ledger_p2026_06; Type: ROW SECURITY; Schema: billing; Owner: -
--

ALTER TABLE billing.tax_ledger_p2026_06 ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_ledger_p2026_06 tax_ledger_p2026_06_isolation; Type: POLICY; Schema: billing; Owner: -
--

CREATE POLICY tax_ledger_p2026_06_isolation ON billing.tax_ledger_p2026_06 TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: tax_ledger_pdefault; Type: ROW SECURITY; Schema: billing; Owner: -
--

ALTER TABLE billing.tax_ledger_pdefault ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_ledger_pdefault tax_ledger_pdefault_isolation; Type: POLICY; Schema: billing; Owner: -
--

CREATE POLICY tax_ledger_pdefault_isolation ON billing.tax_ledger_pdefault TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_cursor; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_cursor ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_cursor connector_cursor_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_cursor_isolation ON connectors.connector_cursor TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_dlq_record; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_dlq_record ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_dlq_record connector_dlq_record_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_dlq_record_isolation ON connectors.connector_dlq_record TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_dlq_record_p2026_06; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_dlq_record_p2026_06 ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_dlq_record_p2026_06 connector_dlq_record_p2026_06_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_dlq_record_p2026_06_isolation ON connectors.connector_dlq_record_p2026_06 TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_dlq_record_p2026_07; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_dlq_record_p2026_07 ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_dlq_record_p2026_07 connector_dlq_record_p2026_07_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_dlq_record_p2026_07_isolation ON connectors.connector_dlq_record_p2026_07 TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_dlq_record_p2026_08; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_dlq_record_p2026_08 ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_dlq_record_p2026_08 connector_dlq_record_p2026_08_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_dlq_record_p2026_08_isolation ON connectors.connector_dlq_record_p2026_08 TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_dlq_record_pdefault; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_dlq_record_pdefault ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_dlq_record_pdefault connector_dlq_record_pdefault_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_dlq_record_pdefault_isolation ON connectors.connector_dlq_record_pdefault TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_instance; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_instance ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_instance connector_instance_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_instance_isolation ON connectors.connector_instance TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_journey_stitch_map; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_journey_stitch_map ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_journey_stitch_map connector_journey_stitch_map_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_journey_stitch_map_isolation ON connectors.connector_journey_stitch_map TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_razorpay_order_map; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_razorpay_order_map ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_razorpay_order_map connector_razorpay_order_map_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_razorpay_order_map_isolation ON connectors.connector_razorpay_order_map TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_sync_run; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_sync_run ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_sync_run connector_sync_run_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_sync_run_isolation ON connectors.connector_sync_run TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_sync_run_p2026_07; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_sync_run_p2026_07 ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_sync_run_p2026_07 connector_sync_run_p2026_07_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_sync_run_p2026_07_isolation ON connectors.connector_sync_run_p2026_07 TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_sync_run_p2026_08; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_sync_run_p2026_08 ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_sync_run_p2026_08 connector_sync_run_p2026_08_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_sync_run_p2026_08_isolation ON connectors.connector_sync_run_p2026_08 TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_sync_run_p2026_09; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_sync_run_p2026_09 ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_sync_run_p2026_09 connector_sync_run_p2026_09_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_sync_run_p2026_09_isolation ON connectors.connector_sync_run_p2026_09 TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_sync_status; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_sync_status ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_sync_status connector_sync_status_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_sync_status_isolation ON connectors.connector_sync_status TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_webhook_raw_archive; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_webhook_raw_archive ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_webhook_raw_archive connector_webhook_raw_archive_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_webhook_raw_archive_isolation ON connectors.connector_webhook_raw_archive TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_webhook_raw_archive_legacy connector_webhook_raw_archive_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_webhook_raw_archive_isolation ON connectors.connector_webhook_raw_archive_legacy TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_webhook_raw_archive_legacy; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_webhook_raw_archive_legacy ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_webhook_raw_archive_p2026_06; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_webhook_raw_archive_p2026_06 ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_webhook_raw_archive_p2026_06 connector_webhook_raw_archive_p2026_06_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_webhook_raw_archive_p2026_06_isolation ON connectors.connector_webhook_raw_archive_p2026_06 TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_webhook_raw_archive_p2026_07; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_webhook_raw_archive_p2026_07 ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_webhook_raw_archive_p2026_07 connector_webhook_raw_archive_p2026_07_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_webhook_raw_archive_p2026_07_isolation ON connectors.connector_webhook_raw_archive_p2026_07 TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_webhook_raw_archive_p2026_08; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_webhook_raw_archive_p2026_08 ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_webhook_raw_archive_p2026_08 connector_webhook_raw_archive_p2026_08_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_webhook_raw_archive_p2026_08_isolation ON connectors.connector_webhook_raw_archive_p2026_08 TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: connector_webhook_raw_archive_pdefault; Type: ROW SECURITY; Schema: connectors; Owner: -
--

ALTER TABLE connectors.connector_webhook_raw_archive_pdefault ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_webhook_raw_archive_pdefault connector_webhook_raw_archive_pdefault_isolation; Type: POLICY; Schema: connectors; Owner: -
--

CREATE POLICY connector_webhook_raw_archive_pdefault_isolation ON connectors.connector_webhook_raw_archive_pdefault TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: consent_record; Type: ROW SECURITY; Schema: consent; Owner: -
--

ALTER TABLE consent.consent_record ENABLE ROW LEVEL SECURITY;

--
-- Name: consent_record consent_record_isolation; Type: POLICY; Schema: consent; Owner: -
--

CREATE POLICY consent_record_isolation ON consent.consent_record TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: consent_tombstone; Type: ROW SECURITY; Schema: consent; Owner: -
--

ALTER TABLE consent.consent_tombstone ENABLE ROW LEVEL SECURITY;

--
-- Name: consent_tombstone consent_tombstone_isolation; Type: POLICY; Schema: consent; Owner: -
--

CREATE POLICY consent_tombstone_isolation ON consent.consent_tombstone TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: email_verification; Type: ROW SECURITY; Schema: iam; Owner: -
--

ALTER TABLE iam.email_verification ENABLE ROW LEVEL SECURITY;

--
-- Name: email_verification email_verification_isolation; Type: POLICY; Schema: iam; Owner: -
--

CREATE POLICY email_verification_isolation ON iam.email_verification TO brain_app USING ((app_user_id = (current_setting('app.current_user_id'::text, true))::uuid));


--
-- Name: invite; Type: ROW SECURITY; Schema: iam; Owner: -
--

ALTER TABLE iam.invite ENABLE ROW LEVEL SECURITY;

--
-- Name: invite invite_brand_level; Type: POLICY; Schema: iam; Owner: -
--

CREATE POLICY invite_brand_level ON iam.invite TO brain_app USING (((brand_id IS NOT NULL) AND (brand_id = (current_setting('app.current_brand_id'::text, true))::uuid)));


--
-- Name: invite invite_org_level; Type: POLICY; Schema: iam; Owner: -
--

CREATE POLICY invite_org_level ON iam.invite TO brain_app USING (((brand_id IS NULL) AND (organization_id = (current_setting('app.current_workspace_id'::text, true))::uuid)));


--
-- Name: membership; Type: ROW SECURITY; Schema: iam; Owner: -
--

ALTER TABLE iam.membership ENABLE ROW LEVEL SECURITY;

--
-- Name: membership membership_isolation; Type: POLICY; Schema: iam; Owner: -
--

CREATE POLICY membership_isolation ON iam.membership TO brain_app USING ((organization_id = (current_setting('app.current_workspace_id'::text, true))::uuid));


--
-- Name: membership membership_self_read; Type: POLICY; Schema: iam; Owner: -
--

CREATE POLICY membership_self_read ON iam.membership FOR SELECT TO brain_app USING ((app_user_id = (current_setting('app.current_user_id'::text, true))::uuid));


--
-- Name: password_reset; Type: ROW SECURITY; Schema: iam; Owner: -
--

ALTER TABLE iam.password_reset ENABLE ROW LEVEL SECURITY;

--
-- Name: password_reset password_reset_isolation; Type: POLICY; Schema: iam; Owner: -
--

CREATE POLICY password_reset_isolation ON iam.password_reset TO brain_app USING ((app_user_id = (current_setting('app.current_user_id'::text, true))::uuid));


--
-- Name: user_session; Type: ROW SECURITY; Schema: iam; Owner: -
--

ALTER TABLE iam.user_session ENABLE ROW LEVEL SECURITY;

--
-- Name: user_session user_session_isolation; Type: POLICY; Schema: iam; Owner: -
--

CREATE POLICY user_session_isolation ON iam.user_session TO brain_app USING ((app_user_id = (current_setting('app.current_user_id'::text, true))::uuid));


--
-- Name: contact_pii; Type: ROW SECURITY; Schema: identity; Owner: -
--

ALTER TABLE identity.contact_pii ENABLE ROW LEVEL SECURITY;

--
-- Name: contact_pii contact_pii_isolation; Type: POLICY; Schema: identity; Owner: -
--

CREATE POLICY contact_pii_isolation ON identity.contact_pii TO brain_app USING (((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid) AND (current_setting('app.role'::text, true) = 'send_service'::text)));


--
-- Name: pii_erasure_log; Type: ROW SECURITY; Schema: identity; Owner: -
--

ALTER TABLE identity.pii_erasure_log ENABLE ROW LEVEL SECURITY;

--
-- Name: pii_erasure_log pii_erasure_log_isolation; Type: POLICY; Schema: identity; Owner: -
--

CREATE POLICY pii_erasure_log_isolation ON identity.pii_erasure_log TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid)) WITH CHECK ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: backfill_job; Type: ROW SECURITY; Schema: jobs; Owner: -
--

ALTER TABLE jobs.backfill_job ENABLE ROW LEVEL SECURITY;

--
-- Name: backfill_job backfill_job_isolation; Type: POLICY; Schema: jobs; Owner: -
--

CREATE POLICY backfill_job_isolation ON jobs.backfill_job TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: resource_backfill_state; Type: ROW SECURITY; Schema: jobs; Owner: -
--

ALTER TABLE jobs.resource_backfill_state ENABLE ROW LEVEL SECURITY;

--
-- Name: resource_backfill_state resource_backfill_state_isolation; Type: POLICY; Schema: jobs; Owner: -
--

CREATE POLICY resource_backfill_state_isolation ON jobs.resource_backfill_state TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: model_registry; Type: ROW SECURITY; Schema: ml; Owner: -
--

ALTER TABLE ml.model_registry ENABLE ROW LEVEL SECURITY;

--
-- Name: model_registry model_registry_isolation; Type: POLICY; Schema: ml; Owner: -
--

CREATE POLICY model_registry_isolation ON ml.model_registry TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: brand_identity_priority; Type: ROW SECURITY; Schema: ops; Owner: -
--

ALTER TABLE ops.brand_identity_priority ENABLE ROW LEVEL SECURITY;

--
-- Name: brand_identity_priority brand_identity_priority_isolation; Type: POLICY; Schema: ops; Owner: -
--

CREATE POLICY brand_identity_priority_isolation ON ops.brand_identity_priority TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid)) WITH CHECK ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: saved_segment; Type: ROW SECURITY; Schema: ops; Owner: -
--

ALTER TABLE ops.saved_segment ENABLE ROW LEVEL SECURITY;

--
-- Name: saved_segment saved_segment_isolation; Type: POLICY; Schema: ops; Owner: -
--

CREATE POLICY saved_segment_isolation ON ops.saved_segment TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid)) WITH CHECK ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: stitch_conflict_review; Type: ROW SECURITY; Schema: ops; Owner: -
--

ALTER TABLE ops.stitch_conflict_review ENABLE ROW LEVEL SECURITY;

--
-- Name: stitch_conflict_review stitch_conflict_review_isolation; Type: POLICY; Schema: ops; Owner: -
--

CREATE POLICY stitch_conflict_review_isolation ON ops.stitch_conflict_review TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid)) WITH CHECK ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: pixel_installation; Type: ROW SECURITY; Schema: pixel; Owner: -
--

ALTER TABLE pixel.pixel_installation ENABLE ROW LEVEL SECURITY;

--
-- Name: pixel_installation pixel_installation_isolation; Type: POLICY; Schema: pixel; Owner: -
--

CREATE POLICY pixel_installation_isolation ON pixel.pixel_installation TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: pixel_status; Type: ROW SECURITY; Schema: pixel; Owner: -
--

ALTER TABLE pixel.pixel_status ENABLE ROW LEVEL SECURITY;

--
-- Name: pixel_status pixel_status_isolation; Type: POLICY; Schema: pixel; Owner: -
--

CREATE POLICY pixel_status_isolation ON pixel.pixel_status TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: gold_product_costs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gold_product_costs ENABLE ROW LEVEL SECURITY;

--
-- Name: gold_product_costs gold_product_costs_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY gold_product_costs_isolation ON public.gold_product_costs TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid)) WITH CHECK ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: brand; Type: ROW SECURITY; Schema: tenancy; Owner: -
--

ALTER TABLE tenancy.brand ENABLE ROW LEVEL SECURITY;

--
-- Name: brand_config_history; Type: ROW SECURITY; Schema: tenancy; Owner: -
--

ALTER TABLE tenancy.brand_config_history ENABLE ROW LEVEL SECURITY;

--
-- Name: brand_config_history brand_config_history_isolation; Type: POLICY; Schema: tenancy; Owner: -
--

CREATE POLICY brand_config_history_isolation ON tenancy.brand_config_history TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid)) WITH CHECK ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: brand_identity_salt; Type: ROW SECURITY; Schema: tenancy; Owner: -
--

ALTER TABLE tenancy.brand_identity_salt ENABLE ROW LEVEL SECURITY;

--
-- Name: brand_identity_salt brand_identity_salt_isolation; Type: POLICY; Schema: tenancy; Owner: -
--

CREATE POLICY brand_identity_salt_isolation ON tenancy.brand_identity_salt TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid)) WITH CHECK ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: brand brand_isolation; Type: POLICY; Schema: tenancy; Owner: -
--

CREATE POLICY brand_isolation ON tenancy.brand TO brain_app USING ((id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: brand_keyring; Type: ROW SECURITY; Schema: tenancy; Owner: -
--

ALTER TABLE tenancy.brand_keyring ENABLE ROW LEVEL SECURITY;

--
-- Name: brand_keyring brand_keyring_isolation; Type: POLICY; Schema: tenancy; Owner: -
--

CREATE POLICY brand_keyring_isolation ON tenancy.brand_keyring TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid)) WITH CHECK ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: brand brand_self_read; Type: POLICY; Schema: tenancy; Owner: -
--

CREATE POLICY brand_self_read ON tenancy.brand FOR SELECT TO brain_app USING ((id IN ( SELECT m.brand_id
   FROM iam.membership m
  WHERE ((m.app_user_id = (current_setting('app.current_user_id'::text, true))::uuid) AND (m.brand_id IS NOT NULL) AND (m.organization_id = (current_setting('app.current_workspace_id'::text, true))::uuid)))));


--
-- Name: organization; Type: ROW SECURITY; Schema: tenancy; Owner: -
--

ALTER TABLE tenancy.organization ENABLE ROW LEVEL SECURITY;

--
-- Name: organization organization_isolation; Type: POLICY; Schema: tenancy; Owner: -
--

CREATE POLICY organization_isolation ON tenancy.organization TO brain_app USING ((id = (current_setting('app.current_workspace_id'::text, true))::uuid));


--
-- Name: organization organization_self_read; Type: POLICY; Schema: tenancy; Owner: -
--

CREATE POLICY organization_self_read ON tenancy.organization FOR SELECT TO brain_app USING ((id IN ( SELECT m.organization_id
   FROM iam.membership m
  WHERE (m.app_user_id = (current_setting('app.current_user_id'::text, true))::uuid))));


--
-- Name: subject_keyring; Type: ROW SECURITY; Schema: tenancy; Owner: -
--

ALTER TABLE tenancy.subject_keyring ENABLE ROW LEVEL SECURITY;

--
-- Name: subject_keyring subject_keyring_isolation; Type: POLICY; Schema: tenancy; Owner: -
--

CREATE POLICY subject_keyring_isolation ON tenancy.subject_keyring TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid)) WITH CHECK ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));


--
-- Name: SCHEMA ai_config; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA ai_config TO brain_app;


--
-- Name: SCHEMA audit; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA audit TO brain_app;


--
-- Name: SCHEMA billing; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA billing TO brain_app;


--
-- Name: SCHEMA connectors; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA connectors TO brain_app;


--
-- Name: SCHEMA consent; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA consent TO brain_app;


--
-- Name: SCHEMA data_plane; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA data_plane TO brain_app;


--
-- Name: SCHEMA iam; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA iam TO brain_app;


--
-- Name: SCHEMA identity; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA identity TO brain_app;


--
-- Name: SCHEMA jobs; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA jobs TO brain_app;


--
-- Name: SCHEMA ml; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA ml TO brain_app;


--
-- Name: SCHEMA ops; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA ops TO brain_app;


--
-- Name: SCHEMA pixel; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA pixel TO brain_app;


--
-- Name: SCHEMA tenancy; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA tenancy TO brain_app;


--
-- Name: FUNCTION attribution_confidence_mart(p_brand_id uuid, p_model_id text, p_from date, p_to date); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.attribution_confidence_mart(p_brand_id uuid, p_model_id text, p_from date, p_to date) TO brain_app;


--
-- Name: FUNCTION claim_due_repull_connectors(p_batch integer, p_interval_seconds integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.claim_due_repull_connectors(p_batch integer, p_interval_seconds integer) TO brain_app;


--
-- Name: FUNCTION cost_inputs_as_of(p_brand_id uuid, p_as_of date); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cost_inputs_as_of(p_brand_id uuid, p_as_of date) TO brain_app;


--
-- Name: FUNCTION erase_contact_pii_for_customer(p_brand_id uuid, p_brain_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.erase_contact_pii_for_customer(p_brand_id uuid, p_brain_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.erase_contact_pii_for_customer(p_brand_id uuid, p_brain_id uuid) TO brain_app;


--
-- Name: FUNCTION find_email_verification_by_hash(p_token_hash text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.find_email_verification_by_hash(p_token_hash text) TO brain_app;


--
-- Name: TABLE invite; Type: ACL; Schema: iam; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE iam.invite TO brain_app;


--
-- Name: FUNCTION find_invite_for_acceptance(p_token_hash text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.find_invite_for_acceptance(p_token_hash text) TO brain_app;


--
-- Name: FUNCTION find_password_reset_by_hash(p_token_hash text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.find_password_reset_by_hash(p_token_hash text) TO brain_app;


--
-- Name: TABLE user_session; Type: ACL; Schema: iam; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE iam.user_session TO brain_app;


--
-- Name: FUNCTION find_session_for_rotation(p_refresh_token_hash text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.find_session_for_rotation(p_refresh_token_hash text) TO brain_app;


--
-- Name: FUNCTION get_brand_identity_salt(p_brand_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_brand_identity_salt(p_brand_id uuid) TO brain_app;


--
-- Name: FUNCTION get_brand_keyring(p_brand_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_brand_keyring(p_brand_id uuid) TO brain_app;


--
-- Name: FUNCTION get_pixel_identity_config(p_install_token uuid, p_brand_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_pixel_identity_config(p_install_token uuid, p_brand_id uuid) TO brain_app;


--
-- Name: FUNCTION get_subject_keyring(p_brand_id uuid, p_brain_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_subject_keyring(p_brand_id uuid, p_brain_id uuid) TO brain_app;


--
-- Name: FUNCTION issue_credit_note(p_brand_id uuid, p_invoice_id uuid, p_reason text, p_taxable_minor bigint, p_tax_rate_bps integer, p_tax_minor bigint, p_regime text, p_sac text, p_cgst_minor bigint, p_sgst_minor bigint, p_igst_minor bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.issue_credit_note(p_brand_id uuid, p_invoice_id uuid, p_reason text, p_taxable_minor bigint, p_tax_rate_bps integer, p_tax_minor bigint, p_regime text, p_sac text, p_cgst_minor bigint, p_sgst_minor bigint, p_igst_minor bigint) TO brain_app;


--
-- Name: FUNCTION issue_invoice(p_brand_id uuid, p_period character, p_legal_entity text, p_fy text, p_seller_gstin text, p_place_of_supply text, p_rate_bps integer, p_fee_minor bigint, p_sac text, p_tax_rate_bps integer, p_tax_minor bigint, p_regime text, p_metric_version text, p_cgst_minor bigint, p_sgst_minor bigint, p_igst_minor bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.issue_invoice(p_brand_id uuid, p_period character, p_legal_entity text, p_fy text, p_seller_gstin text, p_place_of_supply text, p_rate_bps integer, p_fee_minor bigint, p_sac text, p_tax_rate_bps integer, p_tax_minor bigint, p_regime text, p_metric_version text, p_cgst_minor bigint, p_sgst_minor bigint, p_igst_minor bigint) TO brain_app;


--
-- Name: FUNCTION list_active_brand_ids(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.list_active_brand_ids() TO brain_app;


--
-- Name: FUNCTION list_ad_connectors_for_spend_repull(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.list_ad_connectors_for_spend_repull() TO brain_app;


--
-- Name: FUNCTION list_connectors_for_repull(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.list_connectors_for_repull() TO brain_app;


--
-- Name: FUNCTION list_connectors_for_repull(p_provider text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.list_connectors_for_repull(p_provider text) TO brain_app;


--
-- Name: FUNCTION list_gokwik_connectors(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.list_gokwik_connectors() TO brain_app;


--
-- Name: FUNCTION list_queued_backfill_jobs(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.list_queued_backfill_jobs() TO brain_app;


--
-- Name: FUNCTION list_razorpay_connectors_for_settlement_repull(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.list_razorpay_connectors_for_settlement_repull() TO brain_app;


--
-- Name: FUNCTION list_resumable_backfill_states(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.list_resumable_backfill_states() TO brain_app;


--
-- Name: FUNCTION list_shiprocket_connectors_for_repull(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.list_shiprocket_connectors_for_repull() TO brain_app;


--
-- Name: FUNCTION list_shiprocket_connectors_for_webhook(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.list_shiprocket_connectors_for_webhook() TO brain_app;


--
-- Name: FUNCTION list_shopflo_connectors(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.list_shopflo_connectors() TO brain_app;


--
-- Name: FUNCTION list_woocommerce_connectors_for_repull(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.list_woocommerce_connectors_for_repull() TO brain_app;


--
-- Name: FUNCTION maintain_time_partitions(p_ahead_months integer, p_retention_months integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.maintain_time_partitions(p_ahead_months integer, p_retention_months integer) TO brain_app;


--
-- Name: FUNCTION product_cost_as_of(p_brand_id uuid, p_sku text, p_currency character, p_as_of date); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.product_cost_as_of(p_brand_id uuid, p_sku text, p_currency character, p_as_of date) TO brain_app;


--
-- Name: FUNCTION provision_brand_crypto(p_brand_id uuid, p_kms_key_id text, p_wrapped_dek_b64 text, p_wrapped_salt_b64 text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.provision_brand_crypto(p_brand_id uuid, p_kms_key_id text, p_wrapped_dek_b64 text, p_wrapped_salt_b64 text) TO brain_app;


--
-- Name: FUNCTION provision_subject_crypto(p_brand_id uuid, p_brain_id uuid, p_kms_key_id text, p_wrapped_dek_b64 text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.provision_subject_crypto(p_brand_id uuid, p_brain_id uuid, p_kms_key_id text, p_wrapped_dek_b64 text) TO brain_app;


--
-- Name: FUNCTION provision_workspace(p_owner_user_id uuid, p_workspace_name text, p_slug text, p_region_code text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.provision_workspace(p_owner_user_id uuid, p_workspace_name text, p_slug text, p_region_code text) TO brain_app;


--
-- Name: FUNCTION provision_workspace_and_brand(p_owner_user_id uuid, p_workspace_name text, p_slug text, p_brand_display_name text, p_domain text, p_region_code text, p_currency_code character, p_timezone text, p_revenue_definition text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.provision_workspace_and_brand(p_owner_user_id uuid, p_workspace_name text, p_slug text, p_brand_display_name text, p_domain text, p_region_code text, p_currency_code character, p_timezone text, p_revenue_definition text) TO brain_app;


--
-- Name: FUNCTION realized_gmv_composition_as_of(p_brand_id uuid, p_as_of date); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.realized_gmv_composition_as_of(p_brand_id uuid, p_as_of date) TO brain_app;


--
-- Name: FUNCTION resolve_brand_by_install_token(p_install_token uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.resolve_brand_by_install_token(p_install_token uuid) TO brain_app;


--
-- Name: FUNCTION resolve_connector_by_shop_domain(p_shop_domain text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.resolve_connector_by_shop_domain(p_shop_domain text) TO brain_app;


--
-- Name: FUNCTION resolve_gokwik_connector_by_merchant(p_appid text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.resolve_gokwik_connector_by_merchant(p_appid text) TO brain_app;


--
-- Name: FUNCTION resolve_razorpay_connector_by_account(p_account_id text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.resolve_razorpay_connector_by_account(p_account_id text) TO brain_app;


--
-- Name: FUNCTION resolve_shiprocket_connector_by_channel(p_channel text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.resolve_shiprocket_connector_by_channel(p_channel text) TO brain_app;


--
-- Name: FUNCTION resolve_shopflo_connector_by_merchant(p_merchant_id text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.resolve_shopflo_connector_by_merchant(p_merchant_id text) TO brain_app;


--
-- Name: FUNCTION resolve_woocommerce_connector_by_site(p_site_url text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.resolve_woocommerce_connector_by_site(p_site_url text) TO brain_app;


--
-- Name: FUNCTION shred_subject_keyring(p_brand_id uuid, p_brain_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.shred_subject_keyring(p_brand_id uuid, p_brain_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.shred_subject_keyring(p_brand_id uuid, p_brain_id uuid) TO brain_app;


--
-- Name: TABLE ai_provenance; Type: ACL; Schema: ai_config; Owner: -
--

GRANT SELECT,INSERT ON TABLE ai_config.ai_provenance TO brain_app;


--
-- Name: TABLE recommendation; Type: ACL; Schema: ai_config; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE ai_config.recommendation TO brain_app;


--
-- Name: TABLE recommendation_action; Type: ACL; Schema: ai_config; Owner: -
--

GRANT SELECT,INSERT ON TABLE ai_config.recommendation_action TO brain_app;


--
-- Name: TABLE recommendation_outcome; Type: ACL; Schema: ai_config; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE ai_config.recommendation_outcome TO brain_app;


--
-- Name: TABLE audit_log; Type: ACL; Schema: audit; Owner: -
--

GRANT SELECT,INSERT ON TABLE audit.audit_log TO brain_app;


--
-- Name: SEQUENCE audit_log_id_seq; Type: ACL; Schema: audit; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE audit.audit_log_id_seq TO brain_app;


--
-- Name: TABLE capi_deletion_log; Type: ACL; Schema: audit; Owner: -
--

GRANT SELECT,INSERT ON TABLE audit.capi_deletion_log TO brain_app;


--
-- Name: TABLE capi_passback_log; Type: ACL; Schema: audit; Owner: -
--

GRANT SELECT,INSERT ON TABLE audit.capi_passback_log TO brain_app;


--
-- Name: TABLE decision_log; Type: ACL; Schema: audit; Owner: -
--

GRANT SELECT,INSERT ON TABLE audit.decision_log TO brain_app;


--
-- Name: TABLE dq_check_result; Type: ACL; Schema: audit; Owner: -
--

GRANT SELECT,INSERT ON TABLE audit.dq_check_result TO brain_app;


--
-- Name: TABLE identity_audit; Type: ACL; Schema: audit; Owner: -
--

GRANT SELECT,INSERT ON TABLE audit.identity_audit TO brain_app;


--
-- Name: TABLE send_log; Type: ACL; Schema: audit; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE audit.send_log TO brain_app;


--
-- Name: SEQUENCE send_log_part_id_seq; Type: ACL; Schema: audit; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE audit.send_log_part_id_seq TO brain_app;


--
-- Name: TABLE billing_plan; Type: ACL; Schema: billing; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE billing.billing_plan TO brain_app;


--
-- Name: TABLE cost_input; Type: ACL; Schema: billing; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE billing.cost_input TO brain_app;


--
-- Name: TABLE credit_note; Type: ACL; Schema: billing; Owner: -
--

GRANT SELECT ON TABLE billing.credit_note TO brain_app;


--
-- Name: TABLE gmv_meter_snapshot; Type: ACL; Schema: billing; Owner: -
--

GRANT SELECT,INSERT ON TABLE billing.gmv_meter_snapshot TO brain_app;


--
-- Name: TABLE invoice; Type: ACL; Schema: billing; Owner: -
--

GRANT SELECT ON TABLE billing.invoice TO brain_app;


--
-- Name: TABLE invoice_line; Type: ACL; Schema: billing; Owner: -
--

GRANT SELECT ON TABLE billing.invoice_line TO brain_app;


--
-- Name: TABLE tax_ledger; Type: ACL; Schema: billing; Owner: -
--

GRANT SELECT ON TABLE billing.tax_ledger TO brain_app;


--
-- Name: TABLE connector_cursor; Type: ACL; Schema: connectors; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE connectors.connector_cursor TO brain_app;


--
-- Name: TABLE connector_dlq_record; Type: ACL; Schema: connectors; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE connectors.connector_dlq_record TO brain_app;


--
-- Name: TABLE connector_instance; Type: ACL; Schema: connectors; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE connectors.connector_instance TO brain_app;


--
-- Name: TABLE connector_journey_stitch_map; Type: ACL; Schema: connectors; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE connectors.connector_journey_stitch_map TO brain_app;


--
-- Name: TABLE connector_razorpay_order_map; Type: ACL; Schema: connectors; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE connectors.connector_razorpay_order_map TO brain_app;


--
-- Name: TABLE connector_sync_run; Type: ACL; Schema: connectors; Owner: -
--

GRANT SELECT,INSERT ON TABLE connectors.connector_sync_run TO brain_app;


--
-- Name: TABLE connector_sync_status; Type: ACL; Schema: connectors; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE connectors.connector_sync_status TO brain_app;


--
-- Name: TABLE connector_webhook_raw_archive; Type: ACL; Schema: connectors; Owner: -
--

GRANT SELECT,INSERT ON TABLE connectors.connector_webhook_raw_archive TO brain_app;


--
-- Name: TABLE connector_webhook_raw_archive_legacy; Type: ACL; Schema: connectors; Owner: -
--

GRANT SELECT,INSERT ON TABLE connectors.connector_webhook_raw_archive_legacy TO brain_app;


--
-- Name: SEQUENCE connector_webhook_raw_archive_id_seq; Type: ACL; Schema: connectors; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE connectors.connector_webhook_raw_archive_id_seq TO brain_app;


--
-- Name: SEQUENCE connector_webhook_raw_archive_part_id_seq; Type: ACL; Schema: connectors; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE connectors.connector_webhook_raw_archive_part_id_seq TO brain_app;


--
-- Name: TABLE consent_record; Type: ACL; Schema: consent; Owner: -
--

GRANT SELECT,INSERT ON TABLE consent.consent_record TO brain_app;


--
-- Name: TABLE consent_tombstone; Type: ACL; Schema: consent; Owner: -
--

GRANT SELECT,INSERT ON TABLE consent.consent_tombstone TO brain_app;


--
-- Name: TABLE collector_spool; Type: ACL; Schema: data_plane; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE data_plane.collector_spool TO brain_app;


--
-- Name: SEQUENCE collector_spool_id_seq; Type: ACL; Schema: data_plane; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE data_plane.collector_spool_id_seq TO brain_app;


--
-- Name: TABLE app_user; Type: ACL; Schema: iam; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE iam.app_user TO brain_app;


--
-- Name: TABLE email_verification; Type: ACL; Schema: iam; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE iam.email_verification TO brain_app;


--
-- Name: TABLE membership; Type: ACL; Schema: iam; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE iam.membership TO brain_app;


--
-- Name: TABLE password_reset; Type: ACL; Schema: iam; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE iam.password_reset TO brain_app;


--
-- Name: TABLE contact_pii; Type: ACL; Schema: identity; Owner: -
--

GRANT SELECT,INSERT ON TABLE identity.contact_pii TO brain_app;


--
-- Name: TABLE pii_erasure_log; Type: ACL; Schema: identity; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE identity.pii_erasure_log TO brain_app;


--
-- Name: TABLE backfill_job; Type: ACL; Schema: jobs; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE jobs.backfill_job TO brain_app;


--
-- Name: TABLE resource_backfill_state; Type: ACL; Schema: jobs; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE jobs.resource_backfill_state TO brain_app;


--
-- Name: TABLE model_registry; Type: ACL; Schema: ml; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE ml.model_registry TO brain_app;


--
-- Name: TABLE brand_identity_priority; Type: ACL; Schema: ops; Owner: -
--

GRANT SELECT,INSERT ON TABLE ops.brand_identity_priority TO brain_app;


--
-- Name: TABLE identity_export_state; Type: ACL; Schema: ops; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ops.identity_export_state TO brain_app;


--
-- Name: TABLE journey_reversion_pending; Type: ACL; Schema: ops; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ops.journey_reversion_pending TO brain_app;


--
-- Name: TABLE ops_ml_prediction_log; Type: ACL; Schema: ops; Owner: -
--

GRANT SELECT,INSERT ON TABLE ops.ops_ml_prediction_log TO brain_app;


--
-- Name: TABLE restitch_pending; Type: ACL; Schema: ops; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ops.restitch_pending TO brain_app;


--
-- Name: TABLE saved_segment; Type: ACL; Schema: ops; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ops.saved_segment TO brain_app;


--
-- Name: TABLE scoped_recompute_request; Type: ACL; Schema: ops; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ops.scoped_recompute_request TO brain_app;


--
-- Name: TABLE silver_customer_identity; Type: ACL; Schema: ops; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ops.silver_customer_identity TO brain_app;


--
-- Name: TABLE silver_identity_link; Type: ACL; Schema: ops; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ops.silver_identity_link TO brain_app;


--
-- Name: TABLE silver_journey_stitch; Type: ACL; Schema: ops; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ops.silver_journey_stitch TO brain_app;


--
-- Name: TABLE stitch_conflict_review; Type: ACL; Schema: ops; Owner: -
--

GRANT SELECT,INSERT ON TABLE ops.stitch_conflict_review TO brain_app;


--
-- Name: TABLE pixel_installation; Type: ACL; Schema: pixel; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE pixel.pixel_installation TO brain_app;


--
-- Name: TABLE pixel_status; Type: ACL; Schema: pixel; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE pixel.pixel_status TO brain_app;


--
-- Name: TABLE dev_secret; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.dev_secret TO brain_app;


--
-- Name: TABLE gold_product_costs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.gold_product_costs TO brain_app;


--
-- Name: TABLE brand; Type: ACL; Schema: tenancy; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE tenancy.brand TO brain_app;


--
-- Name: TABLE brand_config_history; Type: ACL; Schema: tenancy; Owner: -
--

GRANT SELECT,INSERT ON TABLE tenancy.brand_config_history TO brain_app;


--
-- Name: TABLE brand_identity_salt; Type: ACL; Schema: tenancy; Owner: -
--

GRANT SELECT ON TABLE tenancy.brand_identity_salt TO brain_app;


--
-- Name: TABLE brand_keyring; Type: ACL; Schema: tenancy; Owner: -
--

GRANT SELECT ON TABLE tenancy.brand_keyring TO brain_app;


--
-- Name: TABLE organization; Type: ACL; Schema: tenancy; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE tenancy.organization TO brain_app;


--
-- Name: TABLE ref_currency; Type: ACL; Schema: tenancy; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE tenancy.ref_currency TO brain_app;


--
-- Name: TABLE ref_timezone; Type: ACL; Schema: tenancy; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE tenancy.ref_timezone TO brain_app;


--
-- Name: TABLE subject_keyring; Type: ACL; Schema: tenancy; Owner: -
--

GRANT SELECT ON TABLE tenancy.subject_keyring TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: ai_config; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA ai_config GRANT SELECT,USAGE ON SEQUENCES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: ai_config; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA ai_config GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: audit; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA audit GRANT SELECT,USAGE ON SEQUENCES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: audit; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA audit GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: billing; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA billing GRANT SELECT,USAGE ON SEQUENCES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: billing; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA billing GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: connectors; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA connectors GRANT SELECT,USAGE ON SEQUENCES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: connectors; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA connectors GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: consent; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA consent GRANT SELECT,USAGE ON SEQUENCES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: consent; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA consent GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: data_plane; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA data_plane GRANT SELECT,USAGE ON SEQUENCES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: data_plane; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA data_plane GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: iam; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA iam GRANT SELECT,USAGE ON SEQUENCES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: iam; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA iam GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: identity; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA identity GRANT SELECT,USAGE ON SEQUENCES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: identity; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA identity GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: jobs; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA jobs GRANT SELECT,USAGE ON SEQUENCES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: jobs; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA jobs GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: pixel; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA pixel GRANT SELECT,USAGE ON SEQUENCES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: pixel; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA pixel GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: tenancy; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA tenancy GRANT SELECT,USAGE ON SEQUENCES TO brain_app;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: tenancy; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA tenancy GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO brain_app;


--
-- PostgreSQL database dump complete
--


