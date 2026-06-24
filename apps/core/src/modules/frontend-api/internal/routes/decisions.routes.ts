/**
 * Decision-intelligence BFF routes (CQ-1 decomposition).
 *
 * Recommendations (the Morning Brief, refresh, human-action ledger) and the ML
 * platform (model registry list, gated promote, customer-score serving). Recommend-only:
 * detectors emit ranked actions with confidence + evidence into the append-only
 * decision_log. Brand from session (D-1), never the request.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import { getMetricTrust } from '../../../data-quality/index.js';
import {
  getRecommendations,
  generateRecommendations,
  recordRecommendationAction,
  isRecommendationAction,
  RecommendationNotFoundError,
  InvalidRecommendationActionError,
} from '../../../recommendation/index.js';
import {
  listModels,
  promoteModel,
  serveCustomerScore,
  isModelStage,
  ModelNotFoundError,
  InvalidModelStageError,
} from '../../../ml/index.js';
import type {
  Recommendations as ContractRecommendations,
  GenerateRecommendationsResult as ContractGenerateRecommendationsResult,
  RecommendationAction as ContractRecommendationAction,
  ModelList as ContractModelList,
  Model as ContractModel,
  CustomerScoreResult as ContractCustomerScoreResult,
} from '@brain/contracts';
import type { BffDeps } from './_shared.js';

export function registerDecisionsRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, pool, rawPool, srPool } = deps;

  // ── Recommendation endpoints (P1 — deterministic decision engine, doc 09) ──
  // Recommend-only: detectors emit ranked risk/opportunity actions with confidence + evidence,
  // recorded in the append-only decision_log. Brand from session (D-1), never the request.

  /**
   * GET /api/v1/recommendations — the active brand's OPEN recommendations (the Morning Brief).
   * Honest union: state:'no_data' when none, else state:'has_data' ranked by priority.
   */
  fastify.get(
    '/api/v1/recommendations',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      // "Confidence before decisions" (P0): resolve the brand's CURRENT trust gate and pass it so
      // getRecommendations caps each rec's surfaced confidence + holds high-risk recs below Trusted.
      // Fail-closed to 'untrusted' when the engine pool is unavailable (no trust proof → hold).
      const trust = rawPool
        ? await getMetricTrust(auth.brandId, { pool: rawPool })
        : { tier: 'untrusted' as const, gate: { blocksHighRiskRecommendation: true } };
      const result: ContractRecommendations = await getRecommendations(auth.brandId, requestId, {
        pool,
        gate: {
          tier: trust.tier,
          blocksHighRiskRecommendation: trust.gate.blocksHighRiskRecommendation,
        },
      });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * POST /api/v1/recommendations/refresh — run the detectors for the active brand, reconciling
   * the open set (raise/refresh/expire) and appending to the decision_log. Returns the counts.
   */
  fastify.post(
    '/api/v1/recommendations/refresh',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand before running detectors.' },
        });
      }
      if (!pool || !srPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const result: ContractGenerateRecommendationsResult = await generateRecommendations(
        auth.brandId,
        requestId,
        { pool, srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * POST /api/v1/recommendations/:id/action — record a human action on a recommendation (M7).
   *
   * The human decision-feedback loop: served / accepted / dismissed / snoozed / reopened, appended
   * to the immutable action ledger. 'dismissed'/'reopened' also move the rec's lifecycle status.
   * actor = the authenticated user (auth.userId). Brand from session (D-1), never the request.
   */
  fastify.post(
    '/api/v1/recommendations/:id/action',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand before acting on a recommendation.' },
        });
      }
      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const { id: recommendationId } = request.params as { id: string };
      const body = (request.body ?? {}) as { action?: string; reason?: string };

      if (!isRecommendationAction(body.action)) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_ACTION', message: 'Unknown or missing recommendation action.' },
        });
      }

      try {
        const result: ContractRecommendationAction = await recordRecommendationAction(
          {
            brandId: auth.brandId,
            recommendationId,
            action: body.action,
            actor: auth.userId,
            reason: body.reason ?? null,
          },
          requestId,
          { pool },
        );
        return reply.send({ request_id: requestId, data: result });
      } catch (err) {
        if (err instanceof RecommendationNotFoundError) {
          return reply.code(404).send({
            request_id: requestId,
            error: { code: 'RECOMMENDATION_NOT_FOUND', message: 'Recommendation not found.' },
          });
        }
        if (err instanceof InvalidRecommendationActionError) {
          return reply.code(400).send({
            request_id: requestId,
            error: { code: 'INVALID_ACTION', message: 'Unknown recommendation action.' },
          });
        }
        throw err;
      }
    },
  );

  /**
   * GET /api/v1/ml/models — the active brand's model registry (DB-AUDIT C5 ML platform).
   *
   * Lists ml.model_registry rows (RLS-scoped, ordered name then newest-first). Brand from session (D-1).
   */
  fastify.get(
    '/api/v1/ml/models',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand to view its models.' },
        });
      }
      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }
      const models = await listModels(auth.brandId, requestId, { pool });
      const result: ContractModelList = { models: models as ContractModel[] };
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * POST /api/v1/ml/models/:id/promote — gated stage transition (DB-AUDIT C5 ML platform).
   *
   * Promoting to 'production' archives the prior production model of the same (brand,name) in ONE txn
   * (the partial-unique invariant). Needs the raw pg pool for the explicit atomic transaction. Brand
   * from session (D-1), never the request.
   */
  fastify.post(
    '/api/v1/ml/models/:id/promote',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand before promoting a model.' },
        });
      }
      if (!rawPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }
      const { id: modelId } = request.params as { id: string };
      const body = (request.body ?? {}) as { stage?: string };
      if (!isModelStage(body.stage)) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_STAGE', message: 'Unknown or missing model stage.' },
        });
      }
      try {
        const model = await promoteModel(auth.brandId, { modelId, toStage: body.stage }, requestId, {
          rawPool,
        });
        const result: ContractModel = model as ContractModel;
        return reply.send({ request_id: requestId, data: result });
      } catch (err) {
        if (err instanceof ModelNotFoundError) {
          return reply.code(404).send({
            request_id: requestId,
            error: { code: 'MODEL_NOT_FOUND', message: 'Model not found.' },
          });
        }
        if (err instanceof InvalidModelStageError) {
          return reply.code(400).send({
            request_id: requestId,
            error: { code: 'INVALID_STAGE', message: 'Unknown model stage.' },
          });
        }
        throw err;
      }
    },
  );

  /**
   * GET /api/v1/ml/customer-score?brain_id=… — serve a customer's RFM/churn score (DB-AUDIT C5).
   *
   * Reads the deterministic Gold score (metric-engine seam — needs srPool), resolves the production
   * model, logs an append-only ml.prediction_log row, returns {model, score}. Honest no_data when the
   * customer has no Gold score row. Brand from session (D-1); brain_id is a query param.
   */
  fastify.get(
    '/api/v1/ml/customer-score',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand to serve a score.' },
        });
      }
      const brainId = (request.query as { brain_id?: string })?.brain_id;
      if (!brainId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_BRAIN_ID', message: 'brain_id query parameter is required.' },
        });
      }
      if (!pool || !srPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' },
        });
      }
      const result: ContractCustomerScoreResult = await serveCustomerScore(
        auth.brandId,
        brainId,
        requestId,
        { pool, srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );
}
