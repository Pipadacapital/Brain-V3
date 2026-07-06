// SPEC: 0.5
/**
 * Admin feature-flag BFF routes (§0.5 platform-flags admin surface).
 *
 *   GET /api/v1/admin/flags        — every registered flag + per-brand state.
 *   PUT /api/v1/admin/flags        — set ONE flag for the session brand: { flag, enabled }.
 *
 * Brand from SESSION only (D-1 — never from body/query: a caller can never flip
 * another brand's flags). Coarse RBAC: brand_admin or owner (mirrors the
 * requireRole('brand_admin') gate used on workspace-access admin writes).
 * Flags are per-brand, DEFAULT OFF, fail-closed — see @brain/platform-flags.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { isKnownFlag, ALL_PLATFORM_FLAGS, type PlatformFlag } from '@brain/platform-flags';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import type { BffDeps } from './_shared.js';

/** Roles allowed to read/flip flags — hierarchy: owner > brand_admin > manager > analyst. */
const FLAG_ADMIN_ROLES = new Set(['owner', 'brand_admin']);

export function registerAdminFlagsRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, flagService } = deps;

  /** Shared guard: session brand + admin role, or the reason we refused. */
  function adminBrandOrReply(
    request: FastifyRequest,
    reply: FastifyReply,
    requestId: string,
  ): string | null {
    const auth = (request as AuthenticatedRequest).auth;
    if (!auth.brandId) {
      reply.code(400).send({
        request_id: requestId,
        error: { code: 'NO_BRAND', message: 'Session has no active brand.' },
      });
      return null;
    }
    if (!auth.role || !FLAG_ADMIN_ROLES.has(auth.role)) {
      reply.code(403).send({
        request_id: requestId,
        error: { code: 'FORBIDDEN', message: 'Requires brand_admin role or higher.' },
      });
      return null;
    }
    return auth.brandId;
  }

  /**
   * GET /api/v1/admin/flags
   * Every registered flag (typed registry) with its current per-brand state.
   */
  fastify.get(
    '/api/v1/admin/flags',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const brandId = adminBrandOrReply(request, reply, requestId);
      if (!brandId) return;
      if (!flagService) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Flag service not available' },
        });
      }
      const flags = await flagService.listFlags(brandId);
      return reply.send({ request_id: requestId, data: { brand_id: brandId, flags } });
    },
  );

  /**
   * PUT /api/v1/admin/flags
   * Body: { flag: string, enabled: boolean } — flag must be in the typed registry
   * (the registry is the write allowlist; unknown names are rejected, not created).
   */
  fastify.put(
    '/api/v1/admin/flags',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const brandId = adminBrandOrReply(request, reply, requestId);
      if (!brandId) return;
      if (!flagService) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Flag service not available' },
        });
      }

      const body = (request.body ?? {}) as { flag?: unknown; enabled?: unknown };
      if (typeof body.flag !== 'string' || !isKnownFlag(body.flag)) {
        return reply.code(400).send({
          request_id: requestId,
          error: {
            code: 'UNKNOWN_FLAG',
            message: `flag must be one of: ${ALL_PLATFORM_FLAGS.join(', ')}`,
          },
        });
      }
      if (typeof body.enabled !== 'boolean') {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_BODY', message: 'enabled must be a boolean' },
        });
      }

      const flag: PlatformFlag = body.flag;
      await flagService.setFlag(brandId, flag, body.enabled);
      request.log.info(
        { brandId, flag, enabled: body.enabled },
        '[admin-flags] flag updated',
      );
      return reply.send({
        request_id: requestId,
        data: { brand_id: brandId, flag, enabled: body.enabled },
      });
    },
  );
}
