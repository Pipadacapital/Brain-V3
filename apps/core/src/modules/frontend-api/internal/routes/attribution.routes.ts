/**
 * Attribution BFF routes (CQ-1 decomposition).
 *
 * The write driver (POST /attribution/reconcile) plus the attribution analytics reads
 * (by-channel, reconciliation, channel-roas, campaign-roas) over the gold attribution
 * credit ledger through the metric-engine named seams (ADR-002 / I-ST01 — the BFF
 * issues NO ad-hoc SUM). Brand from session (D-1), never body.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import { reconcileAttribution } from '../../../attribution/index.js';
import {
  getAttributionByChannel,
  getAttributionReconciliation,
  getChannelRoas,
  getCampaignRoas,
  getCampaignAttribution,
  getCampaignTimeseries,
  getAttributedRevenueTimeseries,
} from '../../../analytics/index.js';
import type { AttributionModelId, TimeGrain } from '@brain/metric-engine';
import type {
  AttributionByChannel as ContractAttributionByChannel,
  AttributionReconciliation as ContractAttributionReconciliation,
  ChannelRoas as ContractChannelRoas,
  CampaignAttribution as ContractCampaignAttribution,
  CampaignTimeseries as ContractCampaignTimeseries,
  AttributedRevenueTimeseries as ContractAttributedRevenueTimeseries,
  AttributionReconcileResult as ContractAttributionReconcileResult,
} from '@brain/contracts';
import type { BffDeps } from './_shared.js';

export function registerAttributionRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, rawPool, srPool } = deps;

  /**
   * POST /api/v1/attribution/reconcile — drive the attribution write pipeline (Phase 5).
   *
   * Idempotently populates attribution_credit_ledger from the realized ledger + Silver touches
   * (credit on finalized orders, clawback on reversals). A system/batch trigger; the attribution
   * analytics reads flip not_computed→has_data once a brand is reconciled. Brand from session (D-1).
   */
  fastify.post(
    '/api/v1/attribution/reconcile',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand before reconciling attribution.' },
        });
      }
      if (!rawPool || !srPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Ledger or Silver tier not available' },
        });
      }

      const result: ContractAttributionReconcileResult = await reconcileAttribution(
        auth.brandId,
        requestId,
        { srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── Attribution endpoints (Phase 5 — feat-attribution-ledger) ─────────────
  // Reads over attribution_credit_ledger (Postgres Gold, 0032) through the metric-engine
  // named seams (ADR-002 / I-ST01 — the BFF issues NO ad-hoc SUM). Brand from session
  // (D-1, NEVER body). Honest no_data. data_source='synthetic' in dev (journey data is thin
  // → attribution is mostly synthetic; the badge is honest).

  const ATTRIBUTION_MODELS = new Set<string>(['first_touch', 'last_touch', 'linear', 'position_based', 'time_decay', 'data_driven']);
  function parseModel(raw: string | undefined): AttributionModelId {
    return ATTRIBUTION_MODELS.has(raw ?? '') ? (raw as AttributionModelId) : 'position_based';
  }
  const attributionQuerySchema = {
    type: 'object',
    properties: {
      from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      model: { type: 'string', enum: ['first_touch', 'last_touch', 'linear', 'position_based', 'time_decay', 'data_driven'] },
    },
    additionalProperties: false,
  } as const;

  /**
   * GET /api/v1/analytics/attribution/by-channel?from=&to=&model=
   * Attributed revenue by channel + the unattributed residual + the reconciliation rate
   * for a model + window, from the serving attribution credit ledger (brain_serving.mv_gold_attribution_credit).
   */
  fastify.get(
    '/api/v1/analytics/attribution/by-channel',
    { preHandler: [bffProtectedPreHandler], schema: { querystring: attributionQuerySchema }, attachValidation: true },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD; model must be a valid model id.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      const query = request.query as { from?: string; to?: string; model?: string };
      const model = parseModel(query.model);
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: today, to: today, model } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const fromStr = query.from ?? (new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string);

      const result: ContractAttributionByChannel = await getAttributionByChannel(
        auth.brandId,
        {
          model,
          fromDate: new Date(`${fromStr}T00:00:00Z`),
          toDate: new Date(`${toStr}T00:00:00Z`),
          fromStr,
          toStr,
          dataSource: 'synthetic',
        },
        { srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/attribution/reconciliation?from=&to=&model=
   * The reconciliation rate + the always-rendered unattributed residual.
   */
  fastify.get(
    '/api/v1/analytics/attribution/reconciliation',
    { preHandler: [bffProtectedPreHandler], schema: { querystring: attributionQuerySchema }, attachValidation: true },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD; model must be a valid model id.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      const query = request.query as { from?: string; to?: string; model?: string };
      const model = parseModel(query.model);
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: today, to: today, model } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const fromStr = query.from ?? (new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string);

      const result: ContractAttributionReconciliation = await getAttributionReconciliation(
        auth.brandId,
        {
          model,
          fromDate: new Date(`${fromStr}T00:00:00Z`),
          toDate: new Date(`${toStr}T00:00:00Z`),
          fromStr,
          toStr,
          dataSource: 'synthetic',
        },
        { srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/attribution/channel-roas?from=&to=&model=
   * Per-channel ROAS = attributed_revenue ÷ ad_spend (honest null when spend=0).
   */
  fastify.get(
    '/api/v1/analytics/attribution/channel-roas',
    { preHandler: [bffProtectedPreHandler], schema: { querystring: attributionQuerySchema }, attachValidation: true },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD; model must be a valid model id.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      const query = request.query as { from?: string; to?: string; model?: string };
      const model = parseModel(query.model);
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: today, to: today, model } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const fromStr = query.from ?? (new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string);

      const result: ContractChannelRoas = await getChannelRoas(
        auth.brandId,
        {
          model,
          fromDate: new Date(`${fromStr}T00:00:00Z`),
          toDate: new Date(`${toStr}T00:00:00Z`),
          fromStr,
          toStr,
          dataSource: 'synthetic',
        },
        { srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/attribution/campaign-roas?from=&to=&model=
   * H8 — per-CAMPAIGN ROAS = attributed_revenue ÷ ad_spend (honest null when spend=0). The granular
   * sibling of channel-roas; joins gold_marketing_attribution × silver_marketing_spend on campaign_id.
   */
  fastify.get(
    '/api/v1/analytics/attribution/campaign-roas',
    { preHandler: [bffProtectedPreHandler], schema: { querystring: attributionQuerySchema }, attachValidation: true },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD; model must be a valid model id.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      const query = request.query as { from?: string; to?: string; model?: string };
      const model = parseModel(query.model);
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: today, to: today, model } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const fromStr = query.from ?? (new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string);

      const result = await getCampaignRoas(
        auth.brandId,
        {
          model,
          fromDate: new Date(`${fromStr}T00:00:00Z`),
          toDate: new Date(`${toStr}T00:00:00Z`),
          fromStr,
          toStr,
        },
        { srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/attribution/campaign-attribution?model=
   * #32c — PER-CAMPAIGN attributed revenue + spend + ROAS under the selected attribution model, from
   * the pre-rolled gold_campaign_attribution mart (grain platform/campaign/model/currency). The
   * served sibling of campaign-roas: one view, model-switchable, money bigint minor + currency_code.
   * No date window — the mart is a full per-campaign roll-up; the model selector drives the read.
   */
  fastify.get(
    '/api/v1/analytics/attribution/campaign-attribution',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            model: { type: 'string', enum: ['first_touch', 'last_touch', 'linear', 'position_based', 'time_decay', 'data_driven'] },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      const query = request.query as { model?: string };
      const model = parseModel(query.model);
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'model must be a valid model id.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', model } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (Trino) not available' } });
      }

      const result: ContractCampaignAttribution = await getCampaignAttribution(
        auth.brandId,
        { model },
        { srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/attribution/campaign-timeseries?model=&date_start=&date_end=
   * #32c-ts — DATE-BUCKETED per-campaign/channel attributed revenue over the window, under the selected
   * attribution model. The time-grain sibling of campaign-attribution: the pre-rolled mart has no time
   * dimension, so this reads the date-bearing attribution serving view it rolls up from
   * (mv_gold_marketing_attribution) via the metric-engine. Money bigint minor + currency_code; honest
   * no_data when the brand has no attribution-credit rows. Brand from session (D-1), never body.
   */
  fastify.get(
    '/api/v1/analytics/attribution/campaign-timeseries',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            model: { type: 'string', enum: ['first_touch', 'last_touch', 'linear', 'position_based', 'time_decay', 'data_driven'] },
            date_start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            date_end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      const query = request.query as { model?: string; date_start?: string; date_end?: string };
      const model = parseModel(query.model);
      // 'day' grain — the credit-ledger series is charted per day (the spec exposes no grain selector).
      const grain: TimeGrain = 'day';
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'date_start/date_end must be YYYY-MM-DD; model must be a valid model id.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.date_end ?? today;
      const fromStr = query.date_start ?? (new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string);
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: fromStr, to: toStr, grain, model } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (Trino) not available' } });
      }

      const result: ContractCampaignTimeseries = await getCampaignTimeseries(
        auth.brandId,
        { model, fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`), grain },
        { srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/attribution/revenue-timeseries?model=&date_start=&date_end=
   * P3 — DATE × CHANNEL attributed revenue over the window, under the selected attribution model. Reads
   * the FULL attribution CREDIT LEDGER serving view (mv_gold_attribution_credit) via the metric-engine —
   * the channel-grain sibling of campaign-timeseries (it includes EVERY credited channel, not only
   * campaign-bearing touches). Money bigint minor + currency_code; honest no_data when the brand has no
   * attribution-credit rows. Brand from session (D-1), never body.
   */
  fastify.get(
    '/api/v1/analytics/attribution/revenue-timeseries',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            model: { type: 'string', enum: ['first_touch', 'last_touch', 'linear', 'position_based', 'time_decay', 'data_driven'] },
            date_start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            date_end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      const query = request.query as { model?: string; date_start?: string; date_end?: string };
      const model = parseModel(query.model);
      // 'day' grain — the credit-ledger series is charted per day (the spec exposes no grain selector).
      const grain: TimeGrain = 'day';
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'date_start/date_end must be YYYY-MM-DD; model must be a valid model id.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.date_end ?? today;
      const fromStr = query.date_start ?? (new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string);
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: fromStr, to: toStr, grain, model } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (Trino) not available' } });
      }

      const result: ContractAttributedRevenueTimeseries = await getAttributedRevenueTimeseries(
        auth.brandId,
        { model, fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`), grain },
        { srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );
}
