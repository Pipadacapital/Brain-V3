-- ============================================================================
-- 0112_reconnect_required_repull_backoff.sql — Additive: stop the ingest
--   scheduler from re-claiming RECONNECT_REQUIRED connectors every interval.
-- ============================================================================
-- DEFECT this closes (production-relevant; observed live):
--   claim_due_repull_connectors (0053 → 0106) claims EVERY status='connected'
--   connector whose next_repull_at <= now() and stamps it ahead. A connector whose
--   credential is GONE (secret deleted/rotated → the repull fails with
--   RECONNECT_REQUIRED) keeps status='connected' — only its connector_sync_status
--   row flips to state='error'. So the scheduler RE-CLAIMS it every interval (~45s)
--   and RE-DISPATCHES a repull that can only fail again: an infinite, error-level
--   retry loop. In production that is permanent alert fatigue (ingest_scheduler_
--   dispatch_error_total climbs forever) + wasted Secrets-Manager / vendor calls,
--   for a state that ONLY a human reconnect can clear.
--
-- FIX (surgical, self-healing, no job-code churn):
--   Exclude a connector from the due-claim while it is in a TERMINAL reconnect-
--   required error state — i.e. connector_sync_status.state='error' AND last_error
--   names RECONNECT_REQUIRED — for a bounded back-off window after its last failure
--   (keyed on connector_sync_status.updated_at, which every failing repull bumps).
--
--   • SURGICAL: only the terminal RECONNECT_REQUIRED state is parked. TRANSIENT
--     errors (a flaky vendor, a 500, 'page_error') do NOT match the last_error
--     predicate, so they keep fast-retrying — freshness is not penalised for blips.
--   • SELF-HEALING: a reconnect writes connector_sync_status state='connected' with
--     last_error=NULL (setSyncState). The NOT EXISTS no longer matches → the
--     connector is immediately claimable again. No reset job, no flag to clear.
--   • BOUNDED: even if a still-broken connector is never reconnected, it is re-tried
--     at most once per BACKOFF window (30 min) instead of ~every 45s — a ~40x drop
--     in spam/load — and re-parks itself on the next failure.
--
-- Pure CREATE OR REPLACE of the claim function — same 2-arg signature (callers
-- unchanged), same SECURITY DEFINER + pinned search_path, same FOR UPDATE SKIP
-- LOCKED work-queue semantics, same 0106 ad-activation gate. Idempotent.
-- Reversible: re-apply the 0106 body to drop the back-off clause.
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
  WITH due AS (
    SELECT ci.id
      FROM connectors.connector_instance ci
     WHERE ci.status = 'connected'
       AND (ci.next_repull_at IS NULL OR ci.next_repull_at <= now())
       -- 0106: ad-platform connectors must be activated to be claimed; non-ad providers unaffected.
       AND (ci.provider NOT IN ('meta', 'google_ads') OR ci.activated_at IS NOT NULL)
       -- 0112: park connectors in the TERMINAL reconnect-required error state. A repull that needs a
       -- human reconnect (secret gone) can only fail again; re-try it at most once per back-off window
       -- (30 min) instead of every interval. Reconnect clears state/last_error → immediately claimable.
       -- Transient errors don't carry RECONNECT_REQUIRED in last_error → they keep fast-retrying.
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

-- ── post-condition guards (mirror 0053/0106 invariants) ─────────────────────
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
    RAISE EXCEPTION '0112 failed: claim_due_repull_connectors must remain SECURITY DEFINER with a pinned search_path';
  END IF;

  -- the back-off depends on connector_sync_status.last_error + updated_at existing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'connectors' AND table_name = 'connector_sync_status'
       AND column_name = 'last_error'
  ) THEN
    RAISE EXCEPTION '0112 failed: connectors.connector_sync_status.last_error not found';
  END IF;
END $$;
