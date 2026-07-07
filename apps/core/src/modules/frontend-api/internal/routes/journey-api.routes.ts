// SPEC: B.3
/**
 * Wave-B Journey APIs (SPEC: B.3, AMD-14) — the three spec-named journey surfaces on the
 * sanctioned core BFF seam (AMD-14 R1: no standalone gateway; these are additive routes that
 * reuse the existing analytics use-cases — NOT a parallel implementation).
 *
 *   1. GET /api/v1/customers/:brainId/journey?cursor=&limit=
 *        newest-first paginated timeline; items {ts,type,channel,campaign?,url_path?,session_id,
 *        matched_via,journey_version} + an X-Journey-Version response header. Served from the A.4
 *        Redis touchpoint cache (hot) with the Trino ledger as the §1.11 cold fallback.
 *   2. GET /api/v1/journeys/trace?order_id=
 *        the attribution-lookback touchpoints preceding an order + per-touch matched_via +
 *        identity_evidence [{identifier_type,first_seen,source}] — the explainability surface.
 *   3. GET /api/v1/journeys/compare?left=&right=
 *        two resolved journeys with t_minus_conversion_ms per touch.
 *
 * TENANT: brand_id is ALWAYS from the auth session (D-1) — NEVER a query param. The :brainId path
 * segment + order_id/left/right query keys are lookups WITHIN the caller's brand (every downstream
 * read is brand-scoped at the metric-engine seam / PG RLS). Honest-empty when no journey exists —
 * a NEW endpoint ships and answers no_data rather than fabricating.
 *
 * These are net-new surfaces (they do not change any existing route's behavior) so they are not
 * gated behind journey.engine; the underlying A.4 cache data is itself governed by the per-brand
 * identity.tp_cache flag upstream, and a cold cache transparently falls back to Trino.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import { getCustomerJourney, getJourneyTrace, getJourneyCompare } from '../../../analytics/index.js';
import type { CustomerJourneyTimeline, JourneyTrace, JourneyCompare } from '@brain/contracts';
import type { BffDeps } from './_shared.js';

const UUID_RE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export function registerJourneyApiRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, srPool, rawPool, touchpointCacheReader, servingCache } = deps;

  // §1.11 Redis result-cache wrapper for the Trino-only journey reads (trace/compare) — the
  // 'journey' TTL tier (serving-ttl.ts). Safe-OFF: no cache wired → read Trino directly. The
  // per-customer timeline (1) is served from the A.4 real-time cache instead (not wrapped here).
  const cachedRead = <T>(brandId: string, metricId: string, params: unknown, compute: () => Promise<T>): Promise<T> =>
    servingCache ? servingCache.read(brandId, metricId, params, compute) : compute();

  // ── (1) GET /api/v1/customers/:brainId/journey — paginated newest-first timeline ──────────
  fastify.get(
    '/api/v1/customers/:brainId/journey',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        params: {
          type: 'object',
          properties: { brainId: { type: 'string', pattern: UUID_RE } },
          required: ['brainId'],
        },
        querystring: {
          type: 'object',
          properties: {
            cursor: { type: 'string', maxLength: 512 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
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
          error: { code: 'INVALID_PARAMS', message: 'brainId must be a UUID; limit an integer 1..200.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Serving tier (Trino) not available' } });
      }

      const { brainId } = request.params as { brainId: string };
      const query = request.query as { cursor?: string; limit?: number };

      const result: CustomerJourneyTimeline = await getCustomerJourney(
        auth.brandId,
        { srPool, tpCache: touchpointCacheReader },
        { brainId, cursor: query.cursor ?? null, limit: query.limit, dataSource: 'live' },
      );

      // X-Journey-Version: the derived journey-level version (AMD-11 = max data_version) when the
      // ledger served it; absent on the cache path (pre-ledger hot window) / no_data.
      if (result.state === 'has_data' && result.journey_version !== null) {
        reply.header('X-Journey-Version', String(result.journey_version));
      }
      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── (2) GET /api/v1/journeys/trace?order_id= — lookback touchpoints + identity evidence ────
  fastify.get(
    '/api/v1/journeys/trace',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            order_id: { type: 'string', minLength: 1, maxLength: 256 },
            lookback_days: { type: 'integer', minimum: 1, maximum: 365 },
          },
          required: ['order_id'],
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
          error: { code: 'INVALID_PARAMS', message: 'order_id is required; lookback_days an integer 1..365.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Serving tier (Trino) not available' } });
      }

      const query = request.query as { order_id: string; lookback_days?: number };
      const brandId = auth.brandId; // narrowed const (property narrowing is lost across the closure)

      const result: JourneyTrace = await cachedRead(brandId, 'journey_trace', query, () =>
        getJourneyTrace(
          brandId,
          // rawPool (PG) resolves order → stitched anon(s) via the PG-native stitch map; srPool (Trino)
          // reads the touches + identity evidence.
          { srPool, pool: rawPool },
          { orderId: query.order_id, lookbackDays: query.lookback_days, dataSource: 'live' },
        ),
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── (3) GET /api/v1/journeys/compare?left=&right= — two journeys with t_minus_conversion_ms ─
  fastify.get(
    '/api/v1/journeys/compare',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            left: { type: 'string', pattern: UUID_RE },
            right: { type: 'string', pattern: UUID_RE },
          },
          required: ['left', 'right'],
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
          error: { code: 'INVALID_PARAMS', message: 'left and right must both be customer brain_id UUIDs.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        // Compare is not a discriminated no_data union; an unauthenticated-brand read returns two
        // empty journeys honestly (never another brand's data).
        const { left, right } = request.query as { left: string; right: string };
        return reply.send({
          request_id: requestId,
          data: {
            left: { brain_id: left, conversion_at: null, touches: [] },
            right: { brain_id: right, conversion_at: null, touches: [] },
            data_source: 'live',
          },
        });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Serving tier (Trino) not available' } });
      }

      const { left, right } = request.query as { left: string; right: string };
      const brandId = auth.brandId; // narrowed const (property narrowing is lost across the closure)

      const result: JourneyCompare = await cachedRead(brandId, 'journey_compare', { left, right }, () =>
        getJourneyCompare(brandId, { srPool }, { left, right, dataSource: 'live' }),
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );
}
