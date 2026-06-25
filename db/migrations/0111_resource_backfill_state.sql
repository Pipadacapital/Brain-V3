-- ============================================================================
-- 0111_resource_backfill_state.sql — Additive: per-(brand,connector,resource)
--   resumable, chunked backfill registry for the generalized ingestion framework.
-- ============================================================================
-- GAP this closes (ingestion-framework foundation):
--   The platform target is "every connector can pull EVERY resource it offers, up to 2 years
--   (or the platform max) of history, in RESUMABLE/CHUNKED intervals, with strict dedup + zero
--   loss". The existing tables are insufficient for the MULTI-RESOURCE resumable case:
--
--     - jobs.backfill_job (0022) tracks at most ONE active job per connector_instance: its
--       active-lock partial index (backfill_job_active_idx) is keyed on connector_instance_id
--       ALONE, and the table has NO `resource` column. It cannot represent "orders is 80%
--       backfilled AND customers is 30% backfilled" for the same connector at once.
--     - connectors.connector_cursor (0006) is the LIVE/repull watermark per resource — the
--       newest record seen — NOT the historical backfill frontier (how far BACK we have reached).
--       Overloading it would conflate "newest seen" with "oldest reached".
--
--   resource_backfill_state is the missing third thing: for each (brand, connector_instance,
--   resource) it records the window (anchor → floor), the checkpointed chunk cursor (so a
--   paused/crashed run RESUMES exactly where it left off — never restarts), the deepest
--   occurred_at reached, a resumable status, and a lifetime processed count. The
--   (brand_id, connector_instance_id, resource) triple is the upsert key (I-ST04) — the SAME
--   triple connector_cursor uses, so the two line up per resource.
--
--   Mirrors @brain/connector-core's ResourceBackfillState entity +
--   IResourceBackfillStateRepository (the app-layer reads/writes via that repo).
--
-- WHY a NEW table rather than ALTER backfill_job:
--   backfill_job is an immutable audit ledger of DISPATCHED runs (INSERT+UPDATE, no DELETE) with a
--   per-connector active lock. The resumable frontier is per-RESOURCE mutable state with a
--   per-resource upsert key. Different cardinality + different lock granularity → a separate table
--   (Brain rule: prefer small, reversible, auditable changes). backfill_job stays as-is.
--
-- RLS: FORCE (enforced even for table owner — superuser BYPASS only).
--   Two-arg current_setting('app.current_brand_id', TRUE) — NN-1 fail-closed (missing GUC → 0 rows).
--   brain_app: SELECT + INSERT + UPDATE — NO DELETE (resumable state is never deleted; a fresh
--   backfill re-uses the row via upsert, advancing anchor/floor and resetting the cursor).
--
-- Status CHECK values (mirror the entity):
--   queued    — registered, not yet started
--   running   — a worker holds it and is walking chunks
--   paused    — checkpointed mid-window on purpose (interval scheduling) — resumable
--   completed — reached the historical floor; no more chunks
--   failed    — unrecoverable (auth/reconnect); cursor preserved for a manual resume
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS list_resumable_backfill_states();
--   DROP TABLE IF EXISTS jobs.resource_backfill_state;   -- rebuildable; NOT a source-of-truth
--                                                        -- (Bronze + deterministic event_id are).
--
-- NOTE on search_path (0063): brain_app's role search_path spans the operational schemas, so the
--   app's unqualified `resource_backfill_state` resolves to jobs.resource_backfill_state. The
--   migration runner's session search_path is `public` only, so every reference below is schema-
--   qualified `jobs.` (DDL) and the SECURITY DEFINER fn pins its own widened runtime search_path.
-- ============================================================================

CREATE TABLE IF NOT EXISTS jobs.resource_backfill_state (
  id                     UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id               UUID        NOT NULL REFERENCES tenancy.brand(id),              -- tenant key / RLS anchor (I-S01)
  connector_instance_id  UUID        NOT NULL REFERENCES connectors.connector_instance(id),
  resource               TEXT        NOT NULL,                                           -- matches ResourceDescriptor.name + connector_cursor.resource
  status                 TEXT        NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed')),
  anchor_at              TIMESTAMPTZ NOT NULL,                                           -- window anchor (backfill start "now")
  floor_at               TIMESTAMPTZ NOT NULL,                                           -- historical floor = anchor − effective window (clamped to platform max)
  cursor_value           TEXT        NULL,                                               -- checkpointed chunk cursor (resume from here); NULL = not started
  reached_at             TIMESTAMPTZ NULL,                                               -- deepest occurred_at reached so far; NULL = no chunk done
  records_processed      BIGINT      NOT NULL DEFAULT 0,                                 -- lifetime emitted count (monotonic)
  failure_reason         TEXT        NULL,                                               -- truncated; never a token (I-S09). NULL unless status='failed'
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  -- The upsert key: unique per (brand, connector, resource) — the SAME triple connector_cursor uses.
  CONSTRAINT resource_backfill_state_upsert_key
    UNIQUE (brand_id, connector_instance_id, resource),
  -- Window invariant: the floor is at or before the anchor (we walk anchor → floor BACKWARDS).
  CONSTRAINT resource_backfill_state_window_ck CHECK (floor_at <= anchor_at),
  CONSTRAINT resource_backfill_state_records_ck CHECK (records_processed >= 0)
);

