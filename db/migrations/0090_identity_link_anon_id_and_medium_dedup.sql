-- 0090_identity_link_anon_id_and_medium_dedup.sql
--
-- AUDIT-REMEDIATION C2 (identity) — schema support for the new medium-tier RESOLUTION INPUTS
-- (device_id + anon_id / brain_anon_id) added to the resolver. Two changes, both additive:
--
-- 1. Extend identity_link.identifier_type CHECK to allow 'anon_id'. ('device_id' is already
--    permitted by the existing CHECK; the pixel's stable anonymous id is the new value.)
--
-- 2. Add a replay-safe dedup UNIQUE index for MEDIUM links. Strong/strong_on_link already have
--    identity_link_active_strong_unique; medium links had no unique target, so the resolver's
--    INSERT ... ON CONFLICT DO NOTHING could not dedup on re-delivery (idempotency gap, I-ST04).
--    The key is (brand_id, identifier_type, identifier_value, brain_id) — it dedups the EXACT
--    (value -> brain_id) link while still permitting the rare shared-device case of one value
--    mapping to multiple brain_ids (the resolver treats that as ambiguous and never merges on it).
--
-- Tenant isolation, append-only-to-brain_app, and the deterministic union-find are all unchanged.

BEGIN;

-- 1. Allow 'anon_id' as an identifier_type (device_id already allowed).
ALTER TABLE identity.identity_link
  DROP CONSTRAINT IF EXISTS identity_link_identifier_type_check;

ALTER TABLE identity.identity_link
  ADD CONSTRAINT identity_link_identifier_type_check
  CHECK (identifier_type = ANY (ARRAY[
    'email','phone','storefront_customer_id','auth_user_id','fp_cookie',
    'device_id','anon_id','ip','ua','name','pincode','location'
  ]));

-- 2. Replay-safe dedup for medium links (the ON CONFLICT DO NOTHING target the resolver relies on).
CREATE UNIQUE INDEX IF NOT EXISTS identity_link_active_medium_unique
  ON identity.identity_link (brand_id, identifier_type, identifier_value, brain_id)
  WHERE is_active = TRUE AND tier = 'medium';

COMMENT ON INDEX identity.identity_link_active_medium_unique IS
  'C2: dedup target for medium-tier (device_id/anon_id) resolution links so re-delivery is idempotent. '
  'Keyed on brain_id too so a shared device/anon id may legitimately map to >1 brain_id (resolver treats '
  'that as ambiguous evidence and never merges on it).';

COMMIT;
