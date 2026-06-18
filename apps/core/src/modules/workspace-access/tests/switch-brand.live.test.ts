/**
 * QA-1 / §7 — Live Postgres integration test for AuthService.switchBrandContext().
 *
 * WHAT THIS PROVES (feat-multi-brand §7 acceptance contract):
 *   1. Positive path: switch to brand B → returned context has brandId === B and
 *      role === the brand-B membership row's role (MA-01/MA-03 on the wire).
 *   2. Audit: a `brand.switch` row was appended with from_brand_id/to_brand_id/
 *      workspace_id/role_granted (MA-09).
 *   3. Negative path — archived brand (member): throws AuthError BRAND_ARCHIVED (MA-10).
 *   4. Negative path — non-member brand: throws AuthError FORBIDDEN (MA-02).
 *
 * NEGATIVE-CONTROL (non-inert):
 *   Removing the `if (!row) throw FORBIDDEN` guard from switchBrandContext() causes
 *   LIVE-SB-4 (non-member → FORBIDDEN) to fail.
 *   Removing the archived guard causes LIVE-SB-3 (archived → BRAND_ARCHIVED) to fail.
 *   These are structural guards — removing them is a detectable regression.
 *
 * RUN:
 *   DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
 *     npx vitest run src/modules/workspace-access/tests/switch-brand.live.test.ts
 *
 * Skips cleanly if DATABASE_URL is unreachable (CI without Postgres uses mocks only).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '@brain/db';
import { DbAuditWriter, type AuditDbClient } from '@brain/audit';
import { AuthService, AuthError } from '../internal/application/auth.service.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

// ── Connection helpers ────────────────────────────────────────────────────────

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

// ── Test fixtures ─────────────────────────────────────────────────────────────

// Deterministic, stable-across-runs UUIDs for the seeded 2-brand workspace.
// Prefix 11000 to avoid collision with real data or other test fixtures.
const LIVE_USER_ID          = '11000001-0000-0000-0000-000000000001';
const LIVE_ORG_ID           = '11000002-0000-0000-0000-000000000002';
const LIVE_BRAND_A_ID       = '11000003-0000-0000-0000-000000000003'; // user is 'owner'
const LIVE_BRAND_B_ID       = '11000004-0000-0000-0000-000000000004'; // user is 'analyst'
const LIVE_BRAND_ARCHIVED   = '11000005-0000-0000-0000-000000000005'; // archived + member
const NON_MEMBER_BRAND_ID   = '11000006-0000-0000-0000-000000000006'; // no membership row

// JTI is per-run random — reusing a stable JTI across test runs would cause
// the session revocation guard to fail on 2nd run (session row does not exist).
const LIVE_JTI = randomUUID();

// ── Seed / teardown ───────────────────────────────────────────────────────────

async function seedFixtures(rawPool: pg.Pool): Promise<void> {
  // app_user (no FK deps)
  await rawPool.query(
    `INSERT INTO app_user (id, email, email_normalized, password_hash, status)
     VALUES ($1, $2, $3, 'placeholder-not-used', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [
      LIVE_USER_ID,
      `switch-brand-live-${LIVE_USER_ID}@test.invalid`,
      `switch-brand-live-${LIVE_USER_ID}@test.invalid`,
    ],
  );

  // organization (owner_user_id FK → app_user)
  await rawPool.query(
    `INSERT INTO organization (id, name, slug, owner_user_id, onboarding_status, onboarding_step)
     VALUES ($1, 'switch-brand-live-org', $2, $3, 'complete', 4)
     ON CONFLICT (id) DO NOTHING`,
    [LIVE_ORG_ID, `switch-brand-live-${LIVE_ORG_ID}`, LIVE_USER_ID],
  );

  // org-level membership (M1 invariant — every brand member holds an org-level row, MA-07)
  await rawPool.query(
    `INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
     VALUES ($1, NULL, $2, 'owner')
     ON CONFLICT DO NOTHING`,
    [LIVE_ORG_ID, LIVE_USER_ID],
  );

  // brand A (active) — user is 'owner' at the brand level
  await rawPool.query(
    `INSERT INTO brand (id, organization_id, display_name, status)
     VALUES ($1, $2, 'SB Live Brand A', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [LIVE_BRAND_A_ID, LIVE_ORG_ID],
  );

  // brand B (active) — user is 'analyst' at the brand level
  await rawPool.query(
    `INSERT INTO brand (id, organization_id, display_name, status)
     VALUES ($1, $2, 'SB Live Brand B', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [LIVE_BRAND_B_ID, LIVE_ORG_ID],
  );

  // brand-level memberships: A → owner, B → analyst (same user, same org)
  await rawPool.query(
    `INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
     VALUES ($1, $2, $3, 'owner'), ($1, $4, $3, 'analyst')
     ON CONFLICT DO NOTHING`,
    [LIVE_ORG_ID, LIVE_BRAND_A_ID, LIVE_USER_ID, LIVE_BRAND_B_ID],
  );

  // archived brand — user IS a member (to exercise MA-10: member + archived → BRAND_ARCHIVED)
  await rawPool.query(
    `INSERT INTO brand (id, organization_id, display_name, status)
     VALUES ($1, $2, 'SB Archived Brand', 'archived')
     ON CONFLICT (id) DO NOTHING`,
    [LIVE_BRAND_ARCHIVED, LIVE_ORG_ID],
  );
  await rawPool.query(
    `INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
     VALUES ($1, $2, $3, 'analyst')
     ON CONFLICT DO NOTHING`,
    [LIVE_ORG_ID, LIVE_BRAND_ARCHIVED, LIVE_USER_ID],
  );

  // non-member brand — NO membership row for this user (exercises FORBIDDEN path)
  await rawPool.query(
    `INSERT INTO brand (id, organization_id, display_name, status)
     VALUES ($1, $2, 'SB Non-Member Brand', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [NON_MEMBER_BRAND_ID, LIVE_ORG_ID],
  );
}

async function teardownFixtures(rawPool: pg.Pool): Promise<void> {
  // Remove test audit rows first (no FK from audit_log to other tables)
  await rawPool.query(
    `DELETE FROM audit_log WHERE actor_id = $1`,
    [LIVE_USER_ID],
  ).catch(() => {});
  // FK order: membership → brand → organization → app_user
  await rawPool.query(
    `DELETE FROM membership WHERE organization_id = $1`,
    [LIVE_ORG_ID],
  ).catch(() => {});
  for (const brandId of [LIVE_BRAND_A_ID, LIVE_BRAND_B_ID, LIVE_BRAND_ARCHIVED, NON_MEMBER_BRAND_ID]) {
    await rawPool.query('DELETE FROM brand WHERE id = $1', [brandId]).catch(() => {});
  }
  await rawPool.query('DELETE FROM organization WHERE id = $1', [LIVE_ORG_ID]).catch(() => {});
  await rawPool.query('DELETE FROM app_user WHERE id = $1', [LIVE_USER_ID]).catch(() => {});
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('QA-1 / §7 — AuthService.switchBrandContext LIVE Postgres integration', () => {
  let rawPool: pg.Pool | null = null;
  let authService: AuthService | null = null;
  // A dedicated raw pg.Client for audit writes — DbAuditWriter needs a plain query(sql, params) interface.
  let auditClient: pg.Client | null = null;

  beforeAll(async () => {
    rawPool = await tryConnect();
    if (!rawPool) return; // skip — DB unavailable

    await seedFixtures(rawPool);

    // Open a dedicated raw client for the DbAuditWriter (audit_log has no RLS —
    // 0001_init.sql disables RLS on it; a superuser pg.Client is fine for the test).
    auditClient = new pg.Client({ connectionString: DATABASE_URL });
    await auditClient.connect();

    // Wrap pg.Client as AuditDbClient (DbAuditWriter only needs query(sql, params)).
    const pgAuditClient: AuditDbClient = {
      async query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> {
        const result = await auditClient!.query(sql, params as unknown[]);
        return { rows: result.rows as T[], rowCount: result.rowCount };
      },
    };
    const auditWriter = new DbAuditWriter(pgAuditClient);

    // Build the GUC-middleware-wrapped DbPool (the same factory the prod app uses).
    const dbPool = await createPool({ connectionString: DATABASE_URL, maxConnections: 3 });

    const noopNotify = {
      sendVerificationEmail: async () => {},
      sendPasswordResetEmail: async () => {},
      sendInviteEmail: async () => {},
      canContact: async () => ({ decision: 'allow' as const, reason: 'transactional_exempt' as const }),
    };

    authService = new AuthService(
      dbPool,
      auditWriter,
      noopNotify,
      { jwtSigningSecret: 'live-switch-brand-test-secret-32b!!' },
      rawPool as never,
    );
  });

  afterAll(async () => {
    if (rawPool) {
      await teardownFixtures(rawPool).catch(() => {});
      await rawPool.end().catch(() => {});
    }
    if (auditClient) {
      await auditClient.end().catch(() => {});
    }
  });

  // ── Positive path ─────────────────────────────────────────────────────────

  it('LIVE-SB-1: switch to brand B → context.brandId === B, context.role === analyst (MA-01/MA-03)', async () => {
    if (!rawPool || !authService) {
      console.warn('[SKIP] LIVE-SB-1: Postgres not reachable — skipping live test');
      return;
    }

    const result = await authService.switchBrandContext(
      LIVE_USER_ID,
      LIVE_JTI,
      LIVE_BRAND_A_ID, // fromBrandId (outgoing, audit only)
      LIVE_ORG_ID,     // workspaceId — from JWT, never from the request body (MA-02)
      LIVE_BRAND_B_ID, // requestedBrandId
      randomUUID(),    // correlationId
    );

    // MA-01: mintSessionToken called directly — accessToken returned (not undefined).
    expect(result.accessToken, 'accessToken must be a non-empty string').toBeTruthy();
    expect(typeof result.accessToken).toBe('string');
    expect(result.expiresIn, 'expiresIn must be positive').toBeGreaterThan(0);

    // MA-03: role comes from the brand-B membership row ('analyst'), NOT the org-level row ('owner').
    expect(result.context.brandId, 'brandId must equal brand B').toBe(LIVE_BRAND_B_ID);
    expect(result.context.role, 'role must be analyst (brand-B row), not owner (org-level row)').toBe('analyst');
    expect(result.context.workspaceId, 'workspaceId must equal org').toBe(LIVE_ORG_ID);
  });

  it('LIVE-SB-2: brand.switch audit row written with from/to/workspace/role_granted (MA-09)', async () => {
    if (!rawPool || !authService) {
      console.warn('[SKIP] LIVE-SB-2: Postgres not reachable — skipping live test');
      return;
    }

    // Perform a switch; the DbAuditWriter will INSERT a real audit row.
    await authService.switchBrandContext(
      LIVE_USER_ID,
      LIVE_JTI,
      LIVE_BRAND_A_ID,
      LIVE_ORG_ID,
      LIVE_BRAND_B_ID,
      randomUUID(),
    );

    // Verify the audit row was written (query via rawPool which has superuser access).
    const auditResult = await rawPool.query<{
      action: string;
      actor_id: string;
      actor_role: string;
      payload: {
        from_brand_id: string;
        to_brand_id: string;
        workspace_id: string;
        role_granted: string;
      };
    }>(
      `SELECT action, actor_id, actor_role, payload
       FROM audit_log
       WHERE actor_id = $1 AND action = 'brand.switch'
       ORDER BY id DESC
       LIMIT 1`,
      [LIVE_USER_ID],
    );

    expect(auditResult.rowCount, 'at least one brand.switch audit row must exist').toBeGreaterThan(0);
    const row = auditResult.rows[0]!;
    expect(row.action).toBe('brand.switch');
    expect(row.actor_id).toBe(LIVE_USER_ID);
    expect(row.actor_role, 'actor_role must be analyst (brand-B role)').toBe('analyst');

    // MA-09: payload must contain all four required fields.
    expect(row.payload.to_brand_id, 'to_brand_id must be brand B').toBe(LIVE_BRAND_B_ID);
    expect(row.payload.from_brand_id, 'from_brand_id must be brand A').toBe(LIVE_BRAND_A_ID);
    expect(row.payload.workspace_id, 'workspace_id must be org').toBe(LIVE_ORG_ID);
    expect(row.payload.role_granted, 'role_granted must be analyst').toBe('analyst');
  });

  // ── Negative paths (MA-10/MA-02) ─────────────────────────────────────────

  it('[NEGATIVE] LIVE-SB-3: archived brand → throws AuthError BRAND_ARCHIVED (MA-10)', async () => {
    if (!rawPool || !authService) {
      console.warn('[SKIP] LIVE-SB-3: Postgres not reachable — skipping live test');
      return;
    }

    let caughtErr: unknown;
    try {
      await authService.switchBrandContext(
        LIVE_USER_ID,
        LIVE_JTI,
        LIVE_BRAND_A_ID,
        LIVE_ORG_ID,
        LIVE_BRAND_ARCHIVED, // archived brand — user IS a member (must NOT succeed)
        randomUUID(),
      );
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr, 'archived brand must throw').toBeDefined();
    expect(caughtErr, 'must be an AuthError').toBeInstanceOf(AuthError);
    const authErr = caughtErr as AuthError;
    expect(authErr.code, 'code must be BRAND_ARCHIVED').toBe('BRAND_ARCHIVED');
    expect(authErr.statusCode, 'statusCode must be 400').toBe(400);
  });

  it('[NEGATIVE] LIVE-SB-4: non-member brand → throws AuthError FORBIDDEN (MA-02)', async () => {
    if (!rawPool || !authService) {
      console.warn('[SKIP] LIVE-SB-4: Postgres not reachable — skipping live test');
      return;
    }

    let caughtErr: unknown;
    try {
      await authService.switchBrandContext(
        LIVE_USER_ID,
        LIVE_JTI,
        LIVE_BRAND_A_ID,
        LIVE_ORG_ID,
        NON_MEMBER_BRAND_ID, // user has no membership row for this brand
        randomUUID(),
      );
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr, 'non-member brand must throw').toBeDefined();
    expect(caughtErr, 'must be an AuthError').toBeInstanceOf(AuthError);
    const authErr = caughtErr as AuthError;
    expect(authErr.code, 'code must be FORBIDDEN').toBe('FORBIDDEN');
    expect(authErr.statusCode, 'statusCode must be 403').toBe(403);
  });
});
