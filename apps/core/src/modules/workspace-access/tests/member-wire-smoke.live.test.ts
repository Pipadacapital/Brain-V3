/**
 * member-wire-smoke.live.test.ts — HTTP wire-smoke tests via Fastify app.inject()
 *
 * Resolves QA VETO: F-QA-1 / F-QA-2 / F-QA-3 (feat-members-team-management BOUNCE r1).
 *
 * Coverage (wire-level — real HTTP stack end-to-end via in-process inject):
 *   WIRE-1 (F-QA-1 + SEC-V1): Suspend member → suspended user's next protected HTTP
 *     call returns 401 SESSION_REVOKED. Proves immediate revocation on the wire.
 *   WIRE-2 (F-QA-2): POST /api/v1/invites with brand_admin session + role_code:'brand_admin'
 *     → HTTP 403 FORBIDDEN. Owner control: same route → HTTP 201 (non-tautological).
 *   WIRE-3 (F-QA-3): Seed pending invites in org-A and org-B; GET /api/v1/invites?status=pending
 *     with org-A session → HTTP JSON invites[] contains ONLY org-A IDs, zero org-B IDs.
 *
 * NON-INERT: every assertion would fail if the guard/RLS were removed.
 *   WIRE-1: without the session revocation check in validateSessionPreHandler the suspended
 *     user would receive 200, not 401.
 *   WIRE-2: without the hierarchy check in inviteService.createInvite the brand_admin
 *     caller would receive 201, not 403.
 *   WIRE-3: without the workspaceId GUC / auth.workspaceId scoping the response would
 *     include org-B invites alongside org-A invites.
 *
 * App construction: builds a MINIMAL Fastify instance (no Redis, no argon2 startup)
 * that is structurally identical to the prod path for the routes under test.
 *   - registerAuthRoutes  (required for validateSessionPreHandler)
 *   - registerMemberRoutes (the routes under test)
 * The rest of main.ts (pixel, connector, BFF, dev routes) is NOT mounted — irrelevant
 * to these tests and would require Shopify env vars.
 *
 * RUN:
 *   cd apps/core && \
 *     DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
 *     npx vitest run src/modules/workspace-access/tests/member-wire-smoke.live.test.ts
 *
 * Skips cleanly if Postgres is not reachable (CI without live PG falls back to mock tests).
 * With PG up the tests MUST execute and MUST pass.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import Fastify, { type FastifyError } from 'fastify';
import fastifyCookie from '@fastify/cookie';

import { createPool } from '@brain/db';
import { mintJwt } from '../internal/security/jwt.js';
import { AuthService } from '../internal/application/auth.service.js';
import { InviteService } from '../internal/application/invite.service.js';
import { registerAuthRoutes } from '../internal/interfaces/rest/auth.routes.js';
import { registerMemberRoutes } from '../internal/interfaces/rest/member.routes.js';

// ── Constants ────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const JWT_SIGNING_SECRET = 'wire-smoke-test-secret-32bytes!!';
const COOKIE_SECRET = 'wire-smoke-cookie-secret-32bytes';

// Stable, collision-safe UUIDs for wire-smoke test fixtures (prefix 30001100 avoids
// collision with member-lifecycle (1000xxxx) and switch-brand (1100xxxx) fixtures).
const ORG_A_ID   = '30001100-aaaa-4aaa-aaaa-000000000001';
const ORG_B_ID   = '30001100-bbbb-4bbb-bbbb-000000000002';
const OWNER_ID   = '30001100-cccc-4ccc-8ccc-000000000001';
const ADMIN_ID   = '30001100-dddd-4ddd-8ddd-000000000002';
const TARGET_ID  = '30001100-eeee-4eee-8eee-000000000003';

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

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

/**
 * Mint a valid JWT + insert a live user_session row so validateSessionPreHandler
 * will accept the token.  Returns the raw JWT string.
 */
