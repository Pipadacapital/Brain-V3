/**
 * "Ask Brain" Decision-Intelligence BFF route (CQ-1 decomposition).
 *
 * POST /api/v1/ask — THE honest AI seam: resolves an NL question to a certified
 * metric_binding, computes the number over the metric-engine sole read path, and
 * returns the AskBrainResult DTO. The route issues NO SQL and makes NO model call
 * directly (it calls askBrain). Brand from session (D-1).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import { askBrain } from '../../../ai/index.js';
import { ResolverClient } from '@brain/ai-gateway-client';
import type { AskBrainResult as ContractAskBrainResult } from '@brain/contracts';
import type { BffDeps } from './_shared.js';

// Phase 8 — the NLQ resolver gateway client (litellm @ LITELLM_BASE_URL, latest Claude).
// Constructed once and reused; the raw question is passed in-memory only (never persisted/logged).
const askResolverClient = new ResolverClient();

export function registerAskRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, rawPool, srPool } = deps;

  // ── POST /api/v1/ask — Decision-Intelligence "Ask Brain" (Phase 8, D7) ────
  /**
   * POST /api/v1/ask  body: { question: string, as_of?: YYYY-MM-DD }
   *
   * THE HONEST AI SEAM. Resolves an NL question to a certified metric_binding (the model
   * SELECTS over the registry enum — it NEVER emits SQL and NEVER produces a number, I-S08 /
   * METRICS.md §5), computes the number over the metric-engine SOLE read path (I-ST01),
   * attaches the frozen confidence/tier (Phase 7), persists reproducible provenance (the
   * REDACTED question only — the raw question is NEVER persisted or logged, D4), and returns
   * the AskBrainResult DTO. Off-domain → an honest refusal (no fabricated number).
   *
   * This route issues NO SQL and makes NO model call directly — it calls askBrain (same
   * discipline as every other BFF route). Brand from session (D-1): auth.brandId, never body.
   * Money is bigint-minor string + currency (never float).
   */
  fastify.post(
    '/api/v1/ask',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          required: ['question'],
          additionalProperties: false,
          properties: {
            question: { type: 'string', minLength: 1, maxLength: 2000 },
            as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
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
          error: { code: 'INVALID_REQUEST', message: 'question is required (1–2000 chars); as_of must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;

      // Honest-empty: no active brand yet → an honest refusal (no certified data to bind to).
      if (!auth.brandId) {
        return reply.send({
          request_id: requestId,
          data: { kind: 'refusal', reason: 'no certified metric answers this — connect data first' },
        });
      }

      if (!rawPool || !srPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const body = request.body as { question: string; as_of?: string };
      // as_of is server-bounded (never client-trusted for the value, but accepted for the frame).
      const asOf = body.as_of ?? (new Date().toISOString().split('T')[0] as string);

      // The raw question is passed IN-MEMORY only; askBrain persists/logs only the redacted form.
      let result: ContractAskBrainResult;
      try {
        result = await askBrain(auth.brandId, body.question, asOf, {
          engine: { pool: rawPool },
          srPool,
          resolver: askResolverClient,
        });
      } catch (err) {
        // The LLM gateway (litellm via @brain/ai-gateway-client) can throw a bare Error with
        // raw status detail — NEVER leak that to the client. Log it server-side, return a
        // friendly 503 dependency-down refusal.
        request.log.error({ err, request_id: requestId }, 'askBrain failed — AI gateway unavailable');
        return reply.code(503).send({
          request_id: requestId,
          error: {
            code: 'AI_UNAVAILABLE',
            message: 'The assistant is temporarily unavailable. Please try again shortly.',
          },
        });
      }

      return reply.send({ request_id: requestId, data: result });
    },
  );
}
