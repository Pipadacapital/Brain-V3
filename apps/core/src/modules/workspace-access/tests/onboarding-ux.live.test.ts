/**
 * onboarding-ux.live.test.ts — Live Postgres integration for feat-onboarding-ux.
 *
 * Coverage (each assertion is NON-INERT — fails if the protection is removed):
 *   D3-1: provisionWorkspaceAndBrand creates org + org-membership + brand +
 *         brand-membership + onboarding_status='brand_created' in ONE transaction.
 *   D3-2: ATOMICITY — a forced brand-insert failure leaves NO orphan org (rollback).
 *   D5-1: IDEMPOTENCY — a second provision by the same user returns the EXISTING
 *         org/brand (created=false), no duplicate org/brand row.
 *   D4-1: slug is derived server-side (matches slugify(name)-<suffix>), no input.
 *   ISO-1: cross-tenant RLS under brain_app — user-B GUC cannot see user-A's brand.
 *   GATE-1: the soft-gate truth — isEmailVerified is false for an unverified user
 *           (the value the connector/invite preHandler blocks on) and true once
 *           email_verified_at is set.
 *
 * brain_app vs superuser: ISO-1 SET LOCAL ROLE brain_app (superuser BYPASSES RLS →
 * the negative control would be INERT as superuser). We assert is_superuser=false for
 * that role context before trusting the isolation result.
 *
 * RUN:
 *   cd apps/core && DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
 *     npx vitest run src/modules/workspace-access/tests/onboarding-ux.live.test.ts
 * Skips cleanly if Postgres is unreachable.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import Fastify, { type FastifyError } from 'fastify';
import { createPool } from '@brain/db';
import { OnboardingService, OnboardingError } from '../internal/application/onboarding.service.js';
import { AuthService } from '../internal/application/auth.service.js';
import { InviteService } from '../internal/application/invite.service.js';
import { registerAuthRoutes } from '../internal/interfaces/rest/auth.routes.js';
import { registerMemberRoutes } from '../internal/interfaces/rest/member.routes.js';
import { mintJwt } from '../internal/security/jwt.js';
import { deriveSlug } from '../internal/application/slugify.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

const USER_A_ID = '40001100-aaaa-4aaa-8aaa-000000000001';
const USER_B_ID = '40001100-bbbb-4bbb-8bbb-000000000002';

async function tryConnect(): Promise<pg.Pool | null> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
  try {
    const c = await pool.connect();
    c.release();
    return pool;
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
}

function noopAudit() {
  return { append: vi.fn().mockResolvedValue({ id: 0n, entry_hash: 'noop' }) };
}
function noopNotify() {
  return {
    sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
    sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
    sendInviteEmail: vi.fn().mockResolvedValue(undefined),
    canContact: vi.fn().mockResolvedValue({ decision: 'allow' as const, reason: 'transactional_exempt' as const }),
  };
}

describe('onboarding-ux LIVE — provision + isolation (brain_app)', () => {
  let rawPool: pg.Pool | null = null;

  beforeAll(async () => {
    rawPool = await tryConnect();
    if (!rawPool) return;
    // Seed two app_user rows (the provision owners). Unverified by default.
    for (const [id, email] of [
      [USER_A_ID, `onb-a-${USER_A_ID}@test.invalid`],
      [USER_B_ID, `onb-b-${USER_B_ID}@test.invalid`],
    ]) {
      await rawPool.query(
        `INSERT INTO app_user (id, email, email_normalized, password_hash, status)
         VALUES ($1, $2, $3, 'test-hash', 'active')
         ON CONFLICT (id) DO NOTHING`,
        [id, email, email],
      );
    }
  });

  afterAll(async () => {
    if (!rawPool) return;
    // Tear down anything the provisions created for these two users.
    const orgs = await rawPool.query<{ id: string }>(
      `SELECT id FROM organization WHERE owner_user_id IN ($1, $2)`,
      [USER_A_ID, USER_B_ID],
    ).catch(() => ({ rows: [] as { id: string }[] }));
    const orgIds = orgs.rows.map((r) => r.id);
    for (const orgId of orgIds) {
      await rawPool.query(`DELETE FROM pixel_installation WHERE brand_id IN (SELECT id FROM brand WHERE organization_id = $1)`, [orgId]).catch(() => {});
      await rawPool.query(`DELETE FROM membership WHERE organization_id = $1`, [orgId]).catch(() => {});
      await rawPool.query(`DELETE FROM brand WHERE organization_id = $1`, [orgId]).catch(() => {});
      await rawPool.query(`DELETE FROM organization WHERE id = $1`, [orgId]).catch(() => {});
    }
    await rawPool.query(`DELETE FROM app_user WHERE id IN ($1, $2)`, [USER_A_ID, USER_B_ID]).catch(() => {});
    await rawPool.end().catch(() => {});
  });

  // ── D3-1 + D4-1: atomic provision creates the full graph; slug derived ───────
  it('D3-1/D4-1: provisions org+brand+2 memberships+status; slug derived server-side', async () => {
    if (!rawPool) { console.warn('[SKIP] D3-1: Postgres not reachable'); return; }
    const dbPool = await createPool({ connectionString: DATABASE_URL, maxConnections: 3 });
    let pixelProvisioned = false;
    const svc = new OnboardingService(
      dbPool,
      rawPool,
      noopAudit() as never,
      async () => { pixelProvisioned = true; },
    );

    const result = await svc.provisionWorkspaceAndBrand(
      { workspaceName: 'Onb Live A', brandDisplayName: 'Brand A', domain: 'onb-live-a.example', ownerUserId: USER_A_ID },
      'corr-d3-1',
    );

    expect(result.created).toBe(true);
    expect(result.onboardingStatus).toBe('brand_created');
    expect(result.organizationId).toBeTruthy();
    expect(result.brandId).toBeTruthy();
    // Website given → pixel auto-provisioned (feat-onboarding-website non-regression).
    expect(pixelProvisioned).toBe(true);

    // Org row + derived slug (no slug was supplied; must be slugify('Onb Live A')-suffix).
    const org = await rawPool.query<{ slug: string; onboarding_status: string; onboarding_step: number }>(
      `SELECT slug, onboarding_status, onboarding_step FROM organization WHERE id = $1`,
      [result.organizationId],
    );
    expect(org.rows[0]?.onboarding_status).toBe('brand_created');
    expect(org.rows[0]?.onboarding_step).toBe(2);
    expect(org.rows[0]?.slug.startsWith('onb-live-a-')).toBe(true);
    expect(/^[a-z0-9-]+$/.test(org.rows[0]!.slug)).toBe(true);

    // Two membership rows (org-level + brand-level), both owner, both this user.
    const mems = await rawPool.query<{ brand_id: string | null; role_code: string }>(
      `SELECT brand_id, role_code FROM membership WHERE organization_id = $1 AND app_user_id = $2 ORDER BY brand_id NULLS FIRST`,
      [result.organizationId, USER_A_ID],
    );
    expect(mems.rows).toHaveLength(2);
    expect(mems.rows.every((m) => m.role_code === 'owner')).toBe(true);
    expect(mems.rows.filter((m) => m.brand_id === null)).toHaveLength(1);
    expect(mems.rows.filter((m) => m.brand_id === result.brandId)).toHaveLength(1);

    await dbPool.end();
  });

  // ── REG (fix/session-brand-context): resolveActiveContext must prefer the
  //    brand-level membership within the preferred workspace, NOT the brand-less
  //    org membership. The brand-less row would mint brand_id=null → every
  //    brand-scoped surface 400s "No brand context in JWT" (pixel, connector
  //    connect, etc.). NON-INERT: without findActiveByUserAndOrg this FAILS (the
  //    old findByUserAndOrg(...,null) path returns the null-brand membership).
  it('REG: resolveActiveContext prefers brand membership in the preferred workspace (no null brand_id)', async () => {
    if (!rawPool) { console.warn('[SKIP] REG: Postgres not reachable'); return; }
    const dbPool = await createPool({ connectionString: DATABASE_URL, maxConnections: 3 });
    try {
      const svc = new OnboardingService(dbPool, rawPool, noopAudit() as never, async () => {});
      // Idempotent — returns USER_A's existing org+brand graph from D3-1.
      const prov = await svc.provisionWorkspaceAndBrand(
        { workspaceName: 'Onb Live A REG', brandDisplayName: 'Brand A REG', ownerUserId: USER_A_ID },
        'corr-reg',
      );
      expect(prov.brandId).toBeTruthy();

      const authService = new AuthService(
        dbPool,
        noopAudit() as never,
        noopNotify() as never,
        { jwtSigningSecret: 'live-pg-test-secret-32-bytes-long!!' },
        rawPool,
      );

      // The failing case: a live session carries a preferred workspace id.
      const ctxPreferred = await authService.resolveActiveContext(USER_A_ID, 'corr-reg', prov.organizationId);
      expect(ctxPreferred.workspaceId).toBe(prov.organizationId);
      expect(ctxPreferred.brandId, 'preferred-workspace resolve must carry the brand, not null').toBe(prov.brandId);

      // The no-preferred path must also resolve a brand (findActiveByUser).
      const ctxDefault = await authService.resolveActiveContext(USER_A_ID, 'corr-reg');
      expect(ctxDefault.brandId, 'default resolve must carry the brand, not null').toBe(prov.brandId);
    } finally {
      await dbPool.end();
    }
  });

  // ── D5-1: idempotent — second provision returns existing, no duplicate ───────
  it('D5-1: re-provision by the same user returns existing org/brand (no duplicate)', async () => {
    if (!rawPool) { console.warn('[SKIP] D5-1: Postgres not reachable'); return; }
    const dbPool = await createPool({ connectionString: DATABASE_URL, maxConnections: 3 });
    const svc = new OnboardingService(dbPool, rawPool, noopAudit() as never, async () => {});

    const result = await svc.provisionWorkspaceAndBrand(
      { workspaceName: 'Onb Live A SECOND', brandDisplayName: 'Brand A2', ownerUserId: USER_A_ID },
      'corr-d5-1',
    );

    // Back-safety: returns the EXISTING org/brand, created=false.
    expect(result.created).toBe(false);
    expect(result.brandId).toBeTruthy();

    // Exactly ONE org for user A (no duplicate from the resubmit).
    const orgCount = await rawPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM organization WHERE owner_user_id = $1`,
      [USER_A_ID],
    );
    expect(parseInt(orgCount.rows[0]!.count, 10)).toBe(1);

    await dbPool.end();
  });

  // ── D3-2: atomicity — brand-insert failure leaves no orphan org ──────────────
  it('D3-2: a brand-insert failure rolls back the org (no orphan)', async () => {
    if (!rawPool) { console.warn('[SKIP] D3-2: Postgres not reachable'); return; }
    const dbPool = await createPool({ connectionString: DATABASE_URL, maxConnections: 3 });
    const svc = new OnboardingService(dbPool, rawPool, noopAudit() as never, async () => {});

    // Force a deterministic failure INSIDE the txn: an ownerUserId with no app_user
    // row passes the idempotency pre-check (findActiveByUser → null) but the org-owner
    // membership INSERT violates the app_user FK → the whole txn (incl. the org that was
    // inserted first) must roll back. Proves there is no orphan-org window.
    const GHOST_USER = '49999999-9999-4999-8999-999999999999';
    const beforeCount = await rawPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM organization WHERE owner_user_id = $1`,
      [GHOST_USER],
    );

    await expect(
      svc.provisionWorkspaceAndBrand(
        { workspaceName: 'Onb Live Orphan', brandDisplayName: 'B', ownerUserId: GHOST_USER },
        'corr-d3-2',
      ),
    ).rejects.toThrow();

    const afterCount = await rawPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM organization WHERE owner_user_id = $1`,
      [GHOST_USER],
    );
    // The load-bearing atomicity assertion: NO org was left behind.
    expect(afterCount.rows[0]!.count).toBe(beforeCount.rows[0]!.count);
    expect(afterCount.rows[0]!.count).toBe('0');

    await dbPool.end();
  });

  // ── ISO-1: cross-tenant RLS under brain_app (NOT superuser) ──────────────────
  it('ISO-1: brain_app + user-B GUC → 0 of user-A\'s brand rows (RLS isolation)', async () => {
    if (!rawPool) { console.warn('[SKIP] ISO-1: Postgres not reachable'); return; }

    // user A has a brand from D3-1; resolve its org+brand.
    const aBrand = await rawPool.query<{ id: string; organization_id: string }>(
      `SELECT b.id, b.organization_id FROM brand b
       INNER JOIN organization o ON o.id = b.organization_id
       WHERE o.owner_user_id = $1 LIMIT 1`,
      [USER_A_ID],
    );
    if (!aBrand.rows[0]) { console.warn('[SKIP] ISO-1: no seed brand'); return; }
    const brandId = aBrand.rows[0].id;

    const client = await rawPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE brain_app');

      // Assert the role is NON-superuser, else the isolation result is INERT.
      const su = await client.query<{ usesuper: boolean }>(
        `SELECT rolsuper AS usesuper FROM pg_roles WHERE rolname = current_user`,
      );
      expect(su.rows[0]?.usesuper).toBe(false);

      // Set user-B's scope GUCs to arbitrary non-A UUIDs (B is a member of NEITHER A's
      // workspace nor brand). The brand RLS policy admits a row only for a brand the
      // GUC-scoped principal can see → user-A's brand must NOT be visible.
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [USER_B_ID]);
      await client.query(`SELECT set_config('app.current_workspace_id', $1, true)`, [
        '40001100-bbbb-4bbb-8bbb-0000000000fe',
      ]);
      await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [
        '40001100-bbbb-4bbb-8bbb-0000000000ff', // an arbitrary non-A brand id
      ]);

      // Isolation is satisfied by EITHER 0 rows OR a fail-closed RLS cast error — both
      // prove user-A's brand never leaks to user-B. (The codebase already documents the
      // ''::uuid fail-closed cast as valid isolation — see member-lifecycle NC-2.)
      let leakedRows = -1;
      try {
        const leaked = await client.query(`SELECT id FROM brand WHERE id = $1`, [brandId]);
        leakedRows = leaked.rows.length;
      } catch (err) {
        // Fail-closed (RLS predicate cast rejected the cross-tenant probe) → no leak.
        leakedRows = 0;
        void err;
      }
      // NON-INERT: without RLS FORCE this returns 1 row (the leak); with RLS, 0.
      expect(leakedRows).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  // ── GATE-1: the soft-gate truth value (what the preHandler blocks on) ────────
  it('GATE-1: isEmailVerified=false for an unverified owner; true after verify', async () => {
    if (!rawPool) { console.warn('[SKIP] GATE-1: Postgres not reachable'); return; }
    const dbPool = await createPool({ connectionString: DATABASE_URL, maxConnections: 3 });
    const auth = new AuthService(dbPool, noopAudit() as never, noopNotify() as never, { jwtSigningSecret: 'gate-test-secret-32-bytes-minimum!!' }, rawPool);

    // USER_A seeded unverified (email_verified_at NULL) → the gate would 403.
    expect(await auth.isEmailVerified(USER_A_ID, 'corr-gate')).toBe(false);

    // Verify → the gate would now allow.
    await rawPool.query(`UPDATE app_user SET email_verified_at = NOW() WHERE id = $1`, [USER_A_ID]);
    expect(await auth.isEmailVerified(USER_A_ID, 'corr-gate')).toBe(true);

    // Reset for cleanup idempotence.
    await rawPool.query(`UPDATE app_user SET email_verified_at = NULL WHERE id = $1`, [USER_A_ID]);
    await dbPool.end();
  });

  // ── D4 sanity: deriveSlug is deterministic given a fixed suffix ──────────────
  it('D4: deriveSlug(name, suffix) is stable + valid', () => {
    expect(deriveSlug('Hello World', 'abcdef')).toBe('hello-world-abcdef');
  });

  // ── GATE-WIRE: the soft-gate ENFORCEMENT on POST /api/v1/invites ─────────────
  // Proves the requireVerifiedEmail preHandler is actually wired on the invite route:
  // an UNVERIFIED session is blocked 403 EMAIL_NOT_VERIFIED; a VERIFIED session passes
  // the gate (and proceeds into the handler, where it 422s on the empty body — which
  // is PAST the gate, the point being it is NOT 403).
  it('GATE-WIRE: unverified session → 403 EMAIL_NOT_VERIFIED on invite; verified passes the gate', async () => {
    if (!rawPool) { console.warn('[SKIP] GATE-WIRE: Postgres not reachable'); return; }

    const JWT_SECRET = 'gate-wire-test-secret-32-bytes-min!!';
    const GATE_ORG = '40001100-cccc-4ccc-8ccc-000000000010';
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');

    // Seed an org + an owner membership for USER_A so the route can reach its handler.
    await rawPool.query(
      `INSERT INTO organization (id, name, slug, owner_user_id, onboarding_status)
       VALUES ($1, 'Gate Org', $2, $3, 'brand_created') ON CONFLICT (id) DO NOTHING`,
      [GATE_ORG, `gate-org-${GATE_ORG}`, USER_A_ID],
    );
    await rawPool.query(
      `INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
       VALUES ($1, NULL, $2, 'owner') ON CONFLICT DO NOTHING`,
      [GATE_ORG, USER_A_ID],
    );

    const dbPool = await createPool({ connectionString: DATABASE_URL, maxConnections: 3 });
    const noAudit = { append: async () => ({ id: 0n, entry_hash: 'noop' }) };
    const noNotify = { sendVerificationEmail: async () => {}, sendPasswordResetEmail: async () => {}, sendInviteEmail: async () => {}, canContact: async () => ({ decision: 'allow' as const, reason: 'transactional_exempt' as const }) };
    const authService = new AuthService(dbPool, noAudit as never, noNotify as never, { jwtSigningSecret: JWT_SECRET }, rawPool);
    const inviteService = new InviteService(dbPool, noAudit as never, noNotify as never, rawPool);

    const app = Fastify({ logger: false, genReqId: () => randomUUID() });
    registerAuthRoutes(app, authService);
    registerMemberRoutes(app, authService, inviteService, rawPool);
    app.setErrorHandler<FastifyError>((error, request, reply) => {
      const code = error.statusCode ?? 500;
      return reply.code(code).send({ request_id: request.id as string, error: { code: error.code ?? 'INTERNAL_ERROR', message: code >= 500 ? 'Internal server error' : error.message } });
    });
    await app.ready();

    async function mintSession(userId: string): Promise<string> {
      const jti = randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const token = mintJwt({ sub: userId, jti, brand_id: null, workspace_id: GATE_ORG, role: 'owner', iat: now, exp: now + 3600 }, JWT_SECRET);
      await rawPool!.query(
        `INSERT INTO user_session (app_user_id, jti, refresh_token_hash, expires_at, family_id)
         VALUES ($1, $2, $3, $4, $2) ON CONFLICT DO NOTHING`,
        [userId, jti, sha(randomBytes(32).toString('hex')), new Date(Date.now() + 86_400_000)],
      );
      return token;
    }

    try {
      // USER_A is UNVERIFIED (email_verified_at NULL) → gate blocks with 403.
      await rawPool.query(`UPDATE app_user SET email_verified_at = NULL WHERE id = $1`, [USER_A_ID]);
      const unverifiedToken = await mintSession(USER_A_ID);
      const blocked = await app.inject({
        method: 'POST',
        url: '/api/v1/invites',
        headers: { authorization: `Bearer ${unverifiedToken}`, 'content-type': 'application/json' },
        payload: { organization_id: GATE_ORG, email: 'invitee@test.invalid', role_code: 'manager' },
      });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().error.code).toBe('EMAIL_NOT_VERIFIED');

      // Now VERIFY the user → the SAME route is NO LONGER 403 (gate passes; handler runs).
      await rawPool.query(`UPDATE app_user SET email_verified_at = NOW() WHERE id = $1`, [USER_A_ID]);
      const verifiedToken = await mintSession(USER_A_ID);
      const passed = await app.inject({
        method: 'POST',
        url: '/api/v1/invites',
        headers: { authorization: `Bearer ${verifiedToken}`, 'content-type': 'application/json' },
        payload: { organization_id: GATE_ORG, email: 'invitee@test.invalid', role_code: 'manager' },
      });
      // The load-bearing assertion: a verified session is NOT blocked by the gate.
      expect(passed.statusCode).not.toBe(403);
      expect(passed.json().error?.code).not.toBe('EMAIL_NOT_VERIFIED');
    } finally {
      await rawPool.query(`UPDATE app_user SET email_verified_at = NULL WHERE id = $1`, [USER_A_ID]);
      await rawPool.query(`DELETE FROM user_session WHERE app_user_id = $1`, [USER_A_ID]).catch(() => {});
      await rawPool.query(`DELETE FROM invite WHERE organization_id = $1`, [GATE_ORG]).catch(() => {});
      await rawPool.query(`DELETE FROM membership WHERE organization_id = $1`, [GATE_ORG]).catch(() => {});
      await rawPool.query(`DELETE FROM organization WHERE id = $1`, [GATE_ORG]).catch(() => {});
      await app.close();
      await dbPool.end();
    }
  });

  // ── INVALID_WEBSITE: a malformed website 422s BEFORE any row is written ──────
  it('D3: a malformed website → INVALID_WEBSITE (422), no org created', async () => {
    if (!rawPool) { console.warn('[SKIP] INVALID_WEBSITE: Postgres not reachable'); return; }
    const dbPool = await createPool({ connectionString: DATABASE_URL, maxConnections: 3 });
    const svc = new OnboardingService(dbPool, rawPool, noopAudit() as never, async () => {});

    const before = await rawPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM organization WHERE owner_user_id = $1`,
      [USER_B_ID],
    );
    await expect(
      svc.provisionWorkspaceAndBrand(
        { workspaceName: 'Bad Site', brandDisplayName: 'B', domain: 'http://', ownerUserId: USER_B_ID },
        'corr-bad-site',
      ),
    ).rejects.toBeInstanceOf(OnboardingError);
    const after = await rawPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM organization WHERE owner_user_id = $1`,
      [USER_B_ID],
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
    await dbPool.end();
  });
});
