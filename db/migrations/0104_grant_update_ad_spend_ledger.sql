-- 0104_grant_update_ad_spend_ledger.sql
--
-- AUDIT PF-9 (stale ad-spend restatement): ad platforms RESTATE spend for a stat_date for 72h+. The
-- ad-spend writer (apps/stream-worker/src/infrastructure/pg/LedgerWriter.ts) changed its dedup
-- ON CONFLICT from DO NOTHING to a guarded DO UPDATE so a corrected re-pull overwrites the stale row
-- instead of being silently dropped (wrong ROAS). brain_app previously held SELECT+INSERT only on
-- billing.ad_spend_ledger (0029 append-only posture); the DO UPDATE now requires UPDATE too.
--
-- The row-level isolation policy is already FOR ALL TO brain_app (0029), so RLS permits the UPDATE
-- (same-brand WITH CHECK); this migration only adds the missing table-level UPDATE privilege.
-- It does NOT widen DELETE — the ledger stays delete-free (I-E02 append/restate, never erase).
--
-- ADDITIVE + IDEMPOTENT: GRANT is idempotent; rollback = REVOKE UPDATE ON billing.ad_spend_ledger FROM brain_app;

GRANT UPDATE ON billing.ad_spend_ledger TO brain_app;

-- Post-condition guard: assert brain_app now holds UPDATE on the ad-spend ledger.
DO $$
BEGIN
  IF NOT has_table_privilege('brain_app', 'billing.ad_spend_ledger', 'UPDATE') THEN
    RAISE EXCEPTION '0104 failed: brain_app lacks UPDATE on billing.ad_spend_ledger';
  END IF;
END $$;
