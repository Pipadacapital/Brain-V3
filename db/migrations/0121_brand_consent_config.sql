-- SPEC: A.1.2 (WA-08, AMD-04 — per-brand consent config for pixel identity capture)
-- ============================================================================
-- 0121_brand_consent_config.sql — per-brand identity-capture consent config
-- ============================================================================
--
-- §A.1.2: per-brand config `{identity_capture: 'off'|'explicit_only'|'autodetect',
--                            consent_source:   'cmp_signal'|'assume_granted'}`.
--
-- AMD-04 (BINDING, R1): the spec default 'off' applies to NEW brands only. Every
-- EXISTING brand is SEEDED to its current effective shipped behavior — identity
-- capture ON in its explicit_only-equivalent form, with consent_source =
-- 'assume_granted' (the shipped PIXEL_CONSENT_DEFAULT=granted posture) — so NO
-- live install goes dark when the pixel.identify flag turns on. The seed is this
-- explicit, auditable UPDATE (one-time; the column DEFAULT stays 'off').
--
-- consent_source DEFAULT for new brands is 'cmp_signal' (fail-closed: no CMP
-- signal → consent denied), which is moot while identity_capture='off'.
--
-- Also ships get_pixel_identity_config(): a SECURITY DEFINER reader for the
-- collector's /pixel.js bootstrap templating path. The collector serves the pixel
-- asset PRE-AUTH and PRE-brand-context (no app.current_brand_id GUC), so a direct
-- read of tenancy.brand under its RLS policy returns zero rows. The install_token
-- IS the authorization (same argument as 0110's token lookups: the token is a
-- public-but-unguessable per-brand identifier, and the function returns a row ONLY
-- when the presented token belongs to the presented brand) — no enumeration
-- surface, no cross-brand exposure. Mirrors the get_brand_* SECURITY DEFINER
-- pattern (0109).
--
-- ADDITIVE. Rollback:
--   DROP FUNCTION get_pixel_identity_config(uuid, uuid);
--   ALTER TABLE tenancy.brand DROP COLUMN identity_capture, DROP COLUMN consent_source;

-- ── Per-brand consent config columns (spec default 'off' / fail-closed cmp_signal) ──
ALTER TABLE tenancy.brand
  ADD COLUMN IF NOT EXISTS identity_capture TEXT NOT NULL DEFAULT 'off'
    CONSTRAINT brand_identity_capture_check
    CHECK (identity_capture IN ('off', 'explicit_only', 'autodetect'));

ALTER TABLE tenancy.brand
  ADD COLUMN IF NOT EXISTS consent_source TEXT NOT NULL DEFAULT 'cmp_signal'
    CONSTRAINT brand_consent_source_check
    CHECK (consent_source IN ('cmp_signal', 'assume_granted'));

-- ── AMD-04 seed: grandfather every EXISTING brand to its current shipped behavior ──
-- (identity capture on in explicit_only form + assume_granted). Idempotent-safe:
-- re-running this migration re-applies the same values; brands created AFTER this
-- migration get the column DEFAULTs ('off' / 'cmp_signal') and are NOT re-seeded
-- because migrations run exactly once per database (runner-ledgered).
UPDATE tenancy.brand
   SET identity_capture = 'explicit_only',
       consent_source   = 'assume_granted';

-- ── Reader: pixel bootstrap identity config (SECURITY DEFINER, token-authorized) ──
CREATE OR REPLACE FUNCTION get_pixel_identity_config(p_install_token uuid, p_brand_id uuid)
  RETURNS TABLE(
    identity_capture TEXT,
    consent_source   TEXT,
    region_code      TEXT
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public, tenancy, pixel
AS $$
  SELECT b.identity_capture, b.consent_source, b.region_code
  FROM tenancy.brand b
  JOIN pixel.pixel_installation pi ON pi.brand_id = b.id
  WHERE pi.install_token = p_install_token
    AND b.id = p_brand_id
$$;

GRANT EXECUTE ON FUNCTION get_pixel_identity_config(uuid, uuid) TO brain_app;

-- ── Post-condition guards (mirror the SEC-* pattern) ────────────────────────────
DO $$
DECLARE
  n_unseeded int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'tenancy' AND table_name = 'brand' AND column_name = 'identity_capture'
  ) THEN
    RAISE EXCEPTION '0121 failed: tenancy.brand.identity_capture missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'tenancy' AND table_name = 'brand' AND column_name = 'consent_source'
  ) THEN
    RAISE EXCEPTION '0121 failed: tenancy.brand.consent_source missing';
  END IF;
  -- AMD-04 seed applied: at migration time NO existing brand may remain at the
  -- new-brand default (they must all be grandfathered to explicit_only).
  SELECT count(*) INTO n_unseeded FROM tenancy.brand WHERE identity_capture = 'off';
  IF n_unseeded <> 0 THEN
    RAISE EXCEPTION '0121 failed: % existing brand(s) not seeded to explicit_only (AMD-04)', n_unseeded;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.proname = 'get_pixel_identity_config' AND p.prosecdef AND p.proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0121 failed: get_pixel_identity_config must be SECURITY DEFINER + search_path-pinned';
  END IF;
END $$;
