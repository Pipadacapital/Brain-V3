-- 0098_drop_realized_revenue_ledger.sql
--
-- MEDALLION REALIGNMENT (Epic 1 / decision B): REMOVE REVENUE FROM POSTGRESQL.
--
-- The revenue recognition ledger is now the Bronze-sourced lakehouse table
-- brain_gold.gold_revenue_ledger (dbt: silver_order_recognition → gold_revenue_ledger, rebuilt by the
-- `recognition-refresh` cron from collector_events order.live.v1 + gokwik.awb_status.v1). Every reader
-- AND the write path have been migrated off the PostgreSQL ledger:
--   - billing meter / inspectable bill / invoice  → computeRealizedGmvForPeriod / ...Composition... (gold)
--   - dashboards (revenue/kpi/order-stats/recognition) → withSilverBrand over gold
--   - brand currency-immutability guard, CAPI feed, journey-stitch, ai/ask-brain → gold
--   - attribution credit basis (reconcile-attribution) → gold
--   - recommendation signals (rto / realization / cm2-revenue) → metric-engine seams over gold
--   - WRITE PATH (LedgerWriter revenue methods, revenue-finalization, Live/Settlement/Shipment ledger
--     consumers, measurement module) → DELETED (recognition is a dbt build from Bronze).
--
-- This migration drops the PG ledger and its now-unused as-of / signal functions + the obsolete
-- StarRocks read-shim view. ad_spend_ledger / tax_ledger remain PG (separate, out of Epic-1 scope).
--
-- DESTRUCTIVE + IRREVERSIBLE for the PG copy. Safe because the lakehouse gold ledger is the proven SoR
-- (billing 20/20, attribution 14/14, recommendation 28/28, analytics suites green against gold).
-- ROLLBACK: restore from 0017/0020/0040/0041/0044/0045/0056/0073/0097 (the ledger + its functions).

-- ── 1. Drop the dependent functions (recommendation signals first, then the as-of seams) ──
DROP FUNCTION IF EXISTS rto_risk_signal_for_brand(uuid) CASCADE;
DROP FUNCTION IF EXISTS realization_signal_for_brand(uuid) CASCADE;
DROP FUNCTION IF EXISTS cm2_signal_for_brand(uuid) CASCADE;
DROP FUNCTION IF EXISTS realized_gmv_composition_for_period(uuid, character) CASCADE;
DROP FUNCTION IF EXISTS realized_gmv_for_period(uuid, character) CASCADE;
DROP FUNCTION IF EXISTS realized_gmv_as_of(uuid, date) CASCADE;
DROP FUNCTION IF EXISTS provisional_gmv_as_of(uuid, date) CASCADE;

-- ── 2. Drop the obsolete StarRocks JDBC read-shim view over the PG ledger ──
-- silver_order_ledger_src fed the OLD dbt stg_order_ledger_events (deleted); Silver now builds from
-- Bronze (stg_order_events_bronze). CASCADE on the table would drop it too; explicit for clarity.
DROP VIEW IF EXISTS silver_order_ledger_src CASCADE;

-- ── 3. Drop the partitioned ledger itself (parent + all RANGE partition children + currency trigger) ──
-- Schema-qualified: the ledger was moved to the billing schema by the Phase-A split (migration 0065).
DROP TABLE IF EXISTS billing.realized_revenue_ledger CASCADE;

-- ── 4. Migration-time assertion: the ledger + its functions are gone ──
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'realized_revenue_ledger') THEN
    RAISE EXCEPTION 'DROP GUARD (0098): realized_revenue_ledger still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname IN
       ('realized_gmv_as_of','provisional_gmv_as_of','realized_gmv_for_period',
        'realized_gmv_composition_for_period','rto_risk_signal_for_brand',
        'realization_signal_for_brand','cm2_signal_for_brand')) THEN
    RAISE EXCEPTION 'DROP GUARD (0098): a revenue-ledger function still exists.';
  END IF;
END
$$;
