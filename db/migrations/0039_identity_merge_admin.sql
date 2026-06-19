-- ============================================================================
-- 0039_identity_merge_admin.sql
-- feat-identity-merge-admin (P0-C) — merge/unmerge control-plane + review queue
-- ============================================================================
--
-- Operator actions on the identity graph, mirroring the resolver's deterministic merge:
--   * resolve_merge_review(brand, review_id, decision): approve a pending review →
--     merge brain_id_b INTO brain_id_a (set merged_into + lifecycle='merged', write
--     identity_merge_event + brain_id_alias, mark the review 'merged'); or 'reject' it.
--   * admin_unmerge_customer(brand, merged): split a merged customer back out →
--     clear merged_into, lifecycle='split', close the live brain_id_alias (valid_to).
--
-- WHY SECURITY DEFINER: merge_review_queue has no UPDATE grant for brain_app (status flip),
-- and these multi-table graph mutations must be atomic + consistent in ONE place. Both are
-- strictly scoped to the passed brand_id — no cross-tenant mutation. SET search_path = public.
--
-- ADDITIVE ONLY (I-E02): CREATE OR REPLACE FUNCTION.
-- ROLLBACK: DROP FUNCTION IF EXISTS resolve_merge_review(uuid,uuid,text), admin_unmerge_customer(uuid,uuid);

CREATE OR REPLACE FUNCTION resolve_merge_review(p_brand_id uuid, p_review_id uuid, p_decision text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_a        uuid;  -- canonical
  v_b        uuid;  -- merged-away
  v_status   text;
  v_merge_id uuid;
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
  v_merge_id := gen_random_uuid();

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

CREATE OR REPLACE FUNCTION admin_unmerge_customer(p_brand_id uuid, p_merged uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_state text;
BEGIN
  SELECT lifecycle_state INTO v_state
    FROM customer WHERE brand_id = p_brand_id AND brain_id = p_merged;

  IF v_state IS NULL THEN
    RETURN jsonb_build_object('unmerged', false, 'reason', 'not_found');
  END IF;
  IF v_state <> 'merged' THEN
    RETURN jsonb_build_object('unmerged', false, 'reason', 'not_merged');
  END IF;

  UPDATE customer SET merged_into = NULL, lifecycle_state = 'split'
   WHERE brand_id = p_brand_id AND brain_id = p_merged;

  -- Close the live alias (history is never rewritten — valid_to bounds it).
  UPDATE brain_id_alias SET valid_to = NOW()
   WHERE brand_id = p_brand_id AND observed_brain_id = p_merged AND valid_to IS NULL;

  INSERT INTO identity_audit (brand_id, brain_id, action, detail)
  VALUES (p_brand_id, p_merged, 'unmerge', jsonb_build_object('source', 'admin'));

  RETURN jsonb_build_object('unmerged', true, 'brain_id', p_merged);
END;
$$;

GRANT EXECUTE ON FUNCTION resolve_merge_review(uuid, uuid, text) TO brain_app;
GRANT EXECUTE ON FUNCTION admin_unmerge_customer(uuid, uuid) TO brain_app;

-- ── Migration-time assertion: both fns are SECURITY DEFINER with pinned search_path ──
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosecdef, array_to_string(p.proconfig, ',') AS cfg
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('resolve_merge_review', 'admin_unmerge_customer')
  LOOP
    IF r.prosecdef IS NOT TRUE THEN
      RAISE EXCEPTION 'MERGE-ADMIN GUARD: %() must be SECURITY DEFINER.', r.proname;
    END IF;
    IF r.cfg IS NULL OR r.cfg NOT LIKE '%search_path=public%' THEN
      RAISE EXCEPTION 'MERGE-ADMIN GUARD: %() must pin SET search_path = public.', r.proname;
    END IF;
  END LOOP;
END
$$;
