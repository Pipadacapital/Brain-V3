-- 0093_sync_run_history_ledger.sql
--
-- GAP: sync-run-history-ledger (HIGH)
--
-- connector_sync_status is a single MUTABLE row — there is no per-run audit trail. This migration
-- adds two changes in the additive-then-cutover pattern:
--
--   1. connector_sync_run — a new APPEND-ONLY, brand-scoped, RANGE(started_at)-PARTITIONED table
--      that records every run start + terminal event for every connector job. Born-secure: child
--      partitions are FORCE RLS + isolation policy + REVOKE ALL (matched by maintain_time_partitions
--      per 0084 — it auto-discovers any RANGE-partitioned table with a brand_id column and locks down
--      each new child). GRANT INSERT+SELECT only (no UPDATE/DELETE — append-only ledger).
--
--   2. consecutive_failure_count + first_failure_at on connector_sync_status — for Phase-2 health
--      threshold tracking (alert after N consecutive failures). Additive columns, no backfill needed.
--
-- ROLLBACK:
--   DROP TABLE connectors.connector_sync_run;                            -- cascade drops partitions
--   ALTER TABLE connectors.connector_sync_status
--     DROP COLUMN IF EXISTS consecutive_failure_count,
--     DROP COLUMN IF EXISTS first_failure_at;
--
-- ADDITIVE-ONLY (Brain core rule: prefer small, reversible, auditable changes).
-- ============================================================================

-- ── 1. connector_sync_run — append-only run ledger ────────────────────────────
-- Partitioned on started_at (TIMESTAMPTZ) — the natural partition key for time-ranged queries.
-- PK includes started_at so it is included in every partition's local index without cross-partition
-- scans (Postgres rule: partition key must be in PK for RANGE-partitioned tables).
-- account_key is nullable/sentinel: ad connectors carry an ad_account_id; storefront connectors
-- (shopify/woocommerce) pass NULL (no sub-account discriminator).

CREATE TABLE IF NOT EXISTS connectors.connector_sync_run (
  run_id           UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id         UUID        NOT NULL,             -- RLS anchor; FK validated at parent level
  provider         TEXT        NOT NULL,             -- 'shopify','meta','google_ads','razorpay', etc.
  account_key      TEXT        NULL,                 -- ad_account_id / NULL sentinel for storefronts
  run_type         TEXT        NOT NULL
                     CHECK (run_type IN ('backfill','repull','webhook')),
  status           TEXT        NOT NULL
                     CHECK (status IN ('started','succeeded','failed')),
  started_at       TIMESTAMPTZ NOT NULL,             -- RANGE partition key + PK tail
  finished_at      TIMESTAMPTZ NULL,                 -- NULL while the run is open (status='started')
  rows_ingested    BIGINT      NULL DEFAULT 0,       -- written on close
  error_class      TEXT        NULL,                 -- e.g. 'AUTH_ERROR', 'RATE_LIMITED', 'PAGE_ERROR'
  error_detail     TEXT        NULL,                 -- truncated error message (max 500 chars enforced by app)
  correlation_id   TEXT        NULL,                 -- from job: 'shopify-repull:<ciId>:<runId>'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- PK must include the partition key (started_at) — Postgres requirement for RANGE-partitioned tables.
  PRIMARY KEY (run_id, started_at)
) PARTITION BY RANGE (started_at);

-- ── Indexes on the partitioned parent (inherited by all current + future children) ──
-- Per-brand ordered history: most recent runs first.
CREATE INDEX IF NOT EXISTS connector_sync_run_brand_provider_idx
  ON connectors.connector_sync_run (brand_id, provider, started_at DESC);

-- Audit + alerting query: all failed runs for a brand in a window.
CREATE INDEX IF NOT EXISTS connector_sync_run_brand_status_idx
  ON connectors.connector_sync_run (brand_id, status, started_at);

-- ── RLS: brand isolation ──────────────────────────────────────────────────────
ALTER TABLE connectors.connector_sync_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors.connector_sync_run FORCE ROW LEVEL SECURITY;

CREATE POLICY connector_sync_run_isolation ON connectors.connector_sync_run
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- ── Grants — APPEND-ONLY (no UPDATE/DELETE) ────────────────────────────────────
-- The ledger is immutable: closed runs are recorded as new 'succeeded'/'failed' rows,
-- not by mutating the 'started' row. The writer inserts start + terminal rows separately
-- (same pattern as recommendation_action_ledger 0082).
REVOKE ALL ON connectors.connector_sync_run FROM brain_app;
GRANT SELECT, INSERT ON connectors.connector_sync_run TO brain_app;

