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
 *      GET /api/v1/dashboard/brand-summary
 *      GET /api/v1/dashboard/connection-status
 *      GET /api/v1/dashboard/data-status
 *      GET /api/v1/dashboard/onboarding-progress
 *      GET /api/v1/dashboard/realized-revenue  (Track A, ADR-002 sole-read-path)
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
import { AuthError } from '../../workspace-access/internal/application/auth.service.js';
import type { AuthenticatedRequest } from '../../workspace-access/internal/interfaces/rest/auth.routes.js';
import { validateSessionPreHandler } from '../../workspace-access/internal/interfaces/rest/auth.routes.js';
import type { OnboardingStatus } from '../../workspace-access/internal/domain/organization/entities.js';
import type { DbPool, QueryContext } from '@brain/db';
import { MembershipRepository, OrganizationRepository } from '../../workspace-access/internal/infrastructure/repositories.js';
import { jtiFromJwt, csrfTokenForSession } from './csrf.js';
import type { RateLimiter } from '../../workspace-access/internal/infrastructure/rate-limiter.js';
import { loginFailKeySync, loginIpKey } from '../../workspace-access/internal/infrastructure/rate-limiter.js';
import type { Pool as PgPool } from 'pg';
import { getRevenueMetrics, getRevenueTimeseries, getKpiSummary, getRecognitionBreakdown, getRecentActivity } from '../../analytics/index.js';
import type { TimeGrain } from '@brain/metric-engine';

const COOKIE_NAME = 'brain_session';
const CSRF_COOKIE_NAME = 'brain_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';
const ACCESS_TOKEN_EXPIRY_SECS = 60 * 60; // 1 hour — matches the session cookie maxAge

