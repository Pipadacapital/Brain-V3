-- 0081_drop_partition_legacy_tables.sql
--
-- DB-AUDIT C4b (operational follow-up #2) — drop the *_legacy tables left behind by the twin-swap
-- partition migrations (0072–0079). Each partition migration renamed the original table to <name>_legacy
-- and retained it for a post-deploy verification window. The partitioned twins are verified serving
-- reads + writes (row counts preserved; live + drift-guard test suites green), so the legacy copies are
-- now dead weight (they double the storage of the largest tables, e.g. identity_audit's 172k rows).
--
-- DEV: applied now (data is disposable; twins verified).
-- PROD DEPLOY GATE: run this ONLY after the partitioned tables are confirmed serving prod reads + writes
-- for the bake window. Until then the *_legacy tables are the instant rollback (rename back). Dropping is
-- irreversible — that is why it is a SEPARATE, deploy-gated migration, not folded into the swaps.
--
-- IF EXISTS so this is safe to run on an environment where a given partition migration has not landed.

DROP TABLE IF EXISTS billing.realized_revenue_ledger_legacy;
DROP TABLE IF EXISTS billing.ad_spend_ledger_legacy;
DROP TABLE IF EXISTS billing.tax_ledger_legacy;
DROP TABLE IF EXISTS audit.dq_check_result_legacy;
DROP TABLE IF EXISTS audit.identity_audit_legacy;
DROP TABLE IF EXISTS audit.decision_log_legacy;
DROP TABLE IF EXISTS audit.send_log_legacy;

-- Guard: no *_legacy partition-twin tables remain in the partitioned schemas.
DO $$
DECLARE leftover int;
BEGIN
  SELECT count(*) INTO leftover
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('billing','audit')
    AND c.relkind = 'r'
    AND c.relname LIKE '%\_legacy';
  IF leftover <> 0 THEN
    RAISE EXCEPTION '0081: % *_legacy table(s) still present after drop', leftover;
  END IF;
END $$;
