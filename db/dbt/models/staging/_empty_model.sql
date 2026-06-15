-- ============================================================
-- Empty staging model — Sprint-0 scope (ruling 6)
-- Purpose: proves dbt compile passes against the dev StarRocks profile.
-- Business transforms (Silver/Gold marts) are deferred to M1.
-- ============================================================
-- Materialization: view (from dbt_project.yml staging config)

{{
  config(
    materialized = 'view',
    tags         = ['sprint0', 'stub']
  )
}}

-- Trivial SELECT to satisfy dbt compile without any business logic.
-- This model is NOT run in Sprint-0 CI (`dbt compile` only, not `dbt run`).
SELECT
  'sprint-0-stub'  AS model_name,
  CURRENT_TIMESTAMP AS compiled_at
