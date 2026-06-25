-- 0103_drop_ml_prediction_log.sql
--
-- MEDALLION REALIGNMENT (audit MV-2/DB-2): MODEL-INFERENCE LOG OUT OF OPERATIONAL POSTGRESQL.
--
-- ml.prediction_log (created in 0083, RANGE-partitioned by created_at per C4b) is high-volume,
-- append-only model-inference data — an analytical stream. Like every other such stream it belongs in the
-- lakehouse, NOT in operational PG. It is now written to StarRocks (V4 Phase 5: the operational DB
-- brain_ops.ops_ml_prediction_log, DDL db/starrocks/ops/ops_ml_prediction_log.sql; originally
-- brain_gold.gold_ml_prediction_log before brain_gold's Phase-6 retirement) by the serving path
-- (serveCustomerScore appends each served prediction via the srPool). This migration drops the PG table
-- (CASCADE removes its two partition children
-- — prediction_log_p2026_06 + prediction_log_pdefault — its RLS policy, and its two indexes).
--
-- KEEP: ml.model_registry — it is legitimately operational lifecycle/config (versioning, stage promotion,
-- the partial-unique production invariant; written with UPDATE for promotion). It is NOT dropped.
--
-- DESTRUCTIVE + IRREVERSIBLE for the PG copy (dev rows are disposable; serving now logs to the lakehouse).
-- ROLLBACK: re-create the table from the prediction_log block of 0083_ml_platform_foundation.sql (the
-- partitioned table + its 2 partitions + 2 indexes + RLS policy + the brain_app SELECT,INSERT grant) and
-- re-point serveCustomerScore's append back to PG.

-- ── 1. Drop the partitioned table (CASCADE removes its partition children, policy + indexes). ──
DROP TABLE IF EXISTS ml.prediction_log CASCADE;

-- ── 2. Migration-time assertion: prediction_log (+ its children) are gone; model_registry SURVIVES. ──
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'ml'
       AND c.relname IN ('prediction_log', 'prediction_log_p2026_06', 'prediction_log_pdefault')
  ) THEN
    RAISE EXCEPTION 'DROP GUARD (0103): ml.prediction_log (or a partition child) still exists.';
  END IF;
  -- model_registry is operational lifecycle config — it must SURVIVE (MV-2/DB-2 keeps it in PG).
  IF to_regclass('ml.model_registry') IS NULL THEN
    RAISE EXCEPTION 'DROP GUARD (0103): ml.model_registry must SURVIVE — it does not.';
  END IF;
END
$$;
