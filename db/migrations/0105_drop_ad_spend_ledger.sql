-- 0105_drop_ad_spend_ledger.sql
--
-- MEDALLION REALIGNMENT (audit deviation B — marketing ledger out of operational PostgreSQL):
-- ad spend is ANALYTICAL data, not operational state, so it belongs in the lakehouse, not PG.
--
-- The spend lineage is now: meta/google repull → spend.live.v1 (live lane) → Spark Bronze sink
-- (server-trusted) → brain_bronze.collector_events (Iceberg, the SoR) → dbt stg_ad_spend_bronze →
-- brain_silver.silver_marketing_spend. Every analytical reader (ad-spend-timeseries, blended-roas,
-- channel/campaign ROAS, CM2 marketing) already reads silver_marketing_spend via withSilverBrand.
--
-- billing.ad_spend_ledger (created 0029, schema-moved 0065, partitioned 0074, granted UPDATE 0104) was
-- a SECOND, divergent sink fed by the now-REMOVED SpendLedgerConsumer (a dual-write that produced a
-- PG-vs-Bronze count drift). With the consumer removed it has NO writer and NO reader — it is a pure
-- orphan. This migration drops it (CASCADE removes its RANGE partition children, RLS policy, indexes,
-- grants) and the ad_spend_as_of() read seam (its last PG caller, cm2_signal_for_brand, was already
-- dropped with realized_revenue_ledger). Bronze is the SOLE spend SoR; dedup is the deterministic
-- spend event_id (uuidV5FromSpendRow) under the Bronze MERGE.
--
-- DESTRUCTIVE + IRREVERSIBLE for the PG copy (dev rows are disposable; the analytical history lives in
-- Bronze/Silver). ROLLBACK: re-create from 0029 (table + ad_spend_as_of) + 0074 (partitioning) +
-- 0104 (grant), and re-wire the SpendLedgerConsumer in apps/stream-worker/src/main.ts.

-- ── 1. Drop the read seam first (depends on the table), then the table (CASCADE = partitions/policy/idx). ──
DROP FUNCTION IF EXISTS ad_spend_as_of(uuid, date, date);
DROP FUNCTION IF EXISTS billing.ad_spend_as_of(uuid, date, date);
DROP TABLE IF EXISTS billing.ad_spend_ledger CASCADE;

-- ── 2. Migration-time assertion: the table + its read seam are gone. ──
DO $$
BEGIN
  IF to_regclass('billing.ad_spend_ledger') IS NOT NULL THEN
    RAISE EXCEPTION 'DROP GUARD (0105): billing.ad_spend_ledger still exists.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'ad_spend_as_of'
  ) THEN
    RAISE EXCEPTION 'DROP GUARD (0105): ad_spend_as_of() still exists.';
  END IF;
END
$$;
