/**
 * requireVerifiedEmail — server-side email-verification soft-gate (feat-onboarding-ux,
 * Deliverable 2). This preHandler is the LOAD-BEARING enforcement: the dismissible
 * "verify your email" banner is UX only; THIS is what actually blocks sensitive actions.
 *
 * Mirrors requireRole (rbac.ts) and MUST run AFTER the session preHandler (which
 * populates request.auth). It does an AUTHORITATIVE DB self-read via
 * authService.isEmailVerified — NOT a JWT claim (the JWT carries no email_verified,
 * and a user who verifies mid-session must be un-gated immediately, no token rotation).
 *
 * On unverified → 403 EMAIL_NOT_VERIFIED (NOT 401: the session is valid, the action is
 * forbidden until verified; a 401 would trigger the client's logout-redirect). The
 * error envelope is { request_id, error: { code, message } } like every other guard.
 *
 * Sensitive surfaces gated by this preHandler (the canonical list — keep in sync):
 *   1. Connect a real store — connector WRITE scope (main.ts): POST /api/v1/connectors,
 *      GET /api/v1/connectors/shopify/install, ads install routes. (Read/list/status and
 *      the public OAuth callbacks stay OPEN — callbacks are HMAC/state-authed, and gating
 *      them would strand an in-flight OAuth.)
 *   2. Invite a member — POST /api/v1/invites (member.routes.ts). The public token-authed
 *      POST /api/v1/invites/accept stays OPEN.
 *   3. Billing — no billing-mutation route exists in M1. CONTRACT: any future billing
 *      mutation route MUST include requireVerifiedEmail in its preHandler chain.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuthService } from '../application/auth.service.js';
import type { AuthenticatedRequest } from './rbac.js';

export function requireVerifiedEmail(authService: AuthService) {
  return async function verifiedEmailGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const requestId = randomUUID();
    const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;

    const auth = (request as FastifyRequest & { auth?: AuthenticatedRequest }).auth;
    if (!auth) {
      // Fail-closed: this guard must run after the session preHandler. If auth is
      // missing the chain is misordered — reject rather than allow.
      return reply.code(401).send({
        request_id: requestId,
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
    }

    const verified = await authService.isEmailVerified(auth.userId, correlationId);
    if (!verified) {
      return reply.code(403).send({
        request_id: requestId,
        error: {
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Verify your email before performing this action.',
        },
      });
    }
  };
}
