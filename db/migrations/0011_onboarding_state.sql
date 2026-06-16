-- ============================================================================
-- 0011_onboarding_state.sql — Onboarding status on organization (AC-5 / MA-09)
-- ============================================================================
-- Decision MA-09 Option A (BINDING): onboarding_status on organization,
--   tracking first-brand onboarding only.
--
-- RATIONALE (MA-09 Option A):
--   1. M1 is single-brand-per-org — wizard creates exactly one brand.
--   2. Step 1 (Org creation) precedes any brand_id existing — cannot put
--      status on brand without NULL-limbo at Step 1.
--   3. organization already has RLS (0009_organization_self_read.sql) — new
--      columns inherit workspace isolation automatically.
--   M1 constraint: after 'complete', adding a second brand does NOT reset the wizard.
--   Multi-brand onboarding post-M1 routes via the dashboard onboarding-progress widget.
--
-- ISOLATION NOTE (NN-1):
--   `organization` RLS = app.current_workspace_id (two-arg fail-closed, 0009).
--   New columns inherit it. BFF advance-writes set ctx.workspaceId so RLS
--   permits UPDATE only to caller's own org. A cross-workspace SELECT returns 0 rows.
--   Builder: extend org isolation-fuzz to assert cross-workspace onboarding_status = no rows.
--
-- BACKFILL: existing orgs with brands must NOT be stuck at 'pending' (wrong state).
--   UPDATE sets 'complete'/step=4 for any org that already has a brand row.
--   Orgs with no brand stay 'pending' (correct first-login state).
-- ============================================================================

ALTER TABLE organization ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (onboarding_status IN ('pending','org_created','brand_created','integration_selected','complete'));

ALTER TABLE organization ADD COLUMN IF NOT EXISTS onboarding_step SMALLINT NOT NULL DEFAULT 0
  CHECK (onboarding_step BETWEEN 0 AND 4);
-- onboarding_step is a denormalized convenience mirror for the progress bar.
-- onboarding_status is authoritative for routing (03-architecture-plan.md §1 MA-09).

-- Backfill: existing orgs that already have brands should be marked complete.
-- Avoids shoving fully-onboarded users back to Step 1 on next login.
UPDATE organization o
  SET onboarding_status = 'complete', onboarding_step = 4
  WHERE EXISTS (SELECT 1 FROM brand b WHERE b.organization_id = o.id);

-- ============================================================================
-- MANUAL ROLLBACK PROCEDURE (SEC-AOF-M3 / deploy-runbook):
--
--   PRECONDITION: Only safe to roll back in the DEPLOY WINDOW before any org
--   has had onboarding_status/onboarding_step advanced beyond the backfill values
--   (i.e. before any real user has started or completed the wizard). After that
--   window, the DROP is IRREVERSIBLE (onboarding progress data lost).
--
--   To rollback this migration manually:
--     ALTER TABLE organization DROP COLUMN IF EXISTS onboarding_step;
--     ALTER TABLE organization DROP COLUMN IF EXISTS onboarding_status;
--
--   Verify no non-default advancement has occurred:
--     SELECT COUNT(*) FROM organization
--       WHERE onboarding_status NOT IN ('pending', 'complete');
--     -- If count > 0, rollback will lose active wizard sessions.
--     -- Coordinate with product team before dropping.
-- ============================================================================
