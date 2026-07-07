// SPEC: G (AMD-21)
/**
 * Wave G scaffold — the NEW gold_recommendations-schema-backed serving surface.
 *
 * §G: "GET /v1/recommendations over gold_recommendations → 501 behind flag." AMD-21 (BINDING, R1):
 * a WORKING rule-based recommend-only surface ALREADY ships at `GET /api/v1/recommendations`
 * (decisions.routes.ts detectors + confidence-gate + recommendation_action ledger + UI). Applying
 * the spec's path verbatim would REGRESS that live feature. AMD-21 therefore scopes the 501 stub
 * to a NEW, net-new path so nothing shipped changes:
 *
 *   GET /api/v1/recommendations/generated   ← the §G endpoint, over the (empty) gold_recommendations mart.
 *
 * DEFERRED (§G): all models, all scoring. There is NO reader for gold_recommendations yet — the
 * endpoint is a failing-by-design NotImplemented stub, gated by the per-brand `recommendations.api`
 * flag (registered, DEFAULT OFF, fail-closed — @brain/platform-flags).
 *
 * Behavior (fail-closed):
 *   - no session brand           → 400 NO_BRAND        (brand from session only — D-1)
 *   - flag OFF (default) / absent → 404 NOT_ENABLED     (capability gated OFF for this brand)
 *   - flag ON                     → 501 NOT_IMPLEMENTED (enabled, but Wave G models/scoring not shipped)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import type { BffDeps } from './_shared.js';

/** The per-brand flag that gates the NEW schema-backed recommendations surface (§G). */
const RECOMMENDATIONS_API_FLAG = 'recommendations.api' as const;

export function registerRecommendationsGeneratedRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, flagService } = deps;

  /**
   * GET /api/v1/recommendations/generated
   * The §G gold_recommendations serving endpoint. 501 stub until Wave G models ship (AMD-21).
   * NOTE: intentionally distinct from the shipped GET /api/v1/recommendations (grandfathered, untouched).
   */
  fastify.get(
    '/api/v1/recommendations/generated',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      // Brand from session only (D-1) — never from body/query.
      if (!auth.brandId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'NO_BRAND', message: 'Session has no active brand.' },
        });
      }

      // Fail-closed: absent flag service OR flag OFF ⇒ the capability is not enabled for this brand.
      const enabled = flagService
        ? await flagService.isFlagEnabled(auth.brandId, RECOMMENDATIONS_API_FLAG)
        : false;
      if (!enabled) {
        return reply.code(404).send({
          request_id: requestId,
          error: {
            code: 'NOT_ENABLED',
            message:
              'The gold_recommendations serving endpoint is gated by the recommendations.api flag (OFF).',
          },
        });
      }

      // Flag ON, but Wave G models/scoring are DEFERRED (§G) — honest NotImplemented.
      return reply.code(501).send({
        request_id: requestId,
        error: {
          code: 'NOT_IMPLEMENTED',
          message:
            'gold_recommendations serving is not implemented yet — Wave G models/scoring are deferred (SPEC:G, AMD-21).',
        },
      });
    },
  );
}
