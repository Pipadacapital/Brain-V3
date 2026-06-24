/**
 * Auth + session BFF routes (CQ-1 decomposition).
 *
 * httpOnly cookie ↔ access-token exchange (login), register+auto-login, onboarding
 * provision, session refresh/logout, set-org / set-brand context switches, the
 * onboarding-step advance, and GET /bff/me. Rate-limit + CSRF + cookie discipline
 * are unchanged. The CSRF token endpoint + the bffProtectedPreHandler live in the
 * top-level registerBffRoutes (they ARE the shared scaffolding).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  AuthError,
  OnboardingError,
  MembershipRepository,
  OrganizationRepository,
  loginFailKeySync,
  loginIpKey,
  registerIpKey,
  type AuthenticatedRequest,
  type OnboardingStatus,
} from '../../../workspace-access/index.js';
import type { QueryContext } from '@brain/db';
import { ProvisionOnboardingRequestSchema } from '@brain/contracts';
import type { BffDeps, CookieReply } from './_shared.js';
import { COOKIE_NAME, CSRF_COOKIE_NAME } from './_shared.js';

export function registerAuthSessionRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const {
    authService,
    pool,
    rateLimiter,
    onboardingService,
    sessionPreHandler,
    bffProtectedPreHandler,
  } = deps;

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

  // ── POST /api/v1/bff/register — register + auto-login (feat-onboarding-ux D1) ──
  // Registers a user via AuthService.registerAndStartSession and, for a genuinely-new
  // user, sets the brain_session httpOnly cookie EXACTLY as /api/v1/bff/session does —
  // so the user lands authenticated (EMPTY_CONTEXT) and goes straight to the wizard.
  //
  // SECURITY:
  //  - No bypass: the session is minted via the SAME issueSession() primitive as login.
  //  - The session cookie is set ONLY for created=true. An email collision returns the
  //    same JSON body minus the Set-Cookie (httpOnly Set-Cookie is cross-origin-unreadable
  //    → no enumeration oracle in the visible body, NN-5).
  //  - CSRF-exempt (added to the exempt list in main.ts — establishes the session, no
  //    prior CSRF token can exist). IP rate-limited (registerIpKey, same as /auth/register).
  fastify.post('/api/v1/bff/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = randomUUID();
    const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
    const { email, password } = request.body as { email?: string; password?: string };

    if (!email || !password) {
      return reply.code(400).send({
        request_id: requestId,
        error: { code: 'MISSING_CREDENTIALS', message: 'email and password required.' },
      });
    }

    // AC-3: rate limit by IP (10/hour — same as /api/v1/auth/register).
    if (rateLimiter) {
      const ip = request.ip ?? '0.0.0.0';
      const rl = await rateLimiter.check(registerIpKey(ip), 10, 3600);
      if (!rl.allowed) {
        return reply.code(429).send({
          request_id: requestId,
          error: { code: 'RATE_LIMITED', message: 'Too many registration attempts. Please try again later.' },
        }).header('Retry-After', String(rl.retryAfter));
      }
    }

    try {
      const result = await authService.registerAndStartSession(
        email,
        password,
        request.ip ?? null,
        request.headers['user-agent'] ?? null,
        correlationId,
      );

      // Set the httpOnly session cookie ONLY for a freshly-created user (auto-login).
      if (result.created && result.accessToken && result.expiresIn) {
        (reply as CookieReply).setCookie(COOKIE_NAME, result.accessToken, {
          httpOnly: true,
          secure: process.env['NODE_ENV'] === 'production',
          sameSite: 'strict',
          path: '/',
          maxAge: result.expiresIn,
        });
      }

      // Body is byte-identical between created/existing (NN-5) — the only difference is
      // the presence of Set-Cookie (unreadable cross-origin). onboarding_status is null
      // for a just-registered user (no membership yet) → the wizard.
      return reply.code(201).send({
        request_id: requestId,
        user: {
          id: result.user.id,
          email: result.user.email,
          email_verified: result.user.emailVerifiedAt !== null,
        },
        onboarding_status: result.context.onboardingStatus,
        auth: {
          brand_id: result.context.brandId,
          workspace_id: result.context.workspaceId,
          role: result.context.role,
        },
        ...(result.invitePending ? { code: 'INVITE_PENDING' as const } : {}),
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
  });

  // ── POST /api/v1/bff/onboarding/provision — merged workspace+brand (D3) ────────
  // Provisions workspace + first brand transactionally (server-side slug, website→pixel
  // preserved). Idempotent: a Back→resubmit returns the existing org/brand (200), never
  // a duplicate. After this, the web calls set-org to re-mint the cookie with context.
  // CSRF enforced by the app-wide onRequest hook (session cookie present → mutation).
  fastify.post(
    '/api/v1/bff/onboarding/provision',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;

      if (!onboardingService) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Onboarding service not available.' },
        });
      }

      const parsed = ProvisionOnboardingRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({
          request_id: requestId,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            fields: parsed.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
          },
        });
      }

      try {
        const result = await onboardingService.provisionWorkspaceAndBrand(
          {
            workspaceName: parsed.data.workspace_name,
            brandDisplayName: parsed.data.brand_display_name,
            domain: parsed.data.domain ?? null,
            currencyCode: parsed.data.currency_code,
            timezone: parsed.data.timezone,
            revenueDefinition: parsed.data.revenue_definition,
            ownerUserId: auth.userId,
          },
          correlationId,
        );
        // 201 for a fresh provision, 200 for the idempotent existing-member return.
        return reply.code(result.created ? 201 : 200).send({
          request_id: requestId,
          organization_id: result.organizationId,
          brand_id: result.brandId,
          onboarding_status: result.onboardingStatus,
          created: result.created,
        });
      } catch (err) {
        if (err instanceof OnboardingError) {
          return reply.code(err.statusCode).send({
            request_id: requestId,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );

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
          target.status as import('../../../workspace-access/internal/domain/organization/entities.js').OnboardingStatus,
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

      // feat-onboarding-ux (Deliverable 5): surface onboarding_status so the web's
      // forward-only OnboardingGate can route on the authoritative server status.
      // resolveActiveContext does the membership→org read already used by login/set-org.
      const context = await authService.resolveActiveContext(
        auth.userId,
        correlationId,
        auth.workspaceId ?? undefined,
      );

      return reply.send({
        request_id: requestId,
        user: {
          id: user.id,
          email: user.email,
          email_verified: user.emailVerifiedAt !== null,
          status: user.status,
        },
        onboarding_status: context.onboardingStatus,
        auth: {
          brand_id: auth.brandId,
          workspace_id: auth.workspaceId,
          role: auth.role,
        },
      });
    },
  );
}