-- ── 2. Seed initial partitions (current + next 2 months, born-secure) ─────────
-- The maintain_time_partitions function (0084) auto-discovers this table via pg_catalog
-- (RANGE-partitioned + brand_id column) and will lock down every child it creates.
-- We seed the first three partitions here so the table is immediately usable.
-- Each child gets REVOKE ALL + FORCE RLS + isolation policy (born-secure, per 0084).

DO $$
DECLARE
  m       int;
  mstart  date;
  mend    date;
  pname   text;
  schema  text := 'connectors';
  tbl     text := 'connector_sync_run';
BEGIN
  FOR m IN 0..2 LOOP
    mstart := (date_trunc('month', now())::date + (m || ' months')::interval)::date;
    mend   := (mstart + interval '1 month')::date;
    pname  := tbl || '_p' || to_char(mstart, 'YYYY_MM');

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cc JOIN pg_namespace nn ON nn.oid = cc.relnamespace
      WHERE nn.nspname = schema AND cc.relname = pname
    ) THEN
      EXECUTE format(
        'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
        schema, pname, schema, tbl, mstart::text, mend::text
      );
      -- BORN-SECURE (audit C1 / 0084): REVOKE + FORCE RLS + isolation policy on every child.
      -- maintain_time_partitions (0084) will apply the same lockdown to future children.
      EXECUTE format('REVOKE ALL ON %I.%I FROM brain_app', schema, pname);
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', schema, pname);
      EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', schema, pname);
      EXECUTE format(
        'CREATE POLICY %I ON %I.%I AS PERMISSIVE FOR ALL TO brain_app '
        'USING (brand_id = current_setting(''app.current_brand_id'', TRUE)::uuid)',
        pname || '_isolation', schema, pname
      );
      RAISE NOTICE 'created born-secure partition %.%', schema, pname;
    END IF;
  END LOOP;
END
$$;

-- ── 3. Additive columns on connector_sync_status (Phase-2 health thresholds) ──
-- consecutive_failure_count: incremented on each failed run, reset to 0 on success.
-- first_failure_at: set on the first failure of a streak, cleared on success.
-- Both are additive (no NOT NULL without default) — existing rows stay valid.
ALTER TABLE connectors.connector_sync_status
  ADD COLUMN IF NOT EXISTS consecutive_failure_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_failure_at          TIMESTAMPTZ NULL;

-- ── 4. Structural assertions ───────────────────────────────────────────────────
DO $$
DECLARE
  child_rls_leak int;
  parent_ok      boolean;
BEGIN
  -- Assert parent table has RLS + FORCE.
  SELECT c.relrowsecurity AND c.relforcerowsecurity INTO parent_ok
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'connectors' AND c.relname = 'connector_sync_run';

  IF NOT COALESCE(parent_ok, false) THEN
    RAISE EXCEPTION '0093: connectors.connector_sync_run must have RLS ENABLED + FORCED on parent.';
  END IF;

  -- Assert no brand-scoped child partition is RLS-disabled (0084 contract).
  SELECT count(*) INTO child_rls_leak
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_partitioned_table pt ON pt.partrelid = i.inhparent
  WHERE n.nspname = 'connectors'
    AND NOT c.relrowsecurity
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = i.inhparent AND a.attname = 'brand_id' AND NOT a.attisdropped
    );

  IF child_rls_leak <> 0 THEN
    RAISE EXCEPTION '0093: % brand-scoped connector_sync_run child partition(s) have RLS disabled.', child_rls_leak;
  END IF;

  -- Assert brain_app has NO UPDATE/DELETE on the parent (append-only guard).
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'connectors' AND table_name = 'connector_sync_run'
      AND grantee = 'brain_app' AND privilege_type IN ('UPDATE', 'DELETE')
  ) THEN
    RAISE EXCEPTION '0093: brain_app must NOT have UPDATE/DELETE on connector_sync_run (append-only ledger).';
  END IF;

  -- Assert additive columns exist on connector_sync_status.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'connectors' AND table_name = 'connector_sync_status'
      AND column_name = 'consecutive_failure_count'
  ) THEN
    RAISE EXCEPTION '0093: connector_sync_status is missing consecutive_failure_count column.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'connectors' AND table_name = 'connector_sync_status'
      AND column_name = 'first_failure_at'
  ) THEN
    RAISE EXCEPTION '0093: connector_sync_status is missing first_failure_at column.';
  END IF;

  RAISE NOTICE '0093 assertions passed.';
END
$$;
