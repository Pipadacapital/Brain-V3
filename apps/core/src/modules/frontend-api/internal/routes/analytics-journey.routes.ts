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
  getJourneyEvents,
  getJourneyReplay,
  getJourneyPaths,
  getJourneyList,
  getShipmentOutcomes,
  getReturnFunnel,
  getBehaviorOverview,
  getFunnelAnalytics,
  getFunnelUsers,
  getAbandonedCart,
  getEngagement,
  getSearchBehavior,
  getFormConversion,
} from '../../../analytics/index.js';
import type {
  JourneyFirstTouchMix as ContractJourneyFirstTouchMix,
  JourneyPaths as ContractJourneyPaths,
  JourneyList as ContractJourneyList,
  ShipmentOutcomes as ContractShipmentOutcomes,
  ReturnFunnel as ContractReturnFunnel,
  BehaviorOverview as ContractBehaviorOverview,
  FunnelAnalytics as ContractFunnelAnalytics,
  FunnelUsers as ContractFunnelUsers,
  FunnelStep as ContractFunnelStep,
  AbandonedCart as ContractAbandonedCart,
  Engagement as ContractEngagement,
  SearchBehavior as ContractSearchBehavior,
  FormConversion as ContractFormConversion,
  JourneyTimeline as ContractJourneyTimeline,
  JourneyEventsLedger as ContractJourneyEventsLedger,
  JourneyReplay as ContractJourneyReplay,
  JourneyStitchRate as ContractJourneyStitchRate,
} from '@brain/contracts';
import type { BffDeps } from './_shared.js';
// Records browser — the generic paginated canonical-records reader lives IN the metric engine
// (queryConnectorRecords), so the route is a thin brand-scoped pass-through (no core use-case needed).
import { queryConnectorRecords, CONNECTOR_RECORD_ENTITIES } from '@brain/metric-engine';

export function registerAnalyticsJourneyRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, srPool, rawPool, flagService } = deps;

  // SPEC: B.4 — the per-brand flag gating the NEW replay (?as_of=) behavior on the journey ledger route
  // (DEFAULT OFF, fail-closed — §0.5). The existing current-projection read (no as_of) is grandfathered
  // and stays flag-free (flags-OFF is byte-identical). Wave B journey engine = 'journey.engine'.
  const JOURNEY_ENGINE_FLAG = 'journey.engine' as const;

  // ── Records browser — paginated canonical connector records (orders/shipments/ad-spend) ──────
  // GET /api/v1/analytics/records/:entity?from&to&search&page — newest-first, 20/page. Thin brand-
  // scoped pass-through to the metric-engine reader (queryConnectorRecords → withSilverBrand,
  // BRAND_PREDICATE). entity is enum-validated against the allowlist; from/to are YYYY-MM-DD; page is
  // a positive int; search is free text (parameterized LIKE downstream). Brand from session (D-1).
  fastify.get(
    '/api/v1/analytics/records/:entity',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        params: {
          type: 'object',
          properties: { entity: { type: 'string', enum: CONNECTOR_RECORD_ENTITIES } },
          required: ['entity'],
        },
        querystring: {
          type: 'object',
          properties: {
            from:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:     { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            search: { type: 'string', maxLength: 100 },
            page:   { type: 'string', pattern: '^\\d{1,6}$' },
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
          error: { code: 'INVALID_PARAMS', message: 'entity must be orders|shipments|ad_spend; from/to YYYY-MM-DD; page a number.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      const { entity } = request.params as { entity: string };
      if (!auth.brandId) {
        return reply.send({
          request_id: requestId,
          data: { entity, page: 1, limit: 20, total: 0, columns: [], rows: [] },
        });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Serving tier (Trino) not available' } });
      }

      const query = request.query as { from?: string; to?: string; search?: string; page?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      // Default window: last 90 days (wider than the 30d analytics default — a records browser is a
      // lookup surface, not a trend chart; the user narrows with the date filter).
      const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;
      const page = query.page ? Number(query.page) : 1;

      const result = await queryConnectorRecords(
        auth.brandId,
        { srPool },
        { entity, fromStr, toStr, search: query.search, page },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

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
   * GET /api/v1/analytics/journey/paths?limit=N
   * #32a — the aggregate journey-path Sankey: the top-N most-common ordered CHANNEL paths over
   * silver_touchpoint (pre-aggregated into the gold_journey_paths mart), each with its journey
   * count, conversion count, and drop-off, PLUS the aggregated channel→channel edges the path-flow
   * draws. No date window — the mart is a brand-wide path roll-up. NO money (paths are behavioral).
   */
  fastify.get(
    '/api/v1/analytics/journey/paths',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50 },
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
          error: { code: 'INVALID_PARAMS', message: 'limit must be an integer 1..50.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (Trino) not available' } });
      }

      const query = request.query as { limit?: number };

      const result: ContractJourneyPaths = await getJourneyPaths(
        auth.brandId,
        { srPool },
        {
          limit: query.limit,
          // Dev: journey data is enriched with clearly-labelled synthetic fixtures (real shape).
          dataSource: 'synthetic',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/journey/list?limit=N&cursor=...
   * Paginated recent customer journeys — one row per (brand_id, brain_anon_id) over the serving
   * view mv_gold_journey, newest-first by last_touch_at, keyset-paginated (opaque next_cursor; an
   * invalid cursor degrades to the first page). NO money (a journey list is behavioral); brain_anon_id
   * is the opaque anon key. Brand from session (D-1); honest no_data.
   */
  fastify.get(
    '/api/v1/analytics/journey/list',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit:  { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string', maxLength: 512 },
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
          error: { code: 'INVALID_PARAMS', message: 'limit must be an integer 1..100; cursor a string.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Serving tier (Trino) not available' } });
      }

      const query = request.query as { limit?: number; cursor?: string };

      const result: ContractJourneyList = await getJourneyList(
        auth.brandId,
        { srPool },
        {
          limit: query.limit,
          cursor: query.cursor ?? null,
          // Dev: journey data is enriched with clearly-labelled synthetic fixtures (real shape).
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
   * GET /api/v1/analytics/logistics/return-funnel?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Return-lifecycle breakdown (per return_class + completion% + by courier) over a window, from the
   * silver_return mart (SR-4). A SEPARATE dimension from shipment-outcomes — returns NEVER carry
   * terminal_class, so this can never present a return as a forward DELIVERED. SR-10.
   */
  fastify.get(
    '/api/v1/analytics/logistics/return-funnel',
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
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (Trino) not available' } });
      }

      const query = request.query as { from?: string; to?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractReturnFunnel = await getReturnFunnel(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          // Dev: return lifecycle is fixture-sourced (real shape, synthetic source).
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
   * GET /api/v1/analytics/funnel/users?step=<session|product_view|cart|checkout|purchase>&date_start=&date_end=
   * The funnel STEP drill-down — a paginated list of the VISITORS who DROPPED at `step` (reached it
   * but not the next) within the window, from the per-visitor Gold mart gold_funnel_user via
   * brain_serving.mv_gold_funnel_user. "Dropped at <step>" = furthest_step = '<step>'; the window is
   * applied on last_seen_at. NO money. Brand from session (D-1); honest no_data; paginated.
   */
  fastify.get(
    '/api/v1/analytics/funnel/users',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          required: ['step'],
          properties: {
            step: { type: 'string', enum: ['session', 'product_view', 'cart', 'checkout', 'purchase'] },
            date_start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            date_end:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            page:      { type: 'string', pattern: '^\\d+$' },
            page_size: { type: 'string', pattern: '^\\d+$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      const query = request.query as {
        step?: string; date_start?: string; date_end?: string; page?: string; page_size?: string;
      };
      const page = query.page ? Math.max(1, parseInt(query.page, 10)) : 1;
      const pageSize = query.page_size ? parseInt(query.page_size, 10) : 20;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'step must be one of session|product_view|cart|checkout|purchase; date_start/date_end must be YYYY-MM-DD.' },
        });
      }

      const step = query.step as ContractFunnelStep;
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', step, page, page_size: pageSize, total: '0' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Serving tier (Trino) not available' } });
      }

      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.date_end ?? today;
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.date_start ?? defaultFrom;

      const result: ContractFunnelUsers = await getFunnelUsers(
        auth.brandId,
        { srPool },
        { step, fromStr, toStr, page, pageSize },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/abandoned-cart?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Cart-recovery rollup — of sessions that added to cart, how many converted (recovered) vs
   * abandoned, from the Gold mart gold_abandoned_cart via brain_serving.mv_gold_abandoned_cart.
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
   * GET /api/v1/analytics/search?from=YYYY-MM-DD&to=YYYY-MM-DD
   * On-site search rollup — search-page view volume + session/journey reach + a per-day series,
   * from the page_type='search' slice of gold_behavior (mv_gold_behavior). NO money. Honest
   * no_data when the brand has no search rows in the window.
   */
  fastify.get(
    '/api/v1/analytics/search',
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
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Serving tier (Trino) not available' } });
      }

      const query = request.query as { from?: string; to?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractSearchBehavior = await getSearchBehavior(
        auth.brandId,
        { srPool },
        { fromStr, toStr, dataSource: 'live' },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/forms?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Lead-form submission rollup — per-form submission counts/rates (submissions ÷ sessions) + the
   * brand day-level payment.succeeded reach + a per-day series, from gold_conversion_feedback
   * (mv_gold_conversion_feedback). NO money; PII-safe (structural form_id + counts only). Honest
   * no_data when the brand has no form rows in the window.
   */
  fastify.get(
    '/api/v1/analytics/forms',
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
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Serving tier (Trino) not available' } });
      }

      const query = request.query as { from?: string; to?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractFormConversion = await getFormConversion(
        auth.brandId,
        { srPool },
        { fromStr, toStr, dataSource: 'live' },
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
        // rawPool (PG) resolves an order → its stitched anon(s) from the PG-native stitch map; srPool
        // (Trino) reads the touches. The anonId selector path needs no PG pool.
        { srPool, pool: rawPool },
        { selector, dataSource: 'synthetic' },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/journey/events?brainId=<uuid>&cursor=&limit=&as_of=<iso>
   * The versioned journey LEDGER for ONE resolved customer — the current (is_current=true)
   * projection of iceberg.brain_gold.journey_events via brain_serving.mv_journey_events_current.
   * Keyed by brain_id (the RESOLVED identity, same key as Customer 360 — post-merge canonical),
   * newest-first, keyset-paginated (opaque next_cursor; an invalid cursor degrades to the first
   * page). MONEY: revenue_minor bigint-minor-string + sibling currency_code, composite rows only.
   *
   * SPEC: B.4 REPLAY — with `?as_of=<iso>` this becomes the batch-only replay surface (AMD-14: the
   * spec's GET /v1/customers/{brain_id}/journey?as_of= maps onto this live BFF route): the journey AS
   * KNOWN AT as_of, reconstructed from RETAINED version history + identity_asof intervals (AMD-10,
   * NOT Iceberg time-travel). NEW behavior → gated by the per-brand `journey.engine` flag (DEFAULT
   * OFF, fail-closed); NO cache (Cache-Control: no-store); response carries replayed:true. The
   * no-as_of current-projection path is grandfathered (flag-free, byte-identical when flags OFF).
   */
  fastify.get(
    '/api/v1/analytics/journey/events',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            brainId: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
            cursor: { type: 'string', maxLength: 512 },
            limit:  { type: 'integer', minimum: 1, maximum: 100 },
            // SPEC: B.4 — replay wall-clock (ISO-8601). Presence switches to the replay path.
            as_of: { type: 'string', minLength: 1, maxLength: 40 },
          },
          required: ['brainId'],
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
          error: { code: 'INVALID_PARAMS', message: 'brainId must be a UUID; limit an integer 1..100.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Serving tier (Trino) not available' } });
      }

      const query = request.query as { brainId: string; cursor?: string; limit?: number; as_of?: string };

      // ── SPEC: B.4 — REPLAY path (?as_of=) — batch-only, flag-gated, never cached ──────────────────
      if (query.as_of !== undefined) {
        // Fail-closed: NEW behavior gated by the per-brand journey.engine flag (DEFAULT OFF).
        const enabled = flagService
          ? await flagService.isFlagEnabled(auth.brandId, JOURNEY_ENGINE_FLAG)
          : false;
        if (!enabled) {
          return reply.code(404).send({
            request_id: requestId,
            error: {
              code: 'NOT_ENABLED',
              message: 'Journey replay (?as_of=) is gated by the journey.engine flag (OFF for this brand).',
            },
          });
        }

        // The as_of must be a real instant (reconstruction is time-anchored). Reject an unparseable value.
        const asOfMs = Date.parse(query.as_of);
        if (Number.isNaN(asOfMs)) {
          return reply.code(400).send({
            request_id: requestId,
            error: { code: 'INVALID_PARAMS', message: 'as_of must be an ISO-8601 timestamp.' },
          });
        }

        const replay: ContractJourneyReplay = await getJourneyReplay(
          auth.brandId,
          { srPool },
          {
            brainId: query.brainId,
            asOf: new Date(asOfMs).toISOString(),
            cursor: query.cursor ?? null,
            limit: query.limit ?? 50,
            dataSource: 'live',
          },
        );

        // Batch-path only (B.4): replay is reconstructed, never a cacheable live read.
        reply.header('Cache-Control', 'no-store');
        return reply.send({ request_id: requestId, data: replay });
      }

      const result: ContractJourneyEventsLedger = await getJourneyEvents(
        auth.brandId,
        { srPool },
        {
          brainId: query.brainId,
          cursor: query.cursor ?? null,
          limit: query.limit ?? 50,
          // The ledger is built from the live journey corpus (Gold journey_events over the real
          // Silver spine) — no synthetic enrichment on this surface.
          dataSource: 'live',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );
}
