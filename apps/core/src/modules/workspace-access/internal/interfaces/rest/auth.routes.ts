/**
 * Auth REST routes — thin Fastify route adapters over AuthService.
 *
 * POST /api/v1/auth/register
 * POST /api/v1/auth/verify-email
 * POST /api/v1/auth/login
 * POST /api/v1/auth/logout
 * POST /api/v1/auth/forgot-password
 * POST /api/v1/auth/reset-password
 * GET  /api/v1/auth/me
 *
 * INVARIANTS:
 *  - NN-3: validateSession preHandler on every protected route (logout, me).
 *  - NN-5: forgot-password always 200 content-identical.
 *  - Error envelope: { request_id, error: { code, message, fields? } }
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
): void {
  const FORGOT_PASSWORD_RESPONSE = {
    message: 'If an account exists with this email, a password reset link has been sent.',
  } as const;

  // ── POST /api/v1/auth/register ────────────────────────────────────────────
  fastify.post('/api/v1/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = randomUUID();
    const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;

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
      });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(400).send({
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
        return reply.code(400).send({
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

    try {
      const result = await authService.login(
        parsed.data.email,
        parsed.data.password,
        request.ip ?? null,
        request.headers['user-agent'] ?? null,
        correlationId,
      );
      return reply.send({
        request_id: requestId,
        access_token: result.accessToken,
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
        // NN-5: same response for "user not found" and "wrong password".
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
        });
      }
      throw err;
    }
  });

  // ── POST /api/v1/auth/logout (protected — requires session) ──────────────
  fastify.post(
    '/api/v1/auth/logout',
    {
      preHandler: [validateSessionPreHandler(authService)],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;

      await authService.logout(auth.jti, auth.userId, correlationId);
      return reply.send({ request_id: requestId, ok: true });
    },
  );

  // ── POST /api/v1/auth/forgot-password ─────────────────────────────────────
  // NN-5: always 200 with content-identical body.
  fastify.post('/api/v1/auth/forgot-password', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = randomUUID();
    const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;

    const parsed = ForgotPasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // NN-5: even on invalid input, return 200 with standard body (no enumeration).
      return reply.send({ request_id: requestId, ...FORGOT_PASSWORD_RESPONSE });
    }

    // Fire-and-forget — result is always the same (NN-5).
    authService.forgotPassword(parsed.data.email, correlationId).catch((err) => {
      console.error('[auth] forgotPassword error', { correlationId, err });
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
        return reply.code(400).send({
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
      });
    },
  );
}

// ── Session validation preHandler (NN-3) ─────────────────────────────────────

/**
 * Factory: Fastify preHandler that validates the JWT + checks session revocation.
 * NN-3: called on EVERY protected route — including BFF fan-out routes.
 *
 * The short token the BFF mints must carry the original jti so this handler
 * can check user_session.revoked_at IS NULL.
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
