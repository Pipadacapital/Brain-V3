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
  getRevenueMonthly,
  getRecentActivity,
  getOrdersTimeseries,
  getOrderStats,
  getExecutiveMetrics,
  getCohortRetention,
  getRepeatLatency,
  getCohortUsers,
  getUtmSource,
  getInsightsBriefing,
  getProductDetail,
  getProductAffinity,
  getProductCategories,
} from '../../../analytics/index.js';
import { materializeInsightsAsRecommendations } from '../../../recommendation/index.js';
import type {
  KpiSummary as ContractKpiSummary,
  RepeatLatency as ContractRepeatLatency,
  CohortUsers as ContractCohortUsers,
} from '@brain/contracts';
import type { TimeGrain } from '@brain/metric-engine';
import type { BffDeps } from './_shared.js';

export function registerAnalyticsCoreRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, pool, srPool, servingCache } = deps;

  // ── Serving-cache chokepoint (Brain V4) ─────────────────────────────────────
  // Front the KNOWN-metric serving reads (brain_serving.mv_* over Trino) with the Redis
  // analytics cache: a repeat (brand, metric, params, serving-version) read is served from
  // cache instead of re-hitting Trino. brand_id-leading keys; per-brand invalidation handled
  // by the stream-worker AnalyticsCacheInvalidateConsumer. Safe-OFF fallback (cache absent OR
  // flag off) = read Trino directly. The metric compute fns + withSilverBrand seam are unchanged.
  const cachedRead = <T>(
    brandId: string,
    metricId: string,
    params: unknown,
    compute: () => Promise<T>,
  ): Promise<T> => (servingCache ? servingCache.read(brandId, metricId, params, compute) : compute());

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
      const brandId = auth.brandId; // narrowed string (guarded above) — stable inside the cache closure
      const result = await cachedRead(
        brandId,
        'revenue_timeseries',
        { fromStr, toStr, grain },
        () =>
          getRevenueTimeseries(
            brandId,
            { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`), grain },
            { srPool },
          ),
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
      const brandId = auth.brandId; // narrowed string (guarded above) — stable inside the cache closure
      const result: ContractKpiSummary = await cachedRead(
        brandId,
        'kpi_summary',
        { asOfStr },
        () => getKpiSummary(brandId, asOf, { srPool }),
      );

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

      const brandId = auth.brandId; // narrowed string (guarded above) — stable inside the cache closure
      const result = await cachedRead(
        brandId,
        'executive_metrics',
        { fromStr, toStr },
        () =>
          getExecutiveMetrics(
            brandId,
            { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`) },
            { srPool },
          ),
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
      const brandId = auth.brandId; // narrowed string (guarded above) — stable inside the cache closure
      const result = await cachedRead(brandId, 'cohort_retention', {}, () =>
        getCohortRetention(brandId, { srPool }),
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/retention/repeat-latency
   * #32b — time-to-2nd-purchase: the brand median days between a customer's 1st and 2nd order plus
   * the fixed six-bucket latency histogram, from gold_repeat_latency. Integer day math, NO money.
   * Honest no_data when the brand has no customers; median is null when there are no repeat customers.
   */
  fastify.get(
    '/api/v1/analytics/retention/repeat-latency',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', generated_at: new Date().toISOString() } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (duckdb-serving) not available' } });
      }
      const brandId = auth.brandId; // narrowed string — stable inside the cache closure
      const result: ContractRepeatLatency = await cachedRead(brandId, 'repeat_latency', {}, () =>
        getRepeatLatency(brandId, { srPool }),
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/retention/cohort-users?cohort_month=YYYY-MM&period=N&page=&page_size=
   * Cohort-cell drill-down — the paginated customers inside ONE cohort cell (acquisition month ×
   * months-since) over gold_cohort_member, LTV-enriched from gold_customer_360 where available.
   * Brand from session (D-1, NEVER body). Honest no_data (D-2) on an empty/invalid cell. Money =
   * bigint minor-unit strings (I-S07).
   */
  fastify.get(
    '/api/v1/analytics/retention/cohort-users',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            cohort_month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
            period:       { type: 'integer', minimum: 0 },
            page:         { type: 'integer', minimum: 1 },
            page_size:    { type: 'integer', minimum: 1, maximum: 100 },
          },
          required: ['cohort_month', 'period'],
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
          error: { code: 'INVALID_PARAMS', message: 'cohort_month must be YYYY-MM; period ≥ 0; page ≥ 1; page_size 1–100.' },
        });
      }
      const query = request.query as { cohort_month: string; period: number; page?: number; page_size?: number };
      const page = query.page ?? 1;
      const pageSize = query.page_size ?? 20;
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({
          request_id: requestId,
          data: { state: 'no_data', cohort_month: query.cohort_month, period: query.period, page, page_size: pageSize, total: '0' },
        });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (duckdb-serving) not available' } });
      }
      const brandId = auth.brandId; // narrowed string — stable inside the cache closure
      const result: ContractCohortUsers = await cachedRead(
        brandId,
        'cohort_users',
        { cohortMonth: query.cohort_month, period: query.period, page, pageSize },
        () => getCohortUsers(brandId, { cohortMonth: query.cohort_month, period: query.period, page, pageSize }, { srPool }),
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/utm-source
   * P3 — the UTM / acquisition-SOURCE matrix from gold_utm_source via the metric registry. One row per
   * first-touch (source, medium): visitors, conversions, revenue_minor, avg_ltv_minor, repeat_rate_pct,
   * currency_code. Money = bigint MINOR units + sibling currency_code (per-row dominant currency; never
   * blended). Honest no_data when the brand has no acquisition rows.
   */
  fastify.get(
    '/api/v1/analytics/utm-source',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', generated_at: new Date().toISOString() } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (duckdb-serving) not available' } });
      }
      const brandId = auth.brandId; // narrowed string — stable inside the cache closure
      const result = await cachedRead(brandId, 'utm_source', {}, () =>
        getUtmSource(brandId, { srPool }),
      );
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
      // Cache ONLY the expensive Trino fan-out (getInsightsBriefing reads multiple Gold marts); the
      // recommendation materialization below stays per-request so Accept/Dismiss status is always fresh.
      const brandId = auth.brandId; // narrowed (guarded above) — stable inside the cache closure
      const result = await cachedRead(brandId, 'insights_briefing', {}, () =>
        getInsightsBriefing(brandId, { srPool }),
      );
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
      const brandId = auth.brandId; // narrowed string (guarded above) — stable inside the cache closure
      const result = await cachedRead(
        brandId,
        'recognition_breakdown',
        { asOfStr },
        () => getRecognitionBreakdown(brandId, asOf, { srPool }),
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/revenue-monthly
   * Per-month revenue-lifecycle breakdown from the Gold monthly mart
   * (gold_revenue_analytics): placed → confirmed → cancelled, realized value +
   * order/terminal counts. Drives MoM growth, the recognition funnel, and the
   * net-realized series. Brand from session (D-1); honest no_data when empty.
   */
  fastify.get(
    '/api/v1/analytics/revenue-monthly',
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

      const brandId = auth.brandId; // narrowed string (guarded above) — stable inside the cache closure
      const result = await cachedRead(brandId, 'revenue_monthly', {}, () =>
        getRevenueMonthly(brandId, { srPool }),
      );
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
      const brandId = auth.brandId; // narrowed string (guarded above) — stable inside the cache closure
      const result = await cachedRead(
        brandId,
        'orders_timeseries',
        { fromStr, toStr, grain },
        () =>
          getOrdersTimeseries(
            brandId,
            { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`), grain },
            { srPool },
          ),
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
      const brandId = auth.brandId; // narrowed string (guarded above) — stable inside the cache closure
      const result = await cachedRead(
        brandId,
        'order_stats',
        { asOfStr },
        () => getOrderStats(brandId, asOf, { srPool }),
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── Product analytics (P3) ────────────────────────────────────────────────
  // Per-product performance + frequently-bought-together + the revenue treemap, served from the
  // Gold marts gold_product_detail / gold_product_affinity over the Trino views (via withSilverBrand).
  // Brand from session (D-1); honest no_data / not_found. Money = bigint minor units + currency_code.
  // NOTE: the STATIC /products/categories route is declared before the PARAMETRIC /products/:productId
  // so the treemap path is never captured as a productId (fastify prefers static, but order is explicit).

  /**
   * GET /api/v1/analytics/products/categories?limit=N
   * Product revenue treemap (leaf = product, size = revenue_minor) from gold_product_detail.
   * No category dimension exists on the marts yet → honest product-granularity rollup.
   */
  fastify.get(
    '/api/v1/analytics/products/categories',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: { limit: { type: 'string', pattern: '^\\d+$' } },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'limit must be a positive integer.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Serving tier (duckdb-serving) not available' } });
      }
      const query = request.query as { limit?: string };
      const limit = query.limit ? parseInt(query.limit, 10) : 50;
      const brandId = auth.brandId; // narrowed (guarded above) — stable inside the cache closure
      const result = await cachedRead(brandId, 'product_categories', { limit }, () =>
        getProductCategories(brandId, limit, { srPool }),
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/products/:productId/affinity?limit=N
   * Frequently-bought-together partners for a product from gold_product_affinity. NO money.
   */
  fastify.get(
    '/api/v1/analytics/products/:productId/affinity',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        params: {
          type: 'object',
          required: ['productId'],
          properties: { productId: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
        querystring: {
          type: 'object',
          properties: { limit: { type: 'string', pattern: '^\\d+$' } },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'productId is required; limit must be a positive integer.' } });
      }
      const { productId } = request.params as { productId: string };
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', product_id: productId } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Serving tier (duckdb-serving) not available' } });
      }
      const query = request.query as { limit?: string };
      const limit = query.limit ? parseInt(query.limit, 10) : 10;
      const brandId = auth.brandId; // narrowed (guarded above) — stable inside the cache closure
      const result = await cachedRead(brandId, 'product_affinity', { productId, limit }, () =>
        getProductAffinity(brandId, productId, limit, { srPool }),
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/products/:productId
   * A single product's storefront funnel (views→atc→purchases→revenue) + returns + conversion rates
   * from gold_product_detail. Honest not_found when the brand has no row for that product.
   */
  fastify.get(
    '/api/v1/analytics/products/:productId',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        params: {
          type: 'object',
          required: ['productId'],
          properties: { productId: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'productId is required.' } });
      }
      const { productId } = request.params as { productId: string };
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'not_found', product_id: productId } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Serving tier (duckdb-serving) not available' } });
      }
      const brandId = auth.brandId; // narrowed (guarded above) — stable inside the cache closure
      const result = await cachedRead(brandId, 'product_detail', { productId }, () =>
        getProductDetail(brandId, productId, { srPool }),
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

}
