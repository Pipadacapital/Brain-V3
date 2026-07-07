// SPEC: E
/**
 * AI Feature Layer online-serving BFF route (Wave E — SCAFFOLD ONLY, 501 stub).
 *
 * §PART 6.E: "Online contract: Redis hash {brand_id}:feat:{entity_type}:{entity_id}; endpoint
 * stub GET /v1/features/... → 501 behind flag." Mounted on the BFF at the repo-canonical
 * `/api/v1/...` prefix (AMD-14: spec `/v1/...` paths map to the existing BFF namespace).
 *
 * Behavior — an HONEST NotImplemented scaffold:
 *   • Tenant-scoped: brand from SESSION (auth.brandId), never a query/path param. No active
 *     brand → 400. The entity is addressed by (entity_type, entity_id); entity_type is validated
 *     against the customer|product|campaign contract → 400 on anything else.
 *   • The `features.online_serving` flag is READ (load-bearing) and echoed, but online serving is
 *     NOT implemented in this wave, so the route returns 501 NOT_IMPLEMENTED whether the flag is
 *     ON or OFF (there is no logic to gate). Materialization/serving is Wave E logic (deferred —
 *     knowledge-base/contracts/CONTRACT-E.md §Deferred).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { isFeatureEntityType, FEATURE_ENTITY_TYPES } from '@brain/ai-features';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import type { BffDeps } from './_shared.js';

export function registerFeaturesRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, flagService } = deps;

  /**
   * GET /api/v1/features/:entity_type/:entity_id — online feature vector for one entity.
   * 501 NOT_IMPLEMENTED (Wave E scaffold). Tenant from session; entity_type contract-validated.
   */
  fastify.get(
    '/api/v1/features/:entity_type/:entity_id',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.brandId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand to serve features.' },
        });
      }

      const { entity_type: entityType, entity_id: entityId } = request.params as {
        entity_type: string;
        entity_id: string;
      };
      if (!isFeatureEntityType(entityType)) {
        return reply.code(400).send({
          request_id: requestId,
          error: {
            code: 'INVALID_ENTITY_TYPE',
            message: `entity_type must be one of: ${FEATURE_ENTITY_TYPES.join(', ')}`,
          },
        });
      }
      if (!entityId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_ENTITY_ID', message: 'entity_id is required.' },
        });
      }

      // Read the flag (load-bearing / auditable) — fail-closed to OFF when no service is wired.
      const onlineServingEnabled = flagService
        ? await flagService.isFlagEnabled(auth.brandId, 'features.online_serving')
        : false;

      // Honest scaffold: no serving logic exists yet → 501 regardless of flag state.
      return reply.code(501).send({
        request_id: requestId,
        error: {
          code: 'NOT_IMPLEMENTED',
          message:
            'Online feature serving is not implemented yet (Wave E scaffold). See CONTRACT-E.md.',
        },
        data: {
          entity_type: entityType,
          online_serving_flag: onlineServingEnabled,
          online_key_template: `{brand_id}:feat:${entityType}:{entity_id}`,
        },
      });
    },
  );
}
