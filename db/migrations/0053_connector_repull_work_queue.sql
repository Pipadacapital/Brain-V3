-- 0053_connector_repull_work_queue.sql
--
-- P1 pre-scale: replace poll-everything-every-45s with a DUE-TIME WORK QUEUE.
--
-- The ingest scheduler enumerated EVERY connected connector every tick and dispatched each repull
-- sequentially in a single replica — a model that cannot finish within its interval past ~500
-- brands (ingest freshness silently slips). This adds a per-connector next_repull_at and a
-- SECURITY DEFINER claim function so every replica can CLAIM a disjoint batch of DUE connectors
-- (FOR UPDATE SKIP LOCKED) and process them in PARALLEL — no replica ordinals, naturally
-- load-balanced, each connector dispatched at most once per interval.
--
-- ADDITIVE ONLY (I-E02): a nullable column (NULL = due immediately) + a partial index + a new fn.
--
-- system-job-force-rls-enumeration: the claim crosses tenants, so it is SECURITY DEFINER (owned by
-- 'brain', bypasses FORCE RLS for the cross-brand claim). The atomic claim+stamp makes it safe for
-- concurrent replicas; the brand-scoped repull that follows runs under its OWN per-brand GUC.

ALTER TABLE connector_instance
  ADD COLUMN IF NOT EXISTS next_repull_at TIMESTAMPTZ NULL; -- NULL = due now (never claimed yet)

-- Due-scan index: connected connectors ordered by due time (NULLs first = never-claimed go first).
CREATE INDEX IF NOT EXISTS connector_instance_due_repull_idx
  ON connector_instance (next_repull_at)
  WHERE status = 'connected';

-- ── claim_due_repull_connectors(batch, interval_seconds) ─────────────────────
-- Atomically claim up to `batch` connected connectors whose next_repull_at is due (NULL or <= now),
-- stamp their next_repull_at = now() + interval (so other replicas / later ticks skip them until
-- due again), and RETURN the claimed rows. SKIP LOCKED → two replicas claim DISJOINT sets.
CREATE OR REPLACE FUNCTION claim_due_repull_connectors(p_batch INT, p_interval_seconds INT)
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    provider               text
  )
  LANGUAGE sql
  VOLATILE
  SECURITY DEFINER
  SET search_path = public
AS $$
  WITH due AS (
    SELECT id
      FROM connector_instance
     WHERE status = 'connected'
       AND (next_repull_at IS NULL OR next_repull_at <= now())
     ORDER BY next_repull_at ASC NULLS FIRST
     FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(p_batch, 0)
  )
  UPDATE connector_instance ci
     SET next_repull_at = now() + make_interval(secs => GREATEST(p_interval_seconds, 1)),
         updated_at     = now()
    FROM due
   WHERE ci.id = due.id
  RETURNING ci.id AS connector_instance_id, ci.brand_id, ci.provider
$$;

GRANT EXECUTE ON FUNCTION claim_due_repull_connectors(INT, INT) TO brain_app;

-- ── Migration-time assertion: SECURITY DEFINER + pinned search_path (anti-hijack) ──
DO $$
DECLARE
  fn_security TEXT;
  fn_config   TEXT;
BEGIN
  SELECT p.prosecdef::text, array_to_string(p.proconfig, ', ')
    INTO fn_security, fn_config
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'claim_due_repull_connectors'
     AND n.nspname = 'public';

  IF fn_security IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'GUARD: claim_due_repull_connectors() must be SECURITY DEFINER. Got: %', fn_security;
  END IF;
  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION 'GUARD: claim_due_repull_connectors() must pin search_path=public. Got: %', fn_config;
  END IF;
END $$;
