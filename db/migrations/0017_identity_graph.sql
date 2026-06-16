-- ============================================================================
-- 0017_identity_graph.sql — Identity graph tables + brand identity columns
-- feat-identity-graph (Stage 3). Deterministic resolution only (v1-deterministic).
-- ============================================================================
-- Tenant isolation: ENABLE + FORCE ROW LEVEL SECURITY on every table.
-- Two-arg fail-closed: current_setting('app.current_brand_id', TRUE) → NULL on
--   missing GUC → brand_id = NULL → FALSE → 0 rows. NN-1 CRITICAL.
-- DO NOT use the one-arg form — it raises an exception on missing GUC,
-- which is worse (500) than the fail-closed (0-row) two-arg form.
--
-- contact_pii elevated RLS (D-3): requires BOTH app.current_brand_id AND
--   app.role = 'send_service'. brain_app without send_service → 0 rows.
--
-- Salt (D-2): brand.identity_salt_ciphertext bytea — fetched+decrypted at
--   consumer startup. Fetch failure = HARD CRASH. Never empty/default salt.
--
-- Phone-guard (D-1): brand.phone_guard_threshold DEFAULT 10,
--   suppression_window_days DEFAULT 30, windowed + re-evaluatable.
--
-- ADDITIVE ONLY (I-E02): all CREATE TABLE IF NOT EXISTS, ALTER ADD COLUMN IF NOT EXISTS.
-- ROLLBACK (migrate down): DROP TABLE IF EXISTS (reverse FK order) +
--   ALTER TABLE brand DROP COLUMN IF EXISTS.
-- ============================================================================

-- ── 1. Brand column additions (D-1, D-2) ─────────────────────────────────────
-- Additive-safe: existing brand rows backfill to the defaults.
ALTER TABLE brand ADD COLUMN IF NOT EXISTS identity_salt_ciphertext  BYTEA;
ALTER TABLE brand ADD COLUMN IF NOT EXISTS phone_guard_threshold     INT NOT NULL DEFAULT 10;
ALTER TABLE brand ADD COLUMN IF NOT EXISTS suppression_window_days   INT NOT NULL DEFAULT 30;

-- ── 2. customer ──────────────────────────────────────────────────────────────
-- One row per (brand, brain_id). lifecycle_state drives suppression + erasure.
CREATE TABLE IF NOT EXISTS customer (
  brand_id         UUID        NOT NULL,
  brain_id         UUID        NOT NULL,
  anonymous_id     TEXT        NULL,
  merged_into      UUID        NULL,
  lifecycle_state  TEXT        NOT NULL DEFAULT 'anonymous'
                     CHECK (lifecycle_state IN ('anonymous','active','merged','split','erased')),
  ai_processing_consent  BOOLEAN  NOT NULL DEFAULT FALSE,
  resolution_consent     BOOLEAN  NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, brain_id)
);

ALTER TABLE customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer FORCE ROW LEVEL SECURITY;

CREATE POLICY customer_isolation ON customer
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON customer FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON customer TO brain_app;

-- ── 3. identity_link ─────────────────────────────────────────────────────────
-- HASH ONLY: identifier_value = sha256(per-brand-salt ‖ normalized). NEVER raw PII.
-- UNIQUE PARTIAL blocks two active profiles holding the same strong id.
-- Append-only: unmerge deactivates (is_active=FALSE, new row) — never deletes.
CREATE TABLE IF NOT EXISTS identity_link (
  brand_id          UUID        NOT NULL,
  link_id           UUID        NOT NULL DEFAULT gen_random_uuid(),
  brain_id          UUID        NOT NULL,
  identifier_type   TEXT        NOT NULL
                      CHECK (identifier_type IN (
                        'email','phone','storefront_customer_id','auth_user_id',
                        'fp_cookie','device_id','ip','ua','name','pincode','location'
                      )),
  identifier_value  TEXT        NOT NULL,   -- sha256(salt ‖ normalized); 64-hex; NEVER raw PII
  tier              TEXT        NOT NULL
                      CHECK (tier IN ('strong','strong_on_link','medium','weak')),
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, link_id),
  FOREIGN KEY (brand_id, brain_id) REFERENCES customer(brand_id, brain_id)
);

-- UNIQUE PARTIAL: one active strong identifier per (brand, type, value).
-- Replay-idempotent: ON CONFLICT on this index = DO NOTHING (D-4).
CREATE UNIQUE INDEX IF NOT EXISTS identity_link_active_strong_unique
  ON identity_link (brand_id, identifier_type, identifier_value)
  WHERE is_active = TRUE AND tier IN ('strong','strong_on_link');

-- Lookup index: resolve a hash → brain_id quickly.
CREATE INDEX IF NOT EXISTS idx_identity_link_lookup
  ON identity_link (brand_id, identifier_type, identifier_value, is_active);

