/**
 * Tracking-Center BFF routes (CQ-1 decomposition).
 *
 * Stakeholder-visible proof the pixel works: tracking-health and the recent-events
 * explorer. Bounded reads (D-2 allowed), RLS-scoped via withBrandTxn, brand from
 * session (D-1). NO raw PII in responses (anonymized ids only).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import { getTrackingHealth, getRecentEvents } from '../../../analytics/index.js';
import type { BffDeps } from './_shared.js';

export function registerTrackingRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, rawPool, srPool } = deps;

  // ── Tracking Center endpoints (Phase 1 Track C) ───────────────────────────
  // Stakeholder-visible proof that the pixel works. Bounded reads (D-2 allowed),
  // RLS-scoped via withBrandTxn, brand from session (D-1). NO raw PII in responses.

  /**
   * GET /api/v1/analytics/tracking-health
   * Returns pixel-collection health: first-event-received, per-day volume,
   * last-event freshness, total + consent-capture counts. Honest-empty 'no_data'.
   */
  fastify.get(
    '/api/v1/analytics/tracking-health',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }

      try {
        const result = await getTrackingHealth(auth.brandId, { pool: rawPool, srPool });

        return reply.send({ request_id: requestId, data: result });
      } catch {
        return reply.code(503).send({
          request_id: requestId,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'This data is temporarily unavailable. Please try again.',
          },
        });
      }
    },
  );

  /**
   * GET /api/v1/analytics/recent-events?limit=20
   * Returns the latest N collected events (type/time/anonymized ids) for the
   * Event Explorer. Bounded read; NO raw PII (anonymized ids only).
   */
  fastify.get(
    '/api/v1/analytics/recent-events',
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

      try {
        const result = await getRecentEvents(auth.brandId, limit, { pool: rawPool, srPool });

        return reply.send({ request_id: requestId, data: result });
      } catch {
        return reply.code(503).send({
          request_id: requestId,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'This data is temporarily unavailable. Please try again.',
          },
        });
      }
    },
  );
}
