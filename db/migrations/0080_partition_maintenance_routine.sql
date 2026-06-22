-- 0080_partition_maintenance_routine.sql
--
-- DB-AUDIT C4b (operational follow-up) — partition lifecycle management for the RANGE-partitioned
-- tables (0072–0079). pg_partman / pg_cron are NOT installed in this environment, so this is a
-- self-contained, catalog-driven routine that:
--   • CREATE-AHEAD: ensures the current month + the next N months have a partition on EVERY
--     time-RANGE-partitioned table (so inserts never fall into the DEFAULT catch-all or fail).
--   • DROP-OLD (opt-in): drops partitions whose upper bound is older than a retention horizon
--     (never the DEFAULT partition; retention disabled unless p_retention_months is passed).
-- It auto-discovers partitioned tables from pg_catalog, so new partitioned tables are covered with
-- zero changes. Idempotent: re-running only creates what's missing / drops what's aged out.
--
-- Naming matches the seed migrations: <table>_pYYYY_MM. Bounds are month-aligned [first, next-first).
-- Date-literal bounds cast correctly to both `date` (ad_spend stat_date, ledger occurred_date) and
-- `timestamptz` (audit logs) partition keys.
--
-- SECURITY DEFINER (owned by superuser `brain`) so the scheduled caller can run partition DDL without
-- holding broad DDL grants. All identifiers/literals are passed through format() %I/%L (the names come
-- from pg_catalog + month arithmetic — no untrusted input). EXECUTE granted to brain_app so the
-- stream-worker maintenance job (apps/stream-worker/src/jobs/partition-maintenance.ts) can invoke it.
-- PROD: a CronJob (or pg_cron/pg_partman if later installed) calls SELECT maintain_time_partitions(3, 24).

CREATE OR REPLACE FUNCTION public.maintain_time_partitions(
  p_ahead_months     int DEFAULT 3,
  p_retention_months int DEFAULT NULL
) RETURNS TABLE(action text, partition text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  r          record;
  keycol     text;
  m          int;
  mstart     date;
  mend       date;
  pname      text;
  cutoff     date;
  child      record;
  upper_txt  text;
  upper_date date;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema, c.relname AS tbl, c.oid AS reloid,
           pg_get_partkeydef(c.oid) AS partkeydef
    FROM pg_partitioned_table p
    JOIN pg_class c     ON c.oid = p.partrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pg_get_partkeydef(c.oid) ILIKE 'RANGE (%'
  LOOP
    keycol := trim((regexp_match(r.partkeydef, '^RANGE \(([^,)]+)\)'))[1]);
    IF keycol IS NULL THEN CONTINUE; END IF;   -- skip multi-column / expression range keys

    -- ── CREATE-AHEAD: current month .. +p_ahead_months ──────────────────────────────
    FOR m IN 0..GREATEST(p_ahead_months, 0) LOOP
      mstart := (date_trunc('month', now())::date + (m || ' months')::interval)::date;
      mend   := (mstart + interval '1 month')::date;
      pname  := r.tbl || '_p' || to_char(mstart, 'YYYY_MM');
      IF NOT EXISTS (
        SELECT 1 FROM pg_class cc JOIN pg_namespace nn ON nn.oid = cc.relnamespace
        WHERE nn.nspname = r.schema AND cc.relname = pname
      ) THEN
        EXECUTE format('CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
                       r.schema, pname, r.schema, r.tbl, mstart::text, mend::text);
        action := 'created'; partition := r.schema || '.' || pname; RETURN NEXT;
      END IF;
    END LOOP;

    -- ── DROP-OLD (opt-in retention) ─────────────────────────────────────────────────
    IF p_retention_months IS NOT NULL THEN
      cutoff := (date_trunc('month', now())::date - (p_retention_months || ' months')::interval)::date;
      FOR child IN
        SELECT cc.oid, nn.nspname AS schema, cc.relname AS pname,
               pg_get_expr(cc.relpartbound, cc.oid) AS bound
        FROM pg_inherits i
        JOIN pg_class cc     ON cc.oid = i.inhrelid
        JOIN pg_namespace nn ON nn.oid = cc.relnamespace
        WHERE i.inhparent = r.reloid
      LOOP
        IF child.bound IS NULL OR child.bound ILIKE '%DEFAULT%' THEN CONTINUE; END IF;
        upper_txt := (regexp_match(child.bound, 'TO \(''([^'']+)''\)'))[1];
        IF upper_txt IS NULL THEN CONTINUE; END IF;
        BEGIN
          upper_date := upper_txt::date;
        EXCEPTION WHEN others THEN CONTINUE; END;
        IF upper_date <= cutoff THEN
          EXECUTE format('DROP TABLE %I.%I', child.schema, child.pname);
          action := 'dropped'; partition := child.schema || '.' || child.pname; RETURN NEXT;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$fn$;

COMMENT ON FUNCTION public.maintain_time_partitions(int, int) IS
  'C4b partition lifecycle: create-ahead current+N months on every RANGE-partitioned table; '
  'optionally drop partitions older than a retention horizon (never the DEFAULT). Idempotent.';

GRANT EXECUTE ON FUNCTION public.maintain_time_partitions(int, int) TO brain_app;
