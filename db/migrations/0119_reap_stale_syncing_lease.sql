-- ============================================================================
-- 0119_reap_stale_syncing_lease.sql — Additive: make the ingest scheduler
--   self-heal a stranded connector_sync_status.state='syncing' lease.
-- ============================================================================
-- DEFECT this closes (CRIT-1; observed live — Bodd Active frozen 13h34m):
--   The repull marks connector_sync_status.state='syncing' at the START of a run
--   (claimSyncingState) and only clears it (→ 'connected'/'error') when the run
--   FINISHES (setSyncState). If the worker CRASHES, is OOM-killed, or the pod is
--   evicted mid-repull, the row is stranded in 'syncing' FOREVER. Nothing reaps it:
--   migration 0112 only parks the TERMINAL 'error'+RECONNECT_REQUIRED state; the
--   scheduler's claim_due_repull_connectors keys off connector_instance.status, which
--   is still 'connected', so it KEEPS dispatching repulls — but each dispatched repull
--   re-hits claimSyncingState whose CAS used to require state <> 'syncing', returned 0
--   rows on the stranded lease, and SKIPPED. Live ingestion freezes permanently with
--   no error surfaced (the tile still reads 'connected'/'syncing'), so no alert fires.
--
-- TWO-PART FIX (the job side + this scheduler side — defense in depth):
--   (a) shopify-repull claimSyncingState CAS now ALSO wins when the existing 'syncing'
--       lease is STALE (updated_at < now() - 15 min) → a dispatched repull re-claims an
--       abandoned lease itself. (apps/stream-worker/src/jobs/shopify-repull/run.ts)
--   (b) THIS migration: the scheduler reaps the stale lease proactively, so the stuck
--       state is SURFACED (→ 'error', visible on the tile + claimable) even if the repull
--       dispatch path changes, and freshness self-heals on the very next tick.
--
-- HOW (surgical, no job-code churn, mirrors 0112's in-place extend of the claim fn):
--   CREATE OR REPLACE claim_due_repull_connectors with the EXACT 0112 body PLUS a leading
--   data-modifying CTE `reaped` that flips any connector_sync_status row stuck in 'syncing'
--   past the lease window (15 min) to a TRANSIENT 'error' (last_error='REPULL_LEASE_EXPIRED
--   …', NOT RECONNECT_REQUIRED). Because the claim fn runs every scheduler tick (~45s), the
--   reap is automatic — no new caller, no stream-worker change.
--
--   • LEASE = 15 min — comfortably above the scheduler's 5-min DISPATCH_DEADLINE_MS, so a
--     legitimately in-flight repull (whose 'syncing' updated_at is < 5 min old) is NEVER
--     reaped. Matches the broadened claimSyncingState CAS window exactly.
--   • TRANSIENT, not RECONNECT_REQUIRED — the reaped 'error' does NOT match the 0112 park
--     predicate (LIKE '%RECONNECT_REQUIRED%'), so the connector stays immediately claimable
--     and re-dispatches; the next successful repull writes state='connected' (setSyncState).
--   • DIFFERENT TARGET TABLE — `reaped` updates connectors.connector_sync_status while the
--     claim updates connectors.connector_instance: two independent data-modifying CTEs in one
--     statement (Postgres runs each to completion under one snapshot; no self-interference).
--   • SELF-HEALING / BOUNDED — once reaped to 'error' the lease is gone; a fresh repull
--     re-claims and clears it. Re-running this migration is idempotent.
--
-- Pure CREATE OR REPLACE — same 2-arg signature (callers unchanged), same SECURITY DEFINER +
-- pinned search_path, same FOR UPDATE SKIP LOCKED work-queue semantics, same 0106 ad-activation
-- gate and 0112 RECONNECT_REQUIRED back-off. Reversible: re-apply the 0112 body to drop the reap.
-- ============================================================================

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

GRANT EXECUTE ON FUNCTION claim_due_repull_connectors(INT, INT) TO brain_app;

-- ── post-condition guards (mirror 0053/0106/0112 invariants) ────────────────
DO $$
BEGIN
  -- function remains SECURITY DEFINER with a pinned search_path (0029/0053 invariant preserved)
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'claim_due_repull_connectors'
       AND p.prosecdef = true
       AND p.proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0119 failed: claim_due_repull_connectors must remain SECURITY DEFINER with a pinned search_path';
  END IF;

  -- the reaper depends on connector_sync_status.state + updated_at existing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'connectors' AND table_name = 'connector_sync_status'
       AND column_name = 'updated_at'
  ) THEN
    RAISE EXCEPTION '0119 failed: connectors.connector_sync_status.updated_at not found';
  END IF;
END $$;
