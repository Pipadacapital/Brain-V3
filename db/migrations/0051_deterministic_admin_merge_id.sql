-- ============================================================================
-- 0051_deterministic_admin_merge_id.sql
-- fix-identity-merge-determinism (F1) — admin merge must be idempotent + replay-safe
-- ============================================================================
--
-- DEFECT (0039:54): resolve_merge_review() minted merge_id via gen_random_uuid() — a
-- NON-deterministic value. Calling it twice on the same review (operator double-click,
-- retry, or replay) produced TWO identity_merge_event rows for the SAME (canonical,
-- merged) pair (each ON CONFLICT (merge_id) DO NOTHING is keyed on a fresh random id, so
-- it never deduped). This violates the spine invariant: identity must be deterministic,
-- auditable, and replayable.
--
-- FIX: compute merge_id deterministically, byte-for-byte mirroring the automated resolver's
-- computeMergeId (IdentityResolver.ts) — a UUID derived from
--   sha256(brand_id ‖ canonical ‖ merged ‖ rule_version)
-- formatted 8-4-4-4-12 with version=5 + RFC-4122 variant bits. The version string is
-- 'v1-admin' (matches the stored rule_version), so repeated calls on the same review yield
-- the SAME merge_id → ON CONFLICT (merge_id) DO NOTHING = exactly one event (idempotent).
-- The canonical = v_a (the review's surviving id) is UNCHANGED — merge semantics are intact.
--
-- ADDITIVE ONLY (I-E02): CREATE OR REPLACE FUNCTION (same signature). pgcrypto.digest is
-- already available (0001:30).
-- ROLLBACK: re-apply 0039's resolve_merge_review body (gen_random_uuid) — NOT recommended.
-- ============================================================================

CREATE OR REPLACE FUNCTION resolve_merge_review(p_brand_id uuid, p_review_id uuid, p_decision text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_a        uuid;  -- canonical (surviving)
  v_b        uuid;  -- merged-away
  v_status   text;
  v_merge_id uuid;
  v_hex      text;  -- sha256(brand ‖ canonical ‖ merged ‖ 'v1-admin') as 64 lowercase hex chars
BEGIN
  IF p_decision NOT IN ('merge', 'reject') THEN
    RAISE EXCEPTION 'resolve_merge_review: decision must be merge or reject, got %', p_decision;
  END IF;

  SELECT brain_id_a, brain_id_b, status
    INTO v_a, v_b, v_status
    FROM merge_review_queue
   WHERE brand_id = p_brand_id AND review_id = p_review_id;

  IF v_a IS NULL THEN
    RETURN jsonb_build_object('resolved', false, 'reason', 'not_found');
  END IF;
  IF v_status <> 'pending' THEN
    RETURN jsonb_build_object('resolved', false, 'reason', 'already_' || v_status);
  END IF;

  IF p_decision = 'reject' THEN
    UPDATE merge_review_queue SET status = 'rejected' WHERE brand_id = p_brand_id AND review_id = p_review_id;
    RETURN jsonb_build_object('resolved', true, 'decision', 'rejected');
  END IF;

  -- decision = 'merge': merge brain_id_b INTO brain_id_a (a = canonical).
  -- DETERMINISTIC merge_id (F1) — mirrors IdentityResolver.computeMergeId: UUID-v5-formatted
  -- prefix of sha256(brand ‖ canonical ‖ merged ‖ rule_version). Idempotent on replay.
  v_hex := encode(
    digest(p_brand_id::text || '||' || v_a::text || '||' || v_b::text || '||' || 'v1-admin', 'sha256'),
    'hex'
  );
  v_merge_id := (
    substr(v_hex, 1, 8) || '-' ||
    substr(v_hex, 9, 4) || '-' ||
    '5' || substr(v_hex, 14, 3) || '-' ||                                  -- version 5
    to_hex(((position(substr(v_hex, 17, 1) in '0123456789abcdef') - 1) & 3) | 8)
      || substr(v_hex, 18, 3) || '-' ||                                    -- RFC-4122 variant (8|9|a|b)
    substr(v_hex, 21, 12)
  )::uuid;

  UPDATE customer SET merged_into = v_a, lifecycle_state = 'merged'
   WHERE brand_id = p_brand_id AND brain_id = v_b;

  INSERT INTO identity_merge_event (merge_id, brand_id, canonical_brain_id, merged_brain_id, rule_version, confidence)
  VALUES (v_merge_id, p_brand_id, v_a, v_b, 'v1-admin', 'high')
  ON CONFLICT (merge_id) DO NOTHING;

  INSERT INTO brain_id_alias (brand_id, observed_brain_id, canonical_brain_id, rule_version, merge_id)
  VALUES (p_brand_id, v_b, v_a, 'v1-admin', v_merge_id)
  ON CONFLICT (brand_id, observed_brain_id) WHERE valid_to IS NULL DO NOTHING;

  UPDATE merge_review_queue SET status = 'merged' WHERE brand_id = p_brand_id AND review_id = p_review_id;

  INSERT INTO identity_audit (brand_id, brain_id, action, merge_id, detail)
  VALUES (p_brand_id, v_b, 'merge', v_merge_id,
          jsonb_build_object('canonical_brain_id', v_a, 'source', 'review', 'review_id', p_review_id));

  RETURN jsonb_build_object('resolved', true, 'decision', 'merged',
                            'canonical_brain_id', v_a, 'merged_brain_id', v_b);
END;
$$;

GRANT EXECUTE ON FUNCTION resolve_merge_review(uuid, uuid, text) TO brain_app;

-- ── Assertion: still SECURITY DEFINER with pinned search_path (mirror 0039 guard) ──
DO $$
DECLARE
  r record;
BEGIN
  SELECT p.prosecdef AS secdef, array_to_string(p.proconfig, ',') AS cfg
    INTO r
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_merge_review';
  IF r.secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'MERGE-ADMIN GUARD: resolve_merge_review() must be SECURITY DEFINER.';
  END IF;
  IF r.cfg IS NULL OR r.cfg NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION 'MERGE-ADMIN GUARD: resolve_merge_review() must pin SET search_path = public.';
  END IF;
END
$$;
