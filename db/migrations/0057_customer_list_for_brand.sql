-- 0057_customer_list_for_brand.sql
--
-- feat-identity-customer-browse — the discover front-door for the identity control-plane.
--
-- Customer 360 (0017/get-customer-360) can only RESOLVE a customer you already know the brain_id
-- of — there is no way to BROWSE or FIND one. This adds a single SECURITY INVOKER read seam that
-- returns a paginated, filterable list of customer summaries for the active brand, so an operator
-- can land on a customer (then drill into 360 / merge / unmerge / erase, all of which already exist).
--
-- PII discipline (I-S02): this returns NO raw PII. Identifiers are never selected; only the COUNT of
-- active links per customer is exposed. Search-by-email/phone is done by the BFF HASHING the operator's
-- input with the per-brand salt (@brain/identity-core, same hash the resolver wrote) and passing the
-- resulting 64-hex hash(es) here — the raw value never reaches Postgres.
--
-- RLS applies (SECURITY INVOKER): the function runs under the caller's brain_app role + the
-- app.current_brand_id GUC, so it can only ever see the active brand's customers. The explicit
-- `WHERE brand_id = p_brand_id` is belt-and-suspenders on top of the RLS policy.
--
-- Pagination: COUNT(*) OVER() returns the pre-LIMIT total on every row so the UI can page honestly.

CREATE OR REPLACE FUNCTION customer_list_for_brand(
    p_brand_id          UUID,
    p_lifecycle         TEXT,       -- NULL/'' = any lifecycle; else exact match (anonymous|active|merged|split|erased)
    p_identifier_hashes TEXT[],     -- NULL/empty = no identifier filter; else restrict to customers with an
                                    -- ACTIVE identity_link whose salted hash is in this set (search-by-PII)
    p_limit             INT,
    p_offset            INT
  )
  RETURNS TABLE (
    brain_id               UUID,
    anonymous_id           TEXT,
    lifecycle_state        TEXT,
    merged_into            UUID,
    ai_processing_consent  BOOLEAN,
    resolution_consent     BOOLEAN,
    identifier_count       BIGINT,   -- distinct ACTIVE linked identifiers (count only — never the values)
    last_identifier_at     TIMESTAMPTZ,
    created_at             TIMESTAMPTZ,
    total_count            BIGINT    -- pre-LIMIT total for this filter (same on every row)
  )
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
  SET search_path = public
AS $$
  WITH filtered AS (
    SELECT
      c.brain_id,
      c.anonymous_id,
      c.lifecycle_state,
      c.merged_into,
      c.ai_processing_consent,
      c.resolution_consent,
      c.created_at,
      COALESCE(l.active_count, 0)::bigint AS identifier_count,
      l.last_identifier_at
    FROM customer c
    LEFT JOIN LATERAL (
      SELECT count(*)::bigint AS active_count, max(il.created_at) AS last_identifier_at
        FROM identity_link il
       WHERE il.brand_id = c.brand_id
         AND il.brain_id = c.brain_id
         AND il.is_active = TRUE
    ) l ON TRUE
    WHERE c.brand_id = p_brand_id
      AND (p_lifecycle IS NULL OR p_lifecycle = '' OR c.lifecycle_state = p_lifecycle)
      AND (
        p_identifier_hashes IS NULL
        OR array_length(p_identifier_hashes, 1) IS NULL
        OR EXISTS (
          SELECT 1 FROM identity_link il2
           WHERE il2.brand_id = c.brand_id
             AND il2.brain_id = c.brain_id
             AND il2.is_active = TRUE
             AND il2.identifier_value = ANY(p_identifier_hashes)
        )
      )
  )
  SELECT
    f.brain_id,
    f.anonymous_id,
    f.lifecycle_state,
    f.merged_into,
    f.ai_processing_consent,
    f.resolution_consent,
    f.identifier_count,
    f.last_identifier_at,
    f.created_at,
    count(*) OVER ()::bigint AS total_count
  FROM filtered f
  ORDER BY f.created_at DESC, f.brain_id
  LIMIT GREATEST(p_limit, 0)
  OFFSET GREATEST(p_offset, 0)
$$;

GRANT EXECUTE ON FUNCTION customer_list_for_brand(uuid, text, text[], int, int) TO brain_app;

-- ── Migration-time assertion: SECURITY INVOKER (RLS applies) + pinned search_path ──
DO $$
DECLARE fn_sec TEXT; fn_cfg TEXT;
BEGIN
  SELECT p.prosecdef::text, array_to_string(p.proconfig, ', ')
    INTO fn_sec, fn_cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'customer_list_for_brand' AND n.nspname = 'public';
  IF fn_sec IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'GUARD: customer_list_for_brand must be SECURITY INVOKER (RLS applies). Got prosecdef=%', fn_sec;
  END IF;
  IF fn_cfg IS NULL OR fn_cfg NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION 'GUARD: customer_list_for_brand must pin search_path=public. Got: %', fn_cfg;
  END IF;
END $$;
