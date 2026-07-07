// SPEC:D.2
/**
 * Semantic metric CATALOG discovery route (Wave D.2 / D.4.2).
 *
 * §D.2: "Compiler generates … a JSON catalog at GET /v1/semantic/metrics." Mounted on the BFF at
 * the repo-canonical `/api/v1/...` prefix (AMD-14: spec `/v1/...` paths map to the existing BFF
 * namespace). The catalog is the machine-readable directory of every CERTIFIED metric — its
 * definition, compiled Trino view names, tenancy/determinism posture, and an MCP-shaped tool
 * definition per metric (the Wave-F copilot binds to these; brand_id is NEVER a tool input).
 *
 * Discovery of DEFINITIONS changes no served number, so it is safe with `semantic.serving` either
 * way; the flag state is READ + echoed (load-bearing/auditable) so operators can see whether the
 * compiled views back live serving yet. Tenant is from the SESSION (auth.brandId), never a param.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildPackagedCatalog } from '@brain/semantic-metrics';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import type { BffDeps } from './_shared.js';

export function registerSemanticMetricsRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, flagService } = deps;

  /** GET /api/v1/semantic/metrics — the full certified metric catalog + per-metric MCP tool defs. */
  fastify.get(
    '/api/v1/semantic/metrics',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.code(403).send({
          request_id: requestId,
          error: { code: 'NO_BRAND', message: 'No brand in session.' },
        });
      }

      const servingEnabled = flagService
        ? await flagService.isFlagEnabled(auth.brandId, 'semantic.serving')
        : false;

      const catalog = await buildPackagedCatalog();
      return reply.send({
        request_id: requestId,
        data: { ...catalog, semantic_serving_flag: servingEnabled },
      });
    },
  );

  /** GET /api/v1/semantic/metrics/:metric — one certified metric's catalog entry (404 if unknown). */
  fastify.get(
    '/api/v1/semantic/metrics/:metric',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        params: {
          type: 'object',
          properties: { metric: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' } },
          required: ['metric'],
          additionalProperties: false,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.code(403).send({
          request_id: requestId,
          error: { code: 'NO_BRAND', message: 'No brand in session.' },
        });
      }

      const { metric } = request.params as { metric: string };
      const catalog = await buildPackagedCatalog();
      const entry = catalog.metrics.find((m) => m.name === metric);
      if (!entry) {
        return reply.code(404).send({
          request_id: requestId,
          error: {
            code: 'UNKNOWN_METRIC',
            message: `No certified semantic metric "${metric}".`,
            supported: catalog.metrics.map((m) => m.name),
          },
        });
      }
      return reply.send({ request_id: requestId, data: entry });
    },
  );
}
