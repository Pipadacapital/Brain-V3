-- 0099_drop_attribution_credit_ledger.sql
--
-- MEDALLION REALIGNMENT (Epic 2): ATTRIBUTION OUT OF POSTGRESQL.
--
-- The attribution credit/clawback ledger is now the app-written StarRocks table
-- brain_gold.gold_attribution_credit (db/starrocks/gold_attribution_credit.sql). The reconcile batch
-- job (AttributionCreditWriter) computes the per-touch credit rows in TypeScript (the metric-engine is
-- the SOLE math layer — exact signed BIGINT, deterministic credit_id, Markov for data_driven) and writes
-- them there; gold_marketing_attribution is a dbt VIEW over it. Every reader is migrated:
--   - dashboard (channel-roas / reconciliation / campaign-roas / hasAttributionCredit) → gold_marketing_attribution
--   - reconcile idempotency filter + writer read-own-writes (saved credits, clawed-back total) → gold
--   - data-quality attribution-confidence floor → gold (via srPool)
-- The PG→Bronze Spark materializer (attribution_credit_materialize.py) + the gold_attribution_credit_src
-- read-shim view + the iceberg/pg dbt sources are deleted.
--
-- DESTRUCTIVE + IRREVERSIBLE for the PG copy. Safe: the lakehouse ledger is the proven SoR (attribution
-- 14/14 live suites green against gold; the dashboard reads gold). ROLLBACK: restore from 0032 (+ 0073
-- partitioning if applied) and re-point the writer/readers to PG.

-- ── 1. Drop the obsolete StarRocks JDBC read-shim view over the PG ledger ──
DROP VIEW IF EXISTS gold_attribution_credit_src CASCADE;

-- ── 2. Drop the as-of seam functions (no app reads them — the metric-engine reads gold) ──
DROP FUNCTION IF EXISTS channel_contribution_as_of(uuid, text, date, date) CASCADE;
DROP FUNCTION IF EXISTS attributed_gmv_as_of(uuid, text, date) CASCADE;

-- ── 3. Drop the ledger itself (parent + any partition children + the dedup index) ──
-- Schema-qualified: moved to the billing schema by the Phase-A split (migration 0065).
DROP TABLE IF EXISTS billing.attribution_credit_ledger CASCADE;

-- ── 4. Migration-time assertion: the ledger + its functions are gone ──
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'attribution_credit_ledger') THEN
    RAISE EXCEPTION 'DROP GUARD (0099): attribution_credit_ledger still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('channel_contribution_as_of', 'attributed_gmv_as_of')) THEN
    RAISE EXCEPTION 'DROP GUARD (0099): an attribution as-of function still exists.';
  END IF;
END
$$;