ALTER TABLE identity_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_link FORCE ROW LEVEL SECURITY;

CREATE POLICY identity_link_isolation ON identity_link
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON identity_link FROM brain_app;
GRANT SELECT, INSERT ON identity_link TO brain_app;

-- ── 4. identity_merge_event ───────────────────────────────────────────────────
-- PK = deterministic merge_id = sha256(brand_id‖canonical‖merged‖rule_version).
-- ON CONFLICT (merge_id) DO NOTHING → replay-idempotent (D-4).
CREATE TABLE IF NOT EXISTS identity_merge_event (
  merge_id             UUID        NOT NULL,  -- deterministic PK (D-4)
  brand_id             UUID        NOT NULL,
  canonical_brain_id   UUID        NOT NULL,
  merged_brain_id      UUID        NOT NULL,
  rule_version         TEXT        NOT NULL DEFAULT 'v1-deterministic',
  identifier_combo     TEXT[]      NOT NULL DEFAULT '{}',
  confidence           TEXT        NOT NULL DEFAULT 'high',
  committed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (merge_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_merge_event_brand
  ON identity_merge_event (brand_id, committed_at DESC);

ALTER TABLE identity_merge_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_merge_event FORCE ROW LEVEL SECURITY;

CREATE POLICY identity_merge_event_isolation ON identity_merge_event
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON identity_merge_event FROM brain_app;
GRANT SELECT, INSERT ON identity_merge_event TO brain_app;

-- ── 5. brain_id_alias ─────────────────────────────────────────────────────────
-- Read-time re-pointing: merge = INSERT alias (observed→canonical, valid_to=NULL).
-- History never rewritten: unmerge sets valid_to (Phase-2).
-- UNIQUE PARTIAL: one live pointer per observed_brain_id (union-find invariant).
CREATE TABLE IF NOT EXISTS brain_id_alias (
  brand_id            UUID        NOT NULL,
  alias_id            UUID        NOT NULL DEFAULT gen_random_uuid(),
  observed_brain_id   UUID        NOT NULL,
  canonical_brain_id  UUID        NOT NULL,
  valid_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to            TIMESTAMPTZ NULL,
  rule_version        TEXT        NOT NULL DEFAULT 'v1-deterministic',
  merge_id            UUID        NOT NULL,
  CHECK (observed_brain_id <> canonical_brain_id),
  PRIMARY KEY (brand_id, alias_id),
  FOREIGN KEY (merge_id) REFERENCES identity_merge_event(merge_id)
);

-- UNIQUE PARTIAL: only one live (valid_to IS NULL) alias per (brand, observed_brain_id).
-- ON CONFLICT on this index = DO NOTHING → replay-idempotent (D-4).
CREATE UNIQUE INDEX IF NOT EXISTS brain_id_alias_live_unique
  ON brain_id_alias (brand_id, observed_brain_id)
  WHERE valid_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_brain_id_alias_canonical
  ON brain_id_alias (brand_id, canonical_brain_id)
  WHERE valid_to IS NULL;

ALTER TABLE brain_id_alias ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_id_alias FORCE ROW LEVEL SECURITY;

CREATE POLICY brain_id_alias_isolation ON brain_id_alias
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON brain_id_alias FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON brain_id_alias TO brain_app;

-- ── 6. shared_utility_identifier ─────────────────────────────────────────────
-- Phone-guard (D-1): an identifier seen across > phone_guard_threshold distinct
-- brain_ids in the suppression_window_days is flagged and suppressed_until set.
-- The re-eval Argo job un-suppresses when count drops below threshold / window expires.
CREATE TABLE IF NOT EXISTS shared_utility_identifier (
  brand_id          UUID        NOT NULL,
  identifier_type   TEXT        NOT NULL,
  identifier_value  TEXT        NOT NULL,   -- 64-hex SHA-256 (never raw)
  profile_count     INT         NOT NULL DEFAULT 0,
  flagged_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suppressed_until  TIMESTAMPTZ NULL,       -- NULL = not yet suppressed (D-1)
  window_days       INT         NOT NULL DEFAULT 30,
  reason            TEXT        NULL,
  PRIMARY KEY (brand_id, identifier_type, identifier_value)
);

CREATE INDEX IF NOT EXISTS idx_shared_utility_suppressed
  ON shared_utility_identifier (brand_id, suppressed_until)
  WHERE suppressed_until IS NOT NULL;

ALTER TABLE shared_utility_identifier ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_utility_identifier FORCE ROW LEVEL SECURITY;

CREATE POLICY shared_utility_identifier_isolation ON shared_utility_identifier
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON shared_utility_identifier FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON shared_utility_identifier TO brain_app;

-- ── 7. merge_review_queue ─────────────────────────────────────────────────────
-- Phone-guard conflicts + cycle-guard conflicts land here (M1: unworked; insert-only).
CREATE TABLE IF NOT EXISTS merge_review_queue (
  brand_id       UUID        NOT NULL,
  review_id      UUID        NOT NULL DEFAULT gen_random_uuid(),
  brain_id_a     UUID        NOT NULL,
  brain_id_b     UUID        NOT NULL,
  trigger_reason TEXT        NOT NULL,
  evidence       JSONB       NOT NULL DEFAULT '{}',  -- hashed evidence only, no raw PII
  status         TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','merged','rejected','expired')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, review_id)
);

ALTER TABLE merge_review_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE merge_review_queue FORCE ROW LEVEL SECURITY;

CREATE POLICY merge_review_queue_isolation ON merge_review_queue
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON merge_review_queue FROM brain_app;
GRANT SELECT, INSERT ON merge_review_queue TO brain_app;

-- ── 8. contact_pii ───────────────────────────────────────────────────────────
-- VAULT: raw PII lives ONLY here (dev: plaintext pii_value; prod: pii_ciphertext bytea).
-- Elevated RLS (D-3): BOTH brand_id AND app.role='send_service' required.
-- brain_app without send_service → 0 rows (both predicates two-arg fail-closed).
CREATE TABLE IF NOT EXISTS contact_pii (
  brand_id        UUID        NOT NULL,
  brain_id        UUID        NOT NULL,
  pii_type        TEXT        NOT NULL
                    CHECK (pii_type IN ('email','phone','name')),
  pii_value       TEXT        NULL,     -- dev plaintext stand-in (prod: use pii_ciphertext)
  identifier_hash TEXT        NOT NULL, -- 64-hex SHA-256 — links to identity_link
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, brain_id, pii_type)
);

ALTER TABLE contact_pii ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_pii FORCE ROW LEVEL SECURITY;

-- Elevated policy: BOTH brand_id GUC AND app.role GUC must be set correctly.
-- Two-arg on BOTH: missing either GUC → NULL comparison → FALSE → 0 rows (D-3).
CREATE POLICY contact_pii_isolation ON contact_pii
  AS PERMISSIVE FOR ALL TO brain_app
  USING (
    brand_id = current_setting('app.current_brand_id', TRUE)::uuid
    AND current_setting('app.role', TRUE) = 'send_service'
  );

REVOKE ALL ON contact_pii FROM brain_app;
GRANT SELECT, INSERT ON contact_pii TO brain_app;

-- ── 9. identity_audit ────────────────────────────────────────────────────────
-- Append-only audit trail. detail JSONB references brain_id/hashes only — NO raw PII.
CREATE TABLE IF NOT EXISTS identity_audit (
  brand_id    UUID        NOT NULL,
  audit_id    UUID        NOT NULL DEFAULT gen_random_uuid(),
  brain_id    UUID        NOT NULL,
  action      TEXT        NOT NULL
                CHECK (action IN ('mint','link','merge','unmerge','rebind','erase')),
  merge_id    UUID        NULL,
  detail      JSONB       NOT NULL DEFAULT '{}',  -- hashed refs only; no raw PII
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, audit_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_audit_brain
  ON identity_audit (brand_id, brain_id, occurred_at DESC);

ALTER TABLE identity_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_audit FORCE ROW LEVEL SECURITY;

CREATE POLICY identity_audit_isolation ON identity_audit
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON identity_audit FROM brain_app;
GRANT SELECT, INSERT ON identity_audit TO brain_app;

-- ── 10. NN-1 assertion (extended) ────────────────────────────────────────────
-- Fail the migration if any policy in the schema uses one-arg current_setting.
-- Also catches any policy missing the two-arg form for app.role.
DO $$
DECLARE
  bad_policy RECORD;
BEGIN
  FOR bad_policy IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE (
      -- one-arg app.current_brand_id (no TRUE second arg)
      (qual LIKE '%current_setting(''app.current_brand_id'')%'
       AND qual NOT LIKE '%current_setting(''app.current_brand_id'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.current_brand_id'', true)%')
      OR
      -- one-arg app.current_user_id
      (qual LIKE '%current_setting(''app.current_user_id'')%'
       AND qual NOT LIKE '%current_setting(''app.current_user_id'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.current_user_id'', true)%')
      OR
      -- one-arg app.current_workspace_id
      (qual LIKE '%current_setting(''app.current_workspace_id'')%'
       AND qual NOT LIKE '%current_setting(''app.current_workspace_id'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.current_workspace_id'', true)%')
      OR
      -- one-arg app.role
      (qual LIKE '%current_setting(''app.role'')%'
       AND qual NOT LIKE '%current_setting(''app.role'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.role'', true)%')
    )
  LOOP
    RAISE EXCEPTION
      'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting. '
      'Replace with two-arg form: current_setting(''guc_name'', TRUE).',
      bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
  END LOOP;
END
$$;
