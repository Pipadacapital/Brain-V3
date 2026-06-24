/**
 * Journey + storefront-behavior analytics BFF routes (CQ-1 decomposition).
 *
 * First-touch mix, shipment outcomes, behavior overview, funnel, abandoned-cart,
 * engagement, journey stitch-rate, and the single-journey timeline. Silver reads
 * over silver.touchpoint / silver_shipment through the metric-engine seam
 * (withSilverBrand, I-ST01). The route issues NO OLAP SQL. Brand from session (D-1).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import {
  getJourneyFirstTouchMix,
  getJourneyStitchRate,
  getJourneyTimeline,
  getShipmentOutcomes,
  getBehaviorOverview,
  getFunnelAnalytics,
  getAbandonedCart,
  getEngagement,
} from '../../../analytics/index.js';
import type {
  JourneyFirstTouchMix as ContractJourneyFirstTouchMix,
  ShipmentOutcomes as ContractShipmentOutcomes,
  BehaviorOverview as ContractBehaviorOverview,
  FunnelAnalytics as ContractFunnelAnalytics,
  AbandonedCart as ContractAbandonedCart,
  Engagement as ContractEngagement,
  JourneyTimeline as ContractJourneyTimeline,
  JourneyStitchRate as ContractJourneyStitchRate,
} from '@brain/contracts';
import type { BffDeps } from './_shared.js';

export function registerAnalyticsJourneyRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, srPool } = deps;

  // ── Journey endpoints (Phase 4 — feat-journey-touchpoint) ─────────────────
  // Silver reads over silver.touchpoint through the metric-engine seam (withSilverBrand,
  // I-ST01 sole reader). The route issues NO OLAP SQL itself (ADR-002). Brand from session
  // (D-1, NEVER body). Honest no_data (D-2). data_source='synthetic' in dev (journey demo
  // is enriched with clearly-labelled synthetic fixtures; real page.viewed events are thin).

  /**
   * GET /api/v1/analytics/journey/first-touch-mix?from=YYYY-MM-DD&to=YYYY-MM-DD
   * First-touch channel mix (distinct journeys + integer-basis-point share by channel)
   * over a window, from silver.touchpoint.
   */
  fastify.get(
    '/api/v1/analytics/journey/first-touch-mix',
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
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD.' },
        });
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
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractJourneyFirstTouchMix = await getJourneyFirstTouchMix(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          // Dev: journey demo is enriched with clearly-labelled synthetic fixtures.
          dataSource: 'synthetic',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/logistics/shipment-outcomes?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Shipment outcome breakdown (delivered/RTO/other/in-transit + RTO% overall, by courier,
   * by pincode) over a window, from the multi-source silver_shipment mart (GoKwik AWB +
   * Shiprocket). Slice 2.
   */
  fastify.get(
    '/api/v1/analytics/logistics/shipment-outcomes',
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
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD.' },
        });
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
      const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractShipmentOutcomes = await getShipmentOutcomes(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          // Dev: shipment lifecycle is fixture-sourced (real shape, synthetic source).
          dataSource: 'synthetic',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/behavior/overview?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Storefront behavior — sessions/journeys/touches + page-type mix + top viewed products + top
   * searches, from silver_touchpoint (pixel auto-instrumentation).
   */
  fastify.get(
    '/api/v1/analytics/behavior/overview',
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
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD.' },
        });
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
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractBehaviorOverview = await getBehaviorOverview(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          // Dev: pixel events are real but thin; surface 'live' (no synthetic enrichment here).
          dataSource: 'live',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/funnel?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Storefront conversion funnel — sessions → product views → cart adds → purchases, from
   * silver_touchpoint (Phase H pixel). Distinct-session reach per stage + conversion %.
   */
  fastify.get(
    '/api/v1/analytics/funnel',
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
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD.' },
        });
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
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractFunnelAnalytics = await getFunnelAnalytics(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          dataSource: 'live',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/abandoned-cart?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Cart-recovery rollup — of sessions that added to cart, how many converted (stitched to an order)
   * vs abandoned, from silver_touchpoint (Phase H pixel).
   */
  fastify.get(
    '/api/v1/analytics/abandoned-cart',
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
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD.' },
        });
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
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractAbandonedCart = await getAbandonedCart(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          dataSource: 'live',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/engagement?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Engagement depth — engaged (multi-touch) vs bounce sessions + avg touches per session, from
   * silver_touchpoint (Phase H pixel).
   */
  fastify.get(
    '/api/v1/analytics/engagement',
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
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD.' },
        });
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
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractEngagement = await getEngagement(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          dataSource: 'live',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/journey/stitch-rate?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Deterministic cart-stitch hit-rate (stitched ÷ total distinct anon journeys) over a
   * window. Stitch is read BACK from the order (D-5), never inferred.
   */
  fastify.get(
    '/api/v1/analytics/journey/stitch-rate',
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
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD.' },
        });
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
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractJourneyStitchRate = await getJourneyStitchRate(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          dataSource: 'synthetic',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/journey/timeline?orderId=...  (or ?anonId=...)
   * The ordered touchpoint timeline for ONE journey — resolved by order_id (via the
   * deterministic stitch map, D-5) or directly by brain_anon_id. A read projection.
   */
  fastify.get(
    '/api/v1/analytics/journey/timeline',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            orderId: { type: 'string', minLength: 1, maxLength: 256 },
            anonId:  { type: 'string', minLength: 1, maxLength: 256 },
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
          error: { code: 'INVALID_PARAMS', message: 'orderId or anonId required.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { orderId?: string; anonId?: string };
      if (!query.orderId && !query.anonId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'orderId or anonId required.' },
        });
      }

      const selector = query.orderId
        ? { orderId: query.orderId }
        : { brainAnonId: query.anonId as string };

      const result: ContractJourneyTimeline = await getJourneyTimeline(
        auth.brandId,
        { srPool },
        { selector, dataSource: 'synthetic' },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );
}