async function mintLiveJwt(
  rawPool: pg.Pool,
  opts: {
    userId: string;
    workspaceId: string | null;
    role: string | null;
    brandId?: string | null;
  },
): Promise<{ token: string; jti: string }> {
  const jti = randomUUID();
  const nowSecs = Math.floor(Date.now() / 1000);
  const token = mintJwt(
    {
      sub: opts.userId,
      jti,
      brand_id: opts.brandId ?? null,
      workspace_id: opts.workspaceId,
      role: opts.role,
      iat: nowSecs,
      exp: nowSecs + 3600,
    },
    JWT_SIGNING_SECRET,
  );

  const futureExpiry = new Date(Date.now() + 86_400_000);
  await rawPool.query(
    `INSERT INTO user_session (app_user_id, jti, refresh_token_hash, expires_at, family_id)
     VALUES ($1, $2, $3, $4, $2)
     ON CONFLICT DO NOTHING`,
    [
      opts.userId,
      jti,
      sha256Hex(randomBytes(32).toString('hex')),
      futureExpiry,
    ],
  );

  return { token, jti };
}

/**
 * Build a minimal Fastify app with only the routes under test.
 * No Redis, no argon2 startup assertions, no connector/pixel/BFF routes.
 */
async function buildTestApp(rawPool: pg.Pool) {
  const dbPool = await createPool({ connectionString: DATABASE_URL, maxConnections: 3 });

  const noopAudit = {
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
    dbPool,
    noopAudit,
    noopNotify,
    { jwtSigningSecret: JWT_SIGNING_SECRET },
    rawPool,
  );
  const inviteService = new InviteService(dbPool, noopAudit, noopNotify, rawPool);

  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    trustProxy: true,
    genReqId: () => randomUUID(),
  });

  // Register cookie plugin (same as main.ts).
  await app.register(fastifyCookie as unknown as Parameters<typeof app.register>[0], {
    secret: COOKIE_SECRET,
    parseOptions: {},
  });

  // Wire up only the routes we need.
  registerAuthRoutes(app, authService);
  registerMemberRoutes(app, authService, inviteService, rawPool);

  // Minimal error handler matching the prod envelope.
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    return reply.code(statusCode).send({
      request_id: request.id as string,
      error: {
        code: error.code ?? 'INTERNAL_ERROR',
        message: statusCode >= 500 ? 'Internal server error' : error.message,
      },
    });
  });

  await app.ready();

  return { app, authService, dbPool };
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('Wire-smoke: F-QA-1 / F-QA-2 / F-QA-3 (feat-members-team-management BOUNCE r1)', () => {
  let rawPool: pg.Pool | null = null;
  let app: Awaited<ReturnType<typeof buildTestApp>>['app'] | null = null;
  let authService: AuthService | null = null;

  // Membership IDs seeded for suspend route (WIRE-1)
  let ownerMembershipId: string;
  let adminMembershipId: string;
  let targetMembershipId: string;

  // Invite IDs seeded for WIRE-3 cross-org scoping
  let inviteAId: string;
  let inviteBId: string;

  beforeAll(async () => {
    rawPool = await tryConnect();
    if (!rawPool) return; // skip — PG not available

    // ── Seed: users ────────────────────────────────────────────────────────
    for (const [id, email] of [
      [OWNER_ID,  `wswire-owner-${OWNER_ID}@test.invalid`],
      [ADMIN_ID,  `wswire-admin-${ADMIN_ID}@test.invalid`],
      [TARGET_ID, `wswire-target-${TARGET_ID}@test.invalid`],
    ]) {
      // feat-onboarding-ux: these are established org members — seed them EMAIL-VERIFIED
      // so the requireVerifiedEmail soft-gate (which now runs before the role/hierarchy
      // check on POST /api/v1/invites) passes and the test exercises the FORBIDDEN path
      // it targets, not EMAIL_NOT_VERIFIED.
      await rawPool.query(
        `INSERT INTO app_user (id, email, email_normalized, password_hash, status, email_verified_at)
         VALUES ($1, $2, $3, 'test-hash', 'active', NOW())
         ON CONFLICT (id) DO UPDATE SET email_verified_at = NOW()`,
        [id, email, email],
      );
    }

    // ── Seed: organizations ────────────────────────────────────────────────
    for (const [id, name, slug] of [
      [ORG_A_ID, 'WireSmoke-Org-A', `wswire-org-a-${ORG_A_ID}`],
      [ORG_B_ID, 'WireSmoke-Org-B', `wswire-org-b-${ORG_B_ID}`],
    ]) {
      await rawPool.query(
        `INSERT INTO organization (id, name, slug, owner_user_id, onboarding_status)
         VALUES ($1, $2, $3, $4, 'brand_created')
         ON CONFLICT (id) DO NOTHING`,
        [id, name, slug, OWNER_ID],
      );
    }

    // ── Seed: memberships ──────────────────────────────────────────────────
    // OWNER_ID = owner in ORG_A
    const ownerInsert = await rawPool.query<{ id: string }>(
      `INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
       VALUES ($1, NULL, $2, 'owner')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [ORG_A_ID, OWNER_ID],
    );
    // If ON CONFLICT triggered, fetch the existing row id
    if (ownerInsert.rows[0]?.id) {
      ownerMembershipId = ownerInsert.rows[0].id;
    } else {
      const existing = await rawPool.query<{ id: string }>(
        `SELECT id FROM membership WHERE organization_id = $1 AND app_user_id = $2 AND brand_id IS NULL`,
        [ORG_A_ID, OWNER_ID],
      );
      ownerMembershipId = existing.rows[0]!.id;
    }

    // ADMIN_ID = brand_admin in ORG_A
    const adminInsert = await rawPool.query<{ id: string }>(
      `INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
       VALUES ($1, NULL, $2, 'brand_admin')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [ORG_A_ID, ADMIN_ID],
    );
    if (adminInsert.rows[0]?.id) {
      adminMembershipId = adminInsert.rows[0].id;
    } else {
      const existing = await rawPool.query<{ id: string }>(
        `SELECT id FROM membership WHERE organization_id = $1 AND app_user_id = $2 AND brand_id IS NULL`,
        [ORG_A_ID, ADMIN_ID],
      );
      adminMembershipId = existing.rows[0]!.id;
    }

    // TARGET_ID = manager in ORG_A (will be suspended in WIRE-1)
    const targetInsert = await rawPool.query<{ id: string }>(
      `INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
       VALUES ($1, NULL, $2, 'manager')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [ORG_A_ID, TARGET_ID],
    );
    if (targetInsert.rows[0]?.id) {
      targetMembershipId = targetInsert.rows[0].id;
    } else {
      const existing = await rawPool.query<{ id: string }>(
        `SELECT id FROM membership WHERE organization_id = $1 AND app_user_id = $2 AND brand_id IS NULL`,
        [ORG_A_ID, TARGET_ID],
      );
      targetMembershipId = existing.rows[0]!.id;
    }

    // OWNER_ID also a member in ORG_B (for invite-create control in WIRE-2)
    await rawPool.query(
      `INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
       VALUES ($1, NULL, $2, 'owner')
       ON CONFLICT DO NOTHING`,
      [ORG_B_ID, OWNER_ID],
    );

    // ── Seed: pending invites for WIRE-3 ──────────────────────────────────
    const inviteARes = await rawPool.query<{ id: string }>(
      `INSERT INTO invite (organization_id, brand_id, email, role_code, token_hash, invited_by_user_id, expires_at)
       VALUES ($1, NULL, $2, 'manager', $3, $4, NOW() + INTERVAL '7 days')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [ORG_A_ID, 'wswire-pending-a@test.invalid', sha256Hex(`wswire-token-a-${ORG_A_ID}`), OWNER_ID],
    );
    if (inviteARes.rows[0]?.id) {
      inviteAId = inviteARes.rows[0].id;
    } else {
      const existing = await rawPool.query<{ id: string }>(
        `SELECT id FROM invite WHERE organization_id = $1 AND email = $2`,
        [ORG_A_ID, 'wswire-pending-a@test.invalid'],
      );
      inviteAId = existing.rows[0]!.id;
    }

    const inviteBRes = await rawPool.query<{ id: string }>(
      `INSERT INTO invite (organization_id, brand_id, email, role_code, token_hash, invited_by_user_id, expires_at)
       VALUES ($1, NULL, $2, 'manager', $3, $4, NOW() + INTERVAL '7 days')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [ORG_B_ID, 'wswire-pending-b@test.invalid', sha256Hex(`wswire-token-b-${ORG_B_ID}`), OWNER_ID],
    );
    if (inviteBRes.rows[0]?.id) {
      inviteBId = inviteBRes.rows[0].id;
    } else {
      const existing = await rawPool.query<{ id: string }>(
        `SELECT id FROM invite WHERE organization_id = $1 AND email = $2`,
        [ORG_B_ID, 'wswire-pending-b@test.invalid'],
      );
      inviteBId = existing.rows[0]!.id;
    }

    // ── Build the app ──────────────────────────────────────────────────────
    const built = await buildTestApp(rawPool);
    app = built.app;
    authService = built.authService;

    void ownerMembershipId; // suppress potential unused warning pre-assignment
    void adminMembershipId;
    void targetMembershipId;
    void inviteAId;
    void inviteBId;
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
    if (rawPool) {
      // Cleanup in FK-safe order.
      await rawPool.query(`DELETE FROM audit_log WHERE actor_id IN ($1, $2, $3)`, [OWNER_ID, ADMIN_ID, TARGET_ID]).catch(() => {});
      await rawPool.query(`DELETE FROM user_session WHERE app_user_id IN ($1, $2, $3)`, [OWNER_ID, ADMIN_ID, TARGET_ID]).catch(() => {});
      await rawPool.query(`DELETE FROM invite WHERE organization_id IN ($1, $2)`, [ORG_A_ID, ORG_B_ID]).catch(() => {});
      await rawPool.query(`DELETE FROM membership WHERE organization_id IN ($1, $2)`, [ORG_A_ID, ORG_B_ID]).catch(() => {});
      await rawPool.query(`DELETE FROM organization WHERE id IN ($1, $2)`, [ORG_A_ID, ORG_B_ID]).catch(() => {});
      // Reactivate target if suspended (cleanup idempotency).
      await rawPool.query(`UPDATE app_user SET status = 'active' WHERE id = $1`, [TARGET_ID]).catch(() => {});
      await rawPool.query(`DELETE FROM app_user WHERE id IN ($1, $2, $3)`, [OWNER_ID, ADMIN_ID, TARGET_ID]).catch(() => {});
      await rawPool.end().catch(() => {});
    }
  });

  // ── WIRE-1 (F-QA-1 + SEC-V1): suspend→401 on next protected HTTP call ──────

  it('WIRE-1 (F-QA-1): suspend member → suspended user\'s next protected HTTP call returns 401 SESSION_REVOKED', async () => {
    if (!rawPool || !app || !authService) {
      console.warn('[SKIP] WIRE-1: Postgres not reachable');
      return;
    }

    // Step A: mint a live JWT + session row for TARGET (manager, active).
    const { token: targetToken } = await mintLiveJwt(rawPool, {
      userId: TARGET_ID,
      workspaceId: ORG_A_ID,
      role: 'manager',
    });

    // Step B: verify the session is valid BEFORE suspend (control — proves test is
    // not trivially invalid from the start).
    const beforeSuspend = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${targetToken}` },
    });
    // Should be 200 (user exists + session is active).
    expect(
      beforeSuspend.statusCode,
      'WIRE-1 control: protected call BEFORE suspend must NOT be 401',
    ).not.toBe(401);

    // Step C: suspend the target user (as owner actor).
    await authService.suspendUser(TARGET_ID, OWNER_ID, ORG_A_ID, null, 'wire-1-corr');

    // Step D: make a protected HTTP call as the now-suspended target.
    // The session is revoked; validateSessionPreHandler must return 401.
    const afterSuspend = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${targetToken}` },
    });

    // THE WIRE ASSERTION: HTTP 401 on the wire, not just a DB row assertion.
    expect(
      afterSuspend.statusCode,
      'WIRE-1: after suspend, protected HTTP call MUST return 401 on the wire',
    ).toBe(401);

    const body = afterSuspend.json<{ error: { code: string } }>();
    expect(
      body.error.code,
      'WIRE-1: error code must be SESSION_REVOKED',
    ).toBe('SESSION_REVOKED');

    // NON-INERT proof: removing the validateSession check from validateSessionPreHandler
    // would cause beforeSuspend and afterSuspend both to return non-401, failing this assertion.
  });

  // ── WIRE-2 (F-QA-2): brand_admin→brand_admin invite = HTTP 403 (+owner 201) ─

  it('WIRE-2 (F-QA-2): brand_admin POST /api/v1/invites with role_code:brand_admin → HTTP 403 FORBIDDEN; owner → HTTP 201', async () => {
    if (!rawPool || !app) {
      console.warn('[SKIP] WIRE-2: Postgres not reachable');
      return;
    }

    // Mint a live brand_admin JWT + session for ADMIN_ID in ORG_A.
    const { token: adminToken } = await mintLiveJwt(rawPool, {
      userId: ADMIN_ID,
      workspaceId: ORG_A_ID,
      role: 'brand_admin',
    });

    // brand_admin attempts to invite with role_code='brand_admin' → must 403.
    const forbiddenResp = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
        'x-correlation-id': randomUUID(),
      },
      body: JSON.stringify({
        organization_id: ORG_A_ID,
        email: `wswire-invite-target-${randomUUID()}@test.invalid`,
        role_code: 'brand_admin',
      }),
    });

    expect(
      forbiddenResp.statusCode,
      'WIRE-2: brand_admin inviting brand_admin MUST return 403 on the wire',
    ).toBe(403);

    const forbiddenBody = forbiddenResp.json<{ error: { code: string } }>();
    expect(
      forbiddenBody.error.code,
      'WIRE-2: error code must be FORBIDDEN',
    ).toBe('FORBIDDEN');

    // Control: owner CAN invite brand_admin → 201. Proves the test is not tautological
    // (it's not 403 for all callers; only for callers without sufficient hierarchy).
    const { token: ownerToken } = await mintLiveJwt(rawPool, {
      userId: OWNER_ID,
      workspaceId: ORG_A_ID,
      role: 'owner',
    });

    const allowedResp = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
        'x-correlation-id': randomUUID(),
      },
      body: JSON.stringify({
        organization_id: ORG_A_ID,
        email: `wswire-invite-owner-ctl-${randomUUID()}@test.invalid`,
        role_code: 'brand_admin',
      }),
    });

    expect(
      allowedResp.statusCode,
      'WIRE-2 control: owner inviting brand_admin MUST return 201 (non-tautological)',
    ).toBe(201);

    // NON-INERT proof: removing the hierarchy guard in inviteService.createInvite would
    // cause the brand_admin invite to return 201 instead of 403, failing the assertion above.
  });

  // ── WIRE-3 (F-QA-3): GET /api/v1/invites?status=pending is org-scoped over HTTP ─

  it('WIRE-3 (F-QA-3): GET /api/v1/invites with org-A session → invites[] contains ONLY org-A IDs; zero org-B IDs', async () => {
    if (!rawPool || !app) {
      console.warn('[SKIP] WIRE-3: Postgres not reachable');
      return;
    }

    // Mint a live owner JWT in ORG_A.
    const { token: orgAToken } = await mintLiveJwt(rawPool, {
      userId: OWNER_ID,
      workspaceId: ORG_A_ID,
      role: 'owner',
    });

    // GET /api/v1/invites?status=pending as org-A session.
    const resp = await app.inject({
      method: 'GET',
      url: '/api/v1/invites?status=pending',
      headers: {
        authorization: `Bearer ${orgAToken}`,
        'x-correlation-id': randomUUID(),
      },
    });

    expect(
      resp.statusCode,
      'WIRE-3: GET /api/v1/invites must return 200',
    ).toBe(200);

    const body = resp.json<{ invites: Array<{ id: string; organization_id: string }> }>();
    expect(Array.isArray(body.invites), 'WIRE-3: response must have invites array').toBe(true);

    const returnedIds = body.invites.map((i) => i.id);
    const returnedOrgIds = body.invites.map((i) => i.organization_id);

    // org-A invite MUST be present.
    expect(
      returnedIds,
      `WIRE-3: org-A invite (${inviteAId}) must appear in the response`,
    ).toContain(inviteAId);

    // org-B invite MUST NOT be present.
    expect(
      returnedIds,
      `WIRE-3: org-B invite (${inviteBId}) must NOT appear in the response`,
    ).not.toContain(inviteBId);

    // All returned invites must belong to org-A (belt-and-suspenders check).
    for (const orgId of returnedOrgIds) {
      expect(
        orgId,
        'WIRE-3: every returned invite must belong to org-A',
      ).toBe(ORG_A_ID);
    }

    // NON-INERT proof: removing the auth.workspaceId scoping from the route (or the GUC
    // isolation in the DB pool) would cause org-B's invite to appear in the response,
    // failing the not.toContain(inviteBId) assertion above.
  });
});
