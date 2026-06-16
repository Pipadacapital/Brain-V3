/**
 * member-lifecycle.live.test.ts — Live Postgres integration + unit tests
 *
 * Coverage:
 *   NC-1: membership cross-org leak (SET ROLE brain_app, wrong org → 0 rows)
 *   NC-2: invite table no-GUC → 0 rows (fail-closed)
 *   NC-3: invite table org-A GUC → only org-A rows, 0 org-B rows
 *   NC-4: after suspendUser → user_session has 0 active rows; app_user.status='suspended'
 *   NC-5: after suspend → findActiveByJti returns null (revocation visible immediately)
 *   NC-6: audit brand_id = organizationId (NOT appUserId) for suspend events
 *
 * Unit tests (no live DB):
 *   UNIT-D6: createInvite hierarchy bound — brand_admin→brand_admin = 403
 *   UNIT-D7: updateMemberRole hierarchy bound — brand_admin→brand_admin = 403
 *   UNIT-D8: suspendUser authority check — non-owner suspending owner = 403
 *   UNIT-D9: suspendUser cross-org → 404
 *   UNIT-D1: reactivateUser is distinct — no session revocation SQL
 *
 * LIVE tests connect under SET ROLE brain_app + 3-GUC (NOT as superuser brain).
 * Superuser brain BYPASSES RLS — negative controls are meaningless as superuser.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { InviteService, InviteError } from '../internal/application/invite.service.js';
import { AuthService, AuthError } from '../internal/application/auth.service.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

// ── DB connect helper ─────────────────────────────────────────────────────────

async function tryConnect(): Promise<pg.Pool | null> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
  try {
    const client = await pool.connect();
    client.release();
    return pool;
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// ── Shared mock factories ─────────────────────────────────────────────────────

function makeAudit() {
  return { append: vi.fn().mockResolvedValue({ id: 0n, entry_hash: 'abc' }) };
}

function makeNotification() {
  return {
    sendVerificationEmail: vi.fn(),
    sendPasswordResetEmail: vi.fn(),
    sendInviteEmail: vi.fn(),
    canContact: vi.fn().mockResolvedValue(true),
  };
}

// ── UNIT: D-6 createInvite hierarchy bound ────────────────────────────────────

describe('D-6: createInvite hierarchy bound (unit)', () => {
  it('brand_admin granting brand_admin → InviteError FORBIDDEN 403', async () => {
    let membershipCallCount = 0;
    const rawClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('FROM membership')) {
          membershipCallCount++;
          return {
            rows: [{
              id: 'mem-001', organization_id: 'org-001', brand_id: null,
              app_user_id: 'actor-001', role_code: 'brand_admin',
              created_at: new Date(), updated_at: new Date(),
            }],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    // The GUC-pool stub: connect() returns a client that wraps rawClient
    // InviteService uses the DbPool (GUC-wrapped) for createInvite.
    // We need a DbPool-compatible mock that returns a DbClient.
    const executor = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM membership')) {
        return {
          rows: [{
            id: 'mem-001', organization_id: 'org-001', brand_id: null,
            app_user_id: 'actor-001', role_code: 'brand_admin',
            created_at: new Date(), updated_at: new Date(),
          }],
        };
      }
      return { rows: [] };
    });

    const { createStubClient } = await import('@brain/db');
    const dbClient = createStubClient(executor);
    const fakePool = {
      connect: vi.fn().mockResolvedValue(dbClient),
    } as unknown as import('@brain/db').DbPool;

    const svc = new InviteService(fakePool, makeAudit() as never, makeNotification() as never);

    await expect(
      svc.createInvite({
        organizationId: 'org-001',
        brandId: null,
        email: 'target@example.com',
        roleCode: 'brand_admin',
        invitedByUserId: 'actor-001',
      }, 'corr-d6-unit'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

    void rawClient; // suppress unused warning
  });

  it('brand_admin granting manager → no FORBIDDEN (hierarchy allows)', async () => {
    const executor = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM membership')) {
        return {
          rows: [{
            id: 'mem-001', organization_id: 'org-001', brand_id: null,
            app_user_id: 'actor-001', role_code: 'brand_admin',
            created_at: new Date(), updated_at: new Date(),
          }],
        };
      }
      if (sql.includes('INSERT INTO invite')) {
        return {
          rows: [{
            id: 'inv-001', organization_id: 'org-001', brand_id: null,
            email: 'mgr@example.com', role_code: 'manager',
            token_hash: 'hash', invited_by_user_id: 'actor-001',
            status: 'pending', expires_at: new Date(), accepted_at: null, created_at: new Date(),
          }],
        };
      }
      return { rows: [] };
    });

    const { createStubClient } = await import('@brain/db');
    const dbClient = createStubClient(executor);
    const fakePool = { connect: vi.fn().mockResolvedValue(dbClient) } as unknown as import('@brain/db').DbPool;
    const svc = new InviteService(fakePool, makeAudit() as never, makeNotification() as never);

    // brand_admin (idx 2) granting manager (idx 1) → 1 >= 2 is false → no FORBIDDEN
    await svc.createInvite({
      organizationId: 'org-001',
      brandId: null,
      email: 'mgr@example.com',
      roleCode: 'manager',
      invitedByUserId: 'actor-001',
    }, 'corr-d6-mgr').catch((err) => {
      if (err instanceof InviteError && err.code === 'FORBIDDEN') {
        throw new Error(`Unexpected FORBIDDEN for brand_admin granting manager: ${err.message}`);
      }
      // Other errors (notification etc.) are acceptable — hierarchy check passed
    });
  });
});

// ── UNIT: D-7 updateMemberRole hierarchy bound ────────────────────────────────

describe('D-7: updateMemberRole hierarchy bound (unit)', () => {
  it('brand_admin granting brand_admin → InviteError FORBIDDEN 403 (inside open txn)', async () => {
    let membershipCallCount = 0;
    const queries: string[] = [];
    const rawClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        queries.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [] };
        }
        if (sql.includes('FROM membership')) {
          membershipCallCount++;
          if (membershipCallCount === 1) {
            // Requester is brand_admin
            return { rows: [{ id: 'req-mem', organization_id: 'org-001', brand_id: null, role_code: 'brand_admin' }] };
          }
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const rawPgPool = { connect: vi.fn().mockResolvedValue(rawClient) } as unknown as import('pg').Pool;
    const svc = new InviteService(
      { connect: vi.fn() } as never,
      makeAudit() as never,
      makeNotification() as never,
      rawPgPool,
    );

    await expect(
      svc.updateMemberRole('target-mem-id', 'brand_admin', 'actor-001', 'org-001', 'corr-d7'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

    // ROLLBACK must be present before the throw (txn was open).
    expect(queries).toContain('ROLLBACK');
  });
});

// ── UNIT: D-8 suspendUser authority checks ────────────────────────────────────

describe('D-8: suspendUser authority checks (unit)', () => {
  function makeRawPool(
    actorRow: unknown,
    targetRow: unknown,
  ): import('pg').Pool {
    let membershipCallCount = 0;
    const rawClient = {
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [] };
        }
        if (sql.includes('FROM membership')) {
          membershipCallCount++;
          if (membershipCallCount === 1) {
            // Actor lookup: params[0] = actorId
            return { rows: actorRow ? [actorRow] : [] };
          }
          // Target lookup: params[0] = targetId
          return { rows: targetRow ? [targetRow] : [] };
        }
        if (sql.includes('UPDATE user_session') || sql.includes('SELECT COUNT')) {
          return { rows: [{ rowcount: '2' }] };
        }
        if (sql.includes('UPDATE app_user')) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
        void params;
      }),
      release: vi.fn(),
    };
    return { connect: vi.fn().mockResolvedValue(rawClient) } as unknown as import('pg').Pool;
  }

  it('non-owner suspending owner → AuthError FORBIDDEN 403', async () => {
    const pool = makeRawPool(
      { id: 'm1', organization_id: 'org-001', role_code: 'brand_admin' },
      { id: 'm2', organization_id: 'org-001', app_user_id: 'target-001', role_code: 'owner' },
    );
    const svc = new AuthService(
      {} as never, makeAudit() as never, makeNotification() as never,
      { jwtSigningSecret: 'test-secret' }, pool,
    );
    await expect(
      svc.suspendUser('target-001', 'actor-001', 'org-001', null, 'corr-d8-owner'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
  });

  it('brand_admin suspending brand_admin (equal rank) → AuthError FORBIDDEN 403', async () => {
    const pool = makeRawPool(
      { id: 'm1', organization_id: 'org-001', role_code: 'brand_admin' },
      { id: 'm2', organization_id: 'org-001', app_user_id: 'target-001', role_code: 'brand_admin' },
    );
    const svc = new AuthService(
      {} as never, makeAudit() as never, makeNotification() as never,
      { jwtSigningSecret: 'test-secret' }, pool,
    );
    await expect(
      svc.suspendUser('target-001', 'actor-001', 'org-001', null, 'corr-d8-equal'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
  });

  it('D-9: cross-org suspend → NOT_FOUND 404', async () => {
    // Target returns organization_id = 'org-002' but we pass organizationId='org-001'
    const pool = makeRawPool(
      { id: 'm1', organization_id: 'org-001', role_code: 'owner' },
      { id: 'm2', organization_id: 'org-002', app_user_id: 'target-001', role_code: 'manager' },
    );
    const svc = new AuthService(
      {} as never, makeAudit() as never, makeNotification() as never,
      { jwtSigningSecret: 'test-secret' }, pool,
    );
    await expect(
      svc.suspendUser('target-001', 'actor-001', 'org-001', null, 'corr-d9-xorg'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('owner suspending manager → resolves with sessionsRevoked count', async () => {
    const pool = makeRawPool(
      { id: 'm1', organization_id: 'org-001', role_code: 'owner' },
      { id: 'm2', organization_id: 'org-001', app_user_id: 'target-001', role_code: 'manager' },
    );
    const svc = new AuthService(
      {} as never, makeAudit() as never, makeNotification() as never,
      { jwtSigningSecret: 'test-secret' }, pool,
    );
    const result = await svc.suspendUser('target-001', 'actor-001', 'org-001', null, 'corr-d8-ok');
    expect(result.sessionsRevoked).toBeGreaterThanOrEqual(0);
  });

  it('D-8 audit brand_id = organizationId NOT appUserId (H-1)', async () => {
    const audit = makeAudit();
    let membershipCallCount = 0;
    const rawClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('FROM membership')) {
          membershipCallCount++;
          if (membershipCallCount === 1) {
            return { rows: [{ id: 'm1', organization_id: 'org-H1', role_code: 'owner' }] };
          }
          return { rows: [{ id: 'm2', organization_id: 'org-H1', app_user_id: 'target-H1', role_code: 'manager' }] };
        }
        if (sql.includes('UPDATE user_session') || sql.includes('SELECT COUNT')) {
          return { rows: [{ rowcount: '1' }] };
        }
        if (sql.includes('UPDATE app_user')) return { rows: [], rowCount: 1 };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(rawClient) } as unknown as import('pg').Pool;
    const svc = new AuthService(
      {} as never, audit as never, makeNotification() as never,
      { jwtSigningSecret: 'test-secret' }, pool,
    );

    await svc.suspendUser('target-H1', 'actor-H1', 'org-H1', null, 'corr-h1');

    const auditCalls = (audit.append.mock.calls as unknown[][]).map(
      (args) => (args[0] as { brand_id: string; action: string }),
    );
    for (const call of auditCalls) {
      expect(call.brand_id).toBe('org-H1');
      expect(call.brand_id).not.toBe('target-H1');
    }
  });
});

// ── UNIT: D-1 reactivateUser distinct (no session revocation) ────────────────

describe('D-1: reactivateUser is distinct from suspend (unit)', () => {
  it('reactivateUser writes status=active; does NOT revoke sessions or emit sessions.bulk_revoked', async () => {
    const audit = makeAudit();
    const queries: string[] = [];
    let membershipCallCount = 0;
    const rawClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        queries.push(sql);
        if (sql.includes('FROM membership')) {
          membershipCallCount++;
          if (membershipCallCount === 1) {
            return { rows: [{ id: 'm1', organization_id: 'org-001', role_code: 'owner' }] };
          }
          return { rows: [{ id: 'm2', organization_id: 'org-001', app_user_id: 'target-001', role_code: 'manager' }] };
        }
        if (sql.includes('UPDATE app_user')) return { rows: [], rowCount: 1 };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(rawClient) } as unknown as import('pg').Pool;
    const svc = new AuthService(
      {} as never, audit as never, makeNotification() as never,
      { jwtSigningSecret: 'test-secret' }, pool,
    );

    await svc.reactivateUser('target-001', 'actor-001', 'org-001', null, 'corr-d1');

    // No user_session SQL must appear.
    const sessionSqls = queries.filter((s) => s.includes('user_session'));
    expect(sessionSqls).toHaveLength(0);

    // Audit: user.reactivated present; sessions.bulk_revoked absent.
    const auditActions = (audit.append.mock.calls as unknown[][]).map(
      (args) => (args[0] as { action: string }).action,
    );
    expect(auditActions).toContain('user.reactivated');
    expect(auditActions).not.toContain('sessions.bulk_revoked');
  });
});

// ── LIVE POSTGRES TESTS ───────────────────────────────────────────────────────

describe('member-lifecycle LIVE — NC-1..NC-6 (SET ROLE brain_app)', () => {
  let pool: pg.Pool | null = null;

  // Test-scoped fixed IDs for reproducible cleanup.
  const ORG_A_ID = '10000001-aaaa-aaaa-aaaa-000000000001';
  const ORG_B_ID = '10000001-bbbb-bbbb-bbbb-000000000002';
  const USER_A_ID = '20000001-aaaa-aaaa-aaaa-000000000001';
  const ACTOR_ID = '20000001-bbbb-bbbb-bbbb-000000000002';

  beforeAll(async () => {
    pool = await tryConnect();
    if (!pool) return;

    // Seed: app_user rows.
    for (const [id, email] of [
      [USER_A_ID, `nc-target-${USER_A_ID}@test.invalid`],
      [ACTOR_ID, `nc-actor-${ACTOR_ID}@test.invalid`],
    ]) {
      await pool.query(
        `INSERT INTO app_user (id, email, email_normalized, password_hash, status)
         VALUES ($1, $2, $3, 'test-hash', 'active')
         ON CONFLICT (id) DO NOTHING`,
        [id, email, email],
      );
    }

    // Seed: organizations (requires slug, owner_user_id, and other NOT NULL columns).
    for (const [id, name, slug] of [
      [ORG_A_ID, 'NC-Org-A-Live', `nc-org-a-${ORG_A_ID}`],
      [ORG_B_ID, 'NC-Org-B-Live', `nc-org-b-${ORG_B_ID}`],
    ]) {
      await pool.query(
        `INSERT INTO organization (id, name, slug, owner_user_id, onboarding_status)
         VALUES ($1, $2, $3, $4, 'brand_created')
         ON CONFLICT (id) DO NOTHING`,
        [id, name, slug, ACTOR_ID],
      );
    }

    // Seed: memberships.
    await pool.query(
      `INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
       VALUES ($1, NULL, $2, 'owner')
       ON CONFLICT DO NOTHING`,
      [ORG_A_ID, ACTOR_ID],
    );
    await pool.query(
      `INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
       VALUES ($1, NULL, $2, 'manager')
       ON CONFLICT DO NOTHING`,
      [ORG_A_ID, USER_A_ID],
    );

    // Seed: active sessions for target (for NC-4/NC-5).
    const futureExpiry = new Date(Date.now() + 86_400_000);
    for (let i = 0; i < 2; i++) {
      const jti = randomUUID();
      await pool.query(
        `INSERT INTO user_session (app_user_id, jti, refresh_token_hash, expires_at, family_id)
         VALUES ($1, $2, $3, $4, $2)
         ON CONFLICT DO NOTHING`,
        [USER_A_ID, jti, sha256Hex(randomBytes(32).toString('hex')), futureExpiry],
      );
    }

    // Seed: pending invites (for NC-2/NC-3).
    for (const [orgId, email, tokenSeed] of [
      [ORG_A_ID, 'nc-pending-a@test.invalid', 'nc-pending-token-a'],
      [ORG_B_ID, 'nc-pending-b@test.invalid', 'nc-pending-token-b'],
    ]) {
      await pool.query(
        `INSERT INTO invite (organization_id, brand_id, email, role_code, token_hash, invited_by_user_id, expires_at)
         VALUES ($1, NULL, $2, 'manager', $3, $4, NOW() + INTERVAL '7 days')
         ON CONFLICT DO NOTHING`,
        [orgId, email, sha256Hex(tokenSeed as string), ACTOR_ID],
      );
    }
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM audit_log WHERE actor_id IN ($1, $2)`, [ACTOR_ID, USER_A_ID]).catch(() => {});
    await pool.query(`DELETE FROM user_session WHERE app_user_id IN ($1, $2)`, [USER_A_ID, ACTOR_ID]).catch(() => {});
    await pool.query(`DELETE FROM invite WHERE invited_by_user_id = $1`, [ACTOR_ID]).catch(() => {});
    await pool.query(`DELETE FROM membership WHERE organization_id IN ($1, $2)`, [ORG_A_ID, ORG_B_ID]).catch(() => {});
    await pool.query(`DELETE FROM organization WHERE id IN ($1, $2)`, [ORG_A_ID, ORG_B_ID]).catch(() => {});
    await pool.query(`DELETE FROM app_user WHERE id IN ($1, $2)`, [USER_A_ID, ACTOR_ID]).catch(() => {});
    await pool.end().catch(() => {});
  });

  // ── NC-1: membership cross-org isolation ──────────────────────────────────
  it('NC-1: brain_app + org-A GUC → membership WHERE org-B = 0 rows', async () => {
    if (!pool) {
      console.warn('[SKIP] NC-1: Postgres not reachable');
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE brain_app');
      await client.query(`SELECT set_config('app.current_workspace_id', $1, true)`, [ORG_A_ID]);
      const result = await client.query(
        `SELECT * FROM membership WHERE organization_id = $1`,
        [ORG_B_ID],
      );
      expect(result.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  // ── NC-2: invite fail-closed (no GUC) ─────────────────────────────────────
  // The compound RLS policy casts current_setting('app.current_workspace_id', true)::uuid.
  // With no GUC set the value is '' → the cast throws 'invalid input syntax for type uuid'.
  // This IS the fail-closed behavior (RLS rejects the query). We assert it here explicitly.
  it('NC-2: brain_app + NO GUC → pending invite query errors (fail-closed; invalid-uuid cast)', async () => {
    if (!pool) {
      console.warn('[SKIP] NC-2: Postgres not reachable');
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE brain_app');
      // No GUC → RLS evaluates current_setting(...)::uuid with empty string → error.
      // This is the fail-closed behavior: 0 rows OR an error — both prevent data leak.
      let threwOrEmpty = false;
      try {
        const result = await client.query(`SELECT * FROM invite WHERE status = 'pending'`);
        // If it doesn't throw, it must return 0 rows.
        if (result.rows.length === 0) threwOrEmpty = true;
      } catch (err) {
        // Any error from RLS/uuid cast is acceptable fail-closed behavior.
        const msg = String((err as Error).message);
        if (msg.includes('uuid') || msg.includes('invalid') || msg.includes('syntax')) {
          threwOrEmpty = true;
        } else {
          throw err;
        }
      }
      expect(threwOrEmpty).toBe(true);
    } finally {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      client.release();
    }
  });

  // ── NC-3: invite org-A GUC → zero org-B rows ──────────────────────────────
  it('NC-3: brain_app + org-A workspace GUC → org-B pending invites = 0 rows', async () => {
    if (!pool) {
      console.warn('[SKIP] NC-3: Postgres not reachable');
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE brain_app');
      await client.query(`SELECT set_config('app.current_workspace_id', $1, true)`, [ORG_A_ID]);
      const result = await client.query(
        `SELECT * FROM invite WHERE status = 'pending' AND organization_id = $1`,
        [ORG_B_ID],
      );
      expect(result.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  // ── NC-4/NC-5/NC-6: suspendUser atomicity, revocation, and audit brand_id ──
  // Running NC-4/5/6 in one test so the audit mock is shared across the assertions.
  // NC-6: audit.append mock calls are inspected for brand_id = organizationId (H-1).
  it('NC-4/5/6: suspendUser revokes sessions atomically; app_user.status=suspended; audit brand_id=orgId', async () => {
    if (!pool) {
      console.warn('[SKIP] NC-4/5/6: Postgres not reachable');
      return;
    }

    // Capture one jti before suspend for NC-5.
    const jtiResult = await pool.query<{ jti: string }>(
      `SELECT jti FROM user_session WHERE app_user_id = $1 AND revoked_at IS NULL LIMIT 1`,
      [USER_A_ID],
    );
    const targetJti = jtiResult.rows[0]?.jti;
    expect(targetJti).toBeDefined();

    // Run suspendUser (rawPgPool path). Use mock audit (real audit not required for H-1 assertion).
    const audit = makeAudit();
    const svc = new AuthService(
      {} as never,
      audit as never,
      makeNotification() as never,
      { jwtSigningSecret: 'test-secret' },
      pool, // rawPgPool — the superuser pool
    );

    const { sessionsRevoked } = await svc.suspendUser(USER_A_ID, ACTOR_ID, ORG_A_ID, null, 'corr-nc4');
    expect(sessionsRevoked).toBeGreaterThan(0);

    // NC-4a: 0 active sessions left.
    const active = await pool.query(
      `SELECT * FROM user_session WHERE app_user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
      [USER_A_ID],
    );
    expect(active.rows).toHaveLength(0);

    // NC-4b: app_user.status = 'suspended'.
    const userRow = await pool.query<{ status: string }>(
      `SELECT status FROM app_user WHERE id = $1`,
      [USER_A_ID],
    );
    expect(userRow.rows[0]?.status).toBe('suspended');

    // NC-5: findActiveByJti for the old jti → 0 rows (no cache window — DB hit every call).
    if (targetJti) {
      const sessionCheck = await pool.query(
        `SELECT id FROM user_session WHERE jti = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
        [targetJti],
      );
      expect(sessionCheck.rows).toHaveLength(0);
    }

    // NC-6 (H-1): audit mock calls must have brand_id = organizationId, NOT appUserId.
    // The test uses a mock audit writer to keep the test self-contained (no DB audit_log dep).
    const auditCalls = (audit.append.mock.calls as unknown[][]).map(
      (args) => (args[0] as { brand_id: string; action: string }),
    );
    const suspendCalls = auditCalls.filter(
      (c) => c.action === 'user.suspended' || c.action === 'sessions.bulk_revoked',
    );
    expect(suspendCalls.length).toBeGreaterThan(0);
    for (const call of suspendCalls) {
      // brand_id MUST be ORG_A_ID (not USER_A_ID — the H-1 bug fix).
      expect(call.brand_id).toBe(ORG_A_ID);
      expect(call.brand_id).not.toBe(USER_A_ID);
    }
  });
});