export function registerBffRoutes(
  fastify: FastifyInstance,
  authService: AuthService,
  pool?: DbPool,
  cookieSecret = '',
  rateLimiter?: RateLimiter,
  rawPool?: PgPool,
): void {
  const sessionPreHandler = validateSessionPreHandler(authService);

  // ── CSRF token endpoint ────────────────────────────────────────────────────
  // GET /api/v1/bff/csrf — issues a session-bound CSRF token (SEC-0009-M02). When
  // the request carries a session, the token is HMAC(cookieSecret, jti) — bound to
  // that session and invalidated when it rotates/revokes. Pre-session callers get a
  // random token (only used on CSRF-exempt routes).
  fastify.get('/api/v1/bff/csrf', async (request: FastifyRequest, reply: FastifyReply) => {
    const reqCookies = (request as unknown as { cookies: Record<string, string | undefined> }).cookies;
    const jti = jtiFromJwt(reqCookies?.[COOKIE_NAME]);
    const csrfToken = jti && cookieSecret ? csrfTokenForSession(jti, cookieSecret) : randomUUID();
    (reply as CookieReply).setCookie(CSRF_COOKIE_NAME, csrfToken, {
      httpOnly: false, // CSRF cookie must be readable by JS
      secure: process.env['NODE_ENV'] === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: ACCESS_TOKEN_EXPIRY_SECS, // SEC-0009-L02: match session lifetime
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

    // MA-14 / B-8: The authoritative CSRF check (jti-bound double-submit, SEC-0009-M02)
    // runs in the app-wide onRequest hook in main.ts. The weaker plain-equality check
    // that was here has been REMOVED to eliminate the duplicate and the weaker variant.
    // The app-wide hook enforces HMAC(cookieSecret, jti) binding, not just cookie===header.

    // Step 3: Set Authorization header for the downstream session preHandler.
    // The cookie contains the access token directly (in M1 BFF, cookie = access token).
    request.headers.authorization = `Bearer ${sessionToken}`;

    // Step 4: Delegate to the standard session validation (NN-3).
    return sessionPreHandler(request, reply);
  }

  // ── POST /api/v1/bff/session — exchange credentials for session cookie ────
  // QA-03: Rate limited per-(email+IP) and per-IP (same limits as /auth/login — AC-3).
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

    // AC-3 / QA-03: Rate-limit pattern mirrors auth.routes.ts exactly (SEC-AOF-N1 fix):
    //   Entry  — increment per-IP cap (loginIpKey) only; block if over limit.
    //   Catch  — increment per-(email+IP) failure counter (loginFailKey) on failure.
    //   Success— reset BOTH loginFailKey and loginIpKey (clear the window on good auth).
    // loginFailKey is NOT touched at entry so each failed attempt counts exactly once.
    if (rateLimiter) {
      const ip = request.ip ?? '0.0.0.0';
      const ipRl = await rateLimiter.check(loginIpKey(ip), 20, 900);
      if (!ipRl.allowed) {
        return reply.code(429).send({
          request_id: requestId,
          error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Please try again later.' },
        }).header('Retry-After', String(ipRl.retryAfter));
      }
    }

    try {
      const result = await authService.login(
        email,
        password,
        request.ip ?? null,
        request.headers['user-agent'] ?? null,
        correlationId,
      );

      // Reset BOTH failure counter and per-IP counter on successful login (mirrors auth.routes.ts:183-184).
      if (rateLimiter) {
        const ip = request.ip ?? '0.0.0.0';
        void rateLimiter.reset(loginFailKeySync(email, ip));
        void rateLimiter.reset(loginIpKey(ip));
      }

      // Set the httpOnly cookie with the access token.
      (reply as CookieReply).setCookie(COOKIE_NAME, result.accessToken, {
        httpOnly: true,
        secure: process.env['NODE_ENV'] === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: result.expiresIn,
      });

      // AC-5 / B-5: Surface onboarding_status enum instead of needs_onboarding boolean.
      // null → user has no workspace yet (just registered, no org membership).
      const onboardingStatus: OnboardingStatus | null = result.context.onboardingStatus;
      // QA-07: auth sub-object uses snake_case (contract §6: brand_id, workspace_id).
      return reply.send({
        request_id: requestId,
        user: {
          id: result.user.id,
          email: result.user.email,
          email_verified: result.user.emailVerifiedAt !== null,
        },
        expires_in: result.expiresIn,
        onboarding_status: onboardingStatus,
        auth: {
          brand_id: result.context.brandId,
          workspace_id: result.context.workspaceId,
          role: result.context.role,
        },
      });
    } catch {
      // Increment per-(email+IP) failure counter on failed login (mirrors auth.routes.ts catch).
      if (rateLimiter) {
        const ip = request.ip ?? '0.0.0.0';
        const emailIpRl = await rateLimiter.check(loginFailKeySync(email, ip), 5, 900);
        if (!emailIpRl.allowed) {
          return reply.code(429).send({
            request_id: requestId,
            error: { code: 'RATE_LIMITED', message: 'Too many failed login attempts. Please try again later.' },
          }).header('Retry-After', String(emailIpRl.retryAfter));
        }
      }
      return reply.code(401).send({
        request_id: requestId,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
      });
    }
  });

  // ── POST /api/v1/bff/session/refresh — re-mint cookie with current brand/role ──
  // Called after onboarding (workspace + brand creation) so the SAME session picks
  // up the newly-resolved brand_id/role without forcing a re-login. Authenticated
  // via the session cookie (bridged to Bearer by the app-wide onRequest hook);
  // reuses the existing jti, so revocation state is preserved (NN-3).
  fastify.post(
    '/api/v1/bff/session/refresh',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;

      const result = await authService.refreshSession(auth.userId, auth.jti, correlationId);

      (reply as CookieReply).setCookie(COOKIE_NAME, result.accessToken, {
        httpOnly: true,
        secure: process.env['NODE_ENV'] === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: result.expiresIn,
      });

      // QA-07: auth sub-object uses snake_case (contract §6: brand_id, workspace_id).
      return reply.send({
        request_id: requestId,
        onboarding_status: result.context.onboardingStatus,
        auth: {
          brand_id: result.context.brandId,
          workspace_id: result.context.workspaceId,
          role: result.context.role,
        },
      });
    },
  );

  // ── DELETE /api/v1/bff/session — logout + clear cookie ────────────────────
  fastify.delete(
    '/api/v1/bff/session',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;

      // AC-2: ?scope=all revokes all sessions for this user (e.g. "logout everywhere").
      const scopeAll = (request.query as { scope?: string }).scope === 'all';
      await authService.logout(auth.jti, auth.userId, correlationId, scopeAll);

      // Clear the session cookie.
      (reply as CookieReply).clearCookie(COOKIE_NAME, { path: '/' });
      (reply as CookieReply).clearCookie(CSRF_COOKIE_NAME, { path: '/' });

      return reply.send({ request_id: requestId, ok: true });
    },
  );

  // ── POST /api/v1/bff/session/set-org — switch active workspace in cookie ──────
  // AC-8 / B-7: After onboarding creates the first org, the front-end calls this
  // endpoint with the new organization_id (§6 contract field name). The service
  // verifies the user is a member of that org (SEC-AOF-H1 → 403 if not), then
  // re-resolves brand/role context and re-mints the cookie with onboarding_status.
  // CSRF IS enforced by the app-wide onRequest hook in main.ts (SEC-0009-M02).
  // Do NOT add this path to the CSRF-exempt list.
  fastify.post(
    '/api/v1/bff/session/set-org',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      // QA-02: contract §6 field name is organization_id (not workspace_id).
      const body = request.body as { organization_id?: string };

      if (!body?.organization_id) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_ORGANIZATION_ID', message: 'organization_id is required.' },
        });
      }

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available.' },
        });
      }

      // SEC-AOF-H1: Explicit membership check BEFORE refreshSession.
      // resolveActiveContext falls back to findActiveByUser when membership is missing,
      // which would silently return the user's own org instead of 403.
      // We must fail-closed here: non-member → 403 (architecture plan AC-8 §B-7).
      const memberClient = await pool.connect();
      try {
        const memberRepo = new MembershipRepository(memberClient);
        const membership = await memberRepo.findByUserAndOrg(
          auth.userId,
          body.organization_id,
          null,
          { correlationId, userId: auth.userId, workspaceId: body.organization_id },
        );
        if (!membership) {
          return reply.code(403).send({
            request_id: requestId,
            error: { code: 'FORBIDDEN', message: 'Not a member of the requested organization.' },
          });
        }
      } finally {
        memberClient.release();
      }

      // refreshSession re-resolves brand/role context for the verified org.
      const result = await authService.refreshSession(
        auth.userId,
        auth.jti,
        correlationId,
        body.organization_id,
      );

      (reply as CookieReply).setCookie(COOKIE_NAME, result.accessToken, {
        httpOnly: true,
        secure: process.env['NODE_ENV'] === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: result.expiresIn,
      });

      // QA-07: auth sub-object uses snake_case (contract §6: brand_id, workspace_id).
      return reply.send({
        request_id: requestId,
        onboarding_status: result.context.onboardingStatus,
        auth: {
          brand_id: result.context.brandId,
          workspace_id: result.context.workspaceId,
          role: result.context.role,
        },
      });
    },
  );

  // ── POST /api/v1/bff/session/set-brand — switch active brand in cookie ──────
  // AC-1 / feat-multi-brand: re-mints the session JWT with verified brand-level context.
  // SEC: session revocation DB check required — do NOT use JWT-only verification (MA-05).
  // CSRF enforced by the app-wide onRequest hook (not exempt — same as set-org).
  // workspace_id is sourced from auth.workspaceId (JWT) ONLY — never the body (MA-02).
  // TOCTOU note: remove+set-brand executing within the same millisecond leaves a sub-ms
  // window where a removed user re-mints before the revocation check catches up; acceptable
  // for M1 — noted for future brand-scoped session audit.
  fastify.post(
    '/api/v1/bff/session/set-brand',
    // SEC: session revocation DB check required — do NOT use JWT-only verification (MA-05)
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const body = request.body as { brand_id?: string };

      // SEC: workspaceId must come from JWT, not body — prevents cross-org membership spoofing (MA-02).
      if (!auth.workspaceId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_WORKSPACE', message: 'No workspace context in session. Call set-org first.' },
        });
      }

      if (!body?.brand_id) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_BRAND_ID', message: 'brand_id is required.' },
        });
      }

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available.' },
        });
      }

      try {
        // MA-01 CRITICAL: calls mintSessionToken directly via switchBrandContext — NEVER
        // refreshSession/resolveActiveContext (their findActiveByUser fallback substitutes
        // the wrong brand, causing a context-substitution defect).
        const result = await authService.switchBrandContext(
          auth.userId,
          auth.jti,
          auth.brandId,         // fromBrandId (outgoing context, audit only)
          auth.workspaceId,     // from JWT ONLY — never body (MA-02)
          body.brand_id,
          correlationId,
        );

        // Set the re-minted session cookie (copy of set-org cookie block, bff.routes.ts:335-341).
        (reply as CookieReply).setCookie(COOKIE_NAME, result.accessToken, {
          httpOnly: true,
          secure: process.env['NODE_ENV'] === 'production',
          sameSite: 'strict',
          path: '/',
          maxAge: result.expiresIn,
        });

        return reply.send({
          request_id: requestId,
          auth: {
            brand_id: result.context.brandId,
            workspace_id: result.context.workspaceId,
            role: result.context.role,
          },
        });
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.code(err.statusCode).send({
            request_id: requestId,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );

  // ── POST /api/v1/bff/session/onboarding/advance — advance wizard step ────────
  // QA-01 / AC-5 §B-5: Steps 3 ("Skip For Now") and 4 ("Done") call this.
  // Body: { to: 'integration_selected' | 'complete' }
  // Forward-only guard: the SQL WHERE clause enforces onboarding_step < $newStep.
  // Returns the new onboarding_status so the frontend can route immediately.
  // CSRF enforced by the app-wide onRequest hook (session cookie present → mutation → checked).
  fastify.post(
    '/api/v1/bff/session/onboarding/advance',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const body = request.body as { to?: string };

      const ALLOWED_TARGETS: Record<string, { status: string; step: number }> = {
        integration_selected: { status: 'integration_selected', step: 3 },
        complete: { status: 'complete', step: 4 },
      };

      const target = body?.to ? ALLOWED_TARGETS[body.to] : undefined;
      if (!target) {
        return reply.code(400).send({
          request_id: requestId,
          error: {
            code: 'INVALID_TARGET',
            message: `'to' must be one of: ${Object.keys(ALLOWED_TARGETS).join(', ')}.`,
          },
        });
      }

      if (!auth.workspaceId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_WORKSPACE', message: 'No workspace context in session. Call set-org first.' },
        });
      }

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available.' },
        });
      }

      const ctx: QueryContext = { correlationId, userId: auth.userId, workspaceId: auth.workspaceId };
      const client = await pool.connect();
      try {
        const orgRepo = new OrganizationRepository(client);
        // M1: onboarding_status tracks first-brand onboarding only; multi-brand onboarding is post-M1.
        // Forward-only: advanceOnboardingStatus uses WHERE onboarding_step < $newStep — idempotent.
        await orgRepo.advanceOnboardingStatus(
          auth.workspaceId,
          target.status as import('../../workspace-access/internal/domain/organization/entities.js').OnboardingStatus,
          target.step,
          ctx,
        );

        // Read back the current status so we return the authoritative value.
        const org = await orgRepo.findById(auth.workspaceId, ctx);
        return reply.send({
          request_id: requestId,
          onboarding_status: org?.onboardingStatus ?? target.status,
        });
      } finally {
        client.release();
      }
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

  fastify.addHook('preHandler', async (request: FastifyRequest) => {
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
    '/api/v1/dashboard/brand-summary',
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
            active_brand_id: null,
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
        // brand-summary queries: org + brand list (all member brands for the switcher) + brand-scoped member count.
        const [orgResult, brandResult, memberResult] = await Promise.all([
          client.query<{ id: string; name: string }>(
            ctx,
            `SELECT id, name FROM organization WHERE id = $1`,
            [auth.workspaceId],
          ),
          // brand_self_read (0013) ensures brain_app sees only member brands in the active org.
          // brand list drives the switcher — all member brands within the workspace, newest first.
          client.query<{ id: string; display_name: string; domain: string | null; status: string }>(
            ctx,
            `SELECT id, display_name, domain, status FROM brand WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 20`,
            [auth.workspaceId],
          ),
          // MA-06/SD-2: member count is per-active-brand, not org-level.
          // Guard: if auth.brandId is null (no active brand), count returns 0 (honest empty).
          auth.brandId
            ? client.query<{ count: string }>(
                ctx,
                // COUNT DISTINCT users scoped to the ACTIVE brand.
                // A single owner holds two membership rows (org-level + brand-level),
                // so COUNT(*) double-counts them — DISTINCT eliminates duplicates.
                `SELECT COUNT(DISTINCT app_user_id)::text AS count FROM membership WHERE organization_id = $1 AND brand_id = $2`,
                [auth.workspaceId, auth.brandId],
              )
            : Promise.resolve({ rows: [{ count: '0' }] as { count: string }[] }),
        ]);

        const org = orgResult.rows[0];
        return reply.send({
          request_id: requestId,
          data: {
            org_name: org?.name ?? null,
            // MA-06: active_brand_id = auth.brandId so the client can identify the active brand
            // by ID (not array index). Frontend resolves: brands.find(b => b.id === active_brand_id).
            active_brand_id: auth.brandId ?? null,
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
    '/api/v1/dashboard/connection-status',
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
    '/api/v1/dashboard/data-status',
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
    '/api/v1/dashboard/onboarding-progress',
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

  /**
   * GET /api/v1/dashboard/realized-revenue?as_of=<YYYY-MM-DD>
   *
   * Returns realized + provisional revenue for the active brand via the metric engine.
   *
   * ADR-002 SOLE READ PATH: this route calls getRevenueMetrics (analytics module)
   * which calls computeRealizedRevenue / computeProvisionalRevenue from @brain/metric-engine.
   * NO ad-hoc SUM(amount_minor) here — the ONLY SQL in this path is the EXISTS check
   * (inside the analytics use-case) and the named seam calls in the engine.
   *
   * Honest-empty-state (D-2): state='no_data' when no finalized rows exist.
   * NEVER returns a bare 0 without the state discriminant.
   *
   * as_of validation (D-9): schema-validated via Fastify JSON schema; invalid/garbage
   * returns 400 INVALID_DATE before the handler runs.
   *
   * Pool (D §3.1, F-SEC-02): uses rawPool (pg.Pool) — NOT the DbPool wrapper —
   * so withBrandTxn can set the GUC transaction-locally without double-GUC.
   *
   * Brand from session (D-1): brand_id comes from auth.brandId, NEVER from request body.
   */
  fastify.get(
    '/api/v1/dashboard/realized-revenue',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            as_of: {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            },
          },
          additionalProperties: false,
        },
      },
      // Fastify schema validation errors return 400; we override the reply to match
      // the INVALID_DATE contract (D-9).
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      // D-9: as_of schema validation — Fastify sets validationError on the request
      // when attachValidation:true and the schema fails.
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_DATE', message: 'as_of must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;

      // Honest-empty: no active brand yet → no_data (matches BFF pattern at bff.routes.ts:569)
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({
          request_id: requestId,
          data: {
            state: 'no_data',
            as_of: today,
            realized: null,
            provisional: null,
          },
        });
      }

      // Pool guard: rawPool is required for the engine (F-SEC-02, D §3.1)
      if (!rawPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      // as_of: use provided value or default to today (server-side, never client-trusted — Open-Q1)
      const query = request.query as { as_of?: string };
      const asOfStr = query.as_of ?? (new Date().toISOString().split('T')[0] as string);
      const asOf = new Date(`${asOfStr}T00:00:00Z`);

      // Call the analytics use-case — the SOLE read path (ADR-002, D-3)
      const snapshot = await getRevenueMetrics(auth.brandId, asOf, { pool: rawPool });

      return reply.send({
        request_id: requestId,
        data: snapshot,
      });
    },
  );

  // ── Analytics endpoints (Phase 1) ─────────────────────────────────────────
  // ADR-002 sole-read-path: all routes call analytics query wrappers which call the metric engine.
  // Brand from session (D-1): auth.brandId, NEVER from request body.
  // Honest-empty: state:'no_data' when brand has no ledger rows.

  /**
   * GET /api/v1/analytics/revenue-timeseries?from=YYYY-MM-DD&to=YYYY-MM-DD&grain=day|week
   * Returns per-bucket realized + provisional revenue for charting.
   */
  fastify.get(
    '/api/v1/analytics/revenue-timeseries',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            grain: { type: 'string', enum: ['day', 'week'] },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'from and to must be YYYY-MM-DD; grain must be day or week.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: null, to: null, grain: 'day', buckets: [] } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }

      const query = request.query as { from?: string; to?: string; grain?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      // Default: last 90 days
      const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;
      const grain: TimeGrain = (query.grain === 'week' ? 'week' : 'day') as TimeGrain;

      const result = await getRevenueTimeseries(
        auth.brandId,
        { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`), grain },
        { pool: rawPool },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/kpi-summary?as_of=YYYY-MM-DD
   * Returns brand KPI snapshot: realized, provisional, orders, AOV, RTO rate.
   */
  fastify.get(
    '/api/v1/analytics/kpi-summary',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_DATE', message: 'as_of must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', as_of: today } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }

      const query = request.query as { as_of?: string };
      const asOfStr = query.as_of ?? (new Date().toISOString().split('T')[0] as string);
      const asOf = new Date(`${asOfStr}T00:00:00Z`);

      const result = await getKpiSummary(auth.brandId, asOf, { pool: rawPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/recognition-breakdown?as_of=YYYY-MM-DD
   * Returns recognition state distribution: provisional/settling/finalized counts + amounts.
   */
  fastify.get(
    '/api/v1/analytics/recognition-breakdown',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_DATE', message: 'as_of must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', as_of: today } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }

      const query = request.query as { as_of?: string };
      const asOfStr = query.as_of ?? (new Date().toISOString().split('T')[0] as string);
      const asOf = new Date(`${asOfStr}T00:00:00Z`);

      const result = await getRecognitionBreakdown(auth.brandId, asOf, { pool: rawPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/recent-activity?limit=20
   * Returns the latest N ledger rows for the brand (bounded read, not a metric — D-2 allowed).
   */
  fastify.get(
    '/api/v1/analytics/recent-activity',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'string', pattern: '^\\d+$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { rows: [] } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }

      const query = request.query as { limit?: string };
      const limit = query.limit ? Math.min(parseInt(query.limit, 10), 50) : 20;

      const result = await getRecentActivity(auth.brandId, limit, { pool: rawPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );
}
