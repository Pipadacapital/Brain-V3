-- ============================================================================
-- 0082_recommendation_action_ledger.sql
-- DB-AUDIT M7 — the recommendation ACTION ledger (the human decision-feedback loop)
-- ============================================================================
--
-- The decision engine is recommend-only (doc 09): it emits ranked risk/opportunity recommendations,
-- but a human decides what to DO with each one. This table is the APPEND-ONLY ledger of those human
-- actions — served / accepted / dismissed / snoozed / reopened — the trust-building record of the
-- decision loop ("Capture Truth -> Build Trust -> Enable Decisions").
--
-- Distinct from ai_config.recommendation_outcome (0045), which is the SYSTEM's measurement of whether
-- a recommendation WORKED. This table records what the USER did about it.
--
-- APPEND-ONLY rationale (Brain core rule "data can be replayed and audited"): a decision ledger must
-- be immutable to be auditable — the truth of "who dismissed what, when, and why" cannot be silently
-- rewritten. We therefore grant brain_app SELECT + INSERT only (NO UPDATE/DELETE): state corrections
-- happen by appending a new row (e.g. a 'reopened' after a 'dismissed'), never by mutating history.
-- The derived current state lives on ai_config.recommendation.status, which the use-case updates.
--
-- ADDITIVE ONLY (I-E02). ROLLBACK: DROP TABLE ai_config.recommendation_action.

-- ── 1. recommendation_action — append-only user-action ledger ─────────────────
CREATE TABLE IF NOT EXISTS ai_config.recommendation_action (
  action_id         UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id          UUID        NOT NULL,                            -- RLS anchor (denormalized)
  recommendation_id UUID        NOT NULL
                                REFERENCES ai_config.recommendation(recommendation_id),
  action            TEXT        NOT NULL
                                CHECK (action IN ('served','accepted','dismissed','snoozed','reopened')),
  actor             TEXT        NOT NULL,                            -- user id, or 'system'
  reason            TEXT,                                            -- optional free-text justification
  metadata          JSONB       NOT NULL DEFAULT '{}',               -- extra structured context
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (action_id)
);

-- Per-recommendation history (newest first): the audit trail for a single recommendation.
CREATE INDEX IF NOT EXISTS recommendation_action_by_rec_idx
  ON ai_config.recommendation_action (brand_id, recommendation_id, created_at DESC);
-- Per-action analytics (e.g. dismissals over time): action-type rollups within a brand.
CREATE INDEX IF NOT EXISTS recommendation_action_by_action_idx
  ON ai_config.recommendation_action (brand_id, action, created_at);

-- ── 2. RLS — brand isolation ──────────────────────────────────────────────────
ALTER TABLE ai_config.recommendation_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_config.recommendation_action FORCE ROW LEVEL SECURITY;
CREATE POLICY recommendation_action_isolation ON ai_config.recommendation_action
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- ── 3. Grants — APPEND-ONLY (no UPDATE/DELETE) ────────────────────────────────
REVOKE ALL ON ai_config.recommendation_action FROM brain_app;
GRANT SELECT, INSERT ON ai_config.recommendation_action TO brain_app;

-- ── 4. Assertions ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'ai_config' AND c.relname = 'recommendation_action'
       AND c.relrowsecurity IS TRUE AND c.relforcerowsecurity IS TRUE
  ) THEN
    RAISE EXCEPTION 'RLS GUARD (0082): ai_config.recommendation_action must have RLS ENABLED + FORCED.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'ai_config' AND table_name = 'recommendation_action'
       AND grantee = 'brain_app' AND privilege_type IN ('UPDATE','DELETE')
  ) THEN
    RAISE EXCEPTION 'APPEND-ONLY GUARD (0082): brain_app must NOT have UPDATE/DELETE on recommendation_action.';
  END IF;
END
$$;
