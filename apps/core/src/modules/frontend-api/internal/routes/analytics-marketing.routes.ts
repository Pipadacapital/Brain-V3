/**
 * Marketing + data-health/quality analytics BFF routes (CQ-1 decomposition).
 *
 * Ad-spend timeseries, blended ROAS, ingestion/connector data-health, the Data
 * Quality summary, and the settlement (net-of-fees) summary. ADR-002 sole-read-path
 * via the analytics wrappers → the metric engine. Brand from session (D-1).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import {
  getDataHealth,
  getSettlementSummary,
  getAdSpendTimeseries,
  getBlendedRoas,
} from '../../../analytics/index.js';
import { getDataQualitySummary } from '../../../data-quality/index.js';
import type { DataQualitySummary as ContractDataQualitySummary } from '@brain/contracts';
import type { AdPlatform, TimeGrain } from '@brain/metric-engine';
import type { BffDeps } from './_shared.js';

export function registerAnalyticsMarketingRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, rawPool, srPool } = deps;

  // ── Ad-connectors (Slice 1 Track 3) — spend + blended ROAS ────────────────────
  // ADR-002 sole-read-path: routes call analytics wrappers → metric engine (ad_spend_as_of
  // / realized_gmv_as_of seams). Brand from session (D-1), NEVER the body. Honest no_data.

  /**
   * GET /api/v1/analytics/ad-spend-timeseries?from=YYYY-MM-DD&to=YYYY-MM-DD&grain=day|week&platform=meta|google_ads
   * Returns per-bucket ad spend grouped by (platform, currency_code).
   */
  fastify.get(
    '/api/v1/analytics/ad-spend-timeseries',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            grain: { type: 'string', enum: ['day', 'week'] },
            platform: { type: 'string', enum: ['meta', 'google_ads'] },
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
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD; grain day|week; platform meta|google_ads.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: null, to: null, grain: 'day', platform: null } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string; grain?: string; platform?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      // Default window: last 35 days (covers the Google trailing-restatement window; ADR-AD-3).
      const defaultFrom = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;
      const grain: TimeGrain = (query.grain === 'week' ? 'week' : 'day') as TimeGrain;
      const platform = (query.platform === 'meta' || query.platform === 'google_ads')
        ? (query.platform as AdPlatform)
        : undefined;

      const result = await getAdSpendTimeseries(
        auth.brandId,
        { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`), grain, platform },
        { srPool },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/blended-roas?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Returns per-currency blended ROAS (realized ÷ spend), same-currency only,
   * honest (roas_ratio=null where spend=0).
   */
  fastify.get(
    '/api/v1/analytics/blended-roas',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
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
          error: { code: 'INVALID_PARAMS', message: 'from and to must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: today, to: today } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const defaultFrom = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result = await getBlendedRoas(
        auth.brandId,
        { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`) },
        { srPool },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/data-health
   * Returns ingestion + connector-sync health (bounded read — D-2 allowed).
   */
  fastify.get(
    '/api/v1/analytics/data-health',
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

      const result = await getDataHealth(auth.brandId, { pool: rawPool, srPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/data-quality/summary  (Phase 7 — Data Quality surface)
   *
   * Returns the brand's Data Quality summary: per-category × per-target latest grade,
   * freshness-SLA status, dq_grade coverage, cost/effective confidence, and the gate
   * decision (trust tier / billing-cap / MMM inclusion / block-high-risk). All grades are
   * computed metric OUTPUTS on the sole metric-engine path (I-ST01) — the UI reads ONLY
   * this route, never dq_check_result.
   *
   * Brand from session (D-1): auth.brandId, NEVER request body.
   * Honest no_data (D-2): state='no_data' when the brand has no graded rows (or 0035 not
   *   yet migrated — fail-closed in the query).
   * RLS / F-SEC-02: the query reads inside withBrandTxn (GUC set per-transaction).
   */
  fastify.get(
    '/api/v1/data-quality/summary',
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

      const result: ContractDataQualitySummary = await getDataQualitySummary(auth.brandId, { pool: rawPool, srPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/settlements?as_of=YYYY-MM-DD  (Razorpay Track C)
   *
   * Returns the brand's settlement (net-of-fees) summary computed from the
   * realized_revenue_ledger settlement event_types (migration 0027):
   *   { state, gross_minor, net_minor, fees: [{ type, amount_minor }], currency_code }
   *
   * ADR-002 SOLE READ PATH: calls getSettlementSummary → computeSettlementSummary
   * (metric engine). NO ad-hoc SUM(amount_minor) in this route or the analytics module.
   *
   * Brand from session (D-1): auth.brandId, NEVER request body.
   * Honest no_data (D-2): state='no_data' when the brand has no settlement rows.
   * RLS / F-SEC-02: the engine reads inside withBrandTxn (GUC set per-transaction).
   * Pool: rawPool (pg.Pool), not the DbPool wrapper (no double-GUC).
   */
  fastify.get(
    '/api/v1/analytics/settlements',
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

      const result = await getSettlementSummary(auth.brandId, asOf, { srPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

}
