-- 0084_partition_child_rls_lockdown.sql
--
-- SECURITY P0 (audit C1) — close a cross-brand leak introduced by the C4b partitioning (0072–0083).
--
-- PostgreSQL RLS + grants are NOT inherited by partition children: ENABLE/FORCE RLS + the isolation
-- policy + the REVOKE on the partitioned PARENT protect only PARENT-routed access. A child partition
-- (e.g. billing.realized_revenue_ledger_p2026_06) is created with RLS OFF, and the schema-wide
-- ALTER DEFAULT PRIVILEGES (0063/0066) auto-grants brain_app SELECT/INSERT/UPDATE/DELETE on it. So a
-- query that addresses a CHILD directly bypasses tenant isolation entirely AND can mutate the
-- append-only money ledger. Verified live as brain_app (NOBYPASSRLS) with no brand GUC: the parent
-- returned 0 rows but ...ledger_p2026_06 returned 1,559 rows across 3 brands.
--
-- FIX (defense-in-depth, both layers):
--   1. REVOKE ALL on every child from brain_app — the app only ever touches the PARTITIONED PARENT, and
--      PG checks the PARENT's privileges for routed INSERT/SELECT/UPDATE/DELETE, so children need no
--      brain_app grant. This alone closes the leak (direct child access → permission denied).
--   2. ENABLE + FORCE RLS + the same brand-isolation policy on every child — so even if a grant is ever
--      re-added (e.g. a future ALTER DEFAULT PRIVILEGES), a direct child read is still row-filtered.
-- Applies to EVERY child of EVERY partitioned, brand-scoped table — discovered from pg_catalog, so it
-- self-covers all 8 current partitioned tables and any future one.

-- ── 1. Secure all EXISTING child partitions ─────────────────────────────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema, c.relname AS child
    FROM pg_inherits i
    JOIN pg_class c       ON c.oid = i.inhrelid
    JOIN pg_namespace n   ON n.oid = c.relnamespace
    JOIN pg_partitioned_table pt ON pt.partrelid = i.inhparent
    WHERE EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = i.inhparent AND a.attname = 'brand_id' AND NOT a.attisdropped
    )
  LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM brain_app', r.schema, r.child);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schema, r.child);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', r.schema, r.child);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.child || '_isolation', r.schema, r.child);
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I AS PERMISSIVE FOR ALL TO brain_app USING (brand_id = current_setting(''app.current_brand_id'', TRUE)::uuid)',
      r.child || '_isolation', r.schema, r.child);
  END LOOP;
END $$;

-- ── 2. Make the maintenance routine BORN-SECURE: every new child it creates is locked the same way ───
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
  has_brand  boolean;
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
    IF keycol IS NULL THEN CONTINUE; END IF;
    -- Brand-scoped tables get child RLS lockdown (audit C1); non-tenant tables just get the partition.
    SELECT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = r.reloid AND a.attname = 'brand_id'
                   AND NOT a.attisdropped) INTO has_brand;

    -- ── CREATE-AHEAD ────────────────────────────────────────────────────────────────────────────
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
        -- BORN-SECURE (audit C1): the app only touches the parent, so the child needs no brain_app
        -- grant; REVOKE ALL + FORCE RLS + isolation policy so a direct child reference can never leak.
        IF has_brand THEN
          EXECUTE format('REVOKE ALL ON %I.%I FROM brain_app', r.schema, pname);
          EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schema, pname);
          EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', r.schema, pname);
          EXECUTE format(
            'CREATE POLICY %I ON %I.%I AS PERMISSIVE FOR ALL TO brain_app USING (brand_id = current_setting(''app.current_brand_id'', TRUE)::uuid)',
            pname || '_isolation', r.schema, pname);
        END IF;
        action := 'created'; partition := r.schema || '.' || pname; RETURN NEXT;
      END IF;
    END LOOP;

    -- ── DROP-OLD (opt-in retention) ─────────────────────────────────────────────────────────────
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

-- ── 3. Guard: no brand-scoped child partition may be left RLS-disabled ───────────────────────────────
DO $$
DECLARE leak int;
BEGIN
  SELECT count(*) INTO leak
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_partitioned_table pt ON pt.partrelid = i.inhparent
  WHERE NOT c.relrowsecurity
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = i.inhparent
                AND a.attname = 'brand_id' AND NOT a.attisdropped);
  IF leak <> 0 THEN
    RAISE EXCEPTION '0084: % brand-scoped child partition(s) still have RLS disabled', leak;
  END IF;
END $$;
