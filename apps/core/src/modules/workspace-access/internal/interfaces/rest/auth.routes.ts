/**
 * Auth REST routes — thin Fastify route adapters over AuthService.
 *
 * POST /api/v1/auth/register
 * POST /api/v1/auth/verify-email
 * POST /api/v1/auth/login
 * POST /api/v1/auth/logout          (scope=all query: revoke all sessions)
 * POST /api/v1/auth/forgot-password
 * POST /api/v1/auth/reset-password
 * GET  /api/v1/auth/me
 * POST /api/v1/auth/token/refresh   (AC-1 — rotating refresh tokens; CSRF-exempt)
 *
 * INVARIANTS:
 *  - NN-3: validateSession preHandler on every protected route (logout, me).
 *  - NN-5: forgot-password always 200 content-identical.
 *  - Error envelope: { request_id, error: { code, message, fields? } }
 *  - AC-3: rate limiting on login, forgot-password, register, token/refresh.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  RegisterRequestSchema,
  VerifyEmailRequestSchema,
  LoginRequestSchema,
  ForgotPasswordRequestSchema,
  ResetPasswordRequestSchema,
} from '@brain/contracts';
import type { AuthService } from '../../application/auth.service.js';
import { AuthError } from '../../application/auth.service.js';
import type { RateLimiter } from '../../infrastructure/rate-limiter.js';
import {
  loginFailKeySync,
  loginIpKey,
  forgotPasswordKey,
  registerIpKey,
  refreshIpKey,
} from '../../infrastructure/rate-limiter.js';
import { log } from "../../../../../log.js";

export type AuthenticatedRequest = FastifyRequest & {
  auth: {
    userId: string;
    jti: string;
    brandId: string | null;
    workspaceId: string | null;
    role: string | null;
  };
};

export function registerAuthRoutes(
  fastify: FastifyInstance,
  authService: AuthService,
  rateLimiter?: RateLimiter,
): void {
  const FORGOT_PASSWORD_RESPONSE = {
    message: 'If an account exists with this email, a password reset link has been sent.',
  } as const;

  // ── POST /api/v1/auth/register ────────────────────────────────────────────
  fastify.post('/api/v1/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = randomUUID();
    const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;

    // AC-3: Rate limit by IP (10/hour).
    if (rateLimiter) {
      const ip = request.ip ?? '0.0.0.0';
      const rl = await rateLimiter.check(registerIpKey(ip), 10, 3600);
      if (!rl.allowed) {
        return reply.code(429).send({
          request_id: requestId,
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many registration attempts. Please try again later.',
          },
        }).header('Retry-After', String(rl.retryAfter));
      }
    }

    const parsed = RegisterRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({
        request_id: requestId,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          fields: parsed.error.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        },
      });
    }

    try {
      const result = await authService.register(
        parsed.data.email,
        parsed.data.password,
        correlationId,
      );
      return reply.code(201).send({
        request_id: requestId,
        user_id: result.userId,
        email: parsed.data.email,
        message: result.message,
        ...(result.code ? { code: result.code } : {}),
      });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode ?? 400).send({
          request_id: requestId,
          error: { code: err.code, message: err.message },
        });
      }
      throw err;
    }
  });

  // ── POST /api/v1/auth/verify-email ────────────────────────────────────────
  fastify.post('/api/v1/auth/verify-email', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = randomUUID();
    const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;

    const parsed = VerifyEmailRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({
        request_id: requestId,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid token format' },
      });
    }

    try {
      await authService.verifyEmail(parsed.data.token, correlationId);
      return reply.send({ request_id: requestId, ok: true });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode ?? 400).send({
          request_id: requestId,
          error: { code: err.code, message: err.message },
        });
      }
      throw err;
    }
  });

  // ── POST /api/v1/auth/login ───────────────────────────────────────────────
  fastify.post('/api/v1/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = randomUUID();
    const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;

    const parsed = LoginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({
        request_id: requestId,
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed' },
      });
    }

    const ip = request.ip ?? '0.0.0.0';

    // AC-3: Pre-auth rate limit check (peek-only — only count failures, not successes).
    if (rateLimiter) {
      // Per-IP secondary cap (20/15min — bounds credential-stuffing across emails).
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
        parsed.data.email,
        parsed.data.password,
        ip,
        request.headers['user-agent'] ?? null,
        correlationId,
      );

      // Success — reset failure counters.
      if (rateLimiter) {
        rateLimiter.reset(loginFailKeySync(parsed.data.email, ip)).catch(() => {});
        rateLimiter.reset(loginIpKey(ip)).catch(() => {});
      }

      return reply.send({
        request_id: requestId,
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        token_type: 'bearer' as const,
        expires_in: result.expiresIn,
        user: {
          id: result.user.id,
          email: result.user.email,
          email_verified: result.user.emailVerifiedAt !== null,
        },
      });
    } catch (err) {
      if (err instanceof AuthError) {
        // Increment failure counter on auth failure.
        if (rateLimiter) {
          const emailIpRl = await rateLimiter.check(loginFailKeySync(parsed.data.email, ip), 5, 900);
          if (!emailIpRl.allowed) {
            return reply.code(429).send({
              request_id: requestId,
              error: { code: 'RATE_LIMITED', message: 'Too many failed login attempts. Please try again later.' },
            }).header('Retry-After', String(emailIpRl.retryAfter));
          }
        }
        // NN-5: same response for "user not found" and "wrong password".
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
        });
      }
      throw err;
    }
  });

  // ── POST /api/v1/auth/token/refresh (AC-1 — CSRF-exempt) ─────────────────
  // Token-authenticated endpoint. The refresh token IS the credential.
  // CSRF-exempt because it is not cookie-authenticated (added to exempt list in main.ts).
  fastify.post('/api/v1/auth/token/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = randomUUID();
    const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;

    const body = request.body as { refresh_token?: string };
    if (!body?.refresh_token) {
      return reply.code(400).send({
        request_id: requestId,
        error: { code: 'MISSING_REFRESH_TOKEN', message: 'refresh_token is required.' },
      });
    }

    // AC-3: Per-IP rate limit (30/15min — bounds replay-probing).
    if (rateLimiter) {
      const ip = request.ip ?? '0.0.0.0';
      const rl = await rateLimiter.check(refreshIpKey(ip), 30, 900);
      if (!rl.allowed) {
        return reply.code(429).send({
          request_id: requestId,
          error: { code: 'RATE_LIMITED', message: 'Too many refresh attempts. Please try again later.' },
        }).header('Retry-After', String(rl.retryAfter));
      }
    }

    try {
      const result = await authService.rotateRefreshToken(
        body.refresh_token,
        request.ip ?? null,
        request.headers['user-agent'] ?? null,
        correlationId,
      );
      return reply.send({
        request_id: requestId,
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        expires_in: result.expiresIn,
      });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode ?? 401).send({
          request_id: requestId,
          error: { code: err.code, message: err.message },
        });
      }
      throw err;
    }
  });

  // ── POST /api/v1/auth/logout (protected — requires session) ──────────────
  // ?scope=all → revoke all sessions for the user (AC-2).
  fastify.post(
    '/api/v1/auth/logout',
    {
      preHandler: [validateSessionPreHandler(authService)],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const query = request.query as { scope?: string };
      const scopeAll = query.scope === 'all';

      await authService.logout(auth.jti, auth.userId, correlationId, scopeAll);
      // Clear the httpOnly session cookie (set by the BFF session route) so the browser
      // holds no stale, now-revoked token after logout.
      (reply as unknown as { clearCookie(name: string, opts?: { path?: string }): unknown }).clearCookie(
        'brain_session',
        { path: '/' },
      );
      return reply.send({ request_id: requestId, ok: true });
    },
  );

  // ── POST /api/v1/auth/forgot-password ─────────────────────────────────────
  // NN-5: always 200 with content-identical body.
  // AC-3: rate limited per email (5/hour).
  // MA-04: fire-and-forget in service layer (no timing oracle).
  fastify.post('/api/v1/auth/forgot-password', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = randomUUID();
    const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;

    const parsed = ForgotPasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // NN-5: even on invalid input, return 200 with standard body (no enumeration).
      return reply.send({ request_id: requestId, ...FORGOT_PASSWORD_RESPONSE });
    }

    // AC-3: Rate limit by email (5/hour). Fail-open on Redis error.
    if (rateLimiter) {
      const rl = await rateLimiter.check(forgotPasswordKey(parsed.data.email), 5, 3600);
      if (!rl.allowed) {
        // NN-5: still return 200 (don't leak whether the account exists by rate-limit response).
        return reply.send({ request_id: requestId, ...FORGOT_PASSWORD_RESPONSE });
      }
    }

    // Fire-and-forget — result is always the same (NN-5 / MA-04).
    authService.forgotPassword(parsed.data.email, correlationId).catch((err) => {
      log.error('forgotPassword error', { err: { correlationId, err } });
    });

    return reply.send({ request_id: requestId, ...FORGOT_PASSWORD_RESPONSE });
  });

  // ── POST /api/v1/auth/reset-password ──────────────────────────────────────
  fastify.post('/api/v1/auth/reset-password', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = randomUUID();
    const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;

    const parsed = ResetPasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({
        request_id: requestId,
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed' },
      });
    }

    try {
      await authService.resetPassword(parsed.data.token, parsed.data.new_password, correlationId);
      return reply.send({ request_id: requestId, ok: true });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode ?? 400).send({
          request_id: requestId,
          error: { code: err.code, message: err.message },
        });
      }
      throw err;
    }
  });

  // ── GET /api/v1/auth/me (protected) ──────────────────────────────────────
  fastify.get(
    '/api/v1/auth/me',
    {
      preHandler: [validateSessionPreHandler(authService)],
    },
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
          created_at: user.createdAt.toISOString(),
        },
        // Active-brand session context — the web client caches this under AUTH_QUERY_KEY
        // and useSessionRole() reads auth.role to gate role-based UI (e.g. the Sync now
        // trigger, backfill trigger). Without it the client fell back to 'analyst' and
        // hid those controls for everyone (incl. owners) after a refresh.
        auth: {
          role: auth.role,
          brand_id: auth.brandId,
          workspace_id: auth.workspaceId,
        },
      });
    },
  );
}

// ── Session validation preHandler (NN-3) ─────────────────────────────────────

/**
 * Factory: Fastify preHandler that validates the JWT + checks session revocation.
 * NN-3: called on EVERY protected route — including BFF fan-out routes.
 */
export function validateSessionPreHandler(authService: AuthService) {
  return async function validateSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const requestId = randomUUID();
    const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.code(401).send({
        request_id: requestId,
        error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header.' },
      });
    }

    const token = authHeader.slice(7);
    const claims = authService.parseJwt(token);
    if (!claims) {
      return reply.code(401).send({
        request_id: requestId,
        error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token.' },
      });
    }

    // NN-3: check session revocation denylist on EVERY call.
    const isActive = await authService.validateSession(claims.sub, claims.jti, correlationId);
    if (!isActive) {
      return reply.code(401).send({
        request_id: requestId,
        error: { code: 'SESSION_REVOKED', message: 'Session has been revoked.' },
      });
    }

    // Attach auth context to request for downstream handlers.
    (request as AuthenticatedRequest).auth = {
      userId: claims.sub,
      jti: claims.jti,
      brandId: claims.brand_id,
      workspaceId: claims.workspace_id,
      role: claims.role,
    };
  };
}
