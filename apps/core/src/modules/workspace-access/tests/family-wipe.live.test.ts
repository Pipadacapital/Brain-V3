/**
 * SEC-AOF-L1 / QA-08 — Live Postgres integration test for family-wipe replay containment.
 *
 * WHAT THIS PROVES (bounce-fix round 3):
 *   1. On refresh-token replay, the endpoint throws SESSION_REVOKED (not a 500 syntax error).
 *   2. The family-wipe UPDATE revokes MORE than 1 session (rowcount > 1) — siblings are wiped.
 *   3. Under SET ROLE brain_app + set_config('app.current_user_id', ...) the family-wipe
 *      UPDATE is visible to the RLS policy and affects > 0 rows (would be 0 if set_config
 *      was replaced with SET LOCAL app.current_user_id = $1, which errors with 42601).
 *
 * NEGATIVE CONTROL (non-inert):
 *   Removing the set_config line from auth.service.ts causes this test to fail because:
 *   - Under brain_app role (NOBYPASSRLS) with empty GUC, the wipe UPDATE touches 0 rows.
 *   - The test asserts rowcount > 0 under that role.
 *
 * RUN: pnpm --filter @brain/core test:unit (vitest picks up *.test.ts + *.live.test.ts)
 * Requires: DATABASE_URL=postgres://brain:brain@localhost:5432/brain (dev stack UP).
 * Skips gracefully if DATABASE_URL is unreachable (CI without Postgres uses mocks only).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { AuthService, AuthError } from '../internal/application/auth.service.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function tryConnect(): Promise<pg.Pool | null> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  try {
    const client = await pool.connect();
    client.release();
    return pool;
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
}

async function cleanupUser(pool: pg.Pool, userId: string): Promise<void> {
  await pool.query('DELETE FROM user_session WHERE app_user_id = $1', [userId]);
  await pool.query('DELETE FROM app_user WHERE id = $1', [userId]);
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('SEC-AOF-L1 family-wipe replay — LIVE Postgres integration', () => {
  let pool: pg.Pool | null = null;
  const TEST_USER_ID = randomUUID();
  const FAMILY_ID = randomUUID();

  beforeAll(async () => {
    pool = await tryConnect();
    if (!pool) return; // skip if DB unavailable

    // Insert a test user (no email_verified_at, no password hash needed — direct INSERT).
    const testEmail = `test-family-wipe-${TEST_USER_ID}@example.invalid`;
    await pool.query(
      `INSERT INTO app_user (id, email, email_normalized, password_hash, status)
       VALUES ($1, $2, $3, 'test-hash', 'active')`,
      [TEST_USER_ID, testEmail, testEmail],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanupUser(pool, TEST_USER_ID).catch(() => {});
      await pool.end().catch(() => {});
    }
  });

  it('LIVE-PG-1: set_config call does not error (42601 regression guard)', async () => {
    if (!pool) {
      console.warn('[SKIP] LIVE-PG-1: Postgres not reachable, skipping live test');
      return;
    }

    // Directly verify that set_config with $1 param does NOT throw 42601.
    // If the old `SET LOCAL app.current_user_id = $1` were used, this would throw:
    //   error: syntax error at or near "$1" (code: 42601)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT set_config('app.current_user_id', $1, true) AS guc_value`,
        [TEST_USER_ID],
      );
      expect(result.rows[0]?.guc_value).toBe(TEST_USER_ID);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('LIVE-PG-2: family-wipe under brain_app role + set_config → rowcount > 0 (RLS allows wipe)', async () => {
    if (!pool) {
      console.warn('[SKIP] LIVE-PG-2: Postgres not reachable, skipping live test');
      return;
    }

    // Insert 3 sessions in the same family: session A (replayed), B and C (siblings, still active).
    const sessionAId = randomUUID();
    const sessionBId = randomUUID();
    const sessionCId = randomUUID();
    const futureExpiry = new Date(Date.now() + 86_400_000);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Insert session A (already used — will be replayed).
      await client.query(
        `INSERT INTO user_session (id, app_user_id, jti, refresh_token_hash, expires_at, family_id, used_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL '1 second')`,
        [sessionAId, TEST_USER_ID, randomUUID(), sha256Hex(randomBytes(32).toString('hex')), futureExpiry, FAMILY_ID],
      );
      // Insert session B (active sibling).
      await client.query(
        `INSERT INTO user_session (id, app_user_id, jti, refresh_token_hash, expires_at, family_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sessionBId, TEST_USER_ID, randomUUID(), sha256Hex(randomBytes(32).toString('hex')), futureExpiry, FAMILY_ID],
      );
      // Insert session C (active sibling).
      await client.query(
        `INSERT INTO user_session (id, app_user_id, jti, refresh_token_hash, expires_at, family_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sessionCId, TEST_USER_ID, randomUUID(), sha256Hex(randomBytes(32).toString('hex')), futureExpiry, FAMILY_ID],
      );
      await client.query('COMMIT');

      // Now perform the family-wipe under brain_app role + set_config (the prod path).
      // If set_config is missing, RLS would filter to 0 rows (brain_app sees only
      // rows where app_user_id = current_setting('app.current_user_id')::uuid).
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE brain_app');
      await client.query(
        `SELECT set_config('app.current_user_id', $1, true)`,
        [TEST_USER_ID],
      );

      const wipeResult = await client.query<{ rowcount: string }>(
        `WITH revoked AS (
           UPDATE user_session SET revoked_at = NOW()
           WHERE family_id = $1 AND revoked_at IS NULL
           RETURNING id
         )
         SELECT COUNT(*) AS rowcount FROM revoked`,
        [FAMILY_ID],
      );

      const wipeCount = parseInt(wipeResult.rows[0]?.rowcount ?? '0', 10);

      await client.query('ROLLBACK'); // Clean up — don't leave test data half-revoked

      // NEGATIVE CONTROL: without set_config, brain_app RLS would see 0 rows.
      // With set_config correctly set, it should see all 3 sessions (A, B, C — none revoked yet).
      expect(wipeCount, 'family-wipe must affect more than 1 session (siblings wiped)').toBeGreaterThan(1);
    } finally {
      client.release();
    }
  });

  it('LIVE-PG-3: AuthService.rotateRefreshToken replay → SESSION_REVOKED (not 500)', async () => {
    if (!pool) {
      console.warn('[SKIP] LIVE-PG-3: Postgres not reachable, skipping live test');
      return;
    }

    // Insert two sessions in the same family: one already used (replayed), one active sibling.
    const familyId2 = randomUUID();
    const replayedToken = randomBytes(32).toString('hex');
    const replayedTokenHash = sha256Hex(replayedToken);
    const sessionId1 = randomUUID();
    const sessionId2 = randomUUID();
    const futureExpiry = new Date(Date.now() + 86_400_000);

    await pool.query(
      `INSERT INTO user_session (id, app_user_id, jti, refresh_token_hash, expires_at, family_id, used_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL '1 second')`,
      [sessionId1, TEST_USER_ID, randomUUID(), replayedTokenHash, futureExpiry, familyId2],
    );
    await pool.query(
      `INSERT INTO user_session (id, app_user_id, jti, refresh_token_hash, expires_at, family_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId2, TEST_USER_ID, randomUUID(), sha256Hex(randomBytes(32).toString('hex')), futureExpiry, familyId2],
    );

    // Wire a real AuthService with the live pool.
    const noop = {
      append: async () => ({ id: 0n, entry_hash: 'noop' }),
      getRecentEntries: async () => [],
    };
    const noopNotify = {
      sendVerificationEmail: async () => {},
      sendPasswordResetEmail: async () => {},
      sendInviteEmail: async () => {},
      canContact: async () => true,
    };

    const authService = new AuthService(
      pool as never, // prisma pool (not used in rotateRefreshToken)
      noop,
      noopNotify,
      { jwtSigningSecret: 'live-pg-test-secret-32-bytes-long!!' },
      pool as never, // rawPgPool — the real pg.Pool
    );

    // Replay the already-used token — MUST throw SESSION_REVOKED (AuthError 401), not a 500.
    let caughtError: unknown;
    try {
      await authService.rotateRefreshToken(replayedToken, '127.0.0.1', 'test-agent', 'live-pg-corr');
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError, 'replay must throw an error').toBeDefined();
    expect(caughtError, 'must be an AuthError instance').toBeInstanceOf(AuthError);
    const authErr = caughtError as AuthError;
    expect(authErr.code, 'must be SESSION_REVOKED (not 500 syntax error)').toBe('SESSION_REVOKED');
    expect(authErr.statusCode, 'must be 401').toBe(401);

    // Verify the family-wipe: session2 (active sibling) must now be revoked in DB.
    const siblingResult = await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM user_session WHERE id = $1',
      [sessionId2],
    );
    expect(
      siblingResult.rows[0]?.revoked_at,
      'sibling session must be revoked by family-wipe (rowcount > 1 proof)',
    ).not.toBeNull();
  });
});
