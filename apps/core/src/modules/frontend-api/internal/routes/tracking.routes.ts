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
  const { bffProtectedPreHandler, rawPool, srPool, servingCache } = deps;

  // AUD-IMPL-026: tracking-health/recent-events full-scan the unprunable Bronze lift view
  // (collector_events_connect_lifted — every filter column is json_extract_scalar, no pushdown)
  // on EVERY page load. Front them with the serving Redis cache (executive 5-min tier, ids mapped
  // in serving-ttl.ts) so at most one Bronze scan per (brand, params) runs per TTL window. Same
  // closure shape as dashboard.routes.ts; no-op passthrough when the cache is disabled/absent,
  // and the reader is fail-soft (a cache error falls back to the direct Trino read).
  const cachedRead = <T>(
    brandId: string,
    metricId: string,
    params: Record<string, unknown>,
    compute: () => Promise<T>,
  ): Promise<T> => (servingCache ? servingCache.read(brandId, metricId, params, compute) : compute());

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
        const result = await cachedRead(auth.brandId, 'tracking_health', {}, () =>
          getTrackingHealth(auth.brandId!, { pool: rawPool, srPool }),
        );

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
        // `limit` is part of the cache key (params hash) — different page sizes never collide.
        const result = await cachedRead(auth.brandId, 'recent_events', { limit }, () =>
          getRecentEvents(auth.brandId!, limit, { pool: rawPool, srPool }),
        );

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
