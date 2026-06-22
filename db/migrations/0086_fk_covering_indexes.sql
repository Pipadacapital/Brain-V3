-- ============================================================================
-- 0086_fk_covering_indexes.sql
-- AUDIT-REMEDIATION L2 — covering indexes for FKs that lack a LEADING index
-- ============================================================================
--
-- A foreign key with no index whose LEADING column(s) match the FK column(s) forces a
-- sequential scan of the child table on every parent-row DELETE/UPDATE (FK-maintenance),
-- and makes FK-direction joins slow. Postgres does NOT auto-create such an index.
--
-- Audit named: ai_config.recommendation_action.recommendation_id and
--              pixel.pixel_status.pixel_installation_id.
-- Discovered via pg_constraint (FK with no leading-matching index):
--   • ai_config.recommendation_action.recommendation_id — an index exists
--       (brand_id, recommendation_id, created_at DESC) but it LEADS with brand_id, so it
--       does NOT serve FK-maintenance lookups keyed on recommendation_id. Add a leading
--       recommendation_id index.
--   • pixel.pixel_status.pixel_installation_id — no covering index at all.
--   • tenancy.brand.currency_code → ref_currency(code)  — no covering index.
--   • tenancy.brand.timezone      → ref_timezone(name)  — no covering index.
-- NOT owned by this stream (returned as a crossStreamRequest):
--   • identity.identity_link.(brand_id, brain_id) → customer — identity-graph stream.
--
-- ADDITIVE-ONLY: indexes only. ROLLBACK: DROP INDEX ... for each below.

-- recommendation_action: leading recommendation_id for FK-maintenance + by-recommendation joins.
CREATE INDEX IF NOT EXISTS recommendation_action_recommendation_id_idx
  ON ai_config.recommendation_action (recommendation_id);

-- pixel_status: leading pixel_installation_id for FK-maintenance + installation lookups.
CREATE INDEX IF NOT EXISTS pixel_status_pixel_installation_id_idx
  ON pixel.pixel_status (pixel_installation_id);

-- brand → ref tables: cover the reference FKs so a ref-row change doesn't seq-scan brand.
CREATE INDEX IF NOT EXISTS brand_currency_code_idx
  ON tenancy.brand (currency_code);
CREATE INDEX IF NOT EXISTS brand_timezone_idx
  ON tenancy.brand (timezone);

-- ── Guard ───────────────────────────────────────────────────────────────────
DO $$
DECLARE
  missing TEXT;
BEGIN
  FOR missing IN
    SELECT idx FROM (VALUES
      ('ai_config.recommendation_action_recommendation_id_idx'),
      ('pixel.pixel_status_pixel_installation_id_idx'),
      ('tenancy.brand_currency_code_idx'),
      ('tenancy.brand_timezone_idx')
    ) AS t(idx)
    WHERE to_regclass(idx) IS NULL
  LOOP
    RAISE EXCEPTION '0086 VIOLATION: expected index % was not created', missing;
  END LOOP;
END $$;
