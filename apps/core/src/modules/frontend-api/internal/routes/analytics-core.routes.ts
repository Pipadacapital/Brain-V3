/**
 * Core revenue/orders analytics BFF routes (CQ-1 decomposition).
 *
 * Revenue + orders timeseries, KPI summary, executive headline metrics, cohort
 * retention, the insights/Copilot briefing, recognition breakdown, recent activity,
 * and order stats. ADR-002 sole-read-path: each route calls an analytics wrapper →
 * the metric engine. Brand from session (D-1); honest-empty state when no rows.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import {
  getRevenueTimeseries,
  getKpiSummary,
  getRecognitionBreakdown,
  getRecentActivity,
  getOrdersTimeseries,
  getOrderStats,
  getExecutiveMetrics,
  getCohortRetention,
  getInsightsBriefing,
} from '../../../analytics/index.js';
import { materializeInsightsAsRecommendations } from '../../../recommendation/index.js';
import type { KpiSummary as ContractKpiSummary } from '@brain/contracts';
import type { TimeGrain } from '@brain/metric-engine';
import type { BffDeps } from './_shared.js';

export function registerAnalyticsCoreRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, pool, srPool } = deps;

  // ── Analytics endpoints (Phase 1) ─────────────────────────────────────────
  // ADR-002 sole-read-path: all routes call analytics query wrappers which call the metric engine.
  // Brand from session (D-1): auth.brandId, NEVER from request body.
  // Honest-empty: state:'no_data' when brand has no ledger rows.

  /**
   * GET /api/v1/analytics/revenue-timeseries?from=YYYY-MM-DD&to=YYYY-MM-DD&grain=day|week
   * Returns per-bucket realized + provisional revenue for charting.
   */
  fastify.get(
    '/api/v1/analytics/revenue-timeseries',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            grain: { type: 'string', enum: ['day', 'week'] },
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
          error: { code: 'INVALID_PARAMS', message: 'from and to must be YYYY-MM-DD; grain must be day or week.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: null, to: null, grain: 'day', buckets: [] } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string; grain?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      // Default: last 90 days
      const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;
      const grain: TimeGrain = (query.grain === 'week' ? 'week' : 'day') as TimeGrain;

      // Epic 1: revenue timeseries now reads the lakehouse (gold_revenue_ledger), not the PG ledger.
      const result = await getRevenueTimeseries(
        auth.brandId,
        { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`), grain },
        { srPool },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/kpi-summary?as_of=YYYY-MM-DD
   * Returns brand KPI snapshot: realized, provisional, orders, AOV, RTO rate.
   */
  fastify.get(
    '/api/v1/analytics/kpi-summary',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
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
          error: { code: 'INVALID_DATE', message: 'as_of must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', as_of: today } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { as_of?: string };
      const asOfStr = query.as_of ?? (new Date().toISOString().split('T')[0] as string);
      const asOf = new Date(`${asOfStr}T00:00:00Z`);

      // Epic 1: KPI summary now reads the lakehouse (gold_revenue_ledger), not the PG ledger.
      const result: ContractKpiSummary = await getKpiSummary(auth.brandId, asOf, { srPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/executive-metrics?from=&to=
   * H9 — the executive HEADLINE tiles (AOV, LTV, repeat_rate, CAC, ROAS) served from the Gold marts
   * THROUGH the metric registry (gold_executive_metrics + gold_customer_360 + gold_cac + blended ROAS).
   * Honest no_data when the brand has no Gold rows; ratios are null (never 0/∞) when the denominator is 0.
   */
  fastify.get(
    '/api/v1/analytics/executive-metrics',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
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
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'from and to must be YYYY-MM-DD.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const query = request.query as { from?: string; to?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const fromStr = query.from ?? (new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string);

      const result = await getExecutiveMetrics(
        auth.brandId,
        { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`) },
        { srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/cohort-retention
   * H9/H11 — acquisition-cohort curve (size, lifetime orders/value, orders-per-customer) over the
   * order spine, from gold_cohorts via the metric registry. Honest no_data on zero cohorts.
   */
  fastify.get(
    '/api/v1/analytics/cohort-retention',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const result = await getCohortRetention(auth.brandId, { srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/insights/briefing
   * Insight + Opportunity Engine + AI Copilot daily briefing — deterministic insights (revenue swing,
   * RTO leakage, churn LTV-at-risk, VIP concentration, CAC trend) over the Gold marts via the
   * metric-engine. Numbers come from the marts, never from a model. Honest no_data on zero realized rows.
   */
  fastify.get(
    '/api/v1/insights/briefing',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const result = await getInsightsBriefing(auth.brandId, { srPool });
      // Converge insights into the audited decision loop: persist each as a recommendation (idempotent
      // read-through) so Accept/Dismiss/Snooze write to the recommendation_action ledger and outcomes
      // are measurable (RGUD). Merge the recommendation_id/status back onto each insight for the UI.
      if (result.state === 'has_data' && pool) {
        try {
          const materialized = await materializeInsightsAsRecommendations(
            auth.brandId,
            result.insights,
            requestId,
            { pool },
          );
          const byId = new Map(materialized.map((m) => [m.insightId, m]));
          result.insights = result.insights.map((i) => {
            const m = byId.get(i.id);
            return { ...i, recommendation_id: m?.recommendationId ?? null, status: m?.status ?? null };
          });
        } catch (err) {
          // Non-fatal: the briefing still renders read-only if the recommendation bridge fails.
          request.log.error({ err }, '[insights] materialize-as-recommendations failed; serving read-only');
        }
      }
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/recognition-breakdown?as_of=YYYY-MM-DD
   * Returns recognition state distribution: provisional/settling/finalized counts + amounts.
   */
  fastify.get(
    '/api/v1/analytics/recognition-breakdown',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
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
          error: { code: 'INVALID_DATE', message: 'as_of must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', as_of: today } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { as_of?: string };
      const asOfStr = query.as_of ?? (new Date().toISOString().split('T')[0] as string);
      const asOf = new Date(`${asOfStr}T00:00:00Z`);

      // Epic 1: recognition breakdown now reads the lakehouse (gold_revenue_ledger), not the PG ledger.
      const result = await getRecognitionBreakdown(auth.brandId, asOf, { srPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/recent-activity?limit=20
   * Returns the latest N ledger rows for the brand (bounded read, not a metric — D-2 allowed).
   */
  fastify.get(
    '/api/v1/analytics/recent-activity',
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
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { limit?: string };
      const limit = query.limit ? Math.min(parseInt(query.limit, 10), 50) : 20;

      // Epic 1: recent activity now reads the lakehouse (gold_revenue_ledger), not the PG ledger.
      const result = await getRecentActivity(auth.brandId, limit, { srPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── Analytics endpoints (Phase 2) ─────────────────────────────────────────
  // ADR-002 sole-read-path: orders routes call analytics wrappers → metric engine.
  // Brand from session (D-1): auth.brandId, NEVER from request body.
  // Honest-empty: state:'no_data' when brand has no ledger / bronze rows.

  /**
   * GET /api/v1/analytics/orders-timeseries?from=YYYY-MM-DD&to=YYYY-MM-DD&grain=day|week
   * Returns per-bucket order count + RTO count + realized revenue for charting.
   */
  fastify.get(
    '/api/v1/analytics/orders-timeseries',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            grain: { type: 'string', enum: ['day', 'week'] },
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
          error: { code: 'INVALID_PARAMS', message: 'from and to must be YYYY-MM-DD; grain must be day or week.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: null, to: null, grain: 'day', buckets: [] } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string; grain?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      // Default: last 90 days
      const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;
      const grain: TimeGrain = (query.grain === 'week' ? 'week' : 'day') as TimeGrain;

      // Epic 1: orders timeseries now reads the lakehouse (gold_revenue_ledger), not the PG ledger.
      const result = await getOrdersTimeseries(
        auth.brandId,
        { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`), grain },
        { srPool },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/order-stats?as_of=YYYY-MM-DD
   * Returns per-currency order stats: order count, AOV, RTO rate.
   */
  fastify.get(
    '/api/v1/analytics/order-stats',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
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
          error: { code: 'INVALID_DATE', message: 'as_of must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', as_of: today } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { as_of?: string };
      const asOfStr = query.as_of ?? (new Date().toISOString().split('T')[0] as string);
      const asOf = new Date(`${asOfStr}T00:00:00Z`);

      // Epic 1: order stats now read the lakehouse (gold_revenue_ledger), not the PG ledger.
      const result = await getOrderStats(auth.brandId, asOf, { srPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

}
