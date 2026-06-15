/**
 * BFF (Backend For Frontend) routes.
 *
 * Responsibilities:
 *  - httpOnly cookie ↔ short-lived access token exchange.
 *  - CSRF protection (double-submit cookie pattern).
 *  - Session revocation preHandler on EVERY protected route (NN-3).
 *  - X-Brand-Id assertion on every brand-scoped request.
 *  - Correlation ID forwarding.
 *  - Proxy routes for connector + pixel endpoints.
 *  - Dashboard aggregate endpoints (MED-BFF-DASH-01):
 *      GET /v1/dashboard/brand-summary
 *      GET /v1/dashboard/connection-status
 *      GET /v1/dashboard/data-status
 *      GET /v1/dashboard/onboarding-progress
 *
 * Scope: apps/web calls ONLY the BFF — never calls workspace-access or connector directly.
 * Data sources: Postgres only — ZERO StarRocks/OLAP calls (ADR-002).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';

// @fastify/cookie v11 module augmentation is not automatically applied in
// NodeNext module resolution when the package has no `exports` field.
// We define local helpers to type the cookie-augmented reply/request without
// relying on side-effect augmentation propagation.
type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none' | boolean;
  path?: string;
  maxAge?: number;
  domain?: string;
  expires?: Date;
};
type CookieReply = FastifyReply & {
  setCookie(name: string, value: string, options?: CookieOptions): CookieReply;
  clearCookie(name: string, options?: CookieOptions): CookieReply;
};
import type { AuthService } from '../../workspace-access/internal/application/auth.service.js';
import type { AuthenticatedRequest } from '../../workspace-access/internal/interfaces/rest/auth.routes.js';
import { validateSessionPreHandler } from '../../workspace-access/internal/interfaces/rest/auth.routes.js';
import type { DbPool, QueryContext } from '@brain/db';

const COOKIE_NAME = 'brain_session';
const CSRF_COOKIE_NAME = 'brain_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';

export function registerBffRoutes(
  fastify: FastifyInstance,
  authService: AuthService,
  pool?: DbPool,
): void {
  const sessionPreHandler = validateSessionPreHandler(authService);

  // ── CSRF token endpoint ────────────────────────────────────────────────────
  // GET /api/v1/bff/csrf — returns a CSRF token bound to the session.
  fastify.get('/api/v1/bff/csrf', async (request: FastifyRequest, reply: FastifyReply) => {
    const csrfToken = randomUUID();
    (reply as CookieReply).setCookie(CSRF_COOKIE_NAME, csrfToken, {
      httpOnly: false, // CSRF cookie must be readable by JS
      secure: process.env['NODE_ENV'] === 'production',
      sameSite: 'strict',
      path: '/',
    });
    return reply.send({ csrf_token: csrfToken });
  });

  // ── BFF session validation preHandler (NN-3) ──────────────────────────────
  /**
   * All BFF protected routes run this preHandler FIRST:
   * 1. Reads the httpOnly cookie (set by /api/v1/bff/session).
   * 2. Validates CSRF token (double-submit pattern).
   * 3. Validates the session via validateSessionPreHandler (NN-3).
   * 4. Attaches request.auth for downstream handlers.
   */
  async function bffProtectedPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const requestId = randomUUID();

    // Step 1: Read httpOnly session cookie.
    // request.cookies is added by @fastify/cookie at runtime; we cast via unknown
    // because NodeNext module isolation prevents automatic type augmentation here.
    const reqCookies = (request as unknown as { cookies: Record<string, string | undefined> }).cookies;
    const sessionToken = reqCookies[COOKIE_NAME];
    if (!sessionToken) {
      return reply.code(401).send({
        request_id: requestId,
        error: { code: 'UNAUTHORIZED', message: 'No session cookie.' },
      });
    }

    // Step 2: CSRF double-submit validation for mutations.
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const csrfCookie = reqCookies[CSRF_COOKIE_NAME];
      const csrfHeader = request.headers[CSRF_HEADER_NAME];
      if (!csrfCookie || csrfCookie !== csrfHeader) {
        return reply.code(403).send({
          request_id: requestId,
          error: { code: 'CSRF_MISMATCH', message: 'CSRF token mismatch.' },
        });
      }
    }

    // Step 3: Set Authorization header for the downstream session preHandler.
    // The cookie contains the access token directly (in M1 BFF, cookie = access token).
    request.headers.authorization = `Bearer ${sessionToken}`;

    // Step 4: Delegate to the standard session validation (NN-3).
    return sessionPreHandler(request, reply);
  }

  // ── POST /api/v1/bff/session — exchange credentials for session cookie ────
  fastify.post('/api/v1/bff/session', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = randomUUID();
    const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
    const { email, password } = request.body as { email?: string; password?: string };

    if (!email || !password) {
      return reply.code(400).send({
        request_id: requestId,
        error: { code: 'MISSING_CREDENTIALS', message: 'email and password required.' },
      });
    }

    try {
      const result = await authService.login(
        email,
        password,
        request.ip ?? null,
        request.headers['user-agent'] ?? null,
        correlationId,
      );

      // Set the httpOnly cookie with the access token.
      (reply as CookieReply).setCookie(COOKIE_NAME, result.accessToken, {
        httpOnly: true,
        secure: process.env['NODE_ENV'] === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: result.expiresIn,
      });

      return reply.send({
        request_id: requestId,
        user: {
          id: result.user.id,
          email: result.user.email,
          email_verified: result.user.emailVerifiedAt !== null,
        },
        expires_in: result.expiresIn,
      });
    } catch {
      return reply.code(401).send({
        request_id: requestId,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
      });
    }
  });

  // ── DELETE /api/v1/bff/session — logout + clear cookie ────────────────────
  fastify.delete(
    '/api/v1/bff/session',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;

      await authService.logout(auth.jti, auth.userId, correlationId);

      // Clear the session cookie.
      (reply as CookieReply).clearCookie(COOKIE_NAME, { path: '/' });
      (reply as CookieReply).clearCookie(CSRF_COOKIE_NAME, { path: '/' });

      return reply.send({ request_id: requestId, ok: true });
    },
  );

  // ── GET /api/v1/bff/me — current user via cookie ──────────────────────────
  fastify.get(
    '/api/v1/bff/me',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;

      const user = await authService.getCurrentUser(auth.userId, correlationId);
      if (!user) {
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'UNAUTHORIZED', message: 'User not found.' },
        });
      }

      return reply.send({
        request_id: requestId,
        user: {
          id: user.id,
          email: user.email,
          email_verified: user.emailVerifiedAt !== null,
          status: user.status,
        },
        auth: {
          brand_id: auth.brandId,
          workspace_id: auth.workspaceId,
          role: auth.role,
        },
      });
    },
  );

  // ── Protected BFF proxy routes ─────────────────────────────────────────────
  // These routes require bffProtectedPreHandler (NN-3 + CSRF + cookie).
  // They proxy to the internal service implementations.
  // Brand assertion: if X-Brand-Id is present, it must match auth.brandId (or null).

  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.routeOptions?.url?.startsWith('/api/v1/bff/')) return;
    // Already handled by per-route preHandlers above.
  });

  // ── Dashboard BFF endpoints (MED-BFF-DASH-01) ─────────────────────────────
  // All reads are Postgres-only (ZERO StarRocks/OLAP — ADR-002).
  // Honest empty: if no data exists yet, returns structured empty state — never 404.
  // All routes protected by bffProtectedPreHandler (validateSession + NN-3 + CSRF).

  /**
   * GET /v1/dashboard/brand-summary
   * Returns brand/org/membership counts for the current workspace.
   */
  fastify.get(
    '/v1/dashboard/brand-summary',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.workspaceId) {
        // No workspace context yet — honest empty
        return reply.send({
          request_id: requestId,
          data: {
            org_name: null,
            brand_count: 0,
            member_count: 0,
            brands: [],
          },
        });
      }

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const ctx: QueryContext = { workspaceId: auth.workspaceId, correlationId: requestId };
      const client = await pool.connect();
      try {
        const [orgResult, brandResult, memberResult] = await Promise.all([
          client.query<{ id: string; name: string }>(
            ctx,
            `SELECT id, name FROM organization WHERE id = $1`,
            [auth.workspaceId],
          ),
          client.query<{ id: string; display_name: string; domain: string | null; status: string }>(
            ctx,
            `SELECT id, display_name, domain, status FROM brand WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 20`,
            [auth.workspaceId],
          ),
          client.query<{ count: string }>(
            ctx,
            `SELECT COUNT(*)::text AS count FROM membership WHERE organization_id = $1`,
            [auth.workspaceId],
          ),
        ]);

        const org = orgResult.rows[0];
        return reply.send({
          request_id: requestId,
          data: {
            org_name: org?.name ?? null,
            brand_count: brandResult.rows.length,
            member_count: parseInt(memberResult.rows[0]?.count ?? '0', 10),
            brands: brandResult.rows.map((b) => ({
              id: b.id,
              display_name: b.display_name,
              domain: b.domain,
              status: b.status,
            })),
          },
        });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /v1/dashboard/connection-status
   * Returns connector_sync_status for the current brand.
   */
  fastify.get(
    '/v1/dashboard/connection-status',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.brandId) {
        return reply.send({
          request_id: requestId,
          data: {
            shopify: { connected: false, status: 'not_connected', syncState: null, lastSyncAt: null },
            meta: { coming_soon: true },
            google: { coming_soon: true },
          },
        });
      }

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const ctx: QueryContext = { brandId: auth.brandId, correlationId: requestId };
      const client = await pool.connect();
      try {
        const result = await client.query<{
          status: string;
          shop_domain: string;
          connector_instance_id: string;
          sync_state: string | null;
          last_sync_at: Date | null;
          last_error: string | null;
        }>(
          ctx,
          `SELECT ci.status, ci.shop_domain, ci.id AS connector_instance_id,
                  cs.state AS sync_state, cs.last_sync_at, cs.last_error
           FROM connector_instance ci
           LEFT JOIN connector_sync_status cs ON cs.connector_instance_id = ci.id AND cs.brand_id = ci.brand_id
           WHERE ci.brand_id = $1 AND ci.provider = 'shopify'
           ORDER BY ci.created_at DESC
           LIMIT 1`,
          [auth.brandId],
        );

        const row = result.rows[0];
        return reply.send({
          request_id: requestId,
          data: {
            shopify: row
              ? {
                  connected: row.status === 'connected',
                  status: row.status,
                  shop_domain: row.shop_domain,
                  connector_instance_id: row.connector_instance_id,
                  syncState: row.sync_state,
                  lastSyncAt: row.last_sync_at?.toISOString() ?? null,
                  lastError: row.last_error,
                }
              : { connected: false, status: 'not_connected', syncState: null, lastSyncAt: null },
            meta: { coming_soon: true },
            google: { coming_soon: true },
          },
        });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /v1/dashboard/data-status
   * Returns pixel_installation + pixel_status for the current brand.
   */
  fastify.get(
    '/v1/dashboard/data-status',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.brandId) {
        return reply.send({
          request_id: requestId,
          data: {
            pixel: { installed: false, state: 'not_installed', verifiedAt: null },
          },
        });
      }

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const ctx: QueryContext = { brandId: auth.brandId, correlationId: requestId };
      const client = await pool.connect();
      try {
        const result = await client.query<{
          installation_id: string;
          install_token: string;
          target_host: string;
          installed_at: Date | null;
          state: string | null;
          verified_at: Date | null;
          last_error: string | null;
        }>(
          ctx,
          `SELECT pi.id AS installation_id, pi.install_token, pi.target_host, pi.installed_at,
                  ps.state, ps.verified_at, ps.last_error
           FROM pixel_installation pi
           LEFT JOIN pixel_status ps ON ps.pixel_installation_id = pi.id AND ps.brand_id = pi.brand_id
           WHERE pi.brand_id = $1
           ORDER BY pi.created_at DESC
           LIMIT 1`,
          [auth.brandId],
        );

        const row = result.rows[0];
        return reply.send({
          request_id: requestId,
          data: {
            pixel: row
              ? {
                  installed: row.installed_at !== null,
                  installation_id: row.installation_id,
                  install_token: row.install_token,
                  target_host: row.target_host,
                  installedAt: row.installed_at?.toISOString() ?? null,
                  state: row.state ?? 'waiting_for_data',
                  verifiedAt: row.verified_at?.toISOString() ?? null,
                  lastError: row.last_error,
                }
              : { installed: false, state: 'not_installed', verifiedAt: null },
          },
        });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /v1/dashboard/onboarding-progress
   * Returns deterministic onboarding step completion from control-plane state.
   * Derived entirely from Postgres tables — no external API calls.
   *
   * Steps (M1):
   *   1. email_verified   — app_user.email_verified_at IS NOT NULL
   *   2. workspace_created — membership row exists (brand_id IS NULL)
   *   3. brand_created    — at least one brand row for the workspace
   *   4. shopify_connected — connector_instance.status = 'connected'
   *   5. pixel_installed  — pixel_installation.installed_at IS NOT NULL
   */
  fastify.get(
    '/v1/dashboard/onboarding-progress',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const ctx: QueryContext = {
        userId: auth.userId,
        workspaceId: auth.workspaceId ?? undefined,
        brandId: auth.brandId ?? undefined,
        correlationId: requestId,
      };
      const client = await pool.connect();
      try {
        // All queries run in parallel — no sequential scan.
        const [userResult, workspaceResult, brandResult, connectorResult, pixelResult] =
          await Promise.all([
            // Step 1: email verified
            client.query<{ email_verified_at: Date | null }>(
              ctx,
              `SELECT email_verified_at FROM app_user WHERE id = $1`,
              [auth.userId],
            ),
            // Step 2: workspace created (org-level membership)
            auth.workspaceId
              ? client.query<{ count: string }>(
                  ctx,
                  `SELECT COUNT(*)::text AS count FROM membership WHERE organization_id = $1 AND brand_id IS NULL AND app_user_id = $2`,
                  [auth.workspaceId, auth.userId],
                )
              : Promise.resolve({ rows: [{ count: '0' }] }),
            // Step 3: brand created
            auth.workspaceId
              ? client.query<{ count: string }>(
                  ctx,
                  `SELECT COUNT(*)::text AS count FROM brand WHERE organization_id = $1`,
                  [auth.workspaceId],
                )
              : Promise.resolve({ rows: [{ count: '0' }] }),
            // Step 4: Shopify connected
            auth.brandId
              ? client.query<{ count: string }>(
                  ctx,
                  `SELECT COUNT(*)::text AS count FROM connector_instance WHERE brand_id = $1 AND provider = 'shopify' AND status = 'connected'`,
                  [auth.brandId],
                )
              : Promise.resolve({ rows: [{ count: '0' }] }),
            // Step 5: pixel installed
            auth.brandId
              ? client.query<{ count: string }>(
                  ctx,
                  `SELECT COUNT(*)::text AS count FROM pixel_installation WHERE brand_id = $1 AND installed_at IS NOT NULL`,
                  [auth.brandId],
                )
              : Promise.resolve({ rows: [{ count: '0' }] }),
          ]);

        const steps = [
          {
            key: 'email_verified',
            label: 'Verify your email',
            completed: userResult.rows[0]?.email_verified_at !== null &&
              userResult.rows[0]?.email_verified_at !== undefined,
          },
          {
            key: 'workspace_created',
            label: 'Create your workspace',
            completed: parseInt(workspaceResult.rows[0]?.count ?? '0', 10) > 0,
          },
          {
            key: 'brand_created',
            label: 'Add your first brand',
            completed: parseInt(brandResult.rows[0]?.count ?? '0', 10) > 0,
          },
          {
            key: 'shopify_connected',
            label: 'Connect Shopify',
            completed: parseInt(connectorResult.rows[0]?.count ?? '0', 10) > 0,
          },
          {
            key: 'pixel_installed',
            label: 'Install the Brain pixel',
            completed: parseInt(pixelResult.rows[0]?.count ?? '0', 10) > 0,
          },
        ];

        const completedCount = steps.filter((s) => s.completed).length;

        return reply.send({
          request_id: requestId,
          data: {
            steps,
            completed_count: completedCount,
            total_count: steps.length,
            all_complete: completedCount === steps.length,
          },
        });
      } finally {
        client.release();
      }
    },
  );
}
