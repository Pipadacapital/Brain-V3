-- ============================================================================
-- 0012_session_rotation_lineage.sql — Refresh token family lineage (AC-1 / MA-01 / MA-03)
-- ============================================================================
-- Adds columns to user_session to support:
--   - Token family tracking for replay-detection + family-wipe (AC-1).
--   - used_at for consumed-token detection (replay = used_at IS NOT NULL).
--   - Indexes for fast rotation lookup by refresh_token_hash and family wipe.
--
-- ISOLATION NOTE (NN-1):
--   user_session RLS = app.current_user_id (two-arg fail-closed, 0002_auth.sql).
--   Rotation path sets ctx.userId from the looked-up row's app_user_id BEFORE
--   the FOR UPDATE. Family-wipe runs under same user GUC — another user's sessions
--   are invisible, so family-wipe CANNOT cross users. Builder asserts in isolation-fuzz.
--
-- ROTATION PROTOCOL (AC-1):
--   On login: family_id = new row's own id (root of a new family).
--   On rotation: new row inherits old row's family_id; rotated_from = old row's id.
--   On replay (used_at IS NOT NULL OR revoked_at IS NOT NULL):
--     → family-wipe: UPDATE user_session SET revoked_at=NOW() WHERE family_id=$famId
--     → return 401 SESSION_REVOKED.
--   jti UNIQUE conflict on INSERT → 401 SESSION_CONFLICT (MA-03 concurrent defense).
--
-- BACKFILL: existing live sessions get family_id = id (each its own family root).
-- ============================================================================

ALTER TABLE user_session ADD COLUMN IF NOT EXISTS family_id UUID NULL;
-- Ties the whole rotation lineage together. On login: family_id = the new row's id.
-- On rotation: new row inherits old row's family_id.

ALTER TABLE user_session ADD COLUMN IF NOT EXISTS rotated_from UUID NULL REFERENCES user_session(id);
-- Points to the previous session row in this rotation chain (NULL for root sessions).

ALTER TABLE user_session ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ NULL;
-- Set when a refresh token is consumed (rotation/replay marker).
-- A row with used_at IS NOT NULL = replay attempt → trigger family-wipe.

-- Backfill: existing live sessions each become their own family root.
UPDATE user_session SET family_id = id WHERE family_id IS NULL;

-- Index: fast family-wipe (WHERE family_id = $famId AND revoked_at IS NULL)
CREATE INDEX IF NOT EXISTS user_session_family_id_idx
  ON user_session (family_id)
  WHERE revoked_at IS NULL;

-- Index: fast rotation lookup (WHERE refresh_token_hash = $hash)
-- Without this every /auth/token/refresh is a full seq scan on user_session.
CREATE INDEX IF NOT EXISTS user_session_refresh_hash_idx
  ON user_session (refresh_token_hash);

-- ============================================================================
-- MANUAL ROLLBACK PROCEDURE (SEC-AOF-M3 / deploy-runbook):
--
--   PRECONDITION: Only safe to roll back before any session rotation has occurred
--   (i.e. before any user has called /api/v1/auth/token/refresh on the new schema).
--   After rotation lineage data is written, dropping these columns is IRREVERSIBLE.
--
--   The rotated_from FK constraint must be dropped before the column:
--
--   To rollback this migration manually (in order):
--     DROP INDEX IF EXISTS user_session_refresh_hash_idx;
--     DROP INDEX IF EXISTS user_session_family_id_idx;
--     ALTER TABLE user_session DROP COLUMN IF EXISTS used_at;
--     ALTER TABLE user_session DROP COLUMN IF EXISTS rotated_from;
--     ALTER TABLE user_session DROP COLUMN IF EXISTS family_id;
--
--   After rollback: deploy the previous core image that does NOT use family_id.
--   WARNING: After rollback, B-1 replay-detection / family-wipe is disabled.
--   Invalidate all active sessions via manual UPDATE if there is a security concern.
-- ============================================================================