-- Per-connector progress view: list every resource's backfill state for a connector.
CREATE INDEX IF NOT EXISTS resource_backfill_state_brand_connector_idx
  ON jobs.resource_backfill_state (brand_id, connector_instance_id);

-- Scheduler poll: find resumable (queued/paused/failed-with-cursor) resources to pick up next
-- interval. Partial index keeps it tight — terminal 'completed' rows are excluded.
CREATE INDEX IF NOT EXISTS resource_backfill_state_resumable_idx
  ON jobs.resource_backfill_state (connector_instance_id, resource)
  WHERE status IN ('queued', 'running', 'paused', 'failed');

-- ── Tenant isolation — Postgres RLS ─────────────────────────────────────────
-- FORCE: enforced even for table owner (brain_app is the only runtime accessor).
-- Two-arg current_setting (NN-1): missing GUC → NULL → fail-closed → 0 rows.

ALTER TABLE jobs.resource_backfill_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs.resource_backfill_state FORCE ROW LEVEL SECURITY;

CREATE POLICY resource_backfill_state_isolation ON jobs.resource_backfill_state
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);   -- NN-1 two-arg fail-closed

-- brain_app grants: SELECT + INSERT + UPDATE — NO DELETE.
REVOKE ALL ON jobs.resource_backfill_state FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON jobs.resource_backfill_state TO brain_app;

-- ── SECURITY DEFINER enumeration fn (mirror of 0023 list_queued_backfill_jobs) ──
-- At scheduler poll time NO brand GUC is known (we are discovering WHICH brand/resource to
-- resume), so a bare SELECT under FORCE RLS returns 0 rows always (two-arg fail-closed). This fn
-- runs as the migration owner (superuser 'brain'), bypasses FORCE RLS for the enumeration step
-- ONLY, and returns ONLY dispatch metadata (no tenant data content): which (brand, connector,
-- resource) rows are resumable, oldest-updated first (fairness). The returned brand_id is the
-- authority for all subsequent GUC calls — never from env or the provider (MT-1).
--
-- SECURITY DEFINER hijack prevention (0029/0053 invariant): pinned widened search_path so the
-- unqualified `resource_backfill_state` inside the body resolves to jobs.* deterministically.

CREATE OR REPLACE FUNCTION list_resumable_backfill_states()
  RETURNS TABLE(
    id                     uuid,
    brand_id               uuid,
    connector_instance_id  uuid,
    resource               text,
    status                 text
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config
AS $$
  SELECT
    id,
    brand_id,
    connector_instance_id,
    resource,
    status
  FROM jobs.resource_backfill_state
  WHERE status IN ('queued', 'paused', 'failed')
  ORDER BY updated_at ASC
$$;

GRANT EXECUTE ON FUNCTION list_resumable_backfill_states() TO brain_app;

-- ── Migration-time assertion: fn is SECURITY DEFINER with a pinned search_path ──
DO $$
DECLARE
  fn_config    TEXT;
  fn_security  TEXT;
BEGIN
  SELECT
    p.prosecdef::text,
    array_to_string(p.proconfig, ', ')
  INTO fn_security, fn_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_resumable_backfill_states'
    AND n.nspname = 'public';

  IF fn_security IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      '0111 GUARD: list_resumable_backfill_states() must be SECURITY DEFINER (prosecdef=true). Got: %',
      fn_security;
  END IF;

  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=%' THEN
    RAISE EXCEPTION
      '0111 GUARD: list_resumable_backfill_states() must pin a search_path '
      '(SECURITY DEFINER hijack prevention). Got config: %', fn_config;
  END IF;
END
$$;

-- ── Post-condition guard: table is born-secure (RLS enabled + forced) ─────────
DO $$
DECLARE
  rls_enabled  BOOLEAN;
  rls_forced   BOOLEAN;
BEGIN
  SELECT c.relrowsecurity, c.relforcerowsecurity
  INTO rls_enabled, rls_forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'jobs' AND c.relname = 'resource_backfill_state';

  IF rls_enabled IS DISTINCT FROM TRUE OR rls_forced IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      '0111 GUARD: jobs.resource_backfill_state must be RLS ENABLED + FORCED '
      '(enabled=%, forced=%).', rls_enabled, rls_forced;
  END IF;
END
$$;

-- ── NN-1 assertion (carry-forward from 0006/0022) ────────────────────────────
-- Fail the migration if ANY policy on ANY table uses the one-arg current_setting form.
DO $$
DECLARE
  bad_policy RECORD;
BEGIN
  FOR bad_policy IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE (
      (qual LIKE '%current_setting(''app.current_brand_id'')%'
       AND qual NOT LIKE '%current_setting(''app.current_brand_id'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.current_brand_id'', true)%')
      OR
      (qual LIKE '%current_setting(''app.current_user_id'')%'
       AND qual NOT LIKE '%current_setting(''app.current_user_id'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.current_user_id'', true)%')
      OR
      (qual LIKE '%current_setting(''app.current_workspace_id'')%'
       AND qual NOT LIKE '%current_setting(''app.current_workspace_id'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.current_workspace_id'', true)%')
    )
  LOOP
    RAISE EXCEPTION
      'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting (0111 check).',
      bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
  END LOOP;
END
$$;
